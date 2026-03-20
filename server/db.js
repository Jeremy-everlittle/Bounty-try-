'use strict';

// ═══════════════════════════════════════════════════════════════
// POSTGRESQL DATABASE — Persistent storage for trade history & stats
// Uses DATABASE_URL from Railway
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');

let pool = null;
let ready = false;
let _lastPriceSnapshotTime = 0;
const PRICE_SNAPSHOT_INTERVAL_MS = 10000; // save price snapshot every 10s (matches fetch cycle)

async function init() {
    if (pool) return pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('[db] DATABASE_URL not set — database disabled');
        return null;
    }

    pool = new Pool({
        connectionString,
        ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });

    // Test connection
    try {
        await pool.query('SELECT 1');
    } catch (e) {
        console.error('[db] Failed to connect to PostgreSQL:', e.message);
        pool = null;
        return null;
    }

    // Create tables
    await pool.query(`
        CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            type TEXT NOT NULL,
            time TEXT NOT NULL,
            ticker TEXT,
            side TEXT,
            contracts INTEGER,
            limit_price INTEGER,
            entry_price INTEGER,
            period_key TEXT,
            direction TEXT,
            pnl_cents INTEGER,
            correct INTEGER,
            strategy TEXT,
            order_id TEXT,
            filled_contracts INTEGER,
            data TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(time);
        CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(type);
        CREATE INDEX IF NOT EXISTS idx_trades_period ON trades(period_key);

        CREATE TABLE IF NOT EXISTS daily_stats (
            date TEXT PRIMARY KEY,
            pnl_cents INTEGER DEFAULT 0,
            trade_count INTEGER DEFAULT 0,
            wins INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            ticker TEXT,
            side TEXT,
            contracts INTEGER,
            entry_price INTEGER,
            entry_time BIGINT,
            period_key TEXT,
            total_cost_cents INTEGER,
            total_contracts INTEGER,
            data TEXT,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- ═══════════════════════════════════════════════════════════
        -- PREDICTION CYCLE SNAPSHOTS — Full record of every cycle
        -- Captures: all inputs, prediction outputs, bet quality,
        -- and eventual outcome for algorithm improvement
        -- ═══════════════════════════════════════════════════════════

        CREATE TABLE IF NOT EXISTS prediction_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            snapshot_type TEXT NOT NULL,        -- 'new_period', 'update', 'settlement'
            ticker TEXT,
            strike NUMERIC,
            current_price NUMERIC,
            predicted_price NUMERIC,
            probability NUMERIC,
            raw_probability NUMERIC,
            confidence NUMERIC,
            direction TEXT,                     -- 'up' or 'down'
            minutes_ahead NUMERIC,
            -- Bet quality assessment
            should_bet BOOLEAN,
            bet_quality NUMERIC,
            bet_edge NUMERIC,
            kelly_fraction NUMERIC,
            bet_size NUMERIC,
            bet_size_reason TEXT,
            skip_reason TEXT,
            -- Prediction signals (all individual signal values)
            signals JSONB,
            -- Regime info
            regime_info JSONB,
            ensemble_confidence NUMERIC,
            -- Exhaustion / choppiness
            exhaustion_score NUMERIC,
            exhaustion_type TEXT,
            choppiness_adx NUMERIC,
            is_choppy BOOLEAN,
            -- Session risk state at time of prediction
            session_risk JSONB,
            -- Outcome (filled in at settlement)
            actual_price NUMERIC,
            actual_direction TEXT,
            was_correct BOOLEAN,
            pnl_cents INTEGER,
            -- Full market data snapshot (JSON for flexibility)
            market_data JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_pred_snap_period ON prediction_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_pred_snap_type ON prediction_snapshots(snapshot_type);
        CREATE INDEX IF NOT EXISTS idx_pred_snap_created ON prediction_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- PRICE SNAPSHOTS — BTC price every tick during each period
        -- For analyzing optimal entry/exit timing
        -- ═══════════════════════════════════════════════════════════

        CREATE TABLE IF NOT EXISTS price_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            price NUMERIC NOT NULL,
            strike NUMERIC,
            distance_from_strike NUMERIC,
            minutes_remaining NUMERIC,
            -- Price context
            price_change_1m NUMERIC,
            price_change_5m NUMERIC,
            volatility NUMERIC,
            volume_ratio NUMERIC,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_price_snap_period ON price_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_price_snap_created ON price_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- KALSHI ORDERBOOK SNAPSHOTS — Full order book at key moments
        -- For backtesting optimal entry prices and timing
        -- ═══════════════════════════════════════════════════════════

        CREATE TABLE IF NOT EXISTS orderbook_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            ticker TEXT NOT NULL,
            snapshot_reason TEXT,               -- 'period_start', 'trade_entry', 'trade_exit', 'periodic', 'settlement'
            minutes_remaining NUMERIC,
            -- Full orderbook data
            yes_bids JSONB,                     -- [[price, size], ...]
            no_bids JSONB,                      -- [[price, size], ...]
            best_yes_bid NUMERIC,
            best_no_bid NUMERIC,
            best_yes_ask NUMERIC,               -- derived: 1 - best_no_bid
            best_no_ask NUMERIC,                -- derived: 1 - best_yes_bid
            yes_depth NUMERIC,                  -- total yes bid volume
            no_depth NUMERIC,                   -- total no bid volume
            spread_cents NUMERIC,               -- best ask - best bid for yes side
            -- BTC price at this moment
            btc_price NUMERIC,
            strike NUMERIC,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ob_snap_period ON orderbook_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_ob_snap_ticker ON orderbook_snapshots(ticker);
        CREATE INDEX IF NOT EXISTS idx_ob_snap_created ON orderbook_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- MARKET DATA SNAPSHOTS — External API data each cycle
        -- Funding rate, fear/greed, liquidations, OI, etc.
        -- ═══════════════════════════════════════════════════════════

        CREATE TABLE IF NOT EXISTS market_data_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            btc_price NUMERIC,
            eth_price NUMERIC,
            -- Binance data
            funding_rate NUMERIC,
            funding_premium NUMERIC,
            open_interest NUMERIC,
            long_short_ratio NUMERIC,
            -- Liquidations
            liquidation_volume NUMERIC,
            liquidation_imbalance NUMERIC,
            -- Sentiment
            fear_greed_value INTEGER,
            fear_greed_label TEXT,
            -- Macro
            is_macro_day BOOLEAN,
            is_near_announcement BOOLEAN,
            macro_sizing_multiplier NUMERIC,
            -- Binance orderbook imbalance (BTC spot)
            binance_bid_depth NUMERIC,
            binance_ask_depth NUMERIC,
            binance_ob_imbalance NUMERIC,
            -- Price history summary
            price_high_30 NUMERIC,
            price_low_30 NUMERIC,
            price_range_pct NUMERIC,
            volatility_20 NUMERIC,
            -- ETH correlation
            eth_price_history JSONB,
            -- OI history
            oi_history JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_mkt_snap_period ON market_data_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_mkt_snap_created ON market_data_snapshots(created_at);
    `);

    ready = true;
    console.log(`[db] PostgreSQL initialized`);
    return pool;
}

