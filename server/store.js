'use strict';

// ═══════════════════════════════════════════════════════════════
// PERSISTENT STORE — JSON file + PostgreSQL backed storage
// ───────────────────────────────────────────────────────────────
// Per-asset state: each public function takes an optional
// assetKey ('btc' / 'eth' / etc.) and reads/writes the matching
// slice of state.assets[assetKey]. assetKey defaults to 'btc' so
// legacy single-asset call sites keep working unchanged.
// ───────────────────────────────────────────────────────────────
// On load, any pre-multi-asset top-level keys (predictionLog,
// bayesianState, currentPeriod, errorAnalysis, onlineML) are
// migrated into state.assets.btc.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'prediction-state.json');

let _db = null;
function getDb() {
    if (!_db) {
        try { _db = require('./db'); } catch (e) { _db = null; }
    }
    return _db;
}

// Fields owned by each asset slice. Top-level state still holds
// server-wide stuff like serverStartTime + totalPredictionsMade.
function createDefaultAssetState() {
    return {
        predictionLog: [],
        bayesianState: {
            records: [],
            directionBeta: { up: { a: 1, b: 1 }, down: { a: 1, b: 1 } },
            regimeBeta: {
                volatile: { a: 1, b: 1 }, expanding: { a: 1, b: 1 },
                normal: { a: 1, b: 1 }, quiet: { a: 1, b: 1 }, contracting: { a: 1, b: 1 }
            },
            trendBeta: {
                trending: { a: 1, b: 1 }, meanReverting: { a: 1, b: 1 }, neutral: { a: 1, b: 1 }
            },
            timeBeta: { 0: { a: 1, b: 1 }, 1: { a: 1, b: 1 }, 2: { a: 1, b: 1 }, 3: { a: 1, b: 1 } },
            calibrationBins: {}
        },
        currentPeriod: {
            periodKey: null,
            periodStartPrice: null,
            originalPrediction: null,
            updatedPrediction: null,
            kalshiTicker: null,
            kalshiCloseTime: null,
            kalshiStrike: null,
            smoothedProbability: null,
            lockedDirection: null,
            isTransitioning: false,
            lastKalshiTicker: null
        },
        nextPeriodPreview: null,
        sellSignal: null,
        errorAnalysis: {
            records: [],
            patterns: {
                byVolRegime: {}, byTrendRegime: {}, byTimeOfDay: {}, byDistanceBucket: {},
                byDirection: { up: { totalError: 0, count: 0, correctCount: 0 },
                              down: { totalError: 0, count: 0, correctCount: 0 } }
            },
            corrections: {
                volRegimeMultiplier: {}, directionBias: 0,
                overconfidenceRatio: 1.0, priceErrorScale: 1.0
            },
            lastAnalysis: null,
            totalAnalyzed: 0
        },
        onlineML: null,
    };
}

function createDefaultState() {
    return {
        assets: {
            btc: createDefaultAssetState(),
            eth: createDefaultAssetState(),
        },
        serverStartTime: Date.now(),
        lastPredictionTime: null,
        totalPredictionsMade: 0,
    };
}

// One-shot migration from the pre-multi-asset shape.
function migrateLegacyShape(saved) {
    if (saved && saved.assets) return saved; // already new shape
    const migrated = createDefaultState();
    migrated.serverStartTime = saved.serverStartTime || Date.now();
    migrated.lastPredictionTime = saved.lastPredictionTime || null;
    migrated.totalPredictionsMade = saved.totalPredictionsMade || 0;
    const btc = migrated.assets.btc;
    if (saved.predictionLog) btc.predictionLog = saved.predictionLog;
    if (saved.bayesianState) btc.bayesianState = { ...btc.bayesianState, ...saved.bayesianState };
    if (saved.currentPeriod) btc.currentPeriod = { ...btc.currentPeriod, ...saved.currentPeriod };
    if (saved.errorAnalysis) {
        btc.errorAnalysis = { ...btc.errorAnalysis, ...saved.errorAnalysis };
        if (saved.errorAnalysis.patterns) btc.errorAnalysis.patterns = { ...btc.errorAnalysis.patterns, ...saved.errorAnalysis.patterns };
        if (saved.errorAnalysis.corrections) btc.errorAnalysis.corrections = { ...btc.errorAnalysis.corrections, ...saved.errorAnalysis.corrections };
    }
    if (saved.nextPeriodPreview !== undefined) btc.nextPeriodPreview = saved.nextPeriodPreview;
    if (saved.sellSignal !== undefined) btc.sellSignal = saved.sellSignal;
    if (saved.onlineML !== undefined) btc.onlineML = saved.onlineML;
    return migrated;
}

