'use strict';

const store = require('./store');

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
};

// Anti-flip-flop state for updated predictions (persists within a period)
const stabilityState = {
    smoothedProbability: null,
    lockedDirection: null,
    consecutiveSameDirection: 0,
    lastRawProb: null,
    periodKey: null,
};

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

function getIntradayVolMultiplier() {
    const now = new Date();
    const hourFrac = now.getUTCHours() + now.getUTCMinutes() / 60;
    const schedule = [
        [0, 0.75], [6, 0.90], [8, 1.10], [12, 0.95],
        [14.5, 1.40], [16, 1.15], [20, 0.85], [24, 0.75]
    ];
    for (let i = 0; i < schedule.length - 1; i++) {
        if (hourFrac >= schedule[i][0] && hourFrac < schedule[i + 1][0]) {
            const t = (hourFrac - schedule[i][0]) / (schedule[i + 1][0] - schedule[i][0]);
            return schedule[i][1] + t * (schedule[i + 1][1] - schedule[i][1]);
        }
    }
    return 1.0;
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

function computeOrderBookImbalance(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) return 0;
    let bidVol = 0, askVol = 0;
    const levels = Math.min(orderBook.bids.length, orderBook.asks.length, 10);
    for (let i = 0; i < levels; i++) {
        const weight = 1 / (i + 1);
        bidVol += parseFloat(orderBook.bids[i][1]) * weight;
        askVol += parseFloat(orderBook.asks[i][1]) * weight;
    }
    const total = bidVol + askVol;
    if (total === 0) return 0;
    return (bidVol - askVol) / total;
}

function computeTradeFlowImbalance(trades) {
    if (!trades || trades.length === 0) return 0;
    let buyVol = 0, sellVol = 0;
    const cutoff = Date.now() - 60000;
    for (const t of trades) {
        if (t.T < cutoff) continue;
        const qty = parseFloat(t.q);
        if (t.m) sellVol += qty;
        else buyVol += qty;
    }
    const total = buyVol + sellVol;
    if (total === 0) return 0;
    return (buyVol - sellVol) / total;
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
        const weight = Math.exp(-0.15 * i);
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
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / period);
    const bandwidth = stdDev / mean;
    const histBandwidths = [];
    for (let i = period; i <= prices.length; i++) {
        const s = prices.slice(i - period, i);
        const m = s.reduce((a, b) => a + b, 0) / period;
        const sd = Math.sqrt(s.reduce((sum, p) => sum + (p - m) ** 2, 0) / period);
        histBandwidths.push(sd / m);
    }
    histBandwidths.sort((a, b) => a - b);
    const pct20 = histBandwidths[Math.floor(histBandwidths.length * 0.2)] || bandwidth;
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

