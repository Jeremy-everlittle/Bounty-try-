'use strict';

// ═══════════════════════════════════════════════════════════════
// Trade Executor — Bridges prediction signals to Kalshi orders
// ═══════════════════════════════════════════════════════════════
// Reads signals from: assessBetQuality(), assessSellSignal()
// Executes via: kalshi-trading.js
// Safety: paper mode, daily loss limit, position cap, kill switch
// ═══════════════════════════════════════════════════════════════

const trading = require('./kalshi-trading');

// ── Configuration (from env, with safe defaults) ──
const config = {
    paperMode: (process.env.PAPER_MODE || 'true').toLowerCase() === 'true',
    baseContracts: parseInt(process.env.BASE_CONTRACTS || '5', 10),
    maxPositionContracts: parseInt(process.env.MAX_POSITION_CONTRACTS || '10', 10),
    maxDailyLossCents: parseInt(process.env.MAX_DAILY_LOSS || '1000', 10), // $10
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '50', 10),
};

// ── State ──
let currentPosition = null;   // { ticker, side, action, contracts, entryPrice, orderId, periodKey }
let killSwitch = false;

const dailyStats = {
    date: new Date().toISOString().slice(0, 10),
    pnlCents: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
};

const tradeLog = [];           // recent trades for dashboard (max 100)
const MAX_TRADE_LOG = 100;

// ═══════════════════════════════════════════════════════════════
// Daily reset
// ═══════════════════════════════════════════════════════════════

function checkDayRollover() {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyStats.date !== today) {
        dailyStats.date = today;
        dailyStats.pnlCents = 0;
        dailyStats.tradeCount = 0;
        dailyStats.wins = 0;
        dailyStats.losses = 0;
    }
}

// ═══════════════════════════════════════════════════════════════
// Safety checks
// ═══════════════════════════════════════════════════════════════

