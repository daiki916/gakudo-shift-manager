/**
 * LINE WORKS API v2 authentication using Service Account (JWT)
 * Uses manual JWT construction with crypto.sign() to avoid OpenSSL PEM parser issues
 */
const https = require('https');
const crypto = require('crypto');

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get private key PEM string from environment variable.
 */
function getPrivateKeyPem() {
    let pem;

    const b64 = process.env.LINEWORKS_PRIVATE_KEY_BASE64;
    if (b64) {
        pem = Buffer.from(b64, 'base64').toString('utf8');
        console.log('🔑 Private key loaded from base64 env var, length:', pem.length);
    } else {
        const raw = process.env.LINEWORKS_PRIVATE_KEY;
        if (raw) {
            pem = raw.replace(/\\n/g, '\n');
            console.log('🔑 Private key loaded from raw env var (fallback)');
        } else {
            throw new Error('No private key configured');
        }
    }

    // Clean up: strip \r, trim whitespace
    pem = pem.replace(/\r/g, '').trim();
    return pem;
}

/**
 * Extract DER bytes from PEM and create key using DER format
 */
function getPrivateKeyObject() {
    const pem = getPrivateKeyPem();

    // Extract base64 body from PEM (strip header/footer/newlines)
    const b64Body = pem
        .replace(/-----BEGIN .*-----/, '')
        .replace(/-----END .*-----/, '')
        .replace(/\s/g, '');

    const derBuffer = Buffer.from(b64Body, 'base64');
    console.log('🔑 DER key extracted, bytes:', derBuffer.length);

    // Create key from DER format (bypasses PEM parser)
    return crypto.createPrivateKey({
        key: derBuffer,
        format: 'der',
        type: 'pkcs8',
    });
}

/**
 * Base64url encode
 */
function base64url(data) {
    const b64 = (typeof data === 'string')
        ? Buffer.from(data).toString('base64')
        : data.toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create JWT for Service Account authentication
 */
function createJWT() {
    const clientId = process.env.LINEWORKS_CLIENT_ID;
    const serviceAccountId = process.env.LINEWORKS_SERVICE_ACCOUNT;

    if (!clientId || !serviceAccountId) {
        throw new Error('LINE WORKS credentials not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: clientId,
        sub: serviceAccountId,
        iat: now,
        exp: now + 3600,
    }));

    const signingInput = `${header}.${payload}`;
    const key = getPrivateKeyObject();
    const signature = crypto.sign('sha256', Buffer.from(signingInput), key);

    console.log('✅ JWT signed successfully');
    return `${signingInput}.${base64url(signature)}`;
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
                        reject(new Error(`Auth failed: ${res.statusCode}`));
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
        (process.env.LINEWORKS_PRIVATE_KEY_BASE64 || process.env.LINEWORKS_PRIVATE_KEY) &&
        process.env.LINEWORKS_BOT_ID
    );
}

module.exports = { getAccessToken, sendMessage, isConfigured };
