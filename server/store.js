'use strict';

// ═══════════════════════════════════════════════════════════════
// PERSISTENT STORE — JSON file + PostgreSQL backed storage
// JSON file is primary (fast), DB is backup (survives deploys)
// On startup: loads from JSON file first, then fills gaps from DB
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'prediction-state.json');

// Lazy-loaded db reference (avoid circular dependency)
let _db = null;
function getDb() {
    if (!_db) {
        try { _db = require('./db'); } catch (e) { _db = null; }
    }
    return _db;
}

// Default state
function createDefaultState() {
    return {
        // Prediction log (all graded predictions)
        predictionLog: [],

        // Bayesian learning state
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
            calibrationBins: {
                0: { a: 1, b: 1 }, 1: { a: 1, b: 1 }, 2: { a: 1, b: 1 },
                3: { a: 1, b: 1 }, 4: { a: 1, b: 1 }, 5: { a: 1, b: 1 },
                6: { a: 1, b: 1 }, 7: { a: 1, b: 1 }, 8: { a: 1, b: 1 }
            }
        },

        // Current period state
        currentPeriod: {
            periodKey: null,
            periodStartPrice: null,     // = Kalshi strike
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

        // Next period preview
        nextPeriodPreview: null,

        // Sell signal
        sellSignal: null,

        // Self-learning error analysis log
        errorAnalysis: {
            // Rolling window of detailed error records
            records: [],
            // Aggregated error patterns by category
            patterns: {
                byVolRegime: {},     // avg error by vol regime
                byTrendRegime: {},   // avg error by trend regime
                byTimeOfDay: {},     // avg error by hour bucket
                byDistanceBucket: {},// avg error by distance-from-strike bucket
                byDirection: { up: { totalError: 0, count: 0, correctCount: 0 },
                              down: { totalError: 0, count: 0, correctCount: 0 } }
            },
            // Adaptive corrections learned from errors
            corrections: {
                volRegimeMultiplier: {},   // per-regime vol scaling
                directionBias: 0,          // systematic direction bias
                overconfidenceRatio: 1.0,  // how much to dampen confidence
                priceErrorScale: 1.0       // predicted price error scaling
            },
            lastAnalysis: null,
            totalAnalyzed: 0
        },

        // Online ML state (logistic regression, ensemble, calibrator, HMM)
        onlineML: null,

        // Server uptime tracking
        serverStartTime: Date.now(),
        lastPredictionTime: null,
        totalPredictionsMade: 0
    };
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
            // Merge with defaults to handle new fields
            state = { ...createDefaultState(), ...saved };
            // Deep merge bayesianState
            if (saved.bayesianState) {
                state.bayesianState = { ...createDefaultState().bayesianState, ...saved.bayesianState };
            }
            if (saved.currentPeriod) {
                state.currentPeriod = { ...createDefaultState().currentPeriod, ...saved.currentPeriod };
            }
            // Deep merge errorAnalysis to handle new sub-fields
            if (saved.errorAnalysis) {
                const defaults = createDefaultState().errorAnalysis;
                state.errorAnalysis = { ...defaults, ...saved.errorAnalysis };
                state.errorAnalysis.patterns = { ...defaults.patterns, ...saved.errorAnalysis.patterns };
                state.errorAnalysis.corrections = { ...defaults.corrections, ...saved.errorAnalysis.corrections };
            }
            console.log(`[store] File loaded: ${state.predictionLog.length} predictions, ${state.bayesianState.records.length} Bayesian records`);
        } else {
            console.log('[store] No existing store file found, will load from DB');
        }
    } catch (e) {
        console.error('[store] Failed to load store file, will load from DB:', e.message);
        state = createDefaultState();
    }
    state.serverStartTime = Date.now();
}

// Load from DB — called after db.init() completes
async function loadFromDB() {
    const db = getDb();
    if (!db) return;

    try {
        // Load prediction log from DB
        const dbLog = await db.loadPredictionLog(500);
        if (dbLog && dbLog.length > 0) {
            if (state.predictionLog.length === 0) {
                // JSON file was empty/missing, use DB data
                state.predictionLog = dbLog;
                console.log(`[store] Loaded ${dbLog.length} predictions from DB`);
            } else if (dbLog.length > state.predictionLog.length) {
                // DB has more entries (file was stale), merge
                const existingKeys = new Set(state.predictionLog.map(e => e.periodKey));
                let added = 0;
                for (const entry of dbLog) {
                    if (!existingKeys.has(entry.periodKey)) {
                        state.predictionLog.push(entry);
                        added++;
                    }
                }
                if (added > 0) {
                    // Sort by timestamp
                    state.predictionLog.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                    console.log(`[store] Merged ${added} additional predictions from DB`);
                }
            }
        }

        // Load learning state from DB
        const dbBayesian = await db.loadStoreState('bayesianState');
        if (dbBayesian && (!state.bayesianState.records || state.bayesianState.records.length === 0)) {
            const defaults = createDefaultState().bayesianState;
            state.bayesianState = { ...defaults, ...dbBayesian };
            console.log(`[store] Loaded bayesian state from DB (${state.bayesianState.records?.length || 0} records)`);
        }

        const dbErrorAnalysis = await db.loadStoreState('errorAnalysis');
        if (dbErrorAnalysis && (!state.errorAnalysis.records || state.errorAnalysis.records.length === 0)) {
            const defaults = createDefaultState().errorAnalysis;
            state.errorAnalysis = { ...defaults, ...dbErrorAnalysis };
            state.errorAnalysis.patterns = { ...defaults.patterns, ...(dbErrorAnalysis.patterns || {}) };
            state.errorAnalysis.corrections = { ...defaults.corrections, ...(dbErrorAnalysis.corrections || {}) };
            console.log(`[store] Loaded error analysis from DB (${state.errorAnalysis.records?.length || 0} records)`);
        }

        const dbCurrentPeriod = await db.loadStoreState('currentPeriod');
        if (dbCurrentPeriod && !state.currentPeriod.periodKey) {
            state.currentPeriod = { ...createDefaultState().currentPeriod, ...dbCurrentPeriod };
            console.log(`[store] Loaded current period from DB: ${state.currentPeriod.periodKey}`);
        }

        const dbOnlineML = await db.loadStoreState('onlineML');
        if (dbOnlineML && !state.onlineML) {
            state.onlineML = dbOnlineML;
            console.log(`[store] Loaded online ML state from DB`);
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

        console.log(`[store] DB load complete: ${state.predictionLog.length} total predictions`);
    } catch (e) {
        console.error('[store] Failed to load from DB (continuing with file data):', e.message);
    }
}

function save() {
    // Debounce saves to avoid excessive disk I/O
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        _doSave();
    }, 2000);

    // Also debounce DB saves (slightly longer interval)
    if (!dbSaveTimer) {
        dbSaveTimer = setTimeout(() => {
            dbSaveTimer = null;
            _doSaveDB();
        }, 5000);
    }
}

