'use strict';

const store = require('./store');
const { OnlineMLManager } = require('./online-ml');

// Online ML manager — initialized lazily after store is loaded
let onlineML = null;
function getOnlineML() {
    if (!onlineML) {
        onlineML = new OnlineMLManager(store);
    }
    return onlineML;
}

// ═══════════════════════════════════════════════════════════════
// PREDICTION ENGINE — Server-side headless prediction
// Ported from frontend index.html to run 24/7 without browser
// ═══════════════════════════════════════════════════════════════

// Microstructure state (persists across ticks)
const microState = {
    prevOrderBookImbalance: null,
    imbalanceHistory: [],
    tradeFlowHistory: [],
    cumulativeDelta: 0,
    deltaHistory: [],
    spreadHistory: [],
    vpinBucketSize: 0,
    // Kyle's Lambda (price impact) tracking
    lambdaHistory: [],  // [{timestamp, priceChange, signedVolume}]
};

// Anti-flip-flop state for updated predictions (persists within a period)
const stabilityState = {
    smoothedProbability: null,
    lockedDirection: null,
    consecutiveSameDirection: 0,
    lastRawProb: null,
    periodKey: null,
    flipCount: 0,
};

// ── Online ML feature cache (for attaching to graded records) ──
let _lastMLFeatures = null;
let _lastSignalPredictions = null;

// ── Probability velocity & profit tracking (persists within a period) ──
const probTracker = {
    periodKey: null,
    history: [],          // [{timestamp, prob, price}]
    peakProb: 0,          // highest probForBet seen this period
    peakPrice: 0,         // best price seen for our bet direction
    troughProb: 1,        // lowest probForBet seen
    entryProb: null,      // initial probForBet at bet entry
    entryPrice: null,     // price at bet entry
    momentumHistory: [],  // [{timestamp, momentum}] for exhaustion detection
};

// ── Session Risk Manager ──
// Tracks consecutive losses, drawdown, and adjusts bet sizing dynamically.
// This runs server-side across the session (not per-period).
const sessionRisk = {
    results: [],            // [{timestamp, correct, profit}] — rolling window of 20
    consecutiveLosses: 0,
    consecutiveWins: 0,
    sessionPnL: 0,          // approximate P&L in contracts
    peakPnL: 0,             // high-water mark
    currentDrawdown: 0,     // distance from peak
    coolingOff: false,       // true = stop trading temporarily
    coolingOffUntil: 0,      // timestamp when cooling off ends
    edgeDecayAlert: false,   // true = recent accuracy below breakeven
};

function updateSessionRisk(correct) {
    const profit = correct ? 0.36 : -0.57; // net of Kalshi fees at 50c contracts
    sessionRisk.results.push({ timestamp: Date.now(), correct, profit });
    if (sessionRisk.results.length > 20) sessionRisk.results.shift();

    sessionRisk.sessionPnL += profit;
    if (sessionRisk.sessionPnL > sessionRisk.peakPnL) {
        sessionRisk.peakPnL = sessionRisk.sessionPnL;
    }
    sessionRisk.currentDrawdown = sessionRisk.peakPnL - sessionRisk.sessionPnL;

    if (correct) {
        sessionRisk.consecutiveWins++;
        sessionRisk.consecutiveLosses = 0;
    } else {
        sessionRisk.consecutiveLosses++;
        sessionRisk.consecutiveWins = 0;
    }

    // Cooling off: 5+ consecutive losses → short pause (15 min, was 30)
    if (sessionRisk.consecutiveLosses >= 5) { // was 3
        sessionRisk.coolingOff = true;
        sessionRisk.coolingOffUntil = Date.now() + 15 * 60 * 1000; // was 30 min
    }

    // Edge decay: only alert at very poor accuracy
    if (sessionRisk.results.length >= 12) { // was 8 — need more data
        const recentCorrect = sessionRisk.results.filter(r => r.correct).length;
        const recentAccuracy = recentCorrect / sessionRisk.results.length;
        sessionRisk.edgeDecayAlert = recentAccuracy < 0.45; // was 0.55 — more tolerant
    }
}

function getSessionRiskMultiplier() {
    // Check if cooling off period has expired
    if (sessionRisk.coolingOff && Date.now() > sessionRisk.coolingOffUntil) {
        sessionRisk.coolingOff = false;
    }

    if (sessionRisk.coolingOff) return 0; // full stop during cooldown — trading at 30% when model is broken is still losing money

    let mult = 1.0;

    // Anti-martingale: mild reduction after consecutive losses (was aggressive)
    if (sessionRisk.consecutiveLosses >= 4) mult *= 0.50;       // was >=2
    else if (sessionRisk.consecutiveLosses >= 2) mult *= 0.75;  // was >=1

    // Drawdown protection: only reduce in deep drawdowns
    if (sessionRisk.currentDrawdown > 4.0) mult *= 0.60;   // was >2.0 at 0.50
    else if (sessionRisk.currentDrawdown > 2.5) mult *= 0.80; // was >1.0 at 0.75

    // Edge decay: mild reduction (was 0.60)
    if (sessionRisk.edgeDecayAlert) mult *= 0.80;

    // Win-streak boost REMOVED: Kelly sizes based on EDGE, not recent results.
    // A 3-win streak at 55% base rate is a 16.6% event — not rare enough to
    // indicate the edge has changed. Boosting creates positive feedback into drawdowns.

    return Math.max(0, Math.min(1.0, mult)); // floor at 0 (full stop when cooling), cap at 100%
}

// ── Online Logistic Regression (pure JS, no libraries) ──
// Legacy inline LR removed — replaced by OnlineMLManager in online-ml.js
// The OnlineMLManager provides:
//   - OnlineLogisticRegression with proper Welford normalization, L2 reg, LR scheduling
//   - ExponentialWeightedEnsemble for adaptive signal combination
//   - OnlineCalibrator with Platt scaling + isotonic regression
//   - OnlineHMM for regime detection

// Extract features from market state for online ML
function extractMLFeatures(marketData, extraCtx) {
    const prices = marketData.history.map(h => h.price);
    const n = prices.length;
    if (n < 10) return { features: [0, 0, 0, 0, 0, 0, 0, 0], ctx: {} };

    const volRegime = detectVolRegime(prices);
    const trendRegime = detectTrendRegime(prices, n);
    const ac1 = computeAutocorrelation(prices, 1);
    const flow = marketData.recentTrades ? computeTradeFlowImbalance(marketData.recentTrades) : 0;
    const chop = detectChoppiness(prices);
    const exhaust = detectMomentumExhaustion(prices, marketData.history);
    const mom5 = n > 5 ? (prices[n-1] - prices[n-6]) / prices[n-6] : 0;
    const rsi = computeRSI(prices);
    const hurstH = computeHurstExponent(prices.slice(-Math.min(n, 90)));
    const logReturn = n > 1 ? Math.log(prices[n-1] / prices[n-2]) : 0;

    // Map vol regime to numeric
    const volRegimeMap = { volatile: 2, expanding: 1, normal: 0, contracting: -1, quiet: -2 };
    const volRegimeNum = volRegimeMap[volRegime.regime] || 0;
    const trendStrength = ac1 * 0.5 + (hurstH - 0.5) * 2 * 0.5;
    const hour = new Date().getHours();
    const timeOfDay = hour / 24;
    const distFromStrike = extraCtx && extraCtx.zScore ? extraCtx.zScore : 0;
    const spreadVol = extraCtx && extraCtx.spreadVolAdjust ? extraCtx.spreadVolAdjust : 1.0;

    const features = [
        volRegimeNum,
        trendStrength,
        flow,
        timeOfDay,
        distFromStrike,
        mom5 * 1000,
        (rsi - 50) / 50,
        spreadVol
    ];

    const ctx = {
        volRegime: volRegime.regime,
        ac1,
        hurstH,
        orderFlowSignal: flow,
        driftSignal: mom5 * 1000,
        rsi,
        spreadVolAdjust: spreadVol,
        zScore: distFromStrike,
        logReturn
    };

    return { features, ctx };
}

// ── Standard normal CDF (Abramowitz & Stegun) ──
function normCDF(x) {
    if (x > 8) return 1;
    if (x < -8) return 0;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax / 2);
    return 0.5 * (1.0 + sign * y);
}

// ── Student-t CDF for fat-tail correction ──
function studentTCDF(x, df) {
    if (df <= 0 || df > 30) return normCDF(x);
    const t2 = x * x;
    const u = df / (df + t2);
    const a = df / 2, b = 0.5;
    let betaInc;
    if (u >= (a + 1) / (a + b + 2)) {
        betaInc = 1 - incompleteBetaApprox(1 - u, b, a);
    } else {
        betaInc = incompleteBetaApprox(u, a, b);
    }
    const p = 0.5 * betaInc;
    return x >= 0 ? 1 - p : p;
}

function incompleteBetaApprox(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
    let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    f = d;
    for (let m = 1; m <= 100; m++) {
        let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
        d = 1 + numerator * d;
        if (Math.abs(d) < 1e-30) d = 1e-30;
        c = 1 + numerator / c;
        if (Math.abs(c) < 1e-30) c = 1e-30;
        d = 1 / d;
        f *= c * d;
        numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
        d = 1 + numerator * d;
        if (Math.abs(d) < 1e-30) d = 1e-30;
        c = 1 + numerator / c;
        if (Math.abs(c) < 1e-30) c = 1e-30;
        d = 1 / d;
        const delta = c * d;
        f *= delta;
        if (Math.abs(delta - 1) < 1e-8) break;
    }
    return front * f;
}

function lnGamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
    z -= 1;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    let x = c[0];
    for (let i = 1; i < 9; i++) x += c[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function fatTailCDF(x, prices) {
    if (!prices || prices.length < 20) return normCDF(x);
    const n = Math.min(prices.length, 60);
    const returns = [];
    for (let i = prices.length - n; i < prices.length; i++) {
        if (i > 0) returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    if (returns.length < 15) return normCDF(x);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const m2 = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const m4 = returns.reduce((s, r) => s + (r - mean) ** 4, 0) / returns.length;
    const kurtosis = m2 > 0 ? m4 / (m2 * m2) : 3;
    const excessKurtosis = kurtosis - 3;
    if (excessKurtosis <= 0.5) return normCDF(x);
    const df = Math.max(3.5, Math.min(30, 6 / Math.max(excessKurtosis, 0.3) + 4));
    return studentTCDF(x, df);
}

function computeRealizedVol(prices, window) {
    if (prices.length < 3) return 0.001;
    window = Math.min(window, prices.length - 1);
    if (window < 2) return 0.001;
    const returns = [];
    for (let i = prices.length - window; i < prices.length; i++) {
        returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.max(Math.sqrt(variance), 0.0001);
}

function computeEWMAVol(prices, lambda) {
    if (typeof lambda === 'undefined') lambda = 0.97;
    if (prices.length < 5) return 0.001;
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    let ewmaVar = 0;
    for (let i = 0; i < Math.min(5, returns.length); i++) ewmaVar += returns[i] * returns[i];
    ewmaVar /= Math.min(5, returns.length);
    for (let i = 1; i < returns.length; i++) {
        ewmaVar = lambda * ewmaVar + (1 - lambda) * returns[i] * returns[i];
    }
    return Math.max(Math.sqrt(ewmaVar), 0.0001);
}

function computeGarmanKlassVol(history, window) {
    if (history.length < 3) return 0.001;
    window = Math.min(window, history.length);
    const slice = history.slice(-window);
    let gkSum = 0, validCount = 0;
    for (let i = 0; i < slice.length; i++) {
        const h = slice[i];
        const open = h.open || h.price;
        const high = h.high || h.price;
        const low = h.low || h.price;
        const close = h.price;
        if (high <= low || open <= 0) continue;
        const logHL = Math.log(high / low);
        const logCO = Math.log(close / open);
        gkSum += 0.5 * logHL * logHL - (2 * Math.LN2 - 1) * logCO * logCO;
        validCount++;
    }
    if (validCount < 2) return 0.001;
    return Math.max(Math.sqrt(gkSum / validCount), 0.0001);
}

function detectTrendRegime(prices, n) {
    if (n < 20) return { trending: false, meanReverting: false, vr: 1 };
    const q = 5;
    const logReturns = [];
    for (let i = 1; i < n; i++) {
        logReturns.push(Math.log(prices[i] / prices[i - 1]));
    }
    const mean1 = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const var1 = logReturns.reduce((s, r) => s + (r - mean1) ** 2, 0) / logReturns.length;
    const qReturns = [];
    for (let i = q; i < n; i++) {
        qReturns.push(Math.log(prices[i] / prices[i - q]));
    }
    if (qReturns.length < 3 || var1 === 0) return { trending: false, meanReverting: false, vr: 1 };
    const meanQ = qReturns.reduce((a, b) => a + b, 0) / qReturns.length;
    const varQ = qReturns.reduce((s, r) => s + (r - meanQ) ** 2, 0) / qReturns.length;
    const vr = (varQ / q) / var1;
    return { trending: vr > 1.15, meanReverting: vr < 0.85, vr };
}

function computeAdjustedRemainingVol(perMinuteVol, minutesAhead, prices) {
    const n = prices.length;
    const trendInfo = detectTrendRegime(prices, Math.min(n, 60));
    const vr = trendInfo.vr;
    const q = 5;
    let H = 0.5 + Math.log(Math.max(vr, 0.01)) / (2 * Math.log(q));
    H = Math.max(0.30, Math.min(0.70, H));
    const T = Math.max(minutesAhead, 0.5);
    return { remainingVol: perMinuteVol * Math.pow(T, H), H, vr };
}

// Research-based BTC intraday volatility seasonality
// 24-hour profile (UTC) from empirical BTC 15-min data analysis
// Peak: US market hours (14-16 UTC). Trough: Asia lull (04-06 UTC).
const HOURLY_VOL_MULT = [
    0.80, 0.75, 0.70, 0.65, 0.60, 0.55, // 00-05: Asia → dead zone
    0.65, 0.80, 1.00, 1.10, 1.05, 1.00, // 06-11: Europe session
    1.05, 1.25, 1.45, 1.50, 1.40, 1.30, // 12-17: US open → peak → midday
    1.20, 1.15, 1.10, 0.95, 0.85, 0.80  // 18-23: US close → transition
];
// Day-of-week multipliers: Mon=1.05, Tue=1.0, Wed=1.05, Thu=1.0, Fri=1.10, Sat=0.70, Sun=0.65
const DAY_VOL_MULT = [0.65, 1.05, 1.00, 1.05, 1.00, 1.10, 0.70]; // Sun=0, Mon=1, ..., Sat=6

function getIntradayVolMultiplier() {
    const now = new Date();
    const hour = now.getUTCHours();
    const nextHour = (hour + 1) % 24;
    const frac = now.getUTCMinutes() / 60;
    // Interpolate between current and next hour for smooth transitions
    const hourMult = HOURLY_VOL_MULT[hour] * (1 - frac) + HOURLY_VOL_MULT[nextHour] * frac;
    const dayMult = DAY_VOL_MULT[now.getUTCDay()];
    return hourMult * dayMult;
}

function detectVolRegime(prices) {
    const shortVol = computeRealizedVol(prices, Math.min(10, prices.length - 1));
    const longVol = computeRealizedVol(prices, Math.min(60, prices.length - 1));
    if (longVol < 0.0001) return { regime: 'normal', ratio: 1, shortVol, longVol };
    const ratio = shortVol / longVol;
    let regime = 'normal';
    if (ratio > 1.8) regime = 'volatile';
    else if (ratio > 1.3) regime = 'expanding';
    else if (ratio < 0.5) regime = 'quiet';
    else if (ratio < 0.7) regime = 'contracting';
    return { regime, ratio, shortVol, longVol };
}

// ── Jump-filtered volatility (BNS bipower variation) ──
// Research: Separating jumps from continuous vol improves forecasts by 5-10%.
// Bipower variation is robust to jumps; RV - BV = jump component.
// After a jump, we use continuous vol (BV) for forecasting instead of inflated RV.
function computeJumpFilteredVol(prices, window) {
    const n = prices.length;
    window = Math.min(window, n - 1);
    if (window < 3) return { continuousVol: 0.001, jumpDetected: false, jumpRatio: 0 };

    // Realized variance (sum of squared returns)
    let rv = 0;
    const returns = [];
    for (let i = n - window; i < n; i++) {
        const r = Math.log(prices[i] / prices[i - 1]);
        returns.push(r);
        rv += r * r;
    }

    // Bipower variation: (π/2) * Σ |r_i| * |r_{i-1}| — robust to jumps
    let bv = 0;
    for (let i = 1; i < returns.length; i++) {
        bv += Math.abs(returns[i]) * Math.abs(returns[i - 1]);
    }
    bv *= Math.PI / 2;

    // Jump ratio: how much of RV is explained by jumps
    const jumpRatio = rv > 0 ? Math.max(0, (rv - bv) / rv) : 0;
    const jumpDetected = jumpRatio > 0.10; // >10% of variance from jumps

    // Continuous vol: use BV for forecasting (filters out jumps)
    const continuousVol = Math.sqrt(Math.max(0, Math.min(rv, bv)) / window);

    return { continuousVol, jumpDetected, jumpRatio };
}

// ── TARI: Trade Arrival Rate Imbalance with Size Buckets ──
// Research finding: Count-based imbalance with size buckets outperforms
// simple volume imbalance (54-57% hit rate vs 51-53% for raw flow).
// Large trades (institutional) get highest weight; retail noise is downweighted.
function computeTradeFlowImbalance(trades) {
    if (!trades || trades.length === 0) return 0;
    const cutoff = Date.now() - 120000; // 2-minute window (research optimal)
    // Size buckets: small (<0.01 BTC), medium (0.01-1 BTC), large (>1 BTC)
    let buySmall = 0, sellSmall = 0;
    let buyMed = 0, sellMed = 0;
    let buyLarge = 0, sellLarge = 0;
    for (const t of trades) {
        if (t.T < cutoff) continue;
        const qty = parseFloat(t.q);
        if (qty < 0.01) {
            if (t.m) sellSmall++; else buySmall++;
        } else if (qty <= 1.0) {
            if (t.m) sellMed++; else buyMed++;
        } else {
            if (t.m) sellLarge++; else buyLarge++;
        }
    }
    const tariSmall = (buySmall + sellSmall) > 0 ? (buySmall - sellSmall) / (buySmall + sellSmall) : 0;
    const tariMed = (buyMed + sellMed) > 0 ? (buyMed - sellMed) / (buyMed + sellMed) : 0;
    const tariLarge = (buyLarge + sellLarge) > 0 ? (buyLarge - sellLarge) / (buyLarge + sellLarge) : 0;
    // Weighted: large trades matter most (institutional signal)
    return 0.15 * tariSmall + 0.35 * tariMed + 0.50 * tariLarge;
}

function computeOrderBookPressureGradient(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks)
        return { imbalance: 0, gradient: 0, topHeavy: 1 };
    const levels = Math.min(orderBook.bids.length, orderBook.asks.length, 20);
    if (levels < 4) return { imbalance: 0, gradient: 0, topHeavy: 1 };
    const levelImbalances = [];
    let nearBidVol = 0, nearAskVol = 0, farBidVol = 0, farAskVol = 0;
    let totalBidVol = 0, totalAskVol = 0;
    for (let i = 0; i < levels; i++) {
        const bidVol = parseFloat(orderBook.bids[i][1]);
        const askVol = parseFloat(orderBook.asks[i][1]);
        // Research: steeper decay (0.3) puts 60% weight on top 5 levels
        const weight = Math.exp(-0.3 * i);
        totalBidVol += bidVol * weight;
        totalAskVol += askVol * weight;
        const levelTotal = bidVol + askVol;
        if (levelTotal > 0) levelImbalances.push((bidVol - askVol) / levelTotal);
        if (i < 5) { nearBidVol += bidVol; nearAskVol += askVol; }
        else { farBidVol += bidVol; farAskVol += askVol; }
    }
    const total = totalBidVol + totalAskVol;
    const imbalance = total > 0 ? (totalBidVol - totalAskVol) / total : 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = levelImbalances.length;
    for (let i = 0; i < n; i++) {
        sumX += i; sumY += levelImbalances[i];
        sumXY += i * levelImbalances[i]; sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    const gradient = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const farTotal = farBidVol + farAskVol;
    const topHeavy = farTotal > 0 ? (nearBidVol + nearAskVol) / farTotal : 10;
    return { imbalance, gradient, topHeavy };
}

function computeOrderBookDelta(currentImbalance) {
    const hist = microState.imbalanceHistory;
    hist.push({ timestamp: Date.now(), imbalance: currentImbalance });
    while (hist.length > 30) hist.shift();
    if (hist.length < 3) return { delta: 0, velocity: 0, signal: 0 };
    const alpha = 0.3;
    let velocity = 0;
    for (let i = 1; i < hist.length; i++) {
        velocity = alpha * (hist[i].imbalance - hist[i - 1].imbalance) + (1 - alpha) * velocity;
    }
    let acceleration = 0;
    if (hist.length >= 6) {
        const mid = Math.floor(hist.length / 2);
        const recentVel = (hist[hist.length - 1].imbalance - hist[mid].imbalance) / (hist.length - mid);
        const olderVel = (hist[mid].imbalance - hist[0].imbalance) / mid;
        acceleration = recentVel - olderVel;
    }
    const signal = Math.max(-1, Math.min(1, velocity * 3.0 + acceleration * 1.5));
    return { delta: currentImbalance - hist[hist.length - 2].imbalance, velocity, signal };
}

function computeTradeSizeClustering(trades) {
    if (!trades || trades.length < 10) return { signal: 0, largeTradeRatio: 0 };
    const cutoff = Date.now() - 60000;
    const recent = trades.filter(t => t.T >= cutoff);
    if (recent.length < 5) return { signal: 0, largeTradeRatio: 0 };
    const sizes = recent.map(t => parseFloat(t.q));
    const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const threshold = avgSize * 2.0;
    let retailBuy = 0, retailSell = 0, instBuy = 0, instSell = 0;
    let totalVol = 0, largeVol = 0, largeBuyN = 0, largeSellN = 0;
    for (const t of recent) {
        const qty = parseFloat(t.q);
        totalVol += qty;
        if (qty >= threshold) {
            largeVol += qty;
            if (t.m) { instSell += qty; largeSellN++; }
            else { instBuy += qty; largeBuyN++; }
        } else {
            if (t.m) retailSell += qty; else retailBuy += qty;
        }
    }
    const retailTotal = retailBuy + retailSell;
    const instTotal = instBuy + instSell;
    const retailImb = retailTotal > 0 ? (retailBuy - retailSell) / retailTotal : 0;
    const instImb = instTotal > 0 ? (instBuy - instSell) / instTotal : 0;
    const largeCount = largeBuyN + largeSellN;
    const clustering = largeCount > 0 ? Math.abs(largeBuyN - largeSellN) / largeCount : 0;
    const raw = instImb * 0.75 + retailImb * 0.25;
    const signal = Math.max(-1, Math.min(1, raw * (1 + clustering * 0.5)));
    return { signal, largeTradeRatio: totalVol > 0 ? largeVol / totalVol : 0 };
}

function computeSpreadAnalysis(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks ||
        !orderBook.bids.length || !orderBook.asks.length)
        return { spreadBps: 0, volAdjustment: 1.0, signal: 0 };
    const bestBid = parseFloat(orderBook.bids[0][0]);
    const bestAsk = parseFloat(orderBook.asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;
    if (mid === 0) return { spreadBps: 0, volAdjustment: 1.0, signal: 0 };
    const spreadBps = ((bestAsk - bestBid) / mid) * 10000;
    const hist = microState.spreadHistory;
    hist.push(spreadBps);
    while (hist.length > 60) hist.shift();
    const avgSpread = hist.reduce((s, v) => s + v, 0) / hist.length;
    const spreadRatio = avgSpread > 0 ? spreadBps / avgSpread : 1;
    let volAdjustment = 1.0;
    if (spreadRatio > 1.5) volAdjustment = 1.0 + (spreadRatio - 1.5) * 0.3;
    else if (spreadRatio < 0.7) volAdjustment = 1.0 - (0.7 - spreadRatio) * 0.2;
    volAdjustment = Math.max(0.7, Math.min(1.5, volAdjustment));
    const signal = spreadRatio < 0.8 ? 0.15 : spreadRatio > 1.5 ? -0.1 : 0;
    return { spreadBps, spreadRatio, volAdjustment, signal };
}

// ── Kyle's Lambda: price impact per unit of order flow ──
// Rising lambda = liquidity thinning = trend fragile = reversal imminent
// Research: lambda Z-score > 1.5 during trending = high-confidence exhaustion signal
function computeKyleLambda(trades, prices) {
    if (!trades || trades.length < 20 || !prices || prices.length < 5) {
        return { lambda: 0, lambdaZScore: 0, liquidityThinning: false };
    }
    const cutoff = Date.now() - 120000; // last 2 minutes
    let signedVolume = 0;
    for (const t of trades) {
        if (t.T < cutoff) continue;
        const qty = parseFloat(t.q);
        if (t.m) signedVolume -= qty; else signedVolume += qty;
    }
    const n = prices.length;
    const priceChange = n > 2 ? (prices[n-1] - prices[n-3]) / prices[n-3] : 0;

    // Lambda = price change / signed volume (price impact per unit flow)
    const lambda = Math.abs(signedVolume) > 0.001 ? Math.abs(priceChange) / Math.abs(signedVolume) : 0;

    const lh = microState.lambdaHistory;
    lh.push({ timestamp: Date.now(), lambda });
    while (lh.length > 30) lh.shift();

    // Z-score of current lambda relative to recent history
    let lambdaZScore = 0;
    if (lh.length >= 5) {
        const vals = lh.map(l => l.lambda);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
        const std = Math.sqrt(variance);
        if (std > 0) lambdaZScore = (lambda - mean) / std;
    }

    // Liquidity thinning: lambda z-score > 1.5 means each unit of flow moves price much more
    const liquidityThinning = lambdaZScore > 1.5;

    return { lambda, lambdaZScore, liquidityThinning };
}

function computeCVD(trades) {
    if (!trades || trades.length === 0) return { cvd: 0, divergence: 0, signal: 0 };
    const cutoff = Date.now() - 60000;
    let periodDelta = 0;
    for (const t of trades) {
        if (t.T < cutoff) continue;
        const qty = parseFloat(t.q);
        const price = parseFloat(t.p);
        if (t.m) periodDelta -= qty * price; else periodDelta += qty * price;
    }
    microState.cumulativeDelta = periodDelta;
    microState.deltaHistory.push({ timestamp: Date.now(), delta: periodDelta });
    while (microState.deltaHistory.length > 30) microState.deltaHistory.shift();
    let divergence = 0;
    const dh = microState.deltaHistory;
    if (dh.length >= 10) {
        const recent = dh.slice(-5);
        const older = dh.slice(-10, -5);
        const recentAvg = recent.reduce((s, d) => s + d.delta, 0) / recent.length;
        const olderAvg = older.reduce((s, d) => s + d.delta, 0) / older.length;
        const totalAbs = Math.abs(recentAvg) + Math.abs(olderAvg);
        if (totalAbs > 0) divergence = (recentAvg - olderAvg) / totalAbs;
    }
    const deltaSign = periodDelta > 0 ? 1 : periodDelta < 0 ? -1 : 0;
    const signal = Math.max(-1, Math.min(1, deltaSign * 0.4 + divergence * 0.6));
    return { cvd: periodDelta, divergence, signal };
}

function computeVPIN(trades, numBuckets) {
    if (typeof numBuckets === 'undefined') numBuckets = 20;
    if (!trades || trades.length < 20) return { vpin: 0, toxicity: 'low', signal: 0 };
    if (microState.vpinBucketSize === 0) {
        let totalVol = 0;
        for (const t of trades) totalVol += parseFloat(t.q);
        microState.vpinBucketSize = totalVol / numBuckets || 1;
    }
    const bucketSize = microState.vpinBucketSize;
    const buckets = [];
    let cur = { buyVol: 0, sellVol: 0 }, fill = 0;
    for (const t of trades) {
        const qty = parseFloat(t.q);
        let remaining = qty;
        while (remaining > 0) {
            const space = bucketSize - fill;
            const f = Math.min(remaining, space);
            if (t.m) cur.sellVol += f; else cur.buyVol += f;
            fill += f; remaining -= f;
            if (fill >= bucketSize) { buckets.push({...cur}); cur = { buyVol: 0, sellVol: 0 }; fill = 0; }
        }
    }
    if (buckets.length < 3) return { vpin: 0, toxicity: 'low', signal: 0 };
    const recent = buckets.slice(-numBuckets);
    let sumAbsImb = 0;
    for (const b of recent) sumAbsImb += Math.abs(b.buyVol - b.sellVol);
    const vpin = sumAbsImb / (recent.length * bucketSize);
    const toxicity = vpin > 0.6 ? 'critical' : vpin > 0.4 ? 'elevated' : vpin > 0.25 ? 'moderate' : 'low';
    const signal = vpin > 0.4 ? -(vpin - 0.4) : 0;
    return { vpin, toxicity, signal };
}

function computeEMA(prices, period) {
    if (!prices || prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function computeRSI(prices, period) {
    if (typeof period === 'undefined') period = 14;
    if (prices.length < period + 1) return 50;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[prices.length - period - 1 + i] - prices[prices.length - period - 1 + i - 1];
        if (diff > 0) avgGain += diff;
        else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function computeVolumeWeightedMomentum(history, lookback) {
    lookback = Math.min(lookback, history.length - 1);
    if (lookback < 1) return 0;
    let weightedReturn = 0, totalVol = 0;
    for (let i = history.length - lookback; i < history.length; i++) {
        const ret = (history[i].price - history[i - 1].price) / history[i - 1].price;
        const vol = history[i].volume || 1;
        weightedReturn += ret * vol;
        totalVol += vol;
    }
    return totalVol > 0 ? weightedReturn / totalVol : 0;
}

function detectCandlePatterns(history) {
    const n = history.length;
    if (n < 3) return { signal: 0, pattern: 'Neutral' };
    const last = history[n - 1];
    const prev = history[n - 2];
    const lastBody = last.price - last.open;
    const prevBody = prev.price - prev.open;
    if (prevBody < 0 && lastBody > 0 && Math.abs(lastBody) > Math.abs(prevBody) * 1.2)
        return { signal: 0.6, pattern: 'Bullish' };
    if (prevBody > 0 && lastBody < 0 && Math.abs(lastBody) > Math.abs(prevBody) * 1.2)
        return { signal: -0.6, pattern: 'Bearish' };
    const lastRange = (last.high || last.price) - (last.low || last.price);
    if (lastRange > 0) {
        const lowerWick = Math.min(last.open, last.price) - (last.low || last.price);
        const upperWick = (last.high || last.price) - Math.max(last.open, last.price);
        const bodySize = Math.abs(lastBody);
        if (lowerWick > bodySize * 2 && lowerWick > upperWick * 2)
            return { signal: 0.4, pattern: 'Bullish' };
        if (upperWick > bodySize * 2 && upperWick > lowerWick * 2)
            return { signal: -0.4, pattern: 'Bearish' };
    }
    if (n >= 3) {
        const b1 = history[n-3].price - history[n-3].open;
        if (b1 > 0 && prevBody > 0 && lastBody > 0) return { signal: 0.3, pattern: 'Bullish' };
        if (b1 < 0 && prevBody < 0 && lastBody < 0) return { signal: -0.3, pattern: 'Bearish' };
    }
    return { signal: 0, pattern: 'Neutral' };
}

function computeBollingerSqueeze(prices, period) {
    if (typeof period === 'undefined') period = 20;
    if (prices.length < period + 2) return { squeeze: false, breakoutSignal: 0 };
    // O(n) sliding window: maintain running sum and sum-of-squares
    let sum = 0, sumSq = 0;
    const histBandwidths = [];
    for (let i = 0; i < prices.length; i++) {
        sum += prices[i];
        sumSq += prices[i] * prices[i];
        if (i >= period) {
            sum -= prices[i - period];
            sumSq -= prices[i - period] * prices[i - period];
        }
        if (i >= period - 1) {
            const m = sum / period;
            const variance = sumSq / period - m * m;
            const sd = Math.sqrt(Math.max(0, variance));
            histBandwidths.push(sd / m);
        }
    }
    const bandwidth = histBandwidths[histBandwidths.length - 1];
    const mean = sum / period;
    const sorted = histBandwidths.slice().sort((a, b) => a - b);
    const pct20 = sorted[Math.floor(sorted.length * 0.2)] || bandwidth;
    const squeeze = bandwidth <= pct20 && histBandwidths.length > 5;
    const current = prices[prices.length - 1];
    const breakoutSignal = squeeze ? (current > mean ? 0.3 : -0.3) : 0;
    return { squeeze, breakoutSignal, bandwidth };
}

function computeSRNearStrike(history, strike) {
    if (history.length < 10 || !strike) return 0;
    const prices = history.map(h => h.price);
    const highs = history.map(h => h.high || h.price);
    const lows = history.map(h => h.low || h.price);
    let srLevels = [];
    for (let i = 2; i < history.length - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i-2] &&
            highs[i] > highs[i+1] && highs[i] > highs[i+2]) srLevels.push(highs[i]);
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] &&
            lows[i] < lows[i+1] && lows[i] < lows[i+2]) srLevels.push(lows[i]);
    }
    const tolerance = strike * 0.0005;
    const nearSR = srLevels.some(level => Math.abs(level - strike) < tolerance);
    const current = prices[prices.length - 1];
    if (nearSR) return current > strike ? 0.15 : -0.15;
    return 0;
}

function getRegimeMultipliers(trendRegime, volRegime, ac1, recentReturn) {
    const m = { momentum: 1.0, flow: 1.0, reversion: 1.0, pattern: 1.0, volume: 1.0 };
    // Trending: trust momentum but don't amplify — no boost above 1.0
    if (ac1 > 0.35 || trendRegime.trending) {
        m.momentum = 1.0; m.flow = 1.0; m.reversion = 0.65; m.pattern = 0.85;
    } else if (ac1 < -0.35 || trendRegime.meanReverting) {
        m.momentum = 0.35; m.flow = 0.60; m.reversion = 1.80; m.pattern = 0.80;
    }
    if (volRegime.regime === 'volatile' || volRegime.regime === 'expanding') {
        m.flow *= 1.15; m.volume *= 1.25; m.momentum *= 0.90;
    } else if (volRegime.regime === 'quiet') {
        m.flow *= 0.6; m.momentum *= 1.0;
    }
    // Asymmetric regime behavior (research finding):
    // Negative returns mean-revert faster; positive returns persist more.
    // Fade sharp drops, ride rallies.
    if (typeof recentReturn === 'number') {
        if (recentReturn < -0.002) {
            // Sharp drop: boost mean reversion, dampen momentum
            m.reversion *= 1.25;
            m.momentum *= 0.80;
        } else if (recentReturn > 0.002) {
            // Rally: boost momentum, dampen reversion
            m.momentum *= 1.15;
            m.reversion *= 0.75;
        }
    }
    return m;
}

function timePolarize(prob, minutesAhead, totalMinutes, maxExponent) {
    if (typeof totalMinutes === 'undefined') totalMinutes = 15;
    if (typeof maxExponent === 'undefined') maxExponent = 1.5;
    const timeProgress = 1 - Math.max(0, Math.min(1, minutesAhead / totalMinutes));
    // Linear ramp: gentler polarization — old quadratic pushed extremes too hard
    const exponent = 1 + (maxExponent - 1) * timeProgress;
    const d = 2 * prob - 1;
    const sign = d >= 0 ? 1 : -1;
    const polarizedD = sign * Math.pow(Math.abs(d), 1 / exponent);
    return 0.5 + 0.5 * polarizedD;
}

function ensembleConfidence(zScore, totalZShift, positionalWeight, positionalProb, minutesAhead, nIter) {
    if (typeof nIter === 'undefined') nIter = 50;
    // Deterministic quasi-random via Halton sequence (no Math.random)
    function halton(index, base) {
        let result = 0, f = 1, i = index + 1;
        while (i > 0) { f /= base; result += f * (i % base); i = Math.floor(i / base); }
        return result;
    }
    function qrandn(i) {
        const u = Math.max(1e-10, halton(i, 2));
        const v = halton(i, 3);
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
    function toLogOddsE(p) { return Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9)); }
    function fromLogOddsE(lo) { return 1 / (1 + Math.exp(-lo)); }
    const samples = [];
    for (let i = 0; i < nIter; i++) {
        const pZ = zScore + qrandn(i * 3) * 0.05;
        const pShift = Math.max(-1, Math.min(1, totalZShift + qrandn(i * 3 + 1) * 0.03));
        const pPosPr = Math.max(0.01, Math.min(0.99, positionalProb + qrandn(i * 3 + 2) * 0.02));
        const dap = normCDF(pZ + pShift * (1 - positionalWeight) * 3);
        const lo = toLogOddsE(pPosPr) * positionalWeight + toLogOddsE(dap) * (1 - positionalWeight);
        let p = fromLogOddsE(lo);
        p = timePolarize(p, minutesAhead);
        p = 0.03 + 0.94 / (1 + Math.exp(-10 * (p - 0.5)));
        samples.push(p);
    }
    const mean = samples.reduce((s, v) => s + v, 0) / nIter;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (nIter - 1);
    const stddev = Math.sqrt(variance);
    return { stddev, level: stddev < 0.02 ? 'high' : stddev < 0.05 ? 'moderate' : 'low' };
}

function computeHurstExponent(prices) {
    const n = prices.length;
    if (n < 20) return 0.5;
    const returns = [];
    for (let i = 1; i < n; i++) returns.push(Math.log(prices[i] / prices[i - 1]));
    const chunkSizes = [];
    for (let s = 8; s <= Math.floor(returns.length / 2); s = Math.floor(s * 1.5)) chunkSizes.push(s);
    if (chunkSizes.length < 2) return 0.5;
    const logN = [], logRS = [];
    for (const size of chunkSizes) {
        const numChunks = Math.floor(returns.length / size);
        if (numChunks < 1) continue;
        let rsSum = 0, validChunks = 0;
        for (let c = 0; c < numChunks; c++) {
            const chunk = returns.slice(c * size, (c + 1) * size);
            const mean = chunk.reduce((a, b) => a + b, 0) / size;
            let cumDev = 0, maxCum = -Infinity, minCum = Infinity, sumSq = 0;
            for (let i = 0; i < size; i++) {
                cumDev += chunk[i] - mean;
                if (cumDev > maxCum) maxCum = cumDev;
                if (cumDev < minCum) minCum = cumDev;
                sumSq += (chunk[i] - mean) ** 2;
            }
            const stdDev = Math.sqrt(sumSq / size);
            if (stdDev > 0) { rsSum += (maxCum - minCum) / stdDev; validChunks++; }
        }
        if (validChunks > 0) { logN.push(Math.log(size)); logRS.push(Math.log(rsSum / validChunks)); }
    }
    if (logN.length < 2) return 0.5;
    const nP = logN.length;
    const meanX = logN.reduce((a, b) => a + b, 0) / nP;
    const meanY = logRS.reduce((a, b) => a + b, 0) / nP;
    let num = 0, den = 0;
    for (let i = 0; i < nP; i++) { num += (logN[i] - meanX) * (logRS[i] - meanY); den += (logN[i] - meanX) ** 2; }
    // Clamp to [0.42, 0.58]: BTC Hurst at 1-min frequency is statistically
    // indistinguishable from 0.5 (Frontiers in Blockchain, 2024). Values outside
    // this range at 1-min frequency are estimation noise, not real persistence.
    return Math.max(0.42, Math.min(0.58, den > 0 ? num / den : 0.5));
}

function detectMicroMeanReversion(prices, orderBook) {
    const n = prices.length;
    if (n < 10) return { signal: 0, detected: false };
    const lookback = Math.min(20, n - 2);
    let sumAbsRet = 0;
    for (let i = n - lookback - 1; i < n - 2; i++) sumAbsRet += Math.abs(prices[i + 1] - prices[i]);
    const avgAbsMove = sumAbsRet / lookback;
    if (avgAbsMove === 0) return { signal: 0, detected: false };
    const lastMove = prices[n - 1] - prices[n - 2];
    const lastMoveRatio = Math.abs(lastMove) / avgAbsMove;
    const meanWindow = Math.min(10, n);
    let rollingMean = 0;
    for (let i = n - meanWindow; i < n; i++) rollingMean += prices[i];
    rollingMean /= meanWindow;
    const devFromMean = (prices[n - 1] - rollingMean) / rollingMean;
    let alternations = 0;
    for (let i = Math.max(1, n - 5); i < n - 1; i++) {
        const r1 = prices[i] - prices[i - 1];
        const r2 = prices[i + 1] - prices[i];
        if (r1 * r2 < 0) alternations++;
    }
    const altRate = alternations / Math.min(4, n - 2);
    let absorptionSignal = 0;
    if (orderBook && orderBook.bids && orderBook.asks) {
        const topBidVol = orderBook.bids.slice(0, 3).reduce((s, b) => s + parseFloat(b[1]), 0);
        const topAskVol = orderBook.asks.slice(0, 3).reduce((s, a) => s + parseFloat(a[1]), 0);
        const ratio = (topBidVol - topAskVol) / (topBidVol + topAskVol + 1e-10);
        if (lastMove > 0 && ratio < -0.2) absorptionSignal = -0.3;
        else if (lastMove < 0 && ratio > 0.2) absorptionSignal = 0.3;
    }
    let signal = 0, detected = false;
    if (lastMoveRatio > 2.0) {
        detected = true;
        signal = -Math.sign(lastMove) * Math.min(lastMoveRatio * 0.15, 0.6);
        signal += -Math.sign(devFromMean) * Math.min(Math.abs(devFromMean) * 30, 0.3);
        signal += absorptionSignal;
    } else if (altRate > 0.7) {
        detected = true;
        signal = -Math.sign(lastMove) * 0.3 * altRate;
    } else if (Math.abs(devFromMean) > 0.001) {
        signal = -Math.sign(devFromMean) * Math.min(Math.abs(devFromMean) * 15, 0.2);
    }
    return { signal: Math.max(-1, Math.min(1, signal)), detected };
}

function detectBreakout(prices, history) {
    const n = prices.length;
    if (n < 15) return { signal: 0, breakout: false };
    const current = prices[n - 1];
    const rangeStart = Math.max(0, n - 12);
    const rangeEnd = n - 3;
    if (rangeEnd - rangeStart < 5) return { signal: 0, breakout: false };
    const rangePrices = prices.slice(rangeStart, rangeEnd + 1);
    const rangeHigh = Math.max(...rangePrices);
    const rangeLow = Math.min(...rangePrices);
    const rangeWidth = (rangeHigh - rangeLow) / ((rangeHigh + rangeLow) / 2);
    if (rangeWidth > 0.003) return { signal: 0, breakout: false };
    const breakThresh = rangeWidth * 0.5;
    let direction = 0, breakoutStrength = 0;
    if (current > rangeHigh * (1 + breakThresh)) {
        direction = 1; breakoutStrength = (current - rangeHigh) / (rangeHigh - rangeLow + 1e-10);
    } else if (current < rangeLow * (1 - breakThresh)) {
        direction = -1; breakoutStrength = (rangeLow - current) / (rangeHigh - rangeLow + 1e-10);
    }
    if (direction === 0) return { signal: 0, breakout: false };
    let volConf = 1.0;
    const volumes = history.map(h => h.volume || 0);
    if (volumes.length > 10) {
        const avgVol = volumes.slice(-15, -2).reduce((a, b) => a + b, 0) / Math.min(13, volumes.length - 2);
        const brkVol = (volumes[volumes.length - 1] + volumes[volumes.length - 2]) / 2;
        if (avgVol > 0) volConf = Math.min(brkVol / avgVol, 3.0);
    }
    let consolBars = 0;
    for (let i = rangeEnd; i >= Math.max(0, rangeEnd - 30); i--) {
        if (prices[i] >= rangeLow && prices[i] <= rangeHigh) consolBars++; else break;
    }
    const durMult = Math.min(consolBars / 5, 2.0);
    const signal = direction * Math.min(breakoutStrength, 2.0) * 0.3 * Math.min(volConf, 2.0) * durMult;
    return { signal: Math.max(-1, Math.min(1, signal)), breakout: true };
}

// ── Cross-asset signals ──
function computeEthLeadLag(btcPrices, ethPriceHistory) {
    // Research: BTC leads altcoins (Easley et al., Cornell), NOT the reverse.
    // ETH following confirms BTC's move; ETH diverging suggests BTC's move may fade.
    // Use as a confirmation/dampening signal, not a directional predictor.
    if (!ethPriceHistory || ethPriceHistory.length < 3 || btcPrices.length < 3) {
        return { signal: 0, ethMom: 0, btcMom: 0 };
    }
    const n = ethPriceHistory.length;
    const ethMom = (ethPriceHistory[n-1] - ethPriceHistory[n-3]) / ethPriceHistory[n-3];
    const bn = btcPrices.length;
    const btcMom = (btcPrices[bn-1] - btcPrices[bn-3]) / btcPrices[bn-3];
    // If both moving same direction → confirmation → small boost to BTC direction
    // If ETH diverging from BTC → BTC move may fade → dampen signal
    const sameDirection = Math.sign(ethMom) === Math.sign(btcMom) && Math.sign(btcMom) !== 0;
    let signal = 0;
    if (sameDirection) {
        // ETH confirms BTC direction — small boost in BTC's direction
        signal = Math.sign(btcMom) * 0.08;
    } else if (Math.abs(ethMom) > 0.001 && Math.abs(btcMom) > 0.001) {
        // Active divergence — BTC move may be fading, slight contrarian
        signal = -Math.sign(btcMom) * 0.05;
    }
    return { signal, ethMom, btcMom };
}

function computeOIVolSignal(openInterestHistory) {
    // Rapid OI changes predict higher volatility (not direction)
    // Use rate-of-change of OI to adjust vol estimate
    if (!openInterestHistory || openInterestHistory.length < 3) {
        return { volMultiplier: 1.0, oiChange: 0 };
    }
    const n = openInterestHistory.length;
    const recent = openInterestHistory[n-1];
    const prior = openInterestHistory[Math.max(0, n-3)];
    if (prior <= 0) return { volMultiplier: 1.0, oiChange: 0 };
    const oiChange = Math.abs(recent - prior) / prior;
    // OI change > 2% in 3 ticks (30 sec) → vol boost
    let volMultiplier = 1.0;
    if (oiChange > 0.05) volMultiplier = 1.30; // 5% OI change → 30% vol boost
    else if (oiChange > 0.02) volMultiplier = 1.15;
    else if (oiChange > 0.01) volMultiplier = 1.05;
    return { volMultiplier, oiChange };
}

function detectChangePoints(prices) {
    const n = prices.length;
    if (n < 10) return { detected: false, recentShift: false, signal: 0, currentRegimeLength: n };
    const returns = [];
    for (let i = 1; i < n; i++) returns.push(Math.log(prices[i] / prices[i - 1]));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std < 1e-10) return { detected: false, recentShift: false, signal: 0, currentRegimeLength: n };
    const threshold = 3.0, drift = 0.5 * std;
    let cusumUp = 0, cusumDown = 0, lastChangeIdx = 0;
    const changePoints = [];
    for (let i = 0; i < returns.length; i++) {
        const norm = (returns[i] - mean) / std;
        cusumUp = Math.max(0, cusumUp + norm - drift / std);
        cusumDown = Math.max(0, cusumDown - norm - drift / std);
        if (cusumUp > threshold) {
            changePoints.push({ index: i + 1, type: 'up', strength: cusumUp });
            cusumUp = 0; cusumDown = 0; lastChangeIdx = i + 1;
        } else if (cusumDown > threshold) {
            changePoints.push({ index: i + 1, type: 'down', strength: cusumDown });
            cusumUp = 0; cusumDown = 0; lastChangeIdx = i + 1;
        }
    }
    let signal = 0;
    const recentCPs = changePoints.filter(cp => cp.index > returns.length - 5);
    if (recentCPs.length > 0) {
        const last = recentCPs[recentCPs.length - 1];
        if (last.type === 'up') signal = 0.3 * Math.min(last.strength / threshold, 2.0);
        else if (last.type === 'down') signal = -0.3 * Math.min(last.strength / threshold, 2.0);
    }
    return {
        detected: changePoints.length > 0, recentShift: recentCPs.length > 0,
        signal: Math.max(-1, Math.min(1, signal)), currentRegimeLength: returns.length - lastChangeIdx
    };
}

