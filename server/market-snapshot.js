'use strict';

// ═══════════════════════════════════════════════════════════════
// MarketSnapshot — centralized, lazy-caching data container
// Replaces the ad-hoc marketData object with a richer interface
// while remaining backward-compatible via toMarketData().
// ═══════════════════════════════════════════════════════════════

class MarketSnapshot {
    constructor(rawData) {
        this._raw = rawData;
        this._cache = {};
        this._timestamp = Date.now();
    }

    // ── Direct accessors for raw data ──────────────────────────

    get currentPrice() { return this._raw.currentPrice; }
    get history() { return this._raw.history; }
    get orderBook() { return this._raw.orderBook; }
    get kalshiOrderBook() { return this._raw.kalshiOrderBook; }
    get recentTrades() { return this._raw.recentTrades; }
    get fundingRate() { return this._raw.fundingRate; }
    get ethPrice() { return this._raw.ethPrice; }
    get ethPriceHistory() { return this._raw.ethPriceHistory; }
    get openInterest() { return this._raw.openInterest; }
    get openInterestHistory() { return this._raw.openInterestHistory; }
    get liquidations() { return this._raw.liquidations; }
    get fearGreed() { return this._raw.fearGreed; }
    get macroEvent() { return this._raw.macroEvent; }
    get longShortRatio() { return this._raw.longShortRatio; }
    get externalSignals() { return this._raw.externalSignals || null; }

    // ── Lazy-computed derived fields with caching ──────────────

    get prices() {
        if (!this._cache.prices) {
            this._cache.prices = (this.history || []).map(h => h.close || h.price || h[4]);
        }
        return this._cache.prices;
    }

    get returns() {
        if (!this._cache.returns) {
            const p = this.prices;
            this._cache.returns = p.slice(1).map((v, i) => (v - p[i]) / p[i]);
        }
        return this._cache.returns;
    }

    get volumes() {
        if (!this._cache.volumes) {
            this._cache.volumes = (this.history || []).map(h => h.volume || h[5] || 0);
        }
        return this._cache.volumes;
    }

    get normalizedVolumes() {
        // Z-score normalized volumes
        if (!this._cache.normVols) {
            const vols = this.volumes;
            const mean = vols.reduce((a, b) => a + b, 0) / (vols.length || 1);
            const std = Math.sqrt(vols.reduce((a, b) => a + (b - mean) ** 2, 0) / (vols.length || 1)) || 1;
            this._cache.normVols = vols.map(v => (v - mean) / std);
        }
        return this._cache.normVols;
    }

    get tradesBySize() {
        // Bucket recent trades by size
        if (!this._cache.tradesBySize) {
            const trades = this.recentTrades || [];
            const small = [], medium = [], large = [];
            for (const t of trades) {
                const qty = parseFloat(t.q || t.quantity || 0);
                if (qty < 0.01) small.push(t);
                else if (qty < 0.1) medium.push(t);
                else large.push(t);
            }
            this._cache.tradesBySize = { small, medium, large };
        }
        return this._cache.tradesBySize;
    }

    get liquidationProfile() {
        // Analyze liquidation size distribution
        if (!this._cache.liqProfile) {
            const liqs = this.liquidations || {};
            const bullVol = parseFloat(liqs.bullishVolume || 0);
            const bearVol = parseFloat(liqs.bearishVolume || 0);
            const total = bullVol + bearVol || 1;
            const largeRatio = parseFloat(liqs.largeCount || 0) / (parseFloat(liqs.totalCount || 1));
            this._cache.liqProfile = {
                bullishVolume: bullVol,
                bearishVolume: bearVol,
                imbalance: (bullVol - bearVol) / total,
                largeRatio,
                cascadeRisk: largeRatio > 0.3
            };
        }
        return this._cache.liqProfile;
    }

