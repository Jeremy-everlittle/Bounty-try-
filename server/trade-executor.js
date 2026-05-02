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
    // Default time-in-force for ALL Kalshi orders we send. 'immediate_or_cancel'
    // fills whatever's matchable now and cancels the remainder, so we don't
    // accumulate resting orders that pollute the book and could fill hours
    // later at stale prices. Set to null to use Kalshi's default (resting
    // limit, GTC) if a specific deploy needs the old behavior.
    // NOTE: Must be the spelled-out value — Kalshi rejects shorthand like 'IOC'
    // with HTTP 400 "invalid parameters".
    orderTimeInForce: 'immediate_or_cancel',
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

// Per-asset operation queue — serializes every public method that reads or
// writes currentPosition or talks to Kalshi. Without this, the fetch loop
// can fire onSellSignal while refreshLivePosition is mid-flight, leading to
// torn reads of currentPosition. Internal helpers (placeBuy/placeSell/etc.)
// are NOT enqueued; they always run inside an already-locked outer call.
let opChain = Promise.resolve();
function enqueue(fn) {
    const next = opChain.then(fn, fn);
    // Don't propagate failures down the chain — one failed op shouldn't
    // poison every subsequent op.
    opChain = next.then(() => undefined, () => undefined);
    return next;
}
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
let lastBuyAt = 0;             // ms epoch of most recent buy (any path) — cooldown floor
const MIN_BUY_INTERVAL_MS = 8000;

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
            // Kalshi shows no relevant position. There are two distinct cases:
            //   A. We had a real position that's now gone (sell completed,
            //      manual exit, or settlement). Mark soldThisPeriod=true so
            //      we don't reflexively re-buy the same period.
            //   B. We placed a buy that hasn't filled yet (still resting on
            //      the book). currentPosition was never set by us — it would
            //      only be here if a previous refresh confirmed it. Clearing
            //      it shouldn't lock out the period because nothing actually
            //      sold. The pending order is still pending.
            // Distinguish by whether the position was previously confirmed by
            // a prior Kalshi refresh (meta.confirmedAt set).
            if (currentPosition) {
                const stale = currentPosition;
                const meta = metaByTicker[stale.ticker] || {};
                const wasConfirmed = !!meta.confirmedAt;
                currentPosition = null;
                if (wasConfirmed) {
                    soldThisPeriod = true; // genuine exit/settlement — don't re-enter
                }
                eventLog.log('position_cleared_by_kalshi', {
                    asset: assetKey, ticker: stale.ticker,
                    contracts: stale.contracts, side: stale.side,
                    activeCount: active.length,
                    wasConfirmed,
                    soldThisPeriodSet: wasConfirmed,
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
            lastEntryTime = Date.now();
        }
        // Mark the position as confirmed by Kalshi. Used by the clear path
        // above to distinguish a real exit from a never-filled order.
        meta.confirmedAt = meta.confirmedAt || Date.now();
        metaByTicker[kpos.ticker] = meta;

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
// Persist on every internal mutation — paper buys/sells route through this
// helper, and without the save the in-memory balance silently drifts away
// from the DB across the trading day until a restart wipes the difference.
function setPaperBal(v) {
    paperBalances[activeEnv()] = Math.max(0, Math.round(v));
    savePaperBalancesToDB();
}

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
    // 1000 entries covers ~250 periods of trading (4 trades each: BUY,
    // PRESS, SELL, settle). The cycle/period log easily reaches that depth,
    // so the trade buffer needs to match — without this, post-restart the
    // history page would show graded periods with empty Trade Activity rows
    // because their trades had aged out of the in-memory buffer.
    if (recentTrades.length > 1000) recentTrades.length = 1000;
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
        const resp = await kalshi.placeOrder({ ticker, side, action: 'buy', count: contracts, yesPrice, noPrice, timeInForce: config.orderTimeInForce || undefined });
        const orderId = resp?.order?.order_id || null;
        metaByTicker[ticker] = {
            periodKey, strike, orderId,
            entryTime: (metaByTicker[ticker] && metaByTicker[ticker].entryTime) || null,
        };
        pendingOrderTicker = ticker;
        pendingOrderPlacedAt = Date.now();
        lastBuyAt = Date.now();
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
        const resp = await kalshi.placeOrder({ ticker, side, action: 'sell', count: contracts, yesPrice, noPrice, timeInForce: config.orderTimeInForce || undefined });
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
        // Drop metadata for tickers from prior periods so a stale `confirmedAt`
        // doesn't trick refreshLivePosition into thinking a stale position is
        // ours, and so `lastEntryTime` from the old period doesn't survive into
        // a new entry's min-hold check.
        for (const t of Object.keys(metaByTicker)) {
            if (metaByTicker[t].periodKey !== periodKey) delete metaByTicker[t];
        }
        // Clear stale pending-order tag if it's older than 5 minutes — that's
        // long enough that a resting order should have either filled or be
        // assumed dead by the operator.
        if (pendingOrderTicker && (Date.now() - pendingOrderPlacedAt) > 5 * 60_000) {
            pendingOrderTicker = null;
            pendingOrderPlacedAt = 0;
        }
    }

    const stop = dailyStopHit();
    if (stop) { setThought('stopped', `STOPPED: ${stop}`); return; }
    if (currentPosition) { setThought('holding', `holding ${currentPosition.contracts}x ${currentPosition.side}`, { side: currentPosition.side, contracts: currentPosition.contracts }); return; }
    // LIVE: an order was placed but Kalshi hasn't reflected the fill yet.
    // Skip — refreshLivePosition will populate currentPosition once Kalshi
    // confirms, and the next cycle will then take the holding branch above.
    // Without this gate, every fetch tick re-fires placeBuy while the first
    // order is still pending, draining the account in seconds.
    if (!config.paperMode && pendingOrderTicker) {
        setThought('holding', `pending live order on ${pendingOrderTicker} — awaiting Kalshi confirmation`);
        return;
    }
    if (!config.paperMode && (Date.now() - lastBuyAt) < MIN_BUY_INTERVAL_MS) {
        setThought('holding', `buy cooldown — ${Math.ceil((MIN_BUY_INTERVAL_MS - (Date.now() - lastBuyAt)) / 1000)}s left`);
        return;
    }
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

    // Side from betQuality (which uses probUp >= 0.5) so the trade matches
    // exactly what the model recommended buying. Falls back to predictedPrice
    // only if betQuality didn't include a side (legacy callers).
    const side = bq.factors?.side || (prediction.probability >= 0.5 ? 'yes' : 'no');
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
    // Only paper mode mutates dailyStats from a synthetic settlement. Live
    // mode P&L is sourced from Kalshi-confirmed fills (each placeBuy/placeSell
    // pushes its real cash flow); double-counting here was tripping the
    // daily-loss kill switch on phantom losses. Wins/losses counters are
    // updated either way so the W/L badge matches reality.
    if (config.paperMode) {
        dailyStats.pnlCents += pnl;
    }
    if (won) dailyStats.wins += 1; else dailyStats.losses += 1;

    pushTrade({
        type: 'settle', action: 'settle', side, direction: side, contracts,
        limitPrice: settleCents, ticker, periodKey,
        pnlCents: config.paperMode ? pnl : null, // live PnL is on Kalshi's books, not ours
        won, correct: won, actualDirection, strikePrice, settlementPrice,
        paperMode: config.paperMode,
    });
    decisionLog.logSettlement({ periodKey, won, pnlCents: pnl, contracts, side, actualDirection, settlementPrice });

    currentPosition = null;
    // Drop the meta entry for this ticker — settlement closes the chapter.
    if (ticker && metaByTicker[ticker]) delete metaByTicker[ticker];
    persistDailyStats();
    snapshotBalanceToDB().catch(() => {});
}

