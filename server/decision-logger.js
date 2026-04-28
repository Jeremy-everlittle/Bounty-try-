'use strict';

// ═══════════════════════════════════════════════════════════════
// Decision Logger — writes every bet/skip/sell decision to a log file
// ═══════════════════════════════════════════════════════════════
// File: server/logs/decisions-YYYY-MM-DD.log
// Format: timestamped JSON lines for easy parsing/analysis
// Includes: predictions, trades, skips, sell decisions, settlements,
//           price movements, market data, and algorithm diagnostics
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — rotate if exceeded

// Ensure log directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

function getLogPath() {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(LOG_DIR, `decisions-${date}.log`);
}

function writeEntry(entry) {
    const logPath = getLogPath();
    const line = JSON.stringify(entry) + '\n';
    try {
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > MAX_FILE_SIZE) {
                fs.renameSync(logPath, logPath + '.old');
            }
        } catch (e) { /* file doesn't exist yet */ }
        fs.appendFileSync(logPath, line);
    } catch (e) {
        console.error('[decision-logger] Write error:', e.message);
    }
}

function timestamp() {
    return new Date().toISOString();
}

// ── Compute price movement stats from history ──
function computePriceStats(history, currentPrice) {
    if (!history || history.length < 2) return null;
    const prices = history.map(h => h.price);
    const n = prices.length;
    const oldest = prices[0];
    const newest = prices[n - 1];

    // Recent price movements
    const chg1 = n > 1 ? prices[n - 1] - prices[n - 2] : 0;
    const chg3 = n > 3 ? prices[n - 1] - prices[n - 4] : 0;
    const chg5 = n > 5 ? prices[n - 1] - prices[n - 6] : 0;
    const chg10 = n > 10 ? prices[n - 1] - prices[n - 11] : 0;
    const chg30 = n > 30 ? prices[n - 1] - prices[n - 31] : 0;

    // Percentages
    const pct1 = n > 1 ? (chg1 / prices[n - 2]) * 100 : 0;
    const pct3 = n > 3 ? (chg3 / prices[n - 4]) * 100 : 0;
    const pct5 = n > 5 ? (chg5 / prices[n - 6]) * 100 : 0;
    const pct10 = n > 10 ? (chg10 / prices[n - 11]) * 100 : 0;
    const pct30 = n > 30 ? (chg30 / prices[n - 31]) * 100 : 0;

    // Volatility: standard deviation of returns over last 20 ticks
    const window = Math.min(20, n - 1);
    const returns = [];
    for (let i = n - window; i < n; i++) {
        if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    const meanRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1) : 0;
    const volatility = Math.sqrt(variance);

    // High/low over last 30 ticks
    const recentPrices = prices.slice(-Math.min(30, n));
    const high = Math.max(...recentPrices);
    const low = Math.min(...recentPrices);
    const range = high - low;
    const rangePct = low > 0 ? (range / low) * 100 : 0;

    // Volume stats
    const volumes = history.map(h => h.volume || 0).filter(v => v > 0);
    const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
    const recentVolume = volumes.length > 2 ? (volumes[volumes.length - 1] + volumes[volumes.length - 2]) / 2 : 0;
    const volumeRatio = avgVolume > 0 ? recentVolume / avgVolume : 1;

    return {
        tickCount: n,
        current: currentPrice?.toFixed(2),
        high: high.toFixed(2),
        low: low.toFixed(2),
        range: '$' + range.toFixed(2),
        rangePct: rangePct.toFixed(3) + '%',
        priceChanges: {
            '1tick': { dollar: chg1.toFixed(2), pct: pct1.toFixed(4) + '%' },
            '3tick': { dollar: chg3.toFixed(2), pct: pct3.toFixed(4) + '%' },
            '5tick': { dollar: chg5.toFixed(2), pct: pct5.toFixed(4) + '%' },
            '10tick': { dollar: chg10.toFixed(2), pct: pct10.toFixed(4) + '%' },
            '30tick': { dollar: chg30.toFixed(2), pct: pct30.toFixed(4) + '%' },
        },
        volatility: (volatility * 100).toFixed(5) + '%',
        volumeRatio: volumeRatio.toFixed(2),
        avgVolume: avgVolume.toFixed(0),
    };
}