function computeAgreementMultiplier(signals) {
    if (signals.length < 3) return 1.0;
    let positiveWeight = 0, negativeWeight = 0, totalWeight = 0;
    for (const s of signals) {
        totalWeight += Math.abs(s.weight);
        if (s.value > 0.01) positiveWeight += Math.abs(s.weight);
        else if (s.value < -0.01) negativeWeight += Math.abs(s.weight);
    }
    if (totalWeight === 0) return 1.0;
    const dominantPct = Math.max(positiveWeight, negativeWeight) / totalWeight;
    // In mean-reverting market, agreement = momentum chasing, not confirmation
    if (dominantPct > 0.80) return 1.05;
    if (dominantPct > 0.65) return 1.0;
    if (dominantPct < 0.50) return 0.55;
    if (dominantPct < 0.60) return 0.70;
    return 0.90;
}

function computeHeikinAshi(history) {
    const n = history.length;
    if (n < 5) return { signal: 0, trendStrength: 0 };
    const ha = [];
    for (let i = 0; i < n; i++) {
        const o = history[i].open || history[i].price;
        const c = history[i].price;
        const h = history[i].high || c;
        const l = history[i].low || c;
        if (i === 0) {
            ha.push({ open: (o + c) / 2, close: (o + h + l + c) / 4, high: h, low: l });
        } else {
            const haOpen = (ha[i-1].open + ha[i-1].close) / 2;
            const haClose = (o + h + l + c) / 4;
            ha.push({ open: haOpen, close: haClose, high: Math.max(h, haOpen, haClose), low: Math.min(l, haOpen, haClose) });
        }
    }
    const lookback = Math.min(5, ha.length);
    let bullish = 0, bearish = 0;
    for (let i = ha.length - lookback; i < ha.length; i++) {
        (ha[i].close > ha[i].open) ? bullish++ : bearish++;
    }
    let signal = 0;
    if (bullish === lookback) signal = 0.3;
    else if (bearish === lookback) signal = -0.3;
    else signal = (bullish - bearish) / lookback * 0.15;
    const lastBody = ha[ha.length-1].close - ha[ha.length-1].open;
    const prevBody = ha[ha.length-2].close - ha[ha.length-2].open;
    if (Math.sign(lastBody) !== Math.sign(prevBody) && Math.sign(prevBody) !== 0) {
        signal = Math.sign(lastBody) * 0.2;
    }
    return { signal, trendStrength: Math.abs(bullish - bearish) / lookback };
}

function computeCrossTimeframeMomentum(prices) {
    const n = prices.length;
    if (n < 6) return { signal: 0, confluence: 0 };
    const mom1 = n > 1 ? (prices[n-1] - prices[n-2]) / prices[n-2] : 0;
    const mom3 = n > 3 ? (prices[n-1] - prices[n-4]) / prices[n-4] : 0;
    const mom5 = n > 5 ? (prices[n-1] - prices[n-6]) / prices[n-6] : 0;
    const signs = [Math.sign(mom1), Math.sign(mom3), Math.sign(mom5)];
    const allAgree = signs[0] !== 0 && signs[0] === signs[1] && signs[1] === signs[2];
    const twoAgree = (signs[0] === signs[1] && signs[0] !== 0) ||
                     (signs[1] === signs[2] && signs[1] !== 0);
    if (allAgree) {
        const raw = signs[0] * (Math.abs(mom1) * 0.2 + Math.abs(mom3) * 0.3 + Math.abs(mom5) * 0.5);
        return { signal: Math.sign(raw) * Math.min(Math.abs(raw) * 300, 0.4), confluence: 1 };
    } else if (twoAgree) {
        const majoritySign = signs[0] + signs[1] + signs[2] > 0 ? 1 : -1;
        return { signal: majoritySign * 0.1, confluence: 0.5 };
    }
    return { signal: 0, confluence: 0 };
}

function computeAutocorrelation(prices, lag) {
    const returns = [];
    for (let i = 1; i < prices.length; i++) returns.push(prices[i] / prices[i-1] - 1);
    if (returns.length < lag + 5) return 0;
    const n = returns.length;
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) den += (returns[i] - mean) ** 2;
    for (let i = lag; i < n; i++) num += (returns[i] - mean) * (returns[i - lag] - mean);
    return den > 0 ? num / den : 0;
}


// ── Normalized Rate of Change ──
function computeNormalizedROC(prices, lookback) {
    const n = prices.length;
    if (n < lookback + 2) return 0;
    const roc = (prices[n - 1] - prices[n - 1 - lookback]) / prices[n - 1 - lookback];
    const vol = computeRealizedVol(prices, lookback);
    return vol > 0.0001 ? Math.max(-3, Math.min(3, roc / vol)) : 0;
}

// ── Mean Reversion Composite Score ──
function computeMeanReversionScore(prices, history, trendRegime) {
    const n = prices.length;
    if (n < 20) return { signal: 0, agreement: false };
    let cumPV = 0, cumVol = 0, cumPV2 = 0;
    for (const h of history) {
        const vol = h.volume || 1;
        cumPV += h.price * vol; cumVol += vol; cumPV2 += h.price * h.price * vol;
    }
    const vwap = cumPV / cumVol;
    const vwapStd = Math.sqrt(Math.max(0, (cumPV2 / cumVol) - vwap * vwap));
    const vwapZ = vwapStd > 0 ? (prices[n - 1] - vwap) / vwapStd : 0;
    const period = Math.min(20, n);
    const slice = prices.slice(-period);
    const bbMean = slice.reduce((a, b) => a + b, 0) / period;
    const bbStd = Math.sqrt(slice.reduce((s, p) => s + (p - bbMean) ** 2, 0) / period);
    const bbZ = bbStd > 0 ? (prices[n - 1] - bbMean) / bbStd : 0;
    const agreement = Math.sign(vwapZ) === Math.sign(bbZ) && Math.abs(vwapZ) > 1.0 && Math.abs(bbZ) > 1.0;
    const composite = vwapZ * 0.4 + bbZ * 0.6;
    let regimeGate = 1.0;
    if (trendRegime.trending) regimeGate = 0.3;
    else if (trendRegime.meanReverting) regimeGate = 1.5;
    let signal = -Math.sign(composite) * Math.min(Math.abs(composite) * 0.12, 0.40) * regimeGate;
    if (agreement) signal *= 1.4;
    return { signal: Math.max(-0.5, Math.min(0.5, signal)), agreement };
}

function computeAnchoredVWAP(history) {
    if (history.length < 3) return { vwap: 0, deviation: 0 };
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < history.length; i++) {
        const vol = history[i].volume || 1;
        cumPV += history[i].price * vol;
        cumVol += vol;
    }
    const vwap = cumPV / cumVol;
    const current = history[history.length - 1].price;
    return { vwap, deviation: (current - vwap) / vwap };
}

