'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { execSync } = require('child_process');

const store = require('./store');
const engine = require('./prediction-engine');
const decisionLog = require('./decision-logger');
const tradeExecutor = require('./trade-executor');
const kalshiAuth = require('./kalshi-auth');
const db = require('./db');

// Build version — updated each commit (Railway has no .git dir)
const BUILD_VERSION = {
    hash: process.env.RAILWAY_GIT_COMMIT_SHA
        ? process.env.RAILWAY_GIT_COMMIT_SHA.substring(0, 7)
        : (() => { try { return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch(e) { return 'dev'; } })(),
    startedAt: new Date().toISOString()
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ═══════════════════════════════════════════════════════════════
// API KEY AUTHENTICATION
// Set DASHBOARD_API_KEY env var to protect all endpoints.
// If not set, the dashboard runs without auth (local dev only).
// ═══════════════════════════════════════════════════════════════
const API_KEY = process.env.DASHBOARD_API_KEY || null;

function requireAuth(req, res, next) {
    if (!API_KEY) return next(); // no key configured = no auth
    const provided = req.headers['x-api-key'] || req.query.apiKey;
    if (provided === API_KEY) return next();
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
}

// Protect all /api routes with API key
app.use('/api', requireAuth);

// Serve static frontend (HTML/CSS/JS are public — they need the key to call APIs)
app.use(express.static(path.join(__dirname, 'public')));

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
            if (price && price > 0) {
                console.log(`  ${ex.name}: $${price.toFixed(2)}`);
                return { name: ex.name, price };
            }
            return null;
        })
    );

    const prices = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter(Boolean);

    if (prices.length === 0) return null;

    // Filter outliers > 0.5% from median (~$425 at $85K BTC)
    // BUG FIX: was 0.25 (25%!) — effectively no filter at all.
    // 0.005 (0.5%) catches broken exchange feeds while allowing normal cross-exchange spread.
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    const median = sorted[Math.floor(sorted.length / 2)].price;
    const filtered = prices.filter(p => Math.abs(p.price - median) / median < 0.005);
    const usePrices = filtered.length >= 2 ? filtered : prices;

    const avg = usePrices.reduce((s, p) => s + p.price, 0) / usePrices.length;
    const sourceNames = usePrices.map(p => p.name).join('+');
    console.log(`BRTI approx: $${avg.toFixed(2)} from ${sourceNames} (${usePrices.length} sources)`);

    return { price: avg, sources: sourceNames, count: usePrices.length };
}

// ── Kalshi Market Fetching ──
// Use the PUBLIC elections API for all read-only market data (strike, prices).
// This is the same endpoint that was working before — it returns full market
// detail including yes_sub_title with the real strike price.
// Demo API (demo-api.kalshi.co) is ONLY used by kalshi-trading.js for bets & funds.
const KALSHI_MARKET_API = 'https://api.elections.kalshi.com/trade-api/v2';

async function fetchKalshiData() {
    try {
        let data = await fetchJSON(
            KALSHI_MARKET_API + '/markets?series_ticker=KXBTC15M&status=open&limit=100'
        );
        let markets = data ? (data.markets || []) : [];

        // Check if any have future close time
        const now = new Date();
        const hasFuture = markets.some(m => new Date(m.close_time || m.expiration_time) > now);

        // Fallback to unfiltered if needed
        if (markets.length === 0 || !hasFuture) {
            const allData = await fetchJSON(
                KALSHI_MARKET_API + '/markets?series_ticker=KXBTC15M&limit=100'
            );
            if (allData && allData.markets) {
                const existingTickers = new Set(markets.map(m => m.ticker));
                for (const m of allData.markets) {
                    if (!existingTickers.has(m.ticker)) markets.push(m);
                }
            }
        }

        // Find best future market
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

        // Get detailed market data from PRODUCTION API
        let detailedMarket = best;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(KALSHI_MARKET_API + '/markets/' + best.ticker, {
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (res.ok) {
                const detail = await res.json();
                if (detail && detail.market) {
                    detailedMarket = detail.market;
                    console.log(`[kalshi] Detail fetch OK for ${best.ticker} (production API)`);
                }
            } else {
                console.log(`[kalshi] Detail fetch ${res.status} for ${best.ticker}`);
            }
        } catch (e) {
            console.log(`[kalshi] Detail fetch failed for ${best.ticker}: ${e.message}`);
        }

        // Extract strike from production API data
        const strike = extractStrike(detailedMarket);
        const closeTime = new Date(best.close_time || best.expiration_time).toISOString();

        // Reduce log spam — only log debug every 6th cycle (~60s)
        if (!fetchKalshiData._logCounter) fetchKalshiData._logCounter = 0;
        fetchKalshiData._logCounter++;
        if (fetchKalshiData._logCounter % 6 === 1) {
            console.log(`[kalshi-debug] ticker=${best.ticker} | strike=${strike} | yes_sub_title=${detailedMarket.yes_sub_title} | title=${detailedMarket.title}`);
        }

        return { market: detailedMarket, strike, closeTime, ticker: best.ticker };
    } catch (e) {
        console.error('Kalshi fetch error:', e.message);
        return { market: null, strike: null, closeTime: null, ticker: null };
    }
}

// Extract strike price ONLY from Kalshi API fields. No fallbacks or guessing.
function extractStrike(m) {
    if (!m) return null;

    // ── 1: "Target price: $X" in yes_sub_title / no_sub_title ──
    for (const field of ['yes_sub_title', 'no_sub_title', 'subtitle']) {
        if (!m[field] || typeof m[field] !== 'string') continue;
        const text = m[field];
        if (/TBD/i.test(text)) continue; // Not set yet

        const match = text.match(/(?:Target price|target):\s*\$?([\d,]+\.?\d*)/i);
        if (match) {
            const v = parseFloat(match[1].replace(/,/g, ''));
            if (v > 10000 && v < 500000) {
                console.log(`[strike] From ${field}: $${v}`);
                return v;
            }
        }
    }

    // ── 2: "$X target" in title ──
    if (m.title && typeof m.title === 'string') {
        const match = m.title.match(/\$?([\d,]+\.?\d*)\s*target/i);
        if (match) {
            const v = parseFloat(match[1].replace(/,/g, ''));
            if (v > 10000 && v < 500000) {
                console.log(`[strike] From title: $${v}`);
                return v;
            }
        }
    }

    // ── 3: "X or above" in text fields ──
    for (const field of ['yes_sub_title', 'subtitle', 'no_sub_title']) {
        if (!m[field] || typeof m[field] !== 'string') continue;
        const match = m[field].match(/\$?([\d,]+\.?\d*)\s*(or above|or more|or higher)/i);
        if (match) {
            const v = parseFloat(match[1].replace(/,/g, ''));
            if (v > 10000 && v < 500000) {
                console.log(`[strike] From ${field} "or above": $${v}`);
                return v;
            }
        }
    }

    // ── 4: Numeric API fields ──
    for (const field of ['custom_strike', 'floor_strike', 'cap_strike']) {
        if (m[field] != null) {
            const raw = parseFloat(m[field]);
            if (isNaN(raw) || raw <= 0) continue;
            // Could be in cents (e.g. 6959612 = $69,596.12)
            if (raw > 5000000) {
                const dollars = raw / 100;
                if (dollars > 10000 && dollars < 500000) {
                    console.log(`[strike] From ${field} (cents): $${dollars}`);
                    return dollars;
                }
            }
            if (raw > 10000 && raw < 500000) {
                console.log(`[strike] From ${field}: $${raw}`);
                return raw;
            }
        }
    }

    // No strike found — return null (do NOT guess or use BRTI)
    console.log(`[strike] No strike found in API. yes_sub_title="${m.yes_sub_title}" title="${m.title}"`);
    return null;
}

// ── ETH Price (for cross-asset lead-lag signal) ──
async function fetchEthPrice() {
    const data = await fetchJSON('https://api.binance.com/api/v3/ticker/bookTicker?symbol=ETHUSDT');
    if (data && data.bidPrice && data.askPrice) {
        return (parseFloat(data.bidPrice) + parseFloat(data.askPrice)) / 2;
    }
    return null;
}

// ── BTC Futures Open Interest (volatility predictor) ──
async function fetchOpenInterest() {
    const data = await fetchJSON('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT');
    if (data && data.openInterest) return parseFloat(data.openInterest);
    return null;
}

// ── Binance Order Book ──
async function fetchOrderBook() {
    return await fetchJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20');
}

// ── Binance Recent Trades ──
async function fetchRecentTrades() {
    return await fetchJSON('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=200');
}

// ── Binance Funding Rate (settled rate + real-time premium index) ──
async function fetchFundingRate() {
    // Premium index gives real-time mark/index spread (updates every second)
    // More useful than the 8-hourly settled rate for short-term prediction
    const data = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    if (data && data.lastFundingRate) {
        return {
            settledRate: parseFloat(data.lastFundingRate),
            markPrice: parseFloat(data.markPrice),
            indexPrice: parseFloat(data.indexPrice),
            // Premium = (mark - index) / index: real-time leverage pressure
            premium: parseFloat(data.markPrice) && parseFloat(data.indexPrice)
                ? (parseFloat(data.markPrice) - parseFloat(data.indexPrice)) / parseFloat(data.indexPrice)
                : 0
        };
    }
    // Fallback to simple funding rate endpoint
    const fallback = await fetchJSON('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1');
    if (fallback && fallback.length > 0) return { settledRate: parseFloat(fallback[0].fundingRate), premium: 0 };
    return null;
}

// ── Binance Liquidations (force orders) ──
async function fetchLiquidations() {
    const data = await fetchJSON('https://fapi.binance.com/fapi/v1/forceOrders?symbol=BTCUSDT&limit=50');
    if (!data || !data.length) return { longLiqVol: 0, shortLiqVol: 0, totalLiqVol: 0, count: 0 };
    const cutoff = Date.now() - 15 * 60 * 1000; // last 15 minutes
    let longLiqVol = 0, shortLiqVol = 0;
    let count = 0;
    for (const order of data) {
        if (order.time < cutoff) continue;
        const qty = parseFloat(order.origQty) * parseFloat(order.price);
        if (order.side === 'SELL') longLiqVol += qty;  // long positions being liquidated
        else shortLiqVol += qty; // short positions being liquidated
        count++;
    }
    return {
        longLiqVol, shortLiqVol,
        totalLiqVol: longLiqVol + shortLiqVol,
        count,
        imbalance: (longLiqVol + shortLiqVol) > 0
            ? (shortLiqVol - longLiqVol) / (longLiqVol + shortLiqVol) // positive = shorts liquidated = bullish
            : 0
    };
}

// ── Fear & Greed Index (Alternative.me — free, no key) ──
// Updates daily; used as regime filter, not directional signal.
let cachedFearGreed = { value: 50, classification: 'Neutral', lastFetch: 0 };
async function fetchFearGreed() {
    // Only fetch once per hour (it updates daily)
    if (Date.now() - cachedFearGreed.lastFetch < 3600000) return cachedFearGreed;
    try {
        const data = await fetchJSON('https://api.alternative.me/fng/?limit=1', 5000);
        if (data && data.data && data.data[0]) {
            cachedFearGreed = {
                value: parseInt(data.data[0].value),
                classification: data.data[0].value_classification,
                lastFetch: Date.now()
            };
        }
    } catch (e) { /* keep cached value */ }
    return cachedFearGreed;
}

// ── Binance Long/Short Ratios (free, no key, 5-min updates) ──
// Contra-indicator: when crowd is heavily long, mean reversion is more likely.
let cachedLongShort = { ratio: 1.0, lastFetch: 0 };
async function fetchLongShortRatio() {
    if (Date.now() - cachedLongShort.lastFetch < 60000) return cachedLongShort;
    try {
        const data = await fetchJSON(
            'https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1',
            5000
        );
        if (data && data[0] && data[0].longShortRatio) {
            cachedLongShort = {
                ratio: parseFloat(data[0].longShortRatio),
                longAccount: parseFloat(data[0].longAccount),
                shortAccount: parseFloat(data[0].shortAccount),
                lastFetch: Date.now()
            };
        }
    } catch (e) { /* keep cached value */ }
    return cachedLongShort;
}

// ── Macro Event Calendar — known high-impact dates ──
// FOMC meetings 2025-2026 (published by Federal Reserve a year ahead)
// Format: 'YYYY-MM-DD' of announcement day
const FOMC_DATES = [
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
    '2025-07-30', '2025-09-17', '2025-11-05', '2025-12-17',
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
    '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16'
];
function getMacroEventContext() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const utcHour = now.getUTCHours();
    const isFOMC = FOMC_DATES.includes(today);
    // CPI is typically released at 08:30 ET (13:30 UTC) on release day
    // We flag the entire day as macro-sensitive
    const dayOfWeek = now.getUTCDay();
    // NFP: first Friday of month at 08:30 ET
    const isFirstFriday = dayOfWeek === 5 && now.getUTCDate() <= 7;
    const isMacroDay = isFOMC || isFirstFriday;
    // Macro announcements typically at 14:00-14:30 UTC (FOMC) or 13:30 UTC (CPI/NFP)
    const isNearAnnouncement = isMacroDay && utcHour >= 13 && utcHour <= 15;
    return {
        isFOMC,
        isFirstFriday,
        isMacroDay,
        isNearAnnouncement,
        // Sizing multiplier: reduce bets during macro events
        sizingMultiplier: isNearAnnouncement ? 0.40 : (isMacroDay ? 0.70 : 1.0)
    };
}