function _doSave() {
    ensureDataDir();
    try {
        state.bayesianState.records = state.bayesianState.records.slice(-200);
        fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error('[store] Failed to save store file:', e.message);
    }
}

async function _doSaveDB() {
    const db = getDb();
    if (!db) return;

    try {
        // Save learning state to DB
        await Promise.all([
            db.saveStoreState('bayesianState', state.bayesianState),
            db.saveStoreState('errorAnalysis', state.errorAnalysis),
            db.saveStoreState('currentPeriod', state.currentPeriod),
            state.onlineML ? db.saveStoreState('onlineML', state.onlineML) : Promise.resolve(),
            db.saveStoreState('meta', {
                totalPredictionsMade: state.totalPredictionsMade,
                lastPredictionTime: state.lastPredictionTime,
            }),
        ]);
    } catch (e) {
        console.error('[store] Failed to save to DB:', e.message);
    }
}

function forceSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    _doSave();
    // Also force DB save
    if (dbSaveTimer) {
        clearTimeout(dbSaveTimer);
        dbSaveTimer = null;
    }
    _doSaveDB();
}

function getState() { return state; }

function getPredictionLog() { return state.predictionLog; }
function getBayesianState() { return state.bayesianState; }
function getCurrentPeriod() { return state.currentPeriod; }

function updateCurrentPeriod(updates) {
    Object.assign(state.currentPeriod, updates);
    save();
}

function recordPrediction(entry) {
    // Don't duplicate
    if (state.predictionLog.length &&
        state.predictionLog[state.predictionLog.length - 1].periodKey === entry.periodKey) return;
    state.predictionLog.push(entry);
    save();

    // Also save to DB immediately
    const db = getDb();
    if (db) {
        db.savePredictionLogEntry(entry).catch(e =>
            console.error('[store] Failed to save prediction to DB:', e.message));
    }
}

function updatePredictionLog(updater) {
    updater(state.predictionLog);
    save();

    // Sync updated entries to DB (graded entries + direction flip updates)
    const db = getDb();
    if (db) {
        for (const entry of state.predictionLog) {
            if (entry.actualPrice != null || entry._directionUpdated) {
                db.savePredictionLogEntry(entry).catch(e =>
                    console.error('[store] Failed to update prediction in DB:', e.message));
                delete entry._directionUpdated;
            }
        }
    }
}

function updateBayesianState(updater) {
    updater(state.bayesianState);
    save();
}

function setNextPeriodPreview(preview) {
    state.nextPeriodPreview = preview;
    // No save needed for transient data
}

function setSellSignal(signal) {
    state.sellSignal = signal;
}

function incrementPredictionCount() {
    state.totalPredictionsMade++;
    state.lastPredictionTime = Date.now();
}

function getErrorAnalysis() { return state.errorAnalysis; }

function updateErrorAnalysis(updater) {
    if (!state.errorAnalysis) {
        state.errorAnalysis = createDefaultState().errorAnalysis;
    }
    updater(state.errorAnalysis);
    // Keep records bounded
    if (state.errorAnalysis.records.length > 500) {
        state.errorAnalysis.records = state.errorAnalysis.records.slice(-500);
    }
    save();
}

// Clear prediction log from both memory and DB
function clearPredictionLog() {
    // Full reset: replace entire state with defaults (not just predictionLog)
    const defaults = createDefaultState();
    state.predictionLog = [];
    state.bayesianState = defaults.bayesianState;
    state.currentPeriod = defaults.currentPeriod;
    state.errorAnalysis = defaults.errorAnalysis;
    state.onlineML = null;
    state.totalPredictionsMade = 0;
    state.lastPredictionTime = null;
    state.nextPeriodPreview = null;
    state.sellSignal = null;

    // Delete JSON file so stale data doesn't reload on restart
    try {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
        console.log('[store] Deleted prediction-state.json');
    } catch (e) {
        console.error('[store] Failed to delete store file:', e.message);
    }

    // Save fresh state to both file and DB
    _doSave();

    const db = getDb();
    if (db) {
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
    clearPredictionLog
};