// ── Trade Log ──────────────────────────────────────────────────

async function logTrade(entry) {
    if (!ready) return;

    // Extract known columns, store the rest as JSON
    const known = ['type', 'time', 'ticker', 'side', 'contracts', 'limitPrice', 'entryPrice',
                   'periodKey', 'direction', 'pnlCents', 'correct', 'strategy', 'orderId', 'filledContracts'];
    const extra = {};
    for (const [k, v] of Object.entries(entry)) {
        if (!known.includes(k)) extra[k] = v;
    }

    try {
        await pool.query(`
            INSERT INTO trades (type, time, ticker, side, contracts, limit_price, entry_price, period_key, direction, pnl_cents, correct, strategy, order_id, filled_contracts, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
            entry.type || null,
            entry.time || new Date().toISOString(),
            entry.ticker || null,
            entry.side || null,
            entry.contracts || null,
            entry.limitPrice || entry.limitPrice === 0 ? entry.limitPrice : null,
            entry.entryPrice || entry.entryPrice === 0 ? entry.entryPrice : null,
            entry.periodKey || null,
            entry.direction || null,
            entry.pnlCents || entry.pnlCents === 0 ? entry.pnlCents : null,
            entry.correct != null ? (entry.correct ? 1 : 0) : null,
            entry.strategy || null,
            entry.orderId || null,
            entry.filledContracts || entry.filledContracts === 0 ? entry.filledContracts : null,
            Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to log trade:', e.message);
    }
}

async function getRecentTrades(limit = 200) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query('SELECT * FROM trades ORDER BY id DESC LIMIT $1', [limit]);
        return rows.map(row => {
            const entry = { type: row.type, time: row.time };
            if (row.ticker) entry.ticker = row.ticker;
            if (row.side) entry.side = row.side;
            if (row.contracts) entry.contracts = row.contracts;
            if (row.limit_price != null) entry.limitPrice = row.limit_price;
            if (row.entry_price != null) entry.entryPrice = row.entry_price;
            if (row.period_key) entry.periodKey = row.period_key;
            if (row.direction) entry.direction = row.direction;
            if (row.pnl_cents != null) entry.pnlCents = row.pnl_cents;
            if (row.correct != null) entry.correct = !!row.correct;
            if (row.strategy) entry.strategy = row.strategy;
            if (row.order_id) entry.orderId = row.order_id;
            if (row.filled_contracts != null) entry.filledContracts = row.filled_contracts;
            if (row.data) {
                try { Object.assign(entry, JSON.parse(row.data)); } catch (_) {}
            }
            return entry;
        });
    } catch (e) {
        console.error('[db] Failed to get recent trades:', e.message);
        return [];
    }
}

async function getTradeCount() {
    if (!ready) return 0;
    try {
        const { rows } = await pool.query('SELECT COUNT(*) as count FROM trades');
        return parseInt(rows[0].count, 10);
    } catch (e) { return 0; }
}

// ── Daily Stats ────────────────────────────────────────────────

async function saveDailyStats(stats) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO daily_stats (date, pnl_cents, trade_count, wins, losses, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT(date) DO UPDATE SET
                pnl_cents = $2,
                trade_count = $3,
                wins = $4,
                losses = $5,
                updated_at = NOW()
        `, [stats.date, stats.pnlCents, stats.tradeCount, stats.wins, stats.losses]);
    } catch (e) {
        console.error('[db] Failed to save daily stats:', e.message);
    }
}

