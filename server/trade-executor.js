'use strict';

// ═══════════════════════════════════════════════════════════════
// Trade Executor — Bridges prediction signals to Kalshi orders
// ═══════════════════════════════════════════════════════════════
// Reads signals from: assessBetQuality(), assessSellSignal()
// Executes via: kalshi-trading.js
// Safety: paper mode, daily loss limit, position cap, kill switch
// ═══════════════════════════════════════════════════════════════

const trading = require('./kalshi-trading');
const decisionLog = require('./decision-logger');
const { getEnvironment } = require('./kalshi-auth');
const db = require('./db');

// ── Kalshi orderbook snapshot helper ──
let _lastObSnapTime = 0;
function captureKalshiOrderbook(ticker, reason, minutesRemaining, yesBids, noBids) {
    // For 'periodic' reason, throttle to once per 30s. For trade events, always capture.
    const now = Date.now();
    if (reason === 'periodic' && now - _lastObSnapTime < 30000) return;
    _lastObSnapTime = now;

    // Parse bids to find best prices and depth
    const parseBids = (bids) => {
        if (!bids || bids.length === 0) return { best: null, depth: 0, entries: [] };
        let best = 0;
        let depth = 0;
        const entries = [];
        for (const entry of bids) {
            const price = parseFloat(entry[0]);
            const size = parseFloat(entry[1]);
            if (price > best) best = price;
            depth += size;
            entries.push([price, size]);
        }
        return { best, depth, entries };
    };

    const yes = parseBids(yesBids);
    const no = parseBids(noBids);

    // Derive asks: YES ask = 1 - best NO bid, NO ask = 1 - best YES bid
    const bestYesAsk = no.best ? Math.round((1 - no.best) * 100) : null;
    const bestNoAsk = yes.best ? Math.round((1 - yes.best) * 100) : null;
    const bestYesBid = yes.best ? Math.round(yes.best * 100) : null;
    const bestNoBid = no.best ? Math.round(no.best * 100) : null;

    // Spread in cents
    const spreadCents = (bestYesBid != null && bestYesAsk != null) ? bestYesAsk - bestYesBid : null;

    const periodKey = currentPosition ? currentPosition.periodKey : null;

    db.saveOrderbookSnapshot({
        periodKey: periodKey || 'unknown',
        ticker,
        reason,
        minutesRemaining,
        yesBids: yes.entries,
        noBids: no.entries,
        bestYesBid,
        bestNoBid,
        bestYesAsk,
        bestNoAsk,
        yesDepth: yes.depth,
        noDepth: no.depth,
        spreadCents,
        btcPrice: null, // not readily available here
        strike: null,
    }).catch(e => console.error('[snapshot] Orderbook save error:', e.message));
}

// ── Configuration (from env, with safe defaults) ──
const config = {
    paperMode: (process.env.PAPER_MODE || 'true').toLowerCase() === 'true',
    baseContracts: parseInt(process.env.BASE_CONTRACTS || '10', 10), // percentage of balance to bet (e.g. 10 = 10%)
    maxPositionContracts: parseInt(process.env.MAX_POSITION_CONTRACTS || '50', 10),
    convictionMaxContracts: parseInt(process.env.CONVICTION_MAX_CONTRACTS || '50', 10), // hard safety cap for high-conviction bets
    maxDailyLossCents: parseInt(process.env.MAX_DAILY_LOSS || '10000', 10),   // $100
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '200', 10),
};

// ── State ──
let currentPosition = null;   // { ticker, side, action, contracts, entryPrice, orderId, periodKey, totalCostCents, totalContracts }

// Persist position to DB whenever it changes (debounced)
let positionSaveTimer = null;
function persistPosition() {
    if (positionSaveTimer) return;
    positionSaveTimer = setTimeout(() => {
        positionSaveTimer = null;
        db.savePosition(currentPosition).catch(e => console.error('[db] Position save error:', e.message));
    }, 1000);
}
let killSwitch = false;
let soldThisPeriod = null;    // Track sold positions for re-entry: { periodKey, side, ticker, soldAt, reason }
let flippedThisPeriod = false; // Track if we already flipped this cycle (limit to 1 flip)
let lastDipCheckTime = 0;     // Throttle dip checks (one per 10s tick)
let cachedBalance = null;     // { balanceCents, lastFetched }
let periodTotalCostCents = 0; // Track total cost spent in current period
let periodCostKey = null;     // Period key for cost tracking
const BALANCE_CACHE_MS = 30000; // refresh balance every 30s

// ── Paper balance tracking (separate per environment) ──
const paperBalances = {
    demo: 250000,       // $2500.00 default starting balance (cents)
    production: 250000, // $2500.00 default starting balance (cents)
};
let orderInFlight = false;    // mutex: prevent concurrent order placement
let fillFailedPeriods = {};   // { periodKey: { count, lastAttempt } } — track fill failures for price adjustment
let enteredPeriods = {};      // { periodKey: { side, ticker, entryTime } } — prevent duplicate entries even if position is cleared
let syncZeroCount = 0;        // consecutive times sync read 0 contracts — require 3 before clearing

// Get the current 15-minute period key (matches server.js getPeriodKey format)
function getCurrentPeriodKey() {
    const now = new Date();
    const mins = now.getMinutes();
    const periodStart = Math.floor(mins / 15) * 15;
    return now.getHours() + ':' + periodStart;
}

// Validate currentPosition against the current period.
// If the position is from a previous period, auto-settle it to prevent phantom positions.
// This is critical for paper mode (no Kalshi API to sync with) and also catches
// stale positions restored from DB after server restart.
function validateCurrentPosition() {
    if (!currentPosition) return;
    const currentPeriod = getCurrentPeriodKey();
    if (currentPosition.periodKey && currentPosition.periodKey !== currentPeriod) {
        const positionAge = Date.now() - (currentPosition.entryTime || 0);
        // Only clear if position is old enough (>2 min) to avoid race conditions at period boundaries
        if (positionAge > 120000) {
            console.log(`[trade-executor] Stale position detected: position period=${currentPosition.periodKey}, current period=${currentPeriod}, age=${Math.round(positionAge/1000)}s — auto-settling`);
            // In paper mode, settle the position (assume loss conservatively)
            if (config.paperMode) {
                const contracts = currentPosition.totalContracts || currentPosition.contracts;
                const cost = currentPosition.totalCostCents || (contracts * currentPosition.entryPrice);
                // We don't know the result, but the position should have been settled by onPeriodEnd.
                // If it wasn't (missed period end), assume loss.
                dailyStats.losses++;
                dailyStats.pnlCents -= cost;
                const env = getEnvironment();
                // Don't add back proceeds — assume worst case (total loss)
                logTrade('settle', {
                    ticker: currentPosition.ticker,
                    side: currentPosition.side,
                    contracts,
                    entryPrice: currentPosition.entryPrice,
                    correct: false,
                    pnlCents: -cost,
                    dailyPnlCents: dailyStats.pnlCents,
                    periodKey: currentPosition.periodKey,
                    note: 'auto-settled stale phantom position (missed period end)',
                });
            }
            currentPosition = null;
            persistPosition();
            setThought('idle', 'Cleared stale position from previous period — ready for new trades');
        }
    }
}

// ── Dynamic base contract sizing ──
// baseContracts is a percentage of balance (e.g. 10 = 10%).
// Given an entry price, compute how many contracts that translates to.
// Example: balance=$100, baseContracts=10 (10%), entryPrice=50c → $10 / $0.50 = 20 contracts
function getBaseContractCount(entryPriceCents) {
    const env = getEnvironment();
    let balanceCents;
    if (config.paperMode) {
        balanceCents = paperBalances[env] || 0;
    } else {
        balanceCents = cachedBalance ? cachedBalance.balanceCents : null;
    }
    // Fallback: if balance is unknown, use a conservative default
    if (!balanceCents || balanceCents <= 0) {
        console.log(`[trade-executor] getBaseContractCount: no balance available — using fallback of 1 contract`);
        return 1;
    }
    const pct = config.baseContracts / 100; // e.g. 10 → 0.10
    const betAmountCents = balanceCents * pct;
    const price = Math.max(5, entryPriceCents || 50); // guard against 0/null
    const contracts = Math.floor(betAmountCents / price);
    console.log(`[trade-executor] Base sizing: ${config.baseContracts}% of $${(balanceCents/100).toFixed(2)} = $${(betAmountCents/100).toFixed(2)} / ${price}c = ${contracts} contracts`);
    return Math.max(1, contracts);
}

// ── Bankroll-relative max contract sizing ──
// Computes max contracts based on a percentage of bankroll, preventing
// catastrophically oversized positions regardless of static config caps.
function getMaxContractsForRisk(entryPriceCents, maxRiskPct) {
    const env = getEnvironment();
    const balanceCents = config.paperMode ? (paperBalances[env] || 5000) : (cachedBalance?.balanceCents || 5000);
    const maxRiskCents = balanceCents * maxRiskPct;
    return Math.max(1, Math.floor(maxRiskCents / entryPriceCents));
}

// ── Loss-recovery flip sizing ──
// When flipping, calculate how many contracts are needed to recover
// the loss from selling the original position, plus a profit margin.
// Kalshi contracts pay 100¢ if correct, 0¢ if wrong.
// Profit per contract = 100 - flipPriceCents
// Required contracts = (lossCents + minProfitCents) / profitPerContract
// We take the MAX of this and the normal base sizing.
const FLIP_MIN_PROFIT_PCT = 0.20; // require at least 20% profit on top of loss recovery

function getFlipRecoveryContracts(lossCents, flipPriceCents, originalContracts) {
    if (!lossCents || lossCents <= 0) return 0; // no loss to recover
    const profitPerContract = 100 - flipPriceCents; // cents profit per contract if correct
    if (profitPerContract <= 0) return 0; // can't profit at this price

    const minProfitCents = Math.max(lossCents * FLIP_MIN_PROFIT_PCT, 10); // at least 20% of loss or 10¢
    let neededContracts = Math.ceil((lossCents + minProfitCents) / profitPerContract);

    // Cap flip at 1.5x original position - no martingale recovery
    if (originalContracts && originalContracts > 0) {
        const maxFlipContracts = Math.ceil(originalContracts * 1.5);
        if (neededContracts > maxFlipContracts) {
            console.log(`[trade-executor] Flip recovery: capping ${neededContracts} → ${maxFlipContracts} contracts (1.5x original ${originalContracts})`);
            neededContracts = Math.min(neededContracts, maxFlipContracts);
        }
    }

    console.log(`[trade-executor] Flip recovery: loss=$${(lossCents/100).toFixed(2)}, flipPrice=${flipPriceCents}c, profit/contract=${profitPerContract}c, need ${neededContracts} contracts to recover $${((lossCents + minProfitCents)/100).toFixed(2)}`);
    return neededContracts;
}

// Auto-trader thought status — exposed to the frontend
let traderThought = { status: 'idle', message: 'Waiting for prediction', timestamp: Date.now(), detail: null };

function setThought(status, message, detail) {
    traderThought = { status, message, timestamp: Date.now(), detail: detail || null };
}

const dailyStats = {
    date: new Date().toISOString().slice(0, 10),
    pnlCents: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
};

const tradeLog = [];           // recent trades for dashboard (max 100)
const MAX_TRADE_LOG = 500;
const pendingOrders = [];      // orders placed but not yet confirmed filled

// ── Fill verification helpers ──
// Kalshi deprecated integer count fields (March 12, 2026).
// Use _fp string fields ("10.00") with fallback to legacy integers.