let state = createDefaultState();
let saveTimer = null;
let dbSaveTimer = null;

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function load() {
    ensureDataDir();
    try {
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf8');
            const saved = JSON.parse(raw);
            state = migrateLegacyShape(saved);
            // Ensure every asset slice has all default fields (handles new fields after upgrade).
            for (const key of Object.keys(state.assets)) {
                state.assets[key] = { ...createDefaultAssetState(), ...state.assets[key] };
            }
            const totals = Object.entries(state.assets)
                .map(([k, s]) => `${k}=${(s.predictionLog || []).length}`)
                .join(' ');
            console.log(`[store] File loaded: ${totals}`);
        } else {
            console.log('[store] No existing store file found, will load from DB');
        }
    } catch (e) {
        console.error('[store] Failed to load store file, will load from DB:', e.message);
        state = createDefaultState();
    }
    state.serverStartTime = Date.now();
}

async function loadFromDB() {
    const db = getDb();
    if (!db) return;
    try {
        // BTC prediction log lives in the legacy single-table for now (no asset column).
        // ETH starts empty; load from DB key/value if present.
        const dbLog = await db.loadPredictionLog(500);
        if (dbLog && dbLog.length > 0) {
            const btc = state.assets.btc;
            if (btc.predictionLog.length === 0) {
                btc.predictionLog = dbLog;
                console.log(`[store] BTC: loaded ${dbLog.length} predictions from DB`);
            } else if (dbLog.length > btc.predictionLog.length) {
                const existing = new Set(btc.predictionLog.map(e => e.periodKey));
                let added = 0;
                for (const e of dbLog) {
                    if (!existing.has(e.periodKey)) { btc.predictionLog.push(e); added++; }
                }
                if (added > 0) {
                    btc.predictionLog.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                    console.log(`[store] BTC: merged ${added} additional predictions from DB`);
                }
            }
        }

        for (const assetKey of Object.keys(state.assets)) {
            const slice = state.assets[assetKey];
            const dbBay = await db.loadStoreState(`bayesianState-${assetKey}`)
                       || (assetKey === 'btc' ? await db.loadStoreState('bayesianState') : null);
            if (dbBay && (!slice.bayesianState.records || slice.bayesianState.records.length === 0)) {
                const defaults = createDefaultAssetState().bayesianState;
                slice.bayesianState = { ...defaults, ...dbBay };
            }
            const dbErr = await db.loadStoreState(`errorAnalysis-${assetKey}`)
                       || (assetKey === 'btc' ? await db.loadStoreState('errorAnalysis') : null);
            if (dbErr && (!slice.errorAnalysis.records || slice.errorAnalysis.records.length === 0)) {
                const defaults = createDefaultAssetState().errorAnalysis;
                slice.errorAnalysis = { ...defaults, ...dbErr };
                slice.errorAnalysis.patterns = { ...defaults.patterns, ...(dbErr.patterns || {}) };
                slice.errorAnalysis.corrections = { ...defaults.corrections, ...(dbErr.corrections || {}) };
            }
            const dbCurr = await db.loadStoreState(`currentPeriod-${assetKey}`)
                        || (assetKey === 'btc' ? await db.loadStoreState('currentPeriod') : null);
            if (dbCurr && !slice.currentPeriod.periodKey) {
                slice.currentPeriod = { ...createDefaultAssetState().currentPeriod, ...dbCurr };
            }
        }

        const dbMeta = await db.loadStoreState('meta');
        if (dbMeta) {
            if (dbMeta.totalPredictionsMade > state.totalPredictionsMade) {
                state.totalPredictionsMade = dbMeta.totalPredictionsMade;
            }
            if (dbMeta.lastPredictionTime && (!state.lastPredictionTime || dbMeta.lastPredictionTime > state.lastPredictionTime)) {
                state.lastPredictionTime = dbMeta.lastPredictionTime;
            }
        }
        console.log(`[store] DB load complete`);
    } catch (e) {
        console.error('[store] Failed to load from DB (continuing with file data):', e.message);
    }
}

function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; _doSave(); }, 2000);
    if (!dbSaveTimer) {
        dbSaveTimer = setTimeout(() => { dbSaveTimer = null; _doSaveDB(); }, 5000);
    }
}

function _doSave() {
    ensureDataDir();
    try {
        for (const slice of Object.values(state.assets)) {
            slice.bayesianState.records = (slice.bayesianState.records || []).slice(-200);
        }
        fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error('[store] Failed to save store file:', e.message);
    }
}

async function _doSaveDB() {
    const db = getDb();
    if (!db) return;
    try {
        const ops = [];
        for (const [key, slice] of Object.entries(state.assets)) {
            ops.push(db.saveStoreState(`bayesianState-${key}`, slice.bayesianState));
            ops.push(db.saveStoreState(`errorAnalysis-${key}`, slice.errorAnalysis));
            ops.push(db.saveStoreState(`currentPeriod-${key}`, slice.currentPeriod));
            if (slice.onlineML) ops.push(db.saveStoreState(`onlineML-${key}`, slice.onlineML));
        }
        ops.push(db.saveStoreState('meta', {
            totalPredictionsMade: state.totalPredictionsMade,
            lastPredictionTime: state.lastPredictionTime,
        }));
        await Promise.all(ops);
    } catch (e) {
        console.error('[store] Failed to save to DB:', e.message);
    }
}

