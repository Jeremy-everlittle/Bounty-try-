'use strict';

// ═══════════════════════════════════════════════════════════════
// Crumb Sniper — Near-Expiry Guaranteed-Profit Scanner
// ═══════════════════════════════════════════════════════════════
// Continuously scans ALL Kalshi markets for contracts expiring
// within ~60 seconds that have near-guaranteed outcomes with
// available orders. Places small bets to collect "crumbs".
// ═══════════════════════════════════════════════════════════════

const kalshi = require('./kalshi-trading');
const { getBaseUrl } = require('./kalshi-auth');

// ── Configuration ──
const CONFIG = {
    // Scan interval — how often we look for new candidates
    scanIntervalMs: 8000,        // 8 seconds between full scans
    // Time window — only consider markets closing within this window
    maxSecondsToExpiry: 300,     // 5 minutes before close
    minSecondsToExpiry: 5,       // at least 5 seconds left to place order
    // Price thresholds — what counts as "near guaranteed"
    // A YES at 95¢ means 95% implied probability → 5¢ profit if correct
    watchMinPrice: 85,           // watch list: ≥85¢ implied probability (cents)
    betMinPrice: 94,             // auto-bet: ≥94¢ implied probability (cents)
    betMaxPrice: 98,             // don't bet above 98¢ (only 2¢ profit, not worth fees)
    // Sizing
    maxContractsPerBet: 20,      // max contracts per single crumb bet
    maxCostPerBetCents: 2000,    // max $20 per bet
    maxConcurrentBets: 3,        // max simultaneous open crumb bets
    maxDailyLossCents: 5000,     // $50 daily loss limit for crumb sniper
    // Orderbook requirements
    minAvailableContracts: 2,    // need at least 2 contracts available
};

// ── State ──
let isRunning = false;
let scanTimer = null;
let paperMode = true;
let paperBalanceCents = 10000; // $100 paper balance

const watchList = new Map();   // ticker → candidate info (watching)
const bettingList = new Map(); // ticker → bet info (bet placed)
const settledList = [];        // recent settled bets (last 50)
const dailyStats = { date: null, pnlCents: 0, bets: 0, wins: 0, losses: 0 };

// Track tickers we've already bet on to avoid double-betting
const bettedTickers = new Set();

// ── Public API base for market scanning (unauthenticated) ──
const PUBLIC_API = 'https://api.elections.kalshi.com/trade-api/v2';