function canTrade() {
    checkDayRollover();

    if (killSwitch) return { ok: false, reason: 'Kill switch active' };
    if (!trading.isConfigured() && !config.paperMode) {
        return { ok: false, reason: 'Kalshi API not configured (set KALSHI_API_KEY + KALSHI_PRIVATE_KEY)' };
    }
    if (dailyStats.pnlCents <= -config.maxDailyLossCents) {
        return { ok: false, reason: `Daily loss limit reached ($${(Math.abs(dailyStats.pnlCents) / 100).toFixed(2)})` };
    }
    if (dailyStats.tradeCount >= config.maxDailyTrades) {
        return { ok: false, reason: `Daily trade limit reached (${dailyStats.tradeCount})` };
    }
    return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// Entry: called when a new prediction is made
// ═══════════════════════════════════════════════════════════════

async function onNewPrediction(prediction, kalshiTicker, strike, periodKey) {
    if (!prediction || !kalshiTicker || strike === null) return;

    const betQuality = prediction._betQuality;
    if (!betQuality || !betQuality.shouldBet || betQuality.betSize <= 0) return;

    // Don't enter if we already have a position for this period
    if (currentPosition && currentPosition.periodKey === periodKey) return;

    // Close stale position from a previous period (shouldn't happen — they auto-settle)
    if (currentPosition && currentPosition.periodKey !== periodKey) {
        console.log(`[trade-executor] Clearing stale position from ${currentPosition.periodKey}`);
        currentPosition = null;
    }

    const check = canTrade();
    if (!check.ok) {
        console.log(`[trade-executor] Skipping entry: ${check.reason}`);
        return;
    }

    const isUp = prediction.predictedPrice >= strike;
    const side = isUp ? 'yes' : 'no';
    const contracts = Math.max(1, Math.min(
        config.maxPositionContracts,
        Math.round(betQuality.betSize * config.baseContracts)
    ));

    // Determine limit price from probability
    // If we predict UP (buy YES), we're willing to pay up to our probability in cents
    // e.g. probability=0.65 → willing to pay 65c for YES contract
    const probForBet = isUp ? prediction.probability : (1 - prediction.probability);
    const limitPrice = Math.max(5, Math.min(95, Math.round(probForBet * 100)));

    const tradeInfo = {
        ticker: kalshiTicker,
        side,
        action: 'buy',
        contracts,
        limitPrice,
        periodKey,
        direction: isUp ? 'UP' : 'DOWN',
        edge: (betQuality.edge * 100).toFixed(1) + '%',
        quality: (betQuality.quality * 100).toFixed(0) + '%',
        betSize: betQuality.betSize.toFixed(2),
    };

    if (config.paperMode) {
        console.log(`[trade-executor] PAPER BUY: ${contracts}x ${side.toUpperCase()} on ${kalshiTicker} @ ${limitPrice}c | Edge=${tradeInfo.edge} Quality=${tradeInfo.quality}`);
        currentPosition = {
            ticker: kalshiTicker,
            side,
            contracts,
            entryPrice: limitPrice,
            orderId: 'paper-' + Date.now(),
            periodKey,
            entryTime: Date.now(),
        };
        logTrade('buy', tradeInfo);
        dailyStats.tradeCount++;
        return;
    }

    // ── LIVE ORDER ──
    try {
        // Check balance first
        const balanceResp = await trading.getBalance();
        const availableCents = balanceResp.balance;
        const costEstimate = contracts * limitPrice; // max cost in cents
        if (costEstimate > availableCents) {
            console.log(`[trade-executor] Insufficient balance: need ${costEstimate}c, have ${availableCents}c`);
            return;
        }

        // Use GTC (good-til-canceled) so the order rests on the book if not
        // immediately matched.  FOK/IOC fail with 409 on demo when there is
        // no opposing liquidity.
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side,
            action: 'buy',
            count: contracts,
            yesPrice: side === 'yes' ? limitPrice : undefined,
            noPrice: side === 'no' ? limitPrice : undefined,
        });

        const order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            console.log(`[trade-executor] Order not filled: ${order.status} — ${order.cancel_reason || 'unknown'}`);
            logTrade('buy_failed', { ...tradeInfo, reason: order.status });
            return;
        }

        currentPosition = {
            ticker: kalshiTicker,
            side,
            contracts: order.count || contracts,
            entryPrice: limitPrice,
            orderId: order.order_id,
            periodKey,
            entryTime: Date.now(),
        };
        logTrade('buy', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status });
        dailyStats.tradeCount++;
        console.log(`[trade-executor] LIVE BUY: ${contracts}x ${side.toUpperCase()} on ${kalshiTicker} — order ${order.order_id}`);

    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response) : '';
        console.error(`[trade-executor] Order failed:`, err.message, detail ? `| Response: ${detail}` : '');
        logTrade('buy_error', { ...tradeInfo, error: err.message, response: err.response });

        // On 409 (conflict/insufficient funds), don't retry this period
        if (err.status === 409) {
            currentPosition = { ticker: kalshiTicker, side, contracts: 0, entryPrice: 0, orderId: 'blocked-409', periodKey, entryTime: Date.now() };
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Exit: called every 10s when sell signal updates
// ═══════════════════════════════════════════════════════════════

async function onSellSignal(sellSignal, minutesRemaining) {
    if (!currentPosition || !sellSignal) return;

    const shouldSell = (
        sellSignal.level === 'lost_cause' ||
        sellSignal.level === 'sell_now' ||
        (sellSignal.level === 'take_profit' && minutesRemaining < 2) ||
        (sellSignal.level === 'consider_selling' && minutesRemaining < 1.5)
    );

    if (!shouldSell) return;

    const tradeInfo = {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts: currentPosition.contracts,
        action: 'sell',
        reason: sellSignal.level,
        urgency: sellSignal.urgency,
        minutesRemaining: minutesRemaining.toFixed(1),
    };

    if (config.paperMode) {
        console.log(`[trade-executor] PAPER SELL: ${currentPosition.contracts}x ${currentPosition.side.toUpperCase()} on ${currentPosition.ticker} — reason: ${sellSignal.level}`);
        logTrade('sell', tradeInfo);
        dailyStats.tradeCount++;
        currentPosition = null;
        return;
    }

    // ── LIVE SELL ──
    try {
        const result = await trading.placeOrder({
            ticker: currentPosition.ticker,
            side: currentPosition.side,
            action: 'sell',
            count: currentPosition.contracts,
            // Sell at a price that's likely to fill — accept some slippage
            yesPrice: currentPosition.side === 'yes' ? Math.max(1, currentPosition.entryPrice - 10) : undefined,
            noPrice: currentPosition.side === 'no' ? Math.max(1, currentPosition.entryPrice - 10) : undefined,
        });

        const order = result.order || {};
        console.log(`[trade-executor] LIVE SELL: order ${order.order_id} status=${order.status}`);
        logTrade('sell', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status });
        dailyStats.tradeCount++;
        currentPosition = null;

    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response) : '';
        console.error(`[trade-executor] Sell failed:`, err.message, detail ? `| Response: ${detail}` : '');
        logTrade('sell_error', { ...tradeInfo, error: err.message, response: err.response });
        // Don't clear position — will retry next cycle or auto-settle
    }
}

