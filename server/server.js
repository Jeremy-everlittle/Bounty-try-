'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
// FILE PERSISTENCE
// ═══════════════════════════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filename, defaultValue) {
    const filepath = path.join(DATA_DIR, filename);
    try {
        if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) { console.warn('Failed to load', filename, e.message); }
    return defaultValue;
}

function saveJSON(filename, data) {
    try {
        fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data), 'utf8');
    } catch (e) { console.warn('Failed to save', filename, e.message); }
}

// ═══════════════════════════════════════════════════════════════
// DATA FETCHING — Server-side (no CORS issues!)
// ═══════════════════════════════════════════════════════════════

async function fetchJSON(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        clearTimeout(timer);
        return null;
    }
}

// ── BRTI Approximation (multi-exchange mid-prices) ──
async function fetchBRTIApprox() {
    const exchanges = [
        {
            name: 'Bitstamp',
            url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
            parse: d => d && d.bid && d.ask ? (parseFloat(d.bid) + parseFloat(d.ask)) / 2 : null
        },
        {
            name: 'Coinbase',
            url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
            parse: d => d && d.bid && d.ask ? (parseFloat(d.bid) + parseFloat(d.ask)) / 2 : null
        },
        {
            name: 'Gemini',
            url: 'https://api.gemini.com/v1/pubticker/btcusd',
            parse: d => d && d.bid && d.ask ? (parseFloat(d.bid) + parseFloat(d.ask)) / 2 : null
        },
        {
            name: 'Kraken',
            url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
            parse: d => {
                if (!d || !d.result) return null;
                const key = Object.keys(d.result)[0];
                if (!key) return null;
                const t = d.result[key];
                return t.b && t.a ? (parseFloat(t.b[0]) + parseFloat(t.a[0])) / 2 : null;
            }
        },
        {
            name: 'Crypto.com',
            url: 'https://api.crypto.com/v2/public/get-ticker?instrument_name=BTC_USD',
            parse: d => d && d.result && d.result.data ? parseFloat(d.result.data.a) : null
        },
        {
            name: 'Coinbase-simple',
            url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
            parse: d => d && d.data ? parseFloat(d.data.amount) : null
        }
    ];

    const results = await Promise.allSettled(
        exchanges.map(async ex => {
            const data = await fetchJSON(ex.url);
            const price = data ? ex.parse(data) : null;
            if (price && price > 0) return { name: ex.name, price };
            return null;
        })
    );

    const prices = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
    if (prices.length === 0) return null;

    const sorted = [...prices].sort((a, b) => a.price - b.price);
    const median = sorted[Math.floor(sorted.length / 2)].price;
    const filtered = prices.filter(p => Math.abs(p.price - median) / median < 0.25);
    const usePrices = filtered.length >= 2 ? filtered : prices;

    const avg = usePrices.reduce((s, p) => s + p.price, 0) / usePrices.length;
    const sourceNames = usePrices.map(p => p.name).join('+');
    return { price: avg, sources: sourceNames, count: usePrices.length };
}

// ── Kalshi Market Fetching ──
async function fetchKalshiData() {
    try {
        let data = await fetchJSON(
            'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=100'
        );
        let markets = data ? (data.markets || []) : [];
        const now = new Date();
        const hasFuture = markets.some(m => new Date(m.close_time || m.expiration_time) > now);

        if (markets.length === 0 || !hasFuture) {
            const allData = await fetchJSON(
                'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&limit=100'
            );
            if (allData && allData.markets) {
                const existingTickers = new Set(markets.map(m => m.ticker));
                for (const m of allData.markets) {
                    if (!existingTickers.has(m.ticker)) markets.push(m);
                }
            }
        }

        let best = null;
        for (const m of markets) {
            const closeTime = new Date(m.close_time || m.expiration_time);
            if (closeTime > now) {
                if (!best || closeTime < new Date(best.close_time || best.expiration_time)) {
                    best = m;
                }
            }
        }

        if (!best) return { market: null, strike: null, closeTime: null, ticker: null };

        let detailedMarket = best;
        try {
            const detail = await fetchJSON(
                'https://api.elections.kalshi.com/trade-api/v2/markets/' + best.ticker
            );
            if (detail && detail.market) detailedMarket = detail.market;
        } catch (e) {}

        const strike = extractStrike(detailedMarket);
        const closeTime = new Date(best.close_time || best.expiration_time).toISOString();
        return { market: detailedMarket, strike, closeTime, ticker: best.ticker };
    } catch (e) {
        console.error('Kalshi fetch error:', e.message);
        return { market: null, strike: null, closeTime: null, ticker: null };
    }
}

function extractStrike(m) {
    const textFields = [
        'yes_sub_title', 'subtitle', 'no_sub_title', 'rules_primary',
        'rules_secondary', 'strike_description', 'settlement_sources_description',
        'title', 'event_title'
    ];
    for (const field of textFields) {
        if (m[field] && typeof m[field] === 'string') {
            let match = m[field].match(/at least ([\d,]+\.?\d*)/i);
            if (match) return parseFloat(match[1].replace(/,/g, ''));
            match = m[field].match(/\$?([\d,]+\.?\d*)\s*(or above|or more|or higher)/i);
            if (match) return parseFloat(match[1].replace(/,/g, ''));
            match = m[field].match(/above\s+\$?([\d,]+\.?\d*)/i);
            if (match) { const v = parseFloat(match[1].replace(/,/g, '')); if (v > 50000 && v < 150000) return v; }
            match = m[field].match(/\$?([\d,]+\.?\d*)/);
            if (match) { const v = parseFloat(match[1].replace(/,/g, '')); if (v > 50000 && v < 150000) return v; }
        }
    }
    if (m.custom_strike != null) {
        const raw = parseFloat(m.custom_strike);
        if (raw > 50000 && raw < 150000) return raw;
        if (raw > 5000000) return raw / 100;
    }
    if (m.floor_strike != null) {
        const raw = parseFloat(m.floor_strike);
        if (!isNaN(raw) && raw > 0) return raw > 200000 ? raw / 100 : raw;
    }
    if (m.cap_strike != null) {
        const raw = parseFloat(m.cap_strike);
        if (!isNaN(raw) && raw > 0) return raw > 200000 ? raw / 100 : raw;
    }
    return null;
}

// ── Binance APIs ──
async function fetchOrderBook() {
    return await fetchJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20');
}

async function fetchRecentTrades() {
    return await fetchJSON('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=200');
}

async function fetchFundingRate() {
    const data = await fetchJSON('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1');
    if (data && data.length > 0) return parseFloat(data[0].fundingRate);
    return null;
}

async function fetchHistory() {
    const data = await fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=120');
    if (!data) return [];
    return data.map(k => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        price: parseFloat(k[4]),
        volume: parseFloat(k[5])
    }));
}


// ═══════════════════════════════════════════════════════════════
// SERVER-SIDE STATE
// ═══════════════════════════════════════════════════════════════

const state = {
    brtiPrice: null,
    brtiSources: '',
    kalshiStrike: null,
    kalshiCloseTime: null,
    kalshiTicker: null,
    kalshiMarket: null,
    orderBook: null,
    recentTrades: null,
    fundingRate: null,
    history: [],
    lastUpdate: null,
    periodKey: null,
    error: null
};