// ── Extract market condition data ──
function extractMarketConditions(marketData) {
    const conditions = {};

    if (marketData.fundingRate) {
        const fr = typeof marketData.fundingRate === 'number'
            ? marketData.fundingRate
            : (marketData.fundingRate.settledRate || 0);
        const premium = typeof marketData.fundingRate === 'object'
            ? (marketData.fundingRate.premium || 0) : 0;
        conditions.fundingRate = { rate: (fr * 100).toFixed(4) + '%', premium: (premium * 100).toFixed(4) + '%' };
    }

    if (marketData.longShortRatio && marketData.longShortRatio.ratio) {
        conditions.longShortRatio = marketData.longShortRatio.ratio.toFixed(2);
    }

    if (marketData.fearGreed && marketData.fearGreed.value) {
        conditions.fearGreed = { value: marketData.fearGreed.value, label: marketData.fearGreed.classification };
    }

    if (marketData.macroEvent) {
        conditions.macroEvent = {
            isMacroDay: marketData.macroEvent.isMacroDay,
            isNearAnnouncement: marketData.macroEvent.isNearAnnouncement,
            sizingMultiplier: marketData.macroEvent.sizingMultiplier,
        };
    }

    if (marketData.liquidations && marketData.liquidations.totalLiqVol > 0) {
        conditions.liquidations = {
            totalVolume: '$' + (marketData.liquidations.totalLiqVol / 1000).toFixed(1) + 'K',
            imbalance: marketData.liquidations.imbalance?.toFixed(3),
        };
    }

    if (marketData.orderBook) {
        const ob = marketData.orderBook;
        const bidDepth = ob.bids ? ob.bids.slice(0, 5).reduce((s, b) => s + (parseFloat(b[1]) || 0), 0) : 0;
        const askDepth = ob.asks ? ob.asks.slice(0, 5).reduce((s, a) => s + (parseFloat(a[1]) || 0), 0) : 0;
        const total = bidDepth + askDepth;
        conditions.orderBookImbalance = total > 0 ? ((bidDepth - askDepth) / total).toFixed(3) : '0';
        conditions.bidDepth5 = bidDepth.toFixed(2);
        conditions.askDepth5 = askDepth.toFixed(2);
    }

    return conditions;
}

// ── Log a new period prediction + bet quality assessment ──
function logPrediction(data) {
    const { periodKey, strike, currentPrice, prediction, betQuality, minutesAhead, marketData } = data;
    const isUp = prediction.predictedPrice >= strike;
    const probForBet = isUp ? prediction.probability : (1 - prediction.probability);
    const edge = probForBet - 0.5;

    const entry = {
        ts: timestamp(),
        event: 'PREDICTION',
        periodKey,
        strike: strike?.toFixed(2),
        currentPrice: currentPrice?.toFixed(2),
        distanceFromStrike: currentPrice && strike ? (currentPrice - strike).toFixed(2) : null,
        distanceFromStrikePct: currentPrice && strike ? (((currentPrice - strike) / strike) * 100).toFixed(4) + '%' : null,
        direction: isUp ? 'UP' : 'DOWN',
        predictedPrice: prediction.predictedPrice?.toFixed(2),
        probability: (prediction.probability * 100).toFixed(1) + '%',
        probForBet: (probForBet * 100).toFixed(1) + '%',
        edge: (edge * 100).toFixed(2) + '%',
        confidence: (prediction.confidence * 100).toFixed(0) + '%',
        minutesAhead: minutesAhead?.toFixed(1),
        signals: prediction.signals,
        regimeInfo: prediction._regimeInfo,
        ensembleConfidence: prediction.ensembleConfidence,
    };

    // Price movement data
    if (marketData && marketData.history) {
        entry.priceStats = computePriceStats(marketData.history, currentPrice);
    }

    // Market conditions
    if (marketData) {
        entry.marketConditions = extractMarketConditions(marketData);
    }

    // Exhaustion & choppiness from prediction
    if (prediction._exhaustion) {
        entry.exhaustionDetail = {
            score: prediction._exhaustion.exhaustion?.toFixed(2),
            type: prediction._exhaustion.type,
            roc: prediction._exhaustion.roc?.toFixed(6),
        };
    }
    if (prediction._choppiness) {
        entry.choppinessDetail = {
            choppy: prediction._choppiness.choppy,
            adx: prediction._choppiness.adx?.toFixed(1),
        };
    }

    if (betQuality) {
        entry.betDecision = betQuality.shouldBet ? 'BET' : 'SKIP';
        entry.quality = (betQuality.quality * 100).toFixed(0) + '%';
        entry.betSize = betQuality.betSize?.toFixed(2);
        entry.betSizeReason = betQuality.betSizeReason;
        entry.kellyFraction = betQuality.kellyFraction?.toFixed(4);
        entry.kellyHasEdge = betQuality.kellyHasEdge;
        entry.factors = betQuality.factors;
        entry.sessionRisk = betQuality.sessionRisk;
        entry.skipReason = betQuality.shouldBet ? null : betQuality.reason;
    }

    writeEntry(entry);
}

