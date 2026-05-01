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
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
    });

    // Test connection
    try {
        await pool.query('SELECT 1');
    } catch (e) {
        console.error('[db] Failed to connect to PostgreSQL:', e.message);
        pool = null;
        return null;
    }

    // ── Create tables if they don't exist (preserves data across deploys) ──
    await pool.query(`
        -- ═══════════════════════════════════════════════════════════
        -- TRADES — Every order placed, filled, failed, or settled
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            type TEXT NOT NULL,                 -- 'buy','sell','settle','buy_failed','sell_unfilled','dip_buy', etc.
            time TEXT NOT NULL,
            ticker TEXT,
            side TEXT,                          -- 'yes' or 'no'
            contracts INTEGER,
            limit_price INTEGER,               -- price offered (cents)
            entry_price INTEGER,               -- actual fill price (cents)
            period_key TEXT,
            direction TEXT,                    -- 'up' or 'down'
            pnl_cents INTEGER,
            correct INTEGER,                   -- 1=correct, 0=wrong
            strategy TEXT,                     -- 'initial','press','dip','late_lock','force', etc.
            order_id TEXT,
            filled_contracts INTEGER,
            data TEXT,                         -- extra fields as JSON
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(time);
        CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(type);
        CREATE INDEX IF NOT EXISTS idx_trades_period ON trades(period_key);

        -- ═══════════════════════════════════════════════════════════
        -- DAILY STATS — Aggregate P&L per day
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS daily_stats (
            date TEXT PRIMARY KEY,
            pnl_cents INTEGER DEFAULT 0,
            trade_count INTEGER DEFAULT 0,
            wins INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- ═══════════════════════════════════════════════════════════
        -- POSITIONS — Singleton: current open position (survives restart)
        -- ═══════════════════════════════════════════════════════════
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
        -- PREDICTION SNAPSHOTS — Full record of every prediction cycle
        -- Every input, output, bet quality factor, Kelly calculation,
        -- Kalshi orderbook price, and eventual outcome.
        -- This is the PRIMARY table for algorithm improvement.
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS prediction_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            snapshot_type TEXT NOT NULL,         -- 'new_period', 'update'
            ticker TEXT,
            strike NUMERIC,
            current_price NUMERIC,              -- BTC price at prediction time
            predicted_price NUMERIC,            -- model predicted price
            probability NUMERIC,                -- P(above strike) after calibration
            raw_probability NUMERIC,            -- P(above strike) before calibration
            confidence NUMERIC,                 -- model confidence (0-1)
            direction TEXT,                     -- 'up' or 'down'
            minutes_ahead NUMERIC,

            -- ── Bet quality assessment ──
            should_bet BOOLEAN,                 -- final decision: place bet or skip
            bet_quality_score NUMERIC,          -- weighted quality score (0-1)
            bet_edge NUMERIC,                   -- edge = probForBet - 0.50
            bet_size NUMERIC,                   -- position size multiplier
            bet_size_reason TEXT,               -- human-readable sizing reason
            conviction_tier TEXT,               -- null, 'ELEVATED', 'HIGH', 'LOCK'
            skip_reason TEXT,                   -- why bet was skipped (if should_bet=false)

            -- ── Individual quality factors (each true/false) ──
            -- These determine the quality score. Track each to find which blocks good bets.
            factor_has_min_edge BOOLEAN,
            factor_has_confidence BOOLEAN,
            factor_not_choppy BOOLEAN,
            factor_not_exhausted BOOLEAN,
            factor_has_time BOOLEAN,
            factor_signal_agreement BOOLEAN,

            -- ── Kelly calculation (actual Kalshi orderbook) ──
            -- This determines if there's real edge after fees.
            kelly_entry_price NUMERIC,          -- actual best ask from Kalshi orderbook (cents)
            kelly_win_profit NUMERIC,           -- profit if correct (dollars)
            kelly_loss_amount NUMERIC,           -- loss if wrong (dollars)
            kelly_raw NUMERIC,                  -- raw Kelly fraction (negative = no edge)
            kelly_fraction NUMERIC,             -- quarter-Kelly used for sizing
            kelly_has_edge BOOLEAN,             -- kellyRaw > 0
            kelly_error TEXT,                   -- error message if orderbook unavailable

            -- ── Prediction signals ──
            signals JSONB,                      -- all individual signal values from ensemble
            regime_info JSONB,                  -- market regime classification
            ensemble_confidence NUMERIC,

            -- ── Market microstructure ──
            exhaustion_score NUMERIC,
            exhaustion_type TEXT,
            choppiness_adx NUMERIC,
            is_choppy BOOLEAN,

            -- ── Session risk state ──
            session_consecutive_losses INTEGER,
            session_consecutive_wins INTEGER,
            session_drawdown NUMERIC,
            session_cooling_off BOOLEAN,
            session_edge_decay BOOLEAN,
            session_risk_multiplier NUMERIC,

            -- ── Outcome (filled at settlement) ──
            actual_price NUMERIC,               -- actual BTC price at period end
            actual_direction TEXT,               -- 'up' or 'down'
            was_correct BOOLEAN,                -- prediction correct?
            pnl_cents INTEGER,                  -- P&L from trade (if any)

            -- ── Context snapshots ──
            market_data JSONB,                  -- funding, sentiment, macro context
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pred_snap_period ON prediction_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_pred_snap_type ON prediction_snapshots(snapshot_type);
        CREATE INDEX IF NOT EXISTS idx_pred_snap_created ON prediction_snapshots(created_at);
        CREATE INDEX IF NOT EXISTS idx_pred_snap_should_bet ON prediction_snapshots(should_bet);
        CREATE INDEX IF NOT EXISTS idx_pred_snap_correct ON prediction_snapshots(was_correct);

        -- ═══════════════════════════════════════════════════════════
        -- DECISION LOG — Every bet/skip decision with full reasoning
        -- One row per decision point. Links to prediction_snapshots.
        -- Use this to audit: "why did we skip?" or "why did we bet?"
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS decision_log (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            ticker TEXT,
            decision TEXT NOT NULL,             -- 'bet', 'skip', 'no_liquidity', 'error'
            direction TEXT,                     -- 'up' or 'down'
            side TEXT,                          -- 'yes' or 'no'

            -- ── What we saw ──
            btc_price NUMERIC,
            strike NUMERIC,
            distance_from_strike NUMERIC,       -- btcPrice - strike
            probability NUMERIC,                -- P(our side wins)
            edge NUMERIC,                       -- probability - 0.50
            minutes_remaining NUMERIC,

            -- ── Kalshi orderbook at decision time ──
            kalshi_best_yes_ask INTEGER,        -- cents
            kalshi_best_no_ask INTEGER,         -- cents
            kalshi_yes_depth NUMERIC,           -- total yes liquidity
            kalshi_no_depth NUMERIC,            -- total no liquidity
            kalshi_entry_price INTEGER,         -- what we'd pay (cents)

            -- ── Kelly verdict ──
            kelly_raw NUMERIC,
            kelly_has_edge BOOLEAN,
            kelly_error TEXT,

            -- ── Quality verdict ──
            quality_score NUMERIC,
            factors JSONB,                      -- {hasMinEdge: true, hasConfidence: false, ...}

            -- ── Sizing ──
            bet_size NUMERIC,
            conviction_tier TEXT,
            contracts INTEGER,                  -- actual contracts ordered (if bet)
            limit_price INTEGER,                -- actual limit price used (if bet)

            -- ── Outcome (filled after settlement) ──
            was_correct BOOLEAN,
            pnl_cents INTEGER,

            -- ── Full reason string shown in UI ──
            reason TEXT,

            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_decision_period ON decision_log(period_key);
        CREATE INDEX IF NOT EXISTS idx_decision_type ON decision_log(decision);
        CREATE INDEX IF NOT EXISTS idx_decision_created ON decision_log(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- PRICE SNAPSHOTS — BTC price every 10s during each period
        -- For analyzing optimal entry/exit timing
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS price_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            price NUMERIC NOT NULL,
            strike NUMERIC,
            distance_from_strike NUMERIC,
            minutes_remaining NUMERIC,
            price_change_1m NUMERIC,
            price_change_5m NUMERIC,
            volatility NUMERIC,
            volume_ratio NUMERIC,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_price_snap_period ON price_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_price_snap_created ON price_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- KALSHI ORDERBOOK SNAPSHOTS — Contract orderbook at key moments
        -- For backtesting entry prices and spread analysis
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS orderbook_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            ticker TEXT NOT NULL,
            snapshot_reason TEXT,                -- 'trade_entry','trade_exit','periodic','bet_quality'
            minutes_remaining NUMERIC,
            yes_bids JSONB,
            no_bids JSONB,
            best_yes_bid NUMERIC,
            best_no_bid NUMERIC,
            best_yes_ask NUMERIC,
            best_no_ask NUMERIC,
            yes_depth NUMERIC,
            no_depth NUMERIC,
            spread_cents NUMERIC,
            btc_price NUMERIC,
            strike NUMERIC,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ob_snap_period ON orderbook_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_ob_snap_ticker ON orderbook_snapshots(ticker);
        CREATE INDEX IF NOT EXISTS idx_ob_snap_created ON orderbook_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- MARKET DATA SNAPSHOTS — External signals each cycle
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS market_data_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            btc_price NUMERIC,
            eth_price NUMERIC,
            funding_rate NUMERIC,
            funding_premium NUMERIC,
            open_interest NUMERIC,
            long_short_ratio NUMERIC,
            liquidation_volume NUMERIC,
            liquidation_imbalance NUMERIC,
            fear_greed_value INTEGER,
            fear_greed_label TEXT,
            is_macro_day BOOLEAN,
            is_near_announcement BOOLEAN,
            macro_sizing_multiplier NUMERIC,
            binance_bid_depth NUMERIC,
            binance_ask_depth NUMERIC,
            binance_ob_imbalance NUMERIC,
            price_high_30 NUMERIC,
            price_low_30 NUMERIC,
            price_range_pct NUMERIC,
            volatility_20 NUMERIC,
            eth_price_history JSONB,
            oi_history JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_mkt_snap_period ON market_data_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_mkt_snap_created ON market_data_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- ACCOUNT BALANCE SNAPSHOTS — Track demo & prod balances
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS account_balances (
            id SERIAL PRIMARY KEY,
            environment TEXT NOT NULL,
            balance_cents INTEGER NOT NULL,
            portfolio_value_cents INTEGER,
            pnl_cents INTEGER,
            trade_count INTEGER,
            wins INTEGER,
            losses INTEGER,
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_acct_bal_env ON account_balances(environment);
        CREATE INDEX IF NOT EXISTS idx_acct_bal_created ON account_balances(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- PREDICTION LOG — Period history entries shown in the UI
        -- Backs the in-memory predictionLog from store.js
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS prediction_log (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL UNIQUE,
            time TEXT,
            timestamp BIGINT,
            start_price NUMERIC,
            predicted_price NUMERIC,
            predicted_direction TEXT,
            actual_price NUMERIC,
            actual_direction TEXT,
            correct BOOLEAN,
            confidence NUMERIC,
            probability NUMERIC,
            data JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pred_log_period ON prediction_log(period_key);
        CREATE INDEX IF NOT EXISTS idx_pred_log_created ON prediction_log(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- STORE STATE — Persists critical learning state across deploys
        -- Single-row key-value store for bayesian, errorAnalysis, etc.
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS store_state (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- ═══════════════════════════════════════════════════════════
        -- SELL SIGNALS — Tracked sell/exit signals with context
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS sell_signals (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            ticker TEXT,
            level TEXT,
            urgency INTEGER,
            advice TEXT,
            bet_direction TEXT,
            on_wrong_side BOOLEAN,
            current_price NUMERIC,
            strike NUMERIC,
            exhaustion NUMERIC,
            choppiness NUMERIC,
            prob_velocity NUMERIC,
            peak_prob NUMERIC,
            distance_pct NUMERIC,
            sigma_distance NUMERIC,
            acted BOOLEAN,
            action_type TEXT,
            was_good_signal BOOLEAN,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            settled_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_sell_sig_period ON sell_signals(period_key);
        CREATE INDEX IF NOT EXISTS idx_sell_sig_created ON sell_signals(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- FEATURE SNAPSHOTS — Full feature vector at prediction time
        -- For feature importance analysis and ML training
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS feature_snapshots (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            snapshot_type TEXT,
            vol_regime TEXT,
            vol_value NUMERIC,
            trend_regime TEXT,
            trend_value NUMERIC,
            momentum_score NUMERIC,
            order_flow_imbalance NUMERIC,
            exhaustion_score NUMERIC,
            time_bucket INTEGER,
            distance_from_strike NUMERIC,
            bayesian_prob NUMERIC,
            ml_prob NUMERIC,
            calibrated_prob NUMERIC,
            ensemble_prob NUMERIC,
            feature_vector JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_feat_snap_period ON feature_snapshots(period_key);
        CREATE INDEX IF NOT EXISTS idx_feat_snap_created ON feature_snapshots(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- ORDER EXECUTIONS — Detailed fill data for slippage analysis
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS order_executions (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            trade_id INTEGER,
            order_timestamp TIMESTAMPTZ,
            our_price_limit INTEGER,
            market_best_ask INTEGER,
            slippage_cents INTEGER,
            side TEXT,
            contracts INTEGER,
            filled_contracts INTEGER,
            filled_price INTEGER,
            fill_time_ms BIGINT,
            partial BOOLEAN,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_order_exec_period ON order_executions(period_key);
        CREATE INDEX IF NOT EXISTS idx_order_exec_created ON order_executions(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- SESSION STATE — Risk management state per trading session
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS session_state (
            id SERIAL PRIMARY KEY,
            session_date TEXT,
            consecutive_wins INTEGER DEFAULT 0,
            consecutive_losses INTEGER DEFAULT 0,
            drawdown NUMERIC DEFAULT 0,
            cooling_off BOOLEAN DEFAULT false,
            edge_decay BOOLEAN DEFAULT false,
            risk_multiplier NUMERIC DEFAULT 1.0,
            total_trades INTEGER DEFAULT 0,
            total_pnl_cents INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_session_state_date ON session_state(session_date);

        -- ═══════════════════════════════════════════════════════════
        -- LEARNING AUDIT — Track probability adjustments through pipeline
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS learning_audit (
            id SERIAL PRIMARY KEY,
            period_key TEXT NOT NULL,
            original_prob NUMERIC,
            raw_prob NUMERIC,
            calibrated_prob NUMERIC,
            bayesian_delta NUMERIC,
            ml_delta NUMERIC,
            error_correction_delta NUMERIC,
            final_prob NUMERIC,
            actual_direction TEXT,
            was_correct BOOLEAN,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_learn_audit_period ON learning_audit(period_key);
        CREATE INDEX IF NOT EXISTS idx_learn_audit_created ON learning_audit(created_at);

        -- ═══════════════════════════════════════════════════════════
        -- EXTERNAL SIGNALS — External data feeds (funding, sentiment, etc.)
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS external_signals (
            id SERIAL PRIMARY KEY,
            signal_type TEXT NOT NULL,
            signal_value NUMERIC,
            signal_data JSONB,
            fetched_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ext_sig_type ON external_signals(signal_type);
        CREATE INDEX IF NOT EXISTS idx_ext_sig_fetched ON external_signals(fetched_at);

        -- ═══════════════════════════════════════════════════════════
        -- CYCLE DATA — Comprehensive per-tick data capture
        -- Stores EVERYTHING the app computes every 5 seconds
        -- ═══════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS cycle_data (
            id SERIAL PRIMARY KEY,
            period_key VARCHAR(20) NOT NULL,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            minutes_remaining REAL,

            -- Price data
            btc_price REAL,
            strike REAL,
            distance_from_strike REAL,
            distance_pct REAL,

            -- Kalshi orderbook
            kalshi_yes_bid REAL,
            kalshi_yes_ask REAL,
            kalshi_no_bid REAL,
            kalshi_no_ask REAL,
            kalshi_spread REAL,
            kalshi_yes_bids JSONB,
            kalshi_no_bids JSONB,

            -- Prediction output
            predicted_price REAL,
            probability REAL,
            confidence REAL,
            direction VARCHAR(4),

            -- All raw signals (JSONB for flexibility)
            raw_signals JSONB,

            -- Market data context
            market_context JSONB,

            -- Bet quality if evaluated
            bet_quality JSONB,

            -- Sell signal if evaluated
            sell_signal JSONB
        );

        CREATE INDEX IF NOT EXISTS idx_cycle_data_period ON cycle_data(period_key);
        CREATE INDEX IF NOT EXISTS idx_cycle_data_time ON cycle_data(timestamp);

        CREATE INDEX IF NOT EXISTS idx_cycle_data_period_time ON cycle_data(period_key, timestamp);
        CREATE INDEX IF NOT EXISTS idx_price_snap_period_created ON price_snapshots(period_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_ob_snap_period_created ON orderbook_snapshots(period_key, created_at);
    `);

    // ── Multi-asset migration (idempotent) ─────────────────────────
    // Adds an `asset` column to every BTC-shaped table so BTC and ETH
    // (and future assets) can coexist. Backfills existing rows to 'btc'
    // — anything previously written was BTC-only, this is correct.
    // Drops the singleton id=1 PRIMARY KEY on positions and re-keys by
    // (asset). Drops daily_stats's date-only PRIMARY KEY and re-keys by
    // (date, asset).
    await pool.query(`
        -- trades: add asset column + index
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'btc';
        CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset);

        -- prediction_log: add asset column + index
        ALTER TABLE prediction_log ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'btc';
        CREATE INDEX IF NOT EXISTS idx_prediction_log_asset ON prediction_log(asset);

        -- daily_stats: add asset, replace PK with (date, asset)
        ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'btc';
    `);
    // PK rotations need to be in their own statements / catch-able blocks.
    try {
        await pool.query(`ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS daily_stats_pkey`);
        await pool.query(`ALTER TABLE daily_stats ADD PRIMARY KEY (date, asset)`);
    } catch (e) { /* PK already in place from a prior boot — non-fatal */ }

    await pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'btc'`);
    try {
        // Singleton id=1 check + the original PK both go away. New PK = asset.
        await pool.query(`ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_id_check`);
        await pool.query(`ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey`);
        await pool.query(`ALTER TABLE positions DROP COLUMN IF EXISTS id`);
        await pool.query(`ALTER TABLE positions ADD PRIMARY KEY (asset)`);
    } catch (e) { /* migration already applied — non-fatal */ }

    // prediction_log: PK from period_key alone -> (period_key, asset)
    try {
        await pool.query(`ALTER TABLE prediction_log DROP CONSTRAINT IF EXISTS prediction_log_pkey`);
        await pool.query(`ALTER TABLE prediction_log ADD PRIMARY KEY (period_key, asset)`);
    } catch (e) { /* already applied — non-fatal */ }

    ready = true;
    console.log(`[db] PostgreSQL initialized (multi-asset schema)`);
    return pool;
}

// ── Trade Log ──────────────────────────────────────────────────

async function logTrade(entry) {
    if (!ready) return;

    // Extract known columns, store the rest as JSON. `asset` is now a real
    // column (post-migration); keep it out of the JSON blob.
    const known = ['type', 'time', 'ticker', 'side', 'contracts', 'limitPrice', 'entryPrice',
                   'periodKey', 'direction', 'pnlCents', 'correct', 'strategy', 'orderId', 'filledContracts',
                   'asset'];
    const extra = {};
    for (const [k, v] of Object.entries(entry)) {
        if (!known.includes(k)) extra[k] = v;
    }

    try {
        await pool.query(`
            INSERT INTO trades (type, time, ticker, side, contracts, limit_price, entry_price, period_key, direction, pnl_cents, correct, strategy, order_id, filled_contracts, data, asset)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [
            entry.type || null,
            entry.time || new Date().toISOString(),
            entry.ticker || null,
            entry.side || null,
            entry.contracts || null,
            entry.limitPrice != null ? entry.limitPrice : null,
            entry.entryPrice != null ? entry.entryPrice : null,
            entry.periodKey || null,
            entry.direction || null,
            entry.pnlCents != null ? entry.pnlCents : null,
            entry.correct != null ? (entry.correct ? 1 : 0) : null,
            entry.strategy || null,
            entry.orderId || null,
            entry.filledContracts != null ? entry.filledContracts : null,
            Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
            entry.asset || 'btc',
        ]);
    } catch (e) {
        console.error('[db] Failed to log trade:', e.message);
    }
}

