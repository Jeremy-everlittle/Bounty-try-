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
    baseContracts: parseInt(process.env.BASE_CONTRACTS || '5', 10),
    maxPositionContracts: parseInt(process.env.MAX_POSITION_CONTRACTS || '50', 10),
    convictionMaxContracts: parseInt(process.env.CONVICTION_MAX_CONTRACTS || '150', 10), // higher cap for high-conviction bets
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
let lastDipCheckTime = 0;     // Throttle dip checks (one per 10s tick)
let cachedBalance = null;     // { balanceCents, lastFetched }
const BALANCE_CACHE_MS = 30000; // refresh balance every 30s
let orderInFlight = false;    // mutex: prevent concurrent order placement
let fillFailedPeriods = {};   // { periodKey: { count, lastAttempt } } — track fill failures for price adjustment

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
    if (!trading.isConfigured() && !config.paperMode) {
        return { ok: false, reason: 'Kalshi API not configured (set KALSHI_API_KEY + KALSHI_PRIVATE_KEY)' };
    }
    if (dailyStats.pnlCents <= -config.maxDailyLossCents) {
        return { ok: false, reason: `Daily loss limit reached ($${(Math.abs(dailyStats.pnlCents) / 100).toFixed(2)})` };
    }
    if (dailyStats.tradeCount >= config.maxDailyTrades) {
        return { ok: false, reason: `Daily trade limit reached (${dailyStats.tradeCount})` };
    }
    // Track fill failures but don't block — let retry logic handle with better price
    // Only block after 3 consecutive failures in the same period (likely no liquidity)
    if (periodKey && fillFailedPeriods[periodKey]) {
        const ff = fillFailedPeriods[periodKey];
        if (ff.count >= 3) {
            const elapsed = Date.now() - ff.lastAttempt;
            if (elapsed < 30000) {
                return { ok: false, reason: `3 fill failures this period — brief cooldown ${Math.round((30000 - elapsed) / 1000)}s` };
            }
            // Reset after 30s cooldown so it can try again
            ff.count = 0;
        }
    }
    return { ok: true };
}