async function loadDailyStats(date) {
    if (!ready) return null;
    try {
        const { rows } = await pool.query('SELECT * FROM daily_stats WHERE date = $1', [date]);
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            date: row.date,
            pnlCents: row.pnl_cents,
            tradeCount: row.trade_count,
            wins: row.wins,
            losses: row.losses,
        };
    } catch (e) {
        console.error('[db] Failed to load daily stats:', e.message);
        return null;
    }
}

async function getDailyStatsHistory(days = 30) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT date, pnl_cents AS "pnlCents", trade_count AS "tradeCount", wins, losses
            FROM daily_stats ORDER BY date DESC LIMIT $1
        `, [days]);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get daily stats history:', e.message);
        return [];
    }
}

// ── Position Persistence ───────────────────────────────────────

async function savePosition(pos) {
    if (!ready) return;
    try {
        if (!pos) {
            await pool.query('DELETE FROM positions WHERE id = 1');
            return;
        }
        const extra = {};
        const known = ['ticker', 'side', 'contracts', 'entryPrice', 'entryTime', 'periodKey', 'totalCostCents', 'totalContracts'];
        for (const [k, v] of Object.entries(pos)) {
            if (!known.includes(k)) extra[k] = v;
        }
        await pool.query(`
            INSERT INTO positions (id, ticker, side, contracts, entry_price, entry_time, period_key, total_cost_cents, total_contracts, data, updated_at)
            VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT(id) DO UPDATE SET
                ticker = $1, side = $2, contracts = $3,
                entry_price = $4, entry_time = $5, period_key = $6,
                total_cost_cents = $7, total_contracts = $8,
                data = $9, updated_at = NOW()
        `, [
            pos.ticker || null,
            pos.side || null,
            pos.contracts || null,
            pos.entryPrice || null,
            pos.entryTime || null,
            pos.periodKey || null,
            pos.totalCostCents || null,
            pos.totalContracts || null,
            Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save position:', e.message);
    }
}

async function loadPosition() {
    if (!ready) return null;
    try {
        const { rows } = await pool.query('SELECT * FROM positions WHERE id = 1');
        if (rows.length === 0) return null;
        const row = rows[0];
        const pos = {
            ticker: row.ticker,
            side: row.side,
            contracts: row.contracts,
            entryPrice: row.entry_price,
            entryTime: row.entry_time,
            periodKey: row.period_key,
            totalCostCents: row.total_cost_cents,
            totalContracts: row.total_contracts,
        };
        if (row.data) {
            try { Object.assign(pos, JSON.parse(row.data)); } catch (_) {}
        }
        return pos;
    } catch (e) {
        console.error('[db] Failed to load position:', e.message);
        return null;
    }
}

// ── Analytics Queries ──────────────────────────────────────────

async function getWinRateByStrategy() {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT strategy, COUNT(*) as total,
                   SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN pnl_cents IS NOT NULL THEN pnl_cents ELSE 0 END) AS "totalPnlCents"
            FROM trades WHERE type IN ('settle') AND strategy IS NOT NULL
            GROUP BY strategy
        `);
        return rows;
    } catch (e) { return []; }
}