// ── Log price tick with movement data (sampled — every 30s to avoid spam) ──
let lastPriceLogTime = 0;
function logPriceTick(data) {
    const now = Date.now();
    if (now - lastPriceLogTime < 30000) return; // max one every 30 seconds
    lastPriceLogTime = now;

    const { currentPrice, strike, periodKey, minutesAhead, history } = data;
    const entry = {
        ts: timestamp(),
        event: 'PRICE_TICK',
        periodKey,
        currentPrice: currentPrice?.toFixed(2),
        strike: strike?.toFixed(2),
        distanceFromStrike: currentPrice && strike ? (currentPrice - strike).toFixed(2) : null,
        distanceFromStrikePct: currentPrice && strike ? (((currentPrice - strike) / strike) * 100).toFixed(4) + '%' : null,
        minutesAhead: minutesAhead?.toFixed(1),
    };

    if (history && history.length > 1) {
        const prices = history.map(h => h.price);
        const n = prices.length;
        entry.lastChange = (prices[n - 1] - prices[n - 2]).toFixed(2);
        entry.lastChangePct = (((prices[n - 1] - prices[n - 2]) / prices[n - 2]) * 100).toFixed(4) + '%';
        if (n > 6) {
            const chg5 = prices[n - 1] - prices[n - 6];
            entry.change5tick = chg5.toFixed(2);
            entry.change5tickPct = ((chg5 / prices[n - 6]) * 100).toFixed(4) + '%';
        }
    }

    writeEntry(entry);
}

// ── Log a trade execution (buy, dip-buy, late-lock, re-entry) ──
function logTradeExecution(data) {
    const { action, contracts, side, ticker, limitPrice, periodKey, edge, quality, betSize, strategy, reason, currentPrice, strike, probability } = data;
    writeEntry({
        ts: timestamp(),
        event: 'TRADE',
        action: action || 'buy',
        strategy: strategy || 'initial',
        contracts,
        side,
        ticker,
        limitPrice: limitPrice + 'c',
        periodKey,
        edge,
        quality,
        betSize,
        reason,
        currentPrice: currentPrice?.toFixed(2),
        strike: strike?.toFixed(2),
        probability,
    });
}

// ── Log a sell/hold decision ──
function logSellDecision(data) {
    const { sellSignal, minutesRemaining, acted, reason, currentPrice, strike } = data;
    if (!sellSignal) return;

    writeEntry({
        ts: timestamp(),
        event: 'SELL_DECISION',
        level: sellSignal.level,
        shortLabel: sellSignal.shortLabel,
        urgency: sellSignal.urgency,
        acted: acted || false,
        reason: reason || sellSignal.advice,
        betDirection: sellSignal.betDirection,
        onWrongSide: sellSignal.onWrongSide,
        distancePct: sellSignal.distancePct?.toFixed(4) + '%',
        distanceFromStrike: sellSignal.distanceFromStrike?.toFixed(2),
        sigmaDistance: sellSignal.sigmaDistance?.toFixed(2) + 'σ',
        probForBet: (sellSignal.probForBet * 100).toFixed(1) + '%',
        minutesRemaining: minutesRemaining?.toFixed(1),
        probVelocity: sellSignal.probVelocity?.trend,
        peakProb: sellSignal.peakProb,
        profitAtRisk: sellSignal.profitAtRisk,
        exhaustion: sellSignal.exhaustion,
        choppiness: sellSignal.choppiness,
        currentPrice: currentPrice?.toFixed(2),
        strike: strike?.toFixed(2),
    });
}