// ── Mid-period strategies (intentionally minimal) ─────────────────
async function onDipOpportunity(prediction, sellSignal, strike, currentPrice, minutesRemaining, ticker, periodKey) {
    if (killSwitch || !currentPosition || currentPosition.periodKey !== periodKey) return;
    if (sellSignal && (sellSignal.level === 'lost_cause' || sellSignal.level === 'confident_flip')) return;
    // LIVE: a previous order on this ticker hasn't been confirmed by Kalshi
    // yet — skip the dip add. currentPosition.totalContracts won't reflect
    // the pending fill, so without this gate we'd stack a dip add on top of
    // an unconfirmed order on every fetch tick.
    if (!config.paperMode && pendingOrderTicker) return;
    if (!config.paperMode && (Date.now() - lastBuyAt) < MIN_BUY_INTERVAL_MS) return;
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
            await kalshi.placeOrder({ ticker, side: currentPosition.side, action: 'buy', count: addContracts, yesPrice, noPrice, timeInForce: config.orderTimeInForce || undefined });
            pendingOrderTicker = ticker;
            pendingOrderPlacedAt = Date.now();
            lastBuyAt = Date.now();
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
    if (!config.paperMode && pendingOrderTicker) return;
    if (!config.paperMode && (Date.now() - lastBuyAt) < MIN_BUY_INTERVAL_MS) return;
    if ((minutesRemaining || 0) >= 2) return;
    if ((prediction?.probability ?? 0) < 0.95 && (1 - (prediction?.probability ?? 1)) < 0.95) return;

    const side = prediction._betQuality?.factors?.side || (prediction.probability >= 0.5 ? 'yes' : 'no');
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
            await kalshi.placeOrder({ ticker, side, action: 'buy', count: contracts, yesPrice, noPrice, timeInForce: config.orderTimeInForce || undefined });
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
        lastBuyAt = Date.now();
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
    // Manual entry must respect every safety gate. The whole point of the
    // kill switch and the daily-loss stop is that they apply UNIVERSALLY,
    // including to operator-driven actions.
    if (killSwitch) return { ok: false, reason: 'kill switch is ON' };
    const stop = dailyStopHit();
    if (stop) return { ok: false, reason: `daily stop hit: ${stop}` };
    if (!ticker || !strike) return { ok: false, reason: 'missing ticker/strike' };
    let side;
    if (directionOverride === 'up' || directionOverride === 'down') {
        side = directionOverride === 'up' ? 'yes' : 'no';
    } else {
        // Match the model's recommendation — probUp drives side, not the
        // mean predicted price (which can sit slightly above strike under
        // skewed vol while probUp is still <0.5).
        side = prediction?._betQuality?.factors?.side
            || ((prediction?.probability ?? 0.5) >= 0.5 ? 'yes' : 'no');
    }
    const askCents = (typeof askOverride === 'number') ? askOverride : prediction?._betQuality?.factors?.ask;
    if (askCents == null) return { ok: false, reason: 'no ask quote for ' + side };
    const contracts = Math.max(1, Math.min(config.convictionMaxContracts, contractsOverride || config.baseContracts));
    return placeBuy({ ticker, side, contracts, askCents, periodKey, strike, prediction, edge: prediction?._betQuality?.edge, betQuality: prediction?._betQuality });
}