async function getWinRateByDirection() {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT direction, COUNT(*) as total,
                   SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN pnl_cents IS NOT NULL THEN pnl_cents ELSE 0 END) AS "totalPnlCents"
            FROM trades WHERE type = 'settle' AND direction IS NOT NULL
            GROUP BY direction
        `);
        return rows;
    } catch (e) { return []; }
}

async function getWinRateByHour() {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT EXTRACT(HOUR FROM time::timestamptz)::integer as hour, COUNT(*) as total,
                   SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as wins
            FROM trades WHERE type = 'settle'
            GROUP BY hour ORDER BY hour
        `);
        return rows;
    } catch (e) { return []; }
}

async function getCumulativePnl() {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT date, pnl_cents AS "pnlCents",
                   SUM(pnl_cents) OVER (ORDER BY date) AS "cumulativePnlCents"
            FROM daily_stats ORDER BY date
        `);
        return rows;
    } catch (e) { return []; }
}

// ── Prediction Cycle Snapshots ─────────────────────────────────

async function savePredictionSnapshot(snap) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO prediction_snapshots (
                period_key, snapshot_type, ticker, strike, current_price,
                predicted_price, probability, raw_probability, confidence, direction,
                minutes_ahead, should_bet, bet_quality, bet_edge, kelly_fraction,
                bet_size, bet_size_reason, skip_reason, signals, regime_info,
                ensemble_confidence, exhaustion_score, exhaustion_type,
                choppiness_adx, is_choppy, session_risk, market_data
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
        `, [
            snap.periodKey,
            snap.snapshotType,
            snap.ticker || null,
            snap.strike || null,
            snap.currentPrice || null,
            snap.predictedPrice || null,
            snap.probability || null,
            snap.rawProbability || null,
            snap.confidence || null,
            snap.direction || null,
            snap.minutesAhead || null,
            snap.shouldBet != null ? snap.shouldBet : null,
            snap.betQuality || null,
            snap.betEdge || null,
            snap.kellyFraction || null,
            snap.betSize || null,
            snap.betSizeReason || null,
            snap.skipReason || null,
            snap.signals ? JSON.stringify(snap.signals) : null,
            snap.regimeInfo ? JSON.stringify(snap.regimeInfo) : null,
            snap.ensembleConfidence || null,
            snap.exhaustionScore || null,
            snap.exhaustionType || null,
            snap.choppinessAdx || null,
            snap.isChoppy != null ? snap.isChoppy : null,
            snap.sessionRisk ? JSON.stringify(snap.sessionRisk) : null,
            snap.marketData ? JSON.stringify(snap.marketData) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save prediction snapshot:', e.message);
    }
}

async function updatePredictionOutcome(periodKey, outcome) {
    if (!ready) return;
    try {
        await pool.query(`
            UPDATE prediction_snapshots
            SET actual_price = $2, actual_direction = $3, was_correct = $4, pnl_cents = $5
            WHERE period_key = $1 AND snapshot_type = 'new_period'
        `, [
            periodKey,
            outcome.actualPrice || null,
            outcome.actualDirection || null,
            outcome.wasCorrect != null ? outcome.wasCorrect : null,
            outcome.pnlCents || null,
        ]);
    } catch (e) {
        console.error('[db] Failed to update prediction outcome:', e.message);
    }
}

// ── Price Snapshots ───────────────────────────────────────────

