'use strict';

// ═══════════════════════════════════════════════════════════════
// PERSISTENT STORE — JSON file-based storage (replaces localStorage)
// Runs server-side so all clients see the same data
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'prediction-state.json');

// Default state
function createDefaultState() {
    return {
        // Prediction log (last 50 graded predictions)
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
                3: { a: 1, b: 1 }, 4: { a: 1, b: 1 }, 5: { a: 1, b: 1 }
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

        // Server uptime tracking
        serverStartTime: Date.now(),
        lastPredictionTime: null,
        totalPredictionsMade: 0
    };
}

let state = createDefaultState();
let saveTimer = null;

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
            console.log(`Store loaded: ${state.predictionLog.length} predictions, ${state.bayesianState.records.length} Bayesian records`);
        } else {
            console.log('No existing store found, starting fresh');
        }
    } catch (e) {
        console.error('Failed to load store, starting fresh:', e.message);
        state = createDefaultState();
    }
    state.serverStartTime = Date.now();
}

function save() {
    // Debounce saves to avoid excessive disk I/O
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        _doSave();
    }, 2000);
}

function _doSave() {
    ensureDataDir();
    try {
        // Trim data before saving
        state.predictionLog = state.predictionLog.slice(-50);
        state.bayesianState.records = state.bayesianState.records.slice(-200);
        fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error('Failed to save store:', e.message);
    }
}

function forceSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    _doSave();
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
    state.predictionLog = state.predictionLog.slice(-50);
    save();
}

function updatePredictionLog(updater) {
    updater(state.predictionLog);
    save();
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

module.exports = {
    load, save, forceSave, getState,
    getPredictionLog, getBayesianState, getCurrentPeriod,
    updateCurrentPeriod, recordPrediction, updatePredictionLog,
    updateBayesianState, setNextPeriodPreview, setSellSignal,
    incrementPredictionCount,
    getErrorAnalysis, updateErrorAnalysis
};
