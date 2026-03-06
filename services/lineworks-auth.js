/**
 * LINE WORKS API v2 authentication using Service Account (JWT)
 */
const https = require('https');
const crypto = require('crypto');

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Create JWT for Service Account authentication
 */
function createJWT() {
    const clientId = process.env.LINEWORKS_CLIENT_ID;
    const serviceAccountId = process.env.LINEWORKS_SERVICE_ACCOUNT;
    const privateKey = process.env.LINEWORKS_PRIVATE_KEY;

    if (!clientId || !serviceAccountId || !privateKey) {
        throw new Error('LINE WORKS credentials not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: clientId,
        sub: serviceAccountId,
        iat: now,
        exp: now + 3600, // 1 hour
    };

    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${base64Header}.${base64Payload}`;

    // Handle private key - may have escaped newlines from env var
    const key = privateKey.replace(/\\n/g, '\n');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(key, 'base64url');

    return `${signingInput}.${signature}`;
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

    const jwt = createJWT();

    const body = new URLSearchParams({
        assertion: jwt,
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
        process.env.LINEWORKS_PRIVATE_KEY &&
        process.env.LINEWORKS_BOT_ID
    );
}

module.exports = { getAccessToken, sendMessage, isConfigured };