// forceSave returns a promise so shutdown handlers can await the in-flight
// DB write. Without the await, the file write completes synchronously but
// the DB write is fire-and-forget and the process can exit before it lands.
function forceSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    _doSave();
    if (dbSaveTimer) { clearTimeout(dbSaveTimer); dbSaveTimer = null; }
    return Promise.resolve(_doSaveDB()).catch((e) => {
        console.error('[store] forceSave DB write failed:', e.message);
    });
}

// ── Slice accessor ───────────────────────────────────────────────
function slice(assetKey = 'btc') {
    if (!state.assets) state.assets = {};
    if (!state.assets[assetKey]) state.assets[assetKey] = createDefaultAssetState();
    return state.assets[assetKey];
}

// ── Public API (assetKey-aware, defaults to 'btc') ───────────────
function getState() { return state; }
function getPredictionLog(assetKey)   { return slice(assetKey).predictionLog; }
function getBayesianState(assetKey)   { return slice(assetKey).bayesianState; }
function getCurrentPeriod(assetKey)   { return slice(assetKey).currentPeriod; }
function getErrorAnalysis(assetKey)   { return slice(assetKey).errorAnalysis; }

function updateCurrentPeriod(updates, assetKey) {
    Object.assign(slice(assetKey).currentPeriod, updates);
    save();
}

function recordPrediction(entry, assetKey) {
    const asset = assetKey || 'btc';
    const log = slice(asset).predictionLog;
    if (log.length && log[log.length - 1].periodKey === entry.periodKey) return;
    log.push(entry);
    save();
    const db = getDb();
    if (db) {
        // Multi-asset post-P2.1 — both BTC and ETH persist to the prediction
        // _log table keyed by (period_key, asset).
        db.savePredictionLogEntry(entry, asset).catch(e =>
            console.error('[store] Failed to save prediction to DB:', e.message));
    }
}

function updatePredictionLog(updater, assetKey) {
    const asset = assetKey || 'btc';
    const log = slice(asset).predictionLog;
    updater(log);
    save();
    const db = getDb();
    if (db) {
        for (const entry of log) {
            if (entry.actualPrice != null || entry._directionUpdated) {
                db.savePredictionLogEntry(entry, asset).catch(e =>
                    console.error('[store] Failed to update prediction in DB:', e.message));
                delete entry._directionUpdated;
            }
        }
    }
}

function updateBayesianState(updater, assetKey) {
    updater(slice(assetKey).bayesianState);
    save();
}

function setNextPeriodPreview(preview, assetKey) {
    slice(assetKey).nextPeriodPreview = preview;
}

function setSellSignal(signal, assetKey) {
    slice(assetKey).sellSignal = signal;
}

function incrementPredictionCount() {
    state.totalPredictionsMade++;
    state.lastPredictionTime = Date.now();
}

function updateErrorAnalysis(updater, assetKey) {
    const s = slice(assetKey);
    if (!s.errorAnalysis) s.errorAnalysis = createDefaultAssetState().errorAnalysis;
    updater(s.errorAnalysis);
    if (s.errorAnalysis.records.length > 500) {
        s.errorAnalysis.records = s.errorAnalysis.records.slice(-500);
    }
    save();
}

function clearPredictionLog(assetKey) {
    if (assetKey) {
        // Reset just the requested asset.
        state.assets[assetKey] = createDefaultAssetState();
    } else {
        // Full reset — every asset slice plus server counters.
        for (const key of Object.keys(state.assets)) {
            state.assets[key] = createDefaultAssetState();
        }
        state.totalPredictionsMade = 0;
        state.lastPredictionTime = null;
    }
    try {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
        console.log('[store] Deleted prediction-state.json');
    } catch (e) {
        console.error('[store] Failed to delete store file:', e.message);
    }
    _doSave();
    const db = getDb();
    if (db && (!assetKey || assetKey === 'btc')) {
        db.clearPredictionLog().catch(e =>
            console.error('[store] Failed to clear prediction log from DB:', e.message));
    }
}

module.exports = {
    load, loadFromDB, save, forceSave, getState,
    getPredictionLog, getBayesianState, getCurrentPeriod,
    updateCurrentPeriod, recordPrediction, updatePredictionLog,
    updateBayesianState, setNextPeriodPreview, setSellSignal,
    incrementPredictionCount,
    getErrorAnalysis, updateErrorAnalysis,
    clearPredictionLog,
};