function computeMACD(prices) {
    if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
    // O(n) incremental MACD: compute EMA12 and EMA26 in a single pass
    const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
    let ema12 = prices[0], ema26 = prices[0];
    let signalLine = 0;
    let macdLine = 0;
    for (let i = 1; i < prices.length; i++) {
        ema12 = prices[i] * k12 + ema12 * (1 - k12);
        ema26 = prices[i] * k26 + ema26 * (1 - k26);
        if (i >= 25) {
            macdLine = ema12 - ema26;
            if (i === 25) signalLine = macdLine;
            else signalLine = macdLine * k9 + signalLine * (1 - k9);
        }
    }
    return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

function computeLinRegSlope(prices, lookback) {
    lookback = Math.min(lookback, prices.length);
    if (lookback < 3) return { slope: 0, r2: 0 };
    const segment = prices.slice(-lookback);
    const n = segment.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i; sumY += segment[i];
        sumXY += i * segment[i]; sumX2 += i * i;
        sumY2 += segment[i] * segment[i];
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { slope: 0, r2: 0 };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const r2denom = denom * (n * sumY2 - sumY * sumY);
    const r = r2denom > 0 ? (n * sumXY - sumX * sumY) / Math.sqrt(r2denom) : 0;
    return { slope: segment[0] !== 0 ? slope / segment[0] : 0, r2: Math.min(1, Math.max(0, r * r)) };
}

// ═══════════════════════════════════════════════════════════════
// Bayesian Learning (uses store for persistence)
// ═══════════════════════════════════════════════════════════════

function getTimeBucket() { return Math.floor(new Date().getHours() / 6); }
function betaMean(beta) { return beta.a / (beta.a + beta.b); }
function betaUpdate(beta, success) {
    return success ? { a: beta.a + 1, b: beta.b } : { a: beta.a, b: beta.b + 1 };
}

function getBayesTrendLabel(trendRegime) {
    if (trendRegime.trending) return 'trending';
    if (trendRegime.meanReverting) return 'meanReverting';
    return 'neutral';
}

function getCalibrationBin(prob) {
    if (prob < 0.2) return 0;
    if (prob < 0.35) return 1;
    if (prob < 0.45) return 2;
    if (prob < 0.55) return 3;
    if (prob < 0.65) return 4;
    return 5;
}

function computeDirectionalPrior(direction, windowSize) {
    if (typeof windowSize === 'undefined') windowSize = 5;
    const bayesianState = store.getBayesianState();
    const graded = bayesianState.records.filter(
        r => r.predictedDirection === direction && r.correct !== null
    ).slice(-windowSize);
    if (graded.length < 2) return { adjustment: 0, n: 0 };
    const correct = graded.filter(r => r.correct).length;
    const rate = correct / graded.length;
    return { adjustment: (rate - 0.5) * 0.3, n: graded.length };
}

function computeRegimeAdjustment(volRegimeLabel, trendRegimeLabel) {
    const bayesianState = store.getBayesianState();
    const timeBucket = getTimeBucket();
    const volBeta = bayesianState.regimeBeta[volRegimeLabel] || { a: 1, b: 1 };
    const trendBeta = bayesianState.trendBeta[trendRegimeLabel] || { a: 1, b: 1 };
    const timeBeta = bayesianState.timeBeta[timeBucket] || { a: 1, b: 1 };
    const volAccuracy = betaMean(volBeta);
    const trendAccuracy = betaMean(trendBeta);
    const timeAccuracy = betaMean(timeBeta);
    const combined = (volAccuracy * 0.3 + trendAccuracy * 0.4 + timeAccuracy * 0.3);
    const multiplier = 0.7 + combined * 0.6;
    return { multiplier, volAccuracy, trendAccuracy, timeAccuracy };
}

function computeCalibrationAdjustment(rawProb) {
    const bayesianState = store.getBayesianState();
    const bin = getCalibrationBin(rawProb);
    const beta = bayesianState.calibrationBins[bin];
    if (!beta) return { calibratedProb: rawProb, adjustment: 0 };
    const n = beta.a + beta.b - 2;
    if (n < 3) return { calibratedProb: rawProb, adjustment: 0 };
    const historicalAccuracy = betaMean(beta);
    const weight = Math.min(n / 20, 0.5);
    const calibratedProb = rawProb * (1 - weight) + historicalAccuracy * weight;
    return { calibratedProb, adjustment: calibratedProb - rawProb };
}

function detectPredictionStreak() {
    const bayesianState = store.getBayesianState();
    const graded = bayesianState.records.filter(r => r.actualDirection !== null);
    if (graded.length < 3) return { streakLength: 0, streakDirection: null, adjustment: 0 };
    let streak = 0;
    const lastCorrect = graded[graded.length - 1].correct;
    for (let i = graded.length - 1; i >= 0; i--) {
        if (graded[i].correct === lastCorrect) streak++;
        else break;
    }
    if (streak < 3) return { streakLength: streak, streakDirection: null, adjustment: 0 };
    const adj = lastCorrect ? Math.min(streak * 0.02, 0.1) : -Math.min(streak * 0.03, 0.15);
    return { streakLength: streak, streakDirection: lastCorrect ? 'correct' : 'wrong', adjustment: adj };
}

function bayesianAdjust(rawProb, volRegimeLabel, trendRegimeLabel) {
    const predictedDirection = rawProb >= 0.5 ? 'up' : 'down';
    const dirPrior = computeDirectionalPrior(predictedDirection);
    const calibration = computeCalibrationAdjustment(rawProb);
    const regimeAdj = computeRegimeAdjustment(volRegimeLabel, trendRegimeLabel);
    const streak = detectPredictionStreak();
    let adjustedProb = calibration.calibratedProb;
    adjustedProb += dirPrior.adjustment * 0.3;
    adjustedProb *= regimeAdj.multiplier > 1 ? 1 + (regimeAdj.multiplier - 1) * 0.2 : 1 - (1 - regimeAdj.multiplier) * 0.2;
    adjustedProb += streak.adjustment;
    adjustedProb = Math.max(0.03, Math.min(0.97, adjustedProb));
    return { adjustedProb, dirPrior, calibration, regimeAdj, streak };
}

function computeBayesianPrior() {
    const predLog = store.getPredictionLog();
    const graded = predLog.filter(p => p.actualDirection !== null);
    if (graded.length < 2) return 0;
    const recent = graded.slice(-5);
    let upWeight = 0, totalWeight = 0;
    for (let i = 0; i < recent.length; i++) {
        const w = Math.pow(1.5, i);
        if (recent[i].actualDirection === 'up') upWeight += w;
        totalWeight += w;
    }
    const upRate = upWeight / totalWeight;
    if (upRate > 0.6) return (upRate - 0.5) * 0.6;
    if (upRate < 0.4) return (upRate - 0.5) * 0.6;
    return 0;
}

// ═══════════════════════════════════════════════════════════════
// MOMENTUM EXHAUSTION & REVERSAL DETECTION
// Detects when a move is losing steam BEFORE the reversal
// ═══════════════════════════════════════════════════════════════

function detectMomentumExhaustion(prices, history) {
    const n = prices.length;
    if (n < 12) return { exhaustion: 0, signal: 0, type: 'none' };

    // 1. Rate-of-change deceleration: first derivative positive but second derivative negative
    //    = price still going up but acceleration is slowing → top forming
    const roc3 = (prices[n-1] - prices[n-4]) / prices[n-4];
    const roc3_prev = n > 7 ? (prices[n-4] - prices[n-7]) / prices[n-7] : roc3;
    const roc3_prev2 = n > 10 ? (prices[n-7] - prices[n-10]) / prices[n-10] : roc3_prev;
    const acceleration = roc3 - roc3_prev;
    const jerk = (roc3 - roc3_prev) - (roc3_prev - roc3_prev2); // third derivative

    // Deceleration: price moving in one direction but slowing down
    const isDecelerating = (roc3 > 0 && acceleration < 0) || (roc3 < 0 && acceleration > 0);
    const decelerationStrength = isDecelerating ? Math.abs(acceleration) / (Math.abs(roc3) + 1e-10) : 0;

    // 2. Momentum divergence: price making new highs but momentum declining
    const lookback = Math.min(15, n - 1);
    let priceIsHigher = false, momIsLower = false;
    let priceIsLower = false, momIsHigher = false;
    if (n > 8) {
        const recentHigh = Math.max(...prices.slice(-5));
        const priorHigh = Math.max(...prices.slice(-lookback, -5));
        const recentMom = Math.abs(roc3);
        const priorMom = Math.abs(roc3_prev);

        priceIsHigher = recentHigh > priorHigh;
        momIsLower = recentMom < priorMom * 0.7; // momentum 30%+ weaker
        priceIsLower = Math.min(...prices.slice(-5)) < Math.min(...prices.slice(-lookback, -5));
        momIsHigher = recentMom > priorMom * 1.3; // momentum strengthening despite price drop
    }
    const bearishDivergence = priceIsHigher && momIsLower; // price up, momentum fading
    const bullishDivergence = priceIsLower && momIsHigher;  // price down, momentum fading

    // 3. Volume climax: extremely high volume on the last few bars often marks exhaustion
    let volumeClimax = 0;
    const volumes = history.map(h => h.volume || 0).filter(v => v > 0);
    if (volumes.length > 10) {
        const avgVol = volumes.slice(-20, -2).reduce((a, b) => a + b, 0) / Math.min(18, volumes.length - 2);
        const lastVol = volumes[volumes.length - 1];
        if (avgVol > 0 && lastVol > avgVol * 3.0) {
            volumeClimax = Math.min(1.0, (lastVol / avgVol - 3) / 3);
        }
    }

    // 4. RSI divergence from price
    const rsi = computeRSI(prices);
    let rsiDivergence = 0;
    if (rsi > 70 && roc3 > 0 && acceleration < 0) {
        rsiDivergence = -0.3 * ((rsi - 70) / 30); // stronger as RSI gets more overbought
    } else if (rsi < 30 && roc3 < 0 && acceleration > 0) {
        rsiDivergence = 0.3 * ((30 - rsi) / 30);
    }

    // 5. Bollinger Band rejection: price touched band but couldn't hold
    const bbPeriod = Math.min(20, n);
    const slice = prices.slice(-bbPeriod);
    const mean = slice.reduce((a, b) => a + b, 0) / bbPeriod;
    const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / bbPeriod);
    const upperBand = mean + 2 * std;
    const lowerBand = mean - 2 * std;
    let bbRejection = 0;
    if (n > 3 && std > 0) {
        const prev2 = prices[n-3];
        const prev1 = prices[n-2];
        const curr = prices[n-1];
        // Hit upper band then pulled back
        if (prev1 >= upperBand * 0.999 && curr < prev1) bbRejection = -0.25;
        // Hit lower band then bounced
        else if (prev1 <= lowerBand * 1.001 && curr > prev1) bbRejection = 0.25;
    }

    // Combine exhaustion signals
    let exhaustionScore = 0;
    let type = 'none';

    if (bearishDivergence) { exhaustionScore += 0.35; type = 'bearish_divergence'; }
    if (bullishDivergence) { exhaustionScore += 0.35; type = 'bullish_divergence'; }
    if (decelerationStrength > 0.3) {
        exhaustionScore += Math.min(0.4, decelerationStrength * 0.5);
        if (type === 'none') type = 'deceleration';
    }
    if (volumeClimax > 0) {
        exhaustionScore += volumeClimax * 0.3;
        if (type === 'none') type = 'volume_climax';
    }
    exhaustionScore += Math.abs(rsiDivergence);
    exhaustionScore += Math.abs(bbRejection) * 0.5;

    exhaustionScore = Math.min(1.0, exhaustionScore);

    // Signal direction: negative = bearish exhaustion (was going up, about to reverse down)
    let signal = 0;
    if (exhaustionScore > 0.15) {
        const direction = roc3 > 0 ? -1 : 1; // contra the current move
        signal = direction * exhaustionScore * 0.4;
        signal += rsiDivergence + bbRejection;
    }

    return {
        exhaustion: exhaustionScore,
        signal: Math.max(-1, Math.min(1, signal)),
        type,
        deceleration: decelerationStrength,
        bearishDivergence,
        bullishDivergence,
        volumeClimax,
        rsiDivergence,
        bbRejection,
        roc: roc3,
        acceleration
    };
}

// ── Detect choppy/range-bound market (ADX-like) ──
function detectChoppiness(prices) {
    const n = prices.length;
    if (n < 15) return { choppy: false, adx: 50, choppiness: 0.5 };

    // Simplified ADX: directional movement index
    const lookback = Math.min(14, n - 1);
    let sumPlusDM = 0, sumMinusDM = 0, sumTR = 0;
    for (let i = n - lookback; i < n; i++) {
        const high = prices[i];
        const low = i > 0 ? Math.min(prices[i], prices[i-1]) : prices[i];
        const prevHigh = i > 0 ? prices[i-1] : prices[i];
        const prevLow = i > 1 ? Math.min(prices[i-1], prices[i-2]) : prevHigh;

        const highDiff = high - prevHigh;
        const lowDiff = prevLow - low;

        if (highDiff > 0 && highDiff > lowDiff) sumPlusDM += highDiff;
        if (lowDiff > 0 && lowDiff > highDiff) sumMinusDM += lowDiff;

        const tr = Math.abs(prices[i] - (i > 0 ? prices[i-1] : prices[i]));
        sumTR += tr;
    }

    if (sumTR === 0) return { choppy: true, adx: 0, choppiness: 1.0 };

    const plusDI = (sumPlusDM / sumTR) * 100;
    const minusDI = (sumMinusDM / sumTR) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;

    // Choppiness Index: measures how range-bound vs trending
    // High values = choppy, low values = trending
    const range = Math.max(...prices.slice(-lookback)) - Math.min(...prices.slice(-lookback));
    const choppiness = sumTR > 0 ? Math.log(sumTR / Math.max(range, 1e-10)) / Math.log(lookback) : 0.5;
    const normalizedChop = Math.max(0, Math.min(1, choppiness));

    return {
        choppy: dx < 20 || normalizedChop > 0.6,
        adx: dx,
        choppiness: normalizedChop,
        plusDI,
        minusDI,
        trending: dx > 25 && normalizedChop < 0.45
    };
}

// ── Probability velocity: how fast is our edge changing? ──
function updateProbTracker(periodKey, probForBet, currentPrice, betIsUp, strike) {
    if (probTracker.periodKey !== periodKey) {
        probTracker.periodKey = periodKey;
        probTracker.history = [];
        probTracker.peakProb = probForBet;
        probTracker.peakPrice = currentPrice;
        probTracker.troughProb = probForBet;
        probTracker.entryProb = probForBet;
        probTracker.entryPrice = currentPrice;
        probTracker.momentumHistory = [];
    }

    probTracker.history.push({ timestamp: Date.now(), prob: probForBet, price: currentPrice });
    if (probTracker.history.length > 60) probTracker.history.shift();

    // Track peaks
    if (probForBet > probTracker.peakProb) {
        probTracker.peakProb = probForBet;
        probTracker.peakPrice = currentPrice;
    }
    if (probForBet < probTracker.troughProb) {
        probTracker.troughProb = probForBet;
    }

    const h = probTracker.history;
    if (h.length < 3) return { velocity: 0, acceleration: 0, peakDrawdown: 0, profitAtRisk: 0, trend: 'stable' };

    // Probability velocity (EMA-smoothed first derivative)
    const dt = (h[h.length-1].timestamp - h[h.length-2].timestamp) / 1000; // seconds
    const rawVelocity = dt > 0 ? (h[h.length-1].prob - h[h.length-2].prob) / dt : 0;

    // Average velocity over last 5 readings
    let avgVelocity = 0;
    const velWindow = Math.min(5, h.length - 1);
    for (let i = h.length - velWindow; i < h.length; i++) {
        const dti = i > 0 ? (h[i].timestamp - h[i-1].timestamp) / 1000 : 1;
        if (dti > 0) avgVelocity += (h[i].prob - h[i-1].prob) / dti;
    }
    avgVelocity /= velWindow;

    // Acceleration (change in velocity)
    let acceleration = 0;
    if (h.length >= 6) {
        const recentVel = (h[h.length-1].prob - h[h.length-3].prob) / 2;
        const olderVel = (h[h.length-3].prob - h[h.length-5].prob) / 2;
        acceleration = recentVel - olderVel;
    }

    // Peak drawdown: how far have we fallen from the best probability?
    const peakDrawdown = probTracker.peakProb - probForBet;

    // Profit at risk: if we're on right side with high prob, how much are we giving back?
    const profitAtRisk = probTracker.peakProb > 0.6 ? peakDrawdown / probTracker.peakProb : 0;

    // Trend detection on probability trajectory
    let trend = 'stable';
    if (avgVelocity > 0.005) trend = 'improving';
    else if (avgVelocity < -0.005) trend = 'deteriorating';
    if (avgVelocity < -0.01 && acceleration < 0) trend = 'collapsing'; // accelerating decline

    return { velocity: avgVelocity, acceleration, peakDrawdown, profitAtRisk, trend, rawVelocity };
}

// ── Estimate actual market entry price from orderbook ──
// Returns the likely fill price in dollars (0-1 scale) for our side.
function estimateMarketEntry(isUp, kalshiOrderBook) {
    // Parse the ACTUAL Kalshi orderbook (yes/no binary contract bids).
    // Kalshi only shows BIDS. To find the ask for our side:
    //   buying YES → ask comes from NO bids (ask = 1.00 - NO bid price)
    //   buying NO  → ask comes from YES bids (ask = 1.00 - YES bid price)
    if (!kalshiOrderBook) return null;
    try {
        const ob = kalshiOrderBook.orderbook_fp || kalshiOrderBook.orderbook || kalshiOrderBook;
        if (!ob) return null;
        // Detect format: yes_dollars/no_dollars = dollar strings, yes/no = cent integers
        const isDollarFmt = !!(ob.yes_dollars || ob.no_dollars);
        const yesBids = ob.yes_dollars || ob.yes || [];
        const noBids = ob.no_dollars || ob.no || [];
        // Our side = YES → opposite bids = NO; side = NO → opposite bids = YES
        const side = isUp ? 'yes' : 'no';
        const oppositeBids = side === 'yes' ? noBids : yesBids;
        if (!oppositeBids || oppositeBids.length === 0) return null;

        // Each entry is [price, quantity] — normalize to dollar range (0-1)
        const askPrices = oppositeBids.map(entry => {
            const raw = parseFloat(entry[0]);
            const bidDollars = isDollarFmt ? raw : raw / 100;
            return 1.00 - bidDollars; // ask = 1 - opposing bid
        });
        const bestAsk = Math.min(...askPrices);
        if (!isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) return null;
        return bestAsk;
    } catch (e) {
        return null;
    }
}

