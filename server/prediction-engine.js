'use strict';

// ═══════════════════════════════════════════════════════════════
// Prediction Engine — factory (per-asset instance)
// ───────────────────────────────────────────────────────────────
// Each call to module.exports(assetKey) returns an isolated engine
// with its own sessionRisk and namespaced store reads/writes. The
// asset-symbol-agnostic prediction math (EWMA vol, lognormal CDF,
// Kelly sizing) is shared between instances.
//
// Usage:
//   const createEngine = require('./prediction-engine');
//   const btc = createEngine('btc');
//   const eth = createEngine('eth');
//   btc.handleNewPeriod(...); // independent state from eth.handleNewPeriod
// ═══════════════════════════════════════════════════════════════

const store = require('./store');

// ── Tunables (shared across assets — tune by editing here) ───────
const EWMA_LAMBDA   = 0.94;
const MIN_VOL       = 0.0002;
const MAX_VOL       = 0.02;
const RSI_PERIODS   = 14;
const TREND_LOOKBACK = 20;
const MOMENTUM_LOOKBACK = 5;
const MIN_PROB_TO_BET = 0.58;
const MIN_EDGE_TO_BET = 0.05;
const MIN_CONF_TO_BET = 0.40;
const MIN_MIN_AHEAD_TO_BET = 5;
const KELLY_CAP       = 0.25;

// ── Pure math helpers (asset-independent) ────────────────────────
function erf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function extractPrices(marketData) {
    const hist = marketData?.history || [];
    const prices = hist.map(h => (typeof h === 'number' ? h : h?.price)).filter(p => p && isFinite(p));
    if (marketData?.currentPrice && (prices.length === 0 || prices[prices.length - 1] !== marketData.currentPrice)) {
        prices.push(marketData.currentPrice);
    }
    return prices;
}

function logReturns(prices) {
    const out = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i - 1] > 0 && prices[i] > 0) out.push(Math.log(prices[i] / prices[i - 1]));
    }
    return out;
}

function ewmaVol(returns) {
    if (returns.length === 0) return MIN_VOL;
    let v = returns[0] * returns[0];
    for (let i = 1; i < returns.length; i++) {
        v = EWMA_LAMBDA * v + (1 - EWMA_LAMBDA) * returns[i] * returns[i];
    }
    return clip(Math.sqrt(v), MIN_VOL, MAX_VOL);
}

function estimateDrift(returns) {
    if (returns.length === 0) return 0;
    const recent = returns.slice(-30);
    const mean = recent.reduce((s, r) => s + r, 0) / recent.length;
    return clip(mean, -0.005, 0.005);
}

function computeRsi(prices, period = RSI_PERIODS) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const d = prices[i] - prices[i - 1];
        if (d >= 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses);
}

function computeMomentum(prices, lookback = MOMENTUM_LOOKBACK) {
    if (prices.length < lookback + 1) return 0;
    const a = prices[prices.length - 1 - lookback];
    const b = prices[prices.length - 1];
    return (b - a) / a;
}

function computeTrend(prices, lookback = TREND_LOOKBACK) {
    if (prices.length < lookback) return 0;
    const sl = prices.slice(-lookback);
    const n = sl.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += sl[i]; sxy += i * sl[i]; sxx += i * i; }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return 0;
    const slope = (n * sxy - sx * sy) / denom;
    return slope / sl[sl.length - 1];
}

function detectChoppiness(history) {
    const prices = Array.isArray(history)
        ? history.map(h => typeof h === 'number' ? h : h?.price).filter(p => p)
        : extractPrices({ history });
    if (prices.length < 10) return 0.5;
    const rets = logReturns(prices.slice(-30));
    if (rets.length === 0) return 0.5;
    let signFlips = 0;
    for (let i = 1; i < rets.length; i++) {
        if (rets[i] * rets[i - 1] < 0) signFlips++;
    }
    return clip(signFlips / Math.max(1, rets.length - 1), 0, 1);
}

function detectMomentumExhaustion(history) {
    const prices = Array.isArray(history)
        ? history.map(h => typeof h === 'number' ? h : h?.price).filter(p => p)
        : extractPrices({ history });
    if (prices.length < 15) return 0;
    const rsi = computeRsi(prices);
    if (rsi > 75) return clip((rsi - 75) / 25, 0, 1);
    if (rsi < 25) return clip((25 - rsi) / 25, 0, 1);
    return 0;
}

