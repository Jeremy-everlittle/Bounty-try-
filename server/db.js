'use strict';

// ═══════════════════════════════════════════════════════════════
// SQLITE DATABASE — Persistent storage for trade history & stats
// Survives redeploys when backed by a Railway volume
// ═══════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'trading.db');

let db = null;

function init() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            created_at TEXT DEFAULT (datetime('now'))
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
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            ticker TEXT,
            side TEXT,
            contracts INTEGER,
            entry_price INTEGER,
            entry_time INTEGER,
            period_key TEXT,
            total_cost_cents INTEGER,
            total_contracts INTEGER,
            data TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
    `);

    console.log(`[db] SQLite initialized at ${DB_PATH}`);
    return db;
}

// ── Trade Log ──────────────────────────────────────────────────

const _insertTrade = () => db.prepare(`
    INSERT INTO trades (type, time, ticker, side, contracts, limit_price, entry_price, period_key, direction, pnl_cents, correct, strategy, order_id, filled_contracts, data)
    VALUES (@type, @time, @ticker, @side, @contracts, @limitPrice, @entryPrice, @periodKey, @direction, @pnlCents, @correct, @strategy, @orderId, @filledContracts, @data)
`);

let insertTradeStmt = null;

function logTrade(entry) {
    if (!db) return;
    if (!insertTradeStmt) insertTradeStmt = _insertTrade();

    // Extract known columns, store the rest as JSON
    const known = ['type', 'time', 'ticker', 'side', 'contracts', 'limitPrice', 'entryPrice',
                   'periodKey', 'direction', 'pnlCents', 'correct', 'strategy', 'orderId', 'filledContracts'];
    const extra = {};
    for (const [k, v] of Object.entries(entry)) {
        if (!known.includes(k)) extra[k] = v;
    }

    try {
        insertTradeStmt.run({
            type: entry.type || null,
            time: entry.time || new Date().toISOString(),
            ticker: entry.ticker || null,
            side: entry.side || null,
            contracts: entry.contracts || null,
            limitPrice: entry.limitPrice || entry.limitPrice === 0 ? entry.limitPrice : null,
            entryPrice: entry.entryPrice || entry.entryPrice === 0 ? entry.entryPrice : null,
            periodKey: entry.periodKey || null,
            direction: entry.direction || null,
            pnlCents: entry.pnlCents || entry.pnlCents === 0 ? entry.pnlCents : null,
            correct: entry.correct != null ? (entry.correct ? 1 : 0) : null,
            strategy: entry.strategy || null,
            orderId: entry.orderId || null,
            filledContracts: entry.filledContracts || entry.filledContracts === 0 ? entry.filledContracts : null,
            data: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        });
    } catch (e) {
        console.error('[db] Failed to log trade:', e.message);
    }
}

function getRecentTrades(limit = 200) {
    if (!db) return [];
    try {
        const rows = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);
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

function getTradeCount() {
    if (!db) return 0;
    try {
        return db.prepare('SELECT COUNT(*) as count FROM trades').get().count;
    } catch (e) { return 0; }
}

// ── Daily Stats ────────────────────────────────────────────────

function saveDailyStats(stats) {
    if (!db) return;
    try {
        db.prepare(`
            INSERT INTO daily_stats (date, pnl_cents, trade_count, wins, losses, updated_at)
            VALUES (@date, @pnlCents, @tradeCount, @wins, @losses, datetime('now'))
            ON CONFLICT(date) DO UPDATE SET
                pnl_cents = @pnlCents,
                trade_count = @tradeCount,
                wins = @wins,
                losses = @losses,
                updated_at = datetime('now')
        `).run({
            date: stats.date,
            pnlCents: stats.pnlCents,
            tradeCount: stats.tradeCount,
            wins: stats.wins,
            losses: stats.losses,
        });
    } catch (e) {
        console.error('[db] Failed to save daily stats:', e.message);
    }
}

function loadDailyStats(date) {
    if (!db) return null;
    try {
        const row = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(date);
        if (!row) return null;
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

function getDailyStatsHistory(days = 30) {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT date, pnl_cents as pnlCents, trade_count as tradeCount, wins, losses
            FROM daily_stats ORDER BY date DESC LIMIT ?
        `).all(days);
    } catch (e) {
        console.error('[db] Failed to get daily stats history:', e.message);
        return [];
    }
}

// ── Position Persistence ───────────────────────────────────────

function savePosition(pos) {
    if (!db) return;
    try {
        if (!pos) {
            db.prepare('DELETE FROM positions WHERE id = 1').run();
            return;
        }
        const extra = {};
        const known = ['ticker', 'side', 'contracts', 'entryPrice', 'entryTime', 'periodKey', 'totalCostCents', 'totalContracts'];
        for (const [k, v] of Object.entries(pos)) {
            if (!known.includes(k)) extra[k] = v;
        }
        db.prepare(`
            INSERT INTO positions (id, ticker, side, contracts, entry_price, entry_time, period_key, total_cost_cents, total_contracts, data, updated_at)
            VALUES (1, @ticker, @side, @contracts, @entryPrice, @entryTime, @periodKey, @totalCostCents, @totalContracts, @data, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
                ticker = @ticker, side = @side, contracts = @contracts,
                entry_price = @entryPrice, entry_time = @entryTime, period_key = @periodKey,
                total_cost_cents = @totalCostCents, total_contracts = @totalContracts,
                data = @data, updated_at = datetime('now')
        `).run({
            ticker: pos.ticker || null,
            side: pos.side || null,
            contracts: pos.contracts || null,
            entryPrice: pos.entryPrice || null,
            entryTime: pos.entryTime || null,
            periodKey: pos.periodKey || null,
            totalCostCents: pos.totalCostCents || null,
            totalContracts: pos.totalContracts || null,
            data: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        });
    } catch (e) {
        console.error('[db] Failed to save position:', e.message);
    }
}

function loadPosition() {
    if (!db) return null;
    try {
        const row = db.prepare('SELECT * FROM positions WHERE id = 1').get();
        if (!row) return null;
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

function getWinRateByStrategy() {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT strategy, COUNT(*) as total,
                   SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN pnl_cents IS NOT NULL THEN pnl_cents ELSE 0 END) as totalPnlCents
            FROM trades WHERE type IN ('settle') AND strategy IS NOT NULL
            GROUP BY strategy
        `).all();
    } catch (e) { return []; }
}

function getWinRateByDirection() {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT direction, COUNT(*) as total,
                   SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN pnl_cents IS NOT NULL THEN pnl_cents ELSE 0 END) as totalPnlCents
            FROM trades WHERE type = 'settle' AND direction IS NOT NULL
            GROUP BY direction
        `).all();
    } catch (e) { return []; }
}

function getWinRateByHour() {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT CAST(strftime('%H', time) AS INTEGER) as hour, COUNT(*) as total,
                   SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as wins
            FROM trades WHERE type = 'settle'
            GROUP BY hour ORDER BY hour
        `).all();
    } catch (e) { return []; }
}

function getCumulativePnl() {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT date, pnl_cents as pnlCents,
                   SUM(pnl_cents) OVER (ORDER BY date) as cumulativePnlCents
            FROM daily_stats ORDER BY date
        `).all();
    } catch (e) { return []; }
}

// ── Cleanup ────────────────────────────────────────────────────

function close() {
    if (db) {
        db.close();
        db = null;
        insertTradeStmt = null;
        console.log('[db] Database closed');
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