    get orderbookProfile() {
        // Pre-compute orderbook metrics
        if (!this._cache.obProfile) {
            const ob = this.orderBook || {};
            const bids = ob.bids || [];
            const asks = ob.asks || [];
            const bidVol = bids.reduce((s, [_, v]) => s + parseFloat(v), 0);
            const askVol = asks.reduce((s, [_, v]) => s + parseFloat(v), 0);
            const total = bidVol + askVol || 1;
            const spread = asks.length && bids.length ? parseFloat(asks[0][0]) - parseFloat(bids[0][0]) : 0;
            this._cache.obProfile = {
                bidVolume: bidVol,
                askVolume: askVol,
                imbalance: (bidVol - askVol) / total,
                spread,
                depth5: bids.slice(0, 5).reduce((s, [_, v]) => s + parseFloat(v), 0) +
                        asks.slice(0, 5).reduce((s, [_, v]) => s + parseFloat(v), 0),
                midPrice: bids.length && asks.length ? (parseFloat(bids[0][0]) + parseFloat(asks[0][0])) / 2 : this.currentPrice
            };
        }
        return this._cache.obProfile;
    }

    // ── Cache management ───────────────────────────────────────

    invalidate(field) {
        if (field) delete this._cache[field];
        else this._cache = {};
    }

    // ── Data freshness ─────────────────────────────────────────

    get age() { return Date.now() - this._timestamp; }
    get isStale() { return this.age > 15000; } // 15s

    // ── Backward compatibility ─────────────────────────────────
    // Returns the same plain object shape that server.js assembles,
    // so existing code (prediction-engine, etc.) works unchanged.

    toMarketData() {
        return { ...this._raw };
    }
}

// ═══════════════════════════════════════════════════════════════
// FeatureManager — centralized feature computation with caching
// Replaces scattered signal extraction across prediction-engine
// ═══════════════════════════════════════════════════════════════

class FeatureManager {
    constructor(snapshot, strike, periodMinutesRemaining) {
        this.snapshot = snapshot;
        this.strike = strike;
        this.minutesRemaining = periodMinutesRemaining;
        this._signals = {};
        this._computed = false;
    }

    // ── Compute all signals once ───────────────────────────────

