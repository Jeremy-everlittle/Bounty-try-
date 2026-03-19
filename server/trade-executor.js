'use strict';

// ═══════════════════════════════════════════════════════════════
// Trade Executor — Bridges prediction signals to Kalshi orders
// ═══════════════════════════════════════════════════════════════
// Reads signals from: assessBetQuality(), assessSellSignal()
// Executes via: kalshi-trading.js
// Safety: paper mode, daily loss limit, position cap, kill switch
// ═══════════════════════════════════════════════════════════════

const trading = require('./kalshi-trading');

// ── Configuration (from env, with safe defaults) ──
const config = {
    paperMode: (process.env.PAPER_MODE || 'true').toLowerCase() === 'true',
    baseContracts: parseInt(process.env.BASE_CONTRACTS || '10', 10),           // was 5
    maxPositionContracts: parseInt(process.env.MAX_POSITION_CONTRACTS || '20', 10), // was 10
    maxDailyLossCents: parseInt(process.env.MAX_DAILY_LOSS || '2500', 10),    // $25 (was $10)
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '100', 10),      // was 50
};

// ── State ──
let currentPosition = null;   // { ticker, side, action, contracts, entryPrice, orderId, periodKey, totalCostCents, totalContracts }
let killSwitch = false;
let soldThisPeriod = null;    // Track sold positions for re-entry: { periodKey, side, ticker, soldAt, reason }
let lastDipCheckTime = 0;     // Throttle dip checks (one per 10s tick)
let cachedBalance = null;     // { balanceCents, lastFetched }
const BALANCE_CACHE_MS = 30000; // refresh balance every 30s

const dailyStats = {
    date: new Date().toISOString().slice(0, 10),
    pnlCents: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
};

const tradeLog = [];           // recent trades for dashboard (max 100)
const MAX_TRADE_LOG = 100;

// ═══════════════════════════════════════════════════════════════
// Daily reset
// ═══════════════════════════════════════════════════════════════

function checkDayRollover() {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyStats.date !== today) {
        dailyStats.date = today;
        dailyStats.pnlCents = 0;
        dailyStats.tradeCount = 0;
        dailyStats.wins = 0;
        dailyStats.losses = 0;
    }
}

// ═══════════════════════════════════════════════════════════════
// Safety checks
// ═══════════════════════════════════════════════════════════════