// Prediction state (persisted)
let predictionLog = loadJSON('prediction-log.json', []);
let bayesianState = loadJSON('bayesian-state.json', {
    records: [],
    directionBeta: { up: { a: 1, b: 1 }, down: { a: 1, b: 1 } },
    regimeBeta: {
        volatile: { a: 1, b: 1 }, expanding: { a: 1, b: 1 },
        normal: { a: 1, b: 1 }, quiet: { a: 1, b: 1 }, contracting: { a: 1, b: 1 }
    },
    trendBeta: {
        trending: { a: 1, b: 1 }, meanReverting: { a: 1, b: 1 }, neutral: { a: 1, b: 1 }
    },
    timeBeta: { 0: { a: 1, b: 1 }, 1: { a: 1, b: 1 }, 2: { a: 1, b: 1 }, 3: { a: 1, b: 1 } },
    calibrationBins: {
        0: { a: 1, b: 1 }, 1: { a: 1, b: 1 }, 2: { a: 1, b: 1 },
        3: { a: 1, b: 1 }, 4: { a: 1, b: 1 }, 5: { a: 1, b: 1 }
    }
});

let sessionState = loadJSON('session-state.json', {
    currentPeriodKey: null,
    periodStartPrice: null,
    originalPrediction: null,
    kalshiMarketTicker: null,
    kalshiCloseTime: null
});

// Live prediction state (not persisted — rebuilt from data)
let currentPeriodKey = sessionState.currentPeriodKey;
let periodStartPrice = sessionState.periodStartPrice;
let originalPrediction = sessionState.originalPrediction;
let updatedPrediction = null;
let smoothedProbability = null;
let lockedDirection = null;
let isTransitioning = false;
let transitionRetries = 0;
let lastKalshiTicker = sessionState.kalshiMarketTicker;
let strikeIsPending = false;
let currentSellSignal = null;
let currentRiskAssessment = null;
let nextPeriodPreview = null;
let dataSourceName = '';

// Microstructure state (accumulates across calls)
const microState = {
    prevOrderBookImbalance: null,
    imbalanceHistory: [],
    tradeFlowHistory: [],
    cumulativeDelta: 0,
    deltaHistory: [],
    spreadHistory: [],
    vpinBucketSize: 0,
};

// Cache timestamps for microstructure data
let orderBookTimestamp = 0;
let recentTradesTimestamp = 0;
let fundingRateTimestamp = 0;

function savePredictionLog() {
    predictionLog = predictionLog.slice(-50);
    saveJSON('prediction-log.json', predictionLog);
}

function saveBayesianState() {
    bayesianState.records = bayesianState.records.slice(-200);
    saveJSON('bayesian-state.json', bayesianState);
}

function saveSessionState() {
    saveJSON('session-state.json', {
        currentPeriodKey,
        periodStartPrice,
        originalPrediction,
        kalshiMarketTicker: state.kalshiTicker,
        kalshiCloseTime: state.kalshiCloseTime
    });
}

// ── Time helpers ──
function getPeriodStartTime() {
    const now = new Date();
    const mins = now.getMinutes();
    const periodStart = Math.floor(mins / 15) * 15;
    const t = new Date(now);
    t.setMinutes(periodStart, 0, 0);
    return t;
}

function getPeriodEndTime() {
    const start = getPeriodStartTime();
    return new Date(start.getTime() + 15 * 60 * 1000);
}

function getPeriodKey() {
    const start = getPeriodStartTime();
    return start.getHours() + ':' + start.getMinutes();
}

function getSecondsUntilTarget(target) {
    return Math.max(0, Math.floor((target - Date.now()) / 1000));
}

function formatLocalTime(date) {
    let h = date.getHours();
    const m = date.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ' ' + ampm;
}

function formatTargetTime(date) {
    const start = new Date(date.getTime() - 15 * 60 * 1000);
    return formatLocalTime(start) + '\u2013' + formatLocalTime(date);
}


// ═══════════════════════════════════════════════════════════════
// BAYESIAN LEARNING SYSTEM
// ═══════════════════════════════════════════════════════════════

function getCalibrationBin(prob) {
    if (prob < 0.20) return 0;
    if (prob < 0.35) return 1;
    if (prob < 0.50) return 2;
    if (prob < 0.65) return 3;
    if (prob < 0.80) return 4;
    return 5;
}

function getTimeBucket() { return Math.floor(new Date().getHours() / 6); }
function betaMean(beta) { return beta.a / (beta.a + beta.b); }
function betaN(beta) { return beta.a + beta.b - 2; }
function betaUpdate(beta, success) {
    const decay = 0.98;
    return {
        a: beta.a * decay + (success ? 1 : 0),
        b: beta.b * decay + (success ? 0 : 1)
    };
}
function getBayesTrendLabel(trendRegime) {
    if (trendRegime.trending) return 'trending';
    if (trendRegime.meanReverting) return 'meanReverting';
    return 'neutral';
}

function computeDirectionalPrior(direction, windowSize = 5) {
    const graded = bayesianState.records.filter(
        r => r.predictedDirection === direction && r.correct !== null
    );
    if (graded.length < 2) return { adjustment: 0, confidence: 0, n: 0 };
    const recent = graded.slice(-windowSize);
    const successes = recent.filter(r => r.correct).length;
    const a = 1 + successes, b = 1 + recent.length - successes;
    const adjustment = a / (a + b) - 0.5;
    const confidence = Math.min(0.7, 0.2 * Math.sqrt(recent.length));
    return { adjustment, confidence, n: recent.length };
}

function computeRegimeAdjustment(volRegimeLabel, trendRegimeLabel) {
    const timeBucket = getTimeBucket();
    const volBeta = bayesianState.regimeBeta[volRegimeLabel] || { a: 1, b: 1 };
    const trendBeta = bayesianState.trendBeta[trendRegimeLabel] || { a: 1, b: 1 };
    const timeBeta = bayesianState.timeBeta[timeBucket] || { a: 1, b: 1 };
    const volN = betaN(volBeta), trendN = betaN(trendBeta), timeN = betaN(timeBeta);
    const volWeight = Math.min(0.4, volN * 0.05);
    const trendWeight = Math.min(0.4, trendN * 0.05);
    const timeWeight = Math.min(0.2, timeN * 0.03);
    const totalWeight = volWeight + trendWeight + timeWeight;
    if (totalWeight < 0.05) return { multiplier: 1.0 };
    const weightedAccuracy = (
        betaMean(volBeta) * volWeight + betaMean(trendBeta) * trendWeight + betaMean(timeBeta) * timeWeight
    ) / totalWeight;
    return { multiplier: Math.max(0.5, Math.min(1.5, 0.5 + weightedAccuracy)) };
}

function computeCalibrationAdjustment(rawProb) {
    const bin = getCalibrationBin(rawProb);
    const beta = bayesianState.calibrationBins[bin];
    if (!beta) return { calibratedProb: rawProb, adjustment: 0 };
    const n = betaN(beta);
    if (n < 3) return { calibratedProb: rawProb, adjustment: 0, n };
    const empiricalAccuracy = betaMean(beta);
    const calibratedProb = rawProb < 0.5 ? (1 - empiricalAccuracy) : empiricalAccuracy;
    const blendWeight = Math.min(0.7, 0.1 * Math.sqrt(n));
    const blendedProb = rawProb * (1 - blendWeight) + calibratedProb * blendWeight;
    return { calibratedProb: blendedProb, adjustment: blendedProb - rawProb, n };
}