function getKalshiAsk(marketData, side) {
    const ob = marketData?.kalshiOrderBook?.orderbook_fp || marketData?.kalshiOrderBook?.orderbook || marketData?.kalshiOrderBook;
    if (!ob) return null;
    const isDollar = !!(ob.yes_dollars || ob.no_dollars);
    const yesBids = ob.yes_dollars || ob.yes || [];
    const noBids  = ob.no_dollars || ob.no || [];
    const parse = (lvls) => lvls.map(e => (isDollar ? Math.round(parseFloat(e[0]) * 100) : Math.round(parseFloat(e[0]))));
    const bestYesBid = yesBids.length ? Math.max(...parse(yesBids)) : null;
    const bestNoBid  = noBids.length  ? Math.max(...parse(noBids))  : null;
    if (side === 'yes') return bestNoBid != null ? 100 - bestNoBid : null;
    if (side === 'no')  return bestYesBid != null ? 100 - bestYesBid : null;
    return null;
}

// Best bid for the given side — what the position would crystallize at on a
// market sell. We cross our own quotes: a YES holder sells into the YES bid,
// a NO holder sells into the NO bid.
function getKalshiBid(marketData, side) {
    const ob = marketData?.kalshiOrderBook?.orderbook_fp || marketData?.kalshiOrderBook?.orderbook || marketData?.kalshiOrderBook;
    if (!ob) return null;
    const isDollar = !!(ob.yes_dollars || ob.no_dollars);
    const yesBids = ob.yes_dollars || ob.yes || [];
    const noBids  = ob.no_dollars || ob.no || [];
    const parse = (lvls) => lvls.map(e => (isDollar ? Math.round(parseFloat(e[0]) * 100) : Math.round(parseFloat(e[0]))));
    const bestYesBid = yesBids.length ? Math.max(...parse(yesBids)) : null;
    const bestNoBid  = noBids.length  ? Math.max(...parse(noBids))  : null;
    if (side === 'yes') return bestYesBid;
    if (side === 'no')  return bestNoBid;
    return null;
}

