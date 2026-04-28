'use strict';

// ═══════════════════════════════════════════════════════════════
// EXTERNAL SIGNALS — Macro & on-chain data for BTC prediction
// Fetches S&P futures, DXY, VIX, stablecoins, gold, yields,
// and Bitcoin network stats. Each source cached independently.
// ═══════════════════════════════════════════════════════════════

const LOG_PREFIX = '[external-signals]';

// ── Generic fetch with timeout (mirrors server.js fetchJSON) ──
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

// ── Cache helper ──
function makeCache(ttlMs) {
    return { data: null, lastFetch: 0, ttl: ttlMs };
}

function isCacheValid(cache) {
    return cache.data !== null && (Date.now() - cache.lastFetch) < cache.ttl;
}

// ═══════════════════════════════════════════════════════════════
// Yahoo Finance chart helper
// ═══════════════════════════════════════════════════════════════

function parseYahooChart(json) {
    if (!json || !json.chart || !json.chart.result || !json.chart.result[0]) return null;
    const result = json.chart.result[0];
    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quotes = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const closes = quotes.close || [];

    // Current price from meta
    const price = meta.regularMarketPrice || null;
    const prevClose = meta.chartPreviousClose || meta.previousClose || null;

    // Build arrays of valid (timestamp, close) pairs
    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null) {
            points.push({ t: timestamps[i], c: closes[i] });
        }
    }

    return { price, prevClose, points };
}

function computeReturns(points, price) {
    if (!points || points.length === 0 || price == null) return {};
    const now = Date.now() / 1000;

    // Find price ~15 min ago and ~1h ago
    let price15m = null;
    let price1h = null;
    for (let i = points.length - 1; i >= 0; i--) {
        const age = now - points[i].t;
        if (!price15m && age >= 900) price15m = points[i].c;  // 15 min
        if (!price1h && age >= 3600) price1h = points[i].c;   // 1 hour
    }

    const change15m = price15m ? (price - price15m) / price15m : null;
    const change1h = price1h ? (price - price1h) / price1h : null;

    return { change15m, change1h };
}

// ═══════════════════════════════════════════════════════════════
// 1. S&P 500 / ES Futures
// ═══════════════════════════════════════════════════════════════

const spCache = makeCache(30000); // 30 seconds

async function fetchSPFutures() {
    if (isCacheValid(spCache)) return spCache.data;
    try {
        const data = await fetchJSON(
            'https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=5m&range=1d'
        );
        const parsed = parseYahooChart(data);
        if (!parsed || parsed.price == null) return spCache.data;

        const { change15m, change1h } = computeReturns(parsed.points, parsed.price);

        // Momentum: simple slope of last 6 data points (~30 min at 5m interval)
        let momentum = 0;
        if (parsed.points.length >= 6) {
            const recent = parsed.points.slice(-6);
            const first = recent[0].c;
            const last = recent[recent.length - 1].c;
            momentum = first > 0 ? (last - first) / first : 0;
        }

        spCache.data = {
            price: parsed.price,
            change1h: change1h,
            change15m: change15m,
            momentum: momentum,
            timestamp: Date.now()
        };
        spCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} S&P futures fetch error: ${e.message}`);
    }
    return spCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 2. DXY (US Dollar Index)
// ═══════════════════════════════════════════════════════════════

const dxyCache = makeCache(60000); // 60 seconds

async function fetchDXY() {
    if (isCacheValid(dxyCache)) return dxyCache.data;
    try {
        const data = await fetchJSON(
            'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=5m&range=1d'
        );
        const parsed = parseYahooChart(data);
        if (!parsed || parsed.price == null) return dxyCache.data;

        const { change1h } = computeReturns(parsed.points, parsed.price);
        const change24h = parsed.prevClose
            ? (parsed.price - parsed.prevClose) / parsed.prevClose
            : null;

        // Trend: normalized change (clamped -1 to 1)
        let trend = 0;
        if (change24h != null) {
            // DXY moves ~0.5% on a strong day; normalize so +-1% maps to +-1
            trend = Math.max(-1, Math.min(1, change24h / 0.01));
        }

        dxyCache.data = {
            price: parsed.price,
            change1h: change1h,
            change24h: change24h,
            trend: trend,
            timestamp: Date.now()
        };
        dxyCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} DXY fetch error: ${e.message}`);
    }
    return dxyCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 3. VIX (Volatility Index)
// ═══════════════════════════════════════════════════════════════

const vixCache = makeCache(60000); // 60 seconds

function vixRegime(level) {
    if (level < 15) return 'low';
    if (level < 25) return 'normal';
    if (level < 35) return 'high';
    return 'extreme';
}