function detectPredictionStreak() {
    const graded = bayesianState.records.filter(r => r.actualDirection !== null);
    if (graded.length < 2) return { streakDirection: null, streakLength: 0, adjustment: 0 };
    let streakDir = graded[graded.length - 1].actualDirection;
    let streakLen = 1;
    for (let i = graded.length - 2; i >= 0; i--) {
        if (graded[i].actualDirection === streakDir) streakLen++;
        else break;
    }
    if (streakLen < 2) return { streakDirection: streakDir, streakLength: streakLen, adjustment: 0 };
    const streakRecords = graded.slice(-streakLen);
    const modelAccuracy = streakRecords.filter(r => r.correct).length / streakLen;
    const missedTrendFactor = Math.max(0, 1 - modelAccuracy * 1.2);
    const baseAdjustment = 0.04 * Math.log2(streakLen);
    const sign = streakDir === 'up' ? 1 : -1;
    return { streakDirection: streakDir, streakLength: streakLen,
             adjustment: sign * baseAdjustment * (0.3 + 0.7 * missedTrendFactor) };
}

function recordBayesianPrediction(periodKey, startPrice, predictedPrice, rawProb, volRegimeLabel, trendRegimeLabel) {
    if (bayesianState.records.length > 0 &&
        bayesianState.records[bayesianState.records.length - 1].periodKey === periodKey) return;
    bayesianState.records.push({
        periodKey, startPrice, predictedPrice,
        predictedDirection: predictedPrice >= startPrice ? 'up' : 'down',
        rawProbability: rawProb,
        volRegime: volRegimeLabel, trendRegime: trendRegimeLabel,
        timeBucket: getTimeBucket(), calibrationBin: getCalibrationBin(rawProb),
        timestamp: Date.now(), actualPrice: null, actualDirection: null, correct: null
    });
    saveBayesianState();
}

function gradeBayesianPrediction(currentPrice) {
    let updated = false;
    for (let i = bayesianState.records.length - 1; i >= 0; i--) {
        const rec = bayesianState.records[i];
        if (rec.actualPrice !== null) continue;
        if (rec.periodKey === currentPeriodKey) continue;
        rec.actualPrice = currentPrice;
        rec.actualDirection = currentPrice >= rec.startPrice ? 'up' : 'down';
        rec.correct = rec.predictedDirection === rec.actualDirection;
        updated = true;
        const success = rec.correct;
        bayesianState.directionBeta[rec.predictedDirection] = betaUpdate(
            bayesianState.directionBeta[rec.predictedDirection], success);
        if (rec.volRegime && bayesianState.regimeBeta[rec.volRegime])
            bayesianState.regimeBeta[rec.volRegime] = betaUpdate(bayesianState.regimeBeta[rec.volRegime], success);
        if (rec.trendRegime && bayesianState.trendBeta[rec.trendRegime])
            bayesianState.trendBeta[rec.trendRegime] = betaUpdate(bayesianState.trendBeta[rec.trendRegime], success);
        if (rec.timeBucket !== undefined && bayesianState.timeBeta[rec.timeBucket])
            bayesianState.timeBeta[rec.timeBucket] = betaUpdate(bayesianState.timeBeta[rec.timeBucket], success);
        if (rec.calibrationBin !== undefined && bayesianState.calibrationBins[rec.calibrationBin])
            bayesianState.calibrationBins[rec.calibrationBin] = betaUpdate(bayesianState.calibrationBins[rec.calibrationBin], success);
    }
    if (updated) saveBayesianState();
}

function bayesianAdjust(rawProb, volRegimeLabel, trendRegimeLabel) {
    const predictedDirection = rawProb >= 0.5 ? 'up' : 'down';
    const dirPrior = computeDirectionalPrior(predictedDirection);
    const regimeAdj = computeRegimeAdjustment(volRegimeLabel, trendRegimeLabel);
    const calibration = computeCalibrationAdjustment(rawProb);
    const streak = detectPredictionStreak();
    let adjustedProb = calibration.calibratedProb;
    adjustedProb += dirPrior.adjustment * dirPrior.confidence * 0.15;
    adjustedProb += streak.adjustment;
    const deviation = adjustedProb - 0.5;
    adjustedProb = 0.5 + deviation * regimeAdj.multiplier;
    adjustedProb = Math.max(0.05, Math.min(0.95, adjustedProb));
    return { adjustedProb, rawProb };
}

function recordPrediction(periodKey, startPrice, predictedPrice, targetTimeStr) {
    if (predictionLog.length && predictionLog[predictionLog.length - 1].periodKey === periodKey) return;
    predictionLog.push({
        time: targetTimeStr,
        periodKey,
        startPrice,
        predictedPrice,
        predictedDirection: predictedPrice >= startPrice ? 'up' : 'down',
        actualPrice: null,
        actualDirection: null,
        correct: null
    });
    savePredictionLog();
}

function gradePreviousPrediction(currentPrice) {
    for (let i = predictionLog.length - 1; i >= 0; i--) {
        if (predictionLog[i].actualPrice === null && predictionLog[i].periodKey !== currentPeriodKey) {
            predictionLog[i].actualPrice = currentPrice;
            predictionLog[i].actualDirection = currentPrice >= predictionLog[i].startPrice ? 'up' : 'down';
            predictionLog[i].correct = predictionLog[i].predictedDirection === predictionLog[i].actualDirection;
        }
    }
    savePredictionLog();
}


// ═══════════════════════════════════════════════════════════════
// PREDICTION ENGINE — All functions from client moved here
// ═══════════════════════════════════════════════════════════════

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

function computeEWMAVol(prices, lambda = 0.97) {
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


// ── Order Flow & Microstructure ──

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

function computeVPIN(trades, numBuckets = 20) {
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


// ── Technical Indicators ──

function computeEMA(prices, period) {
    if (!prices || prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function computeRSI(prices, period = 14) {
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
    if (prevBody < 0 && lastBody > 0 && Math.abs(lastBody) > Math.abs(prevBody) * 1.2) {
        return { signal: 0.6, pattern: 'Bullish' };
    }
    if (prevBody > 0 && lastBody < 0 && Math.abs(lastBody) > Math.abs(prevBody) * 1.2) {
        return { signal: -0.6, pattern: 'Bearish' };
    }
    const lastRange = (last.high || last.price) - (last.low || last.price);
    if (lastRange > 0) {
        const lowerWick = Math.min(last.open, last.price) - (last.low || last.price);
        const upperWick = (last.high || last.price) - Math.max(last.open, last.price);
        const bodySize = Math.abs(lastBody);
        if (lowerWick > bodySize * 2 && lowerWick > upperWick * 2) {
            return { signal: 0.4, pattern: 'Bullish' };
        }
        if (upperWick > bodySize * 2 && upperWick > lowerWick * 2) {
            return { signal: -0.4, pattern: 'Bearish' };
        }
    }
    if (n >= 3) {
        const b1 = history[n-3].price - history[n-3].open;
        if (b1 > 0 && prevBody > 0 && lastBody > 0) return { signal: 0.3, pattern: 'Bullish' };
        if (b1 < 0 && prevBody < 0 && lastBody < 0) return { signal: -0.3, pattern: 'Bearish' };
    }
    return { signal: 0, pattern: 'Neutral' };
}

function computeBollingerSqueeze(prices, period = 20) {
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
            highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
            srLevels.push(highs[i]);
        }
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] &&
            lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
            srLevels.push(lows[i]);
        }
    }
    const tolerance = strike * 0.0005;
    const nearSR = srLevels.some(level => Math.abs(level - strike) < tolerance);
    const current = prices[prices.length - 1];
    if (nearSR) {
        return current > strike ? 0.15 : -0.15;
    }
    return 0;
}