// ── Log period settlement (win/loss) with outcome analysis ──
function logSettlement(data) {
    const { periodKey, wasCorrect, pnlCents, dailyPnlCents, contracts, entryPrice, side,
            strikePrice, settlementPrice, predDirection, predProbability, actualDirection } = data;
    writeEntry({
        ts: timestamp(),
        event: 'SETTLEMENT',
        periodKey,
        result: wasCorrect ? 'WIN' : 'LOSS',
        pnl: (pnlCents > 0 ? '+' : '') + '$' + (pnlCents / 100).toFixed(2),
        dailyPnl: (dailyPnlCents > 0 ? '+' : '') + '$' + (dailyPnlCents / 100).toFixed(2),
        contracts,
        entryPrice: entryPrice + 'c',
        side,
        strikePrice: strikePrice?.toFixed(2),
        settlementPrice: settlementPrice?.toFixed(2),
        predDirection,
        predProbability,
        actualDirection,
        predictionCorrect: predDirection === actualDirection,
    });
}

// ── Log when trade is skipped with detailed reason ──
function logSkip(data) {
    const { periodKey, reason, minutesAhead, probability, edge, currentPrice, strike, details } = data;
    writeEntry({
        ts: timestamp(),
        event: 'SKIP',
        periodKey,
        reason,
        minutesAhead: minutesAhead?.toFixed(1),
        probability: probability ? (probability * 100).toFixed(1) + '%' : null,
        edge: edge ? (edge * 100).toFixed(2) + '%' : null,
        currentPrice: currentPrice?.toFixed(2),
        strike: strike?.toFixed(2),
        details,
    });
}

// ── Log mid-period strategy decisions (dip-buy, late-lock, re-entry) ──
function logMidPeriodStrategy(data) {
    const { strategy, action, reason, currentPrice, strike, minutesAhead, probability, details } = data;
    writeEntry({
        ts: timestamp(),
        event: 'MID_PERIOD',
        strategy,
        action: action || 'skip',
        reason,
        currentPrice: currentPrice?.toFixed(2),
        strike: strike?.toFixed(2),
        minutesAhead: minutesAhead?.toFixed(1),
        probability,
        ...details,
    });
}

// ── Log new period start ──
function logNewPeriod(data) {
    const { periodKey, strike, currentPrice, minutesAhead, kalshiTicker } = data;
    writeEntry({
        ts: timestamp(),
        event: 'NEW_PERIOD',
        periodKey,
        strike: strike?.toFixed(2),
        currentPrice: currentPrice?.toFixed(2),
        minutesAhead: minutesAhead?.toFixed(1),
        kalshiTicker,
    });
}

// ── Read today's log file ──
function readTodaysLog() {
    const logPath = getLogPath();
    try {
        return fs.readFileSync(logPath, 'utf8');
    } catch (e) {
        return 'No log file for today yet.';
    }
}

// ── Read log for a specific date ──
function readLog(date) {
    // Validate date format to prevent path traversal attacks
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return 'Invalid date format. Use YYYY-MM-DD.';
    }
    const logPath = path.join(LOG_DIR, `decisions-${date}.log`);
    try {
        return fs.readFileSync(logPath, 'utf8');
    } catch (e) {
        return `No log file for ${date}.`;
    }
}

// ── List available log files ──
function listLogs() {
    try {
        return fs.readdirSync(LOG_DIR).filter(f => f.startsWith('decisions-'));
    } catch (e) {
        return [];
    }
}

module.exports = {
    logPrediction,
    logPriceTick,
    logTradeExecution,
    logSellDecision,
    logSettlement,
    logSkip,
    logMidPeriodStrategy,
    logNewPeriod,
    readTodaysLog,
    readLog,
    listLogs,
    LOG_DIR,
};
