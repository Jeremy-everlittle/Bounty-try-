'use strict';

// ═══════════════════════════════════════════════════════════════
// Trade Executor — clean rewrite
// ───────────────────────────────────────────────────────────────
// Single-position lifecycle:
//   idle → entered → settled
// Entry:   driven by prediction._betQuality.shouldBet
// Exit:    driven by sellSignal.level ∈ {lost_cause, confident_flip}
// Settle:  paper mode resolves on period end; live mode lets Kalshi settle
//
// Paper-mode dual environment (demo / production) with cents-denominated
// balances persisted via db.saveBalanceSnapshot.
// ═══════════════════════════════════════════════════════════════

const kalshi = require('./kalshi-trading');
const kalshiAuth = require('./kalshi-auth');
const db = require('./db');
const decisionLog = require('./decision-logger');
const engine = require('./prediction-engine');
const eventLog = require('./event-log');

// ── Config ────────────────────────────────────────────────────────
const config = {
    paperMode: true,
    baseContracts: 10,
    maxPositionContracts: 100,
    convictionMaxContracts: 200,
    maxDailyLossCents: 50000,    // $500 default daily stop
    maxDailyTrades: 100,
    maxReentriesPerPeriod: 1,    // hard cap on round-trips per 15m period
    minHoldSeconds: 45,          // must hold this long before sell signals can fire
};

// ── Shared state (one wallet / one switch across BTC/ETH/etc) ─────
// Kill switch defaults to ON across the multi-week reliability refactor.
// Real money is blocked until the user explicitly flips it off in the UI;
// the choice is then persisted in `store_state` so it survives restarts.
let killSwitch = true;
const tradeListeners = [];
// Paper balances in CENTS — demo + production tracked separately
const paperBalances = { demo: 250000, production: 250000 };
// Live-balance cache: avoid hammering Kalshi on every getStatus() call
const liveBalanceCache = { demo: null, production: null };
const liveBalanceFetchedAt = { demo: 0, production: 0 };
const LIVE_BALANCE_TTL_MS = 15_000;
let liveBalanceInflight = { demo: null, production: null };
// Combined trade log + daily stats across assets — every trade carries an
// `asset` tag from pushTrade so the UI can render per-asset badges while
// totals (daily P&L, trade count, W/L) reflect the whole bot.
let recentTrades = [];
let dailyStats = { date: null, tradeCount: 0, wins: 0, losses: 0, pnlCents: 0 };
function todayKey() { return new Date().toISOString().slice(0, 10); }
function ensureDailyStats() {
    const today = todayKey();
    if (dailyStats.date !== today) {
        dailyStats = { date: today, tradeCount: 0, wins: 0, losses: 0, pnlCents: 0 };
    }
}

