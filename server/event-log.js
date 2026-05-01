'use strict';

// ═══════════════════════════════════════════════════════════════
// Event Log — in-memory ring buffer + daily JSONL on disk.
// ───────────────────────────────────────────────────────────────
// One-line-per-event structured record of everything noteworthy:
// trades, reconcile actions, sell-signal triggers (acted or not),
// min-hold blocks, re-entry caps, Kalshi API failures, etc.
//
// Endpoint /api/debug/events tails the in-memory buffer; the disk
// file is the persistent record across restarts.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

const MAX_EVENTS = 5000;          // ring buffer cap
const events = [];                // newest at the end

function pathFor(d = new Date()) {
    const iso = d.toISOString().slice(0, 10);
    return path.join(LOG_DIR, `events-${iso}.jsonl`);
}

// Best-effort redact of any obvious secret-shaped fields. We don't pass
// auth tokens through here today, but cheap insurance.
const SECRET_KEYS = /^(authorization|token|apiKey|api_key|secret|privateKey|password)$/i;
function redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (SECRET_KEYS.test(k)) out[k] = '[REDACTED]';
        else if (v && typeof v === 'object') out[k] = redact(v);
        else out[k] = v;
    }
    return out;
}

function log(type, data) {
    const evt = { ts: new Date().toISOString(), type, ...redact(data || {}) };
    events.push(evt);
    if (events.length > MAX_EVENTS) events.shift();
    try { fs.appendFileSync(pathFor(), JSON.stringify(evt) + '\n'); }
    catch (e) { /* disk write is best-effort; the buffer still has it */ }
    return evt;
}

function recent({ n = 500, since, type, asset } = {}) {
    let out = events;
    if (since) {
        const t = Date.parse(since);
        if (Number.isFinite(t)) out = out.filter(e => Date.parse(e.ts) >= t);
    }
    if (type) {
        const types = String(type).split(',').map(s => s.trim()).filter(Boolean);
        if (types.length) out = out.filter(e => types.includes(e.type));
    }
    if (asset) {
        out = out.filter(e => e.asset === asset);
    }
    return out.slice(-Math.max(1, n));
}

function counts() {
    const c = {};
    for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
    return c;
}

function listFiles() {
    try {
        return fs.readdirSync(LOG_DIR).filter(f => f.startsWith('events-') && f.endsWith('.jsonl')).sort();
    } catch (e) { return []; }
}

function readFile(date) {
    const p = path.join(LOG_DIR, `events-${date}.jsonl`);
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { return null; }
}

module.exports = { log, recent, counts, listFiles, readFile, LOG_DIR };