// ── Bet quality assessment: should we even enter this trade? ──
function assessBetQuality(prediction, strike, marketData, minutesAhead) {
    const probForBet = prediction.predictedPrice >= strike ? prediction.probability : (1 - prediction.probability);
    const edge = probForBet - 0.5;
    const confidence = prediction.confidence;
    const prices = marketData.history.map(h => h.price);
    const chop = detectChoppiness(prices);
    const exhaustion = detectMomentumExhaustion(prices, marketData.history);

    // Minimum edge threshold: must cover fees + execution slippage + model uncertainty.
    // Kalshi fees ≈ 1.5¢/side (break-even ~52.3%), but execution slippage adds 2-4%.
    // With model shrinkage (30-50% OOS), a 2% measured edge is likely 0% real edge.
    // At 4%, real edge after costs is ~1.5-2% — marginally profitable.
    const minEdge = 0.04; // 4% minimum edge (was 2%)

    // Quality factors — tightened to only take high-quality setups.
    // Trading less often with higher edge >> trading often with thin edge.
    const factors = {
        hasMinEdge: edge >= minEdge,
        hasConfidence: confidence >= 0.40,        // was 0.35 — need meaningful confidence
        notChoppy: !chop.choppy || chop.adx > 18, // was 15
        notExhausted: exhaustion.exhaustion < 0.5, // was 0.6
        hasTime: minutesAhead >= 5,               // was 1.5 — contracts mispriced after 10 min
        signalAgreement: prediction.ensembleConfidence?.level !== 'low',
    };

    // Score each factor — reduced weight on restrictive factors
    let score = 0;
    let maxScore = 0;
    const weights = { hasMinEdge: 3, hasConfidence: 1, notChoppy: 1, notExhausted: 1, hasTime: 1, signalAgreement: 1 };
    for (const [key, weight] of Object.entries(weights)) {
        maxScore += weight;
        if (factors[key]) score += weight;
    }

    const quality = score / maxScore;
    const shouldBet = quality >= 0.55; // was 0.40 — only take quality setups
    const waitForBetter = !shouldBet && minutesAhead > 10;

    // Optimal entry timing: in choppy markets, wait for clearer signal
    let suggestedWait = 0;
    if (chop.choppy && minutesAhead > 8) suggestedWait = 3; // wait 3 min
    if (exhaustion.exhaustion > 0.5) suggestedWait = Math.max(suggestedWait, 2); // wait for exhaustion to resolve

    // ── BET SIZING — scale position based on conditions ──
    // 1.0 = full size, 0.5 = half size, 0.25 = quarter size
    let betSize = 1.0;
    let betSizeReason = 'Full size';

    // Choppy market = slightly smaller bets (was 50%, now 75%)
    if (chop.choppy) {
        betSize *= 0.75;
        betSizeReason = 'Slightly reduced — choppy market (ADX=' + chop.adx.toFixed(0) + ')';
    }

    // Momentum exhaustion = mild reduction only at extreme levels
    if (exhaustion.exhaustion > 0.6) {
        betSize *= 0.85;
        betSizeReason = betSize < 0.7 ? 'Reduced — choppy + exhausted' : 'Slightly reduced — momentum fading';
    }

    // Low edge = mild reduction (was 0.60, now 0.80)
    if (edge < 0.04) {
        betSize *= 0.80;
        betSizeReason = betSize < 0.6 ? 'Reduced — thin edge + adverse conditions' : 'Slightly reduced — thin edge (' + (edge * 100).toFixed(1) + '%)';
    }

    // Vol regime-based sizing: less aggressive reductions
    if (prices.length > 5) {
        const vr = detectVolRegime(prices);
        const volSizeMults = { quiet: 1.15, contracting: 1.05, normal: 1.00, expanding: 0.85, volatile: 0.65 };
        let volMult = volSizeMults[vr.regime] || 1.0;
        // Only extreme vol crisis gets major cut (was 0.25, now 0.45)
        if (vr.ratio > 3.0) volMult = 0.45;
        else if (vr.ratio > 2.0) volMult = 0.65 - (vr.ratio - 2.0) / (3.0 - 2.0) * 0.20;
        betSize *= Math.max(0.45, Math.min(1.15, volMult));
        if (volMult < 0.9) betSizeReason = betSize < 0.6 ? 'Reduced — ' + vr.regime + ' vol regime' : 'Slightly reduced — ' + vr.regime + ' vol (ratio=' + vr.ratio.toFixed(1) + ')';
    }

    // No size boosts above 1.0 until edge is proven with 300+ trades.
    // Boosting during hot streaks is anti-Kelly (increases size based on luck, not edge).
    if (quality >= 0.70 && edge >= 0.06 && !chop.choppy) {
        betSize = Math.max(betSize, 1.0);
        betSizeReason = 'Full size — strong setup';
    }

    // Session risk adjustment: reduce size based on drawdown/streak
    const sessionMult = getSessionRiskMultiplier();
    if (sessionMult === 0) {
        betSize = 0;
        betSizeReason = 'COOLING OFF — consecutive losses, waiting for reset';
    } else if (sessionMult < 1.0) {
        betSize *= sessionMult;
        if (sessionRisk.edgeDecayAlert) {
            betSizeReason = betSize < 0.4 ? 'Small — edge decay detected' : 'Reduced — edge fading';
        } else if (sessionRisk.consecutiveLosses >= 2) {
            betSizeReason = betSize < 0.4 ? 'Small — loss streak protection' : 'Reduced — after losses';
        } else if (sessionRisk.currentDrawdown > 1.0) {
            betSizeReason = betSize < 0.4 ? 'Small — drawdown protection' : 'Reduced — managing drawdown';
        }
    }

    // Macro event sizing: only reduce during actual announcement hour (was also reducing on macro days)
    if (marketData.macroEvent && marketData.macroEvent.isNearAnnouncement) {
        betSize *= 0.60; // was 0.40
        betSizeReason = 'Reduced — near macro announcement (FOMC/CPI/NFP)';
    }
    // No longer reducing on general macro days — too restrictive

    // Fear & Greed: only reduce at truly extreme levels
    if (marketData.fearGreed && marketData.fearGreed.value) {
        const fg = marketData.fearGreed.value;
        if (fg > 92) { betSize *= 0.85; betSizeReason = 'Slightly reduced — extreme greed'; }
        else if (fg < 8) { betSize *= 0.85; betSizeReason = 'Slightly reduced — extreme fear'; }
    }

    // ── CONVICTION SCALING — go bigger on high-confidence setups ──
    // When multiple signals align and probability is high, scale up aggressively.
    // betSize > 1.0 triggers the convictionMaxContracts cap in trade-executor.
    let convictionTier = null;

    if (shouldBet && sessionMult > 0) {
        const minutesLeft = minutesAhead;
        // Compute sigma distance: how many standard deviations is price from strike?
        const currentPrice = prices.length > 0 ? prices[prices.length - 1] : prediction.predictedPrice;
        const distFromStrike = Math.abs(currentPrice - strike);
        // Estimate remaining vol: ~0.02% per minute for BTC (annualized ~50% vol)
        const remainingVolPct = Math.sqrt(Math.max(0.5, minutesLeft) / (365.25 * 24 * 60)) * 0.50;
        const sigmaFromStrike = remainingVolPct > 0 ? (distFromStrike / currentPrice) / remainingVolPct : 0;
        const isUp = prediction.predictedPrice >= strike;
        const onRightSide = (isUp && currentPrice >= strike) || (!isUp && currentPrice < strike);

        // TIER 3: LOCK — price is far on our side near settlement, nearly guaranteed
        // 85%+ probability, <5 min left, on right side, strong sigma distance
        if (probForBet >= 0.85 && minutesLeft <= 5 && onRightSide && sigmaFromStrike >= 1.0 && !chop.choppy) {
            betSize = Math.max(betSize, 3.0);
            convictionTier = 'LOCK';
            betSizeReason = 'MAX CONVICTION — ' + (probForBet * 100).toFixed(0) + '% prob, ' +
                sigmaFromStrike.toFixed(1) + 'σ on right side, ' + minutesLeft.toFixed(0) + 'm left';
        }
        // TIER 2: HIGH CONVICTION — strong probability, on right side, good edge
        // 75%+ probability, on right side or strong edge, not choppy
        else if (probForBet >= 0.75 && edge >= 0.05 && !chop.choppy && (onRightSide || quality >= 0.70)) {
            betSize = Math.max(betSize, 2.0);
            convictionTier = 'HIGH';
            betSizeReason = 'HIGH CONVICTION — ' + (probForBet * 100).toFixed(0) + '% prob, ' +
                (edge * 100).toFixed(1) + '% edge' + (onRightSide ? ', on right side' : '');
        }
        // TIER 1: ELEVATED — above-average confidence
        // 65%+ probability, positive edge, quality setup
        else if (probForBet >= 0.65 && edge >= 0.04 && quality >= 0.60) {
            betSize = Math.max(betSize, 1.5);
            convictionTier = 'ELEVATED';
            betSizeReason = 'ELEVATED CONVICTION — ' + (probForBet * 100).toFixed(0) + '% prob, ' +
                (edge * 100).toFixed(1) + '% edge';
        }
    }

    betSize = Math.max(0, Math.min(3.00, betSize)); // cap at 3x — conviction scaling max

    // ── Fee-adjusted Kelly fraction ──
    // The entry price should reflect what we'd ACTUALLY pay, not our probability estimate.
    // Using probForBet as entry price is wrong: if we think there's 90% chance of DOWN,
    // we'd buy NO contracts. The market rarely prices at our model's probability.
    // In practice, orderbook prices are stale and we can enter 5-15¢ cheaper than fair value.
    // The trade executor uses getAggressivePrice() which caps slippage at fair+1-5¢.
    // Use a conservative estimate: entry = min(probForBet, 0.70) to avoid the degenerate
    // case where high-confidence bets are mathematically impossible due to entry price.
    // This acknowledges that binary options contracts rarely trade above 85¢ on Kalshi
    // for 15-min BTC contracts because market-makers discount their model too.
    const fee = 0.015; // ~1.5 cents per side (Kalshi's current reduced fee schedule)
    const isUp = prediction.predictedPrice >= strike;
    const kalshiEntryPrice = estimateMarketEntry(isUp, marketData.kalshiOrderBook);

    // Use actual Kalshi orderbook for Kelly — no fallbacks, no guessing.
    // If orderbook is empty/unavailable, skip the Kelly check entirely and
    // let trade executor handle liquidity at execution time via getAggressivePrice.
    let kellyRaw = 0;
    let kellyHasEdge = false;
    let kellyFraction = 0;
    let kellyError = null;
    let kellyEntryPrice = null;  // actual Kalshi ask price in cents
    let kellyWinProfit = null;
    let kellyLossAmount = null;

    if (kalshiEntryPrice === null) {
        // Orderbook empty or unavailable — skip Kelly, let quality factors decide.
        // Trade executor will check liquidity again at order time.
        kellyError = 'No Kalshi orderbook data — Kelly check skipped';
        kellyHasEdge = true; // Don't block on Kelly when we have no data
        console.log(`[bet-quality] ${kellyError} — deferring to trade executor`);
    } else {
        const estimatedEntryPrice = Math.max(0.05, Math.min(0.95, kalshiEntryPrice));
        kellyEntryPrice = Math.round(estimatedEntryPrice * 100); // store in cents
        kellyWinProfit = (1.0 - fee) - estimatedEntryPrice - fee;
        kellyLossAmount = estimatedEntryPrice + fee;
        kellyRaw = kellyWinProfit > 0
            ? (probForBet * kellyWinProfit - (1 - probForBet) * kellyLossAmount) / kellyWinProfit
            : 0;
        kellyFraction = Math.max(0, kellyRaw * 0.25); // Quarter Kelly
        kellyHasEdge = kellyRaw > 0;
        console.log(`[bet-quality] Kalshi entry=${kellyEntryPrice}c | prob=${(probForBet*100).toFixed(1)}% | kelly=${kellyRaw.toFixed(3)} | edge=${kellyHasEdge ? 'YES' : 'NO'}`);
    }

    // Kelly criterion is computed for informational purposes (display/logging)
    // but does NOT gate whether a bet is placed. The quality factors and trade
    // executor's aggressive pricing handle risk management instead.
    const shouldBetAdjusted = shouldBet && sessionMult > 0;

    return {
        quality, shouldBet: shouldBetAdjusted, waitForBetter: !shouldBetAdjusted && minutesAhead > 8,
        suggestedWait, edge, factors, choppiness: chop, exhaustion,
        betSize, betSizeReason, convictionTier,
        kellyEntryPrice, kellyWinProfit, kellyLossAmount,
        kellyRaw, kellyFraction, kellyHasEdge, kellyError,
        sessionRisk: {
            consecutiveLosses: sessionRisk.consecutiveLosses,
            consecutiveWins: sessionRisk.consecutiveWins,
            currentDrawdown: sessionRisk.currentDrawdown,
            coolingOff: sessionRisk.coolingOff,
            edgeDecayAlert: sessionRisk.edgeDecayAlert,
            riskMultiplier: sessionMult
        },
        reason: !shouldBetAdjusted ?
            (sessionMult === 0 ? 'COOLING OFF — ' + sessionRisk.consecutiveLosses + ' consecutive losses, pausing' :
             !factors.hasMinEdge ? 'Edge too thin (' + (edge*100).toFixed(1) + '%)' :
             !factors.notChoppy ? 'Market is choppy (ADX=' + chop.adx.toFixed(0) + ')' :
             !factors.notExhausted ? 'Momentum exhaustion detected' :
             !factors.hasTime ? 'Not enough time remaining' :
             'Low signal quality') : 'Good entry'
    };
}

// ═══════════════════════════════════════════════════════════════
// MAIN PREDICTION FUNCTION
// ═══════════════════════════════════════════════════════════════