function getRegimeMultipliers(trendRegime, volRegime, ac1) {
    const m = { momentum: 1.0, flow: 1.0, reversion: 1.0, pattern: 1.0, volume: 1.0 };
    if (ac1 > 0.15 || trendRegime.trending) {
        m.momentum = 1.4; m.flow = 1.3; m.reversion = 0.3; m.pattern = 0.8;
    }
    else if (ac1 < -0.15 || trendRegime.meanReverting) {
        m.momentum = 0.5; m.flow = 0.8; m.reversion = 1.8; m.pattern = 1.2;
    }
    if (volRegime.regime === 'volatile' || volRegime.regime === 'expanding') {
        m.flow *= 1.3; m.volume *= 1.5; m.momentum *= 0.8;
    }
    else if (volRegime.regime === 'quiet') {
        m.flow *= 0.6; m.momentum *= 1.2;
    }
    return m;
}

function timePolarize(prob, minutesAhead, totalMinutes = 15, maxExponent = 3.0) {
    const timeProgress = 1 - Math.max(0, Math.min(1, minutesAhead / totalMinutes));
    const exponent = 1 + (maxExponent - 1) * timeProgress * timeProgress;
    const d = 2 * prob - 1;
    const sign = d >= 0 ? 1 : -1;
    const polarizedD = sign * Math.pow(Math.abs(d), 1 / exponent);
    return 0.5 + 0.5 * polarizedD;
}

function ensembleConfidence(zScore, totalZShift, positionalWeight, positionalProb, minutesAhead, normCDFfn, nIter = 30) {
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
        const dap = normCDFfn(pZ + pShift * (1 - positionalWeight) * 3);
        const lo = toLogOddsE(pPosPr) * positionalWeight + toLogOddsE(dap) * (1 - positionalWeight);
        let p = fromLogOddsE(lo);
        p = timePolarize(p, minutesAhead);
        p = 0.03 + 0.94 / (1 + Math.exp(-10 * (p - 0.5)));
        samples.push(p);
    }
    const mean = samples.reduce((s, v) => s + v, 0) / nIter;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (nIter - 1);
    const stddev = Math.sqrt(variance);
    return {
        stddev,
        level: stddev < 0.02 ? 'high' : stddev < 0.05 ? 'moderate' : 'low'
    };
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
        detected: changePoints.length > 0,
        recentShift: recentCPs.length > 0,
        signal: Math.max(-1, Math.min(1, signal)),
        currentRegimeLength: returns.length - lastChangeIdx
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
    if (dominantPct > 0.80) return 1.30;
    if (dominantPct > 0.65) return 1.10;
    if (dominantPct < 0.50) return 0.60;
    if (dominantPct < 0.60) return 0.80;
    return 1.0;
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
    for (let i = 1; i < prices.length; i++) {
        returns.push(prices[i] / prices[i-1] - 1);
    }
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