function getRegimeMultipliers(trendRegime, volRegime, ac1) {
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
    if (typeof nIter === 'undefined') nIter = 30;
    function randn() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
    function toLogOddsE(p) { return Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9)); }
    function fromLogOddsE(lo) { return 1 / (1 + Math.exp(-lo)); }
    const samples = [];
    for (let i = 0; i < nIter; i++) {
        const pZ = zScore + randn() * 0.05;
        const pShift = Math.max(-1, Math.min(1, totalZShift + randn() * 0.03));
        const pPosPr = Math.max(0.01, Math.min(0.99, positionalProb + randn() * 0.02));
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
    return Math.max(0.01, Math.min(0.99, den > 0 ? num / den : 0.5));
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
    const ema12 = computeEMA(prices, 12);
    const ema26 = computeEMA(prices, 26);
    const macdLine = ema12 - ema26;
    const macdValues = [];
    for (let i = 26; i <= prices.length; i++) {
        const e12 = computeEMA(prices.slice(0, i), 12);
        const e26 = computeEMA(prices.slice(0, i), 26);
        macdValues.push(e12 - e26);
    }
    const signalLine = macdValues.length >= 9 ? computeEMA(macdValues, 9) : macdLine;
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
        momIsHigher = recentMom < priorMom * 0.7;
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

// ── Bet quality assessment: should we even enter this trade? ──
function assessBetQuality(prediction, strike, marketData, minutesAhead) {
    const probForBet = prediction.predictedPrice >= strike ? prediction.probability : (1 - prediction.probability);
    const edge = probForBet - 0.5;
    const confidence = prediction.confidence;
    const prices = marketData.history.map(h => h.price);
    const chop = detectChoppiness(prices);
    const exhaustion = detectMomentumExhaustion(prices, marketData.history);

    // Minimum edge threshold: need at least 3% edge after Kalshi fees
    // Kalshi fees ≈ 7 cents per contract per side
    // At 50c contracts, that's 14% round-trip. Need significant edge.
    const minEdge = 0.035; // 3.5% minimum edge

    // Quality factors
    const factors = {
        hasMinEdge: edge >= minEdge,
        hasConfidence: confidence >= 0.45,
        notChoppy: !chop.choppy,
        notExhausted: exhaustion.exhaustion < 0.4,
        hasTime: minutesAhead >= 3, // don't enter with < 3 min left
        signalAgreement: prediction.ensembleConfidence?.level !== 'low',
    };

    // Score each factor
    let score = 0;
    let maxScore = 0;
    const weights = { hasMinEdge: 3, hasConfidence: 2, notChoppy: 2, notExhausted: 2, hasTime: 1, signalAgreement: 1 };
    for (const [key, weight] of Object.entries(weights)) {
        maxScore += weight;
        if (factors[key]) score += weight;
    }

    const quality = score / maxScore;
    const shouldBet = quality >= 0.55; // need >55% of quality factors
    const waitForBetter = !shouldBet && minutesAhead > 8; // still early, might improve

    // Optimal entry timing: in choppy markets, wait for clearer signal
    let suggestedWait = 0;
    if (chop.choppy && minutesAhead > 8) suggestedWait = 3; // wait 3 min
    if (exhaustion.exhaustion > 0.5) suggestedWait = Math.max(suggestedWait, 2); // wait for exhaustion to resolve

    return {
        quality, shouldBet, waitForBetter, suggestedWait,
        edge, factors, choppiness: chop, exhaustion,
        reason: !shouldBet ?
            (!factors.hasMinEdge ? 'Edge too thin (' + (edge*100).toFixed(1) + '%)' :
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
    // GARCH research: BTC alpha ≈ 0.20 (lambda = 1-alpha = 0.80)
    // Old lambda=0.97 was too smooth, reacted too slowly to vol shocks
    const ewmaVol = computeEWMAVol(prices, 0.80);
    const gkVol = computeGarmanKlassVol(history, adaptiveWindow);
    const rawPerMinVol = 0.25 * ccVol + 0.40 * ewmaVol + 0.35 * gkVol;
    // Leverage effect: negative recent returns → vol boost (EGARCH finding)
    // BTC has ~2x vol increase after negative shocks
    const recentReturn = n > 1 ? Math.log(prices[n-1] / prices[n-2]) : 0;
    // Leverage effect is WEAK in BTC (EGARCH gamma ≈ -0.038, unlike equities)
    // Reduced from 40% max to 15% max boost on negative returns
    const leverageAdj = recentReturn < -0.002 ? 1.0 + Math.min(0.15, Math.abs(recentReturn) * 20) : 1.0;
    // Weekend vol reduction: weekday vol is substantially higher than weekends
    const dayOfWeek = new Date().getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const weekendAdj = isWeekend ? 0.80 : 1.0; // 20% lower vol on weekends
    const leverageAdjVol = rawPerMinVol * leverageAdj * weekendAdj;
    const shortVol = computeRealizedVol(prices, Math.min(8, n - 1));
    const longVol = computeRealizedVol(prices, Math.min(60, n - 1));
    const volBlendRatio = minutesAhead / 15;
    const blendedVol = longVol * volBlendRatio + shortVol * (1 - volBlendRatio);
    const perMinuteVol = Math.max(leverageAdjVol, blendedVol * 0.9);
    const { remainingVol: rawRemainingVol, H } = computeAdjustedRemainingVol(perMinuteVol, minutesAhead, prices);
    const todMult = getIntradayVolMultiplier();
    const remainingVol = rawRemainingVol * (0.70 + 0.30 * todMult);
    // Settlement-aware volatility compression
    // Kalshi settles to 60-second trimmed average of CF Benchmarks RTI
    // (top/bottom 20% excluded = 36 values averaged)
    // With autocorrelation, effective_n ≈ 12-15 → settlement vol ≈ spot vol * 0.29
    let settlementVolAdj = 1.0;
    if (minutesAhead <= 1) {
        const secAhead = minutesAhead * 60;
        const fraction = Math.max(0, Math.min(1, secAhead / 60));
        settlementVolAdj = 0.29 + fraction * 0.16;
    } else if (minutesAhead <= 2) {
        settlementVolAdj = 0.45 + (minutesAhead - 1) * 0.20;
    } else if (minutesAhead <= 3) {
        settlementVolAdj = 0.65 + (minutesAhead - 2) * 0.15;
    } else if (minutesAhead <= 5) {
        settlementVolAdj = 0.80 + (minutesAhead - 3) / 2 * 0.20;
    }
    const settlementVol = remainingVol * settlementVolAdj;
    const zScore = settlementVol > 0 ? Math.log(current / strike) / settlementVol : 0;
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
    let driftMultiplier = 1.0;
    if (ac1 < -0.35) driftMultiplier = 0.15;
    else if (ac1 > 0.35) driftMultiplier = 0.95;
    else if (trendRegime.meanReverting) driftMultiplier = 0.25;
    else if (trendRegime.trending) driftMultiplier = 1.0;

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
    if (recentTrades && recentTrades.length > 0) {
        const clustering = computeTradeSizeClustering(recentTrades);
        const rawFlow = computeTradeFlowImbalance(recentTrades);
        const cvd = computeCVD(recentTrades);
        const vpin = computeVPIN(recentTrades);
        tradeFlowSignal = clustering.signal * 0.35 + rawFlow * 0.25 + cvd.signal * 0.25 + vpin.signal * 0.15;
        // VPIN Granger-causes price jumps (research) — strongest microstructure signal
        // More aggressive vol boost: VPIN > 0.35 starts affecting, > 0.6 = major stress
        if (vpin.vpin > 0.35) vpinVolAdjust = 1.0 + (vpin.vpin - 0.35) * 0.8;
    }

    // Flow agreement boost removed — order flow decays to noise at 15-min horizon

    const microVolAdjust = spreadVolAdjust * vpinVolAdjust * oiSignal.volMultiplier;
    const adjustedRemainingVol = remainingVol * microVolAdjust;
    const driftWithEarlyBias = minutesIntoPeriod <= 3 ? rawDrift * 0.75 + earlyMomentumSignal * 0.25 : rawDrift;
    const adjustedDrift = driftWithEarlyBias * driftMultiplier;
    const driftZShift = adjustedRemainingVol > 0 ? adjustedDrift / adjustedRemainingVol : 0;

    // SIGNAL 5: RSI
    const rsi = computeRSI(prices);
    let rsiSignal = 0;
    if (rsi > 75) rsiSignal = -0.5;
    else if (rsi > 65) rsiSignal = -0.25;
    else if (rsi < 25) rsiSignal = 0.5;
    else if (rsi < 35) rsiSignal = 0.25;

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
        const fr = marketData.fundingRate;
        const deviation = fr - 0.0001; // deviation from normal baseline
        if (Math.abs(deviation) > 0.0003) {
            // Graduated contrarian signal based on deviation magnitude
            const magnitude = Math.min(0.25, Math.abs(deviation) * 200);
            fundingSignal = -Math.sign(deviation) * magnitude;
        }
    }

    // SIGNAL 20: ETH LEAD-LAG (cross-asset)
    const ethLL = computeEthLeadLag(prices, marketData.ethPriceHistory);

    // SIGNAL 21: OPEN INTEREST VOL ADJUSTMENT
    const oiSignal = computeOIVolSignal(marketData.openInterestHistory);

    // COMBINE SIGNALS
    const timeProgress = Math.max(0, Math.min(1, 1 - (minutesAhead / 15)));
    const sigK = 4, sigMid = 0.6;
    const sigRaw = 1 / (1 + Math.exp(-sigK * (timeProgress - sigMid)));
    const sigMin = 1 / (1 + Math.exp(sigK * sigMid));
    const sigMax = 1 / (1 + Math.exp(-sigK * sigMid));
    const positionalWeight = 0.75 + ((sigRaw - sigMin) / (sigMax - sigMin)) * 0.23;

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

    const earlyBoost = Math.max(0, 1 - timeProgress * 2);
    const urgencyFade = minutesAhead < 3 ? Math.max(0, (minutesAhead - 1) / 2) : 1.0;
    const immediateBoosted = minutesAhead < 3 ? 1 + (3 - minutesAhead) * 0.3 : 1.0;

    // In choppy markets, reduce all signal weights (less conviction)
    const chopDampen = choppiness.choppy ? 0.65 : 1.0;

    const allSignals = [
        { value: driftZShift, weight: 0.18 }, { value: orderFlowSignal, weight: 0.09 },
        { value: tradeFlowSignal, weight: 0.07 }, { value: vwapSignal, weight: 0.06 },
        { value: macdSignal, weight: 0.05 }, { value: linRegSignal, weight: 0.05 },
        { value: bbSqueeze.breakoutSignal, weight: 0.04 }, { value: haResult.signal, weight: 0.04 },
        { value: crossTF.signal, weight: 0.04 }, { value: rsiSignal, weight: 0.04 },
        { value: candlePattern.signal, weight: 0.04 }, { value: microMRSignal, weight: 0.08 },
        { value: breakoutSignal, weight: 0.06 }, { value: cpSignal, weight: 0.04 },
        { value: ethLL.signal, weight: 0.04 },
        { value: exhaustionSignal, weight: 0.08 }
    ];
    const agreementMult = computeAgreementMultiplier(allSignals);

    const effectiveAC1 = (hurstH - 0.5) * 2;
    const blendedAC1 = ac1 * 0.5 + effectiveAC1 * 0.5;
    const regM = getRegimeMultipliers(trendRegime, volRegime, blendedAC1);

    const rawTotalZShift = (
        driftZShift          * (0.10 + earlyBoost * 0.02) * immediateBoosted * regM.momentum +
        orderFlowSignal      * (0.03 + earlyBoost * 0.01) * immediateBoosted * regM.flow +
        tradeFlowSignal      * (0.03 + earlyBoost * 0.01) * immediateBoosted * regM.flow +
        rsiSignal            * (0.12 - earlyBoost * 0.02) * urgencyFade * regM.reversion +
        candlePattern.signal * (0.04 - earlyBoost * 0.02) * urgencyFade * regM.pattern +
        volumeSurgeSignal    * (0.05 + earlyBoost * 0.03) * regM.volume +
        fundingSignal        * (0.02 - earlyBoost * 0.01) * urgencyFade +
        momAccel * 20        * (0.02 + earlyBoost * 0.02) * immediateBoosted * regM.momentum +
        vwapSignal           * (0.06 + earlyBoost * 0.04) * regM.reversion +
        macdSignal           * (0.05 + earlyBoost * 0.03) * regM.momentum +
        linRegSignal         * (0.04 + earlyBoost * 0.02) * regM.momentum +
        bayesianPrior        * earlyBoost * 0.08 +
        bbSqueeze.breakoutSignal * 0.04 * regM.pattern +
        srSignal             * 0.04 * regM.reversion +
        haResult.signal      * (0.04 - earlyBoost * 0.01) * regM.pattern +
        crossTF.signal       * (0.04 + earlyBoost * 0.03) * immediateBoosted * regM.momentum +
        microMRSignal        * 0.12 * regM.reversion +
        breakoutSignal       * 0.06 * regM.momentum +
        cpSignal             * 0.04 * immediateBoosted +
        ethLL.signal         * 0.04 * immediateBoosted * regM.momentum +
        // Momentum exhaustion: contrarian signal that fades current trend when losing steam
        // Increases weight as period progresses (more useful mid/late period)
        exhaustionSignal     * (0.06 + (1 - earlyBoost) * 0.06) * regM.reversion
    );
    // Bayesian shrinkage: 80% of combined signal is noise at 15-min scale
    // In choppy markets, apply extra dampening to prevent false signals
    const shrinkageFactor = 0.20 * chopDampen;
    const totalZShift = Math.max(-0.8, Math.min(0.8, rawTotalZShift * agreementMult * shrinkageFactor));

    // Final probability
    const driftAdjustedProb = fatTailCDF(zScore + totalZShift * (1 - positionalWeight) * 0.8, prices);
    function toLogOdds(p) { return Math.log(Math.max(p, 0.001) / Math.max(1 - p, 0.001)); }
    function fromLogOdds(lo) { return 1 / (1 + Math.exp(-lo)); }
    const posLO = toLogOdds(positionalProb) * positionalWeight;
    const driftLO = toLogOdds(driftAdjustedProb) * (1 - positionalWeight);
    const combinedProb = fromLogOdds(posLO + driftLO);
    const polarizedProb = timePolarize(combinedProb, minutesAhead);
    const clampedProb = 0.08 + 0.84 / (1 + Math.exp(-5 * (polarizedProb - 0.5)));
    const ensConf = ensembleConfidence(zScore, totalZShift, positionalWeight, positionalProb, minutesAhead);

    const bayesResult = bayesianAdjust(clampedProb, volRegime.regime, getBayesTrendLabel(trendRegime));
    let finalProb = bayesResult.adjustedProb;

    // Gamma-aware confidence dampening — extended to 10 min window and 1.0σ threshold
    const isNearStrike = Math.abs(zScore) < 1.0;
    if (isNearStrike && minutesAhead < 10) {
        const proximityFactor = 1 - Math.abs(zScore) / 1.0;
        const timeFactor = (10 - minutesAhead) / 10;
        const gammaRisk = 1 + proximityFactor * timeFactor * 0.50;
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
    let urgency = 0;
    const betIsUp = origPred.predictedPrice >= strike;
    const betDirection = betIsUp ? 'UP' : 'DOWN';
    const priceAboveStrike = currentPrice >= strike;
    const onWrongSide = (betIsUp && !priceAboveStrike) || (!betIsUp && priceAboveStrike);
    const onRightSide = !onWrongSide;
    const distanceFromStrike = currentPrice - strike;
    const distancePct = (Math.abs(distanceFromStrike) / strike) * 100;
    const probForBet = betIsUp ? updPred.probability : (1 - updPred.probability);
    const origProbForBet = betIsUp ? origPred.probability : (1 - origPred.probability);
    const modelFlipped = betIsUp !== (updPred.predictedPrice >= strike);
    const origDirection = betIsUp ? 'UP' : 'DOWN';
    const updDirection = updPred.predictedPrice >= strike ? 'UP' : 'DOWN';

    // ── NEW: Track probability velocity and profit trajectory ──
    const periodKey = stabilityState.periodKey || 'unknown';
    const probVel = updateProbTracker(periodKey, probForBet, currentPrice, betIsUp, strike);

    // ── NEW: Get momentum exhaustion from updated prediction ──
    const exhaustion = updPred._exhaustion || { exhaustion: 0, type: 'none' };
    const choppiness = updPred._choppiness || { choppy: false, adx: 50 };

    // ═══════════════════════════════════════════════════════════
    // URGENCY SCORING — now with early warning signals
    // ═══════════════════════════════════════════════════════════

    // 1. POSITION SIDE ANALYSIS (same as before but with time scaling)
    if (onWrongSide) {
        const side = betIsUp ? 'below' : 'above';
        // Scale urgency by time remaining: being on wrong side matters more late
        const timeMult = minutesRemaining < 3 ? 1.5 : minutesRemaining < 5 ? 1.2 : 1.0;
        if (distancePct > 0.15) { urgency += 40 * timeMult; reasons.push('Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + side + ' strike (' + distancePct.toFixed(3) + '% away)'); }
        else if (distancePct > 0.08) { urgency += 30 * timeMult; reasons.push('Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + side + ' strike'); }
        else if (distancePct > 0.03) { urgency += 18 * timeMult; reasons.push('Price drifting ' + side + ' strike by $' + Math.abs(distanceFromStrike).toFixed(2)); }
        else { urgency += 8; reasons.push('Price barely ' + side + ' strike ($' + Math.abs(distanceFromStrike).toFixed(2) + ')'); }
    }

    // 2. PROBABILITY COLLAPSE
    if (probForBet < 0.08) { urgency += 45; reasons.push('Win probability collapsed to ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probForBet < 0.15) { urgency += 35; reasons.push('Win probability critical: ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probForBet < 0.25) { urgency += 22; reasons.push('Win probability weak: ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probForBet < 0.35) { urgency += 12; reasons.push('Win probability softening: ' + (probForBet * 100).toFixed(0) + '%'); }

    // 3. SIGNAL DISAGREEMENT
    const sigs = updPred.signals;
    let agreeing = 0, opposing = 0;
    if (sigs) {
        if (sigs.momentum === 'Bullish') { betIsUp ? agreeing++ : opposing++; }
        else if (sigs.momentum === 'Bearish') { betIsUp ? opposing++ : agreeing++; }
        if (sigs.trend === 'Bullish') { betIsUp ? agreeing++ : opposing++; }
        else if (sigs.trend === 'Bearish') { betIsUp ? opposing++ : agreeing++; }
        if (sigs.rsi === 'Overbought') { betIsUp ? opposing++ : agreeing++; }
        else if (sigs.rsi === 'Oversold') { betIsUp ? agreeing++ : opposing++; }
        if (opposing >= 3) { urgency += 20; reasons.push('All signals oppose your ' + betDirection + ' bet'); }
        else if (opposing >= 2 && agreeing === 0) { urgency += 15; reasons.push('Multiple signals turned against ' + betDirection); }
        if (sigs.volatility === 'High' && onWrongSide) { urgency += 5; reasons.push('High volatility amplifies loss risk'); }
    }

    // 4. TIME PRESSURE (more aggressive time decay)
    if (onWrongSide || probForBet < 0.35) {
        if (minutesRemaining < 1) { urgency += 35; reasons.push('Under 60 seconds - no time to recover'); }
        else if (minutesRemaining < 2) { urgency += 25; reasons.push('Under 2 min left - recovery unlikely'); }
        else if (minutesRemaining < 3.5) { urgency += 18; reasons.push('Under 3.5 min - time running out'); }
        else if (minutesRemaining < 5) { urgency += 10; reasons.push('Under 5 min remaining'); }
    }

    // 5. MODEL FLIP
    if (modelFlipped) { urgency += 18; reasons.push('Model now predicts ' + updDirection + ' (was ' + origDirection + ')'); }

    // 6. CONFIDENCE DROP
    const confDrop = origPred.confidence - updPred.confidence;
    if (confDrop > 0.35) { urgency += 15; reasons.push('Confidence crashed: ' + (origPred.confidence * 100).toFixed(0) + '% -> ' + (updPred.confidence * 100).toFixed(0) + '%'); }
    else if (confDrop > 0.20) { urgency += 8; reasons.push('Confidence dropped: ' + (origPred.confidence * 100).toFixed(0) + '% -> ' + (updPred.confidence * 100).toFixed(0) + '%'); }

    // 7. PROBABILITY DROP from entry
    const probDrop = origProbForBet - probForBet;
    if (probDrop > 0.30) { urgency += 15; reasons.push('Win prob fell from ' + (origProbForBet * 100).toFixed(0) + '% to ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probDrop > 0.20) { urgency += 8; reasons.push('Win prob softening from ' + (origProbForBet * 100).toFixed(0) + '% to ' + (probForBet * 100).toFixed(0) + '%'); }

    // ═══════════════════════════════════════════════════════════
    // NEW EARLY WARNING SIGNALS — these trigger BEFORE the dump
    // ═══════════════════════════════════════════════════════════

    // 8. PROBABILITY VELOCITY: prob declining rapidly = exit early
    if (probVel.trend === 'collapsing') {
        urgency += 25; reasons.push('Win probability collapsing (velocity: ' + (probVel.velocity * 1000).toFixed(1) + '/s)');
    } else if (probVel.trend === 'deteriorating') {
        urgency += 12; reasons.push('Win probability deteriorating steadily');
    }

    // 9. PEAK DRAWDOWN: we had a much better prob and now it's falling back
    if (probVel.peakDrawdown > 0.25 && probTracker.peakProb > 0.65) {
        urgency += 20; reasons.push('Prob peaked at ' + (probTracker.peakProb * 100).toFixed(0) + '%, now ' + (probForBet * 100).toFixed(0) + '% (gave back ' + (probVel.peakDrawdown * 100).toFixed(0) + '%)');
    } else if (probVel.peakDrawdown > 0.15 && probTracker.peakProb > 0.60) {
        urgency += 10; reasons.push('Profit slipping: was ' + (probTracker.peakProb * 100).toFixed(0) + '% now ' + (probForBet * 100).toFixed(0) + '%');
    }

    // 10. MOMENTUM EXHAUSTION: the trend supporting our bet is losing steam
    if (exhaustion.exhaustion > 0.5) {
        // Exhaustion against our bet direction
        const exhaustionAgainstUs = (betIsUp && exhaustion.roc > 0) || (!betIsUp && exhaustion.roc < 0);
        if (exhaustionAgainstUs) {
            // Move in our favor is exhausting — take profit!
            urgency += 8; // mild urgency, but triggers take_profit
            reasons.push('Momentum exhaustion: move in your favor losing steam (' + exhaustion.type + ')');
        } else if (exhaustion.exhaustion > 0.6) {
            // Move against us is exhausting — good for recovery
            reasons.push('Counter-move exhausting (recovery signal)');
        }
    }

    // 11. CHOPPINESS: in choppy markets, take profit earlier (harder to sustain position)
    if (choppiness.choppy && onRightSide && probForBet > 0.55 && minutesRemaining > 5) {
        urgency += 5;
        reasons.push('Choppy market (ADX=' + choppiness.adx.toFixed(0) + ') - take profit sooner');
    }

    // 12. PROBABILITY ACCELERATION: prob accelerating downward is very bad
    if (probVel.acceleration < -0.002) {
        urgency += 15; reasons.push('Probability decline accelerating');
    }

    urgency = Math.min(100, Math.max(0, urgency));

    // ═══════════════════════════════════════════════════════════
    // DECISION STATES — now with TAKE_PROFIT and smarter logic
    // ═══════════════════════════════════════════════════════════

    let level, shortLabel, advice;
    const isDeepWrongSide = onWrongSide && distancePct > 0.08;
    const noTimeLeft = minutesRemaining < 1.5;

    // ── LOSING POSITIONS ──
    if (urgency >= 75 || (probForBet < 0.08 && minutesRemaining < 2.5) || (isDeepWrongSide && noTimeLeft)) {
        level = 'lost_cause'; shortLabel = 'LOST CAUSE';
        advice = modelFlipped ? 'Both predictions failed. Sell immediately.' :
            (onWrongSide && noTimeLeft) ? 'Price stuck on wrong side with no time. Sell now.' :
            'Prediction failed. Market moved against you. Sell to minimize loss.';
    } else if (urgency >= 55 || probForBet < 0.18 || (probForBet < 0.28 && minutesRemaining < 3)) {
        level = 'sell_now'; shortLabel = 'SELL NOW';
        advice = modelFlipped ? 'Model flipped to ' + updDirection + '. Sell before it worsens.' :
            onWrongSide ? 'Price on wrong side of strike. Sell to lock in remaining value.' :
            'Win probability too low to justify holding.';
    } else if (urgency >= 35 || (probForBet < 0.35 && minutesRemaining < 5)) {
        level = 'consider_selling'; shortLabel = 'CONSIDER SELLING';
        advice = onWrongSide ? 'Price slipped past strike. May recover, but risk elevated.' :
            'Position weakening. Watch closely.';
    }
    // ── WINNING POSITIONS — with smart profit-taking ──
    else if (onRightSide && probForBet >= 0.55) {
        // NEW: TAKE PROFIT conditions — sell while ahead if reversal is likely
        const shouldTakeProfit = (
            // Condition 1: Momentum exhaustion in our favor's direction + high prob + enough time to sell
            (exhaustion.exhaustion > 0.4 && probForBet > 0.65 && minutesRemaining > 3 &&
             ((betIsUp && exhaustion.roc > 0) || (!betIsUp && exhaustion.roc < 0))) ||
            // Condition 2: Probability peaked high and is now declining
            (probVel.peakDrawdown > 0.12 && probTracker.peakProb > 0.70 && probVel.trend === 'deteriorating') ||
            // Condition 3: Choppy market + good profit = lock it in before it chops back
            (choppiness.choppy && probForBet > 0.70 && distancePct > 0.05 && minutesRemaining > 4) ||
            // Condition 4: Probability velocity turning negative after a run-up
            (probTracker.peakProb > 0.75 && probVel.velocity < -0.003 && probForBet > 0.60) ||
            // Condition 5: Volume climax detected (often marks turning point)
            (exhaustion.volumeClimax > 0.3 && probForBet > 0.65 && minutesRemaining > 3)
        );

        if (shouldTakeProfit && minutesRemaining > 2.5) {
            level = 'take_profit'; shortLabel = 'TAKE PROFIT';
            const rightSide = betIsUp ? 'above' : 'below';
            advice = 'Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + rightSide + ' strike with ' +
                (probForBet * 100).toFixed(0) + '% win prob. ';
            if (exhaustion.exhaustion > 0.4) advice += 'Momentum fading — lock in profit now. ';
            if (probVel.peakDrawdown > 0.12) advice += 'Prob peaked at ' + (probTracker.peakProb * 100).toFixed(0) + '% and declining. ';
            if (choppiness.choppy) advice += 'Choppy market — secure your gains. ';
            if (exhaustion.volumeClimax > 0.3) advice += 'Volume climax detected — reversal likely. ';
        } else if (minutesRemaining < 2) {
            level = 'winning'; shortLabel = 'WINNING';
            advice = 'Almost there — hold to close! Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' +
                (betIsUp ? 'above' : 'below') + ' strike.';
        } else {
            level = 'winning'; shortLabel = 'WINNING';
            const rightSide = betIsUp ? 'above' : 'below';
            advice = 'Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + rightSide + ' strike. ' +
                (minutesRemaining < 3 ? 'Almost there — hold to close!' : 'Looking good — hold position.');
        }
    } else {
        level = 'hold'; shortLabel = 'HOLD';
        advice = probForBet >= 0.50 ? 'Position favored (' + (probForBet * 100).toFixed(0) + '% win prob). Hold.' :
            'Close call (' + (probForBet * 100).toFixed(0) + '% win prob). Monitor closely.';
    }

    return {
        level, urgency, reasons: reasons.length > 0 ? reasons : ['Position steady'],
        shortLabel, probForBet, origProbForBet, advice, betDirection,
        modelFlipped, onWrongSide, distancePct, distanceFromStrike,
        // NEW: additional data for frontend
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

    // Reset stability state on new period
    if (periodKey && periodKey !== stabilityState.periodKey) {
        stabilityState.periodKey = periodKey;
        stabilityState.smoothedProbability = null;
        stabilityState.lockedDirection = null;
        stabilityState.consecutiveSameDirection = 0;
        stabilityState.lastRawProb = null;
    }

    // Initialize locked direction from first prediction of the period
    if (stabilityState.lockedDirection === null) {
        stabilityState.lockedDirection = raw.predictedPrice >= strike ? 'up' : 'down';
        stabilityState.smoothedProbability = raw.probability;
        stabilityState.lastRawProb = raw.probability;
        return raw;
    }

    // EMA smooth the probability — lower alpha = more stable, especially near expiry
    const alpha = minutesAhead <= 2 ? 0.12 : minutesAhead <= 5 ? 0.18 : 0.25;
    stabilityState.smoothedProbability = alpha * raw.probability + (1 - alpha) * stabilityState.smoothedProbability;
    const smoothedP = stabilityState.smoothedProbability;

    // Track consecutive same-direction readings to build conviction
    const rawIsUp = raw.predictedPrice >= strike;
    const rawDir = rawIsUp ? 'up' : 'down';
    if (rawDir === stabilityState.lockedDirection) {
        stabilityState.consecutiveSameDirection = Math.min(stabilityState.consecutiveSameDirection + 1, 20);
    } else {
        // Decay counter when raw disagrees, but don't reset immediately
        stabilityState.consecutiveSameDirection = Math.max(0, stabilityState.consecutiveSameDirection - 2);
    }

    // Hysteresis: require VERY strong sustained signal to flip direction
    // Higher thresholds = more committed to original direction
    const flipThreshold = minutesAhead <= 2 ? 0.40
                        : minutesAhead <= 5 ? 0.28
                        : minutesAhead <= 10 ? 0.18
                        : 0.14;

    // Need sustained conviction: both smoothed probability AND consecutive readings
    const convictionRequired = Math.max(3, Math.floor(stabilityState.consecutiveSameDirection * 0.5));
    const canFlip = stabilityState.consecutiveSameDirection <= 1;

    if (canFlip && stabilityState.lockedDirection === 'up' && smoothedP < (0.5 - flipThreshold)) {
        stabilityState.lockedDirection = 'down';
        stabilityState.consecutiveSameDirection = 0;
        console.log(`SERVER FLIP -> DOWN (smoothedP=${(smoothedP*100).toFixed(1)}%)`);
    } else if (canFlip && stabilityState.lockedDirection === 'down' && smoothedP > (0.5 + flipThreshold)) {
        stabilityState.lockedDirection = 'up';
        stabilityState.consecutiveSameDirection = 0;
        console.log(`SERVER FLIP -> UP (smoothedP=${(smoothedP*100).toFixed(1)}%)`);
    }

    // Override predicted price to match locked direction if raw disagrees
    if ((stabilityState.lockedDirection === 'up') !== rawIsUp) {
        const confDist = Math.abs(smoothedP - 0.5) * 2;
        const offset = (raw._remainingVol || 0.002) * strike * confDist * 0.5;
        raw.predictedPrice = stabilityState.lockedDirection === 'up'
            ? strike + Math.max(offset, 0.01)
            : strike - Math.max(offset, 0.01);
        raw.changePercent = ((raw.predictedPrice - strike) / strike) * 100;
    }

    // Use smoothed probability instead of raw for more stable output
    raw.probability = smoothedP;
    raw._rawProbability = stabilityState.lastRawProb;
    raw._lockedDirection = stabilityState.lockedDirection;
    raw._consecutiveSame = stabilityState.consecutiveSameDirection;
    stabilityState.lastRawProb = raw.probability;

    return raw;
}

function gradeBayesianPrediction(currentPrice, periodKey) {
    let updated = false;
    let gradedRecord = null;
    store.updateBayesianState(bs => {
        for (let i = bs.records.length - 1; i >= 0; i--) {
            const rec = bs.records[i];
            if (rec.actualPrice !== null) continue;
            if (rec.periodKey === periodKey) continue;
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
            gradedRecord = { ...rec };
            updated = true;
            break;
        }
    });
    // Feed graded record to self-learning error analysis
    if (gradedRecord) {
        try { analyzeAndLearn(gradedRecord); } catch(e) { console.error('Error analysis failed:', e.message); }
    }
    return updated;
}

function gradePreviousPrediction(currentPrice, periodKey) {
    store.updatePredictionLog(log => {
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].actualPrice === null && log[i].periodKey !== periodKey) {
                log[i].actualPrice = currentPrice;
                log[i].actualDirection = currentPrice >= log[i].startPrice ? 'up' : 'down';
                log[i].correct = log[i].predictedDirection === log[i].actualDirection;
                break;
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
    detectChoppiness
};
