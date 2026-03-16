/**
 * LINE WORKS API v2 authentication using Service Account (JWT)
 * 統合版: シフトBOT + freee勤怠BOT 共用
 *
 * sendMessage / sendChannelMessage は botId を引数で受け取り、
 * 省略時は LINEWORKS_BOT_ID (シフトBOT) をデフォルトとして使う。
 */
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get private key as a crypto KeyObject.
 */
function getPrivateKeyObject() {
    const derB64 = process.env.LINEWORKS_PRIVATE_KEY_DER;
    if (derB64) {
        let derBuffer = Buffer.from(derB64, 'base64');
        console.log('🔑 Private key loaded from DER base64, bytes:', derBuffer.length);

        // ASN.1 length check: if header says N bytes but we have N-1, pad with 0x00
        if (derBuffer.length >= 4 && derBuffer[0] === 0x30 && derBuffer[1] === 0x82) {
            const expectedLen = (derBuffer[2] << 8 | derBuffer[3]) + 4;
            if (expectedLen > derBuffer.length && expectedLen - derBuffer.length <= 2) {
                console.log(`🔧 DER padding: expected ${expectedLen}, got ${derBuffer.length}, adding ${expectedLen - derBuffer.length} byte(s)`);
                const padded = Buffer.alloc(expectedLen);
                derBuffer.copy(padded);
                derBuffer = padded;
            }
        }

        // Try DER/PKCS8 first, then PEM wrapper fallback
        try {
            return crypto.createPrivateKey({ key: derBuffer, format: 'der', type: 'pkcs8' });
        } catch (e1) {
            console.warn('⚠️ DER/PKCS8 failed:', e1.message, '— trying PEM wrapper...');
            try {
                const pem = `-----BEGIN PRIVATE KEY-----\n${derB64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
                return crypto.createPrivateKey(pem);
            } catch (e2) {
                console.error('❌ PEM wrapper also failed:', e2.message);
                throw e1;
            }
        }
    }

    const keyFilePath = process.env.LINEWORKS_PRIVATE_KEY_FILE;
    if (keyFilePath) {
        try {
            const pem = fs.readFileSync(keyFilePath, 'utf8').trim();
            console.log('🔑 Private key loaded from file:', keyFilePath);
            return crypto.createPrivateKey(pem);
        } catch (err) {
            console.error('⚠️ Failed to read key file:', keyFilePath, err.message);
        }
    }

    const pemB64 = process.env.LINEWORKS_PRIVATE_KEY_BASE64;
    if (pemB64) {
        const pem = Buffer.from(pemB64, 'base64').toString('utf8').replace(/\r/g, '').trim();
        const b64Body = pem.replace(/-----BEGIN .*-----/, '').replace(/-----END .*-----/, '').replace(/\s/g, '');
        const derBuffer = Buffer.from(b64Body, 'base64');
        return crypto.createPrivateKey({ key: derBuffer, format: 'der', type: 'pkcs8' });
    }

    const raw = process.env.LINEWORKS_PRIVATE_KEY;
    if (raw) {
        const pem = raw.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
        return crypto.createPrivateKey(pem);
    }

    throw new Error('No private key configured. Set LINEWORKS_PRIVATE_KEY_DER.');
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
    const privateKey = getPrivateKeyObject();
    const token = jwt.sign(
        { iss: clientId, sub: serviceAccountId, iat: now, exp: now + 3600 },
        privateKey,
        { algorithm: 'RS256' }
    );
    console.log('✅ JWT signed successfully');
    return token;
}

/**
 * Get access token (with caching)
 */
async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 300000) {
        return cachedToken;
    }

    const clientId = process.env.LINEWORKS_CLIENT_ID;
    const clientSecret = process.env.LINEWORKS_CLIENT_SECRET;
    const assertion = createJWT();

    const body = new URLSearchParams({
        assertion,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'bot user.read',
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
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Send a text message to a user via LINE WORKS Bot
 * @param {string} userId
 * @param {string} text
 * @param {string} [botId] — 省略時は LINEWORKS_BOT_ID
 */
async function sendMessage(userId, text, botId) {
    const token = await getAccessToken();
    const bid = botId || process.env.LINEWORKS_BOT_ID;
    console.log('📤 Sending LINE WORKS message:', { botId: bid, userId, length: text.length, preview: text.slice(0, 60) });

    const body = JSON.stringify({ content: { type: 'text', text } });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'www.worksapis.com',
            path: `/v1.0/bots/${bid}/users/${userId}/messages`,
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
                    console.log('✅ LINE WORKS message sent:', { userId, statusCode: res.statusCode });
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
 * Send a text message to a channel (group) via LINE WORKS Bot
 * @param {string} channelId
 * @param {string} text
 * @param {string} [botId]
 */
async function sendChannelMessage(channelId, text, botId) {
    const token = await getAccessToken();
    const bid = botId || process.env.LINEWORKS_BOT_ID;
    console.log('📤 Sending LINE WORKS channel message:', { botId: bid, channelId, length: text.length });

    const body = JSON.stringify({ content: { type: 'text', text } });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'www.worksapis.com',
            path: `/v1.0/bots/${bid}/channels/${channelId}/messages`,
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
                    console.log('✅ LINE WORKS channel message sent:', { channelId, statusCode: res.statusCode });
                    resolve(true);
                } else {
                    console.error('Send channel message error:', res.statusCode, data);
                    reject(new Error(`Send channel failed: ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Get LINE WORKS user profile
 */
async function getUserProfile(userId) {
    const token = await getAccessToken();
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'www.worksapis.com',
            path: `/v1.0/users/${userId}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const profile = JSON.parse(data);
                        console.log('👤 LINE WORKS user profile:', profile.userName?.lastName, profile.userName?.firstName);
                        resolve(profile);
                    } else {
                        reject(new Error(`Get profile failed: ${res.statusCode}`));
                    }
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
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
        (process.env.LINEWORKS_PRIVATE_KEY_DER || process.env.LINEWORKS_PRIVATE_KEY_FILE || process.env.LINEWORKS_PRIVATE_KEY_BASE64 || process.env.LINEWORKS_PRIVATE_KEY) &&
        process.env.LINEWORKS_BOT_ID
    );
}

function parseResponseBody(data) {
    if (!data) {
        return {};
    }

    try {
        return JSON.parse(data);
    } catch (error) {
        return data;
    }
}

async function lineworksApiRequest(method, path, options = {}) {
    const {
        body = null,
        headers = {},
        hostname = 'www.worksapis.com',
        expectedStatusCodes = [200, 201, 202, 204],
    } = options;

    const token = await getAccessToken();
    const payload = body == null
        ? null
        : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body), 'utf8');

    const requestHeaders = {
        Authorization: `Bearer ${token}`,
        ...headers,
    };

    if (payload && !requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
    }
    if (payload && !requestHeaders['Content-Length']) {
        requestHeaders['Content-Length'] = payload.length;
    }

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            path,
            method,
            headers: requestHeaders,
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const parsed = parseResponseBody(data);
                if (expectedStatusCodes.includes(res.statusCode)) {
                    resolve(parsed);
                    return;
                }

                const error = new Error(`LINE WORKS API ${method} ${path} failed: ${res.statusCode} - ${data}`);
                error.statusCode = res.statusCode;
                error.responseBody = parsed;
                reject(error);
            });
        });

        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function uploadFileToUrl(uploadUrl, fileBuffer, fileName, contentType) {
    const token = await getAccessToken();
    const boundary = `----CodexLineworks${Date.now().toString(16)}`;
    const prefix = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="Filedata"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
        'utf8'
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = Buffer.concat([prefix, fileBuffer, suffix]);
    const url = new URL(uploadUrl);

    return new Promise((resolve, reject) => {
        const req = https.request({
            protocol: url.protocol,
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': payload.length,
            },
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(parseResponseBody(data));
                    return;
                }

                reject(new Error(`LINE WORKS upload failed: ${res.statusCode} - ${data}`));
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * Get all members in the LINE WORKS domain
 */
async function getOrgMembers() {
    const domainId = process.env.LINEWORKS_DOMAIN_ID;
    if (!domainId) throw new Error('LINEWORKS_DOMAIN_ID not configured');

    const members = [];
    let cursor = null;

    do {
        const path = cursor
            ? `/v1.0/users?domainId=${domainId}&count=100&cursor=${cursor}`
            : `/v1.0/users?domainId=${domainId}&count=100`;
        const data = await lineworksApiRequest('GET', path);
        if (data.users) {
            members.push(...data.users);
        }
        cursor = data.responseMetaData?.nextCursor || null;
    } while (cursor);

    return members;
}

module.exports = {
    getAccessToken,
    getOrgMembers,
    getUserProfile,
    isConfigured,
    lineworksApiRequest,
    sendChannelMessage,
    sendMessage,
    uploadFileToUrl,
};