// ── Factory ──────────────────────────────────────────────────────
function createEngine(assetKey = 'btc') {
    const sessionRisk = {
        results: [],
        consecutiveLosses: 0,
        consecutiveWins: 0,
        sessionPnL: 0,
        peakPnL: 0,
        currentDrawdown: 0,
        coolingOff: false,
        coolingOffUntil: 0,
        edgeDecayAlert: false,
    };

    function recordOutcome(correct) {
        sessionRisk.results.push(correct ? 'W' : 'L');
        if (sessionRisk.results.length > 50) sessionRisk.results.shift();
        if (correct) {
            sessionRisk.consecutiveWins += 1;
            sessionRisk.consecutiveLosses = 0;
        } else {
            sessionRisk.consecutiveLosses += 1;
            sessionRisk.consecutiveWins = 0;
        }
        if (sessionRisk.consecutiveLosses >= 4) {
            sessionRisk.coolingOff = true;
            sessionRisk.coolingOffUntil = Date.now() + 30 * 60 * 1000;
        }
        if (sessionRisk.coolingOff && Date.now() > sessionRisk.coolingOffUntil) {
            sessionRisk.coolingOff = false;
        }
        const last20 = sessionRisk.results.slice(-20);
        const wins = last20.filter(x => x === 'W').length;
        sessionRisk.edgeDecayAlert = last20.length >= 20 && wins / last20.length < 0.40;
    }

    function getSessionRiskMultiplier() {
        if (sessionRisk.coolingOff) return 0.0;
        if (sessionRisk.edgeDecayAlert) return 0.5;
        if (sessionRisk.consecutiveLosses >= 2) return 0.7;
        if (sessionRisk.consecutiveWins >= 3) return 1.1;
        return 1.0;
    }

    function predictPrice(marketData, minutesAhead, strikePrice) {
        const prices = extractPrices(marketData);
        const current = prices.length ? prices[prices.length - 1] : (marketData?.currentPrice || strikePrice);
        const rets = logReturns(prices);
        const sigma = ewmaVol(rets);
        const drift = estimateDrift(rets);

        const M = Math.max(0.5, minutesAhead || 7.5);
        const totalSigma = sigma * Math.sqrt(M);
        const expectedLogMove = drift * M;
        const predictedPrice = current * Math.exp(expectedLogMove);
        const predictedHigh = current * Math.exp(expectedLogMove + 1.96 * totalSigma);
        const predictedLow  = current * Math.exp(expectedLogMove - 1.96 * totalSigma);

        let probability = 0.5;
        if (strikePrice && current > 0) {
            const z = (Math.log(strikePrice) - Math.log(current) - expectedLogMove) / totalSigma;
            probability = clip(1 - normCdf(z), 0.01, 0.99);
        }

        const momentum = computeMomentum(prices);
        const trend = computeTrend(prices);
        const rsi = computeRsi(prices);
        const exhaustion = detectMomentumExhaustion(prices);
        const choppiness = detectChoppiness(prices);

        const distanceFrom50 = Math.abs(probability - 0.5) * 2;
        const directionUp = predictedPrice >= (strikePrice || current);
        const momentumAligned = (momentum > 0) === directionUp;
        const trendAligned = (trend > 0) === directionUp;
        let alignmentBonus = 0;
        if (momentumAligned) alignmentBonus += 0.1;
        if (trendAligned) alignmentBonus += 0.1;
        const confidence = clip(distanceFrom50 + alignmentBonus - 0.3 * choppiness - 0.3 * exhaustion, 0.05, 0.95);

        const signals = {
            momentum: momentum > 0.0005 ? 'Bullish' : momentum < -0.0005 ? 'Bearish' : 'Neutral',
            trend:    trend > 0 ? 'Bullish' : trend < 0 ? 'Bearish' : 'Neutral',
            rsi:      rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral',
        };

        const ensembleConfidence = {
            level: confidence > 0.7 ? 'high' : confidence > 0.4 ? 'medium' : 'low',
        };

        const out = {
            predictedPrice, predictedHigh, predictedLow,
            probability, confidence, signals, ensembleConfidence,
            _exhaustion: exhaustion, _choppiness: choppiness, _remainingVol: totalSigma,
            _rawSignals: { momentum, trend, rsi, sigma, drift, current },
        };
        out._betQuality = assessBetQuality(out, strikePrice, marketData, minutesAhead);
        return out;
    }

    function assessBetQuality(prediction, strikePrice, marketData, minutesAhead) {
        const probUp = prediction.probability;
        const goingUp = prediction.predictedPrice >= strikePrice;
        const probForBet = goingUp ? probUp : 1 - probUp;
        const side = goingUp ? 'yes' : 'no';
        const ask = getKalshiAsk(marketData, side);
        const askProb = ask != null ? ask / 100 : 0.5;
        const edge = probForBet - askProb;

        const exhaustion = prediction._exhaustion || 0;
        const choppiness = prediction._choppiness || 0;
        const conf = prediction.confidence || 0;
        const riskMult = getSessionRiskMultiplier();

        let kellyFraction = 0;
        if (ask != null && ask > 0 && ask < 100) {
            const c = ask / 100;
            const b = (1 - c) / c;
            const f = (probForBet * (b + 1) - 1) / b;
            kellyFraction = clip(f, 0, KELLY_CAP);
        }

        const factors = {
            probability: probForBet, ask, edge, confidence: conf,
            choppiness, exhaustion, sessionMultiplier: riskMult, minutesAhead,
        };

        let shouldBet = true;
        let skipReason = null;
        if (probForBet < MIN_PROB_TO_BET) { shouldBet = false; skipReason = `prob ${(probForBet * 100).toFixed(0)}% < ${MIN_PROB_TO_BET * 100}%`; }
        else if (edge < MIN_EDGE_TO_BET)   { shouldBet = false; skipReason = `edge ${(edge * 100).toFixed(1)}% < ${MIN_EDGE_TO_BET * 100}%`; }
        else if (conf < MIN_CONF_TO_BET)   { shouldBet = false; skipReason = `confidence ${(conf * 100).toFixed(0)}% too low`; }
        else if ((minutesAhead || 0) < MIN_MIN_AHEAD_TO_BET) { shouldBet = false; skipReason = `only ${minutesAhead?.toFixed(1)}min remaining`; }
        else if (riskMult === 0)           { shouldBet = false; skipReason = 'session cooling off'; }
        else if (ask == null)              { shouldBet = false; skipReason = 'no orderbook quote'; }
        else if (ask >= 95)                { shouldBet = false; skipReason = `ask ${ask}c too rich`; }

        const betSize = shouldBet ? Math.max(1, Math.round(kellyFraction * 1000 * riskMult)) : 0;
        const quality = shouldBet ? clip(edge * 2 + conf * 0.5, 0, 1) : 0;
        const convictionTier = quality > 0.5 ? 'high' : quality > 0.25 ? 'medium' : 'low';

        return {
            quality, shouldBet, edge, betSize,
            betSizeReason: shouldBet ? `Kelly ${(kellyFraction * 100).toFixed(1)}% × risk ${riskMult.toFixed(2)}` : '',
            convictionTier, skipReason, kellyFraction, factors,
            choppiness, exhaustion,
            sessionRisk: { multiplier: riskMult, coolingOff: sessionRisk.coolingOff, consecutiveLosses: sessionRisk.consecutiveLosses },
            reason: shouldBet ? `BET ${side.toUpperCase()} @ ${ask}c (edge ${(edge * 100).toFixed(1)}%)` : `SKIP: ${skipReason}`,
        };
    }

    function assessSellSignal(originalPrediction, updatedPrediction, strike, currentPrice, minutesRemaining) {
        if (!originalPrediction || !updatedPrediction || !strike || !currentPrice) {
            return { level: 'hold', shortLabel: 'HOLD', advice: 'Insufficient data', urgency: 'low', reasons: [], confidence: 0 };
        }
        const origDirUp = originalPrediction.predictedPrice >= strike;
        const newDirUp = updatedPrediction.predictedPrice >= strike;
        const onWrongSide = origDirUp ? currentPrice < strike : currentPrice > strike;

        const sigmaPerMin = updatedPrediction._rawSignals?.sigma || 0.001;
        const totalSigma = sigmaPerMin * Math.sqrt(Math.max(0.5, minutesRemaining || 0.5));
        const sigmaDist = Math.abs(Math.log(currentPrice / strike)) / Math.max(totalSigma, 1e-6);

        const reasons = [];
        let level = 'hold', shortLabel = 'HOLD', advice = 'Hold position', urgency = 'low';

        if (onWrongSide && sigmaDist >= 2.5 && (minutesRemaining || 0) < 1.5) {
            level = 'lost_cause'; shortLabel = 'LOST'; urgency = 'high';
            advice = `Cut: ${sigmaDist.toFixed(1)}σ wrong with ${minutesRemaining?.toFixed(1)}min left`;
            reasons.push(`${sigmaDist.toFixed(1)}σ on wrong side`);
            reasons.push(`only ${minutesRemaining?.toFixed(1)}min remaining`);
        } else if (onWrongSide && sigmaDist >= 3.0) {
            level = 'lost_cause'; shortLabel = 'LOST'; urgency = 'high';
            advice = `Cut: ${sigmaDist.toFixed(1)}σ on wrong side`;
            reasons.push(`extreme ${sigmaDist.toFixed(1)}σ wrong side`);
        } else if (origDirUp !== newDirUp && updatedPrediction.confidence >= 0.85
                 && (newDirUp ? updatedPrediction.probability : 1 - updatedPrediction.probability) >= 0.80
                 && sigmaDist >= 1.5 && (minutesRemaining || 0) >= 5) {
            level = 'confident_flip'; shortLabel = 'FLIP'; urgency = 'medium';
            advice = `Reversal: now ${newDirUp ? 'UP' : 'DOWN'} with ${(updatedPrediction.confidence * 100).toFixed(0)}% conf`;
            reasons.push('directional flip');
            reasons.push(`new prob ${((newDirUp ? updatedPrediction.probability : 1 - updatedPrediction.probability) * 100).toFixed(0)}%`);
        } else if (!onWrongSide && sigmaDist >= 2.0 && (minutesRemaining || 0) < 3) {
            level = 'winning'; shortLabel = 'WIN';
            advice = `Likely win: ${sigmaDist.toFixed(1)}σ correct side`;
        } else if (!onWrongSide && sigmaDist >= 1.0) {
            level = 'strong_hold'; shortLabel = 'HOLD+';
            advice = 'Position favorable';
        }

        return { level, shortLabel, advice, urgency, reasons, confidence: updatedPrediction.confidence };
    }

    function handleNewPeriod(periodKey, marketData, minutesAhead, kalshiStrike, periodEnd) {
        const prediction = predictPrice(marketData, minutesAhead, kalshiStrike);
        store.recordPrediction({
            periodKey,
            time: new Date().toISOString(),
            timestamp: Date.now(),
            startPrice: kalshiStrike,
            predictedPrice: prediction.predictedPrice,
            predictedHigh: prediction.predictedHigh,
            predictedLow: prediction.predictedLow,
            probability: prediction.probability,
            confidence: prediction.confidence,
            signals: prediction.signals,
            periodEnd,
            actualPrice: null, correct: null, actualDirection: null,
        }, assetKey);
        return prediction;
    }

    function handleSamePeriod(marketData, minutesAhead, kalshiStrike, _periodKey) {
        return predictPrice(marketData, minutesAhead, kalshiStrike);
    }

    function gradeBayesianPrediction(actualPrice, periodKey) {
        const log = store.getPredictionLog(assetKey);
        const entry = log.find(p => p.periodKey === periodKey);
        if (!entry || entry.startPrice == null) return;
        const wentUp = actualPrice >= entry.startPrice;
        const predUp = entry.predictedPrice >= entry.startPrice;
        const correct = wentUp === predUp;
        store.updateBayesianState((bs) => {
            if (!bs.calibrationBins) bs.calibrationBins = {};
            const bin = Math.floor((entry.probability || 0.5) * 10) / 10;
            const key = bin.toFixed(1);
            if (!bs.calibrationBins[key]) bs.calibrationBins[key] = { wins: 0, total: 0 };
            bs.calibrationBins[key].total += 1;
            if (correct) bs.calibrationBins[key].wins += 1;
            return bs;
        }, assetKey);
    }

    function gradePreviousPrediction(actualPrice, currentPeriodKey) {
        let graded = null;
        store.updatePredictionLog((log) => {
            for (let i = log.length - 1; i >= 0; i--) {
                const e = log[i];
                if (e.periodKey === currentPeriodKey) continue;
                if (e.correct == null && e.startPrice != null) {
                    const wentUp = actualPrice >= e.startPrice;
                    const predUp = e.predictedPrice >= e.startPrice;
                    e.actualPrice = actualPrice;
                    e.actualDirection = wentUp ? 'up' : 'down';
                    e.correct = wentUp === predUp;
                    graded = e;
                    break;
                }
            }
            return log;
        }, assetKey);
        if (graded) {
            recordOutcome(graded.correct);
            store.updateErrorAnalysis((ea) => {
                if (!ea.records) ea.records = [];
                ea.records.push({
                    periodKey: graded.periodKey, correct: graded.correct,
                    probability: graded.probability, confidence: graded.confidence,
                    predictedPrice: graded.predictedPrice, actualPrice: graded.actualPrice,
                });
                if (ea.records.length > 200) ea.records.shift();
                return ea;
            }, assetKey);
        }
    }

    function computeNextPeriodPreview(marketData) {
        const current = marketData?.currentPrice || 0;
        if (!current) return null;
        const pred = predictPrice(marketData, 15, current);
        const direction = pred.predictedPrice >= current ? 'UP' : 'DOWN';
        const probForDirection = direction === 'UP' ? pred.probability : 1 - pred.probability;
        const move = pred.predictedPrice - current;
        const movePct = (move / current) * 100;
        const sigma = pred._rawSignals?.sigma || 0;
        return {
            ...pred,
            direction, probForDirection, move, movePct,
            signals: { ...pred.signals, volatility: sigma > 0.003 ? 'High' : sigma > 0.0015 ? 'Medium' : 'Low' },
        };
    }

    function analyzeAndLearn() { /* no-op: API compatibility */ }

    function getLearnedCorrections() {
        const ea = store.getErrorAnalysis(assetKey);
        return ea?.corrections || {};
    }

    function getErrorSummary() {
        const ea = store.getErrorAnalysis(assetKey) || { records: [] };
        const records = ea.records || [];
        const total = records.length;
        if (total === 0) return { total: 0, accuracy: null, recentAccuracy: null, calibration: {} };
        const correct = records.filter(r => r.correct).length;
        const recent = records.slice(-30);
        const recentCorrect = recent.filter(r => r.correct).length;
        const bs = store.getBayesianState(assetKey);
        return {
            total,
            accuracy: correct / total,
            recentAccuracy: recent.length ? recentCorrect / recent.length : null,
            calibration: bs?.calibrationBins || {},
        };
    }

    function getOnlineML() {
        return { enabled: false, weights: {}, samples: 0 };
    }

    return {
        assetKey,
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
        getOnlineML,
    };
}

// Backwards-compat: callers that do `require('./prediction-engine')` and use
// methods directly (the original single-asset API) get a default 'btc'
// instance. Also expose `.createEngine` so multi-asset callers can spin up
// additional instances (e.g. 'eth') without forking the import.
const _defaultEngine = createEngine('btc');
module.exports = createEngine;
module.exports.createEngine = createEngine;
module.exports.getKalshiAsk = getKalshiAsk;
module.exports.getKalshiBid = getKalshiBid;
for (const key of Object.keys(_defaultEngine)) {
    if (module.exports[key] === undefined) {
        module.exports[key] = _defaultEngine[key];
    }
}