function predictPrice(marketData, minutesAhead, strike) {
    const history = marketData.history;
    const prices = history.map(h => h.price);
    const current = marketData.currentPrice;
    const n = prices.length;
    const orderBook = marketData.orderBook;
    const recentTrades = marketData.recentTrades;

    // SIGNAL 1: POSITIONAL Z-SCORE
    const volWindow = Math.round(8 + 52 * (minutesAhead / 15));
    const adaptiveWindow = Math.max(2, Math.min(volWindow, n - 1));
    const ccVol = computeRealizedVol(prices, adaptiveWindow);
    // GARCH research: BTC alpha ≈ 0.15-0.20 at DAILY frequency.
    // At 1-minute frequency, persistence is higher (microstructure noise).
    // lambda=0.80 had 3-min half-life — far too reactive for 15-min contracts.
    // lambda=0.93 gives ~10-min half-life, matching contract horizon.
    const ewmaVol = computeEWMAVol(prices, 0.93);
    const gkVol = computeGarmanKlassVol(history, adaptiveWindow);
    const rawPerMinVol = 0.25 * ccVol + 0.40 * ewmaVol + 0.35 * gkVol;
    // Leverage effect: BTC has WEAK and SYMMETRIC volatility asymmetry.
    // EGARCH gamma ≈ -0.038 (tiny vs equities' -0.05 to -0.15).
    // BTC vol increases after BOTH sharp up and down moves (FoMO + panic).
    // Cap at 5% boost (not 15%), applied symmetrically.
    const recentReturn = n > 1 ? Math.log(prices[n-1] / prices[n-2]) : 0;
    const leverageAdj = Math.abs(recentReturn) > 0.002
        ? 1.0 + Math.min(0.05, Math.abs(recentReturn) * 8)
        : 1.0;
    // Weekend vol reduction: weekday vol is substantially higher than weekends
    // Weekend adjustment now handled by DAY_VOL_MULT in getIntradayVolMultiplier()
    const leverageAdjVol = rawPerMinVol * leverageAdj;
    const shortVol = computeRealizedVol(prices, Math.min(8, n - 1));
    const longVol = computeRealizedVol(prices, Math.min(60, n - 1));
    const volBlendRatio = minutesAhead / 15;
    const blendedVol = longVol * volBlendRatio + shortVol * (1 - volBlendRatio);

    // Jump-filtered vol: ALWAYS use continuous vol (bipower variation) as primary.
    // Academic consensus (Corsi et al. 2010): continuous vol is uniformly a better
    // predictor of future vol than total realized variance, regardless of jump detection.
    // When jumps occur, add a small intensity boost for elevated future vol.
    const jumpInfo = computeJumpFilteredVol(prices, Math.min(30, n - 1));
    let perMinuteVol = Math.max(jumpInfo.continuousVol, blendedVol * 0.85);
    if (jumpInfo.jumpDetected) {
        perMinuteVol *= 1.0 + jumpInfo.jumpRatio * 0.3; // jumps predict slightly elevated future vol
    }

    const { remainingVol: rawRemainingVol, H } = computeAdjustedRemainingVol(perMinuteVol, minutesAhead, prices);
    const todMult = getIntradayVolMultiplier();
    // todMult includes hour-of-day AND day-of-week (incl. weekend)
    // Widened blend from (0.60+0.40*mult) to (0.45+0.55*mult) to let seasonality have real effect
    const remainingVol = rawRemainingVol * (0.45 + 0.55 * todMult);
    // Settlement-aware volatility compression
    // KXBTC15M settles to simple average of 60 per-second BRTI values
    // (NOT trimmed — trimming is only for BTCMINMAX product)
    // BRTI itself is order-book-based (not trade-based): exponentially weighted mid-price curve
    // With autocorrelation, effective_n ≈ 12-15 → settlement vol ≈ spot vol * 0.29
    // Settlement vol compression: BRTI settles to 60-second simple average.
    // With ~5s BRTI smoothing half-life → effective_n ≈ 12 → factor ≈ 0.29 at T=0.
    // Beyond 2 minutes, the averaging effect is negligible (most of the price path is unknown).
    // Old code applied compression even at 5 min (0.80) — that was excessive.
    let settlementVolAdj = 1.0;
    if (minutesAhead <= 1) {
        const secAhead = minutesAhead * 60;
        const fraction = Math.max(0, Math.min(1, secAhead / 60));
        settlementVolAdj = 0.29 + fraction * 0.21; // 0.29 → 0.50 over 0-60 seconds
    } else if (minutesAhead <= 2) {
        settlementVolAdj = 0.50 + (minutesAhead - 1) * 0.50; // 0.50 → 1.0 over 1-2 min
    }
    // Beyond 2 min: no compression (settlementVolAdj stays 1.0)
    const settlementVol = remainingVol * settlementVolAdj;

    // BRTI Settlement Price Estimator: when < 2 min remain, estimate where
    // the 60-second simple average will land based on recent price trajectory.
    // BRTI is computed per-second from order books (not trades). Settlement =
    // mean of 60 BRTI values. Current spot (Binance) leads BRTI by 1-3 seconds.
    let brtiShift = 0;
    if (minutesAhead <= 2 && n > 5) {
        const settlementWindow = Math.min(6, n);
        const recentAvg = prices.slice(-settlementWindow).reduce((a, b) => a + b, 0) / settlementWindow;

        // BRTI lag correction: Binance leads BRTI constituent exchanges by ~1-3s.
        // During fast moves, BRTI will be closer to where price was 1-2 ticks ago.
        // Momentum = recent price change per tick; lag shifts settlement toward lagged price.
        const momentum1 = n > 2 ? prices[n - 1] - prices[n - 2] : 0;
        const lagFactor = 0.15; // ~1.5 seconds of lag at 10s ticks
        const laggedPrice = current - momentum1 * lagFactor;
        // Blend lagged price into settlement estimate
        const brtiEstimate = recentAvg * 0.85 + laggedPrice * 0.15;

        brtiShift = Math.log(brtiEstimate / current);
        // Weight: stronger as we get closer to settlement
        brtiShift *= (2 - minutesAhead) / 2;
    }
    // Include BRTI settlement lag: spot may be above/below where settlement will land
    const zScore = settlementVol > 0 ? (Math.log(current / strike) + brtiShift) / settlementVol : 0;
    const positionalProb = fatTailCDF(zScore, prices);

    // SIGNAL 2: MOMENTUM / DRIFT
    const mom3 = n > 3 ? (prices[n-1] - prices[n-4]) / prices[n-4] : 0;
    const mom5 = n > 5 ? (prices[n-1] - prices[n-6]) / prices[n-6] : 0;
    const mom10 = n > 10 ? (prices[n-1] - prices[n-11]) / prices[n-11] : 0;
    const vwMom5 = computeVolumeWeightedMomentum(history, 5);
    const ema5 = computeEMA(prices, 5);
    const ema20 = computeEMA(prices, 20);
    const emaTrend = (ema5 - ema20) / current;
    const recentMom = mom3;
    const priorMom = n > 6 ? (prices[n-4] - prices[n-7]) / prices[n-7] : 0;
    const momAccel = recentMom - priorMom;
    const rawDrift = mom3 * 0.15 + mom5 * 0.20 + vwMom5 * 0.25 + mom10 * 0.25 + emaTrend * 0.15;

    // SIGNAL 3: REGIME DETECTION
    const volRegime = detectVolRegime(prices);
    const trendRegime = detectTrendRegime(prices, n);
    const ac1 = computeAutocorrelation(prices, 1);
    const ac2 = computeAutocorrelation(prices, 2);
    // Multi-lag: ac1 + ac2 together differentiate noise from structure
    // Both negative → strong mean reversion (bounce/whipsaw)
    // ac1 positive, ac2 positive → persistent trend
    // ac1 negative, ac2 positive → oscillation (choppy)
    const acSum = ac1 + ac2 * 0.5; // ac2 weighted less (noisier)
    let driftMultiplier = 1.0;
    if (acSum < -0.50) driftMultiplier = 0.35;      // was 0.10 — still respect some momentum
    else if (ac1 < -0.35) driftMultiplier = 0.40;   // was 0.15
    else if (acSum > 0.50) driftMultiplier = 1.0;    // strong persistence
    else if (ac1 > 0.35) driftMultiplier = 0.95;
    else if (trendRegime.meanReverting) driftMultiplier = 0.50; // was 0.25
    else if (trendRegime.trending) driftMultiplier = 1.0;
    // Oscillating market (ac1 neg, ac2 pos): reduce drift mildly
    else if (ac1 < -0.15 && ac2 > 0.15) driftMultiplier = 0.60; // was 0.35

    // Early period momentum bias — stronger and starts immediately
    const minutesIntoPeriod = 15 - minutesAhead;
    let earlyMomentumSignal = 0;
    if (minutesIntoPeriod <= 3 && strike > 0) {
        const openingMove = (current - strike) / strike;
        const openingMoveZ = perMinuteVol > 0 ? openingMove / (perMinuteVol * Math.sqrt(minutesIntoPeriod + 0.5)) : 0;
        const earlyConf = Math.min(1.0, minutesIntoPeriod / 2.5);
        if (Math.abs(openingMoveZ) > 0.5) {
            earlyMomentumSignal = Math.sign(openingMoveZ) * Math.min(Math.abs(openingMoveZ) * 0.10, 0.25) * earlyConf;
        }
    }

    // Momentum consensus removed — in mean-reverting market, agreement = momentum chasing

    // SIGNAL 4: ORDER FLOW & MICROSTRUCTURE
    let orderFlowSignal = 0;
    let spreadVolAdjust = 1.0;
    let orderFlowRaw = 0;
    if (orderBook) {
        const pressure = computeOrderBookPressureGradient(orderBook);
        const obDelta = computeOrderBookDelta(pressure.imbalance);
        const spread = computeSpreadAnalysis(orderBook);
        spreadVolAdjust = spread.volAdjustment;
        orderFlowRaw = pressure.imbalance * 0.30 + pressure.gradient * 2.0 * 0.15 +
                          obDelta.signal * 0.25 + spread.signal * 0.10;
        orderFlowSignal = orderFlowRaw;
    }

    let tradeFlowSignal = 0;
    let vpinVolAdjust = 1.0;
    let lambdaVolAdjust = 1.0;
    if (recentTrades && recentTrades.length > 0) {
        const clustering = computeTradeSizeClustering(recentTrades);
        const rawFlow = computeTradeFlowImbalance(recentTrades);
        const cvd = computeCVD(recentTrades);
        const vpin = computeVPIN(recentTrades);
        tradeFlowSignal = clustering.signal * 0.35 + rawFlow * 0.25 + cvd.signal * 0.25 + vpin.signal * 0.15;
        // VPIN Granger-causes price jumps (research) — strongest microstructure signal
        // More aggressive vol boost: VPIN > 0.35 starts affecting, > 0.6 = major stress
        if (vpin.vpin > 0.35) vpinVolAdjust = 1.0 + (vpin.vpin - 0.35) * 0.8;

        // Kyle's Lambda: price impact rising = liquidity thinning = trend fragile
        const kyleLambda = computeKyleLambda(recentTrades, prices);
        if (kyleLambda.liquidityThinning) {
            // When liquidity is thinning, boost vol estimate (wider uncertainty)
            // and dampen momentum signals (trend is on fumes)
            lambdaVolAdjust = 1.0 + Math.min(0.3, (kyleLambda.lambdaZScore - 1.5) * 0.15);
        }
    }

    // Flow agreement boost removed — order flow decays to noise at 15-min horizon

    // SIGNAL 20: ETH LEAD-LAG (cross-asset) — moved before microVolAdjust
    const ethLL = computeEthLeadLag(prices, marketData.ethPriceHistory);

    // SIGNAL 21: OPEN INTEREST VOL ADJUSTMENT — moved before microVolAdjust
    const oiSignal = computeOIVolSignal(marketData.openInterestHistory);

    // SIGNAL 26: LIQUIDATION CASCADE — strongest short-term signal (60-68% accuracy)
    let liqSignal = 0;
    let liqVolAdjust = 1.0;
    if (marketData.liquidations && marketData.liquidations.totalLiqVol > 0) {
        const liq = marketData.liquidations;
        // Directional signal: positive imbalance = shorts liquidated = bullish
        if (liq.totalLiqVol > 100000) { // >$100K in liquidations = meaningful
            liqSignal = liq.imbalance * Math.min(0.4, liq.totalLiqVol / 5000000); // scale by size
        }
        // Vol adjustment: active liquidation cascade = higher vol
        if (liq.totalLiqVol > 500000) liqVolAdjust = 1.15; // >$500K
        if (liq.totalLiqVol > 2000000) liqVolAdjust = 1.30; // >$2M
    }

    const microVolAdjust = spreadVolAdjust * vpinVolAdjust * lambdaVolAdjust * oiSignal.volMultiplier * liqVolAdjust;
    const adjustedRemainingVol = remainingVol * microVolAdjust;
    const driftWithEarlyBias = minutesIntoPeriod <= 3 ? rawDrift * 0.75 + earlyMomentumSignal * 0.25 : rawDrift;
    const adjustedDrift = driftWithEarlyBias * driftMultiplier;
    const driftZShift = adjustedRemainingVol > 0 ? adjustedDrift / adjustedRemainingVol : 0;

    // SIGNAL 5: RSI — research shows RSI works as MOMENTUM indicator for BTC,
    // not mean-reversion. High RSI = bullish continuation; low RSI = bearish.
    // Only extreme values (>85, <15) indicate true exhaustion for contrarian fade.
    const rsi = computeRSI(prices);
    let rsiSignal = 0;
    if (rsi > 85) rsiSignal = -0.3;        // extreme: likely exhaustion
    else if (rsi > 65) rsiSignal = 0.25;    // strong momentum, ride it
    else if (rsi > 55) rsiSignal = 0.10;    // mild bullish momentum
    else if (rsi < 15) rsiSignal = 0.3;     // extreme: likely exhaustion (bounce)
    else if (rsi < 35) rsiSignal = -0.25;   // strong bearish momentum, follow it
    else if (rsi < 45) rsiSignal = -0.10;   // mild bearish momentum

    // SIGNAL 6: CANDLE PATTERNS
    const candlePattern = detectCandlePatterns(history);

    // SIGNAL 7: VOLUME SURGE
    let volumeSurgeSignal = 0;
    const volumes = history.map(h => h.volume || 0).filter(v => v > 0);
    if (volumes.length > 10) {
        const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
        const recentVol = volumes.slice(-2).reduce((a, b) => a + b, 0) / 2;
        const volRatio = avgVol > 0 ? recentVol / avgVol : 1;
        if (volRatio > 2.0) volumeSurgeSignal = mom3 > 0 ? 0.3 : -0.3;
        else if (volRatio > 1.5) volumeSurgeSignal = mom3 > 0 ? 0.15 : -0.15;
    }

    // SIGNAL 8: FUNDING RATE
    let fundingSignal = 0;
    // Funding rate contrarian signal: baseline is ~0.0001 (0.01%/8hr)
    // Trigger on deviation from baseline, not absolute level
    // Research: > 0.05%/8hr = crowded longs, < -0.03%/8hr = panic shorting
    if (marketData.fundingRate) {
        const frData = marketData.fundingRate;
        // Support both old format (number) and new format (object with settledRate + premium)
        const fr = typeof frData === 'number' ? frData : (frData.settledRate || 0);
        const premium = typeof frData === 'object' ? (frData.premium || 0) : 0;
        const deviation = fr - 0.0001; // deviation from normal baseline
        if (Math.abs(deviation) > 0.0003) {
            const magnitude = Math.min(0.25, Math.abs(deviation) * 200);
            fundingSignal = -Math.sign(deviation) * magnitude;
        }
        // Real-time premium (mark vs index) is a faster signal than settled funding
        // High premium = leveraged longs paying up → contrarian short bias
        if (Math.abs(premium) > 0.0005) {
            const premiumSignal = -Math.sign(premium) * Math.min(0.15, Math.abs(premium) * 100);
            fundingSignal = fundingSignal * 0.4 + premiumSignal * 0.6; // Weight premium more
        }
    }

    // SIGNAL: LONG/SHORT RATIO — contra-indicator when crowd heavily positioned
    // Binance top trader account ratio; >1.5 = crowd heavily long, <0.7 = crowd short
    let longShortSignal = 0;
    if (marketData.longShortRatio && marketData.longShortRatio.ratio) {
        const lsr = marketData.longShortRatio.ratio;
        if (lsr > 2.0) longShortSignal = -0.15;        // extreme long = bearish contra
        else if (lsr > 1.5) longShortSignal = -0.08;    // moderately long
        else if (lsr < 0.5) longShortSignal = 0.15;     // extreme short = bullish contra
        else if (lsr < 0.7) longShortSignal = 0.08;     // moderately short
    }

    // SIGNAL: HOUR-OF-DAY BIAS — research-backed intraday seasonality
    // 22:00-23:00 UTC consistently bullish (~0.07% avg return, p<0.05)
    // US market open (14:30 UTC) = elevated volatility / momentum regime
    const utcHour = new Date().getUTCHours();
    let hourBias = 0;
    if (utcHour === 22) hourBias = 0.08;       // strongest anomaly
    else if (utcHour === 21 || utcHour === 23) hourBias = 0.04; // shoulders
    else if (utcHour === 3) hourBias = -0.03;   // weakest hour (not significant, small)

    // COMBINE SIGNALS
    const timeProgress = Math.max(0, Math.min(1, 1 - (minutesAhead / 15)));
    const sigK = 4, sigMid = 0.6;
    const sigRaw = 1 / (1 + Math.exp(-sigK * (timeProgress - sigMid)));
    const sigMin = 1 / (1 + Math.exp(sigK * sigMid));
    const sigMax = 1 / (1 + Math.exp(-sigK * sigMid));
    // Reduced positional weight so signals have more influence on final probability
    // Was 0.75-0.98 — now 0.55-0.80. This lets momentum/flow signals create tradeable edges.
    const positionalWeight = 0.55 + ((sigRaw - sigMin) / (sigMax - sigMin)) * 0.25;

    const vwapResult = computeAnchoredVWAP(history);
    const vwapSignal = Math.max(-0.5, Math.min(0.5, vwapResult.deviation * 1000));
    const macd = computeMACD(prices);
    const macdSignal = Math.max(-0.4, Math.min(0.4, (macd.histogram / current) * 50000));
    const linReg = computeLinRegSlope(prices, 10);
    const linRegSignal = Math.max(-0.4, Math.min(0.4, linReg.slope * 500 * linReg.r2));
    const bayesianPrior = computeBayesianPrior();
    const bbSqueeze = computeBollingerSqueeze(prices);
    const srSignal = computeSRNearStrike(history, strike);
    const haResult = computeHeikinAshi(history);
    const crossTF = computeCrossTimeframeMomentum(prices);
    const microMR = detectMicroMeanReversion(prices, orderBook);
    const microMRSignal = microMR.signal;
    const breakoutResult = detectBreakout(prices, history);
    const breakoutSignal = breakoutResult.signal;
    const changePoint = detectChangePoints(prices);
    const cpSignal = changePoint.signal;
    const hurstH = computeHurstExponent(prices.slice(-Math.min(n, 90)));

    // SIGNAL 22: MOMENTUM EXHAUSTION — leading reversal indicator
    const momExhaustion = detectMomentumExhaustion(prices, history);
    const exhaustionSignal = momExhaustion.signal;

    // SIGNAL 23: CHOPPINESS DETECTION — reduce signal weight in choppy markets
    const choppiness = detectChoppiness(prices);

    // SIGNAL 24: NORMALIZED ROC — momentum z-scored by vol
    const nroc5 = computeNormalizedROC(prices, 5);
    const nroc10 = computeNormalizedROC(prices, 10);
    const normRocSignal = (nroc5 * 0.6 + nroc10 * 0.4) * 0.10;

    // SIGNAL 25: MEAN REVERSION COMPOSITE — VWAP+BB z-score with regime gating
    const mrComposite = computeMeanReversionScore(prices, history, trendRegime);

    const earlyBoost = Math.max(0, 1 - timeProgress * 2);
    const urgencyFade = minutesAhead < 3 ? Math.max(0, (minutesAhead - 1) / 2) : 1.0;
    const immediateBoosted = minutesAhead < 3 ? 1 + (3 - minutesAhead) * 0.3 : 1.0;

    // In choppy markets, mild signal reduction (was 0.65 — too aggressive)
    const chopDampen = choppiness.choppy ? 0.85 : 1.0;

    const allSignals = [
        { value: driftZShift, weight: 0.18 }, { value: orderFlowSignal, weight: 0.09 },
        { value: tradeFlowSignal, weight: 0.07 }, { value: vwapSignal, weight: 0.06 },
        { value: macdSignal, weight: 0.05 }, { value: linRegSignal, weight: 0.05 },
        { value: bbSqueeze.breakoutSignal, weight: 0.04 }, { value: haResult.signal, weight: 0.04 },
        { value: crossTF.signal, weight: 0.04 }, { value: rsiSignal, weight: 0.04 },
        { value: candlePattern.signal, weight: 0.04 }, { value: microMRSignal, weight: 0.08 },
        { value: breakoutSignal, weight: 0.06 }, { value: cpSignal, weight: 0.04 },
        { value: ethLL.signal, weight: 0.04 },
        { value: exhaustionSignal, weight: 0.08 },
        { value: normRocSignal, weight: 0.05 },
        { value: mrComposite.signal, weight: 0.06 },
        { value: liqSignal, weight: 0.07 }
    ];
    const agreementMult = computeAgreementMultiplier(allSignals);

    const effectiveAC1 = (hurstH - 0.5) * 2;
    const blendedAC1 = ac1 * 0.5 + effectiveAC1 * 0.5;
    const recentReturn10 = n > 10 ? (prices[n - 1] - prices[n - 11]) / prices[n - 11] : 0;
    const regM = getRegimeMultipliers(trendRegime, volRegime, blendedAC1, recentReturn10);

    // ═══════════════════════════════════════════════════════════════
    // STREAMLINED SIGNAL COMBINATION (was 25+ signals, now 6 independent groups)
    //
    // Research finding (Dev 3 review): 25+ overlapping signals created
    // 3-4x momentum overweight (7 momentum signals measuring the same thing).
    // The old aux z-shift cap of 1.2 could swing probability by 35 points,
    // far more than any noisy 15-min microstructure signal justifies.
    //
    // New architecture: 6 independent signal groups, capped at 0.4 total.
    // Positional z-score (60-75%) dominates; auxiliaries are small perturbations.
    // ═══════════════════════════════════════════════════════════════

    // GROUP 1: Single momentum composite (replaces 7 redundant momentum signals)
    const momentumComposite = driftZShift * regM.momentum;

    // GROUP 2: Order flow composite (replaces 4 overlapping flow signals)
    const flowComposite = (orderFlowSignal * 0.5 + tradeFlowSignal * 0.3 + (typeof cvdSignal !== 'undefined' ? cvdSignal * 0.2 : 0)) * regM.flow;

    // GROUP 3: Mean reversion (single composite)
    const meanRevComposite = (microMRSignal * 0.6 + vwapSignal * 0.4) * regM.reversion;

    // GROUP 4: Liquidation cascade (independent information source)
    const liqComposite = liqSignal * immediateBoosted;

    // GROUP 5: Exhaustion (contrarian, stronger mid/late period)
    const exhaustionComposite = exhaustionSignal * (0.06 + (1 - earlyBoost) * 0.06) * regM.reversion;

    // GROUP 6: ETH confirmation (small, only when active)
    const ethComposite = ethLL.signal * immediateBoosted * regM.momentum;

    const rawTotalZShift = (
        momentumComposite     * 0.12 +   // single momentum (was 7 signals totaling ~0.45)
        flowComposite         * 0.08 +   // order flow (with decay: multiply by exp(-minutesAhead/3))
        meanRevComposite      * 0.10 +   // mean reversion
        liqComposite          * 0.08 +   // liquidation cascades
        exhaustionComposite   * 1.00 +   // already scaled
        ethComposite          * 0.04     // ETH confirmation
    );

    // Shrinkage + cap: max 0.4 total z-shift (was 1.2 — a 1.2 z-shift moves
    // probability by ~35 points, which no combination of noisy 15-min signals justifies)
    const shrinkageFactor = 0.55 * (choppiness.choppy ? 0.80 : 1.0);
    const totalZShift = Math.max(-0.4, Math.min(0.4, rawTotalZShift * shrinkageFactor));

    // Final probability
    const driftAdjustedProb = fatTailCDF(zScore + totalZShift * (1 - positionalWeight) * 0.8, prices);
    function toLogOdds(p) { return Math.log(Math.max(p, 0.001) / Math.max(1 - p, 0.001)); }
    function fromLogOdds(lo) { return 1 / (1 + Math.exp(-lo)); }
    const posLO = toLogOdds(positionalProb) * positionalWeight;
    const driftLO = toLogOdds(driftAdjustedProb) * (1 - positionalWeight);
    const combinedProb = fromLogOdds(posLO + driftLO);
    const polarizedProb = timePolarize(combinedProb, minutesAhead);
    // Removed redundant sigmoid clamping — hard bounds + temperature scaling suffice
    const clampedProb = polarizedProb;
    const ensConf = ensembleConfidence(zScore, totalZShift, positionalWeight, positionalProb, minutesAhead);

    const bayesResult = bayesianAdjust(clampedProb, volRegime.regime, getBayesTrendLabel(trendRegime));
    let finalProb = bayesResult.adjustedProb;

    // Gamma-aware confidence dampening near strike — reduced impact
    const isNearStrike = Math.abs(zScore) < 0.5; // was 0.8 — only dampen very close to strike
    if (isNearStrike && minutesAhead < 5) { // was 8 — only in late period
        const proximityFactor = 1 - Math.abs(zScore) / 0.5;
        const timeFactor = (5 - minutesAhead) / 5;
        const gammaRisk = 1 + proximityFactor * timeFactor * 0.12; // was 0.25
        finalProb = 0.5 + (finalProb - 0.5) / gammaRisk;
    }

    // Apply self-learned corrections from error analysis
    const learned = getLearnedCorrections();
    // Overconfidence correction: dampen probability toward 0.5
    if (learned.overconfidenceRatio !== 1.0) {
        finalProb = 0.5 + (finalProb - 0.5) * learned.overconfidenceRatio;
    }
    // Direction bias correction
    if (learned.directionBias !== 0) {
        finalProb += learned.directionBias;
        finalProb = Math.max(0.05, Math.min(0.95, finalProb));
    }
    // Vol regime correction from learned patterns
    if (learned.volRegimeMultiplier[volRegime.regime] && learned.volRegimeMultiplier[volRegime.regime] !== 1.0) {
        // Widen/narrow probability based on learned vol correction
        const volCorr = learned.volRegimeMultiplier[volRegime.regime];
        finalProb = 0.5 + (finalProb - 0.5) / volCorr;
    }

    // ── Online ML Enhancement ──
    // Uses OnlineMLManager: logistic regression, adaptive ensemble,
    // HMM regime detection, and online calibration.
    try {
        const ml = getOnlineML();
        const { features: mlFeatures, ctx: mlCtx } = extractMLFeatures(marketData, {
            zScore, spreadVolAdjust: spreadVolAdjust || 1.0
        });
        // Add signal probabilities for ensemble tracking
        mlCtx.positionalProb = positionalProb;
        mlCtx.driftAdjustedProb = driftAdjustedProb;
        mlCtx.orderFlowProb = orderFlowSignal > 0 ? 0.5 + orderFlowSignal * 0.3 : 0.5 + orderFlowSignal * 0.3;
        mlCtx.bayesianProb = bayesResult.adjustedProb;
        mlCtx.meanReversionProb = rsiSignal !== 0 ? 0.5 + rsiSignal * 0.2 : 0.5 + microMRSignal * 0.2;
        mlCtx.patternProb = 0.5 + (candlePattern.signal * 0.15 + breakoutSignal * 0.15);

        const mlResult = ml.enhance(finalProb, mlCtx);
        finalProb = mlResult.probability;

        // Store ML features and signal predictions for later learning
        // These will be attached to the Bayesian record for grading
        _lastMLFeatures = mlFeatures;
        _lastSignalPredictions = [
            mlCtx.positionalProb, mlCtx.driftAdjustedProb, mlCtx.orderFlowProb,
            mlCtx.bayesianProb, mlResult.lrProb, mlCtx.meanReversionProb, mlCtx.patternProb,
            mlResult.rlsProb
        ];
    } catch (e) {
        // Online ML is non-critical — if it fails, continue with existing prob
        if (e.message && !e.message.includes('Cannot find module')) {
            console.error('Online ML enhance error:', e.message);
        }
    }

    // ── Temperature scaling for overconfidence correction ──
    // Research: BTC 15-min predictions are systematically overconfident.
    // Temperature T > 1 softens probabilities toward 0.5.
    // T = 1.3 is the recommended default for unverified models.
    // The self-learned overconfidenceRatio above partially handles this,
    // but temperature scaling in logit space is more principled.
    const TEMPERATURE = 1.02; // very mild (was 1.10 — crushed edge too much)
    if (finalProb > 0.01 && finalProb < 0.99) {
        const logit = Math.log(finalProb / (1 - finalProb));
        const scaledLogit = logit / TEMPERATURE;
        finalProb = 1 / (1 + Math.exp(-scaledLogit));
    }

    // ── Hard probability bounds — widened to allow stronger convictions ──
    finalProb = Math.max(0.08, Math.min(0.92, finalProb));

    // Construct output
    const predictUp = finalProb > 0.5;
    const confidenceDistance = Math.abs(finalProb - 0.5) * 2;
    // Anchor to current price (martingale property) with small drift
    const priceScale = learned.priceErrorScale || 1.0;
    const maxDrift = adjustedRemainingVol * settlementVolAdj * current * 0.15 * priceScale;
    const drift = maxDrift * confidenceDistance;
    const predictedPrice = predictUp ? current + Math.max(drift, 0.01) : current - Math.max(drift, 0.01);
    const changePercent = ((predictedPrice - current) / current) * 100;
    const sigmoidInput = (confidenceDistance - 0.35) * 8;
    const sigmoidVal = 1 / (1 + Math.exp(-sigmoidInput));
    const confidence = Math.max(0.20, Math.min(0.96, 0.40 + sigmoidVal * 0.56));

    const trendLabel = ema5 > ema20 ? 'Bullish' : ema5 < ema20 ? 'Bearish' : 'Neutral';
    const momentumLabel = mom5 > 0.001 ? 'Bullish' : mom5 < -0.001 ? 'Bearish' : 'Neutral';
    const rsiLabel = rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral';
    const volLabel = volRegime.regime === 'volatile' ? 'High' : volRegime.regime === 'quiet' ? 'Low' : 'Medium';

    return {
        predictedPrice, changePercent, confidence, probability: finalProb,
        _remainingVol: remainingVol, ensembleConfidence: ensConf,
        signals: { momentum: momentumLabel, volatility: volLabel, trend: trendLabel, rsi: rsiLabel },
        _regimeInfo: { volRegime: volRegime.regime, trendRegime: getBayesTrendLabel(trendRegime) },
        _exhaustion: momExhaustion,
        _choppiness: choppiness
    };
}