function markFillFailed(periodKey) {
    if (!fillFailedPeriods[periodKey]) {
        fillFailedPeriods[periodKey] = { count: 0, lastAttempt: 0 };
    }
    fillFailedPeriods[periodKey].count++;
    fillFailedPeriods[periodKey].lastAttempt = Date.now();
    console.log(`[trade-executor] Fill failed for period ${periodKey} (attempt ${fillFailedPeriods[periodKey].count}/3)`);
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
async function getAggressivePrice(ticker, side, theoreticalPrice, minutesRemaining) {
    // Guard against NaN/undefined — fall back to 50c (fair value)
    if (theoreticalPrice === undefined || theoreticalPrice === null || isNaN(theoreticalPrice) || !isFinite(theoreticalPrice)) {
        console.warn(`[trade-executor] getAggressivePrice received invalid theoreticalPrice: ${theoreticalPrice} — defaulting to 50c`);
        theoreticalPrice = 50;
    }
    theoreticalPrice = Math.max(5, Math.min(95, Math.round(theoreticalPrice)));

    if (config.paperMode) return theoreticalPrice;

    // Determine max slippage based on time remaining
    const maxSlippage = (minutesRemaining || 15) <= 4 ? 5
                      : (minutesRemaining || 15) <= 10 ? 3
                      : 1; // early period: post near fair value

    const maxPrice = Math.min(95, theoreticalPrice + maxSlippage);

    // Try to get the best price from the orderbook
    try {
        const resp = await trading.getOrderbook(ticker);
        const book = resp.orderbook_fp || resp.orderbook || resp;

        // Kalshi only shows BIDS. To find the ask for our side:
        // - If we're buying YES: the ask comes from NO bids (ask = 100 - NO bid price)
        // - If we're buying NO: the ask comes from YES bids (ask = 100 - YES bid price)
        const yesBids = book.yes_dollars || book.yes || [];
        const noBids = book.no_dollars || book.no || [];
        const oppositeBids = side === 'yes' ? noBids : yesBids;

        // ── DB: snapshot the full Kalshi orderbook ──
        captureKalshiOrderbook(ticker, 'trade_entry', minutesRemaining, yesBids, noBids);

        if (oppositeBids.length > 0) {
            const askPrices = oppositeBids.map(entry => {
                const bidDollars = parseFloat(entry[0]);
                return Math.round((1.00 - bidDollars) * 100);
            });
            const bestAsk = Math.min(...askPrices);

            // NEVER pay more than theoretical + maxSlippage
            if (bestAsk > maxPrice) {
                console.log(`[trade-executor] Orderbook: best ${side} ask = ${bestAsk}c > max ${maxPrice}c (theory=${theoreticalPrice}c) — posting at fair value`);
                return Math.max(5, Math.min(95, theoreticalPrice));
            }

            const price = Math.min(maxPrice, bestAsk);
            console.log(`[trade-executor] Orderbook: best ${side} ask = ${bestAsk}c — buying at ${price}c (theory=${theoreticalPrice}c, max=${maxPrice}c)`);
            return Math.max(5, price);
        }
        console.log(`[trade-executor] Orderbook: no opposing bids — posting at fair value ${theoreticalPrice}c`);
    } catch (e) {
        console.log(`[trade-executor] Orderbook fetch failed: ${e.message} — posting at fair value`);
    }

    // No orderbook data: post at fair value + small slippage, NOT theory+10
    const price = Math.min(maxPrice, theoreticalPrice + 2);
    console.log(`[trade-executor] Using limit price: ${price}c (theory=${theoreticalPrice}c)`);
    return Math.max(5, price);
}

/**
 * Cap contracts to what we can actually afford.
 * Returns 0 if we can't afford even 1 contract.
 */
async function capContractsByBalance(contracts, pricePerContract) {
    if (config.paperMode) return contracts;
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
    // Conviction scaling: high-conviction bets get a higher position cap
    const isHighConviction = betQuality.betSize > 1.0;
    const positionCap = isHighConviction ? config.convictionMaxContracts : config.maxPositionContracts;
    const contracts = Math.max(1, Math.min(
        positionCap,
        Math.round(betQuality.betSize * config.baseContracts)
    ));
    const convictionLabel = betQuality.convictionTier ? ` [${betQuality.convictionTier}]` : '';
    setThought('buying', `Placing ${isUp ? 'UP' : 'DOWN'} bet: ${contracts}x ${side.toUpperCase()}${convictionLabel}`, {
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
    const theoreticalPrice = Math.round(probForBet * 100);
    const limitPrice = await getAggressivePrice(kalshiTicker, side, theoreticalPrice, 15); // new prediction = ~15 min remaining

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
        setThought('bought', `Bought ${contracts}x ${side.toUpperCase()} @ ${limitPrice}c (paper)`, { edge: betQuality.edge, quality: betQuality.quality });
        console.log(`[trade-executor] PAPER BUY: ${contracts}x ${side.toUpperCase()} on ${kalshiTicker} @ ${limitPrice}c | Edge=${tradeInfo.edge} Quality=${tradeInfo.quality}`);
        currentPosition = {
            ticker: kalshiTicker,
            side,
            contracts,
            entryPrice: limitPrice,
            orderId: 'paper-' + Date.now(),
            periodKey,
            entryTime: Date.now(),
        };
        logTrade('buy', tradeInfo);
        decisionLog.logTradeExecution({ ...tradeInfo, strategy: 'initial', currentPrice: prediction.predictedPrice, strike, probability: (probForBet * 100).toFixed(1) + '%' });
        dailyStats.tradeCount++;
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
        };
        logTrade('buy', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status, filledContracts, requestedContracts: cappedContracts });
        dailyStats.tradeCount++;
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
    if (!currentPosition || !sellSignal) return;

    // ── BINARY OPTIONS: ALMOST NEVER SELL ──
    // Binary options settle at exactly 100¢ or 0¢. Selling early means:
    // - If winning: you get less than the 100¢ settlement payout
    // - If losing: you pay the spread twice (sell + potential re-entry) for minimal salvage
    // The ONLY mathematically justified sell is when recovery is essentially impossible:
    // wrong side, >2.5 sigma away, <1.5 min remaining (recovery prob <1.2%)
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

        // On wrong side: only sell if mathematically dead
        const remainingVol = (updatedPrediction && updatedPrediction._remainingVol) || 0.002;
        const distancePct = Math.abs(currentPrice - strike) / strike;
        const sigmaDistance = distancePct / remainingVol;

        // Recovery probability at various sigma distances:
        // 2.0σ → ~4.6% (position worth ~5¢, not worth selling after spread)
        // 2.5σ → ~1.2% (position worth ~1¢, sell to free margin)
        // 3.0σ → ~0.3% (dead, sell at any price)
        const isMathematicallyDead = (sigmaDistance >= 2.5 && minutesRemaining < 1.5) || sigmaDistance >= 3.0;
        if (!isMathematicallyDead) {
            // Hold — recovery is still plausible or spread eats any salvage value
            setThought('losing', `Wrong side (${sigmaDistance.toFixed(1)}σ) — holding, recovery possible`, {
                sigmaDistance: sigmaDistance.toFixed(1), minutesRemaining, recoveryProb: sigmaDistance < 2 ? '~5%' : '~1%',
            });
            return;
        }
        setThought('selling', `Mathematically dead (${sigmaDistance.toFixed(1)}σ, ${minutesRemaining.toFixed(1)}m left) — selling`);
    }

    // Only lost_cause sells reach this point (wrong side, >2.5σ, <1.5 min)
    const shouldSell = (sellSignal.level === 'lost_cause');

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
        console.log(`[trade-executor] PAPER SELL: ${currentPosition.contracts}x ${currentPosition.side.toUpperCase()} on ${currentPosition.ticker} — reason: ${sellSignal.level}`);
        logTrade('sell', tradeInfo);
        decisionLog.logSellDecision({ sellSignal, minutesRemaining, acted: true, reason: sellSignal.level, currentPrice, strike });
        dailyStats.tradeCount++;
        // Record for potential re-entry
        soldThisPeriod = {
            periodKey: currentPosition.periodKey,
            side: currentPosition.side,
            ticker: currentPosition.ticker,
            soldAt: Date.now(),
            reason: sellSignal.level,
        };
        currentPosition = null;
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

        // Fully sold
        logTrade('sell', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status, filledContracts });
        dailyStats.tradeCount++;
        soldThisPeriod = {
            periodKey: currentPosition.periodKey,
            side: currentPosition.side,
            ticker: currentPosition.ticker,
            soldAt: Date.now(),
            reason: sellSignal.level,
        };
        currentPosition = null;

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
    let pnl;
    if (positionWon) {
        pnl = (contracts * 100) - totalCost; // total payout minus total cost
        dailyStats.wins++;
    } else {
        pnl = -totalCost; // lose everything paid
        dailyStats.losses++;
    }
    dailyStats.pnlCents += pnl;

    logTrade('settle', {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts,
        entryPrice: avgEntryPrice,
        correct: positionWon,
        predictionCorrect,
        pnlCents: pnl,
        dailyPnlCents: dailyStats.pnlCents,
        periodKey: currentPosition.periodKey,
    });

    setThought('settled', `${positionWon ? 'WON' : 'LOST'}: ${pnl > 0 ? '+' : ''}$${(pnl / 100).toFixed(2)}`, { pnlCents: pnl, positionWon });
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

    currentPosition = null;
    soldThisPeriod = null; // reset for new period
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
    const dipCap = probForBet >= 0.75 ? config.convictionMaxContracts : config.maxPositionContracts;
    const maxAdd = dipCap - currentContracts;
    if (maxAdd <= 0) return; // already at max

    // Scale add size: bigger dip = add more, but cap at half the original position
    const dipScale = Math.min(1.0, entryImprovement / 20); // 20¢ dip = full scale
    const addContracts = Math.max(1, Math.min(maxAdd, Math.round(dipScale * bq.betSize * config.baseContracts)));

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
        console.log(`[trade-executor] PAPER DIP-BUY: +${addContracts}x ${currentPosition.side.toUpperCase()} @ ${currentLimitPrice}c (${entryImprovement}c cheaper) | Prob=${(probForBet*100).toFixed(0)}%`);
        // Update position with averaged entry
        const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const addCost = addContracts * currentLimitPrice;
        const newTotal = currentContracts + addContracts;
        currentPosition.totalCostCents = oldCost + addCost;
        currentPosition.totalContracts = newTotal;
        currentPosition.contracts = newTotal;
        currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal); // weighted avg
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
            return;
        }
        // ── FILL VERIFICATION ──
        if (order.status === 'resting' || order.status === 'open') {
            order = await waitForFill(order.order_id, order);
        }
        const fills = parseOrderFills(order);
        if (fills.filled === 0) {
            logTrade('dip_buy_unfilled', { ...tradeInfo, orderId: order.order_id });
            return;
        }
        let filledContracts = await verifyFillIsReal(order.order_id, kalshiTicker, currentPosition.side, fills.filled, balanceBefore);
        if (filledContracts === 0) {
            logTrade('dip_buy_phantom', { ...tradeInfo, orderId: order.order_id, claimedFills: fills.filled });
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
    // Allow late lock in final 3 minutes (was 2)
    if (minutesRemaining > 3.0) return;
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

    // Calculate the entry price (high, since it's nearly guaranteed)
    // At 2.5σ, prob ≈ 0.994, so price ≈ 99¢ for winning side
    // We cap at 95¢ to ensure at least 5¢ profit per contract
    const winProb = Math.min(0.99, 0.5 + 0.5 * erf(sigmaDistance / Math.SQRT2));
    const limitPrice = Math.min(95, Math.max(85, Math.round(winProb * 100)));
    const profitPerContract = 100 - limitPrice;

    // Skip if profit margin is too thin (< 3¢ per contract after fees)
    if (profitPerContract < 5) return;

    // If we already have a position on this side, add to it up to max
    if (currentPosition && currentPosition.periodKey === periodKey) {
        if (currentPosition.side === lockSide) {
            // Already on the right side — add up to max
            const currentContracts = currentPosition.totalContracts || currentPosition.contracts;
            const addContracts = config.convictionMaxContracts - currentContracts; // late-lock = high conviction
            if (addContracts <= 0) return; // already maxed out
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

    const contracts = config.convictionMaxContracts; // late-lock = high conviction, go big
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
        console.log(`[trade-executor] PAPER ${strategy.toUpperCase()}: ${contracts}x ${side.toUpperCase()} @ ${limitPrice}c | ${sigmaDistance.toFixed(1)}σ away | Expected +$${((contracts * profitPerContract) / 100).toFixed(2)}`);
        if (currentPosition && currentPosition.periodKey === periodKey) {
            // Adding to existing position
            const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const addCost = contracts * limitPrice;
            const newTotal = (currentPosition.totalContracts || currentPosition.contracts) + contracts;
            currentPosition.totalCostCents = oldCost + addCost;
            currentPosition.totalContracts = newTotal;
            currentPosition.contracts = newTotal;
            currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal);
        } else {
            currentPosition = {
                ticker, side, contracts,
                entryPrice: limitPrice,
                orderId: 'paper-lock-' + Date.now(),
                periodKey,
                entryTime: Date.now(),
                totalCostCents: contracts * limitPrice,
                totalContracts: contracts,
            };
        }
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
            return;
        }
        // ── FILL VERIFICATION ──
        if (order.status === 'resting' || order.status === 'open') {
            order = await waitForFill(order.order_id, order);
        }
        const fills = parseOrderFills(order);
        if (fills.filled === 0) {
            logTrade(strategy + '_unfilled', { ...tradeInfo, orderId: order.order_id });
            return;
        }
        let filledContracts = await verifyFillIsReal(order.order_id, ticker, side, fills.filled, balanceBefore);
        if (filledContracts === 0) {
            logTrade(strategy + '_phantom', { ...tradeInfo, orderId: order.order_id, claimedFills: fills.filled });
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
    const reEntryCap = bq.betSize > 1.0 ? config.convictionMaxContracts : config.maxPositionContracts;
    const contracts = Math.max(1, Math.min(
        reEntryCap,
        Math.round(bq.betSize * config.baseContracts * 0.85)
    ));
    const limitPrice = Math.max(5, Math.min(95, Math.round(probForBet * 100)));

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
        console.log(`[trade-executor] PAPER RE-ENTRY: ${contracts}x ${origSide.toUpperCase()} @ ${limitPrice}c | Prob=${(probForBet*100).toFixed(0)}% | After sell: ${soldThisPeriod.reason}`);
        currentPosition = {
            ticker: kalshiTicker,
            side: origSide,
            contracts,
            entryPrice: limitPrice,
            orderId: 'paper-reentry-' + Date.now(),
            periodKey,
            entryTime: Date.now(),
            totalCostCents: contracts * limitPrice,
            totalContracts: contracts,
        };
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
        // Try to sell the current position immediately
        trading.placeOrder({
            ticker: currentPosition.ticker,
            side: currentPosition.side,
            action: 'sell',
            count: currentPosition.contracts,
            yesPrice: currentPosition.side === 'yes' ? 1 : undefined,
            noPrice: currentPosition.side === 'no' ? 1 : undefined,
            timeInForce: 'fill_or_kill',
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

function resetState() {
    currentPosition = null;
    dailyStats.date = new Date().toISOString().slice(0, 10);
    dailyStats.pnlCents = 0;
    dailyStats.tradeCount = 0;
    dailyStats.wins = 0;
    dailyStats.losses = 0;
    tradeLog.length = 0;
    killSwitch = true;
    console.log('[trade-executor] State reset — kill switch activated');
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
        cachedBalance = { balanceCents: resp.balance, lastFetched: Date.now() };
    } catch (e) {
        // Silently fail — will retry next cycle
    }
}

let lastPositionSync = 0;
const POSITION_SYNC_MS = 15000; // sync with Kalshi every 15s

async function syncPositionWithKalshi() {
    if (config.paperMode) return;
    if (!currentPosition || !currentPosition.ticker) return;
    if (Date.now() - lastPositionSync < POSITION_SYNC_MS) return;
    lastPositionSync = Date.now();

    try {
        const resp = await trading.getPositions();
        const positions = resp.market_positions || resp.positions || [];
        const match = positions.find(p => p.ticker === currentPosition.ticker);

        if (match) {
            // Kalshi reports position quantity and average cost
            const kalshiContracts = match.position || match.total_traded || 0;
            const kalshiCostCents = match.market_exposure ? Math.round(match.market_exposure * 100) : null;

            if (kalshiContracts > 0) {
                const oldTotal = currentPosition.totalContracts || currentPosition.contracts;
                if (kalshiContracts !== oldTotal) {
                    console.log(`[trade-executor] Position sync: app=${oldTotal} Kalshi=${kalshiContracts} contracts — updating`);
                    currentPosition.totalContracts = kalshiContracts;
                }
                if (kalshiCostCents && kalshiCostCents !== currentPosition.totalCostCents) {
                    console.log(`[trade-executor] Position sync: app cost=${currentPosition.totalCostCents}c Kalshi cost=${kalshiCostCents}c — updating`);
                    currentPosition.totalCostCents = kalshiCostCents;
                }
            } else {
                // Kalshi shows 0 contracts — position was settled/expired
                console.log(`[trade-executor] Position sync: Kalshi reports 0 contracts for ${currentPosition.ticker} — clearing stale position`);
                currentPosition = null;
            }
        } else {
            // No matching position found on Kalshi — contract likely expired/settled
            console.log(`[trade-executor] Position sync: no position found on Kalshi for ${currentPosition.ticker} — clearing stale position`);
            currentPosition = null;
        }
    } catch (e) {
        // 404 means the market/contract expired — clear the stale position
        if (e.status === 404) {
            console.log(`[trade-executor] Position sync: 404 for ${currentPosition?.ticker} — market expired, clearing position`);
            currentPosition = null;
        }
        // Other errors: silently fail — will retry next cycle
    }
}

function getStatus() {
    checkDayRollover().catch(e => console.error('[db] Day rollover error:', e.message));
    // Trigger async balance refresh + position sync (non-blocking)
    refreshBalance();
    syncPositionWithKalshi();
    return {
        paperMode: config.paperMode,
        killSwitch,
        configured: trading.isConfigured(),
        balanceCents: cachedBalance ? cachedBalance.balanceCents : null,
        currentPosition: currentPosition ? (() => {
            const totalCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const totalContracts = currentPosition.totalContracts || currentPosition.contracts;
            return {
                ticker: currentPosition.ticker,
                side: currentPosition.side,
                contracts: currentPosition.contracts,
                entryPrice: Math.round(totalCost / totalContracts), // weighted average, not first entry
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
    const contractsToAdd = addContracts || Math.max(1, config.baseContracts);

    console.log(`[trade-executor] PRESS BET: adding ${contractsToAdd}x ${side.toUpperCase()} to existing ${currentContracts}x on ${ticker}`);

    const tradeInfo = {
        ticker, side, action: 'buy', contracts: contractsToAdd, periodKey,
        direction: side === 'yes' ? 'UP' : 'DOWN',
        strategy: 'press_bet', existingContracts: currentContracts,
    };

    if (config.paperMode) {
        const limitPrice = currentPosition.entryPrice; // use same entry price
        const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const addCost = contractsToAdd * limitPrice;
        const newTotal = currentContracts + contractsToAdd;
        currentPosition.totalCostCents = oldCost + addCost;
        currentPosition.totalContracts = newTotal;
        setThought('bought', `Pressed +${contractsToAdd}x ${side.toUpperCase()} @ ${limitPrice}c (now ${newTotal}x)`, { contracts: newTotal });
        logTrade('buy', { ...tradeInfo, limitPrice, fillStatus: 'paper-press', filledContracts: contractsToAdd });
        dailyStats.tradeCount++;
        return { ok: true, side, contracts: contractsToAdd, entryPrice: limitPrice, totalContracts: newTotal, mode: 'paper' };
    }

    // Live: get price from orderbook and retry like forceBet
    const theoreticalPrice = currentPosition.entryPrice; // start from current entry
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
        // Bump theoretical input, not the result — getAggressivePrice caps at orderbook ask
        const limitPrice = await getAggressivePrice(ticker, side, theoreticalPrice + priceEscalation, minutesRemaining);
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

    // Don't double-enter same period
    if (currentPosition && currentPosition.periodKey === periodKey) {
        return { ok: false, reason: 'Already have a position for this period' };
    }

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
    const contracts = overrideContracts || Math.max(1, config.baseContracts);

    console.log(`[trade-executor] FORCE BET: ${contracts}x ${side.toUpperCase()} (${direction}) on ${kalshiTicker} @ ~${theoreticalPrice}c`);

    const tradeInfo = {
        ticker: kalshiTicker, side, action: 'buy', contracts, periodKey,
        direction, edge: 'FORCED', quality: 'FORCED', betSize: '1.00',
        strategy: 'force_bet',
    };

    if (config.paperMode) {
        const limitPrice = Math.max(5, Math.min(95, theoreticalPrice));
        currentPosition = {
            ticker: kalshiTicker, side, contracts, entryPrice: limitPrice,
            orderId: 'force-paper-' + Date.now(), periodKey, entryTime: Date.now(),
            totalCostCents: contracts * limitPrice, totalContracts: contracts,
        };
        logTrade('buy', { ...tradeInfo, limitPrice, fillStatus: 'paper-forced' });
        dailyStats.tradeCount++;
        return { ok: true, side, direction, contracts, entryPrice: limitPrice, mode: 'paper' };
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
        // Bump theoretical input, not the result — getAggressivePrice caps at orderbook ask
        const limitPrice = await getAggressivePrice(kalshiTicker, side, theoreticalPrice + priceEscalation, minutesRemaining);
        const cappedContracts = await capContractsByBalance(contracts, limitPrice);
        if (cappedContracts <= 0) {
            return { ok: false, reason: 'Insufficient balance for force bet' };
        }

        console.log(`[trade-executor] FORCE BET attempt ${attempt}/${MAX_FORCE_ATTEMPTS}: ${cappedContracts}x ${side.toUpperCase()} @ ${limitPrice}c`);

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

            currentPosition = {
                ticker: kalshiTicker, side, contracts: filledContracts, entryPrice: limitPrice,
                orderId: order.order_id, periodKey, entryTime: Date.now(),
                totalCostCents: filledContracts * limitPrice, totalContracts: filledContracts,
            };
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
        console.log(`[trade-executor] PAPER FORCE SELL: ${contracts}x ${side.toUpperCase()} @ ~${sellPrice}c`);
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
        currentPosition = savedPos;
        console.log(`[trade-executor] Restored position from DB: ${savedPos.contracts}x ${savedPos.side} @ ${savedPos.ticker}`);
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
    resetState,
    getStatus,
    onTradeNotify,
    forceBet,
    pressBet,
    forceSell,
    config, // exposed for startup logging
};