function parseOrderFills(order) {
    const filled = parseFloat(order.fill_count_fp) || order.fill_count || 0;
    const remaining = parseFloat(order.remaining_count_fp) || order.remaining_count || 0;
    const initial = parseFloat(order.initial_count_fp) || order.initial_count || order.count || 0;
    return { filled: Math.round(filled), remaining: Math.round(remaining), initial: Math.round(initial) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Handle a resting order: poll periodically, then cancel unfilled remainder.
 * The demo API returns 404 for GET /portfolio/orders/{id}, so we poll via
 * getOrders() with ticker filter, and also check the cancel response for
 * final fill counts.
 */
async function waitForFill(orderId, createResponse, maxWaitMs = 15000) {
    const pollInterval = 2000;
    const startTime = Date.now();

    // Poll for fills (the order may match while resting)
    while (Date.now() - startTime < maxWaitMs) {
        await sleep(pollInterval);

        // Try to check order status
        try {
            const orderResp = await trading.getOrder(orderId);
            const o = orderResp.order || orderResp;
            if (o.status === 'executed' || o.status === 'filled') {
                console.log(`[trade-executor] Resting order ${orderId} filled during wait! fill_count_fp=${o.fill_count_fp}`);
                return o;
            }
            if (o.status === 'canceled' || o.status === 'cancelled') {
                console.log(`[trade-executor] Resting order ${orderId} was cancelled externally`);
                return o;
            }
            // Still resting — check for partial fills
            const fillCount = parseFloat(o.fill_count_fp || '0');
            if (fillCount > 0) {
                console.log(`[trade-executor] Resting order ${orderId} partially filled: ${fillCount}`);
                // Cancel remainder and return
                try { await trading.cancelOrder(orderId); } catch (e) { /* may already be done */ }
                return o;
            }
        } catch (e) {
            // 404 on demo — can't poll, just keep waiting
            if (e.status !== 404) {
                console.log(`[trade-executor] Poll for ${orderId}: ${e.message}`);
            }
        }
    }

    // Time's up — cancel the resting order
    try {
        const cancelResp = await trading.cancelOrder(orderId);
        console.log(`[trade-executor] Cancelled resting order ${orderId} after ${maxWaitMs}ms`);
        // The cancel response may contain updated fill info
        if (cancelResp && cancelResp.order) return cancelResp.order;
    } catch (e) {
        // 404 = order already gone (filled or expired). Try to get final state.
        if (e.status === 404) {
            console.log(`[trade-executor] Order ${orderId} already gone (likely filled)`);
        } else {
            console.log(`[trade-executor] Cancel attempt for ${orderId}: ${e.message}`);
        }
    }

    // Return original create response as fallback
    return createResponse;
}

/**
 * Verify a position actually exists on Kalshi by checking the portfolio API.
 * Returns the number of contracts we actually hold, or 0 if none.
 */
async function verifyPositionOnKalshi(ticker, side) {
    if (config.paperMode) return -1; // skip verification in paper mode
    if (getEnvironment() === 'demo') return -1; // demo portfolio doesn't reflect demo orders
    try {
        const resp = await trading.getPositions();
        const positions = resp.market_positions || resp.positions || [];
        for (const pos of positions) {
            if (pos.ticker === ticker) {
                // Kalshi returns yes_count/no_count or market_exposure
                const count = side === 'yes'
                    ? (pos.yes_count || parseInt(pos.yes_count_fp) || 0)
                    : (pos.no_count || parseInt(pos.no_count_fp) || 0);
                console.log(`[trade-executor] Kalshi position check: ${ticker} ${side} = ${count} contracts`);
                return count;
            }
        }
        console.log(`[trade-executor] Kalshi position check: NO position found for ${ticker}`);
        return 0;
    } catch (e) {
        console.log(`[trade-executor] Position verification failed: ${e.message}`);
        return -1; // unknown — don't block on verification failure
    }
}

/**
 * Verify balance actually changed after an order.
 * Returns true if balance decreased (order cost money), false if unchanged.
 */
async function verifyBalanceChanged(previousBalanceCents) {
    if (config.paperMode) return true;
    try {
        const resp = await trading.getBalance();
        const newBalance = resp.balance;
        const changed = newBalance < previousBalanceCents;
        console.log(`[trade-executor] Balance check: was ${previousBalanceCents}c, now ${newBalance}c — ${changed ? 'CHANGED' : 'UNCHANGED'}`);
        return changed;
    } catch (e) {
        console.log(`[trade-executor] Balance check failed: ${e.message}`);
        return true; // don't block on failure
    }
}

/**
 * Ground-truth verification: after the order API claims a fill,
 * verify via balance change + portfolio positions that it's real.
 * Returns the verified contract count (0 if phantom fill detected).
 */
async function verifyFillIsReal(orderId, ticker, side, claimedFills, balanceBefore) {
    // Demo API: balance & portfolio endpoints don't reflect demo orders.
    // The demo API's status=executed IS the simulation — trust it.
    if (getEnvironment() === 'demo') {
        console.log(`[trade-executor] Demo mode: trusting API response (${claimedFills} fills) — skipping balance/portfolio verification`);
        return claimedFills;
    }

    const balanceChanged = await verifyBalanceChanged(balanceBefore);
    if (balanceChanged) return claimedFills; // balance moved — fill is real

    // Balance didn't change — cross-check with portfolio
    const kalshiCount = await verifyPositionOnKalshi(ticker, side);
    if (kalshiCount === 0) {
        console.log(`[trade-executor] PHANTOM FILL: Order ${orderId} claims ${claimedFills} fills but balance unchanged & no position. Discarding.`);
        return 0;
    }
    if (kalshiCount > 0) {
        console.log(`[trade-executor] Using Kalshi position count: ${kalshiCount} (order claimed ${claimedFills})`);
        return kalshiCount;
    }
    // kalshiCount === -1 means verification failed — trust claimed fills
    return claimedFills;
}

// ═══════════════════════════════════════════════════════════════
// Daily reset
// ═══════════════════════════════════════════════════════════════

let dailyStatsSaveTimer = null;
function persistDailyStats() {
    // Debounce — save at most every 2s
    if (dailyStatsSaveTimer) return;
    dailyStatsSaveTimer = setTimeout(() => {
        dailyStatsSaveTimer = null;
        db.saveDailyStats(dailyStats).catch(e => console.error('[db] Daily stats save error:', e.message));
    }, 2000);
}

async function checkDayRollover() {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyStats.date !== today) {
        // Save yesterday's final stats before resetting
        await db.saveDailyStats(dailyStats);
        dailyStats.date = today;
        dailyStats.pnlCents = 0;
        dailyStats.tradeCount = 0;
        dailyStats.wins = 0;
        dailyStats.losses = 0;
        // Load today's stats if they exist (e.g., after restart mid-day)
        const saved = await db.loadDailyStats(today);
        if (saved) {
            dailyStats.pnlCents = saved.pnlCents;
            dailyStats.tradeCount = saved.tradeCount;
            dailyStats.wins = saved.wins;
            dailyStats.losses = saved.losses;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Safety checks
// ═══════════════════════════════════════════════════════════════

async function canTrade(periodKey) {
    await checkDayRollover();

    if (killSwitch) return { ok: false, reason: 'Kill switch active' };
    if (orderInFlight) return { ok: false, reason: 'Order already in flight' };
    if (!trading.isConfigured()) {
        return { ok: false, reason: 'Kalshi API not configured (set KALSHI_API_KEY + KALSHI_PRIVATE_KEY)' };
    }
    if (dailyStats.pnlCents <= -config.maxDailyLossCents) {
        return { ok: false, reason: `Daily loss limit reached ($${(Math.abs(dailyStats.pnlCents) / 100).toFixed(2)})` };
    }
    if (dailyStats.tradeCount >= config.maxDailyTrades) {
        return { ok: false, reason: `Daily trade limit reached (${dailyStats.tradeCount})` };
    }
    // Track fill failures with short cooldown to avoid spamming unfillable orders
    // After 5 fails: 5s cooldown. After 10 fails: 15s. After 20+: 30s cooldown.
    if (periodKey && fillFailedPeriods[periodKey]) {
        const ff = fillFailedPeriods[periodKey];
        if (ff.count >= 5) {
            const cooldownMs = ff.count >= 20 ? 30000 : ff.count >= 10 ? 15000 : 5000;
            const elapsed = Date.now() - ff.lastAttempt;
            if (elapsed < cooldownMs) {
                const remaining = Math.round((cooldownMs - elapsed) / 1000);
                return { ok: false, reason: `${ff.count} fill failures this period — cooldown ${remaining}s` };
            }
        }
    }
    return { ok: true };
}

// Check if adding proposedCost would exceed period exposure cap (15% of bankroll)
function checkPeriodExposure(periodKey, proposedCost) {
    // Reset tracking when period changes
    if (periodCostKey !== periodKey) {
        periodTotalCostCents = 0;
        periodCostKey = periodKey;
    }
    const env = getEnvironment();
    const balanceCents = config.paperMode ? (paperBalances[env] || 5000) : (cachedBalance?.balanceCents || 5000);
    const maxPeriodExposure = balanceCents * 0.15; // max 15% of bankroll per period
    if (periodTotalCostCents + proposedCost > maxPeriodExposure) {
        console.log(`[trade-executor] Period exposure cap reached: ${periodTotalCostCents}c + ${proposedCost}c > ${maxPeriodExposure.toFixed(0)}c (15% of $${(balanceCents/100).toFixed(2)})`);
        return false;
    }
    return true;
}

function trackPeriodCost(periodKey, cost) {
    if (periodCostKey !== periodKey) {
        periodTotalCostCents = 0;
        periodCostKey = periodKey;
    }
    periodTotalCostCents += cost;
}

function markFillFailed(periodKey) {
    if (!fillFailedPeriods[periodKey]) {
        fillFailedPeriods[periodKey] = { count: 0, lastAttempt: 0 };
    }
    fillFailedPeriods[periodKey].count++;
    fillFailedPeriods[periodKey].lastAttempt = Date.now();
    console.log(`[trade-executor] Fill failed for period ${periodKey} (attempt ${fillFailedPeriods[periodKey].count})`);
}

/**
 * Get a smart limit price based on orderbook and fair value.
 *
 * KEY PRINCIPLE: Never pay more than theoreticalPrice + maxSlippage.
 * The old approach ("pay whatever the ask is") destroyed all edge by
 * giving away 5-15¢ per trade in slippage. With a 2-4% edge (~1-4¢),
 * that made every trade negative EV.
 *
 * Strategy by time remaining:
 * - >10 min: Post at fair value (be a maker, earn the spread)
 * - 4-10 min: Fair value + 2¢ (patient taker)
 * - <4 min: Pay the ask but cap at fair value + 5¢
 *
 * Kalshi orderbook format (post-March-12):
 *   { orderbook_fp: { yes_dollars: [["0.58","10.00"], ...], no_dollars: [...] } }
 *   Each entry is [price_dollars, count_fp] — BIDS only.
 *   YES bid at $X = NO ask at $(1.00-X), and vice versa.
 *
 * Returns a price in cents (5-95).
 */
async function fetchOrderbook(ticker) {
    // Fetch orderbook: auth API first, then trading-api fallback, then public API fallback
    let resp = null;
    try {
        resp = await trading.getOrderbook(ticker);
    } catch (e) {
        console.log(`[trade-executor] Auth orderbook failed: ${e.message} — trying fallback APIs`);
    }
    // Validate the response has actual data — some responses are empty shells
    if (resp) {
        const book = resp.orderbook_fp || resp.orderbook || resp;
        const hasData = book && (
            (book.yes_dollars && book.yes_dollars.length > 0) ||
            (book.no_dollars && book.no_dollars.length > 0) ||
            (book.yes && book.yes.length > 0) ||
            (book.no && book.no.length > 0)
        );
        if (hasData) return resp;
        console.log(`[trade-executor] Auth orderbook returned empty structure: keys=${Object.keys(book).join(',')} — trying fallbacks`);
        resp = null;
    }
    // Fallback 1: use the correct base URL (trading-api.kalshi.com for prod, demo-api.kalshi.co for demo)
    const { getBaseUrl } = require('./kalshi-auth');
    const fallbackUrls = [
        `${getBaseUrl()}/trade-api/v2/markets/${ticker}/orderbook`,
        `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`,
    ];
    for (const url of fallbackUrls) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (res.ok) {
                resp = await res.json();
                const book = resp.orderbook_fp || resp.orderbook || resp;
                const hasData = book && (
                    (book.yes_dollars && book.yes_dollars.length > 0) ||
                    (book.no_dollars && book.no_dollars.length > 0) ||
                    (book.yes && book.yes.length > 0) ||
                    (book.no && book.no.length > 0)
                );
                if (hasData) {
                    console.log(`[trade-executor] Fallback orderbook OK from ${url.split('/markets/')[0]}`);
                    return resp;
                }
                console.log(`[trade-executor] Fallback returned empty orderbook from ${url.split('/markets/')[0]}`);
                resp = null;
            }
        } catch (e2) {
            console.log(`[trade-executor] Fallback orderbook failed (${url.split('/markets/')[0]}): ${e2.message}`);
        }
    }
    return resp;
}

function parseOrderbookAsk(resp, side, ticker, minutesRemaining) {
    // Parse orderbook and return best ask price for the given side (in cents)
    if (!resp) return null;
    const book = resp.orderbook_fp || resp.orderbook || resp;
    const isDollarFmt = !!(book.yes_dollars || book.no_dollars);
    const yesBids = book.yes_dollars || book.yes || [];
    const noBids = book.no_dollars || book.no || [];

    // Debug: log what we parsed so we can diagnose "no liquidity" false positives
    if (yesBids.length === 0 && noBids.length === 0) {
        const respKeys = Object.keys(resp).join(',');
        const bookKeys = book ? Object.keys(book).join(',') : 'null';
        console.log(`[trade-executor] parseOrderbookAsk: EMPTY orderbook — resp keys=[${respKeys}], book keys=[${bookKeys}], isDollar=${isDollarFmt}`);
    }

    const oppositeBids = side === 'yes' ? noBids : yesBids;

    // ── DB: snapshot the full Kalshi orderbook ──
    captureKalshiOrderbook(ticker, 'trade_entry', minutesRemaining, yesBids, noBids);

    if (!oppositeBids || oppositeBids.length === 0) {
        console.log(`[trade-executor] parseOrderbookAsk: no ${side === 'yes' ? 'NO' : 'YES'} bids (opposing side empty) — yes=${yesBids.length} bids, no=${noBids.length} bids`);
        return null;
    }

    const askPrices = oppositeBids.map(entry => {
        const raw = parseFloat(entry[0]);
        const bidDollars = isDollarFmt ? raw : raw / 100;
        return Math.round((1.00 - bidDollars) * 100);
    });
    return Math.min(...askPrices);
}

// Get the actual market ask price — what it would cost to buy right now.
// Used by FORCE BET and PRESS BET to trade at market price (no theoretical cap).
// Returns price in cents, or null if no liquidity.
async function getMarketPrice(ticker, side, minutesRemaining) {
    try {
        const resp = await fetchOrderbook(ticker);
        if (!resp) return null;
        const bestAsk = parseOrderbookAsk(resp, side, ticker, minutesRemaining);
        if (bestAsk === null || !isFinite(bestAsk) || bestAsk < 1 || bestAsk > 99) {
            console.log(`[trade-executor] Market price: no opposing bids for ${side} on ${ticker}`);
            return null;
        }
        console.log(`[trade-executor] Market price: best ${side} ask = ${bestAsk}c on ${ticker}`);
        return bestAsk;
    } catch (e) {
        console.log(`[trade-executor] Market price fetch failed: ${e.message}`);
        return null;
    }
}

// Get the best bid price for selling — what we'd receive if selling our position now.
// When selling YES contracts, the bid comes from YES bids directly.
// When selling NO contracts, the bid comes from NO bids directly.
// Returns price in cents, or null if no liquidity.
async function getMarketSellPrice(ticker, side, minutesRemaining) {
    try {
        const resp = await fetchOrderbook(ticker);
        if (!resp) return null;
        const book = resp.orderbook_fp || resp.orderbook || resp;
        const isDollarFmt = !!(book.yes_dollars || book.no_dollars);
        // For selling, we want bids on OUR side (not opposite)
        const ourBids = side === 'yes'
            ? (book.yes_dollars || book.yes || [])
            : (book.no_dollars || book.no || []);
        if (!ourBids || ourBids.length === 0) return null;
        const bidPrices = ourBids.map(entry => {
            const raw = parseFloat(entry[0]);
            return isDollarFmt ? Math.round(raw * 100) : Math.round(raw);
        });
        const bestBid = Math.max(...bidPrices);
        if (!isFinite(bestBid) || bestBid < 1 || bestBid > 99) return null;
        console.log(`[trade-executor] Market sell price: best ${side} bid = ${bestBid}c on ${ticker}`);
        return bestBid;
    } catch (e) {
        console.log(`[trade-executor] Market sell price fetch failed: ${e.message}`);
        return null;
    }
}

async function getAggressivePrice(ticker, side, theoreticalPrice, minutesRemaining, passiveMode = false) {
    // Guard against NaN/undefined — fall back to 50c (fair value)
    if (theoreticalPrice === undefined || theoreticalPrice === null || isNaN(theoreticalPrice) || !isFinite(theoreticalPrice)) {
        console.warn(`[trade-executor] getAggressivePrice received invalid theoreticalPrice: ${theoreticalPrice} — defaulting to 50c`);
        theoreticalPrice = 50;
    }
    theoreticalPrice = Math.max(5, Math.min(95, Math.round(theoreticalPrice)));

    // Paper and live both use real orderbook for pricing

    // Determine max slippage based on time remaining
    // In passive mode (minutesRemaining > 7), post at theoretical price (no slippage)
    // to act as a maker and earn the spread. If no fill, next cycle retries.
    const maxSlippage = passiveMode ? 0
                      : (minutesRemaining || 15) <= 3 ? 8
                      : (minutesRemaining || 15) <= 7 ? 5
                      : 3; // early period: still willing to cross a typical spread

    const maxPrice = Math.min(95, theoreticalPrice + maxSlippage);

    // Try to get the best price from the orderbook
    try {
        const resp = await fetchOrderbook(ticker);
        if (!resp) throw new Error('No orderbook data');
        const bestAsk = parseOrderbookAsk(resp, side, ticker, minutesRemaining);

        if (bestAsk !== null) {
            // NEVER pay more than theoretical + maxSlippage
            if (bestAsk > maxPrice) {
                // Post at our maxPrice (NOT theoreticalPrice) — this is our best chance to fill
                // while staying within our willingness-to-pay limit
                console.log(`[trade-executor] Orderbook: best ${side} ask = ${bestAsk}c > max ${maxPrice}c (theory=${theoreticalPrice}c) — posting at maxPrice ${maxPrice}c`);
                return Math.max(5, maxPrice);
            }

            const price = Math.min(maxPrice, bestAsk);
            console.log(`[trade-executor] Orderbook: best ${side} ask = ${bestAsk}c — buying at ${price}c (theory=${theoreticalPrice}c, max=${maxPrice}c)`);
            return Math.max(5, price);
        }
        // In paper mode, don't block on "no opposing bids" — the server's orderbook
        // display may be showing data from a different fetch. Use maxPrice as a
        // reasonable fill price for the simulated trade.
        if (config.paperMode) {
            console.log(`[trade-executor] Orderbook: no opposing bids for ${side} — paper mode, using maxPrice ${maxPrice}c as simulated fill`);
            return Math.max(5, maxPrice);
        }
        console.log(`[trade-executor] Orderbook: no opposing bids — skipping order, will retry when liquidity appears`);
        return null; // Signal: no liquidity, don't place order (live mode only)
    } catch (e) {
        console.log(`[trade-executor] Orderbook fetch failed: ${e.message} — posting at maxPrice`);
    }

    // Orderbook fetch failed (network error etc): post at maxPrice as fallback
    console.log(`[trade-executor] Using limit price: ${maxPrice}c (theory=${theoreticalPrice}c)`);
    return Math.max(5, maxPrice);
}

/**
 * Cap contracts to what we can actually afford.
 * Returns 0 if we can't afford even 1 contract.
 */
async function capContractsByBalance(contracts, pricePerContract) {
    // Paper mode: cap by paper balance instead of skipping
    if (config.paperMode) {
        const env = getEnvironment();
        const availableCents = paperBalances[env] || 0;
        const maxAffordable = Math.floor(availableCents / pricePerContract);
        if (maxAffordable <= 0) {
            console.log(`[trade-executor] Paper: can't afford any contracts: balance=${availableCents}c, price=${pricePerContract}c`);
            return 0;
        }
        const capped = Math.min(contracts, maxAffordable);
        if (capped < contracts) {
            console.log(`[trade-executor] Paper: capping contracts ${contracts} → ${capped} (balance=${availableCents}c @ ${pricePerContract}c each)`);
        }
        return capped;
    }
    try {
        const balanceResp = await trading.getBalance();
        const availableCents = balanceResp.balance;
        const maxAffordable = Math.floor(availableCents / pricePerContract);
        if (maxAffordable <= 0) {
            console.log(`[trade-executor] Can't afford any contracts: balance=${availableCents}c, price=${pricePerContract}c`);
            return 0;
        }
        const capped = Math.min(contracts, maxAffordable);
        if (capped < contracts) {
            console.log(`[trade-executor] Capping contracts ${contracts} → ${capped} (balance=${availableCents}c @ ${pricePerContract}c each)`);
        }
        return capped;
    } catch (e) {
        console.log(`[trade-executor] Balance check failed: ${e.message} — using requested ${contracts}`);
        return Math.min(contracts, 10); // safe fallback
    }
}

// ═══════════════════════════════════════════════════════════════
// Entry: called when a new prediction is made
// ═══════════════════════════════════════════════════════════════

async function onNewPrediction(prediction, kalshiTicker, strike, periodKey) {
    validateCurrentPosition(); // Clear stale positions from previous periods
    if (!prediction || !kalshiTicker || strike === null) return;

    const betQuality = prediction._betQuality;
    if (!betQuality || !betQuality.shouldBet || betQuality.betSize <= 0) {
        const reason = !betQuality ? 'No bet quality data' : !betQuality.shouldBet ? betQuality.reason : 'Bet size is 0';
        setThought('skip', reason, {
            edge: betQuality?.edge, quality: betQuality?.quality,
            waitForBetter: betQuality?.waitForBetter, suggestedWait: betQuality?.suggestedWait,
            probability: prediction?.probability, factors: betQuality?.factors,
            kellyHasEdge: betQuality?.kellyHasEdge,
        });
        decisionLog.logSkip({
            periodKey, reason, minutesAhead: null,
            probability: prediction?.probability, edge: betQuality?.edge,
            currentPrice: prediction?.predictedPrice, strike,
            details: betQuality ? { quality: betQuality.quality, betSize: betQuality.betSize, factors: betQuality.factors } : null,
        });
        // ── DB: log skip decision with full context ──
        db.saveDecisionLog({
            periodKey,
            ticker: kalshiTicker,
            decision: 'skip',
            direction: prediction?.predictedPrice >= strike ? 'up' : 'down',
            side: prediction?.predictedPrice >= strike ? 'yes' : 'no',
            btcPrice: prediction?.predictedPrice,
            strike,
            distanceFromStrike: prediction?.predictedPrice ? prediction.predictedPrice - strike : null,
            probability: prediction?.probability,
            edge: betQuality?.edge,
            kellyEntryPrice: betQuality?.kellyEntryPrice,
            kellyRaw: betQuality?.kellyRaw,
            kellyHasEdge: betQuality?.kellyHasEdge,
            kellyError: betQuality?.kellyError,
            qualityScore: betQuality?.quality,
            factors: betQuality?.factors,
            betSize: betQuality?.betSize,
            convictionTier: betQuality?.convictionTier,
            reason,
        }).catch(e => console.error('[db] Decision log error:', e.message));
        return;
    }

    // Don't enter if we already have a position for this period
    if (currentPosition && currentPosition.periodKey === periodKey) {
        setThought('holding', 'Holding position for this period', {
            side: currentPosition.side, contracts: currentPosition.totalContracts || currentPosition.contracts,
            entryPrice: currentPosition.entryPrice,
        });
        return;
    }

    // CRITICAL: Don't re-enter a period we already entered, even if currentPosition was cleared
    // This prevents the bug where syncPositionWithKalshi clears the position and we place
    // duplicate orders, ending up with way more contracts on Kalshi than we're tracking
    if (enteredPeriods[periodKey]) {
        const ep = enteredPeriods[periodKey];
        console.log(`[trade-executor] Already entered period ${periodKey} (${ep.side} at ${new Date(ep.entryTime).toLocaleTimeString()}) — skipping duplicate entry`);
        setThought('holding', `Already entered this period (${ep.side})`, { side: ep.side });
        return;
    }

    // Close stale position from a previous period — settle it instead of silently discarding
    if (currentPosition && currentPosition.periodKey !== periodKey) {
        console.log(`[trade-executor] Stale position from ${currentPosition.periodKey} — auto-settling before new entry`);
        // We don't know the actual result, but the position should have been settled by onPeriodEnd.
        // If it wasn't (race condition), settle as unknown/loss to be conservative.
        const staleContracts = currentPosition.totalContracts || currentPosition.contracts;
        const staleCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const staleEntry = staleContracts > 0 ? Math.round(staleCost / staleContracts) : currentPosition.entryPrice;
        if (staleContracts > 0 && staleCost > 0) {
            const pnl = -staleCost; // assume loss (worst case)
            dailyStats.losses++;
            dailyStats.pnlCents += pnl;
            logTrade('settle', {
                ticker: currentPosition.ticker,
                side: currentPosition.side,
                contracts: staleContracts,
                entryPrice: staleEntry,
                correct: false,
                pnlCents: pnl,
                dailyPnlCents: dailyStats.pnlCents,
                periodKey: currentPosition.periodKey,
                note: 'auto-settled stale position (missed onPeriodEnd)',
            });
        }
        currentPosition = null;
    }

    const check = await canTrade(periodKey);
    if (!check.ok) {
        setThought('blocked', check.reason);
        console.log(`[trade-executor] Skipping entry: ${check.reason}`);
        decisionLog.logSkip({ periodKey, reason: 'canTrade failed: ' + check.reason, currentPrice: prediction?.predictedPrice, strike });
        return;
    }

    const isUp = prediction.predictedPrice >= strike;
    const side = isUp ? 'yes' : 'no';

    // Compute minutes remaining in this period
    const now = new Date();
    const mins = now.getMinutes();
    const periodEnd = (Math.floor(mins / 15) + 1) * 15;
    const minutesRemaining = Math.max(0.5, periodEnd - mins - (now.getSeconds() / 60));

    // ── EARLY PERIOD WAIT ──
    // In the first 3 minutes of a cycle, the model has very little data.
    // Unless conviction is STRONG or LOCK, wait for the picture to develop.
    const isLockTier = betQuality.convictionTier === 'LOCK';
    const isStrongOrLock = isLockTier || betQuality.convictionTier === 'STRONG';
    if (minutesRemaining > 12 && !isStrongOrLock) {
        const minsIn = 15 - minutesRemaining;
        const msg = `Too early in cycle (${minsIn.toFixed(1)}m in) — waiting for price direction to establish`;
        console.log(`[trade-executor] ${msg}`);
        setThought('waiting', msg);
        decisionLog.logSkip({ periodKey, reason: msg, currentPrice: prediction?.predictedPrice, strike });
        return;
    }

    // ── ENTRY PRICE PROTECTION ──
    // Hard cap: never pay more than 85¢ for standard entries.
    // Above 85¢, risk/reward is terrible — risking 85¢+ to make at most 15¢.
    // Exception: LOCK conviction tier (last ~5 min, near-guaranteed) can go up to 95¢.
    const MAX_ENTRY_PRICE = isLockTier ? 95 : 85;

    // Early period protection: in the first 5 minutes of a period, require cheaper
    // entries to compensate for the higher uncertainty.
    // LOCK bets bypass early period limits (they only trigger with <5 min left anyway).
    const earlyPeriodMaxPrice = isLockTier ? MAX_ENTRY_PRICE
                              : minutesRemaining > 13 ? 65  // first ~2 min: max 65¢ (if STRONG)
                              : minutesRemaining > 11 ? 72  // 2-4 min: max 72¢
                              : minutesRemaining > 10 ? 82  // 4-5 min: max 82¢ (was 78¢ — too tight)
                              : MAX_ENTRY_PRICE;             // after 5 min: standard 85¢ cap

    const convictionLabel = betQuality.convictionTier ? ` [${betQuality.convictionTier}]` : '';
    setThought('buying', `Placing ${isUp ? 'UP' : 'DOWN'} bet${convictionLabel}`, {
        edge: betQuality.edge, quality: betQuality.quality, betSize: betQuality.betSize,
        conviction: betQuality.convictionTier || 'normal',
    });

    // Determine limit price — must be aggressive enough to fill
    // Use probability as our max willingness-to-pay, but try the orderbook first
    if (prediction.probability === undefined || prediction.probability === null || isNaN(prediction.probability)) {
        console.error(`[trade-executor] prediction.probability is invalid (${prediction.probability}) — skipping trade`);
        setThought('error', `Skipped bet: invalid probability (${prediction.probability})`);
        return;
    }
    const probForBet = isUp ? prediction.probability : (1 - prediction.probability);
    const rawTheoreticalPrice = Math.round(probForBet * 100);
    // Apply entry price cap — never pay more than the time-adjusted maximum
    const effectiveMaxEntry = Math.min(MAX_ENTRY_PRICE, earlyPeriodMaxPrice);
    const theoreticalPrice = Math.min(rawTheoreticalPrice, effectiveMaxEntry);
    if (rawTheoreticalPrice > effectiveMaxEntry) {
        console.log(`[trade-executor] Entry price capped: theoretical=${rawTheoreticalPrice}c → ${theoreticalPrice}c (max=${effectiveMaxEntry}c, ${minutesRemaining.toFixed(1)}m left)`);
    }

    // Skip entry entirely if raw price suggests terrible risk/reward
    // If the model says 95%+ but we cap at 70-85¢, we'd be posting below market
    // and unlikely to fill anyway. Only skip if the market is genuinely expensive.
    if (rawTheoreticalPrice > effectiveMaxEntry + 10) {
        // Before skipping, check the actual market ask — if the market ask is within
        // our max, we can still place a limit order that might fill. The model's high
        // theoretical price just means we have strong conviction, not that the market
        // ask is necessarily expensive.
        const actualAsk = await getMarketPrice(kalshiTicker, side, minutesRemaining);
        if (actualAsk !== null && actualAsk <= effectiveMaxEntry) {
            console.log(`[trade-executor] Model price high (${rawTheoreticalPrice}c) but market ask ${actualAsk}c is within max ${effectiveMaxEntry}c — proceeding with entry`);
        } else {
            const askInfo = actualAsk !== null ? `, market ask=${actualAsk}c` : '';
            const msg = `Entry price too high (${rawTheoreticalPrice}c, max=${effectiveMaxEntry}c with ${minutesRemaining.toFixed(1)}m left${askInfo}) — risk/reward unfavorable`;
            console.log(`[trade-executor] ${msg}`);
            setThought('skip', msg);
            return;
        }
    }

    // Fetch orderbook once, use for both market ask (display) and limit price (execution)
    // Use passive mode (post at theoretical, no slippage) when >7 min remaining
    // to earn the spread as a maker. The waitForFill timeout handles non-fills.
    const passiveEntry = minutesRemaining > 7 && !isLockTier;
    let limitPrice = await getAggressivePrice(kalshiTicker, side, theoreticalPrice, minutesRemaining, passiveEntry);
    // Paper mode safety net: if getAggressivePrice still returned null, use theoretical price
    // Paper trades don't hit the exchange, so "no liquidity" should never block them
    if (limitPrice === null && config.paperMode) {
        limitPrice = Math.max(5, Math.min(effectiveMaxEntry, theoreticalPrice));
        console.log(`[trade-executor] Paper mode: orderbook unavailable, using theoretical price ${limitPrice}c`);
    }

    // Enforce hard cap on the final limit price regardless of orderbook
    if (limitPrice !== null && limitPrice > effectiveMaxEntry) {
        console.log(`[trade-executor] Limit price capped: ${limitPrice}c → ${effectiveMaxEntry}c (max entry protection)`);
        limitPrice = effectiveMaxEntry;
    }
    // If limitPrice is null, check if it's truly no liquidity vs market price too high
    let marketAsk = null;
    if (limitPrice === null) {
        marketAsk = await getMarketPrice(kalshiTicker, side, 15);
    }
    if (limitPrice === null) {
        // Distinguish between "no orders" and "market price too high for our edge"
        const noLiquidityMsg = marketAsk === null
            ? 'No liquidity on orderbook — waiting for orders to appear'
            : `Market ask ${marketAsk}c too high for model (${theoreticalPrice}c) — no edge at current price`;
        console.log(`[trade-executor] ${noLiquidityMsg}`);
        setThought('waiting', noLiquidityMsg);
        db.saveDecisionLog({
            periodKey, ticker: kalshiTicker, decision: marketAsk === null ? 'no_liquidity' : 'no_edge',
            direction: isUp ? 'up' : 'down', side,
            btcPrice: prediction.predictedPrice, strike,
            distanceFromStrike: prediction.predictedPrice - strike,
            probability: prediction.probability, edge: betQuality.edge,
            qualityScore: betQuality.quality, betSize: betQuality.betSize,
            marketAsk: marketAsk, theoreticalPrice,
            reason: noLiquidityMsg,
        }).catch(e => console.error('[db] Decision log error:', e.message));
        return;
    }

    // ── Spread awareness: don't enter if spread exceeds edge ──
    {
        const spreadAsk = await getMarketPrice(kalshiTicker, side, minutesRemaining);
        const spreadBid = await getMarketSellPrice(kalshiTicker, side, minutesRemaining);
        if (spreadAsk && spreadBid) {
            const spreadCents = spreadAsk - spreadBid;
            const edgeCents = Math.round(betQuality.edge * 100);
            if (spreadCents > edgeCents * 2 && !isLockTier) {
                console.log(`[trade-executor] Spread ${spreadCents}c > 2x edge ${edgeCents}c — skipping entry`);
                setThought('skip', `Spread ${spreadCents}c too wide for ${edgeCents}c edge`);
                return;
            }
        }
    }

    // ── Dynamic contract sizing: baseContracts% of balance ÷ entry price ──
    const baseCount = getBaseContractCount(limitPrice);
    const isHighConviction = betQuality.betSize > 1.0;
    const dynamicMaxEntry = getMaxContractsForRisk(limitPrice, 0.15); // max 15% of bankroll
    const positionCap = isHighConviction
        ? Math.min(dynamicMaxEntry, config.convictionMaxContracts)
        : Math.min(dynamicMaxEntry, config.maxPositionContracts);
    const contracts = Math.max(1, Math.min(
        positionCap,
        Math.round(betQuality.betSize * baseCount)
    ));

    // ── Per-period exposure cap: don't exceed 15% of bankroll per period ──
    const proposedCost = contracts * limitPrice;
    if (!checkPeriodExposure(periodKey, proposedCost)) {
        setThought('skip', 'Period exposure cap reached (15% of bankroll)');
        return;
    }

    // ── DB: log bet decision ──
    db.saveDecisionLog({
        periodKey, ticker: kalshiTicker, decision: 'bet',
        direction: isUp ? 'up' : 'down', side,
        btcPrice: prediction.predictedPrice, strike,
        distanceFromStrike: prediction.predictedPrice - strike,
        probability: prediction.probability, edge: betQuality.edge,
        kellyEntryPrice: betQuality.kellyEntryPrice,
        kellyRaw: betQuality.kellyRaw,
        kellyHasEdge: betQuality.kellyHasEdge,
        qualityScore: betQuality.quality,
        factors: betQuality.factors,
        betSize: betQuality.betSize,
        convictionTier: betQuality.convictionTier,
        contracts,
        limitPrice,
        reason: 'Good entry',
    }).catch(e => console.error('[db] Decision log error:', e.message));

    const tradeInfo = {
        ticker: kalshiTicker,
        side,
        action: 'buy',
        contracts,
        limitPrice,
        periodKey,
        direction: isUp ? 'UP' : 'DOWN',
        edge: (betQuality.edge * 100).toFixed(1) + '%',
        quality: (betQuality.quality * 100).toFixed(0) + '%',
        betSize: betQuality.betSize.toFixed(2),
    };

    if (config.paperMode) {
        const cappedContracts = await capContractsByBalance(contracts, limitPrice);
        if (cappedContracts <= 0) return;
        const costCents = cappedContracts * limitPrice;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) - costCents;
        console.log(`[trade-executor] PAPER BUY: ${cappedContracts}x ${side.toUpperCase()} on ${kalshiTicker} @ ${limitPrice}c | Cost=$${(costCents/100).toFixed(2)} | Paper balance=$${(paperBalances[env]/100).toFixed(2)}`);
        setThought('bought', `Bought ${cappedContracts}x ${side.toUpperCase()} @ ${limitPrice}c (paper)`, { edge: betQuality.edge, quality: betQuality.quality });
        currentPosition = {
            ticker: kalshiTicker,
            side,
            contracts: cappedContracts,
            entryPrice: limitPrice,
            orderId: 'paper-' + Date.now(),
            periodKey,
            entryTime: Date.now(),
            totalCostCents: costCents,
            totalContracts: cappedContracts,
        };
        enteredPeriods[periodKey] = { side, ticker: kalshiTicker, entryTime: Date.now() };
        tradeInfo.contracts = cappedContracts;
        logTrade('buy', tradeInfo);
        decisionLog.logTradeExecution({ ...tradeInfo, strategy: 'initial', currentPrice: prediction.predictedPrice, strike, probability: (probForBet * 100).toFixed(1) + '%' });
        dailyStats.tradeCount++;
        trackPeriodCost(periodKey, costCents);
        return;
    }

    // ── LIVE ORDER ──
    const cappedContracts = await capContractsByBalance(contracts, limitPrice);
    if (cappedContracts <= 0) return;

    // Snapshot balance before order for verification
    let balanceBefore = 0;
    try { balanceBefore = (await trading.getBalance()).balance; } catch (e) { /* continue */ }

    orderInFlight = true;
    try {
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side,
            action: 'buy',
            count: cappedContracts,
            yesPrice: side === 'yes' ? limitPrice : undefined,
            noPrice: side === 'no' ? limitPrice : undefined,
        });

        let order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            console.log(`[trade-executor] Order not filled: ${order.status} — ${order.cancel_reason || 'unknown'}`);
            logTrade('buy_failed', { ...tradeInfo, reason: order.status });
            return;
        }

        // ── FILL VERIFICATION ──
        // GTC orders may come back as 'resting' (on the book, not yet matched).
        // Wait up to 5s for fill, then cancel any unfilled remainder.
        if (order.status === 'resting' || order.status === 'open') {
            console.log(`[trade-executor] Order ${order.order_id} is ${order.status} — waiting for fill...`);
            order = await waitForFill(order.order_id, order);
        }

        const fills = parseOrderFills(order);
        let filledContracts = fills.filled;

        if (filledContracts === 0) {
            console.log(`[trade-executor] Order ${order.order_id} got 0 fills — no position taken`);
            logTrade('buy_unfilled', { ...tradeInfo, orderId: order.order_id, finalStatus: order.status });
            markFillFailed(periodKey);
            return;
        }

        // ── GROUND-TRUTH VERIFICATION ──
        // Don't trust order response alone. Check balance + portfolio to confirm.
        filledContracts = await verifyFillIsReal(order.order_id, kalshiTicker, side, filledContracts, balanceBefore);
        if (filledContracts === 0) {
            logTrade('buy_phantom', { ...tradeInfo, orderId: order.order_id, claimedFills: fills.filled, orderStatus: order.status });
            markFillFailed(periodKey);
            return;
        }

        if (filledContracts < cappedContracts) {
            console.log(`[trade-executor] Partial fill: ${filledContracts}/${cappedContracts} contracts on ${order.order_id}`);
        }

        currentPosition = {
            ticker: kalshiTicker,
            side,
            contracts: filledContracts,
            entryPrice: limitPrice,
            orderId: order.order_id,
            periodKey,
            entryTime: Date.now(),
            totalCostCents: filledContracts * limitPrice,
            totalContracts: filledContracts,
        };
        // Mark this period as entered to prevent duplicate entries
        enteredPeriods[periodKey] = { side, ticker: kalshiTicker, entryTime: Date.now() };
        syncZeroCount = 0; // reset sync counter on new entry
        logTrade('buy', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status, filledContracts, requestedContracts: cappedContracts });
        dailyStats.tradeCount++;
        trackPeriodCost(periodKey, filledContracts * limitPrice);
        console.log(`[trade-executor] LIVE BUY: ${filledContracts}x ${side.toUpperCase()} on ${kalshiTicker} — order ${order.order_id} (${order.status})`);

    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response) : '';
        console.error(`[trade-executor] Order failed:`, err.message, detail ? `| Response: ${detail}` : '');
        logTrade('buy_error', { ...tradeInfo, error: err.message, response: err.response });

        // On 409 (conflict/insufficient funds), don't retry this period
        if (err.status === 409) {
            currentPosition = { ticker: kalshiTicker, side, contracts: 0, entryPrice: 0, orderId: 'blocked-409', periodKey, entryTime: Date.now() };
        }
    } finally {
        orderInFlight = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// Exit: called every 10s when sell signal updates
// ═══════════════════════════════════════════════════════════════

async function onSellSignal(sellSignal, minutesRemaining, updatedPrediction, strike, currentPrice) {
    validateCurrentPosition(); // Clear stale positions from previous periods
    if (!currentPosition || !sellSignal) return;

    // ── BINARY OPTIONS: ALMOST NEVER SELL (except confident flips) ──
    // Binary options settle at exactly 100¢ or 0¢. Selling early means:
    // - If winning: you get less than the 100¢ settlement payout
    // - If losing: you pay the spread twice (sell + potential re-entry) for minimal salvage
    // The mathematically justified sells:
    // 1. Recovery essentially impossible (lost_cause)
    // 2. Model highly confident the other way + price confirms (confident_flip)
    const isConfidentFlip = sellSignal.level === 'confident_flip';

    if (strike && currentPrice) {
        const betIsUp = currentPosition.side === 'yes';
        const onRightSide = (betIsUp && currentPrice >= strike) || (!betIsUp && currentPrice < strike);

        // NEVER sell a winning position. Settlement pays 100¢. Any sell price < 100¢ loses money.
        if (onRightSide) {
            setThought('winning', 'On right side of strike — holding to settlement', {
                side: currentPosition.side, distFromStrike: ((currentPrice - strike) / strike * 100).toFixed(3) + '%',
                minutesRemaining,
            });
            return;
        }

        // On wrong side: sell if mathematically dead OR model is highly confident the other way
        const remainingVol = (updatedPrediction && updatedPrediction._remainingVol) || 0.002;
        const distancePct = Math.abs(currentPrice - strike) / strike;
        const sigmaDistance = distancePct / remainingVol;

        const isMathematicallyDead = (sigmaDistance >= 2.5 && minutesRemaining < 1.5) || sigmaDistance >= 3.0;
        if (!isMathematicallyDead && !isConfidentFlip) {
            // Hold — recovery is still plausible or spread eats any salvage value
            setThought('losing', `Wrong side (${sigmaDistance.toFixed(1)}σ) — holding, recovery possible`, {
                sigmaDistance: sigmaDistance.toFixed(1), minutesRemaining, recoveryProb: sigmaDistance < 2 ? '~5%' : '~1%',
            });
            return;
        }
        if (isConfidentFlip) {
            const conf = updatedPrediction?.confidence ? (updatedPrediction.confidence * 100).toFixed(0) : '?';
            setThought('flipping', `Flipping position — ${conf}% confidence other way, ${sigmaDistance.toFixed(1)}σ on wrong side`);
        } else {
            setThought('selling', `Mathematically dead (${sigmaDistance.toFixed(1)}σ, ${minutesRemaining.toFixed(1)}m left) — selling`);
        }
    }

    // Sell on lost_cause (mathematically dead) or confident_flip (high-confidence reversal)
    const shouldSell = (sellSignal.level === 'lost_cause' || sellSignal.level === 'confident_flip');

    if (!shouldSell) {
        decisionLog.logSellDecision({ sellSignal, minutesRemaining, acted: false, reason: 'Thresholds not met for sell', currentPrice, strike });
        return;
    }

    const tradeInfo = {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts: currentPosition.contracts,
        action: 'sell',
        periodKey: currentPosition.periodKey,
        reason: sellSignal.level,
        urgency: sellSignal.urgency,
        minutesRemaining: minutesRemaining.toFixed(1),
    };

    if (config.paperMode) {
        const sellContracts = currentPosition.totalContracts || currentPosition.contracts;
        // Use actual market bid for sell price: our side's best bid from orderbook
        // Fallback to entry - 10 if orderbook unavailable
        const marketSellPrice = await getMarketSellPrice(currentPosition.ticker, currentPosition.side, minutesRemaining);
        const sellPrice = marketSellPrice || Math.max(1, currentPosition.entryPrice - 10);
        const sellProceeds = sellContracts * sellPrice;
        // Calculate loss from selling (what we paid minus what we got back)
        const originalCostCents = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const sellLossCents = Math.max(0, originalCostCents - sellProceeds);
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) + sellProceeds;
        console.log(`[trade-executor] PAPER SELL: ${sellContracts}x ${currentPosition.side.toUpperCase()} on ${currentPosition.ticker} @ ${sellPrice}c — reason: ${sellSignal.level} | Proceeds=$${(sellProceeds/100).toFixed(2)} | Loss=$${(sellLossCents/100).toFixed(2)} | Paper balance=$${(paperBalances[env]/100).toFixed(2)}`);
        logTrade('sell', tradeInfo);
        decisionLog.logSellDecision({ sellSignal, minutesRemaining, acted: true, reason: sellSignal.level, currentPrice, strike });
        dailyStats.tradeCount++;
        // Record for potential re-entry
        const soldTicker = currentPosition.ticker;
        const soldPeriodKey = currentPosition.periodKey;
        const soldSide = currentPosition.side;
        soldThisPeriod = {
            periodKey: soldPeriodKey,
            side: soldSide,
            ticker: soldTicker,
            soldAt: Date.now(),
            reason: sellSignal.level,
            lossCents: sellLossCents,
        };
        currentPosition = null;

        // ── FLIP: immediately enter the opposite side (max 1 flip per cycle) ──
        // Size the flip to recover the loss from selling + a profit margin
        if (isConfidentFlip && !flippedThisPeriod && updatedPrediction && soldTicker && soldPeriodKey) {
            const flipSide = soldSide === 'yes' ? 'no' : 'yes';
            console.log(`[trade-executor] CONFIDENT FLIP: sold ${soldSide.toUpperCase()}, now entering ${flipSide.toUpperCase()} (need to recover $${(sellLossCents/100).toFixed(2)} loss)`);
            const flipPrice = await getMarketPrice(soldTicker, flipSide, minutesRemaining);
            if (flipPrice !== null) {
                // Use the LARGER of: base sizing or loss-recovery sizing
                const baseSizing = Math.max(1, getBaseContractCount(flipPrice));
                const recoverySizing = getFlipRecoveryContracts(sellLossCents, flipPrice, sellContracts);
                const targetContracts = Math.max(baseSizing, recoverySizing);
                const flipContracts = await capContractsByBalance(targetContracts, flipPrice);
                if (flipContracts > 0) {
                    const flipCost = flipContracts * flipPrice;
                    const expectedProfit = flipContracts * (100 - flipPrice);
                    const netAfterRecovery = expectedProfit - sellLossCents;
                    const env = getEnvironment();
                    paperBalances[env] = (paperBalances[env] || 0) - flipCost;
                    currentPosition = {
                        ticker: soldTicker, side: flipSide, contracts: flipContracts,
                        entryPrice: flipPrice, orderId: 'flip-paper-' + Date.now(),
                        periodKey: soldPeriodKey, entryTime: Date.now(),
                        totalCostCents: flipCost, totalContracts: flipContracts,
                        flipped: true, originalSide: soldSide,
                        flipLossCents: sellLossCents,
                    };
                    enteredPeriods[soldPeriodKey] = { side: flipSide, ticker: soldTicker, entryTime: Date.now() };
                    flippedThisPeriod = true;
                    logTrade('buy', {
                        ticker: soldTicker, side: flipSide, action: 'buy',
                        contracts: flipContracts, limitPrice: flipPrice,
                        periodKey: soldPeriodKey, direction: flipSide === 'yes' ? 'UP' : 'DOWN',
                        strategy: 'confident_flip', fillStatus: 'paper-flip',
                        flipped: true, originalSide: soldSide,
                        flipLossCents: sellLossCents, expectedProfit, netAfterRecovery,
                    });
                    dailyStats.tradeCount++;
                    setThought('bought', `Flipped to ${flipSide.toUpperCase()} — ${flipContracts}x @ ${flipPrice}c (recovering $${(sellLossCents/100).toFixed(2)} loss, expected net +$${(netAfterRecovery/100).toFixed(2)})`, {
                        contracts: flipContracts, side: flipSide, strategy: 'confident_flip',
                        flipLossCents: sellLossCents, expectedProfit, netAfterRecovery,
                    });
                    console.log(`[trade-executor] PAPER FLIP: ${flipContracts}x ${flipSide.toUpperCase()} @ ${flipPrice}c | Loss to recover=$${(sellLossCents/100).toFixed(2)} | Expected profit=$${(expectedProfit/100).toFixed(2)} | Net=$${(netAfterRecovery/100).toFixed(2)}`);
                }
            }
        } else if (isConfidentFlip && flippedThisPeriod) {
            console.log(`[trade-executor] FLIP BLOCKED: already flipped once this cycle — not flipping again`);
            setThought('skip', 'Flip blocked — already flipped once this cycle');
        }
        return;
    }

    // ── LIVE SELL ──
    if (orderInFlight) {
        console.log(`[trade-executor] Sell skipped — order already in flight`);
        return;
    }
    orderInFlight = true;
    try {
        const result = await trading.placeOrder({
            ticker: currentPosition.ticker,
            side: currentPosition.side,
            action: 'sell',
            count: currentPosition.contracts,
            // Sell at a price that's likely to fill — accept some slippage
            yesPrice: currentPosition.side === 'yes' ? Math.max(1, currentPosition.entryPrice - 10) : undefined,
            noPrice: currentPosition.side === 'no' ? Math.max(1, currentPosition.entryPrice - 10) : undefined,
        });

        let order = result.order || {};
        console.log(`[trade-executor] LIVE SELL: order ${order.order_id} status=${order.status}`);

        // ── FILL VERIFICATION ──
        if (order.status === 'resting' || order.status === 'open') {
            console.log(`[trade-executor] Sell order ${order.order_id} is ${order.status} — waiting for fill...`);
            order = await waitForFill(order.order_id, order);
        }

        const fills = parseOrderFills(order);
        const filledContracts = fills.filled;

        if (filledContracts === 0) {
            console.log(`[trade-executor] Sell order ${order.order_id} got 0 fills — position NOT closed`);
            logTrade('sell_unfilled', { ...tradeInfo, orderId: order.order_id, finalStatus: order.status });
            // Don't clear position — still holding
            return;
        }

        if (filledContracts < currentPosition.contracts) {
            console.log(`[trade-executor] Partial sell: ${filledContracts}/${currentPosition.contracts} — reducing position`);
            currentPosition.contracts -= filledContracts;
            logTrade('sell_partial', { ...tradeInfo, orderId: order.order_id, filledContracts, remaining: currentPosition.contracts });
            dailyStats.tradeCount++;
            return;
        }

        // Fully sold — calculate loss for flip recovery sizing
        const liveSellProceeds = filledContracts * (fills.avgPrice || currentPosition.entryPrice);
        const liveOriginalCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const liveSellLossCents = Math.max(0, liveOriginalCost - liveSellProceeds);
        logTrade('sell', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status, filledContracts, lossCents: liveSellLossCents });
        dailyStats.tradeCount++;
        const soldTicker = currentPosition.ticker;
        const soldPeriodKey = currentPosition.periodKey;
        const soldSide = currentPosition.side;
        soldThisPeriod = {
            periodKey: soldPeriodKey,
            side: soldSide,
            ticker: soldTicker,
            soldAt: Date.now(),
            reason: sellSignal.level,
            lossCents: liveSellLossCents,
        };
        currentPosition = null;

        // ── FLIP: immediately enter the opposite side (live, max 1 flip per cycle) ──
        // Size to recover the loss from selling + a profit margin
        if (isConfidentFlip && !flippedThisPeriod && updatedPrediction && soldTicker && soldPeriodKey) {
            const flipSide = soldSide === 'yes' ? 'no' : 'yes';
            console.log(`[trade-executor] CONFIDENT FLIP (live): sold ${soldSide.toUpperCase()}, now entering ${flipSide.toUpperCase()} (need to recover $${(liveSellLossCents/100).toFixed(2)} loss)`);
            const flipPrice = await getMarketPrice(soldTicker, flipSide, minutesRemaining);
            if (flipPrice !== null) {
                // Use the LARGER of: base sizing or loss-recovery sizing
                const baseSizing = Math.max(1, getBaseContractCount(flipPrice));
                const recoverySizing = getFlipRecoveryContracts(liveSellLossCents, flipPrice, filledContracts);
                const targetContracts = Math.max(baseSizing, recoverySizing);
                const flipContracts = await capContractsByBalance(targetContracts, flipPrice);
                if (flipContracts > 0) {
                    try {
                        const flipResult = await trading.placeOrder({
                            ticker: soldTicker, side: flipSide, action: 'buy', count: flipContracts,
                            yesPrice: flipSide === 'yes' ? flipPrice : undefined,
                            noPrice: flipSide === 'no' ? flipPrice : undefined,
                        });
                        let flipOrder = flipResult.order || {};
                        if (flipOrder.status === 'resting' || flipOrder.status === 'open') {
                            flipOrder = await waitForFill(flipOrder.order_id, flipOrder, 8000);
                        }
                        const flipFills = parseOrderFills(flipOrder);
                        if (flipFills.filled > 0) {
                            const avgPrice = flipFills.avgPrice || flipPrice;
                            const flipCost = flipFills.filled * avgPrice;
                            const expectedProfit = flipFills.filled * (100 - avgPrice);
                            const netAfterRecovery = expectedProfit - liveSellLossCents;
                            currentPosition = {
                                ticker: soldTicker, side: flipSide, contracts: flipFills.filled,
                                entryPrice: avgPrice, orderId: flipOrder.order_id,
                                periodKey: soldPeriodKey, entryTime: Date.now(),
                                totalCostCents: flipCost, totalContracts: flipFills.filled,
                                flipped: true, originalSide: soldSide,
                                flipLossCents: liveSellLossCents,
                            };
                            enteredPeriods[soldPeriodKey] = { side: flipSide, ticker: soldTicker, entryTime: Date.now() };
                            flippedThisPeriod = true;
                            logTrade('buy', {
                                ticker: soldTicker, side: flipSide, action: 'buy',
                                contracts: flipFills.filled, limitPrice: avgPrice,
                                periodKey: soldPeriodKey, direction: flipSide === 'yes' ? 'UP' : 'DOWN',
                                strategy: 'confident_flip', orderId: flipOrder.order_id,
                                flipped: true, originalSide: soldSide,
                                flipLossCents: liveSellLossCents, expectedProfit, netAfterRecovery,
                            });
                            dailyStats.tradeCount++;
                            setThought('bought', `Flipped to ${flipSide.toUpperCase()} — ${flipFills.filled}x @ ${avgPrice}c (recovering $${(liveSellLossCents/100).toFixed(2)} loss, expected net +$${(netAfterRecovery/100).toFixed(2)})`, {
                                contracts: flipFills.filled, side: flipSide, strategy: 'confident_flip',
                                flipLossCents: liveSellLossCents, expectedProfit, netAfterRecovery,
                            });
                            console.log(`[trade-executor] LIVE FLIP: ${flipFills.filled}x ${flipSide.toUpperCase()} @ ${avgPrice}c | Loss to recover=$${(liveSellLossCents/100).toFixed(2)} | Expected profit=$${(expectedProfit/100).toFixed(2)} | Net=$${(netAfterRecovery/100).toFixed(2)} — order ${flipOrder.order_id}`);
                        }
                    } catch (flipErr) {
                        console.error(`[trade-executor] Flip buy failed:`, flipErr.message);
                        logTrade('flip_error', { ticker: soldTicker, side: flipSide, error: flipErr.message });
                    }
                }
            }
        } else if (isConfidentFlip && flippedThisPeriod) {
            console.log(`[trade-executor] FLIP BLOCKED (live): already flipped once this cycle — not flipping again`);
            setThought('skip', 'Flip blocked — already flipped once this cycle');
        }

    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response) : '';
        console.error(`[trade-executor] Sell failed:`, err.message, detail ? `| Response: ${detail}` : '');
        logTrade('sell_error', { ...tradeInfo, error: err.message, response: err.response });
        // Don't clear position — will retry next cycle or auto-settle
    } finally {
        orderInFlight = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// Period end: called when prediction is graded
// ═══════════════════════════════════════════════════════════════

function onPeriodEnd(gradeResult) {
    // If currentPosition was cleared (e.g., by sync bug) but we know we entered this period,
    // still log a settlement so the frontend can show WIN/LOSS instead of PENDING
    if (!currentPosition && gradeResult && gradeResult.periodKey && enteredPeriods[gradeResult.periodKey]) {
        const ep = enteredPeriods[gradeResult.periodKey];
        console.log(`[trade-executor] onPeriodEnd: no currentPosition but enteredPeriods has ${gradeResult.periodKey} — logging settlement from entry record`);
        const positionWon = (ep.side === 'yes' && gradeResult.actualDirection === 'up') ||
                            (ep.side === 'no' && gradeResult.actualDirection === 'down');
        if (positionWon) {
            dailyStats.wins++;
        } else {
            dailyStats.losses++;
        }
        logTrade('settle', {
            ticker: ep.ticker,
            side: ep.side,
            contracts: 0, // unknown — position was cleared
            entryPrice: 0,
            correct: positionWon,
            predictionCorrect: gradeResult.correct,
            pnlCents: 0, // unknown — position was cleared
            dailyPnlCents: dailyStats.pnlCents,
            periodKey: gradeResult.periodKey,
            note: 'settled from enteredPeriods (position was cleared before settlement)',
            actualDirection: gradeResult.actualDirection,
            strikePrice: gradeResult.strikePrice,
            settlementPrice: gradeResult.settlementPrice,
        });
        soldThisPeriod = null;
        flippedThisPeriod = false;
        syncZeroCount = 0;
        return;
    }
    if (!currentPosition) {
        console.log('[trade-executor] onPeriodEnd called but no currentPosition to settle');
        return;
    }
    console.log(`[trade-executor] onPeriodEnd: settling position ${currentPosition.periodKey}, gradeResult:`, JSON.stringify(gradeResult));

    // Position auto-settles on Kalshi. Track the P&L.
    // IMPORTANT: Win/loss is determined by POSITION SIDE vs ACTUAL DIRECTION,
    // NOT by whether the prediction was correct. The position side may diverge
    // from the latest prediction (e.g. bet placed on earlier prediction, then
    // prediction direction changed mid-period).
    const predictionCorrect = gradeResult && gradeResult.correct;
    let positionWon;
    if (gradeResult && gradeResult.actualDirection) {
        // YES wins when price goes UP, NO wins when price goes DOWN
        positionWon = (currentPosition.side === 'yes' && gradeResult.actualDirection === 'up') ||
                      (currentPosition.side === 'no' && gradeResult.actualDirection === 'down');
    } else {
        // Fallback if actualDirection not available
        positionWon = predictionCorrect;
    }
    if (positionWon !== predictionCorrect) {
        console.warn(`[trade-executor] Position side (${currentPosition.side}) diverged from prediction! ` +
            `Prediction ${predictionCorrect ? 'correct' : 'wrong'} but position ${positionWon ? 'WON' : 'LOST'} ` +
            `(actual direction: ${gradeResult?.actualDirection})`);
    }

    // Use totalContracts/totalCostCents to include dip buys, late locks, re-entries
    const contracts = currentPosition.totalContracts || currentPosition.contracts;
    const totalCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
    const avgEntryPrice = contracts > 0 ? Math.round(totalCost / contracts) : currentPosition.entryPrice;

    // P&L: if position won, payout is 100c per contract - total cost. If lost, lose total cost.
    // IMPORTANT: If this position was a flip, subtract the loss from selling the original
    // position. e.g., if we sold 6x NO @ 0¢ (loss: 432¢) then flipped to 50x YES @ 91¢
    // and won (+450¢), the true P&L is 450 - 432 = +18¢, not +450¢.
    const flipLoss = currentPosition.flipLossCents || 0;
    let pnl;
    if (positionWon) {
        pnl = (contracts * 100) - totalCost - flipLoss; // payout minus cost minus sell loss from flip
        dailyStats.wins++;
    } else {
        pnl = -totalCost - flipLoss; // lose everything paid plus the flip sell loss
        dailyStats.losses++;
    }
    if (flipLoss > 0) {
        console.log(`[trade-executor] P&L includes flip sell loss: -${(flipLoss/100).toFixed(2)} (settlement ${positionWon ? 'profit' : 'loss'}: ${((positionWon ? (contracts * 100) - totalCost : -totalCost) / 100).toFixed(2)}, net: ${(pnl/100).toFixed(2)})`);
    }
    dailyStats.pnlCents += pnl;

    // Credit paper balance on settlement (cost was already deducted on buy)
    if (config.paperMode) {
        const env = getEnvironment();
        if (positionWon) {
            // Won: get $1 per contract (100c)
            paperBalances[env] = (paperBalances[env] || 0) + (contracts * 100);
        }
        // Lost: nothing to credit — cost was already deducted on buy
        console.log(`[trade-executor] Paper balance after settle: $${(paperBalances[env]/100).toFixed(2)} (${env})`);
    }

    // Detect bad flips: position was flipped but the original side would have won
    let badFlip = false;
    if (currentPosition.flipped && currentPosition.originalSide && gradeResult && gradeResult.actualDirection) {
        const originalWouldHaveWon = (currentPosition.originalSide === 'yes' && gradeResult.actualDirection === 'up') ||
                                      (currentPosition.originalSide === 'no' && gradeResult.actualDirection === 'down');
        badFlip = originalWouldHaveWon;
        if (badFlip) {
            console.warn(`[trade-executor] BAD FLIP: original ${currentPosition.originalSide.toUpperCase()} would have WON but we flipped to ${currentPosition.side.toUpperCase()} and ${positionWon ? 'won' : 'LOST'}`);
        }
    }

    logTrade('settle', {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts,
        entryPrice: avgEntryPrice,
        correct: positionWon,
        predictionCorrect,
        pnlCents: pnl,
        flipLossCents: flipLoss > 0 ? flipLoss : undefined,
        dailyPnlCents: dailyStats.pnlCents,
        periodKey: currentPosition.periodKey,
        flipped: currentPosition.flipped || false,
        originalSide: currentPosition.originalSide || null,
        badFlip,
    });

    setThought('settled', `${positionWon ? 'WON' : 'LOST'}: ${pnl > 0 ? '+' : ''}$${(pnl / 100).toFixed(2)}${badFlip ? ' (BAD FLIP)' : ''}`, { pnlCents: pnl, positionWon, badFlip });
    console.log(`[trade-executor] Period settled: ${positionWon ? 'WIN' : 'LOSS'} | P&L: ${pnl > 0 ? '+' : ''}${(pnl / 100).toFixed(2)} | Daily: ${dailyStats.pnlCents > 0 ? '+' : ''}$${(dailyStats.pnlCents / 100).toFixed(2)}`);

    decisionLog.logSettlement({
        periodKey: currentPosition.periodKey,
        wasCorrect: positionWon,
        predictionCorrect,
        pnlCents: pnl,
        dailyPnlCents: dailyStats.pnlCents,
        contracts,
        entryPrice: avgEntryPrice,
        totalCostCents: totalCost,
        side: currentPosition.side,
        strikePrice: gradeResult?.strikePrice,
        settlementPrice: gradeResult?.settlementPrice,
        predDirection: gradeResult?.predictedDirection,
        predProbability: gradeResult?.probability,
        actualDirection: gradeResult?.actualDirection,
    });

    // ── DB: update prediction snapshot with P&L from trade ──
    db.updatePredictionOutcome(currentPosition.periodKey, {
        actualPrice: gradeResult?.settlementPrice,
        actualDirection: gradeResult?.actualDirection,
        wasCorrect: positionWon,
        pnlCents: pnl,
    }).catch(e => console.error('[db] Failed to update prediction P&L:', e.message));

    // Snapshot balance after settlement for tracking
    refreshBalance();
    snapshotBalanceToDB('post_settle').catch(e => {});

    currentPosition = null;
    soldThisPeriod = null; // reset for new period
    flippedThisPeriod = false; // reset flip limit for new period
    syncZeroCount = 0;
    // Clean up old period entries (keep last 5 for safety)
    const periodKeys = Object.keys(enteredPeriods);
    if (periodKeys.length > 5) {
        const sorted = periodKeys.sort();
        for (let i = 0; i < sorted.length - 5; i++) {
            delete enteredPeriods[sorted[i]];
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Strategy: DIP/SPIKE BUYER — add to position at better odds
// Called every tick when we have an open position and price moves
// against us but recovery still looks likely.
// ═══════════════════════════════════════════════════════════════

async function onDipOpportunity(updatedPrediction, sellSignal, strike, currentPrice, minutesRemaining, kalshiTicker, periodKey) {
    if (!currentPosition || currentPosition.periodKey !== periodKey) return;
    if (killSwitch) return;
    if (minutesRemaining < 0.75) return; // was 1.5 — allow dip buying closer to settlement
    if (Date.now() - lastDipCheckTime < 8000) return; // throttle
    lastDipCheckTime = Date.now();

    // Respect fill failure cooldowns — don't spam orders when there's no liquidity
    const dipCheck = await canTrade(periodKey);
    if (!dipCheck.ok) return;

    const betIsUp = currentPosition.side === 'yes';
    const onWrongSide = (betIsUp && currentPrice < strike) || (!betIsUp && currentPrice >= strike);
    if (!onWrongSide) return; // not a dip — price is in our favor

    // Only add if the sell signal says HOLD (normal dip / recoverable)
    // Never add if the model says sell or lost cause
    if (sellSignal && (sellSignal.level === 'lost_cause' || sellSignal.level === 'sell_now' || sellSignal.level === 'consider_selling')) return;

    // Check updated prediction still agrees with our direction
    const bq = updatedPrediction && updatedPrediction._betQuality;
    if (!bq || !bq.shouldBet) return;
    const updIsUp = updatedPrediction.predictedPrice >= strike;
    if (updIsUp !== betIsUp) return; // model flipped — don't add

    // Check the probability is still decent (model thinks we'll recover)
    const probForBet = betIsUp ? updatedPrediction.probability : (1 - updatedPrediction.probability);
    if (probForBet < 0.50) return; // was 0.55 — allow dip buying with moderate confidence

    // Calculate the dip opportunity — how much cheaper can we buy?
    const currentLimitPrice = Math.max(5, Math.min(95, Math.round(probForBet * 100)));
    const entryImprovement = currentPosition.entryPrice - currentLimitPrice;
    if (entryImprovement < 3) return; // was 5¢ — allow smaller dips

    // How many more contracts can we add?
    const currentContracts = currentPosition.totalContracts || currentPosition.contracts;
    const dynamicMaxDip = getMaxContractsForRisk(currentLimitPrice, 0.15);
    const dipCap = probForBet >= 0.75 ? Math.min(dynamicMaxDip, config.convictionMaxContracts) : Math.min(dynamicMaxDip, config.maxPositionContracts);
    const maxAdd = dipCap - currentContracts;
    if (maxAdd <= 0) return; // already at max

    // Scale add size: bigger dip = add more, but cap at half the original position
    const dipScale = Math.min(1.0, entryImprovement / 20); // 20¢ dip = full scale
    const addContracts = Math.max(1, Math.min(maxAdd, Math.round(dipScale * bq.betSize * getBaseContractCount(currentLimitPrice))));

    const check = await canTrade(periodKey);
    if (!check.ok) return;

    const tradeInfo = {
        ticker: kalshiTicker,
        side: currentPosition.side,
        action: 'buy',
        contracts: addContracts,
        limitPrice: currentLimitPrice,
        periodKey,
        direction: betIsUp ? 'UP' : 'DOWN',
        strategy: 'dip_buyer',
        dipImprovement: entryImprovement + '¢',
        probForBet: (probForBet * 100).toFixed(0) + '%',
        existingContracts: currentContracts,
    };

    if (config.paperMode) {
        const cappedAdd = await capContractsByBalance(addContracts, currentLimitPrice);
        if (cappedAdd <= 0) return;
        const addCost = cappedAdd * currentLimitPrice;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) - addCost;
        console.log(`[trade-executor] PAPER DIP-BUY: +${cappedAdd}x ${currentPosition.side.toUpperCase()} @ ${currentLimitPrice}c (${entryImprovement}c cheaper) | Cost=$${(addCost/100).toFixed(2)} | Paper balance=$${(paperBalances[env]/100).toFixed(2)}`);
        // Update position with averaged entry
        const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const newTotal = currentContracts + cappedAdd;
        currentPosition.totalCostCents = oldCost + addCost;
        currentPosition.totalContracts = newTotal;
        currentPosition.contracts = newTotal;
        currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal); // weighted avg
        tradeInfo.contracts = cappedAdd;
        logTrade('dip_buy', tradeInfo);
        decisionLog.logTradeExecution({ ...tradeInfo, strategy: 'dip_buyer', currentPrice, strike });
        dailyStats.tradeCount++;
        return;
    }

    // LIVE ORDER
    const cappedAdd = await capContractsByBalance(addContracts, currentLimitPrice);
    if (cappedAdd <= 0) return;

    let balanceBefore = 0;
    try { balanceBefore = (await trading.getBalance()).balance; } catch (e) { /* continue */ }

    orderInFlight = true;
    try {
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side: currentPosition.side,
            action: 'buy',
            count: cappedAdd,
            yesPrice: currentPosition.side === 'yes' ? currentLimitPrice : undefined,
            noPrice: currentPosition.side === 'no' ? currentLimitPrice : undefined,
        });
        let order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            logTrade('dip_buy_failed', { ...tradeInfo, reason: order.status });
            markFillFailed(periodKey);
            return;
        }
        // ── FILL VERIFICATION ──
        if (order.status === 'resting' || order.status === 'open') {
            order = await waitForFill(order.order_id, order);
        }
        const fills = parseOrderFills(order);
        if (fills.filled === 0) {
            logTrade('dip_buy_unfilled', { ...tradeInfo, orderId: order.order_id });
            markFillFailed(periodKey);
            return;
        }
        let filledContracts = await verifyFillIsReal(order.order_id, kalshiTicker, currentPosition.side, fills.filled, balanceBefore);
        if (filledContracts === 0) {
            logTrade('dip_buy_phantom', { ...tradeInfo, orderId: order.order_id, claimedFills: fills.filled });
            markFillFailed(periodKey);
            return;
        }
        const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const addCost = filledContracts * currentLimitPrice;
        const newTotal = currentContracts + filledContracts;
        currentPosition.totalCostCents = oldCost + addCost;
        currentPosition.totalContracts = newTotal;
        currentPosition.contracts = newTotal;
        currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal);
        logTrade('dip_buy', { ...tradeInfo, orderId: order.order_id, filledContracts });
        dailyStats.tradeCount++;
        console.log(`[trade-executor] LIVE DIP-BUY: +${filledContracts}x @ ${currentLimitPrice}c — order ${order.order_id} (${order.status})`);
    } catch (err) {
        logTrade('dip_buy_error', { ...tradeInfo, error: err.message });
    } finally {
        orderInFlight = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// Strategy: LATE LOCK — enter big when outcome is nearly certain
// In the final minutes, if price is far from strike (many sigma),
// buy max contracts at the high price for a small guaranteed return.
// ═══════════════════════════════════════════════════════════════

async function onLateLock(updatedPrediction, strike, currentPrice, minutesRemaining, kalshiTicker, periodKey) {
    // Only allow late lock in final 1 minute — placing earlier risks losing everything
    if (minutesRemaining > 1.0) return;
    if (killSwitch) return;

    // Must have strong prediction data
    const bq = updatedPrediction && updatedPrediction._betQuality;
    if (!bq) return;

    const remainingVol = updatedPrediction._remainingVol || 0.002;
    const distanceFromStrike = Math.abs(currentPrice - strike);
    const distancePct = distanceFromStrike / strike;
    const sigmaDistance = distancePct / remainingVol;

    // Reduced from 2.5σ to 1.8σ — more aggressive late locks
    // At 1.8σ, there's ~96.4% chance price stays on this side
    if (sigmaDistance < 1.8) return;

    const priceAboveStrike = currentPrice >= strike;
    const lockSide = priceAboveStrike ? 'yes' : 'no';

    // Calculate the maximum entry price (high, since it's nearly guaranteed)
    // At 2.5σ, prob ≈ 0.994, so price ≈ 99¢ for winning side
    // We cap at 95¢ to ensure at least 5¢ profit per contract
    const winProb = Math.min(0.99, 0.5 + 0.5 * erf(sigmaDistance / Math.SQRT2));
    const maxLockPrice = Math.min(95, Math.max(85, Math.round(winProb * 100)));

    // FIX: Get the actual market ask price from the orderbook first.
    // Previously we passed maxLockPrice as "theoreticalPrice" to getAggressivePrice,
    // which then added slippage on top — meaning we'd cross the full spread to 95¢
    // even when the market mid was at 89-93¢. Now we use the real market ask and
    // cap it at maxLockPrice instead.
    const marketAsk = await getMarketPrice(kalshiTicker, lockSide, minutesRemaining);
    if (marketAsk === null) {
        console.log(`[trade-executor] Late-lock: no liquidity on orderbook — skipping, will retry next cycle`);
        return;
    }
    // Use the market ask, but never pay more than our calculated max
    const limitPrice = Math.min(marketAsk, maxLockPrice);
    console.log(`[trade-executor] Late-lock pricing: market ask=${marketAsk}c, maxLock=${maxLockPrice}c → limit=${limitPrice}c (sigma=${sigmaDistance.toFixed(2)})`);
    const profitPerContract = 100 - limitPrice;

    // Skip if profit margin is too thin (< 3¢ per contract after fees)
    if (profitPerContract < 5) return;

    // If we already have a position on this side, add to it up to max
    if (currentPosition && currentPosition.periodKey === periodKey) {
        if (currentPosition.side === lockSide) {
            // Already on the right side — add up to max
            const currentContracts = currentPosition.totalContracts || currentPosition.contracts;
            const dynamicMax = getMaxContractsForRisk(limitPrice, 0.15); // max 15% of bankroll
            const cappedMax = Math.min(dynamicMax, config.convictionMaxContracts);
            const addContracts = cappedMax - currentContracts; // late-lock = high conviction
            if (addContracts <= 0) return; // already maxed out
            // Respect fill failure cooldowns
            const addCheck = await canTrade(periodKey);
            if (!addCheck.ok) return;
            return await executeLockEntry(lockSide, addContracts, limitPrice, kalshiTicker, periodKey, sigmaDistance, profitPerContract, 'late_lock_add');
        } else {
            // On the wrong side?! This shouldn't happen if sell signals work, but don't fight it
            return;
        }
    }

    // No position — enter fresh with max contracts
    if (currentPosition) return; // different period position (shouldn't happen)

    const check = await canTrade(periodKey);
    if (!check.ok) return;

    const dynamicMaxFresh = getMaxContractsForRisk(limitPrice, 0.15); // max 15% of bankroll
    const contracts = Math.min(dynamicMaxFresh, config.convictionMaxContracts); // late-lock = high conviction, go big
    await executeLockEntry(lockSide, contracts, limitPrice, kalshiTicker, periodKey, sigmaDistance, profitPerContract, 'late_lock');
}

async function executeLockEntry(side, contracts, limitPrice, ticker, periodKey, sigmaDistance, profitPerContract, strategy) {
    const direction = side === 'yes' ? 'UP' : 'DOWN';
    const tradeInfo = {
        ticker,
        side,
        action: 'buy',
        contracts,
        limitPrice,
        periodKey,
        direction,
        strategy,
        sigmaDistance: sigmaDistance.toFixed(1) + 'σ',
        profitPerContract: profitPerContract + '¢',
        expectedProfit: '$' + ((contracts * profitPerContract) / 100).toFixed(2),
    };

    if (config.paperMode) {
        const cappedContracts = await capContractsByBalance(contracts, limitPrice);
        if (cappedContracts <= 0) return;
        const costCents = cappedContracts * limitPrice;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) - costCents;
        console.log(`[trade-executor] PAPER ${strategy.toUpperCase()}: ${cappedContracts}x ${side.toUpperCase()} @ ${limitPrice}c | ${sigmaDistance.toFixed(1)}σ away | Cost=$${(costCents/100).toFixed(2)} | Paper balance=$${(paperBalances[env]/100).toFixed(2)}`);
        if (currentPosition && currentPosition.periodKey === periodKey) {
            const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const newTotal = (currentPosition.totalContracts || currentPosition.contracts) + cappedContracts;
            currentPosition.totalCostCents = oldCost + costCents;
            currentPosition.totalContracts = newTotal;
            currentPosition.contracts = newTotal;
            currentPosition.entryPrice = Math.round((oldCost + costCents) / newTotal);
        } else {
            currentPosition = {
                ticker, side, contracts: cappedContracts,
                entryPrice: limitPrice,
                orderId: 'paper-lock-' + Date.now(),
                periodKey,
                entryTime: Date.now(),
                totalCostCents: costCents,
                totalContracts: cappedContracts,
            };
            enteredPeriods[periodKey] = { side, ticker, entryTime: Date.now() };
        }
        tradeInfo.contracts = cappedContracts;
        logTrade(strategy, tradeInfo);
        decisionLog.logTradeExecution({ ...tradeInfo, strategy });
        dailyStats.tradeCount++;
        return;
    }

    // LIVE
    const cappedContracts = await capContractsByBalance(contracts, limitPrice);
    if (cappedContracts <= 0) return;

    let balanceBefore = 0;
    try { balanceBefore = (await trading.getBalance()).balance; } catch (e) { /* continue */ }

    orderInFlight = true;
    try {
        const result = await trading.placeOrder({
            ticker,
            side,
            action: 'buy',
            count: cappedContracts,
            yesPrice: side === 'yes' ? limitPrice : undefined,
            noPrice: side === 'no' ? limitPrice : undefined,
        });
        let order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            logTrade(strategy + '_failed', { ...tradeInfo, reason: order.status });
            markFillFailed(periodKey);
            return;
        }
        // ── FILL VERIFICATION ──
        if (order.status === 'resting' || order.status === 'open') {
            order = await waitForFill(order.order_id, order);
        }
        const fills = parseOrderFills(order);
        if (fills.filled === 0) {
            logTrade(strategy + '_unfilled', { ...tradeInfo, orderId: order.order_id });
            markFillFailed(periodKey);
            return;
        }
        let filledContracts = await verifyFillIsReal(order.order_id, ticker, side, fills.filled, balanceBefore);
        if (filledContracts === 0) {
            logTrade(strategy + '_phantom', { ...tradeInfo, orderId: order.order_id, claimedFills: fills.filled });
            markFillFailed(periodKey);
            return;
        }
        if (currentPosition && currentPosition.periodKey === periodKey) {
            const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const addCost = filledContracts * limitPrice;
            const newTotal = (currentPosition.totalContracts || currentPosition.contracts) + filledContracts;
            currentPosition.totalCostCents = oldCost + addCost;
            currentPosition.totalContracts = newTotal;
            currentPosition.contracts = newTotal;
            currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal);
        } else {
            currentPosition = {
                ticker, side, contracts: filledContracts,
                entryPrice: limitPrice,
                orderId: order.order_id,
                periodKey,
                entryTime: Date.now(),
                totalCostCents: filledContracts * limitPrice,
                totalContracts: filledContracts,
            };
            enteredPeriods[periodKey] = { side, ticker, entryTime: Date.now() };
            syncZeroCount = 0;
        }
        logTrade(strategy, { ...tradeInfo, orderId: order.order_id, filledContracts });
        dailyStats.tradeCount++;
        console.log(`[trade-executor] LIVE ${strategy.toUpperCase()}: ${filledContracts}x ${side.toUpperCase()} @ ${limitPrice}c — order ${order.order_id} (${order.status})`);
    } catch (err) {
        logTrade(strategy + '_error', { ...tradeInfo, error: err.message });
    } finally {
        orderInFlight = false;
    }
}

