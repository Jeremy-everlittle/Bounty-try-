'use strict';

// ═══════════════════════════════════════════════════════════════
// POSTGRESQL DATABASE — Persistent storage for trade history & stats
// Uses DATABASE_URL from Railway
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');

let pool = null;
let ready = false;

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
};
