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
//   KALSHI_BASE_URL          — Production API URL (default: https://trading-api.kalshi.com)
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
// Default to production if production credentials are available, otherwise demo.
// The demo API (demo-api.kalshi.co) is a sandbox that returns status=executed
// without actually matching orders. Only the production API creates real fills.
let _currentEnv = (process.env.KALSHI_API_KEY && process.env.KALSHI_PRIVATE_KEY)
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
}

function getBaseUrl() {
    if (_currentEnv === 'demo') {
        return process.env.KALSHI_DEMO_BASE_URL || 'https://demo-api.kalshi.co';
    }
    // Production: trading-api.kalshi.com is the current correct URL.
    // The old api.elections.kalshi.com also works but is the market-data URL.
    return process.env.KALSHI_BASE_URL || 'https://trading-api.kalshi.com';
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

function getPrivateKey() {
    if (_privateKey) return _privateKey;

    if (_currentEnv === 'demo') {
        // Demo: inline PEM only
        if (process.env.KALSHI_DEMO_PRIVATE_KEY) {
            _privateKey = process.env.KALSHI_DEMO_PRIVATE_KEY.replace(/\\n/g, '\n');
            return _privateKey;
        }
        return null;
    }

    // Production: try inline PEM first
    if (process.env.KALSHI_PRIVATE_KEY) {
        _privateKey = process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n');
        return _privateKey;
    }

    // Production: try file path
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (keyPath) {
        const absPath = path.resolve(keyPath);
        if (fs.existsSync(absPath)) {
            _privateKey = fs.readFileSync(absPath, 'utf8');
            return _privateKey;
        }
        console.warn(`[kalshi-auth] Private key file not found: ${absPath}`);
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

    const signature = crypto.sign('sha256', Buffer.from(message), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return signature.toString('base64');
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