async function pressBet(arg1) {
    if (killSwitch) return { ok: false, reason: 'kill switch is ON' };
    const stop = dailyStopHit();
    if (stop) return { ok: false, reason: `daily stop hit: ${stop}` };
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
            await kalshi.placeOrder({ ticker, side, action: 'buy', count: addContracts, yesPrice, noPrice, timeInForce: config.orderTimeInForce || undefined });
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
    // forceSell is intentionally NOT gated by killSwitch or dailyStopHit.
    // The kill switch is meant to stop opening new exposure, but the operator
    // must always be able to close out an existing position — that's the point
    // of an emergency stop.
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
    // Schema is multi-asset post-P2.1: every executor persists to its own
    // asset-keyed row. dailyStats is shared at module scope so we only need
    // to save once per process; do it from BTC's executor to avoid two
    // concurrent writes of identical content.
    if (isBtc) {
        try { await db.saveDailyStats(dailyStats, 'btc'); } catch (e) { /* non-fatal */ }
    }
    try { await db.savePosition(currentPosition, assetKey); } catch (e) { /* non-fatal */ }
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
    // Kill switch + paperBalances + trading-config are SHARED across both
    // executors (module-scope state). Load them only from BTC's init pass to
    // avoid two concurrent loaders racing on the same keys.
    if (isBtc) {
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
            const stats = await db.loadDailyStats(todayKey(), 'btc');
            if (stats) dailyStats = { ...dailyStats, ...stats, date: todayKey() };
        } catch (e) { /* non-fatal */ }
        try {
            // Match the in-memory cap so a restart restores the full window
            // of trade history that the period-history renderer expects.
            const trades = await db.getRecentTrades(1000);
            if (Array.isArray(trades) && trades.length) recentTrades = trades;
        } catch (e) { /* non-fatal */ }
    }
    // Per-asset position load — both BTC and ETH read from their own row.
    try {
        const pos = await db.loadPosition(assetKey);
        if (pos && pos.totalContracts > 0) currentPosition = pos;
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

// Methods that read/write currentPosition or call Kalshi go through the
// per-asset op queue so they execute serially. Synchronous setters/getters
// (setKillSwitch, getStatus, getPaperBalances, etc.) bypass the queue.
return {
    assetKey,
    initFromDB,
    setMarketData,
    reconcileFromKalshi: (...args) => enqueue(() => reconcileFromKalshi(...args)),
    clearLocalPosition: (...args) => enqueue(() => clearLocalPosition(...args)),
    onNewPrediction: (...args) => enqueue(() => onNewPrediction(...args)),
    onSellSignal: (...args) => enqueue(() => onSellSignal(...args)),
    onPeriodEnd: (...args) => enqueue(() => onPeriodEnd(...args)),
    onDipOpportunity: (...args) => enqueue(() => onDipOpportunity(...args)),
    onLateLock: (...args) => enqueue(() => onLateLock(...args)),
    onReentryCheck: (...args) => enqueue(() => onReentryCheck(...args)),
    forceBet: (...args) => enqueue(() => forceBet(...args)),
    pressBet: (...args) => enqueue(() => pressBet(...args)),
    forceSell: (...args) => enqueue(() => forceSell(...args)),
    setKillSwitch,
    setPaperMode,
    setPaperBalance,
    addPaperBalance,
    getPaperBalances,
    clearTradeLog,
    resetState,
    getStatus,
    onTradeNotify,
    snapshotBalanceToDB,
    applyConfig,
    config,
};
} // end createExecutor

// Default export = BTC executor (preserves existing single-asset call sites)
const _btc = createExecutor('btc');
module.exports = _btc;
module.exports.createExecutor = createExecutor;
