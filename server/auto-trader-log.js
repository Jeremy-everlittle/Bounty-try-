'use strict';

// ═══════════════════════════════════════════════════════════════
// Auto-Trader Narrative Log
// ───────────────────────────────────────────────────────────────
// Companion to decision-logger.js. While decision-logger writes
// structured JSON for machine analysis, this writes one human-
// readable line per event so you can scroll and see the algorithm
// think.
//
// File: server/logs/auto-trader-YYYY-MM-DD.log
//
// Event types written:
//   PERIOD ... OPEN           — every new 15-min period
//   TICK ...                  — sampled every 15s (or on regime change)
//   BUY / SELL / SETTLE       — every executed trade
//   DIP-BUY / LATE-LOCK / PRESS — strategy-driven adds
//   SESSION                   — balance + daily P&L snapshot
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB → rotate

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

function pathFor(date) {
    return path.join(LOG_DIR, `auto-trader-${date}.log`);
}
function todayPath() {
    return pathFor(new Date().toISOString().slice(0, 10));
}

function ts() {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function dollar(n) {
    return n != null && isFinite(n) ? '$' + Number(n).toFixed(2) : '$?';
}
function pct(n) {
    return n != null && isFinite(n) ? (Number(n) * 100).toFixed(1) + '%' : '?';
}
function signed(n) {
    if (n == null || !isFinite(n)) return '?';
    return (n >= 0 ? '+' : '') + Number(n).toFixed(2);
}
function signedDollar(n) {
    if (n == null || !isFinite(n)) return '$?';
    return (n >= 0 ? '+$' : '-$') + Math.abs(Number(n)).toFixed(2);
}

function append(line) {
    const p = todayPath();
    try {
        try {
            const stat = fs.statSync(p);
            if (stat.size > MAX_FILE_SIZE) fs.renameSync(p, p + '.old');
        } catch (e) { /* not yet created */ }
        fs.appendFileSync(p, line + '\n');
    } catch (e) {
        console.error('[auto-trader-log] write error:', e.message);
    }
}

// ── Period open ───────────────────────────────────────────────────
function logPeriodOpen({ periodKey, currentPrice, strike, prediction, betQuality }) {
    if (!prediction || strike == null || currentPrice == null) return;
    const dir = prediction.predictedPrice >= strike ? 'UP' : 'DOWN';
    const probForBet = dir === 'UP' ? prediction.probability : 1 - prediction.probability;

    let action;
    if (!betQuality) {
        action = 'NO BET QUALITY';
    } else if (betQuality.shouldBet) {
        const askStr = betQuality.factors?.ask != null ? `${betQuality.factors.ask}c` : '?';
        action = `BET ${dir} ${betQuality.betSize}x @ ${askStr} (edge ${pct(betQuality.edge)}, kelly ${pct(betQuality.kellyFraction)}, conviction:${betQuality.convictionTier})`;
    } else {
        action = `SKIP — ${betQuality.skipReason || 'no reason'}`;
    }
    append(`[${ts()}] PERIOD ${periodKey} OPEN — BTC ${dollar(currentPrice)} vs strike ${dollar(strike)} (${signedDollar(currentPrice - strike)}) — pred ${dir} ${dollar(prediction.predictedPrice)} prob ${pct(probForBet)} conf ${pct(prediction.confidence)} — ${action}`);
}

// ── Tick (sampled) ───────────────────────────────────────────────
//
// Throttled via a small ring of last-write timestamps keyed by periodKey.
// Always logs on direction flip or sell-signal level change, plus a
// regular tick every TICK_SAMPLE_MS.
const TICK_SAMPLE_MS = 15_000;
const lastTick = { time: 0, periodKey: null, direction: null, sellLevel: null };

function logTick({ periodKey, minutesRemaining, currentPrice, strike, prediction, sellSignal, position }) {
    if (!prediction || strike == null || currentPrice == null) return;
    const dir = prediction.predictedPrice >= strike ? 'UP' : 'DOWN';
    const sellLevel = sellSignal?.level || 'none';
    const now = Date.now();

    const periodChanged = lastTick.periodKey !== periodKey;
    const directionFlipped = !periodChanged && lastTick.direction !== dir;
    const sellChanged = !periodChanged && lastTick.sellLevel !== sellLevel;
    const dueToSampling = (now - lastTick.time) >= TICK_SAMPLE_MS;

    if (!periodChanged && !directionFlipped && !sellChanged && !dueToSampling) return;

    lastTick.time = now;
    lastTick.periodKey = periodKey;
    lastTick.direction = dir;
    lastTick.sellLevel = sellLevel;

    const probForBet = dir === 'UP' ? prediction.probability : 1 - prediction.probability;
    const ssLabel = sellSignal ? (sellSignal.shortLabel || sellSignal.level) : 'none';
    const posStr = position
        ? `holding ${position.totalContracts}x ${position.side?.toUpperCase()}@${position.entryPrice}c (${Math.round((Date.now() - position.entryTime) / 1000)}s)`
        : 'flat';
    const tag = directionFlipped ? 'FLIP' : sellChanged ? `SELL→${sellLevel.toUpperCase()}` : 'TICK';
    const minStr = minutesRemaining != null ? `${minutesRemaining.toFixed(1)}m` : '?m';
    append(`[${ts()}] ${tag} ${periodKey} ${minStr} — BTC ${dollar(currentPrice)} vs ${dollar(strike)} (${signedDollar(currentPrice - strike)}) — pred ${dir} prob ${pct(probForBet)} conf ${pct(prediction.confidence)} — sell:${ssLabel} — ${posStr}`);
}

// ── Trade actions (called from tradeExecutor.onTradeNotify) ───────
function logTradeAction(trade) {
    if (!trade || !trade.type) return;
    const side = trade.side ? trade.side.toUpperCase() : '?';
    const price = trade.limitPrice != null ? `${trade.limitPrice}c` : '?';
    switch (trade.type) {
        case 'buy':
            append(`[${ts()}] BUY ${trade.contracts}x ${side} @ ${price} on ${trade.ticker || '?'} (period ${trade.periodKey || '?'}) — edge ${trade.edge || '?'} — ${trade.reason || 'auto'}`);
            break;
        case 'sell': {
            const pnl = trade.pnlCents != null ? ` P&L ${signedDollar(trade.pnlCents / 100)}` : '';
            append(`[${ts()}] SELL ${trade.contracts}x ${side} @ ${price} (period ${trade.periodKey || '?'}) — ${trade.reason || 'manual'}${pnl}`);
            break;
        }
        case 'settle': {
            const result = trade.won || trade.correct ? 'WON' : 'LOST';
            const pnl = trade.pnlCents != null ? signedDollar(trade.pnlCents / 100) : '?';
            append(`[${ts()}] SETTLE ${trade.periodKey || '?'} — ${result} ${trade.contracts}x ${side} — ${pnl} P&L (settled ${dollar(trade.settlementPrice)} vs strike ${dollar(trade.strikePrice)})`);
            break;
        }
        case 'dip_buy':
            append(`[${ts()}] DIP-BUY +${trade.contracts}x ${side} @ ${price} (period ${trade.periodKey || '?'}) — ${trade.dipImprovement || ''} cheaper`);
            break;
        case 'late_lock':
            append(`[${ts()}] LATE-LOCK ${trade.contracts}x ${side} @ ${price} (period ${trade.periodKey || '?'}) — ${trade.sigmaDistance || '?'} from strike`);
            break;
        case 'press':
            append(`[${ts()}] PRESS +${trade.contracts}x ${side} @ ${price} (period ${trade.periodKey || '?'})`);
            break;
        default:
            append(`[${ts()}] ${trade.type.toUpperCase()} ${trade.contracts || '?'}x ${side} @ ${price} (period ${trade.periodKey || '?'})`);
    }
}

// ── Session snapshot (call periodically; e.g. on settlement) ──────
function logSessionState({ env, balanceCents, dailyPnlCents, wins, losses, tradeCount }) {
    append(`[${ts()}] SESSION ${env || '?'} — balance ${dollar(balanceCents != null ? balanceCents / 100 : null)} — daily P&L ${signedDollar(dailyPnlCents != null ? dailyPnlCents / 100 : null)} (${wins || 0}W/${losses || 0}L over ${tradeCount || 0} trades)`);
}

// ── Free-form note (skip reason changes, manual interventions) ────
function logNote(message) {
    if (!message) return;
    append(`[${ts()}] NOTE — ${message}`);
}

// ── Reading helpers (for /api/auto-log endpoints) ─────────────────
function readToday() {
    try { return fs.readFileSync(todayPath(), 'utf8'); }
    catch (e) { return ''; }
}

function read(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    try { return fs.readFileSync(pathFor(date), 'utf8'); }
    catch (e) { return null; }
}

function list() {
    try { return fs.readdirSync(LOG_DIR).filter(f => f.startsWith('auto-trader-')).sort(); }
    catch (e) { return []; }
}

// Tail-N implementation: scan from the end of the file backwards.
function tail(n = 200) {
    const text = readToday();
    if (!text) return '';
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - n - 1)).join('\n');
}

module.exports = {
    logPeriodOpen,
    logTick,
    logTradeAction,
    logSessionState,
    logNote,
    readToday,
    read,
    list,
    tail,
    LOG_DIR,
};