// ── Binance 1m Klines ──
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
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const state = {
    brtiPrice: null,
    brtiSources: '',
    kalshiStrike: null,
    _lastStrikePeriodKey: null,  // tracks which period the strike was locked for
    _strikeSource: null,         // 'api' or 'failed' — tracks where strike came from
    kalshiCloseTime: null,
    kalshiTicker: null,
    kalshiMarket: null,
    orderBook: null,
    kalshiOrderBook: null,
    kalshiOrderBookError: null,
    recentTrades: null,
    fundingRate: null,
    ethPrice: null,
    ethPriceHistory: [], // last 15 ETH prices for lead-lag
    openInterest: null,
    openInterestHistory: [], // last 15 OI values for rate-of-change
    liquidations: null,      // recent liquidation data
    fearGreed: null,         // Alternative.me Fear & Greed index
    macroEvent: null,        // macro event context (FOMC/CPI/NFP)
    longShortRatio: null,    // Binance top trader long/short ratio
    history: [],
    lastUpdate: null,
    periodKey: null,
    error: null
};

function getPeriodKey() {
    const now = new Date();
    const mins = now.getMinutes();
    const periodStart = Math.floor(mins / 15) * 15;
    return now.getHours() + ':' + periodStart;
}

// ═══════════════════════════════════════════════════════════════
// PERIOD HELPERS (from frontend, now server-side)
// ═══════════════════════════════════════════════════════════════

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

function getSecondsUntilTarget(target) {
    return Math.max(0, Math.floor((target - Date.now()) / 1000));
}

// ═══════════════════════════════════════════════════════════════
// SNAPSHOT CAPTURE — Save all data for algorithm improvement
// ═══════════════════════════════════════════════════════════════

function capturePredictionSnapshot(snapshotType, periodKey, ticker, strike, currentPrice, prediction, betQuality, minutesAhead, marketData) {
    const bq = betQuality || prediction._betQuality;
    const factors = bq ? bq.factors : null;
    db.savePredictionSnapshot({
        periodKey,
        snapshotType,
        ticker,
        strike,
        currentPrice,
        predictedPrice: prediction.predictedPrice,
        probability: prediction.probability,
        rawProbability: prediction._rawProbability || prediction.probability,
        confidence: prediction.confidence,
        direction: prediction.predictedPrice >= strike ? 'up' : 'down',
        minutesAhead,
        shouldBet: bq ? bq.shouldBet : null,
        betQualityScore: bq ? bq.quality : null,
        betEdge: bq ? bq.edge : null,
        betSize: bq ? bq.betSize : null,
        betSizeReason: bq ? bq.betSizeReason : null,
        convictionTier: bq ? bq.convictionTier : null,
        skipReason: bq && !bq.shouldBet ? bq.reason : null,
        // Individual quality factors
        factorHasMinEdge: factors ? factors.hasMinEdge : null,
        factorHasConfidence: factors ? factors.hasConfidence : null,
        factorNotChoppy: factors ? factors.notChoppy : null,
        factorNotExhausted: factors ? factors.notExhausted : null,
        factorHasTime: factors ? factors.hasTime : null,
        factorSignalAgreement: factors ? factors.signalAgreement : null,
        // Kelly calculation details
        kellyEntryPrice: bq ? bq.kellyEntryPrice : null,
        kellyWinProfit: bq ? bq.kellyWinProfit : null,
        kellyLossAmount: bq ? bq.kellyLossAmount : null,
        kellyRaw: bq ? bq.kellyRaw : null,
        kellyFraction: bq ? bq.kellyFraction : null,
        kellyHasEdge: bq ? bq.kellyHasEdge : null,
        kellyError: bq ? bq.kellyError : null,
        // Signals & regime
        signals: prediction.signals || null,
        regimeInfo: prediction._regimeInfo || null,
        ensembleConfidence: prediction.ensembleConfidence || null,
        exhaustionScore: prediction._exhaustion ? prediction._exhaustion.exhaustion : null,
        exhaustionType: prediction._exhaustion ? prediction._exhaustion.type : null,
        choppinessAdx: prediction._choppiness ? prediction._choppiness.adx : null,
        isChoppy: prediction._choppiness ? prediction._choppiness.choppy : null,
        // Session risk (individual fields)
        sessionConsecutiveLosses: engine.sessionRisk.consecutiveLosses,
        sessionConsecutiveWins: engine.sessionRisk.consecutiveWins,
        sessionDrawdown: engine.sessionRisk.currentDrawdown,
        sessionCoolingOff: engine.sessionRisk.coolingOff,
        sessionEdgeDecay: engine.sessionRisk.edgeDecayAlert,
        sessionRiskMultiplier: engine.getSessionRiskMultiplier(),
        marketData: {
            fundingRate: marketData.fundingRate,
            fearGreed: marketData.fearGreed,
            longShortRatio: marketData.longShortRatio,
            macroEvent: marketData.macroEvent,
            ethPrice: marketData.ethPrice || (marketData.ethPriceHistory ? marketData.ethPriceHistory[marketData.ethPriceHistory.length - 1] : null),
            openInterest: marketData.openInterest || (marketData.openInterestHistory ? marketData.openInterestHistory[marketData.openInterestHistory.length - 1] : null),
            liquidations: marketData.liquidations,
        },
    }).catch(e => console.error('[snapshot] Prediction save error:', e.message));
}

