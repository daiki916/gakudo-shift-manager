/**
 * LINE WORKS API v2 authentication using Service Account (JWT)
 *
 * Private Key の読み込み優先順位:
 *   1. LINEWORKS_PRIVATE_KEY_FILE (Render Secret File パス)
 *   2. LINEWORKS_PRIVATE_KEY_BASE64 (base64エンコード済み)
 *   3. LINEWORKS_PRIVATE_KEY (生PEM文字列)
 */
const https = require('https');
const fs = require('fs');
const jwt = require('jsonwebtoken');

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get private key PEM string.
 * Supports three sources (in priority order):
 *   1. File path (Render Secret File)
 *   2. Base64-encoded env var
 *   3. Raw PEM env var
 */
function getPrivateKeyPem() {
    // 1. Secret File (most reliable on Render)
    const keyFilePath = process.env.LINEWORKS_PRIVATE_KEY_FILE;
    if (keyFilePath) {
        try {
            const pem = fs.readFileSync(keyFilePath, 'utf8').trim();
            console.log('🔑 Private key loaded from file:', keyFilePath, 'length:', pem.length);
            return pem;
        } catch (err) {
            console.error('⚠️ Failed to read key file:', keyFilePath, err.message);
        }
    }

    // 2. Base64-encoded (safe for env vars with no newline issues)
    const b64 = process.env.LINEWORKS_PRIVATE_KEY_BASE64;
    if (b64) {
        const pem = Buffer.from(b64, 'base64').toString('utf8').replace(/\r/g, '').trim();
        console.log('🔑 Private key loaded from base64 env var, length:', pem.length);
        return pem;
    }

    // 3. Raw PEM string (fallback)
    const raw = process.env.LINEWORKS_PRIVATE_KEY;
    if (raw) {
        const pem = raw.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
        console.log('🔑 Private key loaded from raw env var (fallback)');
        return pem;
    }

    throw new Error('No private key configured. Set LINEWORKS_PRIVATE_KEY_FILE, LINEWORKS_PRIVATE_KEY_BASE64, or LINEWORKS_PRIVATE_KEY');
}

/**
 * Create JWT for Service Account authentication using jsonwebtoken package
 */
function createJWT() {
    const clientId = process.env.LINEWORKS_CLIENT_ID;
    const serviceAccountId = process.env.LINEWORKS_SERVICE_ACCOUNT;

    if (!clientId || !serviceAccountId) {
        throw new Error('LINE WORKS credentials not configured');
    }

    const pem = getPrivateKeyPem();
    const now = Math.floor(Date.now() / 1000);

    const token = jwt.sign(
        {
            iss: clientId,
            sub: serviceAccountId,
            iat: now,
            exp: now + 3600,
        },
        pem,
        { algorithm: 'RS256' }
    );

    console.log('✅ JWT signed successfully with jsonwebtoken');
    return token;
}

/**
 * Get access token (with caching)
 */
async function getAccessToken() {
    // Return cached token if still valid (with 5 min buffer)
    if (cachedToken && Date.now() < tokenExpiresAt - 300000) {
        return cachedToken;
    }

    const clientId = process.env.LINEWORKS_CLIENT_ID;
    const clientSecret = process.env.LINEWORKS_CLIENT_SECRET;

    const assertion = createJWT();

    const body = new URLSearchParams({
        assertion: assertion,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'bot',
    }).toString();

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'auth.worksmobile.com',
            path: '/oauth2/v2.0/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        console.error('LINE WORKS auth error:', res.statusCode, data);
                        reject(new Error(`Auth failed: ${res.statusCode} - ${data}`));
                        return;
                    }
                    cachedToken = result.access_token;
                    tokenExpiresAt = Date.now() + (result.expires_in || 86400) * 1000;
                    console.log('✅ LINE WORKS access token obtained');
                    resolve(cachedToken);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Send a text message to a user via LINE WORKS Bot
 */
async function sendMessage(userId, text) {
    const token = await getAccessToken();
    const botId = process.env.LINEWORKS_BOT_ID;

    const body = JSON.stringify({
        content: {
            type: 'text',
            text: text,
        }
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'www.worksapis.com',
            path: `/v1.0/bots/${botId}/users/${userId}/messages`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(true);
                } else {
                    console.error('Send message error:', res.statusCode, data);
                    reject(new Error(`Send failed: ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Check if LINE WORKS integration is configured
 */
function isConfigured() {
    return !!(
        process.env.LINEWORKS_CLIENT_ID &&
        process.env.LINEWORKS_CLIENT_SECRET &&
        process.env.LINEWORKS_SERVICE_ACCOUNT &&
        (process.env.LINEWORKS_PRIVATE_KEY_FILE || process.env.LINEWORKS_PRIVATE_KEY_BASE64 || process.env.LINEWORKS_PRIVATE_KEY) &&
        process.env.LINEWORKS_BOT_ID
    );
}

module.exports = { getAccessToken, sendMessage, isConfigured };