// ═══════════════════════════════════════════════════════════════
// Period end: called when prediction is graded
// ═══════════════════════════════════════════════════════════════

function onPeriodEnd(gradeResult) {
    if (!currentPosition) return;

    // Position auto-settles on Kalshi. Track the P&L.
    const wasCorrect = gradeResult && gradeResult.correct;
    const contracts = currentPosition.contracts;
    const entryPrice = currentPosition.entryPrice;

    // P&L: if correct, payout is 100c per contract - entry. If wrong, lose entry.
    let pnl;
    if (wasCorrect) {
        pnl = contracts * (100 - entryPrice); // profit per contract
        dailyStats.wins++;
    } else {
        pnl = -contracts * entryPrice; // loss per contract
        dailyStats.losses++;
    }
    dailyStats.pnlCents += pnl;

    logTrade('settle', {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts,
        entryPrice,
        correct: wasCorrect,
        pnlCents: pnl,
        dailyPnlCents: dailyStats.pnlCents,
    });

    console.log(`[trade-executor] Period settled: ${wasCorrect ? 'WIN' : 'LOSS'} | P&L: ${pnl > 0 ? '+' : ''}${(pnl / 100).toFixed(2)} | Daily: ${dailyStats.pnlCents > 0 ? '+' : ''}$${(dailyStats.pnlCents / 100).toFixed(2)}`);

    currentPosition = null;
}

// ═══════════════════════════════════════════════════════════════
// Controls
// ═══════════════════════════════════════════════════════════════

function setKillSwitch(active) {
    killSwitch = active;
    console.log(`[trade-executor] Kill switch ${active ? 'ACTIVATED' : 'deactivated'}`);
    if (active && currentPosition && !config.paperMode) {
        // Try to sell the current position immediately
        trading.placeOrder({
            ticker: currentPosition.ticker,
            side: currentPosition.side,
            action: 'sell',
            count: currentPosition.contracts,
            yesPrice: currentPosition.side === 'yes' ? 1 : undefined,
            noPrice: currentPosition.side === 'no' ? 1 : undefined,
            timeInForce: 'fill_or_kill',
        }).then(() => {
            console.log('[trade-executor] Emergency sell executed');
            currentPosition = null;
        }).catch(err => {
            console.error('[trade-executor] Emergency sell failed:', err.message);
        });
    }
}

function setPaperMode(enabled) {
    config.paperMode = enabled;
    console.log(`[trade-executor] Mode: ${enabled ? 'PAPER' : 'LIVE'}`);
}

function resetState() {
    currentPosition = null;
    dailyStats.date = new Date().toISOString().slice(0, 10);
    dailyStats.pnlCents = 0;
    dailyStats.tradeCount = 0;
    dailyStats.wins = 0;
    dailyStats.losses = 0;
    tradeLog.length = 0;
    killSwitch = true;
    console.log('[trade-executor] State reset — kill switch activated');
}

// ═══════════════════════════════════════════════════════════════
// Status & logging
// ═══════════════════════════════════════════════════════════════

function logTrade(type, info) {
    const entry = { type, time: new Date().toISOString(), ...info };
    tradeLog.unshift(entry);
    if (tradeLog.length > MAX_TRADE_LOG) tradeLog.length = MAX_TRADE_LOG;
}

function getStatus() {
    checkDayRollover();
    return {
        paperMode: config.paperMode,
        killSwitch,
        configured: trading.isConfigured(),
        currentPosition: currentPosition ? {
            ticker: currentPosition.ticker,
            side: currentPosition.side,
            contracts: currentPosition.contracts,
            entryPrice: currentPosition.entryPrice,
            periodKey: currentPosition.periodKey,
            holdingSeconds: Math.round((Date.now() - currentPosition.entryTime) / 1000),
        } : null,
        daily: { ...dailyStats },
        config: {
            baseContracts: config.baseContracts,
            maxPositionContracts: config.maxPositionContracts,
            maxDailyLossCents: config.maxDailyLossCents,
            maxDailyTrades: config.maxDailyTrades,
        },
        recentTrades: tradeLog.slice(0, 20),
    };
}

module.exports = {
    onNewPrediction,
    onSellSignal,
    onPeriodEnd,
    setKillSwitch,
    setPaperMode,
    resetState,
    getStatus,
    config, // exposed for startup logging
};