// ── Per-asset executor factory ────────────────────────────────────
function createExecutor(assetKey = 'btc') {
const isBtc = assetKey === 'btc';
let currentPosition = null;     // { ticker, side, action, contracts, entryPrice, orderId, periodKey, totalCostCents, totalContracts, entryTime, strike }
let soldThisPeriod = false;
let lastPeriodKey = null;
let reentriesThisPeriod = 0;
let lastEntryTime = 0;          // ms epoch of most recent buy; gates reflexive sells
let lastSellAt = 0;             // ms epoch of most recent sell order; prevents hammering
let consecutiveEmptyReconciles = 0; // legacy debounce, kept for compat
let thought = { status: 'idle', message: 'Waiting for prediction', timestamp: Date.now(), detail: null };
// Latest market data snapshot (orderbook + price) for this asset.
// Updated once per fetch cycle by the server so placeSell can crystallize
// paper sells at the live bid instead of the stale entry price.
let latestMarketData = null;
function setMarketData(md) { latestMarketData = md || null; }

// In LIVE mode, Kalshi is the source of truth for currentPosition. Every
// fetch cycle we pull /portfolio/positions and rebuild currentPosition from
// what Kalshi actually shows. This eliminates two bugs the optimistic local
// model kept producing:
//   - "Buy" rows for orders that are still resting (never filled).
//   - "Sell" rows for positions that didn't actually exist on Kalshi.
//
// We keep a tiny per-ticker metadata cache (periodKey, entryTime) so that a
// position pulled from Kalshi can be tagged with the period it belongs to —
// Kalshi doesn't know about our 15-min slicing.
//
// Paper mode is unchanged: currentPosition is local optimistic state, since
// there's nothing to reconcile against.
const metaByTicker = {}; // ticker -> { periodKey, entryTime }
let pendingOrderTicker = null; // ticker of the most recent live order placed
let pendingOrderPlacedAt = 0;  // ms epoch — used to surface "PENDING FILL" UI hints

async function refreshLivePosition() {
    if (config.paperMode) return;
    if (!(kalshiAuth.isConfigured && kalshiAuth.isConfigured())) return;
    try {
        const resp = await kalshi.getPositions();
        const list = (resp && resp.market_positions) || [];
        const active = list.filter(p => p && Math.abs(parseInt(p.position, 10) || 0) > 0);

        // Pick which Kalshi position represents OUR position. Prefer one that
        // matches a ticker we have metadata for (i.e. we placed an order for
        // it). If none match but there's a pending order ticker, prefer that.
        let kpos = null;
        if (currentPosition) kpos = active.find(p => p.ticker === currentPosition.ticker);
        if (!kpos && pendingOrderTicker) kpos = active.find(p => p.ticker === pendingOrderTicker);
        if (!kpos) {
            // Fall back to any active position we have metadata for.
            kpos = active.find(p => metaByTicker[p.ticker]);
        }

        if (!kpos) {
            // Kalshi shows no relevant position. Clear local state.
            if (currentPosition) {
                const stale = currentPosition;
                currentPosition = null;
                soldThisPeriod = true; // don't reflexively re-enter same period
                eventLog.log('position_cleared_by_kalshi', {
                    asset: assetKey, ticker: stale.ticker,
                    contracts: stale.contracts, side: stale.side,
                    activeCount: active.length,
                });
            }
            return;
        }

        // Build currentPosition from Kalshi's view.
        const rawPos = parseInt(kpos.position, 10) || 0;
        const qty = Math.abs(rawPos);
        const side = rawPos > 0 ? 'yes' : 'no';
        // Kalshi reports market_exposure in CENTS (matches the same convention
        // as our limitPrice). Avg fill price = exposure / contracts.
        const exposureCents = Math.abs(parseInt(kpos.market_exposure, 10) || 0);
        const avgPriceCents = qty > 0 ? Math.round(exposureCents / qty) : 0;

        const meta = metaByTicker[kpos.ticker] || {};
        const wasNew = !currentPosition || currentPosition.ticker !== kpos.ticker;
        if (wasNew && !meta.entryTime) {
            // First time we're seeing this position — anchor metadata now.
            meta.entryTime = Date.now();
            metaByTicker[kpos.ticker] = meta;
            lastEntryTime = Date.now();
        }

        currentPosition = {
            ticker: kpos.ticker,
            side,
            action: 'buy',
            contracts: qty,
            totalContracts: qty,
            entryPrice: avgPriceCents,
            totalCostCents: exposureCents,
            entryTime: meta.entryTime || Date.now(),
            periodKey: meta.periodKey || lastPeriodKey,
            strike: meta.strike || null,
            orderId: meta.orderId || null,
        };

        // Pending-order hint: if Kalshi now shows our position, the order has
        // landed; clear the pending tag.
        if (pendingOrderTicker === kpos.ticker) {
            pendingOrderTicker = null;
        }
    } catch (e) {
        console.warn('[trade-executor] live position refresh failed:', e.message);
        eventLog.log('kalshi_refresh_error', { asset: assetKey, message: e.message });
    }
}

// Backwards-compat alias — server still calls reconcileFromKalshi.
const reconcileFromKalshi = refreshLivePosition;


// Manual escape hatch: nuke local position without placing any order. For when
// reconcile hasn't caught the drift yet and the user wants to clear the panel.
function clearLocalPosition() {
    if (!currentPosition) return { ok: false, reason: 'no local position' };
    const cleared = currentPosition;
    currentPosition = null;
    soldThisPeriod = true;
    setThought('idle', `manually cleared local ${cleared.contracts}x ${cleared.side}`);
    return { ok: true, cleared };
}

function setThought(status, message, detail) {
    thought = { status, message, timestamp: Date.now(), detail: detail || null };
}

function activeEnv() { return kalshiAuth.getEnvironment ? kalshiAuth.getEnvironment() : 'demo'; }
function paperBal() { return paperBalances[activeEnv()] ?? 250000; }
function setPaperBal(v) { paperBalances[activeEnv()] = Math.max(0, Math.round(v)); }

// ── Daily stats handling (shared via module scope above) ─────────

function dailyStopHit() {
    ensureDailyStats();
    if (config.maxDailyLossCents && dailyStats.pnlCents <= -Math.abs(config.maxDailyLossCents)) return 'daily loss limit';
    if (config.maxDailyTrades && dailyStats.tradeCount >= config.maxDailyTrades) return 'daily trade cap';
    return null;
}

// ── Trade log ─────────────────────────────────────────────────────
function pushTrade(trade) {
    const nowIso = new Date().toISOString();
    // Frontend reads both `time` (period-history) and `timestamp` (notifications);
    // keep them in sync so a trade lands in its period and triggers a push.
    const enriched = {
        ...trade,
        asset: assetKey,
        time: trade.time || nowIso,
        timestamp: trade.timestamp || nowIso,
    };
    recentTrades.unshift(enriched);
    if (recentTrades.length > 200) recentTrades.length = 200;
    eventLog.log('trade', {
        asset: assetKey,
        type: enriched.type, side: enriched.side, contracts: enriched.contracts,
        limitPrice: enriched.limitPrice, ticker: enriched.ticker,
        periodKey: enriched.periodKey, pnlCents: enriched.pnlCents,
        reason: enriched.reason, paperMode: enriched.paperMode,
        sellPriceSource: enriched.sellPriceSource,
    });
    for (const cb of tradeListeners) {
        try { cb(enriched); } catch (e) { console.error('[trade-executor] listener error:', e.message); }
    }
    db.logTrade(enriched).catch(e => console.error('[trade-executor] db.logTrade:', e.message));
}

function onTradeNotify(cb) { tradeListeners.push(cb); }

function clearTradeLog() {
    recentTrades = [];
    dailyStats = { date: todayKey(), tradeCount: 0, wins: 0, losses: 0, pnlCents: 0 };
}

// ── Order helpers ─────────────────────────────────────────────────
async function placeBuy({ ticker, side, contracts, askCents, periodKey, strike, prediction, edge, betQuality }) {
    const limitPrice = Math.min(99, Math.max(1, Math.round(askCents)));
    const costCents = limitPrice * contracts;

    if (config.paperMode) {
        if (paperBal() < costCents) {
            setThought('error', `Paper balance ${paperBal()}c < cost ${costCents}c — abort`);
            return { ok: false, reason: 'insufficient paper balance' };
        }
        setPaperBal(paperBal() - costCents);
        const orderId = 'paper-' + Date.now();
        currentPosition = {
            ticker, side, action: 'buy', contracts, entryPrice: limitPrice, orderId, periodKey, strike,
            totalCostCents: costCents, totalContracts: contracts, entryTime: Date.now(),
        };
        lastEntryTime = Date.now();
        consecutiveEmptyReconciles = 0;
        setThought('entry', `PAPER BUY ${contracts}x ${side} @ ${limitPrice}c on ${ticker}`, { side, contracts, edge: betQuality?.edge, quality: betQuality?.quality, probability: betQuality?.factors?.probability });
        ensureDailyStats();
        dailyStats.tradeCount += 1;
        pushTrade({
            type: 'buy', action: 'buy', side, direction: side, contracts, limitPrice,
            ticker, periodKey, strike, edge: edge != null ? (edge * 100).toFixed(1) + '%' : null,
            reason: betQuality?.reason || 'auto entry',
            paperMode: true,
        });
        return { ok: true, orderId, position: currentPosition };
    }

    // LIVE — order placed, but DO NOT optimistically set currentPosition.
    // The order may be resting (limit price not yet matched) or rejected.
    // refreshLivePosition() pulls Kalshi as the source of truth; the next
    // refresh cycle will populate currentPosition if/when Kalshi confirms a
    // fill. We only stash metadata so the eventual position can be tagged
    // with the right period.
    try {
        const yesPrice = side === 'yes' ? limitPrice : undefined;
        const noPrice  = side === 'no'  ? limitPrice : undefined;
        const resp = await kalshi.placeOrder({ ticker, side, action: 'buy', count: contracts, yesPrice, noPrice });
        const orderId = resp?.order?.order_id || null;
        metaByTicker[ticker] = {
            periodKey, strike, orderId,
            entryTime: (metaByTicker[ticker] && metaByTicker[ticker].entryTime) || null,
        };
        pendingOrderTicker = ticker;
        pendingOrderPlacedAt = Date.now();
        setThought('entry-pending', `LIVE BUY ${contracts}x ${side} @ ${limitPrice}c placed on ${ticker} → order ${orderId} (awaiting fill)`, { side, contracts, edge: betQuality?.edge, quality: betQuality?.quality, probability: betQuality?.factors?.probability });
        ensureDailyStats();
        dailyStats.tradeCount += 1;
        pushTrade({
            type: 'buy', action: 'buy', side, direction: side, contracts, limitPrice,
            ticker, periodKey, strike, orderId,
            edge: edge != null ? (edge * 100).toFixed(1) + '%' : null,
            reason: betQuality?.reason || 'auto entry',
            paperMode: false,
            pendingFill: true,
        });
        return { ok: true, orderId, pending: true };
    } catch (e) {
        setThought('error', `LIVE BUY FAILED: ${e.message}`);
        return { ok: false, reason: e.message };
    }
}

async function placeSell(reasonText) {
    if (!currentPosition) return { ok: false, reason: 'no position' };
    const { ticker, side, contracts, periodKey, entryPrice } = currentPosition;

    // Crystallize at the LIVE bid for our side (what a market sell would
    // actually fill at), not the stale entry price. Falls back to entry only
    // if the orderbook is missing — old behavior — so we never crash a sell.
    const liveBid = latestMarketData ? engine.getKalshiBid(latestMarketData, side) : null;
    const rawSellPrice = (liveBid != null) ? liveBid : entryPrice;
    const sellPrice = Math.max(1, Math.min(99, rawSellPrice));
    const sellPriceSource = (liveBid != null) ? 'live_bid' : 'entry_fallback';

    if (config.paperMode) {
        const proceeds = sellPrice * contracts;
        setPaperBal(paperBal() + proceeds);
        const pnl = proceeds - currentPosition.totalCostCents;
        ensureDailyStats();
        dailyStats.pnlCents += pnl;
        if (pnl >= 0) dailyStats.wins += 1; else dailyStats.losses += 1;
        setThought('exit', `PAPER SELL ${contracts}x ${side} @ ${sellPrice}c (${reasonText})`, { side, contracts, sellPriceSource });
        pushTrade({
            type: 'sell', action: 'sell', side, direction: side, contracts, limitPrice: sellPrice,
            ticker, periodKey, reason: reasonText, pnlCents: pnl, paperMode: true,
            sellPriceSource,
        });
        soldThisPeriod = true;
        currentPosition = null;
        return { ok: true, pnl };
    }

    // LIVE — sell order placed, but DO NOT optimistically clear
    // currentPosition. The sell may rest, partially fill, or be rejected
    // (e.g. zero position to sell). Trust refreshLivePosition to reflect
    // Kalshi truth on the next cycle.
    try {
        const yesPrice = side === 'yes' ? sellPrice : undefined;
        const noPrice  = side === 'no'  ? sellPrice : undefined;
        const resp = await kalshi.placeOrder({ ticker, side, action: 'sell', count: contracts, yesPrice, noPrice });
        setThought('exit-pending', `LIVE SELL ${contracts}x ${side} @ ${sellPrice}c placed on ${ticker} (${reasonText}, awaiting fill)`, { side, contracts });
        pushTrade({
            type: 'sell', action: 'sell', side, direction: side, contracts, limitPrice: sellPrice,
            ticker, periodKey, reason: reasonText, paperMode: false,
            orderId: resp?.order?.order_id || null,
            pendingFill: true,
        });
        // Mark soldThisPeriod so the auto-trader doesn't immediately re-enter
        // before Kalshi updates. Position itself is cleared by next refresh.
        soldThisPeriod = true;
        return { ok: true, pending: true };
    } catch (e) {
        setThought('error', `LIVE SELL FAILED: ${e.message}`);
        return { ok: false, reason: e.message };
    }
}

// ── Public API: prediction → order ────────────────────────────────
async function onNewPrediction(prediction, ticker, strike, periodKey) {
    if (killSwitch) { setThought('killed', 'kill-switch active'); return; }
    if (!ticker || !strike) { setThought('idle', 'awaiting ticker/strike'); return; }

    if (lastPeriodKey !== periodKey) {
        lastPeriodKey = periodKey;
        soldThisPeriod = false;
        reentriesThisPeriod = 0;
        lastSellAt = 0;
    }

    const stop = dailyStopHit();
    if (stop) { setThought('stopped', `STOPPED: ${stop}`); return; }
    if (currentPosition) { setThought('holding', `holding ${currentPosition.contracts}x ${currentPosition.side}`, { side: currentPosition.side, contracts: currentPosition.contracts }); return; }
    if (soldThisPeriod) { setThought('idle', 'already sold this period — no re-entry'); return; }

    const bq = prediction?._betQuality;
    if (!bq || !bq.shouldBet) {
        setThought('skip', bq ? `SKIP: ${bq.skipReason}` : 'no bet quality', bq ? {
            edge: bq.edge,
            quality: bq.quality,
            probability: bq.factors?.probability,
            kellyHasEdge: (bq.kellyFraction || 0) > 0,
        } : null);
        decisionLog.logSkip({ periodKey, strike, reason: bq?.skipReason || 'no quality', prediction });
        return;
    }

    const goingUp = prediction.predictedPrice >= strike;
    const side = goingUp ? 'yes' : 'no';
    const askCents = bq.factors?.ask;
    if (askCents == null) { setThought('skip', 'SKIP: no ask quote'); return; }

    const cap = bq.convictionTier === 'high' ? config.convictionMaxContracts : config.maxPositionContracts;
    const contracts = Math.min(cap, Math.max(1, bq.betSize || config.baseContracts));

    decisionLog.logTradeExecution({ periodKey, strike, side, contracts, limitPrice: askCents, edge: bq.edge, prediction });
    await placeBuy({ ticker, side, contracts, askCents, periodKey, strike, prediction, edge: bq.edge, betQuality: bq });
}

async function onSellSignal(sellSignal, minutesRemaining, prediction, strike, currentPrice) {
    if (killSwitch || !currentPosition) return;
    if (!sellSignal) return;

    if (sellSignal.level === 'lost_cause' || sellSignal.level === 'confident_flip') {
        // Block reflexive sells: a buy that was placed seconds ago shouldn't
        // be flushed by a transient sellSignal. The sellSignal will fire
        // again on the next cycle if the thesis really has flipped.
        const heldSec = (Date.now() - (lastEntryTime || 0)) / 1000;
        if (heldSec < (config.minHoldSeconds || 0)) {
            setThought('holding', `holding ${currentPosition.contracts}x ${currentPosition.side} (min hold ${Math.ceil((config.minHoldSeconds||0) - heldSec)}s left)`);
            eventLog.log('min_hold_block', {
                asset: assetKey, sellLevel: sellSignal.level, heldSec: Math.round(heldSec),
                minHoldSeconds: config.minHoldSeconds, side: currentPosition.side, ticker: currentPosition.ticker,
            });
            return;
        }
        // Don't hammer Kalshi with duplicate sells while a previous sell
        // order is still resting — wait at least 30s between attempts.
        const sinceLastSellSec = (Date.now() - (lastSellAt || 0)) / 1000;
        if (lastSellAt && sinceLastSellSec < 30) {
            setThought('holding', `sell already pending (${Math.round(sinceLastSellSec)}s ago) — waiting`);
            eventLog.log('sell_throttled', {
                asset: assetKey, sinceLastSellSec: Math.round(sinceLastSellSec),
                ticker: currentPosition.ticker,
            });
            return;
        }
        lastSellAt = Date.now();
        decisionLog.logSellDecision({
            sellSignal, minutesRemaining, acted: true,
            currentPrice, strike,
        });
        await placeSell(sellSignal.advice || sellSignal.level);
    } else {
        setThought('holding', `holding through ${sellSignal.shortLabel || sellSignal.level}`);
    }
}

async function onPeriodEnd({ correct, periodKey, actualDirection, strikePrice, settlementPrice }) {
    soldThisPeriod = false;
    if (!currentPosition || currentPosition.periodKey !== periodKey) {
        // Position may have been sold already this period; nothing to settle
        return;
    }
    const { ticker, side, contracts, totalCostCents } = currentPosition;
    // Did our side win?
    const won = correct === true; // server only flags `correct` for our predicted direction
    const settleCents = won ? 100 : 0;
    const proceeds = settleCents * contracts;

    if (config.paperMode) {
        setPaperBal(paperBal() + proceeds);
    }

    const pnl = proceeds - totalCostCents;
    ensureDailyStats();
    dailyStats.pnlCents += pnl;
    if (won) dailyStats.wins += 1; else dailyStats.losses += 1;

    pushTrade({
        type: 'settle', action: 'settle', side, direction: side, contracts,
        limitPrice: settleCents, ticker, periodKey, pnlCents: pnl,
        won, correct: won, actualDirection, strikePrice, settlementPrice,
        paperMode: config.paperMode,
    });
    decisionLog.logSettlement({ periodKey, won, pnlCents: pnl, contracts, side, actualDirection, settlementPrice });

    currentPosition = null;
    persistDailyStats();
    snapshotBalanceToDB().catch(() => {});
}

// ── Mid-period strategies (intentionally minimal) ─────────────────
async function onDipOpportunity(prediction, sellSignal, strike, currentPrice, minutesRemaining, ticker, periodKey) {
    if (killSwitch || !currentPosition || currentPosition.periodKey !== periodKey) return;
    if (sellSignal && (sellSignal.level === 'lost_cause' || sellSignal.level === 'confident_flip')) return;
    const bq = prediction?._betQuality;
    if (!bq || !bq.shouldBet) return;
    if (currentPosition.totalContracts >= config.maxPositionContracts) return;

    const askCents = bq.factors?.ask;
    if (askCents == null || askCents >= currentPosition.entryPrice - 3) return; // require ≥3c improvement
    const room = config.maxPositionContracts - currentPosition.totalContracts;
    const addContracts = Math.max(1, Math.min(room, Math.floor(bq.betSize / 2)));

    if (config.paperMode) {
        const cost = askCents * addContracts;
        if (paperBal() < cost) return;
        setPaperBal(paperBal() - cost);
    } else {
        try {
            const yesPrice = currentPosition.side === 'yes' ? askCents : undefined;
            const noPrice  = currentPosition.side === 'no'  ? askCents : undefined;
            await kalshi.placeOrder({ ticker, side: currentPosition.side, action: 'buy', count: addContracts, yesPrice, noPrice });
        } catch (e) {
            setThought('error', `dip add failed: ${e.message}`);
            return;
        }
    }

    if (config.paperMode) {
        currentPosition.totalContracts += addContracts;
        currentPosition.totalCostCents += askCents * addContracts;
    } // else: refreshLivePosition will update from Kalshi
    const dipImprovement = (currentPosition.entryPrice - askCents).toFixed(1) + 'c';
    pushTrade({
        type: 'dip_buy', action: 'buy', side: currentPosition.side, direction: currentPosition.side,
        contracts: addContracts, limitPrice: askCents, ticker, periodKey,
        dipImprovement, paperMode: config.paperMode,
    });
    decisionLog.logMidPeriodStrategy({ kind: 'dip_buy', periodKey, addContracts, askCents, dipImprovement });
}

async function onLateLock(prediction, strike, currentPrice, minutesRemaining, ticker, periodKey) {
    if (killSwitch) return;
    if (currentPosition && currentPosition.totalContracts >= config.convictionMaxContracts) return;
    if ((minutesRemaining || 0) >= 2) return;
    if ((prediction?.probability ?? 0) < 0.95 && (1 - (prediction?.probability ?? 1)) < 0.95) return;

    const goingUp = prediction.predictedPrice >= strike;
    const side = goingUp ? 'yes' : 'no';
    const askCents = prediction._betQuality?.factors?.ask;
    if (askCents == null || askCents >= 95) return;

    const sigmaDistance = Math.abs(currentPrice - strike).toFixed(0);
    const room = currentPosition
        ? Math.max(0, config.convictionMaxContracts - currentPosition.totalContracts)
        : config.maxPositionContracts;
    const contracts = Math.max(1, Math.min(room, config.baseContracts));
    if (contracts <= 0) return;

    if (config.paperMode) {
        const cost = askCents * contracts;
        if (paperBal() < cost) return;
        setPaperBal(paperBal() - cost);
    } else {
        try {
            const yesPrice = side === 'yes' ? askCents : undefined;
            const noPrice  = side === 'no'  ? askCents : undefined;
            await kalshi.placeOrder({ ticker, side, action: 'buy', count: contracts, yesPrice, noPrice });
        } catch (e) {
            setThought('error', `late lock failed: ${e.message}`);
            return;
        }
    }

    // Paper mode: update currentPosition optimistically.
    // Live mode: skip — refreshLivePosition will pull truth from Kalshi.
    if (config.paperMode) {
        if (!currentPosition) {
            currentPosition = {
                ticker, side, action: 'buy', contracts, entryPrice: askCents,
                orderId: 'late-lock-' + Date.now(), periodKey, strike,
                totalCostCents: askCents * contracts, totalContracts: contracts, entryTime: Date.now(),
            };
            lastEntryTime = Date.now();
        } else {
            currentPosition.totalContracts += contracts;
            currentPosition.totalCostCents += askCents * contracts;
        }
    } else {
        // Anchor metadata so the position pulled from Kalshi inherits the
        // right period/strike when it lands.
        metaByTicker[ticker] = {
            periodKey, strike,
            entryTime: (metaByTicker[ticker] && metaByTicker[ticker].entryTime) || null,
        };
        pendingOrderTicker = ticker;
        pendingOrderPlacedAt = Date.now();
    }
    pushTrade({
        type: 'late_lock', action: 'buy', side, direction: side,
        contracts, limitPrice: askCents, ticker, periodKey,
        sigmaDistance: sigmaDistance + 'pts', paperMode: config.paperMode,
        pendingFill: !config.paperMode,
    });
    decisionLog.logMidPeriodStrategy({ kind: 'late_lock', periodKey, contracts, askCents });
}

async function onReentryCheck(prediction, strike, currentPrice, minutesRemaining, ticker, periodKey) {
    if (killSwitch || currentPosition) return;
    if (!soldThisPeriod) return;
    if ((minutesRemaining || 0) < 5) return;
    // Hard cap re-entries per period — without this, every sell could be
    // immediately followed by another buy, leading to BUY/SELL/BUY/SELL
    // thrash that bleeds bid-ask spread on every round-trip.
    if (reentriesThisPeriod >= (config.maxReentriesPerPeriod ?? 1)) {
        setThought('skip', `re-entry cap reached (${reentriesThisPeriod}/${config.maxReentriesPerPeriod ?? 1})`);
        eventLog.log('reentry_cap', {
            asset: assetKey, periodKey, reentriesThisPeriod,
            cap: config.maxReentriesPerPeriod ?? 1,
        });
        return;
    }
    const bq = prediction?._betQuality;
    if (!bq || !bq.shouldBet) return;
    if (bq.edge < 0.10) return; // higher bar for re-entry

    reentriesThisPeriod += 1;
    soldThisPeriod = false;     // allow this re-entry
    await onNewPrediction(prediction, ticker, strike, periodKey);
}

// ── Manual controls ───────────────────────────────────────────────
async function forceBet(prediction, ticker, strike, periodKey, contractsOverride, directionOverride, askOverride) {
    if (!ticker || !strike) return { ok: false, reason: 'missing ticker/strike' };
    let side;
    if (directionOverride === 'up' || directionOverride === 'down') {
        side = directionOverride === 'up' ? 'yes' : 'no';
    } else {
        const goingUp = prediction.predictedPrice >= strike;
        side = goingUp ? 'yes' : 'no';
    }
    const askCents = (typeof askOverride === 'number') ? askOverride : prediction?._betQuality?.factors?.ask;
    if (askCents == null) return { ok: false, reason: 'no ask quote for ' + side };
    const contracts = Math.max(1, Math.min(config.convictionMaxContracts, contractsOverride || config.baseContracts));
    return placeBuy({ ticker, side, contracts, askCents, periodKey, strike, prediction, edge: prediction?._betQuality?.edge, betQuality: prediction?._betQuality });
}

async function pressBet(arg1) {
    if (!currentPosition) return { ok: false, reason: 'no position' };
    const addContracts = typeof arg1 === 'number' ? arg1 : config.baseContracts;
    const { ticker, side, periodKey, entryPrice } = currentPosition;
    if (config.paperMode) {
        const cost = entryPrice * addContracts;
        if (paperBal() < cost) return { ok: false, reason: 'insufficient paper balance' };
        setPaperBal(paperBal() - cost);
    } else {
        try {
            const yesPrice = side === 'yes' ? entryPrice : undefined;
            const noPrice  = side === 'no'  ? entryPrice : undefined;
            await kalshi.placeOrder({ ticker, side, action: 'buy', count: addContracts, yesPrice, noPrice });
        } catch (e) { return { ok: false, reason: e.message }; }
    }
    if (config.paperMode) {
        currentPosition.totalContracts += addContracts;
        currentPosition.totalCostCents += entryPrice * addContracts;
    } // else: refreshLivePosition will pick up the new contracts from Kalshi
    pushTrade({
        type: 'press', action: 'buy', side, direction: side,
        contracts: addContracts, limitPrice: entryPrice, ticker, periodKey,
        paperMode: config.paperMode,
    });
    return { ok: true, position: currentPosition };
}

async function forceSell() {
    if (!currentPosition) return { ok: false, reason: 'no position' };
    return placeSell('manual force sell');
}

// ── Status / config knobs ─────────────────────────────────────────
function setKillSwitch(active) {
    killSwitch = !!active;
    setThought(killSwitch ? 'killed' : 'idle', killSwitch ? 'KILL SWITCH ON' : 'kill-switch off');
    // Persist so a restart respects the operator's last decision rather than
    // silently re-enabling trading on the in-memory default.
    saveKillSwitchToDB();
}

async function saveKillSwitchToDB() {
    try { await db.saveStoreState('kill-switch', { active: killSwitch }); }
    catch (e) { /* non-fatal */ }
}

function setPaperMode(paperMode) {
    config.paperMode = !!paperMode;
}

function setPaperBalance(env, cents) {
    if (env !== 'demo' && env !== 'production') env = activeEnv();
    paperBalances[env] = Math.max(0, Math.round(cents));
    savePaperBalancesToDB();
    return paperBalances[env];
}

function addPaperBalance(env, cents) {
    if (env !== 'demo' && env !== 'production') env = activeEnv();
    paperBalances[env] = Math.max(0, Math.round((paperBalances[env] || 0) + cents));
    savePaperBalancesToDB();
    return paperBalances[env];
}

function getPaperBalances() {
    return { ...paperBalances };
}

// Fetch + cache the live Kalshi balance for the active environment.
// Non-blocking: returns cached value immediately, refreshes async on staleness.
function refreshLiveBalanceIfStale() {
    const env = activeEnv();
    if (Date.now() - liveBalanceFetchedAt[env] < LIVE_BALANCE_TTL_MS) return;
    if (liveBalanceInflight[env]) return;
    if (!(kalshiAuth.isConfigured && kalshiAuth.isConfigured())) return;

    liveBalanceInflight[env] = (async () => {
        try {
            const resp = await kalshi.getBalance();
            // Kalshi returns { balance: <int cents> } per their API; defensive parse.
            const cents = typeof resp?.balance === 'number'
                ? resp.balance
                : typeof resp?.balance_cents === 'number'
                    ? resp.balance_cents
                    : null;
            if (cents != null && isFinite(cents)) {
                liveBalanceCache[env] = Math.round(cents);
                liveBalanceFetchedAt[env] = Date.now();
            }
        } catch (e) {
            // Don't spam logs if we just don't have credentials yet
            if (!/not configured|401|403/i.test(e.message || '')) {
                console.error('[trade-executor] live balance fetch failed:', e.message);
            }
            liveBalanceFetchedAt[env] = Date.now(); // back off retries
        } finally {
            liveBalanceInflight[env] = null;
        }
    })();
}

function getStatus() {
    ensureDailyStats();
    if (!config.paperMode) refreshLiveBalanceIfStale();

    let posOut = null;
    if (currentPosition) {
        posOut = {
            ...currentPosition,
            holdingSeconds: Math.round((Date.now() - currentPosition.entryTime) / 1000),
        };
    }
    const balanceCents = config.paperMode ? paperBal() : liveBalanceCache[activeEnv()];
    return {
        paperMode: config.paperMode,
        killSwitch,
        configured: kalshiAuth.isConfigured ? kalshiAuth.isConfigured() : false,
        balanceCents: balanceCents != null ? balanceCents : null,
        currentPosition: posOut,
        soldThisPeriod,
        daily: { ...dailyStats },
        config: { ...config },
        recentTrades: recentTrades.slice(0, 50),
        thought,
    };
}

// ── Persistence ───────────────────────────────────────────────────
async function persistDailyStats() {
    if (!isBtc) return; // schema currently BTC-only; multi-asset migration TODO
    try { await db.saveDailyStats(dailyStats); } catch (e) { /* non-fatal */ }
    try { await db.savePosition(currentPosition); } catch (e) { /* non-fatal */ }
}

async function snapshotBalanceToDB() {
    try {
        await db.saveBalanceSnapshot({
            timestamp: new Date().toISOString(),
            environment: activeEnv(),
            paperMode: config.paperMode,
            balanceCents: paperBal(),
            paperBalances: { ...paperBalances },
            dailyStats: { ...dailyStats },
        });
    } catch (e) { /* non-fatal */ }
}

async function initFromDB() {
    if (!isBtc) return; // schema currently BTC-only; ETH starts fresh
    // Kill switch: load the operator's last decision. Module default is ON
    // (safety) so if there's no saved row the bot stays parked until the user
    // explicitly enables trading.
    try {
        const saved = await db.loadStoreState('kill-switch');
        if (saved && typeof saved === 'object' && typeof saved.active === 'boolean') {
            killSwitch = saved.active;
            setThought(killSwitch ? 'killed' : 'idle', killSwitch ? 'KILL SWITCH ON (loaded from DB)' : 'kill-switch off (loaded from DB)');
        } else {
            setThought('killed', 'KILL SWITCH ON (default — flip off in UI to enable trading)');
        }
        console.log(`[trade-executor] Kill switch on startup: ${killSwitch ? 'ON' : 'off'}`);
    } catch (e) { /* non-fatal — keep default ON */ }
    try {
        const stats = await db.loadDailyStats(todayKey());
        if (stats) dailyStats = { ...dailyStats, ...stats, date: todayKey() };
    } catch (e) { /* non-fatal */ }
    try {
        const pos = await db.loadPosition();
        if (pos && pos.totalContracts > 0) currentPosition = pos;
    } catch (e) { /* non-fatal */ }
    try {
        const trades = await db.getRecentTrades(50);
        if (Array.isArray(trades) && trades.length) recentTrades = trades;
    } catch (e) { /* non-fatal */ }
    // Restore user-tuned config + paper balances across restarts so settings
    // edits survive Railway redeploys instead of reverting to in-code defaults.
    try {
        const saved = await db.loadStoreState('trading-config');
        if (saved && typeof saved === 'object') {
            for (const k of ['baseContracts', 'maxPositionContracts', 'convictionMaxContracts', 'maxDailyLossCents', 'maxDailyTrades']) {
                if (typeof saved[k] === 'number' && saved[k] > 0) config[k] = saved[k];
            }
            for (const k of ['maxReentriesPerPeriod', 'minHoldSeconds']) {
                if (typeof saved[k] === 'number' && saved[k] >= 0) config[k] = saved[k];
            }
        }
    } catch (e) { /* non-fatal */ }
    try {
        const savedBalances = await db.loadStoreState('paper-balances');
        if (savedBalances && typeof savedBalances === 'object') {
            for (const env of ['demo', 'production']) {
                if (typeof savedBalances[env] === 'number' && savedBalances[env] >= 0) {
                    paperBalances[env] = Math.round(savedBalances[env]);
                }
            }
        }
    } catch (e) { /* non-fatal */ }
}

// Persist user config to DB so /api/trading/config edits survive restarts.
async function saveConfigToDB() {
    try {
        await db.saveStoreState('trading-config', {
            baseContracts: config.baseContracts,
            maxPositionContracts: config.maxPositionContracts,
            convictionMaxContracts: config.convictionMaxContracts,
            maxDailyLossCents: config.maxDailyLossCents,
            maxDailyTrades: config.maxDailyTrades,
            maxReentriesPerPeriod: config.maxReentriesPerPeriod,
            minHoldSeconds: config.minHoldSeconds,
        });
    } catch (e) { /* non-fatal */ }
}

async function savePaperBalancesToDB() {
    try { await db.saveStoreState('paper-balances', { ...paperBalances }); }
    catch (e) { /* non-fatal */ }
}

// Public setter the server.js config endpoint should call so changes
// are persisted, not just mutated in-memory.
function applyConfig(updates) {
    const allowed = ['baseContracts', 'maxPositionContracts', 'convictionMaxContracts', 'maxDailyLossCents', 'maxDailyTrades', 'maxReentriesPerPeriod', 'minHoldSeconds'];
    const bounds = {
        baseContracts: 5000,
        maxPositionContracts: 10000,
        convictionMaxContracts: 10000,
        maxDailyLossCents: 10000000, // $100k
        maxDailyTrades: 10000,
        maxReentriesPerPeriod: 20,
        minHoldSeconds: 900, // up to a full 15m period
    };
    // Settings that may be set to 0 to mean 'disabled'.
    const allowZero = new Set(['maxReentriesPerPeriod', 'minHoldSeconds']);
    const applied = {};
    const rejected = [];
    for (const key of allowed) {
        if (updates[key] === undefined) continue;
        const val = parseInt(updates[key], 10);
        const max = bounds[key];
        const minOk = allowZero.has(key) ? 0 : 1;
        if (!Number.isFinite(val)) { rejected.push({ key, value: updates[key], reason: 'not a number' }); continue; }
        if (val < minOk)           { rejected.push({ key, value: val, reason: minOk === 0 ? 'must be >= 0' : 'must be > 0' }); continue; }
        if (val > max)             { rejected.push({ key, value: val, reason: `exceeds max ${max}` }); continue; }
        config[key] = val;
        applied[key] = val;
    }
    saveConfigToDB();
    return { applied, rejected };
}

function resetState() {
    currentPosition = null;
    soldThisPeriod = false;
    lastPeriodKey = null;
    reentriesThisPeriod = 0;
    lastEntryTime = 0;
    dailyStats = { date: todayKey(), tradeCount: 0, wins: 0, losses: 0, pnlCents: 0 };
    recentTrades = [];
    setThought('idle', 'state reset');
}

return {
    assetKey,
    initFromDB,
    setMarketData,
    reconcileFromKalshi,
    clearLocalPosition,
    onNewPrediction,
    onSellSignal,
    onPeriodEnd,
    onDipOpportunity,
    onLateLock,
    onReentryCheck,
    setKillSwitch,
    setPaperMode,
    setPaperBalance,
    addPaperBalance,
    getPaperBalances,
    clearTradeLog,
    resetState,
    getStatus,
    onTradeNotify,
    forceBet,
    pressBet,
    forceSell,
    snapshotBalanceToDB,
    applyConfig,
    config,
};
} // end createExecutor

// Default export = BTC executor (preserves existing single-asset call sites)
const _btc = createExecutor('btc');
module.exports = _btc;
module.exports.createExecutor = createExecutor;