// Approximation of the error function for probability calculations
function erf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}

// ═══════════════════════════════════════════════════════════════
// Strategy: RE-ENTRY — get back in after an early sell
// If we sold out (stop-loss/sell signal) but the prediction
// swings back in our favor, re-enter the position.
// ═══════════════════════════════════════════════════════════════

async function onReentryCheck(updatedPrediction, strike, currentPrice, minutesRemaining, kalshiTicker, periodKey) {
    // Must have sold this period and have no current position
    if (currentPosition) return;
    if (!soldThisPeriod || soldThisPeriod.periodKey !== periodKey) return;
    if (killSwitch) return;
    if (minutesRemaining < 1.5) return; // was 2.0 — allow later re-entry

    const bq = updatedPrediction && updatedPrediction._betQuality;
    if (!bq || !bq.shouldBet) return;

    // The updated prediction must agree with our original direction
    const origSide = soldThisPeriod.side;
    const origIsUp = origSide === 'yes';
    const updIsUp = updatedPrediction.predictedPrice >= strike;
    if (updIsUp !== origIsUp) return; // model hasn't recovered to our side

    // Lowered re-entry bar — still slightly above initial entry
    const probForBet = origIsUp ? updatedPrediction.probability : (1 - updatedPrediction.probability);
    if (probForBet < 0.55) return; // was 0.62
    if (bq.quality < 0.45) return; // was 0.65
    if (bq.edge < 0.03) return;    // was 0.06

    // Price must be back on our side
    const priceOnOurSide = (origIsUp && currentPrice >= strike) || (!origIsUp && currentPrice < strike);
    if (!priceOnOurSide) return;

    const check = await canTrade(periodKey);
    if (!check.ok) return;

    // Re-enter at near-full size (was 60%, now 85%) — use conviction cap if high conviction
    const limitPrice = Math.max(5, Math.min(95, Math.round(probForBet * 100)));
    const dynamicMaxReentry = getMaxContractsForRisk(limitPrice, 0.15);
    const reEntryCap = bq.betSize > 1.0 ? Math.min(dynamicMaxReentry, config.convictionMaxContracts) : Math.min(dynamicMaxReentry, config.maxPositionContracts);
    const contracts = Math.max(1, Math.min(
        reEntryCap,
        Math.round(bq.betSize * getBaseContractCount(limitPrice) * 0.85)
    ));

    const tradeInfo = {
        ticker: kalshiTicker,
        side: origSide,
        action: 'buy',
        contracts,
        limitPrice,
        periodKey,
        direction: origIsUp ? 'UP' : 'DOWN',
        strategy: 're_entry',
        originalSellReason: soldThisPeriod.reason,
        probForBet: (probForBet * 100).toFixed(0) + '%',
        edge: (bq.edge * 100).toFixed(1) + '%',
    };

    if (config.paperMode) {
        const cappedContracts = await capContractsByBalance(contracts, limitPrice);
        if (cappedContracts <= 0) return;
        const costCents = cappedContracts * limitPrice;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) - costCents;
        console.log(`[trade-executor] PAPER RE-ENTRY: ${cappedContracts}x ${origSide.toUpperCase()} @ ${limitPrice}c | Cost=$${(costCents/100).toFixed(2)} | Paper balance=$${(paperBalances[env]/100).toFixed(2)}`);
        currentPosition = {
            ticker: kalshiTicker,
            side: origSide,
            contracts: cappedContracts,
            entryPrice: limitPrice,
            orderId: 'paper-reentry-' + Date.now(),
            periodKey,
            entryTime: Date.now(),
            totalCostCents: costCents,
            totalContracts: cappedContracts,
        };
        tradeInfo.contracts = cappedContracts;
        logTrade('re_entry', tradeInfo);
        decisionLog.logTradeExecution({ ...tradeInfo, strategy: 're_entry', currentPrice, strike, probability: (probForBet * 100).toFixed(1) + '%' });
        dailyStats.tradeCount++;
        soldThisPeriod = null; // consumed
        return;
    }

    // LIVE
    const cappedContracts = await capContractsByBalance(contracts, limitPrice);
    if (cappedContracts <= 0) return;

    let balanceBefore = 0;
    try { balanceBefore = (await trading.getBalance()).balance; } catch (e) { /* continue */ }

    orderInFlight = true;
    try {
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side: origSide,
            action: 'buy',
            count: cappedContracts,
            yesPrice: origSide === 'yes' ? limitPrice : undefined,
            noPrice: origSide === 'no' ? limitPrice : undefined,
        });
        let order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            logTrade('re_entry_failed', { ...tradeInfo, reason: order.status });
            return;
        }
        // ── FILL VERIFICATION ──
        if (order.status === 'resting' || order.status === 'open') {
            order = await waitForFill(order.order_id, order);
        }
        const fills = parseOrderFills(order);
        if (fills.filled === 0) {
            logTrade('re_entry_unfilled', { ...tradeInfo, orderId: order.order_id });
            return;
        }
        let filledContracts = await verifyFillIsReal(order.order_id, kalshiTicker, origSide, fills.filled, balanceBefore);
        if (filledContracts === 0) {
            logTrade('re_entry_phantom', { ...tradeInfo, orderId: order.order_id, claimedFills: fills.filled });
            return;
        }
        currentPosition = {
            ticker: kalshiTicker,
            side: origSide,
            contracts: filledContracts,
            entryPrice: limitPrice,
            orderId: order.order_id,
            periodKey,
            entryTime: Date.now(),
            totalCostCents: filledContracts * limitPrice,
            totalContracts: filledContracts,
        };
        logTrade('re_entry', { ...tradeInfo, orderId: order.order_id, filledContracts });
        dailyStats.tradeCount++;
        soldThisPeriod = null;
        console.log(`[trade-executor] LIVE RE-ENTRY: ${filledContracts}x ${origSide.toUpperCase()} @ ${limitPrice}c — order ${order.order_id} (${order.status})`);
    } catch (err) {
        logTrade('re_entry_error', { ...tradeInfo, error: err.message });
    } finally {
        orderInFlight = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// Controls
// ═══════════════════════════════════════════════════════════════

function setKillSwitch(active) {
    killSwitch = active;
    console.log(`[trade-executor] Kill switch ${active ? 'ACTIVATED' : 'deactivated'}`);
    if (active && currentPosition && !config.paperMode) {
        // Try to sell the current position immediately at market bid (not 1 cent)
        const emergencyPos = currentPosition; // capture before async
        getMarketSellPrice(emergencyPos.ticker, emergencyPos.side, 0).then(marketBid => {
            const emergencySellPrice = marketBid || 1;
            console.log(`[trade-executor] Emergency sell: using price ${emergencySellPrice}c (market bid: ${marketBid || 'unavailable'})`);
            return trading.placeOrder({
                ticker: emergencyPos.ticker,
                side: emergencyPos.side,
                action: 'sell',
                count: emergencyPos.contracts,
                yesPrice: emergencyPos.side === 'yes' ? emergencySellPrice : undefined,
                noPrice: emergencyPos.side === 'no' ? emergencySellPrice : undefined,
                timeInForce: 'fill_or_kill',
            });
        }).then(() => {
            console.log('[trade-executor] Emergency sell executed');
            currentPosition = null;
        }).catch(err => {
            console.error('[trade-executor] Emergency sell failed:', err.message);
        });
    }
}

function setPaperMode(enabled) {
    config.paperMode = enabled;
    console.log(`[trade-executor] Mode: ${enabled ? 'PAPER' : 'LIVE'}`);
}

function setPaperBalance(env, cents) {
    const key = env === 'production' ? 'production' : 'demo';
    paperBalances[key] = cents;
    console.log(`[trade-executor] Paper balance set: ${key} = $${(cents / 100).toFixed(2)}`);
    return paperBalances[key];
}

function addPaperBalance(env, cents) {
    const key = env === 'production' ? 'production' : 'demo';
    paperBalances[key] = (paperBalances[key] || 0) + cents;
    console.log(`[trade-executor] Paper balance added $${(cents / 100).toFixed(2)}: ${key} = $${(paperBalances[key] / 100).toFixed(2)}`);
    return paperBalances[key];
}

function getPaperBalances() {
    return { ...paperBalances };
}

function resetState() {
    currentPosition = null;
    dailyStats.date = new Date().toISOString().slice(0, 10);
    dailyStats.pnlCents = 0;
    dailyStats.tradeCount = 0;
    dailyStats.wins = 0;
    dailyStats.losses = 0;
    tradeLog.length = 0;
    enteredPeriods = {};
    syncZeroCount = 0;
    killSwitch = true;
    console.log('[trade-executor] State reset — kill switch activated');
}

function clearTradeLog() {
    tradeLog.length = 0;
    console.log('[trade-executor] Trade log cleared');
}

// ═══════════════════════════════════════════════════════════════
// Status & logging
// ═══════════════════════════════════════════════════════════════

let tradeNotifyCallback = null;

function onTradeNotify(cb) { tradeNotifyCallback = cb; }

function logTrade(type, info) {
    const entry = { type, time: new Date().toISOString(), ...info };
    tradeLog.unshift(entry);
    if (tradeLog.length > MAX_TRADE_LOG) tradeLog.length = MAX_TRADE_LOG;
    // Persist to PostgreSQL (fire-and-forget)
    db.logTrade(entry).catch(e => console.error('[db] Trade log error:', e.message));
    // Persist daily stats + position (debounced) after every trade
    persistDailyStats();
    persistPosition();
    // Notify listeners (for push notifications)
    if (tradeNotifyCallback) {
        try { tradeNotifyCallback(entry); } catch(e) { /* ignore */ }
    }
}

async function refreshBalance() {
    if (cachedBalance && Date.now() - cachedBalance.lastFetched < BALANCE_CACHE_MS) return;
    try {
        const resp = await trading.getBalance();
        cachedBalance = { balanceCents: resp.balance, portfolioValueCents: resp.portfolio_value, lastFetched: Date.now() };
    } catch (e) {
        // Silently fail — will retry next cycle
    }
}

// ── Balance snapshot to DB (every 5 minutes) ──
let lastBalanceSnapshot = 0;
const BALANCE_SNAPSHOT_MS = 5 * 60 * 1000; // 5 minutes

async function snapshotBalanceToDB(note) {
    if (!cachedBalance) return;
    const now = Date.now();
    // Throttle periodic snapshots (but allow forced snapshots via note)
    if (!note && now - lastBalanceSnapshot < BALANCE_SNAPSHOT_MS) return;
    lastBalanceSnapshot = now;

    const env = getEnvironment();
    db.saveBalanceSnapshot({
        environment: env,
        balanceCents: cachedBalance.balanceCents,
        portfolioValueCents: cachedBalance.portfolioValueCents || null,
        pnlCents: dailyStats.pnlCents,
        tradeCount: dailyStats.tradeCount,
        wins: dailyStats.wins,
        losses: dailyStats.losses,
        note: note || 'periodic',
    }).catch(e => console.error('[db] Balance snapshot error:', e.message));
}

let lastPositionSync = 0;
const POSITION_SYNC_MS = 15000; // sync with Kalshi every 15s

async function syncPositionWithKalshi() {
    if (config.paperMode) return;
    // Demo API doesn't reflect demo orders in portfolio/positions endpoint,
    // so syncing would always see 0 contracts and incorrectly clear the position
    if (getEnvironment() === 'demo') return;
    if (!currentPosition || !currentPosition.ticker) return;
    if (Date.now() - lastPositionSync < POSITION_SYNC_MS) return;
    lastPositionSync = Date.now();

    // Safety: never clear a position that was entered less than 90s ago
    // (Kalshi API may be slow to reflect newly placed orders)
    const positionAge = Date.now() - (currentPosition.entryTime || 0);
    if (positionAge < 90000) {
        return;
    }

    try {
        // Use verifyPositionOnKalshi which correctly reads yes_count/no_count fields
        const kalshiContracts = await verifyPositionOnKalshi(currentPosition.ticker, currentPosition.side);

        if (kalshiContracts === -1) {
            // Verification failed (network error) — do nothing, retry next cycle
            return;
        }

        if (kalshiContracts > 0) {
            syncZeroCount = 0; // reset zero counter
            const oldTotal = currentPosition.totalContracts || currentPosition.contracts;
            if (kalshiContracts !== oldTotal) {
                console.log(`[trade-executor] Position sync: app=${oldTotal} Kalshi=${kalshiContracts} contracts — updating to Kalshi count`);
                currentPosition.totalContracts = kalshiContracts;
                currentPosition.contracts = kalshiContracts;
                // If Kalshi has more than we tracked, update cost estimate
                if (kalshiContracts > oldTotal && currentPosition.entryPrice) {
                    const oldCost = currentPosition.totalCostCents || (oldTotal * currentPosition.entryPrice);
                    const extraContracts = kalshiContracts - oldTotal;
                    currentPosition.totalCostCents = oldCost + (extraContracts * currentPosition.entryPrice);
                    console.log(`[trade-executor] Position sync: adjusted cost for ${extraContracts} extra contracts`);
                }
                persistPosition();
            }
        } else {
            // Kalshi reports 0 or no position — but require 3 consecutive zero readings
            // before clearing (to handle API lag, temporary 404s, etc.)
            syncZeroCount++;
            console.log(`[trade-executor] Position sync: Kalshi reports 0 for ${currentPosition.ticker} (zero count: ${syncZeroCount}/3)`);
            if (syncZeroCount >= 3 && positionAge > 120000) {
                console.log(`[trade-executor] Position sync: confirmed 0 contracts after ${syncZeroCount} checks — clearing position`);
                currentPosition = null;
                syncZeroCount = 0;
                persistPosition();
            }
        }
    } catch (e) {
        // 404 means the market/contract expired — but require age check
        if (e.status === 404 && positionAge > 180000) {
            syncZeroCount++;
            if (syncZeroCount >= 3) {
                console.log(`[trade-executor] Position sync: 404 for ${currentPosition?.ticker} after ${syncZeroCount} checks — clearing position`);
                currentPosition = null;
                syncZeroCount = 0;
                persistPosition();
            }
        }
        // Other errors: silently fail — will retry next cycle
    }
}

function getStatus() {
    checkDayRollover().catch(e => console.error('[db] Day rollover error:', e.message));
    // Validate position is still for current period (prevents phantom positions)
    validateCurrentPosition();
    // Trigger async balance refresh + position sync + balance snapshot (non-blocking)
    if (!config.paperMode) {
        refreshBalance();
    }
    syncPositionWithKalshi();
    snapshotBalanceToDB().catch(e => {});
    const env = getEnvironment();
    const effectiveBalance = config.paperMode
        ? (paperBalances[env] || 0)
        : (cachedBalance ? cachedBalance.balanceCents : null);
    return {
        paperMode: config.paperMode,
        killSwitch,
        configured: trading.isConfigured(),
        balanceCents: effectiveBalance,
        currentPosition: currentPosition ? (() => {
            const totalCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const totalContracts = currentPosition.totalContracts || currentPosition.contracts;
            return {
                ticker: currentPosition.ticker,
                side: currentPosition.side,
                contracts: totalContracts,              // always show total position size
                entryPrice: Math.round(totalCost / totalContracts), // weighted average entry
                periodKey: currentPosition.periodKey,
                holdingSeconds: Math.round((Date.now() - currentPosition.entryTime) / 1000),
                totalCostCents: totalCost,
                totalContracts: totalContracts,
            };
        })() : null,
        soldThisPeriod: soldThisPeriod ? { side: soldThisPeriod.side, reason: soldThisPeriod.reason } : null,
        daily: { ...dailyStats },
        config: {
            baseContracts: config.baseContracts,
            maxPositionContracts: config.maxPositionContracts,
            convictionMaxContracts: config.convictionMaxContracts,
            maxDailyLossCents: config.maxDailyLossCents,
            maxDailyTrades: config.maxDailyTrades,
        },
        recentTrades: tradeLog.slice(0, 200),
        thought: { ...traderThought },
    };
}

// ═══════════════════════════════════════════════════════════════
// Press Bet — add contracts to an existing open position
// ═══════════════════════════════════════════════════════════════

async function pressBet(addContracts) {
    if (!currentPosition) {
        return { ok: false, reason: 'No open position to press' };
    }

    const ticker = currentPosition.ticker;
    const side = currentPosition.side;
    const periodKey = currentPosition.periodKey;
    const currentContracts = currentPosition.totalContracts || currentPosition.contracts;
    const contractsToAdd = addContracts || Math.max(1, getBaseContractCount(currentPosition.entryPrice));

    console.log(`[trade-executor] PRESS BET: adding ${contractsToAdd}x ${side.toUpperCase()} to existing ${currentContracts}x on ${ticker}`);

    const tradeInfo = {
        ticker, side, action: 'buy', contracts: contractsToAdd, periodKey,
        direction: side === 'yes' ? 'UP' : 'DOWN',
        strategy: 'press_bet', existingContracts: currentContracts,
    };

    if (config.paperMode) {
        // Use actual market ask price, not stale entry price
        const limitPrice = await getMarketPrice(ticker, side, 15) || currentPosition.entryPrice;
        console.log(`[trade-executor] PRESS BET paper: market ask = ${limitPrice}c (entry was ${currentPosition.entryPrice}c)`);
        const cappedAdd = await capContractsByBalance(contractsToAdd, limitPrice);
        if (cappedAdd <= 0) return { ok: false, reason: 'Insufficient paper balance' };
        const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const addCost = cappedAdd * limitPrice;
        const newTotal = currentContracts + cappedAdd;
        currentPosition.totalCostCents = oldCost + addCost;
        currentPosition.totalContracts = newTotal;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) - addCost;
        setThought('bought', `Pressed +${cappedAdd}x ${side.toUpperCase()} @ ${limitPrice}c (now ${newTotal}x)`, { contracts: newTotal });
        logTrade('buy', { ...tradeInfo, limitPrice, fillStatus: 'paper-press', filledContracts: cappedAdd });
        dailyStats.tradeCount++;
        return { ok: true, side, contracts: cappedAdd, entryPrice: limitPrice, totalContracts: newTotal, mode: 'paper' };
    }

    // Live: get actual market price from orderbook and retry
    const MAX_ATTEMPTS = 3;
    const PRICE_BUMP = 3;
    let minutesRemaining = 15;
    try {
        const now = new Date();
        const mins = now.getMinutes();
        const periodEnd = (Math.floor(mins / 15) + 1) * 15;
        minutesRemaining = Math.max(1, periodEnd - mins);
    } catch(e) { /* fallback */ }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const priceEscalation = (attempt - 1) * PRICE_BUMP;
        // PRESS BET: use actual market ask price, not theoretical cap
        let limitPrice = await getMarketPrice(ticker, side, minutesRemaining);
        if (limitPrice !== null && attempt > 1) {
            limitPrice = Math.min(95, limitPrice + priceEscalation);
        }
        if (limitPrice === null) {
            console.log(`[trade-executor] PRESS BET attempt ${attempt}: no liquidity — will retry`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        const cappedContracts = await capContractsByBalance(contractsToAdd, limitPrice);
        if (cappedContracts <= 0) {
            return { ok: false, reason: 'Insufficient balance to press bet' };
        }

        console.log(`[trade-executor] PRESS BET attempt ${attempt}/${MAX_ATTEMPTS}: +${cappedContracts}x ${side.toUpperCase()} @ ${limitPrice}c`);

        orderInFlight = true;
        try {
            const result = await trading.placeOrder({
                ticker, side, action: 'buy', count: cappedContracts,
                yesPrice: side === 'yes' ? limitPrice : undefined,
                noPrice: side === 'no' ? limitPrice : undefined,
            });

            let order = result.order || {};
            if (order.status === 'canceled' || order.status === 'rejected') {
                if (attempt === MAX_ATTEMPTS) return { ok: false, reason: `Order ${order.status} after ${MAX_ATTEMPTS} attempts` };
                await sleep(1000);
                continue;
            }

            if (order.status === 'resting' || order.status === 'open') {
                order = await waitForFill(order.order_id, order, 8000);
            }

            const fills = parseOrderFills(order);
            let filledContracts = fills.filled;
            if (filledContracts === 0) {
                if (attempt === MAX_ATTEMPTS) return { ok: false, reason: `No fills after ${MAX_ATTEMPTS} attempts` };
                await sleep(1000);
                continue;
            }

            const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const addCost = filledContracts * limitPrice;
            const newTotal = currentContracts + filledContracts;
            currentPosition.totalCostCents = oldCost + addCost;
            currentPosition.totalContracts = newTotal;
            setThought('bought', `Pressed +${filledContracts}x ${side.toUpperCase()} @ ${limitPrice}c (now ${newTotal}x)`, { contracts: newTotal });
            logTrade('buy', { ...tradeInfo, limitPrice, orderId: order.order_id, fillStatus: order.status, filledContracts, attempt });
            dailyStats.tradeCount++;
            return { ok: true, side, contracts: filledContracts, entryPrice: limitPrice, totalContracts: newTotal, mode: 'live', orderId: order.order_id, attempts: attempt };
        } catch (err) {
            if (attempt === MAX_ATTEMPTS) return { ok: false, reason: err.message };
            await sleep(1000);
        } finally {
            orderInFlight = false;
        }
    }
    return { ok: false, reason: 'Press bet exhausted all attempts' };
}

// ═══════════════════════════════════════════════════════════════
// Force Bet — manual override, bypasses all quality/Kelly checks
// ═══════════════════════════════════════════════════════════════

async function forceBet(prediction, kalshiTicker, strike, periodKey, overrideContracts) {
    if (!prediction || !kalshiTicker || strike === null) {
        return { ok: false, reason: 'Missing prediction, ticker, or strike data' };
    }

    // Force bet should ADD to existing position, not refuse
    const addingToExisting = currentPosition && currentPosition.periodKey === periodKey;

    // Close stale position from a previous period
    if (currentPosition && currentPosition.periodKey !== periodKey) {
        console.log(`[trade-executor] Force bet: auto-settling stale position from ${currentPosition.periodKey}`);
        const staleContracts = currentPosition.totalContracts || currentPosition.contracts;
        const staleCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        if (staleContracts > 0 && staleCost > 0) {
            const pnl = -staleCost;
            dailyStats.losses++;
            dailyStats.pnlCents += pnl;
            logTrade('settle', {
                ticker: currentPosition.ticker, side: currentPosition.side,
                contracts: staleContracts, entryPrice: Math.round(staleCost / staleContracts),
                correct: false, pnlCents: pnl, dailyPnlCents: dailyStats.pnlCents,
                periodKey: currentPosition.periodKey,
                note: 'auto-settled stale position before force bet',
            });
        }
        currentPosition = null;
    }

    const isUp = prediction.predictedPrice >= strike;
    const side = isUp ? 'yes' : 'no';
    const direction = isUp ? 'UP' : 'DOWN';
    const probForBet = isUp ? prediction.probability : (1 - prediction.probability);
    const theoreticalPrice = Math.round(probForBet * 100);
    const contracts = overrideContracts || Math.max(1, getBaseContractCount(theoreticalPrice));

    console.log(`[trade-executor] FORCE BET: ${contracts}x ${side.toUpperCase()} (${direction}) on ${kalshiTicker} @ ~${theoreticalPrice}c`);

    const tradeInfo = {
        ticker: kalshiTicker, side, action: 'buy', contracts, periodKey,
        direction, edge: 'FORCED', quality: 'FORCED', betSize: '1.00',
        strategy: 'force_bet',
    };

    if (config.paperMode) {
        // Use actual market ask price — FORCE BET should buy at market, not theoretical
        const limitPrice = await getMarketPrice(kalshiTicker, side, 15) || Math.max(5, Math.min(95, theoreticalPrice));
        console.log(`[trade-executor] FORCE BET paper: market ask = ${limitPrice}c (theoretical was ${theoreticalPrice}c)`);
        const cappedContracts = await capContractsByBalance(contracts, limitPrice);
        if (cappedContracts <= 0) return { ok: false, reason: 'Insufficient paper balance' };
        const costCents = cappedContracts * limitPrice;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) - costCents;
        if (addingToExisting) {
            const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const newTotal = (currentPosition.totalContracts || currentPosition.contracts) + cappedContracts;
            currentPosition.totalCostCents = oldCost + costCents;
            currentPosition.totalContracts = newTotal;
            currentPosition.contracts = newTotal;
            currentPosition.entryPrice = Math.round((oldCost + costCents) / newTotal);
        } else {
            currentPosition = {
                ticker: kalshiTicker, side, contracts: cappedContracts, entryPrice: limitPrice,
                orderId: 'force-paper-' + Date.now(), periodKey, entryTime: Date.now(),
                totalCostCents: costCents, totalContracts: cappedContracts,
            };
        }
        enteredPeriods[periodKey] = enteredPeriods[periodKey] || { side, ticker: kalshiTicker, entryTime: Date.now() };
        tradeInfo.contracts = cappedContracts;
        logTrade('buy', { ...tradeInfo, limitPrice, fillStatus: 'paper-forced' });
        dailyStats.tradeCount++;
        return { ok: true, side, direction, contracts: cappedContracts, entryPrice: limitPrice, mode: 'paper' };
    }

    // Live order — retry with escalating price up to 3 attempts
    const MAX_FORCE_ATTEMPTS = 3;
    const PRICE_BUMP = 3; // bump 3¢ each retry
    let minutesRemaining = 15;
    // Estimate minutes remaining from period key if possible
    try {
        const now = new Date();
        const mins = now.getMinutes();
        const periodEnd = (Math.floor(mins / 15) + 1) * 15;
        minutesRemaining = Math.max(1, periodEnd - mins);
    } catch(e) { /* fallback to 15 */ }

    for (let attempt = 1; attempt <= MAX_FORCE_ATTEMPTS; attempt++) {
        const priceEscalation = (attempt - 1) * PRICE_BUMP;
        // FORCE BET: use actual market ask price, not theoretical cap
        // First try market price, then fall back to aggressive price with escalation
        let limitPrice = await getMarketPrice(kalshiTicker, side, minutesRemaining);
        if (limitPrice !== null && attempt > 1) {
            // On retries, bump above market ask to improve fill chance
            limitPrice = Math.min(95, limitPrice + priceEscalation);
        }
        if (limitPrice === null) {
            console.log(`[trade-executor] FORCE BET attempt ${attempt}: no liquidity — will retry`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        const cappedContracts = await capContractsByBalance(contracts, limitPrice);
        if (cappedContracts <= 0) {
            return { ok: false, reason: 'Insufficient balance for force bet' };
        }

        console.log(`[trade-executor] FORCE BET attempt ${attempt}/${MAX_FORCE_ATTEMPTS}: ${cappedContracts}x ${side.toUpperCase()} @ ${limitPrice}c (market price)`);

        orderInFlight = true;
        try {
            const result = await trading.placeOrder({
                ticker: kalshiTicker, side, action: 'buy', count: cappedContracts,
                yesPrice: side === 'yes' ? limitPrice : undefined,
                noPrice: side === 'no' ? limitPrice : undefined,
            });

            let order = result.order || {};
            if (order.status === 'canceled' || order.status === 'rejected') {
                if (attempt === MAX_FORCE_ATTEMPTS) {
                    return { ok: false, reason: `Order ${order.status} after ${MAX_FORCE_ATTEMPTS} attempts: ${order.cancel_reason || 'unknown'}` };
                }
                console.log(`[trade-executor] Force bet attempt ${attempt} rejected — retrying with higher price`);
                await sleep(1000);
                continue;
            }

            if (order.status === 'resting' || order.status === 'open') {
                order = await waitForFill(order.order_id, order, 8000); // shorter wait for force
            }

            const fills = parseOrderFills(order);
            let filledContracts = fills.filled;
            if (filledContracts === 0) {
                logTrade('buy_unfilled', { ...tradeInfo, limitPrice, orderId: order.order_id, finalStatus: order.status, attempt });
                if (attempt === MAX_FORCE_ATTEMPTS) {
                    return { ok: false, reason: `No fills after ${MAX_FORCE_ATTEMPTS} attempts (last price: ${limitPrice}c)` };
                }
                console.log(`[trade-executor] Force bet attempt ${attempt} unfilled at ${limitPrice}c — retrying +${PRICE_BUMP}c`);
                await sleep(1000);
                continue;
            }

            if (addingToExisting) {
                const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
                const addCost = filledContracts * limitPrice;
                const newTotal = (currentPosition.totalContracts || currentPosition.contracts) + filledContracts;
                currentPosition.totalCostCents = oldCost + addCost;
                currentPosition.totalContracts = newTotal;
                currentPosition.contracts = newTotal;
                currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal);
            } else {
                currentPosition = {
                    ticker: kalshiTicker, side, contracts: filledContracts, entryPrice: limitPrice,
                    orderId: order.order_id, periodKey, entryTime: Date.now(),
                    totalCostCents: filledContracts * limitPrice, totalContracts: filledContracts,
                };
            }
            enteredPeriods[periodKey] = enteredPeriods[periodKey] || { side, ticker: kalshiTicker, entryTime: Date.now() };
            logTrade('buy', { ...tradeInfo, limitPrice, orderId: order.order_id, fillStatus: order.status, filledContracts, requestedContracts: cappedContracts, attempt });
            dailyStats.tradeCount++;
            return { ok: true, side, direction, contracts: filledContracts, entryPrice: limitPrice, mode: 'live', orderId: order.order_id, attempts: attempt };
        } catch (err) {
            logTrade('buy_error', { ...tradeInfo, error: err.message, response: err.response, attempt });
            if (attempt === MAX_FORCE_ATTEMPTS) {
                return { ok: false, reason: `Error after ${MAX_FORCE_ATTEMPTS} attempts: ${err.message}` };
            }
            await sleep(1000);
        } finally {
            orderInFlight = false;
        }
    }
    return { ok: false, reason: 'Force bet exhausted all retry attempts' };
}

// ═══════════════════════════════════════════════════════════════
// Force Sell — manual override, immediately sell entire position
// ═══════════════════════════════════════════════════════════════

async function forceSell() {
    if (!currentPosition) {
        return { ok: false, reason: 'No open position to sell' };
    }

    const contracts = currentPosition.totalContracts || currentPosition.contracts;
    const side = currentPosition.side;
    const ticker = currentPosition.ticker;
    const periodKey = currentPosition.periodKey;

    console.log(`[trade-executor] FORCE SELL: ${contracts}x ${side.toUpperCase()} on ${ticker}`);

    const tradeInfo = {
        ticker, side, contracts, action: 'sell', periodKey,
        strategy: 'force_sell', reason: 'manual_force_sell',
    };

    if (config.paperMode) {
        const sellPrice = Math.max(1, currentPosition.entryPrice - 5);
        const sellProceeds = contracts * sellPrice;
        const env = getEnvironment();
        paperBalances[env] = (paperBalances[env] || 0) + sellProceeds;
        console.log(`[trade-executor] PAPER FORCE SELL: ${contracts}x ${side.toUpperCase()} @ ~${sellPrice}c | Proceeds=$${(sellProceeds/100).toFixed(2)} | Paper balance=$${(paperBalances[env]/100).toFixed(2)}`);
        logTrade('sell', { ...tradeInfo, limitPrice: sellPrice, fillStatus: 'paper-force-sell' });
        dailyStats.tradeCount++;
        soldThisPeriod = { periodKey, side, ticker, soldAt: Date.now(), reason: 'force_sell' };
        currentPosition = null;
        return { ok: true, side, contracts, mode: 'paper' };
    }

    // Live: aggressive sell — try multiple price levels
    if (orderInFlight) {
        return { ok: false, reason: 'Another order is in flight — wait a moment' };
    }

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Start aggressive, get more desperate each attempt
        const discount = 5 + (attempt - 1) * 10; // 5c, 15c, 25c discount
        const limitPrice = Math.max(1, currentPosition.entryPrice - discount);

        console.log(`[trade-executor] FORCE SELL attempt ${attempt}/${MAX_ATTEMPTS}: ${contracts}x ${side.toUpperCase()} @ ${limitPrice}c`);

        orderInFlight = true;
        try {
            const result = await trading.placeOrder({
                ticker, side, action: 'sell', count: contracts,
                yesPrice: side === 'yes' ? limitPrice : undefined,
                noPrice: side === 'no' ? limitPrice : undefined,
            });

            let order = result.order || {};
            if (order.status === 'resting' || order.status === 'open') {
                order = await waitForFill(order.order_id, order, 5000);
            }

            const fills = parseOrderFills(order);
            if (fills.filled === 0) {
                if (attempt === MAX_ATTEMPTS) {
                    logTrade('sell_unfilled', { ...tradeInfo, orderId: order.order_id });
                    return { ok: false, reason: 'Could not fill sell after ' + MAX_ATTEMPTS + ' attempts' };
                }
                await sleep(500);
                continue;
            }

            if (fills.filled < contracts) {
                currentPosition.contracts -= fills.filled;
                if (currentPosition.totalContracts) currentPosition.totalContracts -= fills.filled;
                logTrade('sell_partial', { ...tradeInfo, orderId: order.order_id, filledContracts: fills.filled, remaining: currentPosition.contracts });
                dailyStats.tradeCount++;
                return { ok: true, side, contracts: fills.filled, remaining: currentPosition.contracts, mode: 'live', partial: true };
            }

            // Fully sold
            logTrade('sell', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status, filledContracts: fills.filled });
            dailyStats.tradeCount++;
            soldThisPeriod = { periodKey, side, ticker, soldAt: Date.now(), reason: 'force_sell' };
            currentPosition = null;
            return { ok: true, side, contracts: fills.filled, mode: 'live', orderId: order.order_id };
        } catch (err) {
            if (attempt === MAX_ATTEMPTS) {
                logTrade('sell_error', { ...tradeInfo, error: err.message });
                return { ok: false, reason: err.message };
            }
            await sleep(500);
        } finally {
            orderInFlight = false;
        }
    }
    return { ok: false, reason: 'Force sell exhausted all attempts' };
}