async function savePriceSnapshot(snap) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO price_snapshots (
                period_key, price, strike, distance_from_strike, minutes_remaining,
                price_change_1m, price_change_5m, volatility, volume_ratio
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [
            snap.periodKey,
            snap.price,
            snap.strike || null,
            snap.distanceFromStrike || null,
            snap.minutesRemaining || null,
            snap.priceChange1m || null,
            snap.priceChange5m || null,
            snap.volatility || null,
            snap.volumeRatio || null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save price snapshot:', e.message);
    }
}

// ── Orderbook Snapshots ───────────────────────────────────────

async function saveOrderbookSnapshot(snap) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO orderbook_snapshots (
                period_key, ticker, snapshot_reason, minutes_remaining,
                yes_bids, no_bids, best_yes_bid, best_no_bid,
                best_yes_ask, best_no_ask, yes_depth, no_depth,
                spread_cents, btc_price, strike
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
            snap.periodKey,
            snap.ticker,
            snap.reason || null,
            snap.minutesRemaining || null,
            snap.yesBids ? JSON.stringify(snap.yesBids) : null,
            snap.noBids ? JSON.stringify(snap.noBids) : null,
            snap.bestYesBid || null,
            snap.bestNoBid || null,
            snap.bestYesAsk || null,
            snap.bestNoAsk || null,
            snap.yesDepth || null,
            snap.noDepth || null,
            snap.spreadCents || null,
            snap.btcPrice || null,
            snap.strike || null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save orderbook snapshot:', e.message);
    }
}

// ── Market Data Snapshots ─────────────────────────────────────