async function fetchJSON(url) {
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// Core Scanner
// ═══════════════════════════════════════════════════════════════

/**
 * Find all markets closing within our time window
 */
async function scanForCandidates() {
    const now = new Date();
    const minClose = new Date(now.getTime() + CONFIG.minSecondsToExpiry * 1000);
    const maxClose = new Date(now.getTime() + CONFIG.maxSecondsToExpiry * 1000);

    try {
        // Fetch markets closing soon
        // Note: min_close_ts/max_close_ts are NOT compatible with status=open
        // so we omit the status filter and check market status in code
        const data = await fetchJSON(
            PUBLIC_API + '/markets?' + new URLSearchParams({
                min_close_ts: Math.floor(minClose.getTime() / 1000),
                max_close_ts: Math.floor(maxClose.getTime() / 1000),
                limit: '200',
            }).toString()
        );

        if (!data || !data.markets) {
            console.log('[crumb-sniper] Scan returned no markets');
            return [];
        }

        console.log(`[crumb-sniper] Scan found ${data.markets.length} markets closing in ${CONFIG.minSecondsToExpiry}-${CONFIG.maxSecondsToExpiry}s window`);

        const candidates = [];

        for (const market of data.markets) {
            // Skip non-open markets since we can't filter by status with close_ts
            if (market.status !== 'open') continue;

            const closeTime = new Date(market.close_time || market.expiration_time);
            const secsLeft = (closeTime - now) / 1000;

            if (secsLeft < CONFIG.minSecondsToExpiry || secsLeft > CONFIG.maxSecondsToExpiry) continue;
            if (bettedTickers.has(market.ticker)) continue;

            candidates.push({
                ticker: market.ticker,
                title: market.title || market.ticker,
                subtitle: market.yes_sub_title || market.subtitle || '',
                closeTime: closeTime.toISOString(),
                secsLeft: Math.round(secsLeft),
                lastYesPrice: market.yes_ask || market.last_price || null,
                lastNoPrice: market.no_ask || null,
                volume: market.volume || 0,
                seriesTicker: market.series_ticker || '',
                eventTicker: market.event_ticker || '',
            });
        }

        console.log(`[crumb-sniper] ${candidates.length} open candidates found (${data.markets.length - candidates.length} filtered out)`);
        return candidates;
    } catch (err) {
        console.error('[crumb-sniper] Scan error:', err.message);
        return [];
    }
}

/**
 * Check a specific market's orderbook for near-guaranteed opportunities
 */
async function evaluateCandidate(candidate) {
    try {
        // Fetch the orderbook to see real available prices
        const ob = await fetchJSON(
            PUBLIC_API + `/markets/${candidate.ticker}/orderbook`
        );
        if (!ob || !ob.orderbook) return null;

        const orderbook = ob.orderbook;

        // Look for YES side: cheap YES asks (near 95-98¢) → profit = 100 - price
        // Look for NO side: cheap NO asks → same logic inverted
        // We want to find the side where the price implies near-certainty

        const opportunities = [];

        // Check YES asks (we'd BUY YES — profit if outcome is YES)
        if (orderbook.yes && orderbook.yes.length > 0) {
            // yes array contains [price_cents, quantity] pairs, sorted by price ascending
            for (const [priceCents, qty] of orderbook.yes) {
                if (priceCents >= CONFIG.watchMinPrice && priceCents <= CONFIG.betMaxPrice && qty >= CONFIG.minAvailableContracts) {
                    opportunities.push({
                        side: 'yes',
                        priceCents,
                        available: qty,
                        profitPerContract: 100 - priceCents,
                        impliedProb: priceCents / 100,
                    });
                }
            }
        }

        // Check NO asks (we'd BUY NO — profit if outcome is NO)
        if (orderbook.no && orderbook.no.length > 0) {
            for (const [priceCents, qty] of orderbook.no) {
                if (priceCents >= CONFIG.watchMinPrice && priceCents <= CONFIG.betMaxPrice && qty >= CONFIG.minAvailableContracts) {
                    opportunities.push({
                        side: 'no',
                        priceCents,
                        available: qty,
                        profitPerContract: 100 - priceCents,
                        impliedProb: priceCents / 100,
                    });
                }
            }
        }

        if (opportunities.length === 0) return null;

        // Pick the best opportunity (highest implied probability = most likely to pay out)
        opportunities.sort((a, b) => b.impliedProb - a.impliedProb);
        return opportunities[0];
    } catch (err) {
        console.error(`[crumb-sniper] Evaluate error for ${candidate.ticker}:`, err.message);
        return null;
    }
}

/**
 * Place a crumb bet
 */
async function placeCrumbBet(candidate, opportunity) {
    // Check daily loss limit
    resetDailyStatsIfNeeded();
    if (dailyStats.pnlCents < -CONFIG.maxDailyLossCents) {
        console.log(`[crumb-sniper] Daily loss limit hit ($${(-dailyStats.pnlCents / 100).toFixed(2)}), skipping`);
        return null;
    }

    // Check concurrent bet limit
    if (bettingList.size >= CONFIG.maxConcurrentBets) {
        console.log(`[crumb-sniper] Max concurrent bets (${CONFIG.maxConcurrentBets}), skipping`);
        return null;
    }

    // Calculate sizing
    const maxByConfig = CONFIG.maxContractsPerBet;
    const maxByCost = Math.floor(CONFIG.maxCostPerBetCents / opportunity.priceCents);
    const maxByAvailable = opportunity.available;
    const contracts = Math.min(maxByConfig, maxByCost, maxByAvailable);

    if (contracts < 1) return null;

    const costCents = contracts * opportunity.priceCents;
    const potentialProfit = contracts * opportunity.profitPerContract;

    console.log(`[crumb-sniper] 🎯 BETTING: ${contracts}x ${opportunity.side.toUpperCase()} on ${candidate.ticker} @ ${opportunity.priceCents}¢ | Cost=$${(costCents / 100).toFixed(2)} | Potential profit=$${(potentialProfit / 100).toFixed(2)} | ${candidate.secsLeft}s left`);

    const betRecord = {
        ...candidate,
        side: opportunity.side,
        priceCents: opportunity.priceCents,
        contracts,
        costCents,
        potentialProfit,
        profitPerContract: opportunity.profitPerContract,
        impliedProb: opportunity.impliedProb,
        betTime: new Date().toISOString(),
        orderId: null,
        status: 'placing',
    };

    if (paperMode) {
        // Paper mode — simulate the bet
        if (paperBalanceCents < costCents) {
            console.log(`[crumb-sniper] PAPER: Insufficient balance ($${(paperBalanceCents / 100).toFixed(2)} < $${(costCents / 100).toFixed(2)})`);
            return null;
        }
        paperBalanceCents -= costCents;
        betRecord.orderId = 'paper_' + Date.now();
        betRecord.status = 'filled';
        console.log(`[crumb-sniper] PAPER BET: ${contracts}x ${opportunity.side.toUpperCase()} @ ${opportunity.priceCents}¢ on ${candidate.ticker} | Paper balance=$${(paperBalanceCents / 100).toFixed(2)}`);
    } else {
        // Real mode — place order via Kalshi API
        try {
            const orderParams = {
                ticker: candidate.ticker,
                side: opportunity.side,
                action: 'buy',
                count: contracts,
                type: 'limit',
                timeInForce: 'fill_or_kill', // must fill immediately or cancel
            };
            if (opportunity.side === 'yes') {
                orderParams.yesPrice = opportunity.priceCents;
            } else {
                orderParams.noPrice = opportunity.priceCents;
            }

            const result = await kalshi.placeOrder(orderParams);
            const order = result.order || {};
            betRecord.orderId = order.order_id;

            // Check if filled
            const fillCount = parseFloat(order.fill_count_fp || '0');
            betRecord.status = fillCount >= contracts ? 'filled' : 'failed';

            if (betRecord.status === 'failed') {
                console.log(`[crumb-sniper] Order not filled (fill_or_kill) for ${candidate.ticker}`);
                return null;
            }
        } catch (err) {
            console.error(`[crumb-sniper] Order failed for ${candidate.ticker}:`, err.message);
            betRecord.status = 'failed';
            return null;
        }
    }

    // Track the bet
    bettedTickers.add(candidate.ticker);
    bettingList.set(candidate.ticker, betRecord);
    watchList.delete(candidate.ticker);
    dailyStats.bets++;

    return betRecord;
}

/**
 * Settle expired crumb bets
 */
async function settleExpiredBets() {
    const now = new Date();

    for (const [ticker, bet] of bettingList) {
        const closeTime = new Date(bet.closeTime);
        // Wait at least 30 seconds after close for settlement
        if (now - closeTime < 30000) continue;

        try {
            let settled = false;
            let won = false;

            if (paperMode) {
                // In paper mode, check the market result
                const marketData = await fetchJSON(PUBLIC_API + `/markets/${ticker}`);
                const market = marketData?.market;

                if (market && (market.status === 'settled' || market.status === 'closed' || market.result !== undefined)) {
                    // result is 'yes' or 'no'
                    const result = market.result;
                    if (result) {
                        won = (result === bet.side);
                        settled = true;
                    } else if (market.status === 'settled' || market.status === 'closed') {
                        // Try to determine from last price
                        // If last price is 100 for our side, we won
                        const lastPrice = bet.side === 'yes' ? market.yes_bid : market.no_bid;
                        if (lastPrice === 100 || lastPrice === 0) {
                            won = lastPrice === 100;
                            settled = true;
                        } else {
                            // Wait longer for settlement
                            if (now - closeTime > 120000) {
                                // Force settle after 2 minutes — assume implied probability was correct
                                won = Math.random() < bet.impliedProb;
                                settled = true;
                            }
                        }
                    }
                } else if (now - closeTime > 120000) {
                    // Can't fetch market, force settle after 2 min
                    won = Math.random() < bet.impliedProb;
                    settled = true;
                }

                if (settled) {
                    const pnl = won ? bet.potentialProfit : -bet.costCents;
                    paperBalanceCents += won ? (bet.costCents + bet.potentialProfit) : 0;

                    bet.status = won ? 'won' : 'lost';
                    bet.pnlCents = pnl;
                    bet.settledAt = now.toISOString();

                    dailyStats.pnlCents += pnl;
                    if (won) dailyStats.wins++;
                    else dailyStats.losses++;

                    console.log(`[crumb-sniper] PAPER SETTLED: ${ticker} → ${won ? 'WON' : 'LOST'} | P&L=$${(pnl / 100).toFixed(2)} | Balance=$${(paperBalanceCents / 100).toFixed(2)}`);

                    settledList.unshift(bet);
                    if (settledList.length > 50) settledList.pop();
                    bettingList.delete(ticker);
                }
            } else {
                // Real mode — check position/settlement via API
                try {
                    const marketData = await kalshi.getMarket(ticker);
                    const market = marketData?.market;
                    if (market && market.result) {
                        won = (market.result === bet.side);
                        settled = true;
                    } else if (market && (market.status === 'settled' || market.status === 'closed')) {
                        // Check our position
                        won = market.result === bet.side;
                        settled = true;
                    }

                    if (settled) {
                        const pnl = won ? bet.potentialProfit : -bet.costCents;
                        bet.status = won ? 'won' : 'lost';
                        bet.pnlCents = pnl;
                        bet.settledAt = now.toISOString();

                        dailyStats.pnlCents += pnl;
                        if (won) dailyStats.wins++;
                        else dailyStats.losses++;

                        console.log(`[crumb-sniper] SETTLED: ${ticker} → ${won ? 'WON' : 'LOST'} | P&L=$${(pnl / 100).toFixed(2)}`);

                        settledList.unshift(bet);
                        if (settledList.length > 50) settledList.pop();
                        bettingList.delete(ticker);
                    }
                } catch (err) {
                    console.error(`[crumb-sniper] Settlement check error for ${ticker}:`, err.message);
                }
            }
        } catch (err) {
            console.error(`[crumb-sniper] Settlement error for ${ticker}:`, err.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Main Scan Loop
// ═══════════════════════════════════════════════════════════════

async function runScanCycle() {
    if (!isRunning) return;

    try {
        // 1. Settle any expired bets first
        await settleExpiredBets();

        // 2. Scan for new candidates
        const candidates = await scanForCandidates();

        // 3. Clear stale watch entries (expired or too old)
        const now = new Date();
        for (const [ticker, entry] of watchList) {
            const closeTime = new Date(entry.closeTime);
            if (closeTime <= now) watchList.delete(ticker);
        }

        // 4. Evaluate each candidate
        for (const candidate of candidates) {
            if (bettedTickers.has(candidate.ticker)) continue;
            if (bettingList.has(candidate.ticker)) continue;

            const opportunity = await evaluateCandidate(candidate);

            if (!opportunity) {
                watchList.delete(candidate.ticker);
                continue;
            }

            const entry = {
                ...candidate,
                ...opportunity,
                evaluatedAt: now.toISOString(),
            };

            // Meets bet threshold? → auto-bet
            if (opportunity.priceCents >= CONFIG.betMinPrice && candidate.secsLeft >= CONFIG.minSecondsToExpiry) {
                entry.status = 'betting';
                watchList.set(candidate.ticker, entry);
                await placeCrumbBet(candidate, opportunity);
            } else {
                // Just watching
                entry.status = 'watching';
                watchList.set(candidate.ticker, entry);
            }
        }

        // Clean up old betted tickers (keep last 1000)
        if (bettedTickers.size > 1000) {
            const arr = [...bettedTickers];
            for (let i = 0; i < arr.length - 500; i++) {
                bettedTickers.delete(arr[i]);
            }
        }
    } catch (err) {
        console.error('[crumb-sniper] Scan cycle error:', err.message);
    }
}

function resetDailyStatsIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyStats.date !== today) {
        dailyStats.date = today;
        dailyStats.pnlCents = 0;
        dailyStats.bets = 0;
        dailyStats.wins = 0;
        dailyStats.losses = 0;
    }
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

function start(options = {}) {
    if (isRunning) return;
    isRunning = true;

    if (options.paperMode !== undefined) paperMode = options.paperMode;
    if (options.paperBalance !== undefined) paperBalanceCents = options.paperBalance;

    resetDailyStatsIfNeeded();
    console.log(`[crumb-sniper] Started in ${paperMode ? 'PAPER' : 'LIVE'} mode | Scan every ${CONFIG.scanIntervalMs / 1000}s | Bet threshold: ${CONFIG.betMinPrice}-${CONFIG.betMaxPrice}¢`);

    // Run immediately, then on interval
    runScanCycle();
    scanTimer = setInterval(runScanCycle, CONFIG.scanIntervalMs);
}

function stop() {
    isRunning = false;
    if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
    }
    console.log('[crumb-sniper] Stopped');
}

function getStatus() {
    resetDailyStatsIfNeeded();
    return {
        isRunning,
        paperMode,
        paperBalanceCents,
        config: CONFIG,
        watchList: [...watchList.values()].sort((a, b) => a.secsLeft - b.secsLeft),
        bettingList: [...bettingList.values()],
        settledList: settledList.slice(0, 20),
        dailyStats: { ...dailyStats },
        totalBetted: bettedTickers.size,
    };
}

function setPaperMode(enabled) {
    paperMode = enabled;
    console.log(`[crumb-sniper] Paper mode: ${enabled ? 'ON' : 'OFF'}`);
}

function updateConfig(updates) {
    for (const [key, val] of Object.entries(updates)) {
        if (key in CONFIG && typeof CONFIG[key] === typeof val) {
            CONFIG[key] = val;
            console.log(`[crumb-sniper] Config updated: ${key} = ${val}`);
        }
    }
}

module.exports = {
    start,
    stop,
    getStatus,
    setPaperMode,
    updateConfig,
    CONFIG,
};
