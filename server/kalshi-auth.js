'use strict';

// ═══════════════════════════════════════════════════════════════
// Kalshi API Authentication — RSA-PSS Request Signing
// ═══════════════════════════════════════════════════════════════
// Each request is independently signed with:
//   message = timestamp + HTTP_METHOD + path (without query params)
//   signature = RSA-PSS(SHA-256, saltLen=DIGEST) → base64
//
// Required env vars:
//   KALSHI_API_KEY       — API Key ID from Kalshi dashboard
//   KALSHI_PRIVATE_KEY   — RSA private key PEM string (newlines as \n)
//   OR KALSHI_PRIVATE_KEY_PATH — path to .pem file
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let _privateKey = null;
let _apiKeyId = null;

function getApiKeyId() {
    if (!_apiKeyId) {
        _apiKeyId = process.env.KALSHI_API_KEY || '';
    }
    return _apiKeyId;
}

function getPrivateKey() {
    if (_privateKey) return _privateKey;

    // Try inline PEM first (env var with \n escaped)
    if (process.env.KALSHI_PRIVATE_KEY) {
        _privateKey = process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n');
        return _privateKey;
    }

    // Try file path
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
};
