'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

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
async function fetchKalshiData() {
    try {
        // Try status=open first
        let data = await fetchJSON(
            'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=100'
        );
        let markets = data ? (data.markets || []) : [];

        // Check if any have future close time
        const now = new Date();
        const hasFuture = markets.some(m => new Date(m.close_time || m.expiration_time) > now);

        // Fallback to unfiltered if needed
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

        // Get detailed market data
        let detailedMarket = best;
        try {
            const detail = await fetchJSON(
                'https://api.elections.kalshi.com/trade-api/v2/markets/' + best.ticker
            );
            if (detail && detail.market) detailedMarket = detail.market;
        } catch (e) {}

        // Extract strike
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

// ── Binance Order Book ──
async function fetchOrderBook() {
    return await fetchJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20');
}

// ── Binance Recent Trades ──
async function fetchRecentTrades() {
    return await fetchJSON('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=200');
}

// ── Binance Funding Rate ──
async function fetchFundingRate() {
    const data = await fetchJSON('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1');
    if (data && data.length > 0) return parseFloat(data[0].fundingRate);
    return null;
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

function getPeriodKey() {
    const now = new Date();
    const mins = now.getMinutes();
    const periodStart = Math.floor(mins / 15) * 15;
    return now.getHours() + ':' + periodStart;
}

// ═══════════════════════════════════════════════════════════════
// MAIN FETCH LOOP — Runs every 10 seconds
// ═══════════════════════════════════════════════════════════════

async function fetchAllData() {
    console.log(`\n--- Fetch cycle @ ${new Date().toLocaleTimeString()} ---`);
    try {
        // Parallel fetch all data sources
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

            // Fallback: use BRTI as strike if market exists but strike missing
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

        // Broadcast to all connected clients
        broadcast({
            type: 'data',
            ...state
        });

        console.log(`Broadcast: BRTI=$${state.brtiPrice?.toFixed(2)} | Kalshi=${state.kalshiTicker || 'none'} | Strike=$${state.kalshiStrike || 'none'} | ${wss.clients.size} clients`);

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

wss.on('connection', (ws) => {
    console.log(`Client connected (total: ${wss.clients.size})`);

    // Send current state immediately
    ws.send(JSON.stringify({
        type: 'data',
        ...state
    }));

    ws.on('close', () => {
        console.log(`Client disconnected (total: ${wss.clients.size})`);
    });

    ws.on('error', (e) => {
        console.error('WebSocket error:', e.message);
    });
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        lastUpdate: state.lastUpdate,
        brtiPrice: state.brtiPrice,
        kalshiTicker: state.kalshiTicker,
        clients: wss.clients.size
    });
});

app.get('/api/state', (req, res) => {
    res.json(state);
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BTC Predictor server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Health:   http://localhost:${PORT}/api/health`);

    // Initial fetch
    fetchAllData();

    // Fetch every 10 seconds
    setInterval(fetchAllData, 10000);
});