async function getRecentTrades(limit = 1000) {
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
            // The asset column is populated by every trade (post-P2.1 migration),
            // so reload it explicitly. Without this, trades loaded from the DB
            // had no asset tag and the period-history grouping (asset:periodKey)
            // misclassified them all as BTC by default.
            if (row.asset) entry.asset = row.asset;
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

async function saveDailyStats(stats, asset = 'btc') {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO daily_stats (date, asset, pnl_cents, trade_count, wins, losses, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT(date, asset) DO UPDATE SET
                pnl_cents = $3,
                trade_count = $4,
                wins = $5,
                losses = $6,
                updated_at = NOW()
        `, [stats.date, asset, stats.pnlCents, stats.tradeCount, stats.wins, stats.losses]);
    } catch (e) {
        console.error('[db] Failed to save daily stats:', e.message);
    }
}

async function loadDailyStats(date, asset = 'btc') {
    if (!ready) return null;
    try {
        const { rows } = await pool.query('SELECT * FROM daily_stats WHERE date = $1 AND asset = $2', [date, asset]);
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            date: row.date,
            asset: row.asset,
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

async function savePosition(pos, asset = 'btc') {
    if (!ready) return;
    try {
        if (!pos) {
            await pool.query('DELETE FROM positions WHERE asset = $1', [asset]);
            return;
        }
        const extra = {};
        const known = ['ticker', 'side', 'contracts', 'entryPrice', 'entryTime', 'periodKey', 'totalCostCents', 'totalContracts', 'asset'];
        for (const [k, v] of Object.entries(pos)) {
            if (!known.includes(k)) extra[k] = v;
        }
        await pool.query(`
            INSERT INTO positions (asset, ticker, side, contracts, entry_price, entry_time, period_key, total_cost_cents, total_contracts, data, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT(asset) DO UPDATE SET
                ticker = $2, side = $3, contracts = $4,
                entry_price = $5, entry_time = $6, period_key = $7,
                total_cost_cents = $8, total_contracts = $9,
                data = $10, updated_at = NOW()
        `, [
            asset,
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

async function loadPosition(asset = 'btc') {
    if (!ready) return null;
    try {
        const { rows } = await pool.query('SELECT * FROM positions WHERE asset = $1', [asset]);
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
                minutes_ahead, should_bet, bet_quality_score, bet_edge,
                bet_size, bet_size_reason, conviction_tier, skip_reason,
                factor_has_min_edge, factor_has_confidence, factor_not_choppy,
                factor_not_exhausted, factor_has_time, factor_signal_agreement,
                kelly_entry_price, kelly_win_profit, kelly_loss_amount,
                kelly_raw, kelly_fraction, kelly_has_edge, kelly_error,
                signals, regime_info, ensemble_confidence,
                exhaustion_score, exhaustion_type, choppiness_adx, is_choppy,
                session_consecutive_losses, session_consecutive_wins,
                session_drawdown, session_cooling_off, session_edge_decay,
                session_risk_multiplier, market_data
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45)
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
            snap.betQualityScore || null,
            snap.betEdge || null,
            snap.betSize || null,
            snap.betSizeReason || null,
            snap.convictionTier || null,
            snap.skipReason || null,
            // Individual quality factors
            snap.factorHasMinEdge != null ? snap.factorHasMinEdge : null,
            snap.factorHasConfidence != null ? snap.factorHasConfidence : null,
            snap.factorNotChoppy != null ? snap.factorNotChoppy : null,
            snap.factorNotExhausted != null ? snap.factorNotExhausted : null,
            snap.factorHasTime != null ? snap.factorHasTime : null,
            snap.factorSignalAgreement != null ? snap.factorSignalAgreement : null,
            // Kelly calculation details
            snap.kellyEntryPrice || null,
            snap.kellyWinProfit || null,
            snap.kellyLossAmount || null,
            snap.kellyRaw || null,
            snap.kellyFraction || null,
            snap.kellyHasEdge != null ? snap.kellyHasEdge : null,
            snap.kellyError || null,
            // Signals & regime
            snap.signals ? JSON.stringify(snap.signals) : null,
            snap.regimeInfo ? JSON.stringify(snap.regimeInfo) : null,
            typeof snap.ensembleConfidence === 'object' ? (snap.ensembleConfidence?.stddev ?? null) : (snap.ensembleConfidence || null),
            snap.exhaustionScore || null,
            snap.exhaustionType || null,
            snap.choppinessAdx || null,
            snap.isChoppy != null ? snap.isChoppy : null,
            // Session risk (individual columns, not JSONB)
            snap.sessionConsecutiveLosses || null,
            snap.sessionConsecutiveWins || null,
            snap.sessionDrawdown || null,
            snap.sessionCoolingOff != null ? snap.sessionCoolingOff : null,
            snap.sessionEdgeDecay != null ? snap.sessionEdgeDecay : null,
            snap.sessionRiskMultiplier || null,
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

// ── Decision Log ─────────────────────────────────────────────

async function saveDecisionLog(entry) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO decision_log (
                period_key, ticker, decision, direction, side,
                btc_price, strike, distance_from_strike, probability, edge,
                minutes_remaining, kalshi_best_yes_ask, kalshi_best_no_ask,
                kalshi_yes_depth, kalshi_no_depth, kalshi_entry_price,
                kelly_raw, kelly_has_edge, kelly_error,
                quality_score, factors, bet_size, conviction_tier,
                contracts, limit_price, reason
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        `, [
            entry.periodKey,
            entry.ticker || null,
            entry.decision,
            entry.direction || null,
            entry.side || null,
            entry.btcPrice || null,
            entry.strike || null,
            entry.distanceFromStrike || null,
            entry.probability || null,
            entry.edge || null,
            entry.minutesRemaining || null,
            entry.kalshiBestYesAsk || null,
            entry.kalshiBestNoAsk || null,
            entry.kalshiYesDepth || null,
            entry.kalshiNoDepth || null,
            entry.kalshiEntryPrice || null,
            entry.kellyRaw || null,
            entry.kellyHasEdge != null ? entry.kellyHasEdge : null,
            entry.kellyError || null,
            entry.qualityScore || null,
            entry.factors ? JSON.stringify(entry.factors) : null,
            entry.betSize || null,
            entry.convictionTier || null,
            entry.contracts || null,
            entry.limitPrice || null,
            entry.reason || null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save decision log:', e.message);
    }
}

async function updateDecisionOutcome(periodKey, outcome) {
    if (!ready) return;
    try {
        await pool.query(`
            UPDATE decision_log
            SET was_correct = $2, pnl_cents = $3
            WHERE period_key = $1 AND was_correct IS NULL
        `, [periodKey, outcome.wasCorrect, outcome.pnlCents || null]);
    } catch (e) {
        console.error('[db] Failed to update decision outcome:', e.message);
    }
}

async function getDecisionLog(options = {}) {
    if (!ready) return [];
    try {
        let query = 'SELECT * FROM decision_log';
        const params = [];
        const conditions = [];
        if (options.decision) {
            params.push(options.decision);
            conditions.push(`decision = $${params.length}`);
        }
        if (options.periodKey) {
            params.push(options.periodKey);
            conditions.push(`period_key = $${params.length}`);
        }
        if (options.since) {
            params.push(options.since);
            conditions.push(`created_at >= $${params.length}`);
        }
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY created_at DESC';
        if (options.limit) {
            params.push(options.limit);
            query += ` LIMIT $${params.length}`;
        }
        const { rows } = await pool.query(query, params);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get decision log:', e.message);
        return [];
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

// ── Account Balance Snapshots ─────────────────────────────────

async function saveBalanceSnapshot(snap) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO account_balances (environment, balance_cents, portfolio_value_cents, pnl_cents, trade_count, wins, losses, note)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            snap.environment,
            snap.balanceCents,
            snap.portfolioValueCents || null,
            snap.pnlCents || null,
            snap.tradeCount || null,
            snap.wins || null,
            snap.losses || null,
            snap.note || null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save balance snapshot:', e.message);
    }
}

async function getBalanceHistory(options = {}) {
    if (!ready) return [];
    try {
        let query = 'SELECT * FROM account_balances';
        const params = [];
        const conditions = [];

        if (options.environment) {
            params.push(options.environment);
            conditions.push(`environment = $${params.length}`);
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
        console.error('[db] Failed to get balance history:', e.message);
        return [];
    }
}

async function getLatestBalance(environment) {
    if (!ready) return null;
    try {
        const { rows } = await pool.query(
            'SELECT * FROM account_balances WHERE environment = $1 ORDER BY created_at DESC LIMIT 1',
            [environment]
        );
        return rows.length > 0 ? rows[0] : null;
    } catch (e) {
        console.error('[db] Failed to get latest balance:', e.message);
        return null;
    }
}

async function getBalanceSummary() {
    if (!ready) return [];
    try {
        // Get the latest balance for each environment plus 24h change
        const { rows } = await pool.query(`
            WITH latest AS (
                SELECT DISTINCT ON (environment)
                    environment, balance_cents, portfolio_value_cents, pnl_cents,
                    trade_count, wins, losses, created_at
                FROM account_balances
                ORDER BY environment, created_at DESC
            ),
            day_ago AS (
                SELECT DISTINCT ON (environment)
                    environment, balance_cents AS balance_24h_ago
                FROM account_balances
                WHERE created_at <= NOW() - INTERVAL '24 hours'
                ORDER BY environment, created_at DESC
            )
            SELECT l.*, d.balance_24h_ago,
                   CASE WHEN d.balance_24h_ago IS NOT NULL
                        THEN l.balance_cents - d.balance_24h_ago
                        ELSE NULL END AS change_24h_cents
            FROM latest l
            LEFT JOIN day_ago d ON l.environment = d.environment
        `);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get balance summary:', e.message);
        return [];
    }
}

// ── Prediction Log (UI Period History) ────────────────────────

async function savePredictionLogEntry(entry, asset = 'btc') {
    if (!ready) return;
    try {
        // Extract core fields, store everything else in data JSONB. `asset`
        // is now part of the composite primary key.
        const known = ['periodKey', 'time', 'timestamp', 'startPrice', 'predictedPrice',
                       'predictedDirection', 'actualPrice', 'actualDirection', 'correct',
                       'confidence', 'probability', 'asset'];
        const extra = {};
        for (const [k, v] of Object.entries(entry)) {
            if (!known.includes(k)) extra[k] = v;
        }

        await pool.query(`
            INSERT INTO prediction_log (period_key, asset, time, timestamp, start_price, predicted_price,
                predicted_direction, actual_price, actual_direction, correct, confidence, probability, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT(period_key, asset) DO UPDATE SET
                predicted_direction = COALESCE($7, prediction_log.predicted_direction),
                actual_price = COALESCE($8, prediction_log.actual_price),
                actual_direction = COALESCE($9, prediction_log.actual_direction),
                correct = COALESCE($10, prediction_log.correct),
                data = COALESCE($13, prediction_log.data),
                updated_at = NOW()
        `, [
            entry.periodKey,
            asset,
            entry.time || null,
            entry.timestamp || null,
            entry.startPrice || null,
            entry.predictedPrice || null,
            entry.predictedDirection || null,
            entry.actualPrice != null ? entry.actualPrice : null,
            entry.actualDirection || null,
            entry.correct != null ? entry.correct : null,
            entry.confidence || null,
            entry.probability || null,
            Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save prediction log entry:', e.message);
    }
}

async function loadPredictionLog(limit = 500) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(
            'SELECT * FROM prediction_log ORDER BY created_at ASC LIMIT $1', [limit]
        );
        return rows.map(row => {
            const entry = {
                periodKey: row.period_key,
                time: row.time,
                timestamp: row.timestamp ? parseInt(row.timestamp) : null,
                startPrice: row.start_price ? parseFloat(row.start_price) : null,
                predictedPrice: row.predicted_price ? parseFloat(row.predicted_price) : null,
                predictedDirection: row.predicted_direction,
                actualPrice: row.actual_price ? parseFloat(row.actual_price) : null,
                actualDirection: row.actual_direction,
                correct: row.correct,
            };
            if (row.confidence) entry.confidence = parseFloat(row.confidence);
            if (row.probability) entry.probability = parseFloat(row.probability);
            // Merge any extra fields from data JSONB
            if (row.data) {
                try { Object.assign(entry, typeof row.data === 'string' ? JSON.parse(row.data) : row.data); } catch (_) {}
            }
            return entry;
        });
    } catch (e) {
        console.error('[db] Failed to load prediction log:', e.message);
        return [];
    }
}

async function clearPredictionLog() {
    if (!ready) return;
    try {
        await pool.query('DELETE FROM prediction_log');
    } catch (e) {
        console.error('[db] Failed to clear prediction log:', e.message);
    }
}

async function purgeAllData() {
    if (!ready) return;
    try {
        await pool.query('DELETE FROM trades');
        await pool.query('DELETE FROM daily_stats');
        await pool.query('DELETE FROM positions');
        await pool.query('DELETE FROM prediction_snapshots');
        await pool.query('DELETE FROM decision_log');
        await pool.query('DELETE FROM price_snapshots');
        await pool.query('DELETE FROM orderbook_snapshots');
        await pool.query('DELETE FROM market_data_snapshots');
        await pool.query('DELETE FROM account_balances');
        await pool.query('DELETE FROM prediction_log');
        await pool.query('DELETE FROM store_state');
        await pool.query('DELETE FROM cycle_data');
        console.log('[db] All data purged');
    } catch (e) {
        console.error('[db] purgeAllData error:', e.message);
    }
}

// ── Store State (Key-Value persistence) ──────────────────────

async function saveStoreState(key, value) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO store_state (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW()
        `, [key, JSON.stringify(value)]);
    } catch (e) {
        console.error(`[db] Failed to save store state '${key}':`, e.message);
    }
}

async function loadStoreState(key) {
    if (!ready) return null;
    try {
        const { rows } = await pool.query('SELECT value FROM store_state WHERE key = $1', [key]);
        if (rows.length === 0) return null;
        return rows[0].value;
    } catch (e) {
        console.error(`[db] Failed to load store state '${key}':`, e.message);
        return null;
    }
}

// ── Sell Signals ──────────────────────────────────────────────

async function saveSellSignal(data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO sell_signals (
                period_key, ticker, level, urgency, advice, bet_direction,
                on_wrong_side, current_price, strike, exhaustion, choppiness,
                prob_velocity, peak_prob, distance_pct, sigma_distance,
                acted, action_type, was_good_signal, settled_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        `, [
            data.periodKey,
            data.ticker || null,
            data.level || null,
            data.urgency || null,
            data.advice || null,
            data.betDirection || null,
            data.onWrongSide != null ? data.onWrongSide : null,
            data.currentPrice || null,
            data.strike || null,
            data.exhaustion || null,
            data.choppiness || null,
            data.probVelocity || null,
            data.peakProb || null,
            data.distancePct || null,
            data.sigmaDistance || null,
            data.acted != null ? data.acted : null,
            data.actionType || null,
            data.wasGoodSignal != null ? data.wasGoodSignal : null,
            data.settledAt || null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save sell signal:', e.message);
    }
}

// ── Feature Snapshots ─────────────────────────────────────────

async function saveFeatureSnapshot(data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO feature_snapshots (
                period_key, snapshot_type, vol_regime, vol_value, trend_regime,
                trend_value, momentum_score, order_flow_imbalance, exhaustion_score,
                time_bucket, distance_from_strike, bayesian_prob, ml_prob,
                calibrated_prob, ensemble_prob, feature_vector
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `, [
            data.periodKey,
            data.snapshotType || null,
            data.volRegime || null,
            data.volValue || null,
            data.trendRegime || null,
            data.trendValue || null,
            data.momentumScore || null,
            data.orderFlowImbalance || null,
            data.exhaustionScore || null,
            data.timeBucket || null,
            data.distanceFromStrike || null,
            data.bayesianProb || null,
            data.mlProb || null,
            data.calibratedProb || null,
            data.ensembleProb || null,
            data.featureVector ? JSON.stringify(data.featureVector) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save feature snapshot:', e.message);
    }
}

// ── Order Executions ──────────────────────────────────────────

async function saveOrderExecution(data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO order_executions (
                period_key, trade_id, order_timestamp, our_price_limit,
                market_best_ask, slippage_cents, side, contracts,
                filled_contracts, filled_price, fill_time_ms, partial
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
            data.periodKey,
            data.tradeId || null,
            data.orderTimestamp || null,
            data.ourPriceLimit || null,
            data.marketBestAsk || null,
            data.slippageCents || null,
            data.side || null,
            data.contracts || null,
            data.filledContracts || null,
            data.filledPrice || null,
            data.fillTimeMs || null,
            data.partial != null ? data.partial : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save order execution:', e.message);
    }
}

// ── Session State ─────────────────────────────────────────────

async function saveSessionState(data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO session_state (
                session_date, consecutive_wins, consecutive_losses, drawdown,
                cooling_off, edge_decay, risk_multiplier, total_trades, total_pnl_cents
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (id) DO UPDATE SET
                consecutive_wins = $2,
                consecutive_losses = $3,
                drawdown = $4,
                cooling_off = $5,
                edge_decay = $6,
                risk_multiplier = $7,
                total_trades = $8,
                total_pnl_cents = $9
        `, [
            data.sessionDate,
            data.consecutiveWins || 0,
            data.consecutiveLosses || 0,
            data.drawdown || 0,
            data.coolingOff != null ? data.coolingOff : false,
            data.edgeDecay != null ? data.edgeDecay : false,
            data.riskMultiplier || 1.0,
            data.totalTrades || 0,
            data.totalPnlCents || 0,
        ]);
    } catch (e) {
        console.error('[db] Failed to save session state:', e.message);
    }
}

async function loadSessionState(date) {
    if (!ready) return null;
    try {
        const { rows } = await pool.query(
            'SELECT * FROM session_state WHERE session_date = $1 ORDER BY created_at DESC LIMIT 1',
            [date]
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            sessionDate: row.session_date,
            consecutiveWins: row.consecutive_wins,
            consecutiveLosses: row.consecutive_losses,
            drawdown: parseFloat(row.drawdown),
            coolingOff: row.cooling_off,
            edgeDecay: row.edge_decay,
            riskMultiplier: parseFloat(row.risk_multiplier),
            totalTrades: row.total_trades,
            totalPnlCents: row.total_pnl_cents,
        };
    } catch (e) {
        console.error('[db] Failed to load session state:', e.message);
        return null;
    }
}

// ── Learning Audit ────────────────────────────────────────────

async function saveLearningAudit(data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO learning_audit (
                period_key, original_prob, raw_prob, calibrated_prob,
                bayesian_delta, ml_delta, error_correction_delta,
                final_prob, actual_direction, was_correct
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
            data.periodKey,
            data.originalProb || null,
            data.rawProb || null,
            data.calibratedProb || null,
            data.bayesianDelta || null,
            data.mlDelta || null,
            data.errorCorrectionDelta || null,
            data.finalProb || null,
            data.actualDirection || null,
            data.wasCorrect != null ? data.wasCorrect : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save learning audit:', e.message);
    }
}

// ── External Signals ──────────────────────────────────────────

async function saveExternalSignal(type, value, data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO external_signals (signal_type, signal_value, signal_data)
            VALUES ($1, $2, $3)
        `, [
            type,
            value || null,
            data ? JSON.stringify(data) : null,
        ]);
    } catch (e) {
        console.error('[db] Failed to save external signal:', e.message);
    }
}

async function getRecentExternalSignals(type, limit = 50) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(
            'SELECT * FROM external_signals WHERE signal_type = $1 ORDER BY fetched_at DESC LIMIT $2',
            [type, limit]
        );
        return rows;
    } catch (e) {
        console.error('[db] Failed to get recent external signals:', e.message);
        return [];
    }
}

// ── Feature Importance Analysis ───────────────────────────────

async function getFeatureImportance(days = 7) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT
                fs.vol_regime,
                fs.trend_regime,
                COUNT(*) AS total,
                SUM(CASE WHEN ps.was_correct = true THEN 1 ELSE 0 END) AS wins,
                ROUND(AVG(fs.momentum_score)::numeric, 4) AS avg_momentum,
                ROUND(AVG(fs.order_flow_imbalance)::numeric, 4) AS avg_order_flow,
                ROUND(AVG(fs.exhaustion_score)::numeric, 4) AS avg_exhaustion,
                ROUND(AVG(fs.ensemble_prob)::numeric, 4) AS avg_ensemble_prob,
                ROUND(AVG(fs.distance_from_strike)::numeric, 4) AS avg_distance
            FROM feature_snapshots fs
            JOIN prediction_snapshots ps ON fs.period_key = ps.period_key
                AND ps.snapshot_type = 'new_period'
                AND ps.was_correct IS NOT NULL
            WHERE fs.created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY fs.vol_regime, fs.trend_regime
            ORDER BY total DESC
        `, [days]);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get feature importance:', e.message);
        return [];
    }
}

// ── Hourly Directional Stats ──────────────────────────────────

async function getHourlyDirectionalStats(days = 7) {
    if (!ready) return [];
    try {
        const { rows } = await pool.query(`
            SELECT
                EXTRACT(HOUR FROM created_at)::integer AS hour,
                direction,
                COUNT(*) AS total,
                SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) AS wins,
                ROUND(AVG(probability)::numeric, 4) AS avg_prob,
                SUM(CASE WHEN pnl_cents IS NOT NULL THEN pnl_cents ELSE 0 END) AS total_pnl_cents
            FROM prediction_snapshots
            WHERE snapshot_type = 'new_period'
                AND was_correct IS NOT NULL
                AND created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY hour, direction
            ORDER BY hour, direction
        `, [days]);
        return rows;
    } catch (e) {
        console.error('[db] Failed to get hourly directional stats:', e.message);
        return [];
    }
}

// ── Data Cleanup ──────────────────────────────────────────────

async function cleanOldData(daysToKeep = 30) {
    if (!ready) return;
    try {
        const cutoff = `NOW() - ('${parseInt(daysToKeep, 10)} days')::INTERVAL`;
        const tables = [
            'price_snapshots',
            'orderbook_snapshots',
            'market_data_snapshots',
            'feature_snapshots',
            'order_executions',
            'sell_signals',
            'learning_audit',
            'external_signals',
        ];
        let totalDeleted = 0;
        for (const table of tables) {
            const col = table === 'external_signals' ? 'fetched_at' : 'created_at';
            const result = await pool.query(
                `DELETE FROM ${table} WHERE ${col} < NOW() - ($1 || ' days')::INTERVAL`,
                [parseInt(daysToKeep, 10)]
            );
            totalDeleted += result.rowCount;
        }
        console.log(`[db] Cleaned old data: ${totalDeleted} rows deleted (kept ${daysToKeep} days)`);
        return totalDeleted;
    } catch (e) {
        console.error('[db] Failed to clean old data:', e.message);
        return 0;
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

// ── Cycle Data (comprehensive per-tick capture) ─────────────

async function saveCycleData(data) {
    if (!ready) return;
    try {
        await pool.query(`
            INSERT INTO cycle_data (
                period_key, minutes_remaining,
                btc_price, strike, distance_from_strike, distance_pct,
                kalshi_yes_bid, kalshi_yes_ask, kalshi_no_bid, kalshi_no_ask, kalshi_spread,
                kalshi_yes_bids, kalshi_no_bids,
                predicted_price, probability, confidence, direction,
                raw_signals, market_context, bet_quality, sell_signal
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        `, [
            data.periodKey, data.minutesRemaining,
            data.btcPrice, data.strike, data.distanceFromStrike, data.distancePct,
            data.kalshiYesBid, data.kalshiYesAsk, data.kalshiNoBid, data.kalshiNoAsk, data.kalshiSpread,
            data.kalshiYesBids ? JSON.stringify(data.kalshiYesBids) : null, data.kalshiNoBids ? JSON.stringify(data.kalshiNoBids) : null,
            data.predictedPrice, data.probability, data.confidence, data.direction,
            data.rawSignals ? JSON.stringify(data.rawSignals) : null,
            data.marketContext ? JSON.stringify(data.marketContext) : null,
            data.betQuality ? JSON.stringify(data.betQuality) : null,
            data.sellSignal ? JSON.stringify(data.sellSignal) : null
        ]);
    } catch (e) {
        console.error('[db] saveCycleData error:', e.message);
    }
}

async function getCycleData(periodKey, options = {}) {
    if (!ready) return [];
    try {
        let query = 'SELECT * FROM cycle_data WHERE period_key = $1 ORDER BY timestamp ASC';
        const params = [periodKey];
        if (options.limit) {
            query += ' LIMIT $2';
            params.push(options.limit);
        }
        const result = await pool.query(query, params);
        return result.rows;
    } catch (e) {
        console.error('[db] getCycleData error:', e.message);
        return [];
    }
}

async function getRecentCycleData(limit = 100) {
    if (!ready) return [];
    try {
        const result = await pool.query(
            'SELECT * FROM cycle_data ORDER BY timestamp DESC LIMIT $1',
            [limit]
        );
        return result.rows;
    } catch (e) {
        console.error('[db] getRecentCycleData error:', e.message);
        return [];
    }
}

async function runRetention() {
    if (!ready) return;
    try {
        const results = [];
        // High-frequency data: keep 7 days
        const r1 = await pool.query(`DELETE FROM cycle_data WHERE timestamp < NOW() - INTERVAL '7 days'`);
        results.push(`cycle_data: ${r1.rowCount} rows deleted`);

        // Price snapshots: keep 14 days
        const r2 = await pool.query(`DELETE FROM price_snapshots WHERE created_at < NOW() - INTERVAL '14 days'`);
        results.push(`price_snapshots: ${r2.rowCount} rows deleted`);

        // Orderbook snapshots: keep 14 days
        const r3 = await pool.query(`DELETE FROM orderbook_snapshots WHERE created_at < NOW() - INTERVAL '14 days'`);
        results.push(`orderbook_snapshots: ${r3.rowCount} rows deleted`);

        // Market data: keep 30 days
        const r4 = await pool.query(`DELETE FROM market_data_snapshots WHERE created_at < NOW() - INTERVAL '30 days'`);
        results.push(`market_data_snapshots: ${r4.rowCount} rows deleted`);

        // Prediction snapshots: keep 90 days
        const r5 = await pool.query(`DELETE FROM prediction_snapshots WHERE created_at < NOW() - INTERVAL '90 days'`);
        results.push(`prediction_snapshots: ${r5.rowCount} rows deleted`);

        console.log(`[db] Retention cleanup: ${results.join(', ')}`);
    } catch (e) {
        console.error('[db] Retention error:', e.message);
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
    // Decision log
    saveDecisionLog,
    updateDecisionOutcome,
    getDecisionLog,
    // Cycle snapshot queries
    getPredictionSnapshots,
    getPriceHistory,
    getOrderbookHistory,
    getMarketDataHistory,
    getCycleAnalysis,
    // Account balance tracking
    saveBalanceSnapshot,
    getBalanceHistory,
    getLatestBalance,
    getBalanceSummary,
    // Prediction log (UI period history)
    savePredictionLogEntry,
    loadPredictionLog,
    clearPredictionLog,
    purgeAllData,
    // Store state persistence
    saveStoreState,
    loadStoreState,
    // Sell signals
    saveSellSignal,
    // Feature snapshots
    saveFeatureSnapshot,
    // Order executions
    saveOrderExecution,
    // Session state
    saveSessionState,
    loadSessionState,
    // Learning audit
    saveLearningAudit,
    // External signals
    saveExternalSignal,
    getRecentExternalSignals,
    // Analytics
    getFeatureImportance,
    getHourlyDirectionalStats,
    // Maintenance
    cleanOldData,
    // Cycle data (comprehensive per-tick capture)
    saveCycleData,
    getCycleData,
    getRecentCycleData,
    // Data retention
    runRetention,
};