// ═══════════════════════════════════════════════════════════════
// SELL SIGNAL ASSESSMENT
// ═══════════════════════════════════════════════════════════════

function assessSellSignal(origPred, updPred, strike, currentPrice, minutesRemaining) {
    if (!origPred || !updPred || strike === null) return null;
    const reasons = [];
    const betIsUp = origPred.predictedPrice >= strike;
    const betDirection = betIsUp ? 'UP' : 'DOWN';
    const priceAboveStrike = currentPrice >= strike;
    const onWrongSide = (betIsUp && !priceAboveStrike) || (!betIsUp && priceAboveStrike);
    const onRightSide = !onWrongSide;
    const distanceFromStrike = currentPrice - strike;
    const distancePct = (Math.abs(distanceFromStrike) / strike) * 100;
    let probForBet = betIsUp ? updPred.probability : (1 - updPred.probability);
    const origProbForBet = betIsUp ? origPred.probability : (1 - origPred.probability);
    const modelFlipped = betIsUp !== (updPred.predictedPrice >= strike);
    const origDirection = betIsUp ? 'UP' : 'DOWN';
    const updDirection = updPred.predictedPrice >= strike ? 'UP' : 'DOWN';

    // Track probability velocity and profit trajectory
    const periodKey = stabilityState.periodKey || 'unknown';
    const probVel = updateProbTracker(periodKey, probForBet, currentPrice, betIsUp, strike);

    // Get momentum exhaustion and choppiness from updated prediction
    const exhaustion = updPred._exhaustion || { exhaustion: 0, type: 'none' };
    const choppiness = updPred._choppiness || { choppy: false, adx: 50 };

    // Remaining vol estimate for recovery analysis
    const remainingVol = updPred._remainingVol || 0.002;
    const remainingVolPct = remainingVol * 100;
    // How many standard deviations away from strike (lower = easier to recover)
    const sigmaDistance = remainingVolPct > 0 ? distancePct / remainingVolPct : 99;

    // ═══════════════════════════════════════════════════════════
    // PHILOSOPHY: Strongly favor holding the original position.
    // Flipping mid-cycle is almost always wrong — the user pays
    // spread twice and the market often reverts. Only recommend
    // selling when recovery is mathematically very unlikely.
    // ═══════════════════════════════════════════════════════════

    // ── Signal alignment ──
    const sigs = updPred.signals;
    let agreeing = 0, opposing = 0;
    if (sigs) {
        if (sigs.momentum === 'Bullish') { betIsUp ? agreeing++ : opposing++; }
        else if (sigs.momentum === 'Bearish') { betIsUp ? opposing++ : agreeing++; }
        if (sigs.trend === 'Bullish') { betIsUp ? agreeing++ : opposing++; }
        else if (sigs.trend === 'Bearish') { betIsUp ? opposing++ : agreeing++; }
        if (sigs.rsi === 'Overbought') { betIsUp ? opposing++ : agreeing++; }
        else if (sigs.rsi === 'Oversold') { betIsUp ? agreeing++ : opposing++; }
    }

    // ═══════════════════════════════════════════════════════════
    // DECISION: Use hard conditions, NOT additive urgency scoring.
    // Each sell level has specific, independently sufficient conditions.
    // This prevents noisy signals from stacking into a false sell.
    // ═══════════════════════════════════════════════════════════

    let level, shortLabel, advice;
    let urgency = 0;

    const noTimeLeft = minutesRemaining < 1.0;
    const almostNoTime = minutesRemaining < 2.0;

    // ── CASE 0: CONFIDENT FLIP — model strongly disagrees with position ──
    // When the updated prediction has HIGH confidence the other way AND price confirms it,
    // sell and flip to the winning side. This is different from normal "wrong side" holds
    // because the model is highly confident (not just briefly on wrong side).
    // Requirements (all must be true):
    //   1. On wrong side of strike (price confirms the model)
    //   2. Model flipped direction OR updated probability strongly favors the other side
    //   3. High confidence (>=80%) — not just a marginal signal
    //   4. Enough time to profit from the flip (>=4 min remaining)
    //   5. Sigma distance >= 0.8 — not just a tiny blip across strike
    const updProbForOtherSide = betIsUp ? (1 - updPred.probability) : updPred.probability;
    const confidenceForFlip = updPred.confidence || 0;
    const shouldFlip = onWrongSide
        && (modelFlipped || updProbForOtherSide >= 0.70)
        && confidenceForFlip >= 0.80
        && minutesRemaining >= 4
        && sigmaDistance >= 0.8;

    if (shouldFlip) {
        level = 'confident_flip'; shortLabel = 'FLIP';
        urgency = 85;
        advice = 'Model strongly predicts ' + updDirection + ' (' + (confidenceForFlip * 100).toFixed(0) +
            '% confidence) while holding ' + origDirection + '. Price is ' + sigmaDistance.toFixed(1) +
            'σ on wrong side with ' + minutesRemaining.toFixed(1) + ' min left — selling to flip.';
        reasons.push('High confidence flip: ' + (confidenceForFlip * 100).toFixed(0) + '% conf ' + updDirection);
        reasons.push(sigmaDistance.toFixed(1) + 'σ on wrong side');
    }

    // ── CASE 1: LOST CAUSE — mathematically dead ──
    // Binary options: only sell when recovery is essentially impossible.
    // At 2.5σ, recovery probability is ~1.2%. At 3.0σ, it's ~0.3%.
    // The trade executor enforces: sell ONLY lost_cause or confident_flip, so these are the sell gates.
    else if (
        (onWrongSide && sigmaDistance >= 2.5 && minutesRemaining < 1.5) ||  // ~1.2% recovery
        (onWrongSide && sigmaDistance >= 3.0)                                // ~0.3% recovery, any time
    ) {
        level = 'lost_cause'; shortLabel = 'LOST CAUSE';
        urgency = 95;
        advice = noTimeLeft
            ? 'No time to recover — price $' + Math.abs(distanceFromStrike).toFixed(2) + ' on wrong side with <1 min left.'
            : 'Recovery requires ' + sigmaDistance.toFixed(1) + 'σ move with only ' + minutesRemaining.toFixed(1) + ' min left. Mathematically dead.';
        reasons.push(sigmaDistance.toFixed(1) + 'σ from strike');
        if (modelFlipped) reasons.push('Model also flipped to ' + updDirection);
    }

    // ── CASE 2: SELL NOW — very unlikely to recover ──
    // Tightened thresholds to hold longer
    else if (
        onWrongSide && (
            (sigmaDistance > 2.2 && minutesRemaining < 3) ||          // was 1.8/4
            (probForBet < 0.07 && minutesRemaining < 2) ||           // was 0.10/3
            (sigmaDistance > 2.0 && minutesRemaining < 2 && probVel.trend === 'collapsing') // was 1.5/2.5
        )
    ) {
        level = 'sell_now'; shortLabel = 'SELL NOW';
        urgency = 75;
        advice = 'On wrong side by ' + sigmaDistance.toFixed(1) + 'σ with ' + minutesRemaining.toFixed(1) +
            ' min left. Recovery needs a ' + distancePct.toFixed(3) + '% move — unlikely in remaining time.';
        reasons.push(sigmaDistance.toFixed(1) + 'σ distance, ' + minutesRemaining.toFixed(1) + ' min left');
        if (probVel.trend === 'collapsing') reasons.push('Probability also collapsing');
    }

    // ── CASE 3: CONSIDER SELLING — wrong side, marginal recovery ──
    // Much tighter — only when really losing with no time
    else if (
        onWrongSide && (
            (sigmaDistance > 1.8 && minutesRemaining < 2.5 && opposing >= 3 && agreeing === 0) || // was 1.2/3.5/2
            (probForBet < 0.10 && minutesRemaining < 2.5 && sigmaDistance > 1.5)                  // was 0.15/4/1.0
        )
    ) {
        level = 'consider_selling'; shortLabel = 'WATCH CLOSELY';
        urgency = 45;
        advice = 'Wrong side by $' + Math.abs(distanceFromStrike).toFixed(2) + ' (' + sigmaDistance.toFixed(1) +
            'σ). Recovery possible but signals not favorable. ' +
            (minutesRemaining < 3 ? 'Running low on time.' : 'Watch for recovery in next 30s.');
        reasons.push(sigmaDistance.toFixed(1) + 'σ from strike');
        if (opposing >= 2) reasons.push('Signals opposing ' + betDirection);
    }

    // ── CASE 4: HOLD THROUGH DIP — wrong side but recoverable ──
    else if (onWrongSide) {
        // Default for being on wrong side: HOLD, not sell
        // BTC fluctuates constantly — being briefly on wrong side is normal
        if (sigmaDistance < 0.8) {
            level = 'hold'; shortLabel = 'HOLD — NORMAL DIP';
            urgency = 10;
            advice = 'Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' on wrong side but only ' +
                sigmaDistance.toFixed(1) + 'σ from strike — well within normal fluctuation range. ' +
                minutesRemaining.toFixed(1) + ' min remaining. Hold.';
        } else {
            level = 'hold'; shortLabel = 'HOLD — WATCH';
            urgency = 20;
            advice = 'Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' on wrong side (' +
                sigmaDistance.toFixed(1) + 'σ). Still recoverable with ' +
                minutesRemaining.toFixed(1) + ' min left. ' +
                (probForBet >= 0.35 ? 'Model still gives ' + (probForBet * 100).toFixed(0) + '% win prob.' :
                 'Monitor — sell only if it deteriorates further.');
        }
        reasons.push(sigmaDistance.toFixed(1) + 'σ from strike');
        if (probForBet >= 0.35) reasons.push('Win prob still ' + (probForBet * 100).toFixed(0) + '%');
        if (agreeing > opposing) reasons.push('Signals still favor ' + betDirection);
        // Add recovery context
        if (exhaustion.exhaustion > 0.5) {
            const moveAgainstExhausting = (betIsUp && exhaustion.roc < 0) || (!betIsUp && exhaustion.roc > 0);
            if (moveAgainstExhausting) {
                reasons.push('Move against you is exhausting — recovery likely');
            }
        }
    }

    // ── CASE 5: WINNING — on right side ──
    // When price is clearly on our side, trust reality over the model.
    // A model saying 13% when price is $116 above strike is wrong — override it.
    else if (onRightSide) {
        // Compute a reality-based win probability: if price is on right side,
        // the actual win prob is at least based on how far we are from strike
        const realityProb = Math.max(probForBet,
            sigmaDistance < 0.3 ? 0.55 :
            sigmaDistance < 0.5 ? 0.60 :
            sigmaDistance < 0.8 ? 0.65 :
            sigmaDistance < 1.0 ? 0.70 :
            sigmaDistance < 1.5 ? 0.78 : 0.85
        );
        const displayProb = realityProb;

        if (distancePct > 0.10 && minutesRemaining < 3 && displayProb >= 0.70) {
            level = 'take_profit'; shortLabel = 'TAKE PROFIT';
            urgency = 5;
            advice = 'Strong position: $' + Math.abs(distanceFromStrike).toFixed(2) + ' on right side with ' +
                (displayProb * 100).toFixed(0) + '% win prob and only ' + minutesRemaining.toFixed(1) +
                ' min left. Can sell now to lock in profit, or hold to expiry.';
        } else if (minutesRemaining < 2) {
            level = 'winning'; shortLabel = 'WINNING';
            urgency = 0;
            advice = 'Almost there — hold to close! Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' +
                (betIsUp ? 'above' : 'below') + ' strike with ' + (displayProb * 100).toFixed(0) + '% win prob.';
        } else if (displayProb >= 0.70) {
            level = 'strong_hold'; shortLabel = 'STRONG HOLD';
            urgency = 0;
            advice = 'Dominant position: ' + (displayProb * 100).toFixed(0) + '% win prob, $' +
                Math.abs(distanceFromStrike).toFixed(2) + ' on right side. Hold confidently.';
            if (agreeing >= 2) reasons.push(agreeing + ' signals agree with ' + betDirection);
        } else if (displayProb >= 0.55) {
            level = 'winning'; shortLabel = 'WINNING';
            urgency = 0;
            const rightSide = betIsUp ? 'above' : 'below';
            advice = 'Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + rightSide + ' strike. ' +
                (displayProb * 100).toFixed(0) + '% win prob. Looking good — hold position.';
        } else {
            level = 'hold'; shortLabel = 'HOLD';
            urgency = 10;
            advice = 'Price on your side by $' + Math.abs(distanceFromStrike).toFixed(2) +
                '. Model cautious at ' + (displayProb * 100).toFixed(0) + '% but position is favored. Hold.';
        }
        // Override probForBet for display
        probForBet = displayProb;
    }

    // ── CASE 6: FALLBACK ──
    else {
        level = 'hold'; shortLabel = 'HOLD';
        urgency = 10;
        advice = 'Position at ' + (probForBet * 100).toFixed(0) + '% win probability. Normal fluctuation — hold position.';
    }

    urgency = Math.min(100, Math.max(0, urgency));

    return {
        level, urgency, reasons: reasons.length > 0 ? reasons : ['Position steady'],
        shortLabel, probForBet, origProbForBet, advice, betDirection,
        modelFlipped, onWrongSide, distancePct, distanceFromStrike,
        sigmaDistance,
        probVelocity: probVel,
        exhaustion: { score: exhaustion.exhaustion, type: exhaustion.type },
        choppiness: { choppy: choppiness.choppy, adx: choppiness.adx },
        peakProb: probTracker.peakProb,
        profitAtRisk: probVel.profitAtRisk
    };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — Called by server.js
// ═══════════════════════════════════════════════════════════════

function handleNewPeriod(periodKey, marketData, minutesAhead, strike, periodEnd) {
    const prediction = predictPrice(marketData, minutesAhead, strike);

    // Assess bet quality — should we even take this trade?
    const betQuality = assessBetQuality(prediction, strike, marketData, minutesAhead);
    prediction._betQuality = betQuality;

    // Record Bayesian prediction
    store.updateBayesianState(bs => {
        if (bs.records.length > 0 && bs.records[bs.records.length - 1].periodKey === periodKey) return;
        const volRegime = detectVolRegime(marketData.history.map(h => h.price));
        const trendRegime = detectTrendRegime(marketData.history.map(h => h.price), marketData.history.length);
        bs.records.push({
            periodKey, startPrice: strike, predictedPrice: prediction.predictedPrice,
            predictedDirection: prediction.predictedPrice >= strike ? 'up' : 'down',
            rawProbability: prediction.probability,
            volRegime: volRegime.regime,
            trendRegime: getBayesTrendLabel(trendRegime),
            timeBucket: getTimeBucket(),
            calibrationBin: getCalibrationBin(prediction.probability),
            timestamp: Date.now(),
            actualPrice: null, actualDirection: null, correct: null
        });
    });

    // Record in prediction log
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const m = now.getMinutes().toString().padStart(2, '0');
    const ampm = now.getHours() >= 12 ? 'PM' : 'AM';
    const timeStr = h + ':' + m + ' ' + ampm;

    store.recordPrediction({
        periodKey, startPrice: strike, predictedPrice: prediction.predictedPrice,
        predictedDirection: prediction.predictedPrice >= strike ? 'up' : 'down',
        time: timeStr, timestamp: Date.now(), actualPrice: null, actualDirection: null, correct: null
    });

    return prediction;
}

function handleSamePeriod(marketData, minutesAhead, strike, periodKey) {
    const raw = predictPrice(marketData, minutesAhead, strike);
    const current = marketData.currentPrice;

    // Reset stability state on new period
    if (periodKey && periodKey !== stabilityState.periodKey) {
        stabilityState.periodKey = periodKey;
        stabilityState.smoothedProbability = null;
        stabilityState.lockedDirection = null;
        stabilityState.consecutiveSameDirection = 0;
        stabilityState.lastRawProb = null;
        stabilityState.flipCount = 0;
    }

    // Initialize locked direction from first prediction of the period
    if (stabilityState.lockedDirection === null) {
        stabilityState.lockedDirection = raw.predictedPrice >= strike ? 'up' : 'down';
        stabilityState.smoothedProbability = raw.probability;
        stabilityState.lastRawProb = raw.probability;
        stabilityState.flipCount = 0;
        return raw;
    }

    // Adaptive EMA alpha — more responsive so edges can develop
    // Was 0.15-0.40; increased to allow faster probability movement
    const alpha = minutesAhead <= 1 ? 0.60
                : minutesAhead <= 2 ? 0.50
                : minutesAhead <= 5 ? 0.40
                : 0.30;
    stabilityState.smoothedProbability = alpha * raw.probability + (1 - alpha) * stabilityState.smoothedProbability;
    const smoothedP = stabilityState.smoothedProbability;

    // Track consecutive same-direction readings
    const rawIsUp = raw.predictedPrice >= strike;
    const rawDir = rawIsUp ? 'up' : 'down';
    if (rawDir === stabilityState.lockedDirection) {
        stabilityState.consecutiveSameDirection = Math.min(stabilityState.consecutiveSameDirection + 1, 30);
    } else {
        stabilityState.consecutiveSameDirection = Math.max(0, stabilityState.consecutiveSameDirection - 1);
    }

    // ── Direction flip logic ──
    // Allow flipping when current price strongly contradicts the locked direction.
    // The key insight: the CURRENT PRICE vs STRIKE is the strongest signal,
    // especially as settlement approaches. If price is far on the wrong side
    // with little time left, the original prediction is simply wrong.
    const lockedIsUp = stabilityState.lockedDirection === 'up';
    const priceVsStrike = (current - strike) / strike; // positive = above strike
    const currentIsUp = current >= strike;
    const directionConflict = lockedIsUp !== currentIsUp;

    // Compute how "wrong" the locked direction is using remaining volatility
    // A large move relative to remaining vol means a flip is very unlikely to revert
    const remainingVol = raw._remainingVol || 0.002;
    const distanceInVols = Math.abs(priceVsStrike) / remainingVol;

    // Flip criteria: price is on the wrong side AND the distance is significant
    // relative to remaining volatility. Harder to flip early, easier near settlement.
    // - With 10+ min left: need ~3 vols of distance (very unlikely to revert)
    // - With 5 min left: need ~2 vols
    // - With 2 min left: need ~1.5 vols
    // - With <1 min left: need ~0.8 vols (price is almost certainly settling here)
    const flipThreshold = minutesAhead <= 1 ? 0.8
                        : minutesAhead <= 2 ? 1.5
                        : minutesAhead <= 5 ? 2.0
                        : 3.0;

    // Also require the raw prediction model to agree (not just price position)
    const rawModelAgrees = rawIsUp === currentIsUp;

    // Limit total flips per period to prevent flip-flopping
    const maxFlips = 2;
    const canFlip = (stabilityState.flipCount || 0) < maxFlips;

    let didFlip = false;
    if (directionConflict && distanceInVols >= flipThreshold && rawModelAgrees && canFlip) {
        console.log(`[prediction-engine] Direction flip: ${stabilityState.lockedDirection} → ${rawDir} ` +
            `(price ${current.toFixed(2)} vs strike ${strike.toFixed(2)}, ` +
            `${distanceInVols.toFixed(1)} vols away, ${minutesAhead.toFixed(1)} min left)`);
        stabilityState.lockedDirection = rawDir;
        stabilityState.consecutiveSameDirection = 0;
        stabilityState.flipCount = (stabilityState.flipCount || 0) + 1;
        // Reset smoothed probability toward the new direction
        stabilityState.smoothedProbability = raw.probability;
        didFlip = true;
    }

    // If direction still conflicts with raw (no flip happened), adjust predicted price
    const finalLockedIsUp = stabilityState.lockedDirection === 'up';
    if (finalLockedIsUp !== rawIsUp && !didFlip) {
        const confDist = Math.abs(smoothedP - 0.5) * 2;
        const offset = remainingVol * strike * confDist * 0.5;
        raw.predictedPrice = finalLockedIsUp
            ? strike + Math.max(offset, 0.01)
            : strike - Math.max(offset, 0.01);
        raw.changePercent = ((raw.predictedPrice - strike) / strike) * 100;
    }

    // Save true raw probability before overwriting with smoothed
    const trueRawProb = raw.probability;
    raw.probability = didFlip ? raw.probability : smoothedP;
    raw._rawProbability = trueRawProb;
    raw._lockedDirection = stabilityState.lockedDirection;
    raw._consecutiveSame = stabilityState.consecutiveSameDirection;
    raw._didFlip = didFlip;
    raw._distanceInVols = distanceInVols;
    stabilityState.lastRawProb = trueRawProb;

    return raw;
}

function gradeBayesianPrediction(currentPrice, periodKey) {
    let updated = false;
    const gradedRecords = [];
    store.updateBayesianState(bs => {
        // Grade ungraded entries from completed periods.
        // Only grade the most recent ungraded period — older records used currentPrice
        // which is wrong (should be closing price of THEIR period, not the current one).
        for (let i = bs.records.length - 1; i >= 0; i--) {
            const rec = bs.records[i];
            if (rec.actualPrice !== null) continue;
            if (rec.periodKey === periodKey) continue;
            // Skip records more than 1 period old — grading with current price is inaccurate
            if (rec.timestamp && Date.now() - rec.timestamp > 20 * 60 * 1000) {
                rec.actualPrice = -1; // mark as stale, skip grading
                rec.staleGraded = true;
                continue;
            }
            rec.actualPrice = currentPrice;
            rec.actualDirection = currentPrice >= rec.startPrice ? 'up' : 'down';
            rec.correct = rec.predictedDirection === rec.actualDirection;
            const success = rec.correct;
            bs.directionBeta[rec.predictedDirection] = betaUpdate(bs.directionBeta[rec.predictedDirection], success);
            if (rec.volRegime && bs.regimeBeta[rec.volRegime])
                bs.regimeBeta[rec.volRegime] = betaUpdate(bs.regimeBeta[rec.volRegime], success);
            if (rec.trendRegime && bs.trendBeta[rec.trendRegime])
                bs.trendBeta[rec.trendRegime] = betaUpdate(bs.trendBeta[rec.trendRegime], success);
            if (rec.timeBucket !== undefined && bs.timeBeta[rec.timeBucket])
                bs.timeBeta[rec.timeBucket] = betaUpdate(bs.timeBeta[rec.timeBucket], success);
            if (rec.calibrationBin !== undefined && bs.calibrationBins[rec.calibrationBin])
                bs.calibrationBins[rec.calibrationBin] = betaUpdate(bs.calibrationBins[rec.calibrationBin], success);
            gradedRecords.push({ ...rec });
            updated = true;
            // No break — grade all pending entries
        }
    });
    // Feed each graded record to self-learning error analysis, session risk, and online ML
    for (const rec of gradedRecords) {
        try {
            analyzeAndLearn(rec);
            updateSessionRisk(rec.correct);

            // Feed outcome to Online ML Manager
            try {
                const ml = getOnlineML();
                // Attach cached ML features if available (from last prediction)
                rec._mlFeatures = _lastMLFeatures;
                rec._signalPredictions = _lastSignalPredictions;
                ml.learn(rec);
            } catch (mlErr) {
                // Online ML learning is non-critical
                if (mlErr.message && !mlErr.message.includes('Cannot find module')) {
                    console.error('Online ML learn error:', mlErr.message);
                }
            }
        } catch(e) { console.error('Error analysis failed:', e.message); }
    }
    return updated;
}

function gradePreviousPrediction(currentPrice, periodKey) {
    store.updatePredictionLog(log => {
        // Grade ALL ungraded entries from completed periods (not just the most recent one).
        // If a cycle was skipped (no Kalshi strike), entries pile up ungraded.
        // By removing the `break`, we grade every pending entry in one pass.
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].actualPrice === null && log[i].periodKey !== periodKey) {
                log[i].actualPrice = currentPrice;
                log[i].actualDirection = currentPrice >= log[i].startPrice ? 'up' : 'down';
                log[i].correct = log[i].predictedDirection === log[i].actualDirection;
                // No break — grade all pending entries
            }
        }
    });
}