// ═══════════════════════════════════════════════════════════════
// Database initialization — restore state from PostgreSQL on startup
// ═══════════════════════════════════════════════════════════════

async function initFromDB() {
    await db.init();
    const today = new Date().toISOString().slice(0, 10);

    // Restore today's daily stats
    const savedStats = await db.loadDailyStats(today);
    if (savedStats) {
        dailyStats.date = today;
        dailyStats.pnlCents = savedStats.pnlCents;
        dailyStats.tradeCount = savedStats.tradeCount;
        dailyStats.wins = savedStats.wins;
        dailyStats.losses = savedStats.losses;
        console.log(`[trade-executor] Restored daily stats from DB: ${savedStats.wins}W/${savedStats.losses}L, P&L: ${savedStats.pnlCents > 0 ? '+' : ''}${(savedStats.pnlCents / 100).toFixed(2)}`);
    }

    // Restore trade history into in-memory log
    const savedTrades = await db.getRecentTrades(MAX_TRADE_LOG);
    if (savedTrades.length > 0) {
        tradeLog.length = 0;
        tradeLog.push(...savedTrades);
        const totalCount = await db.getTradeCount();
        console.log(`[trade-executor] Restored ${savedTrades.length} trades from DB (${totalCount} total in DB)`);
    }

    // Restore current position (if server restarted mid-position)
    const savedPos = await db.loadPosition();
    if (savedPos && savedPos.ticker) {
        const currentPeriod = getCurrentPeriodKey();
        if (savedPos.periodKey && savedPos.periodKey !== currentPeriod) {
            console.log(`[trade-executor] Restored position from DB but period expired: position=${savedPos.periodKey}, current=${currentPeriod} — discarding`);
            // Clear the stale position from DB
            db.savePosition(null).catch(e => console.error('[db] Position clear error:', e.message));
        } else {
            currentPosition = savedPos;
            console.log(`[trade-executor] Restored position from DB: ${savedPos.contracts}x ${savedPos.side} @ ${savedPos.ticker} (period=${savedPos.periodKey})`);
        }
    }

    // Snapshot balance on startup
    try {
        await refreshBalance();
        await snapshotBalanceToDB('startup');
        if (cachedBalance) {
            console.log(`[trade-executor] Balance on startup: $${(cachedBalance.balanceCents / 100).toFixed(2)} (${getEnvironment()})`);
        }
    } catch (e) {
        // Non-fatal — balance tracking is best-effort
    }
}

module.exports = {
    initFromDB,
    onNewPrediction,
    onSellSignal,
    onPeriodEnd,
    onDipOpportunity,
    onLateLock,
    onReentryCheck,
    setKillSwitch,
    setPaperMode,
    setPaperBalance,
    addPaperBalance,
    getPaperBalances,
    clearTradeLog,
    resetState,
    getStatus,
    onTradeNotify,
    forceBet,
    pressBet,
    forceSell,
    snapshotBalanceToDB,
    config, // exposed for startup logging
};
