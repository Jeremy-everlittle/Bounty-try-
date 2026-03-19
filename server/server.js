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

// Serve static frontend
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

    // Filter outliers > 0.25% from median
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    const median = sorted[Math.floor(sorted.length / 2)].price;
    const filtered = prices.filter(p => Math.abs(p.price - median) / median < 0.25);
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
                    engine.gradeBayesianPrediction(state.brtiPrice, periodKey);
                    engine.gradePreviousPrediction(state.brtiPrice, periodKey);

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
                        tradeExecutor.onPeriodEnd({ correct: lastGraded.correct, periodKey: lastGraded.periodKey });
                    } else {
                        console.warn(`[server] No graded prediction found for period ${currentPeriod.periodKey} — forcing onPeriodEnd with price-based grading`);
                        // Fallback: grade based on current price vs strike
                        if (currentPeriod.periodStartPrice && state.brtiPrice) {
                            const correct = currentPeriod.originalPrediction ?
                                (currentPeriod.originalPrediction.predictedPrice >= currentPeriod.periodStartPrice) === (state.brtiPrice >= currentPeriod.periodStartPrice)
                                : false;
                            tradeExecutor.onPeriodEnd({ correct, periodKey: currentPeriod.periodKey });
                        }
                    }
                }

                // New period - wait for Kalshi strike
                if (state.kalshiStrike) {
                    const marketData = {
                        currentPrice: state.brtiPrice,
                        history: state.history,
                        orderBook: state.orderBook,
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

                // ── Auto-trade: evaluate late entry ──
                tradeExecutor.onNewPrediction(prediction, state.kalshiTicker, state.kalshiStrike, periodKey).catch(e => console.error('[trade-executor] Late entry error:', e.message));
            } else if (currentPeriod.originalPrediction && state.kalshiStrike) {
                // Same period - update prediction
                const marketData = {
                    currentPrice: state.brtiPrice,
                    history: state.history,
                    orderBook: state.orderBook,
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
            kalshiEnvironment: kalshiAuth.getEnvironment()
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

wss.on('connection', (ws) => {
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
                console.log('Client requested history clear');
                store.getState().predictionLog = [];
                store.save();
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

app.get('/api/error-analysis', (req, res) => {
    res.json(engine.getErrorSummary());
});

app.get('/api/learned-corrections', (req, res) => {
    res.json(engine.getLearnedCorrections());
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

app.use(express.json());

app.post('/api/trading/kill-switch', (req, res) => {
    const active = req.body?.active !== false; // default to activating
    tradeExecutor.setKillSwitch(active);
    res.json({ killSwitch: active, message: active ? 'Kill switch ACTIVATED — all trading halted' : 'Kill switch deactivated' });
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
        const configured = kalshiAuth.isConfigured();
        res.json({
            environment: env,
            configured,
            message: `Switched to ${env.toUpperCase()}${configured ? '' : ' (credentials not configured!)'}. Kill switch activated — re-enable trading manually.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

process.on('SIGTERM', () => {
    console.log('SIGTERM received, saving state...');
    store.forceSave();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, saving state...');
    store.forceSave();
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

server.listen(PORT, () => {
    console.log(`BTC Predictor server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Health:   http://localhost:${PORT}/api/health`);
    console.log(`Predictions: http://localhost:${PORT}/api/predictions`);
    console.log(`History: http://localhost:${PORT}/api/history`);
    console.log(`Trading: http://localhost:${PORT}/api/trading/status`);
    console.log(`Trading mode: ${tradeExecutor.config.paperMode ? 'PAPER (simulated)' : 'LIVE'}${kalshiAuth.isConfigured() ? '' : ' | Kalshi API not configured'}`);
    console.log(`Kalshi market data: PUBLIC API → ${KALSHI_MARKET_API}`);
    console.log(`Kalshi trading: ${kalshiAuth.getEnvironment().toUpperCase()} → ${kalshiAuth.getBaseUrl()}`);

    // Fetch loop: setTimeout recursion prevents overlapping when APIs are slow
    async function fetchLoop() {
        await fetchAllData();
        setTimeout(fetchLoop, 5000);
    }
    fetchLoop();
});