function computeNextPeriodPreview(marketData) {
    if (!marketData || !marketData.currentPrice) return null;
    const pseudoStrike = marketData.currentPrice;
    try {
        const prediction = predictPrice(marketData, 15, pseudoStrike);
        const isUp = prediction.predictedPrice >= pseudoStrike;
        const move = prediction.predictedPrice - pseudoStrike;
        const movePct = (move / pseudoStrike) * 100;
        return {
            direction: isUp ? 'UP' : 'DOWN',
            predictedPrice: prediction.predictedPrice,
            confidence: prediction.confidence,
            probability: prediction.probability,
            move, movePct,
            signals: prediction.signals,
            strike: pseudoStrike,
            probForDirection: isUp ? prediction.probability : (1 - prediction.probability)
        };
    } catch(e) {
        console.warn('Next period preview failed:', e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// SELF-LEARNING ERROR ANALYSIS
// Analyzes each graded prediction, identifies error patterns,
// and computes adaptive corrections to improve future predictions.
// ═══════════════════════════════════════════════════════════════

const ERROR_LOG_FILE = require('path').join(__dirname, 'data', 'error-analysis.log');

function logErrorAnalysis(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    try {
        require('fs').appendFileSync(ERROR_LOG_FILE, line);
    } catch(e) { /* ignore file errors */ }
    console.log(`[ErrorAnalysis] ${message}`);
}

function getDistanceBucket(distancePct) {
    if (distancePct < 0.05) return 'near_0-0.05%';
    if (distancePct < 0.15) return 'close_0.05-0.15%';
    if (distancePct < 0.30) return 'mid_0.15-0.30%';
    return 'far_0.30%+';
}

function getHourBucket(timestamp) {
    const h = new Date(timestamp).getUTCHours();
    if (h < 6) return 'asia_0-6';
    if (h < 12) return 'europe_6-12';
    if (h < 18) return 'us_12-18';
    return 'evening_18-24';
}

function analyzeAndLearn(gradedRecord) {
    // gradedRecord: { periodKey, startPrice, predictedPrice, predictedDirection,
    //                 rawProbability, volRegime, trendRegime, timestamp,
    //                 actualPrice, actualDirection, correct }
    if (!gradedRecord || gradedRecord.actualPrice === null) return;

    const priceError = Math.abs(gradedRecord.predictedPrice - gradedRecord.actualPrice);
    const pricePct = (priceError / gradedRecord.actualPrice) * 100;
    const directionCorrect = gradedRecord.correct;
    const distanceFromStrike = Math.abs(gradedRecord.startPrice - gradedRecord.actualPrice) / gradedRecord.startPrice * 100;
    const distanceBucket = getDistanceBucket(distanceFromStrike);
    const hourBucket = getHourBucket(gradedRecord.timestamp);
    const probError = directionCorrect ? 0 : Math.abs(gradedRecord.rawProbability - 0.5) * 2;

    // Compute how overconfident/underconfident we were
    const confidenceLevel = Math.abs(gradedRecord.rawProbability - 0.5) * 2; // 0-1
    const wasOverconfident = !directionCorrect && confidenceLevel > 0.3;
    const wasUnderconfident = directionCorrect && confidenceLevel < 0.2;

    const record = {
        periodKey: gradedRecord.periodKey,
        timestamp: gradedRecord.timestamp,
        startPrice: gradedRecord.startPrice,
        predictedPrice: gradedRecord.predictedPrice,
        actualPrice: gradedRecord.actualPrice,
        priceError, pricePct,
        predictedDirection: gradedRecord.predictedDirection,
        actualDirection: gradedRecord.actualDirection,
        directionCorrect,
        rawProbability: gradedRecord.rawProbability,
        probError, confidenceLevel,
        wasOverconfident, wasUnderconfident,
        volRegime: gradedRecord.volRegime,
        trendRegime: gradedRecord.trendRegime,
        distanceBucket, hourBucket
    };

    store.updateErrorAnalysis(ea => {
        ea.records.push(record);
        ea.totalAnalyzed++;

        // Update patterns
        const p = ea.patterns;

        // By vol regime
        if (!p.byVolRegime[record.volRegime]) {
            p.byVolRegime[record.volRegime] = { totalError: 0, count: 0, correctCount: 0, overconfidentCount: 0 };
        }
        const vr = p.byVolRegime[record.volRegime];
        vr.totalError += priceError;
        vr.count++;
        if (directionCorrect) vr.correctCount++;
        if (wasOverconfident) vr.overconfidentCount++;

        // By trend regime
        if (!p.byTrendRegime[record.trendRegime]) {
            p.byTrendRegime[record.trendRegime] = { totalError: 0, count: 0, correctCount: 0, overconfidentCount: 0 };
        }
        const tr = p.byTrendRegime[record.trendRegime];
        tr.totalError += priceError;
        tr.count++;
        if (directionCorrect) tr.correctCount++;
        if (wasOverconfident) tr.overconfidentCount++;

        // By time of day
        if (!p.byTimeOfDay[hourBucket]) {
            p.byTimeOfDay[hourBucket] = { totalError: 0, count: 0, correctCount: 0 };
        }
        const tod = p.byTimeOfDay[hourBucket];
        tod.totalError += priceError;
        tod.count++;
        if (directionCorrect) tod.correctCount++;

        // By distance from strike
        if (!p.byDistanceBucket[distanceBucket]) {
            p.byDistanceBucket[distanceBucket] = { totalError: 0, count: 0, correctCount: 0 };
        }
        const db = p.byDistanceBucket[distanceBucket];
        db.totalError += priceError;
        db.count++;
        if (directionCorrect) db.correctCount++;

        // By direction
        const dir = p.byDirection[record.predictedDirection] ||
            { totalError: 0, count: 0, correctCount: 0 };
        dir.totalError += priceError;
        dir.count++;
        if (directionCorrect) dir.correctCount++;
        p.byDirection[record.predictedDirection] = dir;

        // Recompute adaptive corrections every 10 records
        if (ea.totalAnalyzed % 10 === 0 && ea.records.length >= 10) {
            recomputeCorrections(ea);
        }

        ea.lastAnalysis = Date.now();
    });

    // Log to file
    const emoji = directionCorrect ? 'OK' : 'WRONG';
    logErrorAnalysis(
        `${emoji} | Period=${gradedRecord.periodKey} | ` +
        `Predicted=${gradedRecord.predictedDirection.toUpperCase()} Actual=${gradedRecord.actualDirection.toUpperCase()} | ` +
        `PriceErr=$${priceError.toFixed(2)} (${pricePct.toFixed(3)}%) | ` +
        `Prob=${(gradedRecord.rawProbability*100).toFixed(1)}% Conf=${(confidenceLevel*100).toFixed(0)}% | ` +
        `Vol=${gradedRecord.volRegime} Trend=${gradedRecord.trendRegime} | ` +
        `${wasOverconfident ? 'OVERCONFIDENT' : wasUnderconfident ? 'UNDERCONFIDENT' : 'calibrated'}`
    );
}

function recomputeCorrections(ea) {
    const recent = ea.records.slice(-50); // last 50 predictions
    if (recent.length < 10) return;

    const c = ea.corrections;

    // 1. Overconfidence ratio: if we're often wrong when confident, dampen
    const confidentWrong = recent.filter(r => r.wasOverconfident).length;
    const confidentTotal = recent.filter(r => r.confidenceLevel > 0.3).length;
    if (confidentTotal > 5) {
        const overconfRate = confidentWrong / confidentTotal;
        // Target: < 30% wrong when confident. If higher, dampen.
        if (overconfRate > 0.40) {
            c.overconfidenceRatio = Math.max(0.5, c.overconfidenceRatio * 0.95);
        } else if (overconfRate < 0.20) {
            c.overconfidenceRatio = Math.min(1.5, c.overconfidenceRatio * 1.02);
        }
    }

    // 2. Direction bias: if we systematically predict one direction too much
    const upPreds = recent.filter(r => r.predictedDirection === 'up');
    const downPreds = recent.filter(r => r.predictedDirection === 'down');
    const upAccuracy = upPreds.length > 3 ? upPreds.filter(r => r.directionCorrect).length / upPreds.length : 0.5;
    const downAccuracy = downPreds.length > 3 ? downPreds.filter(r => r.directionCorrect).length / downPreds.length : 0.5;
    c.directionBias = (upAccuracy - downAccuracy) * 0.1; // small correction

    // 3. Vol regime corrections: if we're worse in certain regimes
    for (const [regime, stats] of Object.entries(ea.patterns.byVolRegime)) {
        if (stats.count < 5) continue;
        const avgError = stats.totalError / stats.count;
        const accuracy = stats.correctCount / stats.count;
        // If accuracy is low in this regime, boost vol (widen uncertainty)
        if (accuracy < 0.45) {
            c.volRegimeMultiplier[regime] = 1.15; // widen vol by 15%
        } else if (accuracy > 0.65) {
            c.volRegimeMultiplier[regime] = 0.95; // slightly tighten
        } else {
            c.volRegimeMultiplier[regime] = 1.0;
        }
    }

    // 4. Price error scaling: if our predicted prices are systematically too far/close
    const avgPriceError = recent.reduce((s, r) => s + r.pricePct, 0) / recent.length;
    const medianMove = recent.reduce((s, r) => s + Math.abs(r.actualPrice - r.startPrice) / r.startPrice * 100, 0) / recent.length;
    if (medianMove > 0.01) {
        // If our error is much larger than typical moves, scale down predictions
        const errorRatio = avgPriceError / medianMove;
        if (errorRatio > 1.5) c.priceErrorScale = Math.max(0.3, c.priceErrorScale * 0.9);
        else if (errorRatio < 0.8) c.priceErrorScale = Math.min(2.0, c.priceErrorScale * 1.05);
    }

    logErrorAnalysis(
        `CORRECTIONS UPDATED (n=${recent.length}): ` +
        `overconfRatio=${c.overconfidenceRatio.toFixed(3)} | ` +
        `dirBias=${c.directionBias.toFixed(4)} | ` +
        `priceScale=${c.priceErrorScale.toFixed(3)} | ` +
        `volRegime=${JSON.stringify(c.volRegimeMultiplier)} | ` +
        `upAcc=${(upAccuracy*100).toFixed(0)}% downAcc=${(downAccuracy*100).toFixed(0)}%`
    );
}

// Get learned corrections for use in predictPrice
function getLearnedCorrections() {
    const ea = store.getErrorAnalysis();
    if (!ea || !ea.corrections) {
        return { overconfidenceRatio: 1.0, directionBias: 0, priceErrorScale: 1.0, volRegimeMultiplier: {} };
    }
    return ea.corrections;
}

// Generate a human-readable error analysis summary
function getErrorSummary() {
    const ea = store.getErrorAnalysis();
    if (!ea || ea.totalAnalyzed < 5) {
        return { message: 'Insufficient data for analysis (need 5+ graded predictions)', totalAnalyzed: ea ? ea.totalAnalyzed : 0 };
    }

    const recent = ea.records.slice(-50);
    const accuracy = recent.filter(r => r.directionCorrect).length / recent.length;
    const avgPriceError = recent.reduce((s, r) => s + r.priceError, 0) / recent.length;
    const avgPricePct = recent.reduce((s, r) => s + r.pricePct, 0) / recent.length;
    const overconfRate = recent.filter(r => r.wasOverconfident).length / recent.length;

    return {
        totalAnalyzed: ea.totalAnalyzed,
        recentCount: recent.length,
        directionAccuracy: accuracy,
        avgPriceError: avgPriceError,
        avgPricePctError: avgPricePct,
        overconfidenceRate: overconfRate,
        patterns: ea.patterns,
        corrections: ea.corrections,
        message: `Direction accuracy: ${(accuracy*100).toFixed(1)}% | Avg error: $${avgPriceError.toFixed(2)} (${avgPricePct.toFixed(3)}%) | Overconfident: ${(overconfRate*100).toFixed(0)}%`
    };
}

module.exports = {
    predictPrice,
    handleNewPeriod,
    handleSamePeriod,
    gradeBayesianPrediction,
    gradePreviousPrediction,
    assessSellSignal,
    assessBetQuality,
    computeNextPeriodPreview,
    analyzeAndLearn,
    getLearnedCorrections,
    getErrorSummary,
    detectMomentumExhaustion,
    detectChoppiness,
    getSessionRiskMultiplier,
    sessionRisk,
    getOnlineML
};