function computeBayesianPrior() {
    const graded = predictionLog.filter(p => p.actualDirection !== null);
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
// MAIN PREDICTION FUNCTION
// ═══════════════════════════════════════════════════════════════

function predictPrice(data, minutesAhead) {
    const history = data.history;
    const prices = history.map(h => h.price);
    const current = data.currentPrice;
    const n = prices.length;
    const strike = state.kalshiStrike || periodStartPrice || current;

    // SIGNAL 1: POSITIONAL Z-SCORE
    const volWindow = Math.round(8 + 52 * (minutesAhead / 15));
    const adaptiveWindow = Math.max(2, Math.min(volWindow, n - 1));

    const ccVol = computeRealizedVol(prices, adaptiveWindow);
    const ewmaVol = computeEWMAVol(prices, 0.97);
    const gkVol = computeGarmanKlassVol(history, adaptiveWindow);
    const rawPerMinVol = 0.25 * ccVol + 0.40 * ewmaVol + 0.35 * gkVol;

    const shortVol = computeRealizedVol(prices, Math.min(8, n - 1));
    const longVol = computeRealizedVol(prices, Math.min(60, n - 1));
    const volBlendRatio = minutesAhead / 15;
    const blendedVol = longVol * volBlendRatio + shortVol * (1 - volBlendRatio);
    const perMinuteVol = Math.max(rawPerMinVol, blendedVol * 0.8);

    const { remainingVol: rawRemainingVol, H } = computeAdjustedRemainingVol(
        perMinuteVol, minutesAhead, prices);
    const todMult = getIntradayVolMultiplier();
    const remainingVol = rawRemainingVol * (0.70 + 0.30 * todMult);

    const zScore = remainingVol > 0 ? Math.log(current / strike) / remainingVol : 0;
    const positionalProb = normCDF(zScore);

    // SIGNAL 2: MOMENTUM / DRIFT
    const mom3 = n > 3 ? (prices[n-1] - prices[n-4]) / prices[n-4] : 0;
    const mom5 = n > 5 ? (prices[n-1] - prices[n-6]) / prices[n-6] : 0;
    const mom10 = n > 10 ? (prices[n-1] - prices[n-11]) / prices[n-11] : 0;
    const vwMom5 = computeVolumeWeightedMomentum(history, 5);
    const ema5 = computeEMA(prices, 5);
    const ema20 = computeEMA(prices, 20);
    const emaTrend = (ema5 - ema20) / current;
    const recentMom = n > 3 ? (prices[n-1] - prices[n-4]) / prices[n-4] : 0;
    const priorMom = n > 6 ? (prices[n-4] - prices[n-7]) / prices[n-7] : 0;
    const momAccel = recentMom - priorMom;
    const rawDrift = mom3 * 0.35 + mom5 * 0.25 + vwMom5 * 0.20 + mom10 * 0.10 + emaTrend * 0.10;

    // SIGNAL 3: REGIME DETECTION
    const volRegime = detectVolRegime(prices);
    const trendRegime = detectTrendRegime(prices, n);
    const ac1 = computeAutocorrelation(prices, 1);

    let driftMultiplier = 1.0;
    if (ac1 < -0.15) driftMultiplier = -0.3;
    else if (ac1 > 0.15) driftMultiplier = 1.5;
    else if (trendRegime.meanReverting) driftMultiplier = 0.3;
    else if (trendRegime.trending) driftMultiplier = 1.3;

    const minutesIntoPeriod = 15 - minutesAhead;
    let earlyMomentumSignal = 0;
    if (minutesIntoPeriod <= 3 && periodStartPrice && periodStartPrice > 0) {
        const openingMove = (current - periodStartPrice) / periodStartPrice;
        const openingMoveZ = perMinuteVol > 0
            ? openingMove / (perMinuteVol * Math.sqrt(minutesIntoPeriod + 0.5)) : 0;
        const earlyConf = Math.min(1.0, minutesIntoPeriod / 2.5);
        if (Math.abs(openingMoveZ) > 0.5) {
            earlyMomentumSignal = Math.sign(openingMoveZ) *
                Math.min(Math.abs(openingMoveZ) * 0.15, 0.4) * earlyConf;
        }
    }

    // SIGNAL 4: ORDER FLOW & MICROSTRUCTURE
    let orderFlowSignal = 0;
    let spreadVolAdjust = 1.0;
    if (state.orderBook) {
        const pressure = computeOrderBookPressureGradient(state.orderBook);
        const obDelta = computeOrderBookDelta(pressure.imbalance);
        const spread = computeSpreadAnalysis(state.orderBook);
        spreadVolAdjust = spread.volAdjustment;
        orderFlowSignal = pressure.imbalance * 0.30 + pressure.gradient * 2.0 * 0.15 +
                          obDelta.signal * 0.25 + spread.signal * 0.10;
    }

    let tradeFlowSignal = 0;
    let vpinVolAdjust = 1.0;
    if (state.recentTrades && state.recentTrades.length) {
        const trades = state.recentTrades;
        const clustering = computeTradeSizeClustering(trades);
        const rawFlow = computeTradeFlowImbalance(trades);
        const cvd = computeCVD(trades);
        const vpin = computeVPIN(trades);
        tradeFlowSignal = clustering.signal * 0.35 + rawFlow * 0.25 +
                          cvd.signal * 0.25 + vpin.signal * 0.15;
        if (vpin.vpin > 0.4) vpinVolAdjust = 1.0 + (vpin.vpin - 0.4) * 0.5;
    }

    const microVolAdjust = spreadVolAdjust * vpinVolAdjust;
    const adjustedRemainingVol = remainingVol * microVolAdjust;

    const driftWithEarlyBias = minutesIntoPeriod <= 3
        ? rawDrift * 0.6 + earlyMomentumSignal * 0.4 : rawDrift;
    const adjustedDrift = driftWithEarlyBias * driftMultiplier;
    const driftZShift = adjustedRemainingVol > 0 ? adjustedDrift / adjustedRemainingVol : 0;

    // SIGNAL 5: RSI
    const rsi = computeRSI(prices);
    let rsiSignal = 0;
    if (rsi > 80) rsiSignal = -0.4;
    else if (rsi > 70) rsiSignal = -0.2;
    else if (rsi < 20) rsiSignal = 0.4;
    else if (rsi < 30) rsiSignal = 0.2;

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
    if (state.fundingRate && Math.abs(state.fundingRate) > 0.0005) {
        fundingSignal = -Math.sign(state.fundingRate) * 0.15;
    }

    // COMBINE ALL SIGNALS
    const timeProgress = Math.max(0, Math.min(1, 1 - (minutesAhead / 15)));
    const sigK = 6, sigMid = 0.5;
    const sigRaw = 1 / (1 + Math.exp(-sigK * (timeProgress - sigMid)));
    const sigMin = 1 / (1 + Math.exp(sigK * sigMid));
    const sigMax = 1 / (1 + Math.exp(-sigK * sigMid));
    const positionalWeight = 0.35 + ((sigRaw - sigMin) / (sigMax - sigMin)) * 0.62;

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
    const microMR = detectMicroMeanReversion(prices, state.orderBook);
    const microMRSignal = microMR.signal;
    const breakoutResult = detectBreakout(prices, history);
    const breakoutSignal = breakoutResult.signal;
    const changePoint = detectChangePoints(prices);
    const cpSignal = changePoint.signal;
    const hurstH = computeHurstExponent(prices.slice(-Math.min(n, 90)));

    const earlyBoost = Math.max(0, 1 - timeProgress * 2);
    const urgencyFade = minutesAhead < 3 ? Math.max(0, (minutesAhead - 1) / 2) : 1.0;
    const immediateBoosted = minutesAhead < 3 ? 1 + (3 - minutesAhead) * 0.3 : 1.0;

    const allSignals = [
        { value: driftZShift, weight: 0.20 },
        { value: orderFlowSignal, weight: 0.10 },
        { value: tradeFlowSignal, weight: 0.08 },
        { value: vwapSignal, weight: 0.06 },
        { value: macdSignal, weight: 0.05 },
        { value: linRegSignal, weight: 0.05 },
        { value: bbSqueeze.breakoutSignal, weight: 0.04 },
        { value: haResult.signal, weight: 0.04 },
        { value: crossTF.signal, weight: 0.04 },
        { value: rsiSignal, weight: 0.04 },
        { value: candlePattern.signal, weight: 0.04 },
        { value: microMRSignal, weight: 0.08 },
        { value: breakoutSignal, weight: 0.06 },
        { value: cpSignal, weight: 0.04 }
    ];
    const agreementMult = computeAgreementMultiplier(allSignals);

    const effectiveAC1 = (hurstH - 0.5) * 2;
    const blendedAC1 = ac1 * 0.5 + effectiveAC1 * 0.5;
    const regM = getRegimeMultipliers(trendRegime, volRegime, blendedAC1);

    const rawTotalZShift = (
        driftZShift          * (0.22 + earlyBoost * 0.08) * immediateBoosted * regM.momentum +
        orderFlowSignal      * (0.12 + earlyBoost * 0.06) * immediateBoosted * regM.flow +
        tradeFlowSignal      * (0.09 + earlyBoost * 0.04) * immediateBoosted * regM.flow +
        rsiSignal            * (0.04 - earlyBoost * 0.02) * urgencyFade * regM.reversion +
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
        microMRSignal        * 0.08 * regM.reversion +
        breakoutSignal       * 0.06 * regM.momentum +
        cpSignal             * 0.04 * immediateBoosted
    );

    const totalZShift = rawTotalZShift * agreementMult;

    function toLogOdds(p) { return Math.log(Math.max(p, 0.001) / Math.max(1 - p, 0.001)); }
    function fromLogOdds(lo) { return 1 / (1 + Math.exp(-lo)); }

    const driftAdjustedProb = normCDF(zScore + totalZShift * (1 - positionalWeight) * 3);
    const posLO = toLogOdds(positionalProb) * positionalWeight;
    const driftLO = toLogOdds(driftAdjustedProb) * (1 - positionalWeight);
    const combinedProb = fromLogOdds(posLO + driftLO);
    const polarizedProb = timePolarize(combinedProb, minutesAhead);
    const clampedProb = 0.03 + 0.94 / (1 + Math.exp(-10 * (polarizedProb - 0.5)));

    const ensConf = ensembleConfidence(zScore, totalZShift, positionalWeight, positionalProb, minutesAhead, normCDF);

    const bayesResult = bayesianAdjust(clampedProb, volRegime.regime, getBayesTrendLabel(trendRegime));
    let finalProb = bayesResult.adjustedProb;

    const isNearStrike = Math.abs(zScore) < 1.0;
    if (isNearStrike && minutesAhead < 3) {
        const gammaRisk = 1 + (1 - Math.abs(zScore)) * (3 - minutesAhead) * 0.15;
        finalProb = 0.5 + (finalProb - 0.5) / gammaRisk;
    }

    // CONSTRUCT OUTPUT
    const predictUp = finalProb > 0.5;
    const confidenceDistance = Math.abs(finalProb - 0.5) * 2;
    const priceOffset = adjustedRemainingVol * current * confidenceDistance * 0.5;
    const predictedPrice = predictUp
        ? strike + Math.max(priceOffset, 0.01)
        : strike - Math.max(priceOffset, 0.01);
    const changePercent = ((predictedPrice - current) / current) * 100;

    const sigmoidInput = (confidenceDistance - 0.35) * 8;
    const sigmoidVal = 1 / (1 + Math.exp(-sigmoidInput));
    const confidence = Math.max(0.20, Math.min(0.96, 0.40 + sigmoidVal * 0.56));

    const trendLabel = ema5 > ema20 ? 'Bullish' : ema5 < ema20 ? 'Bearish' : 'Neutral';
    const momentumLabel = mom5 > 0.001 ? 'Bullish' : mom5 < -0.001 ? 'Bearish' : 'Neutral';
    const rsiLabel = rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral';
    const volLabel = volRegime.regime === 'volatile' ? 'High'
        : volRegime.regime === 'quiet' ? 'Low' : 'Medium';

    console.log(`Predict: P(up)=${(finalProb*100).toFixed(1)}% z=${zScore.toFixed(2)} drift=${totalZShift.toFixed(3)} regime=${volRegime.regime} => ${predictUp?'UP':'DOWN'}`);

    return {
        predictedPrice,
        changePercent,
        confidence,
        probability: finalProb,
        _remainingVol: remainingVol,
        ensembleConfidence: ensConf,
        signals: {
            momentum: momentumLabel,
            volatility: volLabel,
            trend: trendLabel,
            rsi: rsiLabel
        },
        _regimeInfo: { volRegime: volRegime.regime, trendRegime: getBayesTrendLabel(trendRegime) }
    };
}


// ═══════════════════════════════════════════════════════════════
// RISK & SELL SIGNAL ASSESSMENT
// ═══════════════════════════════════════════════════════════════

function assessRisk(prediction, strike, currentPrice) {
    if (!prediction || strike === null) return null;
    const reasons = [];
    let riskScore = 0;
    const margin = Math.abs(prediction.predictedPrice - strike);
    const marginPct = (margin / strike) * 100;
    if (marginPct < 0.01) { riskScore += 45; reasons.push('Razor-thin margin to strike'); }
    else if (marginPct < 0.03) { riskScore += 30; reasons.push('Very close to strike'); }
    else if (marginPct < 0.06) { riskScore += 15; reasons.push('Near strike'); }
    const conf = prediction.confidence || 0.5;
    if (conf < 0.55) { riskScore += 25; reasons.push('Low confidence'); }
    else if (conf < 0.65) { riskScore += 12; reasons.push('Moderate confidence'); }
    if (prediction.signals) {
        const isUp = prediction.predictedPrice >= strike;
        const sigs = prediction.signals;
        let agree = 0, disagree = 0;
        if (sigs.trend === 'Bullish') isUp ? agree++ : disagree++;
        else if (sigs.trend === 'Bearish') isUp ? disagree++ : agree++;
        if (sigs.momentum === 'Bullish') isUp ? agree++ : disagree++;
        else if (sigs.momentum === 'Bearish') isUp ? disagree++ : agree++;
        if (sigs.rsi === 'Overbought') isUp ? disagree++ : agree++;
        else if (sigs.rsi === 'Oversold') isUp ? agree++ : disagree++;
        if (disagree >= 2) { riskScore += 20; reasons.push('Conflicting signals'); }
        else if (disagree >= 1 && agree <= 1) { riskScore += 10; reasons.push('Mixed signals'); }
        if (sigs.volatility === 'High') { riskScore += 15; reasons.push('High volatility'); }
    }
    const predictedUp = prediction.predictedPrice >= strike;
    const currentUp = currentPrice >= strike;
    if (predictedUp !== currentUp) { riskScore += 10; reasons.push('Price moving against prediction'); }
    riskScore = Math.min(100, riskScore);
    let level;
    if (riskScore >= 50) level = 'risky';
    else if (riskScore >= 25) level = 'moderate';
    else level = 'safe';
    if (reasons.length === 0) reasons.push('Strong margin from strike');
    return { level, score: riskScore, reasons };
}

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

    if (onWrongSide) {
        const side = betIsUp ? 'below' : 'above';
        if (distancePct > 0.15) { urgency += 40; reasons.push('Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + side + ' strike (' + distancePct.toFixed(3) + '% away)'); }
        else if (distancePct > 0.08) { urgency += 30; reasons.push('Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + side + ' strike'); }
        else if (distancePct > 0.03) { urgency += 18; reasons.push('Price drifting ' + side + ' strike by $' + Math.abs(distanceFromStrike).toFixed(2)); }
        else { urgency += 8; reasons.push('Price barely ' + side + ' strike ($' + Math.abs(distanceFromStrike).toFixed(2) + ')'); }
    }
    if (probForBet < 0.08) { urgency += 45; reasons.push('Win probability collapsed to ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probForBet < 0.15) { urgency += 35; reasons.push('Win probability critical: ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probForBet < 0.25) { urgency += 22; reasons.push('Win probability weak: ' + (probForBet * 100).toFixed(0) + '%'); }
    else if (probForBet < 0.35) { urgency += 12; reasons.push('Win probability softening: ' + (probForBet * 100).toFixed(0) + '%'); }

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
    if (onWrongSide || probForBet < 0.35) {
        if (minutesRemaining < 1) { urgency += 30; reasons.push('Under 60 seconds \u2014 no time to recover'); }
        else if (minutesRemaining < 2) { urgency += 22; reasons.push('Under 2 min left \u2014 recovery unlikely'); }
        else if (minutesRemaining < 3.5) { urgency += 15; reasons.push('Under 3.5 min \u2014 time running out'); }
        else if (minutesRemaining < 5) { urgency += 8; reasons.push('Under 5 min remaining'); }
    }
    if (modelFlipped) { urgency += 18; reasons.push('Model now predicts ' + updDirection + ' (was ' + origDirection + ')'); }
    const confDrop = origPred.confidence - updPred.confidence;
    if (confDrop > 0.35) { urgency += 15; reasons.push('Confidence crashed: ' + (origPred.confidence * 100).toFixed(0) + '% \u2192 ' + (updPred.confidence * 100).toFixed(0) + '%'); }
    else if (confDrop > 0.20) { urgency += 8; reasons.push('Confidence dropped: ' + (origPred.confidence * 100).toFixed(0) + '% \u2192 ' + (updPred.confidence * 100).toFixed(0) + '%'); }
    const probDrop = origProbForBet - probForBet;
    if (probDrop > 0.30) { urgency += 12; reasons.push('Win prob fell from ' + (origProbForBet * 100).toFixed(0) + '% to ' + (probForBet * 100).toFixed(0) + '%'); }
    urgency = Math.min(100, Math.max(0, urgency));

    let level, shortLabel, advice;
    const isDeepWrongSide = onWrongSide && distancePct > 0.08;
    const noTimeLeft = minutesRemaining < 1.5;
    if (urgency >= 75 || (probForBet < 0.08 && minutesRemaining < 2.5) || (isDeepWrongSide && noTimeLeft)) {
        level = 'lost_cause'; shortLabel = 'LOST CAUSE';
        if (modelFlipped) advice = 'Both original (' + origDirection + ') and updated (' + updDirection + ') predictions have failed. Sell immediately to cut losses.';
        else if (onWrongSide && noTimeLeft) advice = 'Original ' + origDirection + ' prediction wrong \u2014 price stuck on wrong side with no time to recover. Sell now.';
        else advice = 'Original ' + origDirection + ' prediction has failed. Market moved against you. Sell to minimize loss.';
    } else if (urgency >= 55 || probForBet < 0.18 || (probForBet < 0.28 && minutesRemaining < 3)) {
        level = 'sell_now'; shortLabel = 'SELL NOW';
        if (modelFlipped) advice = 'Updated model flipped to ' + updDirection + '. Original ' + origDirection + ' prediction losing ground \u2014 sell before it worsens.';
        else if (onWrongSide) advice = 'Price on wrong side of strike. Sell to lock in remaining value before further decay.';
        else advice = 'Win probability too low to justify holding. Sell to recover what you can.';
    } else if (urgency >= 30 || (probForBet < 0.35 && minutesRemaining < 5)) {
        level = 'consider_selling'; shortLabel = 'CONSIDER SELLING';
        if (onWrongSide) advice = 'Price slipped ' + (betIsUp ? 'below' : 'above') + ' strike. May recover, but risk is elevated.';
        else advice = 'Position weakening \u2014 watch closely. Sell if probability drops further.';
    } else if (onRightSide && probForBet >= 0.55) {
        level = 'winning'; shortLabel = 'WINNING';
        const rightSide = betIsUp ? 'above' : 'below';
        advice = 'Price $' + Math.abs(distanceFromStrike).toFixed(2) + ' ' + rightSide + ' strike. ' +
            (minutesRemaining < 3 ? 'Almost there \u2014 hold to close!' : 'Looking good \u2014 hold position.');
    } else {
        level = 'hold'; shortLabel = 'HOLD';
        advice = probForBet >= 0.50
            ? 'Position favored (' + (probForBet * 100).toFixed(0) + '% win prob). Hold.'
            : 'Close call (' + (probForBet * 100).toFixed(0) + '% win prob). Monitor closely.';
    }

    return {
        level, urgency, reasons: reasons.length > 0 ? reasons : ['Position steady'],
        shortLabel, probForBet, origProbForBet, advice, betDirection,
        modelFlipped, onWrongSide, distancePct, distanceFromStrike
    };
}


// ═══════════════════════════════════════════════════════════════
// PERIOD MANAGEMENT & PREDICTION CYCLE
// ═══════════════════════════════════════════════════════════════

function enterTransitionState() {
    isTransitioning = true;
    transitionRetries = 0;
    lastKalshiTicker = state.kalshiTicker;

    const completedPeriodKey = currentPeriodKey;
    currentPeriodKey = getPeriodKey();

    // Grade the outgoing prediction
    if (completedPeriodKey !== null && state.brtiPrice) {
        gradePreviousPrediction(state.brtiPrice);
        gradeBayesianPrediction(state.brtiPrice);
    }

    originalPrediction = null;
    updatedPrediction = null;
    smoothedProbability = null;
    lockedDirection = null;
    periodStartPrice = null;
    currentSellSignal = null;
    currentRiskAssessment = null;
    nextPeriodPreview = null;
    strikeIsPending = false;
    saveSessionState();
}

function computeNextPeriodPreview(data) {
    if (!data.currentPrice) return null;
    const currentPrice = data.currentPrice;
    const pseudoStrike = currentPrice;

    // Temporarily override state for prediction
    const savedStrike = state.kalshiStrike;
    const savedPeriodStart = periodStartPrice;
    state.kalshiStrike = pseudoStrike;
    periodStartPrice = pseudoStrike;

    try {
        const prediction = predictPrice(data, 15);
        state.kalshiStrike = savedStrike;
        periodStartPrice = savedPeriodStart;

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
    } catch (e) {
        state.kalshiStrike = savedStrike;
        periodStartPrice = savedPeriodStart;
        return null;
    }
}

function runPredictionCycle() {
    if (!state.brtiPrice || !state.history.length) return;

    const data = {
        currentPrice: state.brtiPrice,
        history: state.history
    };

    const periodEnd = getPeriodEndTime();
    const periodKey = getPeriodKey();
    const minutesAhead = Math.max(1, getSecondsUntilTarget(periodEnd) / 60);
    const secsLeft = getSecondsUntilTarget(periodEnd);

    // Check for period transition
    if (secsLeft <= 0 && !isTransitioning) {
        enterTransitionState();
        return;
    }

    if (isTransitioning) {
        transitionRetries++;
        // Validate the Kalshi market is for the CURRENT period
        let marketIsForCurrentPeriod = false;
        if (state.kalshiCloseTime) {
            const closeMs = new Date(state.kalshiCloseTime).getTime();
            const periodEndMs = periodEnd.getTime();
            marketIsForCurrentPeriod = Math.abs(closeMs - periodEndMs) < 2 * 60 * 1000;
        }

        if (marketIsForCurrentPeriod && state.kalshiStrike) {
            isTransitioning = false;
            currentPeriodKey = periodKey;
            periodStartPrice = state.kalshiStrike;
            strikeIsPending = false;
            smoothedProbability = null;
            lockedDirection = null;
            originalPrediction = predictPrice(data, minutesAhead);
            updatedPrediction = null;
            recordPrediction(periodKey, periodStartPrice, originalPrediction.predictedPrice, formatTargetTime(periodEnd));
            if (originalPrediction._regimeInfo) recordBayesianPrediction(periodKey, periodStartPrice, originalPrediction.predictedPrice, originalPrediction.probability, originalPrediction._regimeInfo.volRegime, originalPrediction._regimeInfo.trendRegime);
            currentRiskAssessment = assessRisk(originalPrediction, state.kalshiStrike, data.currentPrice);
            dataSourceName = 'BRTI~(' + state.brtiSources + ') + Kalshi strike';
            saveSessionState();
            console.log('New period started:', periodKey, 'strike:', periodStartPrice);
        } else if (transitionRetries >= 40) {
            console.warn('Transition timeout: no Kalshi market found after 40 retries');
        }
        return;
    }

    // Normal operation
    if (periodKey !== currentPeriodKey) {
        // New period detected
        if (currentPeriodKey !== null) {
            gradePreviousPrediction(data.currentPrice);
            gradeBayesianPrediction(data.currentPrice);
        }
        currentPeriodKey = periodKey;

        if (state.kalshiStrike) {
            periodStartPrice = state.kalshiStrike;
            strikeIsPending = false;
            originalPrediction = predictPrice(data, minutesAhead);
            updatedPrediction = null;
            recordPrediction(periodKey, periodStartPrice, originalPrediction.predictedPrice, formatTargetTime(periodEnd));
            if (originalPrediction._regimeInfo) recordBayesianPrediction(periodKey, periodStartPrice, originalPrediction.predictedPrice, originalPrediction.probability, originalPrediction._regimeInfo.volRegime, originalPrediction._regimeInfo.trendRegime);
            currentRiskAssessment = assessRisk(originalPrediction, state.kalshiStrike, data.currentPrice);
            dataSourceName = 'BRTI~(' + state.brtiSources + ') + Kalshi strike';
        } else {
            periodStartPrice = null;
            originalPrediction = null;
            strikeIsPending = true;
        }
        saveSessionState();
    } else if (!originalPrediction) {
        // Same period, no prediction yet — try if Kalshi arrived
        if (state.kalshiStrike) {
            periodStartPrice = state.kalshiStrike;
            strikeIsPending = false;
            originalPrediction = predictPrice(data, minutesAhead);
            updatedPrediction = null;
            recordPrediction(periodKey, periodStartPrice, originalPrediction.predictedPrice, formatTargetTime(periodEnd));
            if (originalPrediction._regimeInfo) recordBayesianPrediction(periodKey, periodStartPrice, originalPrediction.predictedPrice, originalPrediction.probability, originalPrediction._regimeInfo.volRegime, originalPrediction._regimeInfo.trendRegime);
            currentRiskAssessment = assessRisk(originalPrediction, state.kalshiStrike, data.currentPrice);
            saveSessionState();
        }
    } else {
        // Same period, update prediction
        const rawUpdated = predictPrice(data, minutesAhead);
        const strike = state.kalshiStrike || periodStartPrice;

        if (lockedDirection === null && originalPrediction) {
            lockedDirection = originalPrediction.predictedPrice >= strike ? 'up' : 'down';
        }

        const alpha = minutesAhead <= 3 ? 0.20 : 0.35;
        if (smoothedProbability === null) smoothedProbability = rawUpdated.probability;
        else smoothedProbability = alpha * rawUpdated.probability + (1 - alpha) * smoothedProbability;

        const flipThreshold = minutesAhead <= 2 ? 0.35 : minutesAhead <= 5 ? 0.20 : 0.12;
        if (lockedDirection === 'up' && smoothedProbability < (0.5 - flipThreshold)) {
            lockedDirection = 'down';
        } else if (lockedDirection === 'down' && smoothedProbability > (0.5 + flipThreshold)) {
            lockedDirection = 'up';
        }

        const rawIsUp = rawUpdated.predictedPrice >= strike;
        if ((lockedDirection === 'up') !== rawIsUp) {
            const confDist = Math.abs(smoothedProbability - 0.5) * 2;
            const offset = (rawUpdated._remainingVol || 0.002) * strike * confDist * 0.5;
            rawUpdated.predictedPrice = lockedDirection === 'up'
                ? strike + Math.max(offset, 0.01)
                : strike - Math.max(offset, 0.01);
            rawUpdated.changePercent = ((rawUpdated.predictedPrice - strike) / strike) * 100;
        }

        updatedPrediction = rawUpdated;

        // If Kalshi strike just arrived and we were using a fallback
        if (state.kalshiStrike && strikeIsPending) {
            periodStartPrice = state.kalshiStrike;
            strikeIsPending = false;
            originalPrediction = predictPrice(data, minutesAhead);
            updatedPrediction = null;
            recordPrediction(currentPeriodKey, periodStartPrice, originalPrediction.predictedPrice, formatTargetTime(periodEnd));
            if (originalPrediction._regimeInfo) recordBayesianPrediction(currentPeriodKey, periodStartPrice, originalPrediction.predictedPrice, originalPrediction.probability, originalPrediction._regimeInfo.volRegime, originalPrediction._regimeInfo.trendRegime);
            saveSessionState();
        } else if (state.kalshiStrike && state.kalshiStrike !== periodStartPrice) {
            periodStartPrice = state.kalshiStrike;
            saveSessionState();
        }
    }

    // Update sell signal and risk
    const strike = state.kalshiStrike || periodStartPrice;
    const activePred = updatedPrediction || originalPrediction;
    if (originalPrediction && activePred) {
        currentSellSignal = assessSellSignal(originalPrediction, activePred, strike, data.currentPrice, minutesAhead);
        currentRiskAssessment = {
            original: assessRisk(originalPrediction, strike, data.currentPrice),
            updated: updatedPrediction ? assessRisk(updatedPrediction, strike, data.currentPrice) : null
        };
    }

    // Next period preview (last 3 minutes)
    if (secsLeft <= 180 && secsLeft > 0) {
        nextPeriodPreview = computeNextPeriodPreview(data);
    } else {
        nextPeriodPreview = null;
    }

    dataSourceName = state.kalshiStrike
        ? 'BRTI~(' + state.brtiSources + ') + Kalshi strike'
        : 'BRTI~(' + state.brtiSources + ')';
}

// ═══════════════════════════════════════════════════════════════
// MAIN FETCH LOOP — Runs every 10 seconds
// ═══════════════════════════════════════════════════════════════

async function fetchAllData() {
    try {
        const [brti, kalshi, orderBook, trades, fundingRate, history] = await Promise.allSettled([
            fetchBRTIApprox(),
            fetchKalshiData(),
            fetchOrderBook(),
            fetchRecentTrades(),
            fetchFundingRate(),
            fetchHistory()
        ]);

        if (brti.status === 'fulfilled' && brti.value) {
            state.brtiPrice = brti.value.price;
            state.brtiSources = brti.value.sources;
        }
        if (kalshi.status === 'fulfilled' && kalshi.value) {
            const k = kalshi.value;
            state.kalshiStrike = k.strike;
            state.kalshiCloseTime = k.closeTime;
            state.kalshiTicker = k.ticker;
            state.kalshiMarket = k.market;
            if (!k.strike && k.closeTime && state.brtiPrice) {
                state.kalshiStrike = state.brtiPrice;
            }
        }
        if (orderBook.status === 'fulfilled' && orderBook.value) {
            state.orderBook = orderBook.value;
        }
        if (trades.status === 'fulfilled' && trades.value) {
            state.recentTrades = trades.value;
        }
        if (fundingRate.status === 'fulfilled' && fundingRate.value !== null) {
            state.fundingRate = fundingRate.value;
        }
        if (history.status === 'fulfilled' && history.value) {
            state.history = history.value;
        }

        state.periodKey = getPeriodKey();
        state.lastUpdate = new Date().toISOString();
        state.error = null;

        // Run prediction engine
        runPredictionCycle();

        // Broadcast complete state to all clients
        broadcastState();

        console.log(`Cycle: BRTI=$${state.brtiPrice?.toFixed(2)} | Strike=$${state.kalshiStrike || 'none'} | Period=${currentPeriodKey} | Pred=${originalPrediction ? (originalPrediction.predictedPrice >= (state.kalshiStrike || 0) ? 'UP' : 'DOWN') : 'none'} | ${wss.clients.size} clients`);

    } catch (e) {
        console.error('Fetch cycle error:', e);
        state.error = e.message;
    }
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET & BROADCAST
// ═══════════════════════════════════════════════════════════════

function getClientState() {
    return {
        type: 'state',
        currentPrice: state.brtiPrice,
        brtiSources: state.brtiSources,
        kalshiStrike: state.kalshiStrike,
        kalshiTicker: state.kalshiTicker,
        kalshiCloseTime: state.kalshiCloseTime,
        periodKey: currentPeriodKey,
        periodStartPrice,
        isTransitioning,
        originalPrediction,
        updatedPrediction,
        sellSignal: currentSellSignal,
        riskAssessment: currentRiskAssessment,
        nextPeriodPreview,
        history: state.history,
        predictionLog: predictionLog.slice(-20),
        lastUpdate: state.lastUpdate,
        serverUptime: process.uptime(),
        dataSourceName
    };
}

function broadcastState() {
    const msg = JSON.stringify(getClientState());
    for (const client of wss.clients) {
        if (client.readyState === 1) {
            client.send(msg);
        }
    }
}

wss.on('connection', (ws) => {
    console.log(`Client connected (total: ${wss.clients.size})`);

    // Send current state immediately
    ws.send(JSON.stringify(getClientState()));

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'clearHistory') {
                predictionLog = [];
                savePredictionLog();
                broadcastState();
            } else if (msg.type === 'refresh') {
                // Force a data refresh
                fetchAllData();
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log(`Client disconnected (total: ${wss.clients.size})`);
    });

    ws.on('error', (e) => {
        console.error('WebSocket error:', e.message);
    });
});

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        lastUpdate: state.lastUpdate,
        brtiPrice: state.brtiPrice,
        kalshiTicker: state.kalshiTicker,
        periodKey: currentPeriodKey,
        hasPrediction: !!originalPrediction,
        clients: wss.clients.size
    });
});

app.get('/api/state', (req, res) => {
    res.json(getClientState());
});

app.get('/api/predictions', (req, res) => {
    res.json(predictionLog);
});

app.get('/api/bayesian', (req, res) => {
    const graded = bayesianState.records.filter(r => r.correct !== null);
    const correct = graded.filter(r => r.correct).length;
    res.json({
        totalRecords: bayesianState.records.length,
        gradedRecords: graded.length,
        accuracy: graded.length > 0 ? (correct / graded.length * 100).toFixed(1) + '%' : 'N/A',
        directionBeta: bayesianState.directionBeta,
        regimeBeta: bayesianState.regimeBeta
    });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BTC Predictor server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Health:   http://localhost:${PORT}/api/health`);
    console.log('Server runs predictions autonomously every 10 seconds.');
    console.log('Clients are display-only — all predictions happen server-side.');

    // Initial fetch
    fetchAllData();

    // Fetch and predict every 10 seconds
    setInterval(fetchAllData, 10000);
});