function canTrade() {
    checkDayRollover();

    if (killSwitch) return { ok: false, reason: 'Kill switch active' };
    if (!trading.isConfigured() && !config.paperMode) {
        return { ok: false, reason: 'Kalshi API not configured (set KALSHI_API_KEY + KALSHI_PRIVATE_KEY)' };
    }
    if (dailyStats.pnlCents <= -config.maxDailyLossCents) {
        return { ok: false, reason: `Daily loss limit reached ($${(Math.abs(dailyStats.pnlCents) / 100).toFixed(2)})` };
    }
    if (dailyStats.tradeCount >= config.maxDailyTrades) {
        return { ok: false, reason: `Daily trade limit reached (${dailyStats.tradeCount})` };
    }
    return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// Entry: called when a new prediction is made
// ═══════════════════════════════════════════════════════════════

async function onNewPrediction(prediction, kalshiTicker, strike, periodKey) {
    if (!prediction || !kalshiTicker || strike === null) return;

    const betQuality = prediction._betQuality;
    if (!betQuality || !betQuality.shouldBet || betQuality.betSize <= 0) return;

    // Don't enter if we already have a position for this period
    if (currentPosition && currentPosition.periodKey === periodKey) return;

    // Close stale position from a previous period — settle it instead of silently discarding
    if (currentPosition && currentPosition.periodKey !== periodKey) {
        console.log(`[trade-executor] Stale position from ${currentPosition.periodKey} — auto-settling before new entry`);
        // We don't know the actual result, but the position should have been settled by onPeriodEnd.
        // If it wasn't (race condition), settle as unknown/loss to be conservative.
        const staleContracts = currentPosition.contracts;
        const staleEntry = currentPosition.entryPrice;
        if (staleContracts > 0 && staleEntry > 0) {
            const pnl = -staleContracts * staleEntry; // assume loss (worst case)
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
                note: 'auto-settled stale position (missed onPeriodEnd)',
            });
        }
        currentPosition = null;
    }

    const check = canTrade();
    if (!check.ok) {
        console.log(`[trade-executor] Skipping entry: ${check.reason}`);
        return;
    }

    const isUp = prediction.predictedPrice >= strike;
    const side = isUp ? 'yes' : 'no';
    const contracts = Math.max(1, Math.min(
        config.maxPositionContracts,
        Math.round(betQuality.betSize * config.baseContracts)
    ));

    // Determine limit price from probability
    // If we predict UP (buy YES), we're willing to pay up to our probability in cents
    // e.g. probability=0.65 → willing to pay 65c for YES contract
    const probForBet = isUp ? prediction.probability : (1 - prediction.probability);
    const limitPrice = Math.max(5, Math.min(95, Math.round(probForBet * 100)));

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
        dailyStats.tradeCount++;
        return;
    }

    // ── LIVE ORDER ──
    try {
        // Check balance first
        const balanceResp = await trading.getBalance();
        const availableCents = balanceResp.balance;
        const costEstimate = contracts * limitPrice; // max cost in cents
        if (costEstimate > availableCents) {
            console.log(`[trade-executor] Insufficient balance: need ${costEstimate}c, have ${availableCents}c`);
            return;
        }

        // Use GTC (good-til-canceled) so the order rests on the book if not
        // immediately matched.  FOK/IOC fail with 409 on demo when there is
        // no opposing liquidity.
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side,
            action: 'buy',
            count: contracts,
            yesPrice: side === 'yes' ? limitPrice : undefined,
            noPrice: side === 'no' ? limitPrice : undefined,
        });

        const order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            console.log(`[trade-executor] Order not filled: ${order.status} — ${order.cancel_reason || 'unknown'}`);
            logTrade('buy_failed', { ...tradeInfo, reason: order.status });
            return;
        }

        currentPosition = {
            ticker: kalshiTicker,
            side,
            contracts: order.count || contracts,
            entryPrice: limitPrice,
            orderId: order.order_id,
            periodKey,
            entryTime: Date.now(),
        };
        logTrade('buy', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status });
        dailyStats.tradeCount++;
        console.log(`[trade-executor] LIVE BUY: ${contracts}x ${side.toUpperCase()} on ${kalshiTicker} — order ${order.order_id}`);

    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response) : '';
        console.error(`[trade-executor] Order failed:`, err.message, detail ? `| Response: ${detail}` : '');
        logTrade('buy_error', { ...tradeInfo, error: err.message, response: err.response });

        // On 409 (conflict/insufficient funds), don't retry this period
        if (err.status === 409) {
            currentPosition = { ticker: kalshiTicker, side, contracts: 0, entryPrice: 0, orderId: 'blocked-409', periodKey, entryTime: Date.now() };
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Exit: called every 10s when sell signal updates
// ═══════════════════════════════════════════════════════════════

async function onSellSignal(sellSignal, minutesRemaining, updatedPrediction, strike, currentPrice) {
    if (!currentPosition || !sellSignal) return;

    // ── GUARANTEED WIN PROTECTION ──
    // If we're solidly winning with little time left, DON'T sell — ride it to settlement
    // for the full payout. Selling early means we get less than 100¢ per contract.
    if (strike && currentPrice) {
        const betIsUp = currentPosition.side === 'yes';
        const onRightSide = (betIsUp && currentPrice >= strike) || (!betIsUp && currentPrice < strike);
        const remainingVol = (updatedPrediction && updatedPrediction._remainingVol) || 0.002;
        const distancePct = Math.abs(currentPrice - strike) / strike;
        const sigmaDistance = distancePct / remainingVol;

        // If we're winning AND price is 1.5+ sigma on our side, hold for settlement
        if (onRightSide && sigmaDistance >= 1.5 && minutesRemaining < 3) {
            // Don't sell a guaranteed winner — let it settle for full 100¢ payout
            if (sellSignal.level === 'take_profit') {
                console.log(`[trade-executor] Holding guaranteed winner: ${sigmaDistance.toFixed(1)}σ on right side with ${minutesRemaining.toFixed(1)}m left`);
                return;
            }
        }
    }

    const shouldSell = (
        sellSignal.level === 'lost_cause' ||
        (sellSignal.level === 'sell_now' && minutesRemaining < 1.5) ||            // was unconditional
        (sellSignal.level === 'take_profit' && minutesRemaining < 1) ||           // was 2 min
        (sellSignal.level === 'consider_selling' && minutesRemaining < 0.75)      // was 1.5 min
    );

    if (!shouldSell) return;

    const tradeInfo = {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts: currentPosition.contracts,
        action: 'sell',
        reason: sellSignal.level,
        urgency: sellSignal.urgency,
        minutesRemaining: minutesRemaining.toFixed(1),
    };

    if (config.paperMode) {
        console.log(`[trade-executor] PAPER SELL: ${currentPosition.contracts}x ${currentPosition.side.toUpperCase()} on ${currentPosition.ticker} — reason: ${sellSignal.level}`);
        logTrade('sell', tradeInfo);
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

        const order = result.order || {};
        console.log(`[trade-executor] LIVE SELL: order ${order.order_id} status=${order.status}`);
        logTrade('sell', { ...tradeInfo, orderId: order.order_id, fillStatus: order.status });
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

    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response) : '';
        console.error(`[trade-executor] Sell failed:`, err.message, detail ? `| Response: ${detail}` : '');
        logTrade('sell_error', { ...tradeInfo, error: err.message, response: err.response });
        // Don't clear position — will retry next cycle or auto-settle
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
    const wasCorrect = gradeResult && gradeResult.correct;
    const contracts = currentPosition.contracts;
    const entryPrice = currentPosition.entryPrice;

    // P&L: if correct, payout is 100c per contract - entry. If wrong, lose entry.
    let pnl;
    if (wasCorrect) {
        pnl = contracts * (100 - entryPrice); // profit per contract
        dailyStats.wins++;
    } else {
        pnl = -contracts * entryPrice; // loss per contract
        dailyStats.losses++;
    }
    dailyStats.pnlCents += pnl;

    logTrade('settle', {
        ticker: currentPosition.ticker,
        side: currentPosition.side,
        contracts,
        entryPrice,
        correct: wasCorrect,
        pnlCents: pnl,
        dailyPnlCents: dailyStats.pnlCents,
    });

    console.log(`[trade-executor] Period settled: ${wasCorrect ? 'WIN' : 'LOSS'} | P&L: ${pnl > 0 ? '+' : ''}${(pnl / 100).toFixed(2)} | Daily: ${dailyStats.pnlCents > 0 ? '+' : ''}$${(dailyStats.pnlCents / 100).toFixed(2)}`);

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
    const maxAdd = config.maxPositionContracts - currentContracts;
    if (maxAdd <= 0) return; // already at max

    // Scale add size: bigger dip = add more, but cap at half the original position
    const dipScale = Math.min(1.0, entryImprovement / 20); // 20¢ dip = full scale
    const addContracts = Math.max(1, Math.min(maxAdd, Math.round(dipScale * bq.betSize * config.baseContracts)));

    const check = canTrade();
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
        dailyStats.tradeCount++;
        return;
    }

    // LIVE ORDER
    try {
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side: currentPosition.side,
            action: 'buy',
            count: addContracts,
            yesPrice: currentPosition.side === 'yes' ? currentLimitPrice : undefined,
            noPrice: currentPosition.side === 'no' ? currentLimitPrice : undefined,
        });
        const order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            logTrade('dip_buy_failed', { ...tradeInfo, reason: order.status });
            return;
        }
        const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
        const addCost = addContracts * currentLimitPrice;
        const newTotal = currentContracts + addContracts;
        currentPosition.totalCostCents = oldCost + addCost;
        currentPosition.totalContracts = newTotal;
        currentPosition.contracts = newTotal;
        currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal);
        logTrade('dip_buy', { ...tradeInfo, orderId: order.order_id });
        dailyStats.tradeCount++;
        console.log(`[trade-executor] LIVE DIP-BUY: +${addContracts}x @ ${currentLimitPrice}c — order ${order.order_id}`);
    } catch (err) {
        logTrade('dip_buy_error', { ...tradeInfo, error: err.message });
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
            const addContracts = config.maxPositionContracts - currentContracts;
            if (addContracts <= 0) return; // already maxed out
            return await executeLockEntry(lockSide, addContracts, limitPrice, kalshiTicker, periodKey, sigmaDistance, profitPerContract, 'late_lock_add');
        } else {
            // On the wrong side?! This shouldn't happen if sell signals work, but don't fight it
            return;
        }
    }

    // No position — enter fresh with max contracts
    if (currentPosition) return; // different period position (shouldn't happen)

    const check = canTrade();
    if (!check.ok) return;

    const contracts = config.maxPositionContracts;
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
        dailyStats.tradeCount++;
        return;
    }

    // LIVE
    try {
        const result = await trading.placeOrder({
            ticker,
            side,
            action: 'buy',
            count: contracts,
            yesPrice: side === 'yes' ? limitPrice : undefined,
            noPrice: side === 'no' ? limitPrice : undefined,
        });
        const order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            logTrade(strategy + '_failed', { ...tradeInfo, reason: order.status });
            return;
        }
        if (currentPosition && currentPosition.periodKey === periodKey) {
            const oldCost = currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice);
            const addCost = contracts * limitPrice;
            const newTotal = (currentPosition.totalContracts || currentPosition.contracts) + contracts;
            currentPosition.totalCostCents = oldCost + addCost;
            currentPosition.totalContracts = newTotal;
            currentPosition.contracts = newTotal;
            currentPosition.entryPrice = Math.round((oldCost + addCost) / newTotal);
        } else {
            currentPosition = {
                ticker, side, contracts: order.count || contracts,
                entryPrice: limitPrice,
                orderId: order.order_id,
                periodKey,
                entryTime: Date.now(),
                totalCostCents: contracts * limitPrice,
                totalContracts: contracts,
            };
        }
        logTrade(strategy, { ...tradeInfo, orderId: order.order_id });
        dailyStats.tradeCount++;
        console.log(`[trade-executor] LIVE ${strategy.toUpperCase()}: ${contracts}x ${side.toUpperCase()} @ ${limitPrice}c — order ${order.order_id}`);
    } catch (err) {
        logTrade(strategy + '_error', { ...tradeInfo, error: err.message });
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

    const check = canTrade();
    if (!check.ok) return;

    // Re-enter at near-full size (was 60%, now 85%)
    const contracts = Math.max(1, Math.min(
        config.maxPositionContracts,
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
        dailyStats.tradeCount++;
        soldThisPeriod = null; // consumed
        return;
    }

    // LIVE
    try {
        const result = await trading.placeOrder({
            ticker: kalshiTicker,
            side: origSide,
            action: 'buy',
            count: contracts,
            yesPrice: origSide === 'yes' ? limitPrice : undefined,
            noPrice: origSide === 'no' ? limitPrice : undefined,
        });
        const order = result.order || {};
        if (order.status === 'canceled' || order.status === 'rejected') {
            logTrade('re_entry_failed', { ...tradeInfo, reason: order.status });
            return;
        }
        currentPosition = {
            ticker: kalshiTicker,
            side: origSide,
            contracts: order.count || contracts,
            entryPrice: limitPrice,
            orderId: order.order_id,
            periodKey,
            entryTime: Date.now(),
            totalCostCents: contracts * limitPrice,
            totalContracts: contracts,
        };
        logTrade('re_entry', { ...tradeInfo, orderId: order.order_id });
        dailyStats.tradeCount++;
        soldThisPeriod = null;
        console.log(`[trade-executor] LIVE RE-ENTRY: ${contracts}x ${origSide.toUpperCase()} @ ${limitPrice}c — order ${order.order_id}`);
    } catch (err) {
        logTrade('re_entry_error', { ...tradeInfo, error: err.message });
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

function getStatus() {
    checkDayRollover();
    // Trigger async balance refresh (non-blocking)
    refreshBalance();
    return {
        paperMode: config.paperMode,
        killSwitch,
        configured: trading.isConfigured(),
        balanceCents: cachedBalance ? cachedBalance.balanceCents : null,
        currentPosition: currentPosition ? {
            ticker: currentPosition.ticker,
            side: currentPosition.side,
            contracts: currentPosition.contracts,
            entryPrice: currentPosition.entryPrice,
            periodKey: currentPosition.periodKey,
            holdingSeconds: Math.round((Date.now() - currentPosition.entryTime) / 1000),
            totalCostCents: currentPosition.totalCostCents || (currentPosition.contracts * currentPosition.entryPrice),
            totalContracts: currentPosition.totalContracts || currentPosition.contracts,
        } : null,
        soldThisPeriod: soldThisPeriod ? { side: soldThisPeriod.side, reason: soldThisPeriod.reason } : null,
        daily: { ...dailyStats },
        config: {
            baseContracts: config.baseContracts,
            maxPositionContracts: config.maxPositionContracts,
            maxDailyLossCents: config.maxDailyLossCents,
            maxDailyTrades: config.maxDailyTrades,
        },
        recentTrades: tradeLog.slice(0, 50),
    };
}

module.exports = {
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
    config, // exposed for startup logging
};
