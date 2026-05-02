'use strict';

// ═══════════════════════════════════════════════════════════════
// Kalshi Trading Client — Authenticated API operations
// ═══════════════════════════════════════════════════════════════
// Wraps: orders, positions, balance, cancellations
// All monetary values in CENTS unless noted otherwise.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { getAuthHeaders, isConfigured, getBaseUrl } = require('./kalshi-auth');

const API_PREFIX = '/trade-api/v2';

/**
 * Make an authenticated request to the Kalshi API
 */
async function kalshiFetch(method, path, body = null, timeout = 10000) {
    const fullPath = API_PREFIX + path;
    const url = getBaseUrl() + fullPath;
    const headers = {
        ...getAuthHeaders(method, fullPath),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const opts = {
            method,
            headers,
            signal: controller.signal,
        };
        if (body && (method === 'POST' || method === 'PUT')) {
            opts.body = JSON.stringify(body);
        }

        const res = await fetch(url, opts);
        clearTimeout(timer);

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        if (!res.ok) {
            // Handle rate limiting with backoff
            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
                const waitMs = Math.min(retryAfter * 1000, 60000);
                console.warn(`[kalshi-trading] Rate limited (429) on ${method} ${path} — waiting ${retryAfter}s`);
                await new Promise(r => setTimeout(r, waitMs));
                // Retry once after waiting
                const retryRes = await fetch(url, opts);
                const retryText = await retryRes.text();
                let retryData;
                try { retryData = JSON.parse(retryText); } catch { retryData = retryText; }
                if (retryRes.ok) return retryData;
                const retryErr = new Error(`Kalshi API ${method} ${path} → ${retryRes.status} (after 429 retry)`);
                retryErr.status = retryRes.status;
                retryErr.response = retryData;
                throw retryErr;
            }
            const detail = (data && typeof data === 'object')
                ? (data.error?.message || data.error?.code || data.message || JSON.stringify(data))
                : (typeof data === 'string' && data ? data : '');
            const err = new Error(`Kalshi API ${method} ${path} → ${res.status}${detail ? ` — ${detail}` : ''}`);
            err.status = res.status;
            err.response = data;
            throw err;
        }
        return data;
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
            const err = new Error(`Kalshi API ${method} ${path} timed out (${timeout}ms)`);
            err.code = 'TIMEOUT';
            throw err;
        }
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════
// Portfolio
// ═══════════════════════════════════════════════════════════════

/**
 * Get account balance
 * @returns {{ balance: number, portfolio_value: number }} values in cents
 */
async function getBalance() {
    return kalshiFetch('GET', '/portfolio/balance');
}

/**
 * Get current positions
 * @param {string} [eventTicker] - optional event ticker filter
 * @returns {{ market_positions: Array, cursor: string }}
 */
async function getPositions(eventTicker) {
    let path = '/portfolio/positions?count_filter=position';
    if (eventTicker) path += '&event_ticker=' + encodeURIComponent(eventTicker);
    return kalshiFetch('GET', path);
}

// ═══════════════════════════════════════════════════════════════
// Orders
// ═══════════════════════════════════════════════════════════════

/**
 * Place an order on Kalshi
 * Uses the post-March-12 API format: count_fp (string), yes/no_price_dollars (string).
 * Callers still pass cents integers — we convert here.
 *
 * @param {Object} params
 * @param {string} params.ticker - Market ticker
 * @param {'yes'|'no'} params.side - yes or no
 * @param {'buy'|'sell'} params.action - buy or sell
 * @param {number} params.count - Number of contracts (integer)
 * @param {number} [params.yesPrice] - Limit price in cents (1-99) for yes side
 * @param {number} [params.noPrice] - Limit price in cents (1-99) for no side
 * @param {string} [params.type='limit'] - Order type
 * @param {string} [params.timeInForce] - e.g. 'fill_or_kill'
 * @returns {Object} Order response with order_id, status, etc.
 */