    computeAll() {
        if (this._computed) return this._signals;

        const prices = this.snapshot.prices;
        const currentPrice = this.snapshot.currentPrice;

        // Distance metrics
        this._signals.distanceFromStrike = currentPrice - this.strike;
        this._signals.distancePct = (currentPrice - this.strike) / this.strike;
        this._signals.timeRemaining = this.minutesRemaining / 15; // normalized 0-1

        // Momentum signals
        if (prices.length >= 5) {
            this._signals.momentum5 = (prices[prices.length - 1] - prices[prices.length - 5]) / prices[prices.length - 5];
            this._signals.momentum10 = prices.length >= 10 ? (prices[prices.length - 1] - prices[prices.length - 10]) / prices[prices.length - 10] : 0;
            this._signals.momentum20 = prices.length >= 20 ? (prices[prices.length - 1] - prices[prices.length - 20]) / prices[prices.length - 20] : 0;
        }

        // Volatility signals
        const returns = this.snapshot.returns;
        if (returns.length >= 10) {
            const recentReturns = returns.slice(-20);
            const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
            this._signals.realizedVol = Math.sqrt(recentReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / recentReturns.length);
        }

        // Order flow
        const ob = this.snapshot.orderbookProfile;
        this._signals.orderbookImbalance = ob.imbalance;
        this._signals.spread = ob.spread;
        this._signals.bidAskDepthRatio = ob.bidVolume / (ob.askVolume || 1);

        // Liquidation signals
        const liq = this.snapshot.liquidationProfile;
        this._signals.liquidationImbalance = liq.imbalance;
        this._signals.liquidationCascadeRisk = liq.cascadeRisk ? 1 : 0;
        this._signals.liquidationLargeRatio = liq.largeRatio;

        // Trade size clustering
        const trades = this.snapshot.tradesBySize;
        const totalTrades = (trades.small.length + trades.medium.length + trades.large.length) || 1;
        this._signals.largeTradeRatio = trades.large.length / totalTrades;
        this._signals.tradeConcentration = trades.large.length > 0 ?
            trades.large.reduce((s, t) => s + parseFloat(t.q || 0), 0) /
            (this.snapshot.recentTrades || []).reduce((s, t) => s + parseFloat(t.q || 0), 0) || 0 : 0;

        // ETH divergence
        if (this.snapshot.ethPrice && this.snapshot.ethPriceHistory?.length >= 5) {
            const ethPrices = this.snapshot.ethPriceHistory;
            const ethMom = (ethPrices[ethPrices.length - 1] - ethPrices[ethPrices.length - Math.min(5, ethPrices.length)]) / ethPrices[ethPrices.length - Math.min(5, ethPrices.length)];
            const btcMom = this._signals.momentum5 || 0;
            const denom = Math.abs(btcMom) + Math.abs(ethMom) + 1e-8;
            this._signals.ethDivergence = (btcMom - ethMom) / denom;
            this._signals.ethAgreement = Math.sign(btcMom) === Math.sign(ethMom) ? 1 : -1;
        }

        // External signals (if available)
        const ext = this.snapshot.externalSignals;
        if (ext) {
            this._signals.spMomentum = ext.spMomentum || 0;
            this._signals.dxyTrend = ext.dxyTrend || 0;
            this._signals.vixLevel = ext.vixLevel || 0;
            this._signals.vixRegime = ext.vixRegime || 'normal';
            this._signals.goldTrend = ext.goldTrend || 0;
            this._signals.yieldSpread = ext.yieldSpread || 0;
            this._signals.riskAppetite = ext.riskAppetite || 0;
            this._signals.hashRateTrend = ext.hashRateTrend || 0;
            this._signals.stablecoinFlow = ext.stablecoinFlow || 0;
        }

        // Funding rate signal
        if (this.snapshot.fundingRate) {
            const rate = parseFloat(this.snapshot.fundingRate.rate || this.snapshot.fundingRate || 0);
            this._signals.fundingRate = rate;
            this._signals.fundingExtreme = Math.abs(rate) > 0.001 ? Math.sign(rate) : 0;
        }

        // Fear & Greed
        if (this.snapshot.fearGreed) {
            const fg = parseInt(this.snapshot.fearGreed.value || this.snapshot.fearGreed || 50);
            this._signals.fearGreed = (fg - 50) / 50; // normalize to -1 to 1
            this._signals.fearGreedExtreme = fg < 25 ? -1 : fg > 75 ? 1 : 0;
        }

        // Long/Short ratio
        if (this.snapshot.longShortRatio) {
            const ratio = parseFloat(this.snapshot.longShortRatio.ratio || this.snapshot.longShortRatio || 1);
            this._signals.longShortRatio = ratio;
            this._signals.longShortBias = ratio > 1.5 ? 1 : ratio < 0.67 ? -1 : 0;
        }

        // Time features
        const hour = new Date().getUTCHours();
        this._signals.hourOfDay = hour / 24;
        this._signals.isUSSession = (hour >= 13 && hour <= 21) ? 1 : 0;
        this._signals.isAsiaSession = (hour >= 0 && hour <= 8) ? 1 : 0;

        // Day of week
        const dow = new Date().getUTCDay();
        this._signals.dayOfWeek = dow / 7;
        this._signals.isWeekend = (dow === 0 || dow === 6) ? 1 : 0;

        this._computed = true;
        return this._signals;
    }

    // ── Accessors ──────────────────────────────────────────────

    get(name) {
        if (!this._computed) this.computeAll();
        return this._signals[name];
    }

    getAll() {
        if (!this._computed) this.computeAll();
        return { ...this._signals };
    }

    getMLFeatures(featureNames) {
        if (!this._computed) this.computeAll();
        return featureNames.map(name => this._signals[name] || 0);
    }

    getFeatureRecord() {
        if (!this._computed) this.computeAll();
        return {
            signals: this._signals,
            signalCount: Object.keys(this._signals).length,
            timestamp: Date.now()
        };
    }

    // ── Composite risk score ───────────────────────────────────

    getRiskScore() {
        if (!this._computed) this.computeAll();
        let risk = 0;
        // High VIX = higher risk
        if (this._signals.vixLevel > 30) risk += 0.3;
        else if (this._signals.vixLevel > 25) risk += 0.15;
        // Liquidation cascade risk
        if (this._signals.liquidationCascadeRisk) risk += 0.2;
        // Low liquidity
        if (Math.abs(this._signals.orderbookImbalance) > 0.4) risk += 0.15;
        // Extreme funding
        if (Math.abs(this._signals.fundingRate || 0) > 0.001) risk += 0.1;
        // Weekend lower liquidity
        if (this._signals.isWeekend) risk += 0.1;
        return Math.min(risk, 1.0);
    }
}

module.exports = {
    MarketSnapshot,
    FeatureManager
};