async function fetchVIX() {
    if (isCacheValid(vixCache)) return vixCache.data;
    try {
        const data = await fetchJSON(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=5m&range=1d'
        );
        const parsed = parseYahooChart(data);
        if (!parsed || parsed.price == null) return vixCache.data;

        const change = parsed.prevClose
            ? (parsed.price - parsed.prevClose) / parsed.prevClose
            : null;

        vixCache.data = {
            level: parsed.price,
            change: change,
            regime: vixRegime(parsed.price),
            timestamp: Date.now()
        };
        vixCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} VIX fetch error: ${e.message}`);
    }
    return vixCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 4. Stablecoin Market Cap (CoinGecko)
// ═══════════════════════════════════════════════════════════════

const stablecoinCache = makeCache(300000); // 5 minutes

async function fetchStablecoinFlow() {
    if (isCacheValid(stablecoinCache)) return stablecoinCache.data;
    try {
        const data = await fetchJSON(
            'https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin&vs_currencies=usd&include_market_cap=true&include_24hr_change=true',
            10000
        );
        if (!data) return stablecoinCache.data;

        const usdtMcap = data.tether ? data.tether.usd_market_cap || 0 : 0;
        const usdcMcap = data['usd-coin'] ? data['usd-coin'].usd_market_cap || 0 : 0;
        const usdtChange = data.tether ? data.tether.usd_24h_change || 0 : 0;
        const usdcChange = data['usd-coin'] ? data['usd-coin'].usd_24h_change || 0 : 0;

        const totalMcap = usdtMcap + usdcMcap;
        // Weighted average change
        const mcapChange24h = totalMcap > 0
            ? (usdtChange * usdtMcap + usdcChange * usdcMcap) / totalMcap
            : 0;

        stablecoinCache.data = {
            usdtMcap: usdtMcap,
            usdcMcap: usdcMcap,
            totalMcap: totalMcap,
            mcapChange24h: mcapChange24h,
            timestamp: Date.now()
        };
        stablecoinCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} Stablecoin flow fetch error: ${e.message}`);
    }
    return stablecoinCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 5. Bitcoin Network Stats (blockchain.com)
// ═══════════════════════════════════════════════════════════════

const onChainCache = makeCache(600000); // 10 minutes

async function fetchOnChainMetrics() {
    if (isCacheValid(onChainCache)) return onChainCache.data;
    try {
        const data = await fetchJSON('https://api.blockchain.info/stats', 10000);
        if (!data) return onChainCache.data;

        onChainCache.data = {
            hashRate: data.hash_rate || null,
            difficulty: data.difficulty || null,
            txCount24h: data.n_tx || null,
            btcMined24h: data.n_blocks_mined != null
                ? data.n_blocks_mined * 3.125  // current block reward
                : null,
            timestamp: Date.now()
        };
        onChainCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} On-chain metrics fetch error: ${e.message}`);
    }
    return onChainCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 6. Gold Price (GC=F via Yahoo Finance)
// ═══════════════════════════════════════════════════════════════

const goldCache = makeCache(60000); // 60 seconds

async function fetchGoldPrice() {
    if (isCacheValid(goldCache)) return goldCache.data;
    try {
        const data = await fetchJSON(
            'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d'
        );
        const parsed = parseYahooChart(data);
        if (!parsed || parsed.price == null) return goldCache.data;

        const { change1h } = computeReturns(parsed.points, parsed.price);
        const change24h = parsed.prevClose
            ? (parsed.price - parsed.prevClose) / parsed.prevClose
            : null;

        goldCache.data = {
            price: parsed.price,
            change1h: change1h,
            change24h: change24h,
            timestamp: Date.now()
        };
        goldCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} Gold price fetch error: ${e.message}`);
    }
    return goldCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 7. Treasury Yields (^TNX = 10Y, ^FVX = 5Y as proxy for 2Y)
// ═══════════════════════════════════════════════════════════════

const yieldsCache = makeCache(300000); // 5 minutes

async function fetchTreasuryYields() {
    if (isCacheValid(yieldsCache)) return yieldsCache.data;
    try {
        const [tnxData, irxData] = await Promise.all([
            fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=5m&range=1d'),
            fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=5m&range=1d')
        ]);

        const tnx = parseYahooChart(tnxData);
        const irx = parseYahooChart(irxData);

        const yield10y = tnx && tnx.price != null ? tnx.price : null;
        const yield2y = irx && irx.price != null ? irx.price : null;

        // Spread: 10Y minus short-term (inverted = recession signal)
        const spread = (yield10y != null && yield2y != null) ? yield10y - yield2y : null;

        yieldsCache.data = {
            yield10y: yield10y,
            yield2y: yield2y,
            spread: spread,
            timestamp: Date.now()
        };
        yieldsCache.lastFetch = Date.now();
    } catch (e) {
        console.error(`${LOG_PREFIX} Treasury yields fetch error: ${e.message}`);
    }
    return yieldsCache.data;
}