async function placeOrder({ ticker, side, action, count, yesPrice, noPrice, type = 'limit', timeInForce }) {
    // ── Validate critical parameters before sending to Kalshi ──
    const priceCentsRaw = yesPrice !== undefined ? yesPrice : noPrice;
    if (priceCentsRaw === undefined || priceCentsRaw === null || isNaN(priceCentsRaw) || !isFinite(priceCentsRaw)) {
        const err = new Error(`[kalshi-trading] Invalid price: ${priceCentsRaw} — aborting order`);
        console.error(err.message);
        throw err;
    }
    if (!count || isNaN(count) || count <= 0) {
        const err = new Error(`[kalshi-trading] Invalid count: ${count} — aborting order`);
        console.error(err.message);
        throw err;
    }
    if (!ticker) {
        const err = new Error(`[kalshi-trading] Missing ticker — aborting order`);
        console.error(err.message);
        throw err;
    }

    const clientOrderId = crypto.randomUUID();

    // Convert cents (integer) → dollars (string) for the new API format
    // e.g. 58 cents → "0.58", 5 cents → "0.05"
    const centsToDollars = (cents) => (cents / 100).toFixed(2);

    // Post-March-12 Kalshi API: send ONLY the new fixed-point fields.
    // Sending both `count` (legacy int) and `count_fp` (string) — or both
    // `yes_price` and `yes_price_dollars` — returns HTTP 400.
    const body = {
        ticker,
        side,
        action,
        count_fp: count.toFixed(2),
        type,
        client_order_id: clientOrderId,
    };

    if (yesPrice !== undefined) {
        body.yes_price_dollars = centsToDollars(yesPrice);
    }
    if (noPrice !== undefined) {
        body.no_price_dollars = centsToDollars(noPrice);
    }
    if (timeInForce) body.time_in_force = timeInForce;

    const priceCents = yesPrice || noPrice || 0;
    console.log(`[kalshi-trading] Placing order: ${action} ${count}x ${side} on ${ticker} @ ${priceCents}c ($${centsToDollars(priceCents)})`);
    console.log(`[kalshi-trading] REQUEST BODY: ${JSON.stringify(body)}`);
    const result = await kalshiFetch('POST', '/portfolio/orders', body);
    const o = result.order || {};
    console.log(`[kalshi-trading] FULL RESPONSE: ${JSON.stringify(result)}`);
    console.log(`[kalshi-trading] Order response: id=${o.order_id} status=${o.status} fill_count_fp=${o.fill_count_fp} remaining_count_fp=${o.remaining_count_fp} yes_price_dollars=${o.yes_price_dollars} no_price_dollars=${o.no_price_dollars}`);
    return result;
}

/**
 * Cancel an order
 * @param {string} orderId
 */
async function cancelOrder(orderId) {
    console.log(`[kalshi-trading] Cancelling order: ${orderId}`);
    const result = await kalshiFetch('DELETE', `/portfolio/orders/${orderId}`);
    if (result && result.order) {
        const o = result.order;
        console.log(`[kalshi-trading] Cancel response: fill_count_fp=${o.fill_count_fp} remaining_count_fp=${o.remaining_count_fp} status=${o.status}`);
    }
    return result;
}

/**
 * Get order details
 * @param {string} orderId
 */
async function getOrder(orderId) {
    return kalshiFetch('GET', `/portfolio/orders/${orderId}`);
}

/**
 * Get recent orders
 * @param {string} [ticker] - filter by market ticker
 */
async function getOrders(ticker) {
    let path = '/portfolio/orders';
    if (ticker) path += '?ticker=' + encodeURIComponent(ticker);
    return kalshiFetch('GET', path);
}

// ═══════════════════════════════════════════════════════════════
// Market data (authenticated — gets more detail)
// ═══════════════════════════════════════════════════════════════

/**
 * Get market details
 * @param {string} ticker
 */
async function getMarket(ticker) {
    return kalshiFetch('GET', `/markets/${ticker}`);
}

/**
 * Get market orderbook
 * @param {string} ticker
 */
async function getOrderbook(ticker) {
    return kalshiFetch('GET', `/markets/${ticker}/orderbook`);
}

// ═══════════════════════════════════════════════════════════════
// Market Discovery (for scanning all markets)
// ═══════════════════════════════════════════════════════════════

/**
 * List markets with optional filters
 * @param {Object} [params] - Query parameters
 * @param {string} [params.status] - 'open', 'closed', 'settled'
 * @param {string} [params.cursor] - Pagination cursor
 * @param {number} [params.limit] - Max results (default 100, max 1000)
 * @param {string} [params.series_ticker] - Filter by series
 * @param {string} [params.event_ticker] - Filter by event
 * @param {string} [params.min_close_ts] - ISO timestamp, markets closing after this
 * @param {string} [params.max_close_ts] - ISO timestamp, markets closing before this
 * @returns {{ markets: Array, cursor: string }}
 */
async function listMarkets(params = {}) {
    const query = new URLSearchParams();
    for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) query.set(key, val);
    }
    const qs = query.toString();
    const path = '/markets' + (qs ? '?' + qs : '');
    return kalshiFetch('GET', path, null, 15000); // longer timeout for large lists
}

/**
 * Get event details (contains all markets in an event)
 * @param {string} eventTicker
 */
async function getEvent(eventTicker) {
    return kalshiFetch('GET', `/events/${eventTicker}`);
}

module.exports = {
    isConfigured,
    getBalance,
    getPositions,
    placeOrder,
    cancelOrder,
    getOrder,
    getOrders,
    getMarket,
    getOrderbook,
    listMarkets,
    getEvent,
};