async function saveMarketDataSnapshot(snap) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO market_data_snapshots (
                period_key, btc_price, eth_price, funding_rate, funding_premium,
                open_interest, long_short_ratio, liquidation_volume,
                liquidation_imbalance, fear_greed_value, fear_greed_label,
                is_macro_day, is_near_announcement, macro_sizing_multiplier,
                binance_bid_depth, binance_ask_depth, binance_ob_imbalance,
                price_high_30, price_low_30, price_range_pct, volatility_20,
                eth_price_history, oi_history
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        `, [
            snap.periodKey,
            snap.btcPrice || null,
            snap.ethPrice || null,
            snap.fundingRate || null,
            snap.fundingPremium || null,
            snap.openInterest || null,
            snap.longShortRatio || null,
            snap.liquidationVolume || null,
            snap.liquidationImbalance || null,
            snap.fearGreedValue || null,
            snap.fearGreedLabel || null,
            snap.isMacroDay != null ? snap.isMacroDay : null,
            snap.isNearAnnouncement != null ? snap.isNearAnnouncement : null,
            snap.macroSizingMultiplier || null,
            snap.binanceBidDepth || null,
            snap.binanceAskDepth || null,
            snap.binanceObImbalance || null,
            snap.priceHigh30 || null,
            snap.priceLow30 || null,
            snap.priceRangePct || null,
            snap.volatility20 || null,
            snap.ethPriceHistory ? JSON.stringify(snap.ethPriceHistory) : null,
            snap.oiHistory ? JSON.stringify(snap.oiHistory) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save market data snapshot:', e.message);
    }
}

// ── Snapshot Queries (for algorithm improvement) ──────────────

async function getPredictionSnapshots(options = {}) {
    if (!ready) return [];
    try {
        let query = 'SELECT * FROM prediction_snapshots';
        const params = [];
        const conditions = [];

        if (options.periodKey) {
            params.push(options.periodKey);
            conditions.push(`period_key = $${params.length}`);
        }
        if (options.snapshotType) {
            params.push(options.snapshotType);
            conditions.push(`snapshot_type = $${params.length}`);
        }
        if (options.wasCorrect !== undefined) {
            params.push(options.wasCorrect);
            conditions.push(`was_correct = $${params.length}`);
        }
        if (options.since) {
            params.push(options.since);
            conditions.push(`created_at >= $${params.length}`);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY created_at DESC';

        if (options.limit) {
            params.push(options.limit);
            query += ` LIMIT $${params.length}`;
        }

        const { rows } = await pool.query(query, params);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get prediction snapshots:', e.message);
        return [];
    }
}

async function getPriceHistory(periodKey) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(
            'SELECT * FROM price_snapshots WHERE period_key = $1 ORDER BY created_at ASC',
            [periodKey]
        );
        return rows;
    } catch (e) {
        console.error('[db] Failed to get price history:', e.message);
        return [];
    }
}

async function getOrderbookHistory(periodKey) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(
            'SELECT * FROM orderbook_snapshots WHERE period_key = $1 ORDER BY created_at ASC',
            [periodKey]
        );
        return rows;
    } catch (e) {
        console.error('[db] Failed to get orderbook history:', e.message);
        return [];
    }
}

async function getMarketDataHistory(options = {}) {
    if (!ready) return [];
    try {
        let query = 'SELECT * FROM market_data_snapshots';
        const params = [];
        if (options.periodKey) {
            params.push(options.periodKey);
            query += ` WHERE period_key = $${params.length}`;
        }
        query += ' ORDER BY created_at DESC';
        if (options.limit) {
            params.push(options.limit);
            query += ` LIMIT $${params.length}`;
        }
        const { rows } = await pool.query(query, params);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get market data history:', e.message);
        return [];
    }
}

async function getCycleAnalysis(periodKey) {
    if (!ready) return null;
    try {
        const [predictions, prices, orderbooks, marketData] = await Promise.all([
            getPredictionSnapshots({ periodKey }),
            getPriceHistory(periodKey),
            getOrderbookHistory(periodKey),
            getMarketDataHistory({ periodKey }),
        ]);

        // Compute optimal entry/exit from price history
        let optimalEntry = null;
        if (prices.length > 0) {
            const prediction = predictions.find(p => p.snapshot_type === 'new_period');
            if (prediction) {
                const isUp = prediction.direction === 'up';
                // Best entry = lowest yes price (if betting up) or lowest no price (if betting down)
                // For YES bets: best entry is when price is farthest below strike (cheapest yes contracts)
                // For NO bets: best entry is when price is farthest above strike (cheapest no contracts)
                let bestPrice = null;
                let bestTime = null;
                for (const p of prices) {
                    const distance = isUp ? (p.strike - p.price) : (p.price - p.strike);
                    if (bestPrice === null || distance > bestPrice) {
                        bestPrice = distance;
                        bestTime = p.created_at;
                    }
                }
                optimalEntry = { bestTime, bestDistanceFromStrike: bestPrice };
            }
        }

        // Compute optimal orderbook entry from snapshots
        let bestOrderbookEntry = null;
        if (orderbooks.length > 0 && predictions.length > 0) {
            const prediction = predictions.find(p => p.snapshot_type === 'new_period');
            if (prediction) {
                const isUp = prediction.direction === 'up';
                const field = isUp ? 'best_yes_ask' : 'best_no_ask';
                let cheapest = null;
                for (const ob of orderbooks) {
                    const price = parseFloat(ob[field]);
                    if (price && (!cheapest || price < cheapest.price)) {
                        cheapest = { price, time: ob.created_at, minutesRemaining: ob.minutes_remaining };
                    }
                }
                bestOrderbookEntry = cheapest;
            }
        }

        return {
            periodKey,
            predictions,
            priceCount: prices.length,
            prices,
            orderbookCount: orderbooks.length,
            orderbooks,
            marketData,
            optimalEntry,
            bestOrderbookEntry,
        };
    } catch (e) {
        console.error('[db] Failed to get cycle analysis:', e.message);
        return null;
    }
}

// ── Cleanup ────────────────────────────────────────────────────

async function close() {
    if (pool) {
        await pool.end();
        pool = null;
        ready = false;
        console.log('[db] Database connection closed');
    }
}

module.exports = {
    init,
    close,
    logTrade,
    getRecentTrades,
    getTradeCount,
    saveDailyStats,
    loadDailyStats,
    getDailyStatsHistory,
    savePosition,
    loadPosition,
    getWinRateByStrategy,
    getWinRateByDirection,
    getWinRateByHour,
    getCumulativePnl,
    // Cycle snapshot capture
    savePredictionSnapshot,
    updatePredictionOutcome,
    savePriceSnapshot,
    saveOrderbookSnapshot,
    saveMarketDataSnapshot,
    // Cycle snapshot queries
    getPredictionSnapshots,
    getPriceHistory,
    getOrderbookHistory,
    getMarketDataHistory,
    getCycleAnalysis,
};