function captureMarketDataSnapshot(periodKey, state, marketData) {
    // Extract structured market conditions
    const fr = marketData.fundingRate;
    const fundingRate = typeof fr === 'number' ? fr : (fr ? fr.settledRate || 0 : null);
    const fundingPremium = typeof fr === 'object' ? (fr.premium || 0) : null;

    const history = marketData.history || state.history || [];
    const prices = history.map(h => h.price);
    const n = prices.length;

    // Compute price stats
    const recentPrices = prices.slice(-Math.min(30, n));
    const high30 = recentPrices.length > 0 ? Math.max(...recentPrices) : null;
    const low30 = recentPrices.length > 0 ? Math.min(...recentPrices) : null;
    const rangePct = low30 > 0 ? ((high30 - low30) / low30) * 100 : null;

    // Volatility: std dev of returns over last 20 ticks
    const window = Math.min(20, n - 1);
    let volatility = null;
    if (window > 1) {
        const returns = [];
        for (let i = n - window; i < n; i++) {
            if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
        if (returns.length > 1) {
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
            volatility = Math.sqrt(variance);
        }
    }

    // Binance orderbook imbalance
    let binanceBidDepth = null, binanceAskDepth = null, binanceObImbalance = null;
    if (marketData.orderBook) {
        const ob = marketData.orderBook;
        binanceBidDepth = ob.bids ? ob.bids.slice(0, 5).reduce((s, b) => s + (parseFloat(b[1]) || 0), 0) : 0;
        binanceAskDepth = ob.asks ? ob.asks.slice(0, 5).reduce((s, a) => s + (parseFloat(a[1]) || 0), 0) : 0;
        const total = binanceBidDepth + binanceAskDepth;
        binanceObImbalance = total > 0 ? (binanceBidDepth - binanceAskDepth) / total : 0;
    }

    db.saveMarketDataSnapshot({
        periodKey,
        btcPrice: state.brtiPrice,
        ethPrice: state.ethPrice,
        fundingRate,
        fundingPremium,
        openInterest: state.openInterest,
        longShortRatio: marketData.longShortRatio ? marketData.longShortRatio.ratio : null,
        liquidationVolume: marketData.liquidations ? marketData.liquidations.totalLiqVol : null,
        liquidationImbalance: marketData.liquidations ? marketData.liquidations.imbalance : null,
        fearGreedValue: marketData.fearGreed ? marketData.fearGreed.value : null,
        fearGreedLabel: marketData.fearGreed ? marketData.fearGreed.classification : null,
        isMacroDay: marketData.macroEvent ? marketData.macroEvent.isMacroDay : null,
        isNearAnnouncement: marketData.macroEvent ? marketData.macroEvent.isNearAnnouncement : null,
        macroSizingMultiplier: marketData.macroEvent ? marketData.macroEvent.sizingMultiplier : null,
        binanceBidDepth,
        binanceAskDepth,
        binanceObImbalance,
        priceHigh30: high30,
        priceLow30: low30,
        priceRangePct: rangePct,
        volatility20: volatility,
        ethPriceHistory: state.ethPriceHistory || null,
        oiHistory: state.openInterestHistory || null,
    }).catch(e => console.error('[snapshot] Market data save error:', e.message));
}

let _lastPriceSnapTime = 0;
function capturePriceSnapshot(periodKey, price, strike, minutesRemaining, history) {
    const now = Date.now();
    if (now - _lastPriceSnapTime < 10000) return; // max one per 10s
    _lastPriceSnapTime = now;

    const prices = history ? history.map(h => h.price) : [];
    const n = prices.length;

    // 1-min and 5-min price change
    const chg1m = n > 6 ? prices[n - 1] - prices[n - 7] : null; // ~6 ticks = 1 min at 10s intervals
    const chg5m = n > 30 ? prices[n - 1] - prices[n - 31] : null;

    // Quick volatility
    const window = Math.min(20, n - 1);
    let vol = null;
    if (window > 1) {
        const returns = [];
        for (let i = n - window; i < n; i++) {
            if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
        if (returns.length > 1) {
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
            vol = Math.sqrt(variance);
        }
    }

    // Volume ratio
    const volumes = history ? history.map(h => h.volume || 0).filter(v => v > 0) : [];
    const avgVol = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
    const recentVol = volumes.length > 2 ? (volumes[volumes.length - 1] + volumes[volumes.length - 2]) / 2 : 0;
    const volRatio = avgVol > 0 ? recentVol / avgVol : null;

    db.savePriceSnapshot({
        periodKey,
        price,
        strike,
        distanceFromStrike: price && strike ? price - strike : null,
        minutesRemaining,
        priceChange1m: chg1m,
        priceChange5m: chg5m,
        volatility: vol,
        volumeRatio: volRatio,
    }).catch(e => console.error('[snapshot] Price save error:', e.message));
}

let _lastPeriodicObTime = 0;
async function capturePeriodicOrderbook(ticker, periodKey, minutesRemaining, btcPrice, strike) {
    const now = Date.now();
    if (now - _lastPeriodicObTime < 10000) return; // max one per 10s (was 30s — need finer resolution for analysis)
    _lastPeriodicObTime = now;

    try {
        const kalshiTrading = require('./kalshi-trading');
        const resp = await kalshiTrading.getOrderbook(ticker);
        const book = resp.orderbook_fp || resp.orderbook || resp;
        // Detect format: yes_dollars/no_dollars = dollar strings, yes/no = cent integers
        const isDollarFmt = !!(book.yes_dollars || book.no_dollars);
        const yesBids = book.yes_dollars || book.yes || [];
        const noBids = book.no_dollars || book.no || [];

        // Parse bids — normalize to dollar-range (0-1) for consistent math
        const parseBids = (bids) => {
            if (!bids || bids.length === 0) return { best: null, depth: 0, entries: [] };
            let best = 0, depth = 0;
            const entries = [];
            for (const entry of bids) {
                const raw = parseFloat(entry[0]);
                const price = isDollarFmt ? raw : raw / 100; // normalize to 0-1
                const size = parseFloat(entry[1]);
                if (price > best) best = price;
                depth += size;
                entries.push([price, size]);
            }
            return { best, depth, entries };
        };

        const yes = parseBids(yesBids);
        const no = parseBids(noBids);
        const bestYesAsk = no.best ? Math.round((1 - no.best) * 100) : null;
        const bestNoAsk = yes.best ? Math.round((1 - yes.best) * 100) : null;
        const bestYesBid = yes.best ? Math.round(yes.best * 100) : null;
        const bestNoBid = no.best ? Math.round(no.best * 100) : null;
        const spreadCents = (bestYesBid != null && bestYesAsk != null) ? bestYesAsk - bestYesBid : null;

        db.saveOrderbookSnapshot({
            periodKey,
            ticker,
            reason: 'periodic',
            minutesRemaining,
            yesBids: yes.entries,
            noBids: no.entries,
            bestYesBid,
            bestNoBid,
            bestYesAsk,
            bestNoAsk,
            yesDepth: yes.depth,
            noDepth: no.depth,
            spreadCents,
            btcPrice,
            strike,
        }).catch(e => console.error('[snapshot] Periodic orderbook save error:', e.message));
    } catch (e) {
        // Orderbook fetch failed — don't spam logs
        if (!capturePeriodicOrderbook._errCount) capturePeriodicOrderbook._errCount = 0;
        capturePeriodicOrderbook._errCount++;
        if (capturePeriodicOrderbook._errCount % 10 === 1) {
            console.error('[snapshot] Periodic orderbook fetch error:', e.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN FETCH LOOP — Runs every 10 seconds
// ═══════════════════════════════════════════════════════════════

async function fetchAllData() {
    console.log(`\n--- Fetch cycle @ ${new Date().toLocaleTimeString()} ---`);
    try {
        // Parallel fetch all data sources
        const [brti, kalshi, orderBook, trades, fundingRate, history, ethPrice, openInterest, liquidations, fearGreed, longShort] = await Promise.allSettled([
            fetchBRTIApprox(),
            fetchKalshiData(),
            fetchOrderBook(),
            fetchRecentTrades(),
            fetchFundingRate(),
            fetchHistory(),
            fetchEthPrice(),
            fetchOpenInterest(),
            fetchLiquidations(),
            fetchFearGreed(),
            fetchLongShortRatio()
        ]);
        // Macro event context (no API call needed — calendar-based)
        state.macroEvent = getMacroEventContext();

        // Store previous BRTI price before updating — used for accurate period-end grading
        const previousBrtiPrice = state.brtiPrice;
        if (brti.status === 'fulfilled' && brti.value) {
            state.brtiPrice = brti.value.price;
            state.brtiSources = brti.value.sources;
        }

        if (kalshi.status === 'fulfilled' && kalshi.value) {
            const k = kalshi.value;
            state.kalshiCloseTime = k.closeTime;
            state.kalshiTicker = k.ticker;
            state.kalshiMarket = k.market;

            // ── Strike Management ──
            // Only use the strike from the Kalshi production API.
            // If the API doesn't return a strike, show "API failed" — no guessing.
            const currentPeriodKey = getPeriodKey();
            const isNewPeriod = currentPeriodKey !== state._lastStrikePeriodKey;

            if (isNewPeriod) {
                // New period — reset strike, wait for API
                state.kalshiStrike = null;
                state._strikeSource = null;
                state._lastStrikePeriodKey = currentPeriodKey;
                console.log(`[strike] New period ${currentPeriodKey}: waiting for API strike...`);
            }

            // Use strike from Kalshi API if available
            if (k.strike) {
                state.kalshiStrike = k.strike;
                state._strikeSource = 'api';
                if (isNewPeriod || !state.kalshiStrike) {
                    console.log(`[strike] API strike=$${k.strike.toFixed(2)} for ${currentPeriodKey}`);
                }
            } else if (!state.kalshiStrike) {
                state._strikeSource = 'failed';
                // Log only occasionally to reduce spam
                if (isNewPeriod) {
                    console.log(`[strike] API failed to provide strike for ${currentPeriodKey}`);
                }
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

        if (ethPrice.status === 'fulfilled' && ethPrice.value !== null) {
            state.ethPrice = ethPrice.value;
            state.ethPriceHistory.push(ethPrice.value);
            if (state.ethPriceHistory.length > 15) state.ethPriceHistory.shift();
        }

        if (openInterest.status === 'fulfilled' && openInterest.value !== null) {
            state.openInterest = openInterest.value;
            state.openInterestHistory.push(openInterest.value);
            if (state.openInterestHistory.length > 15) state.openInterestHistory.shift();
        }

        if (liquidations.status === 'fulfilled' && liquidations.value) {
            state.liquidations = liquidations.value;
        }
        if (fearGreed.status === 'fulfilled' && fearGreed.value) {
            state.fearGreed = fearGreed.value;
        }
        if (longShort.status === 'fulfilled' && longShort.value) {
            state.longShortRatio = longShort.value;
        }

        if (history.status === 'fulfilled' && history.value) {
            state.history = history.value;
        }

        state.periodKey = getPeriodKey();
        state.lastUpdate = new Date().toISOString();
        state.error = null;

        // ── Fetch Kalshi orderbook for bet quality assessment ──
        // This is the ACTUAL Kalshi contract orderbook (yes/no bids),
        // NOT the Binance BTC/USDT orderbook stored in state.orderBook.
        // Uses authenticated API only (demo or prod based on current mode).
        state.kalshiOrderBook = null;
        state.kalshiOrderBookError = null;
        if (state.kalshiTicker) {
            // Try 1: authenticated API (uses current env's credentials)
            try {
                const kalshiTrading = require('./kalshi-trading');
                state.kalshiOrderBook = await kalshiTrading.getOrderbook(state.kalshiTicker);
            } catch (e) {
                const errMsg = `${e.message}${e.status ? ' (HTTP ' + e.status + ')' : ''}`;
                console.log(`[kalshi-ob] Auth API failed (${kalshiAuth.getEnvironment()}): ${errMsg}`);
                state.kalshiOrderBookError = errMsg;
            }
            // Try 2: public Kalshi API (same data, no auth needed)
            if (!state.kalshiOrderBook) {
                try {
                    const publicUrl = `${KALSHI_MARKET_API}/markets/${state.kalshiTicker}/orderbook`;
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 5000);
                    const res = await fetch(publicUrl, { signal: controller.signal });
                    clearTimeout(timer);
                    if (res.ok) {
                        state.kalshiOrderBook = await res.json();
                        state.kalshiOrderBookError = null;
                        console.log(`[kalshi-ob] Public API fallback OK for ${state.kalshiTicker}`);
                    }
                } catch (e2) {
                    console.log(`[kalshi-ob] Public API fallback also failed: ${e2.message}`);
                    state.kalshiOrderBookError = (state.kalshiOrderBookError || '') + '; public API also failed: ' + e2.message;
                }
            }
            if (state.kalshiOrderBook) {
                // Debug: log top-level keys and format to diagnose price display issues
                const topKeys = Object.keys(state.kalshiOrderBook).join(',');
                const ob = state.kalshiOrderBook?.orderbook_fp || state.kalshiOrderBook?.orderbook || state.kalshiOrderBook;
                const obKeys = ob ? Object.keys(ob).join(',') : 'null';
                const isDollar = !!(ob?.yes_dollars || ob?.no_dollars);
                const yesBids = ob?.yes_dollars || ob?.yes || [];
                const noBids = ob?.no_dollars || ob?.no || [];
                console.log(`[kalshi-ob] ${state.kalshiTicker} (${kalshiAuth.getEnvironment()}): keys=[${topKeys}] ob_keys=[${obKeys}] isDollar=${isDollar} yes=${yesBids.length} no=${noBids.length}`);
                if (yesBids.length > 0 || noBids.length > 0) {
                    console.log(`[kalshi-ob] first_yes=${JSON.stringify(yesBids.slice(0, 3))} first_no=${JSON.stringify(noBids.slice(0, 3))} last_yes=${JSON.stringify(yesBids.slice(-2))} last_no=${JSON.stringify(noBids.slice(-2))}`);
                }
            }
        } else {
            state.kalshiOrderBookError = 'No active Kalshi ticker';
        }

        // ═══════════════════════════════════════════════════════
        // SERVER-SIDE PREDICTION ENGINE
        // ═══════════════════════════════════════════════════════
        try {
            const currentPeriod = store.getCurrentPeriod();
            const periodEnd = getPeriodEndTime();
            const periodKey = getPeriodKey();
            const minutesAhead = Math.max(1, getSecondsUntilTarget(periodEnd) / 60);

            // Detect period transitions
            if (periodKey !== currentPeriod.periodKey) {
                // Grade previous predictions — pass the NEW periodKey so the
                // just-completed period isn't excluded from grading.
                // (These functions skip entries matching the passed periodKey,
                //  treating it as "still active". We want to exclude the NEW
                //  period, not the old one that just ended.)
                if (currentPeriod.periodKey !== null && state.brtiPrice) {
                    // Use the PREVIOUS BRTI price for grading — it's the last price from
                    // the closing period. state.brtiPrice is already updated to the new
                    // period's first price, which can differ from the closing price.
                    const gradingPrice = previousBrtiPrice || state.brtiPrice;
                    engine.gradeBayesianPrediction(gradingPrice, periodKey);
                    engine.gradePreviousPrediction(gradingPrice, periodKey);

                    // ── Auto-trade: settle position P&L ──
                    // Find the most recently graded entry from the PREVIOUS period
                    const log = store.getPredictionLog();
                    let lastGraded = null;
                    for (let i = log.length - 1; i >= 0; i--) {
                        if (log[i].correct !== undefined && log[i].correct !== null && log[i].periodKey !== periodKey) {
                            lastGraded = log[i];
                            break;
                        }
                    }
                    console.log(`[server] Period transition ${currentPeriod.periodKey} → ${periodKey} | ` +
                        `predLog size: ${log.length} | lastGraded: ${lastGraded ? lastGraded.periodKey + ' correct=' + lastGraded.correct : 'NONE'}`);
                    if (lastGraded) {
                        await tradeExecutor.onPeriodEnd({
                            correct: lastGraded.correct,
                            periodKey: lastGraded.periodKey,
                            actualDirection: lastGraded.actualDirection,
                            strikePrice: lastGraded.startPrice,
                            settlementPrice: lastGraded.actualPrice,
                        });

                        // ── DB: backfill prediction + decision outcomes ──
                        db.updatePredictionOutcome(lastGraded.periodKey, {
                            actualPrice: lastGraded.actualPrice,
                            actualDirection: lastGraded.actualDirection,
                            wasCorrect: lastGraded.correct,
                            pnlCents: null, // filled by trade-executor settlement
                        }).catch(e => console.error('[db] Failed to backfill prediction outcome:', e.message));
                        db.updateDecisionOutcome(lastGraded.periodKey, {
                            wasCorrect: lastGraded.correct,
                            pnlCents: null,
                        }).catch(e => console.error('[db] Failed to backfill decision outcome:', e.message));
                    } else {
                        console.warn(`[server] No graded prediction found for period ${currentPeriod.periodKey} — forcing onPeriodEnd with price-based grading`);
                        // Fallback: grade based on current price vs strike
                        if (currentPeriod.periodStartPrice && state.brtiPrice) {
                            const actualDirection = state.brtiPrice >= currentPeriod.periodStartPrice ? 'up' : 'down';
                            const correct = currentPeriod.originalPrediction ?
                                (currentPeriod.originalPrediction.predictedPrice >= currentPeriod.periodStartPrice) === (state.brtiPrice >= currentPeriod.periodStartPrice)
                                : false;
                            await tradeExecutor.onPeriodEnd({
                                correct,
                                periodKey: currentPeriod.periodKey,
                                actualDirection,
                                strikePrice: currentPeriod.periodStartPrice,
                                settlementPrice: state.brtiPrice,
                            });
                        }
                    }
                }

                // New period - wait for Kalshi strike
                if (state.kalshiStrike) {
                    const marketData = {
                        currentPrice: state.brtiPrice,
                        history: state.history,
                        orderBook: state.orderBook,
                        kalshiOrderBook: state.kalshiOrderBook,
                        recentTrades: state.recentTrades,
                        fundingRate: state.fundingRate,
                        ethPrice: state.ethPrice,
                        ethPriceHistory: state.ethPriceHistory,
                        openInterest: state.openInterest,
                        openInterestHistory: state.openInterestHistory,
                    liquidations: state.liquidations,
                    fearGreed: state.fearGreed,
                    macroEvent: state.macroEvent,
                    longShortRatio: state.longShortRatio
                    };
                    const prediction = engine.handleNewPeriod(periodKey, marketData, minutesAhead, state.kalshiStrike, periodEnd);
                    store.updateCurrentPeriod({
                        periodKey,
                        periodStartPrice: state.kalshiStrike,
                        originalPrediction: prediction,
                        updatedPrediction: null,
                        kalshiTicker: state.kalshiTicker,
                        kalshiCloseTime: state.kalshiCloseTime,
                        kalshiStrike: state.kalshiStrike,
                        isTransitioning: false
                    });

                    store.incrementPredictionCount();
                    const bq = prediction._betQuality;
                    const qualStr = bq ? (bq.shouldBet ? 'BET' : 'SKIP') + ' (Q=' + (bq.quality*100).toFixed(0) + '% E=' + (bq.edge*100).toFixed(1) + '%)' : '';
                    console.log(`Prediction: ${prediction.predictedPrice >= state.kalshiStrike ? 'UP' : 'DOWN'} | P(up)=${(prediction.probability * 100).toFixed(1)}% | Conf=${(prediction.confidence * 100).toFixed(0)}% | ${qualStr}`);

                    // ── Decision log: new period prediction ──
                    decisionLog.logNewPeriod({ periodKey, strike: state.kalshiStrike, currentPrice: state.brtiPrice, minutesAhead, kalshiTicker: state.kalshiTicker });
                    decisionLog.logPrediction({ periodKey, strike: state.kalshiStrike, currentPrice: state.brtiPrice, prediction, betQuality: bq, minutesAhead, marketData });

                    // ── DB: snapshot prediction + market data for algorithm improvement ──
                    capturePredictionSnapshot('new_period', periodKey, state.kalshiTicker, state.kalshiStrike, state.brtiPrice, prediction, bq, minutesAhead, marketData);
                    captureMarketDataSnapshot(periodKey, state, marketData);

                    // ── Auto-trade: evaluate entry ──
                    tradeExecutor.onNewPrediction(prediction, state.kalshiTicker, state.kalshiStrike, periodKey).catch(e => console.error('[trade-executor] Entry error:', e.message));
                } else {
                    store.updateCurrentPeriod({
                        periodKey,
                        isTransitioning: true,
                        originalPrediction: null,
                        updatedPrediction: null,
                        periodStartPrice: null,
                        kalshiStrike: null
                    });
                }
            } else if (!currentPeriod.originalPrediction && state.kalshiStrike && currentPeriod.isTransitioning) {
                // Strike arrived late — make the initial prediction now
                const marketData = {
                    currentPrice: state.brtiPrice,
                    history: state.history,
                    orderBook: state.orderBook,
                    kalshiOrderBook: state.kalshiOrderBook,
                    recentTrades: state.recentTrades,
                    fundingRate: state.fundingRate,
                    ethPrice: state.ethPrice,
                    ethPriceHistory: state.ethPriceHistory,
                    openInterest: state.openInterest,
                    openInterestHistory: state.openInterestHistory,
                    liquidations: state.liquidations,
                    fearGreed: state.fearGreed,
                    macroEvent: state.macroEvent,
                    longShortRatio: state.longShortRatio
                };
                const prediction = engine.handleNewPeriod(periodKey, marketData, minutesAhead, state.kalshiStrike, periodEnd);
                store.updateCurrentPeriod({
                    periodStartPrice: state.kalshiStrike,
                    originalPrediction: prediction,
                    updatedPrediction: null,
                    kalshiTicker: state.kalshiTicker,
                    kalshiCloseTime: state.kalshiCloseTime,
                    kalshiStrike: state.kalshiStrike,
                    isTransitioning: false
                });
                const bq = prediction._betQuality;
                const qualStr = bq ? (bq.shouldBet ? 'BET' : 'SKIP') + ' (Q=' + (bq.quality*100).toFixed(0) + '% E=' + (bq.edge*100).toFixed(1) + '%)' : '';
                console.log(`Late prediction: ${prediction.predictedPrice >= state.kalshiStrike ? 'UP' : 'DOWN'} | P(up)=${(prediction.probability * 100).toFixed(1)}% | ${qualStr}`);

                // ── Decision log: late prediction ──
                decisionLog.logPrediction({ periodKey, strike: state.kalshiStrike, currentPrice: state.brtiPrice, prediction, betQuality: bq, minutesAhead, marketData });

                // ── DB: snapshot late prediction + market data ──
                capturePredictionSnapshot('new_period', periodKey, state.kalshiTicker, state.kalshiStrike, state.brtiPrice, prediction, bq, minutesAhead, marketData);
                captureMarketDataSnapshot(periodKey, state, marketData);

                // ── Auto-trade: evaluate late entry ──
                tradeExecutor.onNewPrediction(prediction, state.kalshiTicker, state.kalshiStrike, periodKey).catch(e => console.error('[trade-executor] Late entry error:', e.message));
            } else if (currentPeriod.originalPrediction && state.kalshiStrike) {
                // Same period - update prediction
                const marketData = {
                    currentPrice: state.brtiPrice,
                    history: state.history,
                    orderBook: state.orderBook,
                    kalshiOrderBook: state.kalshiOrderBook,
                    recentTrades: state.recentTrades,
                    fundingRate: state.fundingRate,
                    ethPriceHistory: state.ethPriceHistory,
                    openInterestHistory: state.openInterestHistory,
                    liquidations: state.liquidations,
                    fearGreed: state.fearGreed,
                    macroEvent: state.macroEvent,
                    longShortRatio: state.longShortRatio
                };
                const updated = engine.handleSamePeriod(marketData, minutesAhead, state.kalshiStrike, periodKey);
                // Recompute bet quality based on updated prediction
                const updatedBetQuality = engine.assessBetQuality(updated, state.kalshiStrike, marketData, minutesAhead);
                updated._betQuality = updatedBetQuality;
                store.updateCurrentPeriod({ updatedPrediction: updated });

                // Compute sell signal
                const sellSignal = engine.assessSellSignal(
                    currentPeriod.originalPrediction, updated,
                    state.kalshiStrike, state.brtiPrice, minutesAhead
                );
                store.setSellSignal(sellSignal);

                // ── Decision log: sell signal evaluation ──
                if (sellSignal && sellSignal.level !== 'hold' && sellSignal.level !== 'winning' && sellSignal.level !== 'strong_hold') {
                    decisionLog.logSellDecision({ sellSignal, minutesRemaining: minutesAhead, acted: false, currentPrice: state.brtiPrice, strike: state.kalshiStrike });
                }
                // Log price ticks (sampled every 30s)
                decisionLog.logPriceTick({ currentPrice: state.brtiPrice, strike: state.kalshiStrike, periodKey, minutesAhead, history: state.history });

                // ── DB: price snapshot every tick ──
                capturePriceSnapshot(periodKey, state.brtiPrice, state.kalshiStrike, minutesAhead, state.history);

                // ── DB: comprehensive cycle data snapshot every tick ──
                // Captures EVERYTHING the app computed this tick for full post-mortem visibility
                try {
                    const ob = state.kalshiOrderBook?.orderbook_fp || state.kalshiOrderBook?.orderbook || state.kalshiOrderBook;
                    const obDollar = ob ? !!(ob.yes_dollars || ob.no_dollars) : false;
                    const obYes = ob ? (ob.yes_dollars || ob.yes || []) : [];
                    const obNo = ob ? (ob.no_dollars || ob.no || []) : [];
                    const parseOB = (bids) => bids.map(e => {
                        const raw = parseFloat(e[0]);
                        return [obDollar ? Math.round(raw * 100) : Math.round(raw), parseFloat(e[1])];
                    });
                    const yParsed = parseOB(obYes);
                    const nParsed = parseOB(obNo);
                    const bestYesBid = yParsed.length > 0 ? Math.max(...yParsed.map(e => e[0])) : null;
                    const bestNoBid = nParsed.length > 0 ? Math.max(...nParsed.map(e => e[0])) : null;
                    const bestYesAsk = bestNoBid != null ? 100 - bestNoBid : null;
                    const bestNoAsk = bestYesBid != null ? 100 - bestYesBid : null;

                    const distFromStrike = state.brtiPrice && state.kalshiStrike ? state.brtiPrice - state.kalshiStrike : null;
                    const distPct = state.kalshiStrike ? (Math.abs(distFromStrike) / state.kalshiStrike) * 100 : null;

                    db.saveCycleData({
                        periodKey,
                        minutesRemaining: minutesAhead,
                        btcPrice: state.brtiPrice,
                        strike: state.kalshiStrike,
                        distanceFromStrike: distFromStrike,
                        distancePct: distPct,
                        kalshiYesBid: bestYesBid,
                        kalshiYesAsk: bestYesAsk,
                        kalshiNoBid: bestNoBid,
                        kalshiNoAsk: bestNoAsk,
                        kalshiSpread: bestYesBid != null && bestYesAsk != null ? bestYesAsk - bestYesBid : null,
                        kalshiYesBids: yParsed,
                        kalshiNoBids: nParsed,
                        predictedPrice: updated.predictedPrice,
                        probability: updated.probability,
                        confidence: updated.confidence,
                        direction: updated.predictedPrice >= state.kalshiStrike ? 'up' : 'down',
                        rawSignals: { ...(updated._rawSignals || {}), predictedHigh: updated.predictedHigh, predictedLow: updated.predictedLow },
                        marketContext: {
                            fundingRate: state.fundingRate,
                            ethPrice: state.ethPriceHistory ? state.ethPriceHistory[state.ethPriceHistory.length - 1] : null,
                            openInterest: state.openInterestHistory ? state.openInterestHistory[state.openInterestHistory.length - 1] : null,
                            liquidations: state.liquidations,
                            fearGreed: state.fearGreed,
                            longShortRatio: state.longShortRatio,
                            macroEvent: state.macroEvent,
                            binanceOrderBookImbalance: state.orderBook ? (() => {
                                const bids = state.orderBook.bids || [];
                                const asks = state.orderBook.asks || [];
                                const bidDepth = bids.reduce((s, b) => s + parseFloat(b[1] || 0), 0);
                                const askDepth = asks.reduce((s, a) => s + parseFloat(a[1] || 0), 0);
                                return { bidDepth, askDepth, imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0 };
                            })() : null,
                        },
                        betQuality: updatedBetQuality ? {
                            shouldBet: updatedBetQuality.shouldBet,
                            quality: updatedBetQuality.quality,
                            edge: updatedBetQuality.edge,
                            betSize: updatedBetQuality.betSize,
                            convictionTier: updatedBetQuality.convictionTier,
                            skipReason: updatedBetQuality.skipReason,
                        } : null,
                        sellSignal: sellSignal ? {
                            level: sellSignal.level,
                            reasons: sellSignal.reasons,
                            confidence: sellSignal.confidence,
                        } : null,
                    }).catch(e => console.error('[cycle-data] Save error:', e.message));
                } catch (cycleErr) {
                    // Non-critical — don't break the main loop
                    console.error('[cycle-data] Capture error:', cycleErr.message);
                }

                // ── DB: periodic Kalshi orderbook snapshot (throttled to every 30s) ──
                if (state.kalshiTicker) {
                    capturePeriodicOrderbook(state.kalshiTicker, periodKey, minutesAhead, state.brtiPrice, state.kalshiStrike);
                }

                // ── Auto-trade: check current status to avoid redundant calls ──
                const tradeStatus = tradeExecutor.getStatus();
                const hasPosition = !!(tradeStatus.currentPosition);

                // ── Auto-trade: mid-period entry ──
                // Only attempt entry if no position exists for this period
                if (!hasPosition && updatedBetQuality && updatedBetQuality.shouldBet) {
                    await tradeExecutor.onNewPrediction(updated, state.kalshiTicker, state.kalshiStrike, periodKey)
                        .catch(e => console.error('[trade-executor] Mid-period entry error:', e.message));
                }

                // ── Auto-trade: evaluate exit (with guaranteed-win protection) ──
                if (hasPosition && sellSignal) {
                    await tradeExecutor.onSellSignal(sellSignal, minutesAhead, updated, state.kalshiStrike, state.brtiPrice)
                        .catch(e => console.error('[trade-executor] Sell error:', e.message));
                }

                // ── Auto-trade: mid-period strategies (only when relevant) ──
                // Dip buyer: add to position when price moves against us at better odds
                if (hasPosition) {
                    await tradeExecutor.onDipOpportunity(updated, sellSignal, state.kalshiStrike, state.brtiPrice, minutesAhead, state.kalshiTicker, periodKey)
                        .catch(e => console.error('[trade-executor] Dip buyer error:', e.message));
                }

                // Late lock: max entry when outcome is nearly guaranteed (only if no/small position)
                await tradeExecutor.onLateLock(updated, state.kalshiStrike, state.brtiPrice, minutesAhead, state.kalshiTicker, periodKey)
                    .catch(e => console.error('[trade-executor] Late lock error:', e.message));

                // Re-entry: get back in after an early sell if conditions recover (only if no position)
                if (!hasPosition) {
                    await tradeExecutor.onReentryCheck(updated, state.kalshiStrike, state.brtiPrice, minutesAhead, state.kalshiTicker, periodKey)
                        .catch(e => console.error('[trade-executor] Re-entry error:', e.message));
                }

                // Next period preview in last 3 minutes
                if (minutesAhead <= 3) {
                    const preview = engine.computeNextPeriodPreview(marketData);
                    store.setNextPeriodPreview(preview);
                }

                console.log(`Prediction: ${updated.predictedPrice >= state.kalshiStrike ? 'UP' : 'DOWN'} | P(up)=${(updated.probability * 100).toFixed(1)}% | Conf=${(updated.confidence * 100).toFixed(0)}%`);
            }

        } catch (predErr) {
            console.error('Prediction engine error:', predErr.message);
        }

        // Broadcast to all connected clients
        broadcast({
            type: 'data',
            // Market data
            brtiPrice: state.brtiPrice,
            brtiSources: state.brtiSources,
            kalshiStrike: state.kalshiStrike,
            strikeSource: state._strikeSource,  // 'api', 'failed', or null
            kalshiCloseTime: state.kalshiCloseTime,
            kalshiTicker: state.kalshiTicker,
            kalshiMarket: state.kalshiMarket,
            history: state.history,
            lastUpdate: state.lastUpdate,
            periodKey: state.periodKey,
            // Prediction data (from server!)
            prediction: store.getCurrentPeriod(),
            predictionLog: store.getPredictionLog(),
            sellSignal: store.getState().sellSignal,
            nextPeriodPreview: store.getState().nextPeriodPreview,
            serverUptime: process.uptime(),
            serverVersion: BUILD_VERSION.hash,
            totalPredictions: store.getState().totalPredictionsMade,
            errorAnalysis: engine.getErrorSummary(),
            learnedCorrections: engine.getLearnedCorrections(),
            betQuality: store.getCurrentPeriod()?.updatedPrediction?._betQuality || store.getCurrentPeriod()?.originalPrediction?._betQuality || null,
            sessionRisk: {
                consecutiveLosses: engine.sessionRisk.consecutiveLosses,
                consecutiveWins: engine.sessionRisk.consecutiveWins,
                currentDrawdown: engine.sessionRisk.currentDrawdown,
                coolingOff: engine.sessionRisk.coolingOff,
                edgeDecayAlert: engine.sessionRisk.edgeDecayAlert,
                riskMultiplier: engine.getSessionRiskMultiplier()
            },
            fearGreed: state.fearGreed,
            macroEvent: state.macroEvent,
            tradingStatus: tradeExecutor.getStatus(),
            kalshiEnvironment: kalshiAuth.getEnvironment(),
            kalshiOrderBook: state.kalshiOrderBook || null,
            kalshiOrderBookError: state.kalshiOrderBookError || null,
        });

        console.log(`Broadcast: BRTI=$${state.brtiPrice?.toFixed(2)} | Kalshi=${state.kalshiTicker || 'none'} | Strike=$${state.kalshiStrike || 'none'} | Env=${kalshiAuth.getEnvironment()} | ${wss.clients.size} clients`);

    } catch (e) {
        console.error('Fetch cycle error:', e);
        state.error = e.message;
    }
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════

function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(msg);
        }
    }
}

// Forward trade events to all WebSocket clients for push notifications
tradeExecutor.onTradeNotify((trade) => {
    broadcast({ type: 'trade', trade });
});

wss.on('connection', (ws, req) => {
    // Authenticate WebSocket connections via ?apiKey= query param
    if (API_KEY) {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('apiKey') !== API_KEY) {
            ws.close(4401, 'Unauthorized');
            return;
        }
    }
    console.log(`Client connected (total: ${wss.clients.size})`);

    // Send full current state including predictions immediately
    ws.send(JSON.stringify({
        type: 'data',
        // Market data
        brtiPrice: state.brtiPrice,
        brtiSources: state.brtiSources,
        kalshiStrike: state.kalshiStrike,
        strikeSource: state._strikeSource,
        kalshiCloseTime: state.kalshiCloseTime,
        kalshiTicker: state.kalshiTicker,
        kalshiMarket: state.kalshiMarket,
        history: state.history,
        lastUpdate: state.lastUpdate,
        periodKey: state.periodKey,
        // Prediction data (from server!)
        prediction: store.getCurrentPeriod(),
        predictionLog: store.getPredictionLog(),
        sellSignal: store.getState().sellSignal,
        nextPeriodPreview: store.getState().nextPeriodPreview,
        serverUptime: process.uptime(),
        serverVersion: BUILD_VERSION.hash,
        totalPredictions: store.getState().totalPredictionsMade,
        errorAnalysis: engine.getErrorSummary(),
        learnedCorrections: engine.getLearnedCorrections(),
        tradingStatus: tradeExecutor.getStatus(),
        kalshiEnvironment: kalshiAuth.getEnvironment()
    }));

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'clearHistory') {
                console.log('Client requested FULL data purge');
                store.clearPredictionLog();
                tradeExecutor.clearTradeLog();
                db.purgeAllData();
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
        version: BUILD_VERSION,
        uptime: process.uptime(),
        lastUpdate: state.lastUpdate,
        brtiPrice: state.brtiPrice,
        kalshiTicker: state.kalshiTicker,
        clients: wss.clients.size,
        totalPredictions: store.getState().totalPredictionsMade,
        lastPredictionTime: store.getState().lastPredictionTime,
        predictionLogSize: store.getPredictionLog().length
    });
});

app.get('/api/state', (req, res) => {
    res.json({
        ...state,
        prediction: store.getCurrentPeriod(),
        predictionLog: store.getPredictionLog(),
        sellSignal: store.getState().sellSignal,
        nextPeriodPreview: store.getState().nextPeriodPreview,
        serverUptime: process.uptime(),
        serverVersion: BUILD_VERSION.hash,
        totalPredictions: store.getState().totalPredictionsMade,
        errorAnalysis: engine.getErrorSummary(),
        learnedCorrections: engine.getLearnedCorrections()
    });
});

app.get('/api/predictions', (req, res) => {
    res.json({
        currentPeriod: store.getCurrentPeriod(),
        sellSignal: store.getState().sellSignal,
        nextPeriodPreview: store.getState().nextPeriodPreview,
        totalPredictions: store.getState().totalPredictionsMade,
        lastPredictionTime: store.getState().lastPredictionTime
    });
});

app.get('/api/history', (req, res) => {
    res.json({
        predictionLog: store.getPredictionLog()
    });
});

// Combined period history: merges predictions + trades by periodKey
app.get('/api/history/combined', (req, res) => {
    const predictions = store.getPredictionLog();
    const trades = tradeExecutor.getStatus().recentTrades || [];

    // Group trades by periodKey
    const tradesByPeriod = {};
    for (const t of trades) {
        const pk = t.periodKey || 'unknown';
        if (!tradesByPeriod[pk]) tradesByPeriod[pk] = [];
        tradesByPeriod[pk].push(t);
    }

    // Build combined entries from predictions
    const periods = [];
    const seenKeys = new Set();
    for (const p of predictions) {
        const pk = p.periodKey;
        seenKeys.add(pk);
        periods.push({
            periodKey: pk,
            timestamp: p.timestamp,
            prediction: p,
            trades: tradesByPeriod[pk] || [],
        });
    }

    // Add trade-only periods (trades with no prediction entry)
    for (const pk of Object.keys(tradesByPeriod)) {
        if (!seenKeys.has(pk) && pk !== 'unknown') {
            const firstTrade = tradesByPeriod[pk][0];
            periods.push({
                periodKey: pk,
                timestamp: new Date(firstTrade.time).getTime(),
                prediction: null,
                trades: tradesByPeriod[pk],
            });
        }
    }

    // Sort newest first
    periods.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    res.json({ periods });
});

// ── Model Health: consolidated model diagnostics ──
app.get('/api/model-health', (req, res) => {
    const engineModule = require('./prediction-engine');
    const errorSummary = engineModule.getErrorSummary();
    const sessionRiskData = engineModule.sessionRisk;
    const riskMult = engineModule.getSessionRiskMultiplier();

    res.json({
        accuracy: errorSummary.directionAccuracy,
        totalPredictions: errorSummary.totalAnalyzed,
        overconfidenceRate: errorSummary.overconfidenceRate,
        sessionRisk: {
            consecutiveLosses: sessionRiskData.consecutiveLosses,
            consecutiveWins: sessionRiskData.consecutiveWins,
            coolingOff: sessionRiskData.coolingOff,
            drawdown: sessionRiskData.currentDrawdown,
            riskMultiplier: riskMult,
            edgeDecay: sessionRiskData.edgeDecayAlert,
        },
        corrections: errorSummary.corrections,
        patterns: errorSummary.patterns,
    });
});

app.get('/api/error-analysis', (req, res) => {
    res.json(engine.getErrorSummary());
});

app.get('/api/learned-corrections', (req, res) => {
    res.json(engine.getLearnedCorrections());
});

// ── Hourly Performance: DB win rates + live hour filter status ──
app.get('/api/hourly-performance', async (req, res) => {
    try {
        // DB-based historical win rates by hour
        const dbHourly = await db.getWinRateByHour();

        // Live hour filter from trade executor
        const tradingStatus = tradeExecutor.getStatus();
        const hourFilter = tradingStatus.hourFilter || {};

        // In-memory hourly tracking from prediction log
        const predictionLog = store.getPredictionLog();
        const inMemoryByHour = {};
        for (const entry of predictionLog) {
            if (entry.correct === undefined || entry.correct === null) continue;
            const ts = entry.timestamp ? new Date(entry.timestamp) : null;
            if (!ts) continue;
            const hour = ts.getHours();
            if (!inMemoryByHour[hour]) inMemoryByHour[hour] = { total: 0, wins: 0 };
            inMemoryByHour[hour].total++;
            if (entry.correct) inMemoryByHour[hour].wins++;
        }

        // Merge all sources into a unified 0-23 hour map
        const hours = {};
        for (let h = 0; h < 24; h++) {
            const dbRow = dbHourly.find(r => parseInt(r.hour) === h);
            const memRow = inMemoryByHour[h];
            const filterInfo = hourFilter.allHours ? hourFilter.allHours[h] : null;

            const dbTotal = dbRow ? parseInt(dbRow.total) : 0;
            const dbWins = dbRow ? parseInt(dbRow.wins) : 0;
            const memTotal = memRow ? memRow.total : 0;
            const memWins = memRow ? memRow.wins : 0;

            hours[h] = {
                dbTotal,
                dbWins,
                dbWinRate: dbTotal > 0 ? (dbWins / dbTotal * 100).toFixed(1) + '%' : 'N/A',
                sessionTotal: memTotal,
                sessionWins: memWins,
                sessionWinRate: memTotal > 0 ? (memWins / memTotal * 100).toFixed(1) + '%' : 'N/A',
                filterAllowed: filterInfo ? filterInfo.allowed : true,
                filterBoost: filterInfo ? filterInfo.boost : false,
                filterMinConviction: filterInfo ? filterInfo.minConviction : null,
            };
        }

        res.json({
            currentHour: hourFilter.currentHour,
            currentHourAllowed: hourFilter.allowed,
            currentHourBoost: hourFilter.boost,
            hours,
        });
    } catch (e) {
        console.error('[api] Hourly performance error:', e.message);
        res.status(500).json({ error: 'Failed to load hourly performance' });
    }
});

// ── Debug: raw Kalshi market data (dumps EVERYTHING) ──
app.get('/api/debug/kalshi-raw', (req, res) => {
    const m = state.kalshiMarket;
    if (!m) return res.json({ error: 'No Kalshi market loaded yet' });
    // Return the ENTIRE market object plus our extracted values
    res.json({
        _extractedStrike: state.kalshiStrike,
        _brtiPrice: state.brtiPrice,
        _kalshiTicker: state.kalshiTicker,
        _allKeys: Object.keys(m),
        ...m,
    });
});

// ── Trading endpoints ──

app.get('/api/trading/status', (req, res) => {
    res.json(tradeExecutor.getStatus());
});

// Trading analytics — historical data from PostgreSQL
app.get('/api/trading/analytics', async (req, res) => {
    const db = require('./db');
    try {
        const [dailyHistory, cumulativePnl, winRateByDirection, winRateByHour, winRateByStrategy, totalTrades, balanceSummary] = await Promise.all([
            db.getDailyStatsHistory(90),
            db.getCumulativePnl(),
            db.getWinRateByDirection(),
            db.getWinRateByHour(),
            db.getWinRateByStrategy(),
            db.getTradeCount(),
            db.getBalanceSummary(),
        ]);
        res.json({ dailyHistory, cumulativePnl, winRateByDirection, winRateByHour, winRateByStrategy, totalTrades, balanceSummary });
    } catch (e) {
        console.error('[api] Analytics error:', e.message);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// ── DB Dump / Debug Endpoint ─────────────────────────────────
// Full trade history + stats for external analysis
app.get('/api/db/dump', async (req, res) => {
    const db = require('./db');
    try {
        const days = parseInt(req.query.days || '7', 10);
        const tradeLimit = parseInt(req.query.trades || '200', 10);

        const [dailyStats, recentTrades, winByStrategy, winByDirection, winByHour, cumulativePnl, totalTrades] = await Promise.all([
            db.getDailyStatsHistory(days),
            db.getRecentTrades(tradeLimit),
            db.getWinRateByStrategy(),
            db.getWinRateByDirection(),
            db.getWinRateByHour(),
            db.getCumulativePnl(),
            db.getTradeCount(),
        ]);

        // Summarize settlements for quick analysis
        const settlements = (recentTrades || []).filter(t => t.type === 'settle');
        const buys = (recentTrades || []).filter(t => t.type === 'buy');

        res.json({
            summary: {
                totalTrades,
                cumulativePnl,
                settlementsInWindow: settlements.length,
                winsInWindow: settlements.filter(s => s.correct).length,
                lossesInWindow: settlements.filter(s => !s.correct).length,
                flipsInWindow: settlements.filter(s => s.data?.flipped).length,
            },
            dailyStats,
            winByStrategy,
            winByDirection,
            winByHour,
            recentTrades: (recentTrades || []).map(t => ({
                type: t.type,
                time: t.time,
                side: t.side,
                contracts: t.contracts,
                price: t.limit_price || t.entry_price,
                pnlCents: t.pnl_cents,
                correct: t.correct,
                strategy: t.strategy,
                periodKey: t.period_key,
                conviction: t.data?.convictionTier,
                edge: t.data?.edge,
                flipped: t.data?.flipped,
                flipLoss: t.data?.flipLossCents,
                sigma: t.data?.sigmaDistance,
            })),
        });
    } catch (e) {
        console.error('[api] DB dump error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Cycle Data API — full per-tick data for any period ────────
app.get('/api/cycle-data/:periodKey', async (req, res) => {
    const db = require('./db');
    try {
        const rows = await db.getCycleData(req.params.periodKey);
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/cycle-data', async (req, res) => {
    const db = require('./db');
    try {
        const limit = parseInt(req.query.limit || '100', 10);
        const rows = await db.getRecentCycleData(limit);
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Auto-Bettor Performance Analysis Endpoint ────────────────
app.get('/api/auto-bettor-analysis', async (req, res) => {
    try {
        const predictions = store.getPredictionLog();
        const trades = tradeExecutor.getStatus().recentTrades || [];
        const dailyStats = await db.getDailyStatsHistory(30);
        const winByStrategy = await db.getWinRateByStrategy();
        const winByDirection = await db.getWinRateByDirection();
        const winByHour = await db.getWinRateByHour();
        const cumulativePnl = await db.getCumulativePnl();

        // Aggregate trade stats
        const settles = trades.filter(t => t.type === 'settle');
        const buys = trades.filter(t => ['buy', 'dip_buy', 'late_lock', 'late_lock_add', 're_entry'].includes(t.type));
        const sells = trades.filter(t => t.type === 'sell' || t.type === 'flip');
        const wins = settles.filter(t => t.correct);
        const losses = settles.filter(t => t.correct === false);
        const totalPnlCents = settles.reduce((s, t) => s + (t.pnlCents || 0), 0);

        // Win/loss streaks
        let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
        for (const s of settles) {
            if (s.correct) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
            else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
        }

        // Prediction accuracy
        const graded = predictions.filter(p => p.correct !== null && p.correct !== undefined);
        const predCorrect = graded.filter(p => p.correct).length;

        // Entry price analysis
        const entryPrices = buys.map(t => t.entryPrice || t.limitPrice).filter(Boolean);
        const avgEntry = entryPrices.length > 0 ? entryPrices.reduce((s, v) => s + v, 0) / entryPrices.length : 0;

        // Avg contracts per trade
        const contractCounts = buys.map(t => t.contracts).filter(Boolean);
        const avgContracts = contractCounts.length > 0 ? contractCounts.reduce((s, v) => s + v, 0) / contractCounts.length : 0;

        // Conviction tier breakdown
        const convictionTrades = {};
        for (const t of buys) {
            const tier = t.strategy || 'standard';
            if (!convictionTrades[tier]) convictionTrades[tier] = { count: 0, wins: 0, losses: 0, pnl: 0 };
            convictionTrades[tier].count++;
        }
        // Match settles to strategies
        for (const s of settles) {
            const matchingBuy = buys.find(b => b.periodKey === s.periodKey);
            const tier = matchingBuy?.strategy || 'standard';
            if (!convictionTrades[tier]) convictionTrades[tier] = { count: 0, wins: 0, losses: 0, pnl: 0 };
            if (s.correct) convictionTrades[tier].wins++;
            else convictionTrades[tier].losses++;
            convictionTrades[tier].pnl += (s.pnlCents || 0);
        }

        // Periods where we bet vs didn't
        const tradedPeriods = new Set(buys.map(t => t.periodKey));
        const betPeriods = graded.filter(p => tradedPeriods.has(p.periodKey));
        const skipPeriods = graded.filter(p => !tradedPeriods.has(p.periodKey));
        const betCorrect = betPeriods.filter(p => p.correct).length;
        const skipCorrect = skipPeriods.filter(p => p.correct).length;

        // Sell signal analysis
        const earlyExits = sells.filter(t => t.reason && t.reason !== 'settlement');
        const flipTrades = trades.filter(t => t.type === 'flip');

        // Per-cycle data for deep analysis (last 20 cycles)
        const recentPeriodKeys = [...new Set(predictions.slice(-20).map(p => p.periodKey))];
        const cycleDetails = [];
        for (const pk of recentPeriodKeys) {
            try {
                const rows = await db.getCycleData(pk);
                if (rows.length === 0) continue;
                const pred = predictions.find(p => p.periodKey === pk);
                const periodTrades = trades.filter(t => t.periodKey === pk);
                const settle = periodTrades.find(t => t.type === 'settle');
                const firstTick = rows[0];
                const lastTick = rows[rows.length - 1];
                const prices = rows.map(r => parseFloat(r.btc_price));
                const strike = parseFloat(firstTick.strike);
                const probs = rows.map(r => parseFloat(r.probability) || 0);
                const confs = rows.map(r => parseFloat(r.confidence) || 0);

                // Direction changes
                let dirFlips = 0;
                for (let i = 1; i < rows.length; i++) {
                    if (rows[i].direction && rows[i - 1].direction && rows[i].direction !== rows[i - 1].direction) dirFlips++;
                }

                cycleDetails.push({
                    periodKey: pk,
                    tickCount: rows.length,
                    priceStart: prices[0],
                    priceEnd: prices[prices.length - 1],
                    priceMin: Math.min(...prices),
                    priceMax: Math.max(...prices),
                    priceMove: prices[prices.length - 1] - prices[0],
                    strike,
                    endedAboveStrike: prices[prices.length - 1] >= strike,
                    avgProb: probs.reduce((s, v) => s + v, 0) / probs.length,
                    avgConf: confs.reduce((s, v) => s + v, 0) / confs.length,
                    directionFlips: dirFlips,
                    finalDirection: lastTick.direction,
                    predicted: pred ? pred.predictedDirection : null,
                    correct: pred ? pred.correct : null,
                    traded: periodTrades.length > 0,
                    pnlCents: settle ? settle.pnlCents : null,
                    strategy: periodTrades.find(t => t.strategy)?.strategy || null,
                });
            } catch (e) { /* skip */ }
        }

        res.json({
            summary: {
                totalPredictions: graded.length,
                predictionAccuracy: graded.length > 0 ? (predCorrect / graded.length * 100).toFixed(1) : '0',
                totalTrades: settles.length,
                wins: wins.length,
                losses: losses.length,
                winRate: settles.length > 0 ? (wins.length / settles.length * 100).toFixed(1) : '0',
                totalPnlCents,
                avgPnlPerTrade: settles.length > 0 ? Math.round(totalPnlCents / settles.length) : 0,
                maxWinStreak,
                maxLossStreak,
                avgEntryPrice: Math.round(avgEntry),
                avgContracts: Math.round(avgContracts),
                earlyExits: earlyExits.length,
                flips: flipTrades.length,
            },
            betVsSkip: {
                betPeriods: betPeriods.length,
                betCorrect,
                betAccuracy: betPeriods.length > 0 ? (betCorrect / betPeriods.length * 100).toFixed(1) : '0',
                skipPeriods: skipPeriods.length,
                skipCorrect,
                skipAccuracy: skipPeriods.length > 0 ? (skipCorrect / skipPeriods.length * 100).toFixed(1) : '0',
            },
            convictionTrades,
            winByStrategy,
            winByDirection,
            winByHour,
            dailyStats,
            cumulativePnl,
            cycleDetails,
        });
    } catch (e) {
        console.error('[auto-bettor-analysis] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Snapshot / Cycle Analysis API Endpoints ──────────────────

app.get('/api/snapshots/predictions', async (req, res) => {
    try {
        const options = {};
        if (req.query.periodKey) options.periodKey = req.query.periodKey;
        if (req.query.type) options.snapshotType = req.query.type;
        if (req.query.correct !== undefined) options.wasCorrect = req.query.correct === 'true';
        if (req.query.since) options.since = req.query.since;
        options.limit = parseInt(req.query.limit || '100', 10);
        const rows = await db.getPredictionSnapshots(options);
        res.json({ count: rows.length, snapshots: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snapshots/prices/:periodKey', async (req, res) => {
    try {
        const rows = await db.getPriceHistory(req.params.periodKey);
        res.json({ count: rows.length, prices: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snapshots/orderbook/:periodKey', async (req, res) => {
    try {
        const rows = await db.getOrderbookHistory(req.params.periodKey);
        res.json({ count: rows.length, orderbooks: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snapshots/market-data', async (req, res) => {
    try {
        const options = {};
        if (req.query.periodKey) options.periodKey = req.query.periodKey;
        options.limit = parseInt(req.query.limit || '100', 10);
        const rows = await db.getMarketDataHistory(options);
        res.json({ count: rows.length, marketData: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snapshots/cycle/:periodKey', async (req, res) => {
    try {
        const analysis = await db.getCycleAnalysis(req.params.periodKey);
        if (!analysis) return res.status(404).json({ error: 'Period not found' });
        res.json(analysis);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Account Balance Tracking Endpoints ────────────────────────

app.get('/api/trading/balance-history', async (req, res) => {
    try {
        const options = {};
        if (req.query.environment) options.environment = req.query.environment;
        if (req.query.since) options.since = req.query.since;
        options.limit = parseInt(req.query.limit || '500', 10);
        const history = await db.getBalanceHistory(options);
        res.json({ history });
    } catch (e) {
        console.error('[api] Balance history error:', e.message);
        res.status(500).json({ error: 'Failed to load balance history' });
    }
});

app.get('/api/trading/balance-summary', async (req, res) => {
    try {
        const summary = await db.getBalanceSummary();
        res.json({ accounts: summary });
    } catch (e) {
        console.error('[api] Balance summary error:', e.message);
        res.status(500).json({ error: 'Failed to load balance summary' });
    }
});

app.use(express.json());

app.post('/api/trading/kill-switch', (req, res) => {
    const active = req.body?.active !== false; // default to activating
    tradeExecutor.setKillSwitch(active);
    res.json({ killSwitch: active, message: active ? 'Kill switch ACTIVATED — all trading halted' : 'Kill switch deactivated' });
});

app.post('/api/trading/force-bet', async (req, res) => {
    const contracts = req.body?.contracts; // optional override
    const currentPeriod = store.getCurrentPeriod();
    const prediction = currentPeriod?.updatedPrediction || currentPeriod?.originalPrediction;
    const ticker = state.kalshiTicker;
    const strike = state.kalshiStrike;
    const periodKey = state.periodKey;

    if (!prediction) return res.status(400).json({ error: 'No prediction available for current period' });
    if (!ticker) return res.status(400).json({ error: 'No Kalshi ticker available' });
    if (!strike) return res.status(400).json({ error: 'No strike price available' });

    try {
        const result = await tradeExecutor.forceBet(prediction, ticker, strike, periodKey, contracts || null);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, reason: err.message });
    }
});

app.post('/api/trading/press-bet', async (req, res) => {
    const contracts = req.body?.contracts || null;
    try {
        const result = await tradeExecutor.pressBet(contracts);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, reason: err.message });
    }
});

app.post('/api/trading/force-sell', async (req, res) => {
    try {
        const result = await tradeExecutor.forceSell();
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, reason: err.message });
    }
});

app.post('/api/trading/config', (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Invalid config' });
    }
    const cfg = tradeExecutor.config;
    const allowed = ['baseContracts', 'maxPositionContracts', 'convictionMaxContracts', 'maxDailyLossCents', 'maxDailyTrades'];
    const applied = {};
    for (const key of allowed) {
        if (updates[key] !== undefined) {
            const val = parseInt(updates[key], 10);
            if (!isNaN(val) && val > 0) {
                cfg[key] = val;
                applied[key] = val;
            }
        }
    }
    console.log('[server] Config updated:', applied);
    res.json({ ok: true, config: { baseContracts: cfg.baseContracts, maxPositionContracts: cfg.maxPositionContracts, convictionMaxContracts: cfg.convictionMaxContracts, maxDailyLossCents: cfg.maxDailyLossCents, maxDailyTrades: cfg.maxDailyTrades } });
});

app.post('/api/trading/mode', (req, res) => {
    const paperMode = req.body?.paperMode !== false;
    tradeExecutor.setPaperMode(paperMode);
    res.json({ paperMode, message: `Trading mode set to ${paperMode ? 'PAPER' : 'LIVE'}` });
});

app.get('/api/trading/environment', (req, res) => {
    res.json({ environment: kalshiAuth.getEnvironment(), configured: kalshiAuth.isConfigured() });
});

app.post('/api/trading/environment', (req, res) => {
    const env = req.body?.environment;
    if (env !== 'demo' && env !== 'production') {
        return res.status(400).json({ error: "environment must be 'demo' or 'production'" });
    }
    try {
        tradeExecutor.setKillSwitch(true);
        kalshiAuth.setEnvironment(env);
        tradeExecutor.resetState();
        // SAFETY: switching to production forces paper mode on — user must explicitly disable it
        if (env === 'production') {
            tradeExecutor.setPaperMode(true);
        }
        const configured = kalshiAuth.isConfigured();
        const safetyNote = env === 'production' ? ' Paper mode enabled — disable manually to trade with real money.' : '';
        res.json({
            environment: env,
            configured,
            message: `Switched to ${env.toUpperCase()}${configured ? '' : ' (credentials not configured!)'}. Kill switch activated — re-enable trading manually.${safetyNote}`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Force Bet / Press Bet / Force Sell ──
app.post('/api/trading/force-bet', express.json(), async (req, res) => {
    const contracts = req.body?.contracts;
    const currentPeriod = store.getCurrentPeriod();
    const prediction = currentPeriod?.updatedPrediction || currentPeriod?.originalPrediction;
    const ticker = state.kalshiTicker;
    const strike = state.kalshiStrike;
    const periodKey = state.periodKey;

    if (!prediction) return res.status(400).json({ error: 'No prediction available for current period' });
    if (!ticker) return res.status(400).json({ error: 'No Kalshi ticker available' });
    if (!strike) return res.status(400).json({ error: 'No strike price available' });

    try {
        const result = await tradeExecutor.forceBet(prediction, ticker, strike, periodKey, contracts || null);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, reason: err.message });
    }
});

app.post('/api/trading/press-bet', express.json(), async (req, res) => {
    const contracts = req.body?.contracts;
    const currentPeriod = store.getCurrentPeriod();
    const prediction = currentPeriod?.updatedPrediction || currentPeriod?.originalPrediction;
    const ticker = state.kalshiTicker;
    const strike = state.kalshiStrike;
    const periodKey = state.periodKey;

    if (!prediction) return res.status(400).json({ error: 'No prediction available' });
    if (!ticker) return res.status(400).json({ error: 'No Kalshi ticker available' });

    try {
        const result = await tradeExecutor.pressBet(prediction, ticker, strike, periodKey, contracts || null);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, reason: err.message });
    }
});

app.post('/api/trading/force-sell', express.json(), async (req, res) => {
    try {
        const result = await tradeExecutor.forceSell();
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, reason: err.message });
    }
});

app.get('/api/trading/config', (req, res) => {
    res.json(tradeExecutor.config);
});

app.post('/api/trading/config', express.json(), (req, res) => {
    try {
        const updates = req.body;
        Object.assign(tradeExecutor.config, updates);
        res.json({ ok: true, config: tradeExecutor.config });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Paper balance management ──
app.get('/api/trading/paper-balance', (req, res) => {
    res.json(tradeExecutor.getPaperBalances());
});

app.post('/api/trading/paper-balance', (req, res) => {
    const { action, amount, environment } = req.body || {};
    const env = environment || kalshiAuth.getEnvironment();
    const cents = Math.round((parseFloat(amount) || 0) * 100);
    if (cents <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    let newBalance;
    if (action === 'set') {
        newBalance = tradeExecutor.setPaperBalance(env, cents);
    } else {
        // default to 'add'
        newBalance = tradeExecutor.addPaperBalance(env, cents);
    }
    res.json({ environment: env, balanceCents: newBalance, balanceDollars: (newBalance / 100).toFixed(2) });
});

// ═══════════════════════════════════════════════════════════════
// DECISION LOG API — Read decision logs for analysis
// ═══════════════════════════════════════════════════════════════

app.get('/api/logs', (req, res) => {
    const files = decisionLog.listLogs();
    res.json({ files, logDir: decisionLog.LOG_DIR });
});

app.get('/api/logs/today', (req, res) => {
    const content = decisionLog.readTodaysLog();
    const lines = content.trim().split('\n').filter(l => l);
    const parsed = [];
    for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch (e) { parsed.push({ raw: line }); }
    }
    res.json({ date: new Date().toISOString().slice(0, 10), entries: parsed, count: parsed.length });
});

app.get('/api/logs/:date', (req, res) => {
    const content = decisionLog.readLog(req.params.date);
    const lines = content.trim().split('\n').filter(l => l);
    const parsed = [];
    for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch (e) { parsed.push({ raw: line }); }
    }
    res.json({ date: req.params.date, entries: parsed, count: parsed.length });
});

// Filter by event type: /api/logs/today/filter?event=PREDICTION&event=TRADE
app.get('/api/logs/today/filter', (req, res) => {
    const eventTypes = [].concat(req.query.event || []);
    const content = decisionLog.readTodaysLog();
    const lines = content.trim().split('\n').filter(l => l);
    const parsed = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (eventTypes.length === 0 || eventTypes.includes(entry.event)) {
                parsed.push(entry);
            }
        } catch (e) { /* skip */ }
    }
    res.json({ date: new Date().toISOString().slice(0, 10), filter: eventTypes, entries: parsed, count: parsed.length });
});

// Summary: counts by event type + win/loss stats
app.get('/api/logs/today/summary', (req, res) => {
    const content = decisionLog.readTodaysLog();
    const lines = content.trim().split('\n').filter(l => l);
    const counts = {};
    let wins = 0, losses = 0, totalPnl = 0;
    const bets = [], skips = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            counts[entry.event] = (counts[entry.event] || 0) + 1;
            if (entry.event === 'SETTLEMENT') {
                if (entry.result === 'WIN') wins++;
                else losses++;
            }
            if (entry.event === 'PREDICTION' && entry.betDecision === 'BET') bets.push(entry);
            if (entry.event === 'PREDICTION' && entry.betDecision === 'SKIP') skips.push(entry);
        } catch (e) { /* skip */ }
    }
    const skipReasons = {};
    for (const s of skips) {
        const reason = s.skipReason || 'unknown';
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
    }
    res.json({
        date: new Date().toISOString().slice(0, 10),
        totalEntries: lines.length,
        eventCounts: counts,
        tradingStats: { bets: bets.length, skips: skips.length, wins, losses, winRate: wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) + '%' : 'N/A' },
        skipReasons,
    });
});

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — Save state on exit
// ═══════════════════════════════════════════════════════════════

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, saving state...');
    store.forceSave();
    const db = require('./db');
    await db.close().catch(() => {});
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, saving state...');
    store.forceSave();
    const db = require('./db');
    await db.close().catch(() => {});
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception, saving state:', err.message);
    store.forceSave();
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection, saving state:', reason);
    store.forceSave();
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

// Load persisted prediction state before starting
store.load();

// Initialize PostgreSQL database, restore trade history & store state, then start server
tradeExecutor.initFromDB().then(async () => {
    console.log('[db] Database initialization complete');
    // Load persistent store data from DB (fills gaps if JSON file was wiped by deploy)
    await store.loadFromDB();
}).catch(e => {
    console.error('[db] Database initialization failed (continuing without DB):', e.message);
});

server.listen(PORT, () => {
    if (!API_KEY) {
        console.warn('⚠️  WARNING: DASHBOARD_API_KEY is not set — dashboard has NO authentication!');
        console.warn('   Set DASHBOARD_API_KEY env var to protect your trading endpoints.');
    } else {
        console.log('🔒 Dashboard API key authentication is ENABLED');
    }
    console.log(`BTC Predictor server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Health:   http://localhost:${PORT}/api/health`);
    console.log(`Predictions: http://localhost:${PORT}/api/predictions`);
    console.log(`History: http://localhost:${PORT}/api/history`);
    console.log(`Trading: http://localhost:${PORT}/api/trading/status`);
    console.log(`Trading mode: ${tradeExecutor.config.paperMode ? 'PAPER (simulated)' : 'LIVE'}${kalshiAuth.isConfigured() ? '' : ' | Kalshi API not configured'}`);
    console.log(`Kalshi market data: PUBLIC API → ${KALSHI_MARKET_API}`);
    console.log(`Kalshi trading: ${kalshiAuth.getEnvironment().toUpperCase()} → ${kalshiAuth.getBaseUrl()}`);
    if (kalshiAuth.getEnvironment() === 'production' && !tradeExecutor.config.paperMode) {
        console.warn('⚠️  WARNING: LIVE TRADING WITH REAL MONEY IS ACTIVE. Set KALSHI_ENV=demo or PAPER_MODE=true to disable.');
    }

    // Fetch loop: setTimeout recursion prevents overlapping when APIs are slow
    async function fetchLoop() {
        await fetchAllData();
        setTimeout(fetchLoop, 2000);
    }
    fetchLoop();
});
