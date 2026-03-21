'use strict';

// ═══════════════════════════════════════════════════════════════
// Kalshi API Authentication — RSA-PSS Request Signing
// ═══════════════════════════════════════════════════════════════
// Supports two environments: 'demo' and 'production'
// Each has its own credentials and base URL.
//
// Production env vars:
//   KALSHI_API_KEY           — Production API Key ID
//   KALSHI_PRIVATE_KEY       — Production RSA private key PEM (newlines as \n)
//   OR KALSHI_PRIVATE_KEY_PATH — path to production .pem file
//   KALSHI_BASE_URL          — Production API URL (default: https://api.elections.kalshi.com)
//
// Demo env vars:
//   KALSHI_DEMO_API_KEY      — Demo API Key ID
//   KALSHI_DEMO_PRIVATE_KEY  — Demo RSA private key PEM (newlines as \n)
//   KALSHI_DEMO_BASE_URL     — Demo API URL (default: https://demo-api.kalshi.co)
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let _privateKey = null;
let _apiKeyId = null;
// SAFETY: Always default to demo. Live/production trading requires explicit opt-in
// by setting KALSHI_ENV=production. This prevents accidental real-money trades.
let _currentEnv = (process.env.KALSHI_ENV || 'demo').toLowerCase() === 'production'
    ? 'production'
    : 'demo';

function getEnvironment() {
    return _currentEnv;
}

function setEnvironment(env) {
    if (env !== 'demo' && env !== 'production') {
        throw new Error(`Invalid environment: ${env}. Must be 'demo' or 'production'.`);
    }
    if (env === _currentEnv) return;
    console.log(`[kalshi-auth] Switching environment: ${_currentEnv} → ${env}`);
    _currentEnv = env;
    // Clear cached credentials so they are re-read for the new environment
    _privateKey = null;
    _apiKeyId = null;
    // Log credential availability for the new environment
    const keyEnv = env === 'demo' ? 'KALSHI_DEMO_API_KEY' : 'KALSHI_API_KEY';
    const pkEnv = env === 'demo' ? 'KALSHI_DEMO_PRIVATE_KEY' : 'KALSHI_PRIVATE_KEY';
    const keyId = process.env[keyEnv] || '';
    const pk = process.env[pkEnv] || '';
    console.log(`[kalshi-auth] ${env} credentials: API_KEY=${keyId ? keyId.substring(0, 8) + '...' : 'NOT SET'}, PRIVATE_KEY=${pk ? pk.length + ' chars' : 'NOT SET'}`);
}

function getBaseUrl() {
    if (_currentEnv === 'demo') {
        return process.env.KALSHI_DEMO_BASE_URL || 'https://demo-api.kalshi.co';
    }
    // Production: api.elections.kalshi.com is the current correct URL.
    // The old trading-api.kalshi.com has been deprecated (returns 401 with migration notice).
    return process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
}

function getApiKeyId() {
    if (!_apiKeyId) {
        if (_currentEnv === 'demo') {
            _apiKeyId = process.env.KALSHI_DEMO_API_KEY || '';
        } else {
            _apiKeyId = process.env.KALSHI_API_KEY || '';
        }
    }
    return _apiKeyId;
}

/**
 * Normalize a PEM key string — handles various env-var formats:
 *   1. Proper PEM with real newlines (already correct)
 *   2. PEM with literal \n (common in env vars)
 *   3. Raw base64 without PEM headers (just the key body)
 *   4. PEM with headers but newlines stripped (one long line)
 */
function normalizePem(raw) {
    if (!raw || !raw.trim()) return null;

    // Step 1: replace literal \n with real newlines
    let pem = raw.replace(/\\n/g, '\n').trim();

    // Step 2: check if PEM headers are present
    const hasHeader = pem.includes('-----BEGIN');
    const hasFooter = pem.includes('-----END');

    if (hasHeader && hasFooter) {
        // Headers present — check if body has proper line breaks
        // Extract body between headers
        const bodyMatch = pem.match(/-----BEGIN[^-]+-----\s*([\s\S]*?)\s*-----END[^-]+-----/);
        if (bodyMatch) {
            let body = bodyMatch[1].replace(/\s+/g, ''); // strip all whitespace
            // Re-wrap at 64 chars per line (PEM standard)
            body = body.match(/.{1,64}/g).join('\n');
            const headerLine = pem.match(/-----BEGIN[^-]+-----/)[0];
            const footerLine = pem.match(/-----END[^-]+-----/)[0];
            pem = `${headerLine}\n${body}\n${footerLine}\n`;
        }
        return pem;
    }

    // No PEM headers — treat as raw base64 body
    let body = pem.replace(/\s+/g, ''); // strip all whitespace
    // Re-wrap at 64 chars
    body = body.match(/.{1,64}/g).join('\n');
    return `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\n`;
}

function getPrivateKey() {
    if (_privateKey) return _privateKey;

    let rawKey = null;
    if (_currentEnv === 'demo') {
        rawKey = process.env.KALSHI_DEMO_PRIVATE_KEY;
    } else {
        rawKey = process.env.KALSHI_PRIVATE_KEY;
    }

    if (rawKey) {
        _privateKey = normalizePem(rawKey);
        if (_privateKey) {
            // Log key format for debugging (safe — only shows structure, not content)
            const lines = _privateKey.split('\n').filter(l => l.trim());
            console.log(`[kalshi-auth] Private key loaded (${_currentEnv}): ${lines.length} lines, starts with ${lines[0].substring(0, 20)}...`);
            return _privateKey;
        }
    }

    // Production: try file path
    if (_currentEnv !== 'demo') {
        const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
        if (keyPath) {
            const absPath = path.resolve(keyPath);
            if (fs.existsSync(absPath)) {
                _privateKey = fs.readFileSync(absPath, 'utf8');
                return _privateKey;
            }
            console.warn(`[kalshi-auth] Private key file not found: ${absPath}`);
        }
    }

    return null;
}

function isConfigured() {
    return !!(getApiKeyId() && getPrivateKey());
}

/**
 * Sign a message using RSA-PSS with SHA-256
 * @param {string} message - The string to sign (timestamp + method + path)
 * @returns {string} Base64-encoded signature
 */
function signPssText(message) {
    const privateKey = getPrivateKey();
    if (!privateKey) throw new Error('Kalshi private key not configured');

    try {
        const signature = crypto.sign('sha256', Buffer.from(message), {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        });
        return signature.toString('base64');
    } catch (e) {
        console.error(`[kalshi-auth] RSA signing failed: ${e.message} — key may be malformed`);
        throw e;
    }
}

/**
 * Generate auth headers for a Kalshi API request
 * @param {string} method - HTTP method (GET, POST, DELETE, etc.)
 * @param {string} requestPath - Full path including /trade-api/v2/... (query params stripped automatically)
 * @returns {{ 'KALSHI-ACCESS-KEY': string, 'KALSHI-ACCESS-SIGNATURE': string, 'KALSHI-ACCESS-TIMESTAMP': string }}
 */
function getAuthHeaders(method, requestPath) {
    const timestamp = Date.now().toString();
    const pathWithoutQuery = requestPath.split('?')[0];
    const message = timestamp + method.toUpperCase() + pathWithoutQuery;
    const signature = signPssText(message);

    return {
        'KALSHI-ACCESS-KEY': getApiKeyId(),
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
}

module.exports = {
    getAuthHeaders,
    isConfigured,
    getApiKeyId,
    getEnvironment,
    setEnvironment,
    getBaseUrl,
};
