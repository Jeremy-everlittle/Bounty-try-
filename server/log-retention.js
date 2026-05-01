'use strict';

// ═══════════════════════════════════════════════════════════════
// Log Retention — TTL prune for daily-rotated log files.
// ───────────────────────────────────────────────────────────────
// decision-logger, auto-trader-log, and event-log all write daily
// files (decisions-YYYY-MM-DD.log, auto-trader-YYYY-MM-DD.log,
// events-YYYY-MM-DD.jsonl) with no built-in cleanup. On Railway's
// ephemeral disk that fills until OOM. This module deletes anything
// older than RETENTION_DAYS (default 14).
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '14', 10);

// File-pattern matchers — we only prune files we own.
const PATTERNS = [
    /^decisions-(\d{4}-\d{2}-\d{2})\.log$/,
    /^auto-trader-(\d{4}-\d{2}-\d{2})\.log$/,
    /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/,
];

function pruneOnce() {
    let entries;
    try { entries = fs.readdirSync(LOG_DIR); }
    catch (e) { return { scanned: 0, deleted: 0 }; }

    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    let deleted = 0;
    for (const name of entries) {
        let match = null;
        for (const re of PATTERNS) {
            const m = name.match(re);
            if (m) { match = m; break; }
        }
        if (!match) continue;
        const fileDate = Date.parse(match[1] + 'T00:00:00Z');
        if (!isFinite(fileDate)) continue;
        if (fileDate < cutoffMs) {
            try {
                fs.unlinkSync(path.join(LOG_DIR, name));
                deleted += 1;
            } catch (e) { /* file may already be gone — non-fatal */ }
        }
    }
    return { scanned: entries.length, deleted };
}

function scheduleDaily() {
    // Run once at startup, then every 24 hours.
    setTimeout(() => {
        try {
            const r = pruneOnce();
            if (r.deleted > 0) console.log(`[log-retention] Pruned ${r.deleted} old log files (>${RETENTION_DAYS} days)`);
        } catch (e) { console.error('[log-retention] prune error:', e.message); }
    }, 60_000); // 1 minute after boot
    setInterval(() => {
        try {
            const r = pruneOnce();
            if (r.deleted > 0) console.log(`[log-retention] Pruned ${r.deleted} old log files`);
        } catch (e) { console.error('[log-retention] prune error:', e.message); }
    }, 24 * 3600 * 1000);
}

module.exports = { pruneOnce, scheduleDaily, RETENTION_DAYS };