// ═══════════════════════════════════════════════════════════════
// 8. Master fetch — all signals in parallel
// ═══════════════════════════════════════════════════════════════

async function fetchAllExternalSignals() {
    const results = await Promise.allSettled([
        fetchSPFutures(),
        fetchDXY(),
        fetchVIX(),
        fetchStablecoinFlow(),
        fetchOnChainMetrics(),
        fetchGoldPrice(),
        fetchTreasuryYields()
    ]);

    const extract = (r) => r.status === 'fulfilled' ? r.value : null;

    return {
        spFutures: extract(results[0]),
        dxy: extract(results[1]),
        vix: extract(results[2]),
        stablecoin: extract(results[3]),
        onChain: extract(results[4]),
        gold: extract(results[5]),
        treasury: extract(results[6]),
        timestamp: Date.now()
    };
}

// ═══════════════════════════════════════════════════════════════
// Signal Summary — compact object for prediction engine
// ═══════════════════════════════════════════════════════════════

function clamp(val, min, max) {
    if (val == null) return 0;
    return Math.max(min, Math.min(max, val));
}

function getSignalSummary() {
    const sp = spCache.data;
    const dxy = dxyCache.data;
    const vix = vixCache.data;
    const stable = stablecoinCache.data;
    const gold = goldCache.data;
    const yields = yieldsCache.data;
    const chain = onChainCache.data;

    // S&P momentum: normalize ~0.3% move to +-1
    const spMomentum = sp
        ? clamp(sp.momentum / 0.003, -1, 1)
        : 0;

    // DXY trend: already normalized in fetch
    const dxyTrend = dxy ? clamp(dxy.trend, -1, 1) : 0;

    // VIX
    const vixRegimeVal = vix ? vix.regime : 'normal';
    const vixLevel = vix ? vix.level : 20;

    // Stablecoin flow: positive mcap change = inflow = bullish
    // Normalize: 0.5% daily change => +-1
    const stablecoinFlow = stable
        ? clamp(stable.mcapChange24h / 0.5, -1, 1)
        : 0;

    // Gold trend: normalize ~1% daily move to +-1
    const goldTrend = gold && gold.change24h != null
        ? clamp(gold.change24h / 0.01, -1, 1)
        : 0;

    // Yield spread (10Y - short term)
    const yieldSpread = yields ? yields.spread : null;

    // Hash rate trend: we only have a snapshot, so just flag availability
    // A more sophisticated approach would compare to historical average
    const hashRateTrend = 0; // placeholder — needs historical data to compute

    // ── Composite risk appetite ──
    // Positive = risk-on (bullish BTC), negative = risk-off
    let riskAppetite = 0;
    let factors = 0;

    // S&P up = risk on
    if (sp) { riskAppetite += spMomentum * 0.3; factors++; }
    // DXY down = risk on (dollar weakness = BTC bullish)
    if (dxy) { riskAppetite += (-dxyTrend) * 0.2; factors++; }
    // Low VIX = risk on
    if (vix) {
        const vixScore = vix.level < 15 ? 0.5
            : vix.level < 20 ? 0.2
            : vix.level < 25 ? 0
            : vix.level < 30 ? -0.3
            : -0.6;
        riskAppetite += vixScore * 0.25;
        factors++;
    }
    // Stablecoin inflows = bullish
    if (stable) { riskAppetite += stablecoinFlow * 0.15; factors++; }
    // Gold up can mean both risk-off and inflation hedge (weak signal for BTC)
    if (gold) { riskAppetite += goldTrend * 0.1; factors++; }

    if (factors > 0) riskAppetite = clamp(riskAppetite / factors * factors, -1, 1);

    return {
        spMomentum: spMomentum,
        dxyTrend: dxyTrend,
        vixRegime: vixRegimeVal,
        vixLevel: vixLevel,
        stablecoinFlow: stablecoinFlow,
        goldTrend: goldTrend,
        yieldSpread: yieldSpread,
        hashRateTrend: hashRateTrend,
        riskAppetite: clamp(riskAppetite, -1, 1),
        timestamp: Date.now()
    };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
    fetchSPFutures,
    fetchDXY,
    fetchVIX,
    fetchStablecoinFlow,
    fetchOnChainMetrics,
    fetchGoldPrice,
    fetchTreasuryYields,
    fetchAllExternalSignals,
    getSignalSummary
};
