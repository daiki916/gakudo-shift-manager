const https = require('https');

let accessToken = process.env.FREEE_ACCESS_TOKEN || '';
let refreshToken = process.env.FREEE_REFRESH_TOKEN || '';
let projectIdPromise = null;
let metadataTokenPromise = null;

function setTokens(tokens) {
    accessToken = tokens.access_token || '';
    refreshToken = tokens.refresh_token || refreshToken || process.env.FREEE_REFRESH_TOKEN || '';
    process.env.FREEE_ACCESS_TOKEN = accessToken;
    process.env.FREEE_REFRESH_TOKEN = refreshToken;
}

function clearCachedAccessToken() {
    accessToken = '';
    process.env.FREEE_ACCESS_TOKEN = '';
}

function getCurrentRefreshToken() {
    return refreshToken || process.env.FREEE_REFRESH_TOKEN || '';
}

function httpRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

async function requestToken(body) {
    const { statusCode, body: responseBody } = await httpRequest({
        hostname: 'accounts.secure.freee.co.jp',
        path: '/public_api/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);

    const result = JSON.parse(responseBody);
    if (statusCode !== 200) {
        throw new Error(`freee token request failed: ${statusCode} - ${responseBody}`);
    }

    setTokens(result);
    return result;
}

async function getProjectId() {
    if (!projectIdPromise) {
        projectIdPromise = (async () => {
            if (process.env.GOOGLE_CLOUD_PROJECT) {
                return process.env.GOOGLE_CLOUD_PROJECT;
            }

            if (process.env.GCLOUD_PROJECT) {
                return process.env.GCLOUD_PROJECT;
            }

            const { statusCode, body } = await httpRequest({
                hostname: 'metadata.google.internal',
                path: '/computeMetadata/v1/project/project-id',
                method: 'GET',
                headers: { 'Metadata-Flavor': 'Google' },
            });

            if (statusCode !== 200) {
                throw new Error(`Failed to get project id from metadata: ${statusCode}`);
            }

            return body.trim();
        })();
    }

    return projectIdPromise;
}

async function getMetadataAccessToken() {
    if (!metadataTokenPromise) {
        metadataTokenPromise = (async () => {
            const { statusCode, body } = await httpRequest({
                hostname: 'metadata.google.internal',
                path: '/computeMetadata/v1/instance/service-accounts/default/token',
                method: 'GET',
                headers: { 'Metadata-Flavor': 'Google' },
            });

            if (statusCode !== 200) {
                throw new Error(`Failed to get metadata token: ${statusCode}`);
            }

            const token = JSON.parse(body);
            return {
                access_token: token.access_token,
                expires_at: Date.now() + (token.expires_in - 60) * 1000,
            };
        })();
    }

    const token = await metadataTokenPromise;
    if (Date.now() > token.expires_at) {
        metadataTokenPromise = null;
        return getMetadataAccessToken();
    }

    return token.access_token;
}

async function addSecretVersion(secretName, value) {
    const projectId = await getProjectId();
    const bearerToken = await getMetadataAccessToken();
    const payload = JSON.stringify({
        payload: {
            data: Buffer.from(value, 'utf8').toString('base64'),
        },
    });

    const { statusCode, body } = await httpRequest({
        hostname: 'secretmanager.googleapis.com',
        path: `/v1/projects/${projectId}/secrets/${secretName}:addVersion`,
        method: 'POST',
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        },
    }, payload);

    if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Failed to add secret version for ${secretName}: ${statusCode} - ${body}`);
    }
}

async function persistTokens() {
    const tasks = [];
    if (accessToken) {
        tasks.push(addSecretVersion('FREEE_ACCESS_TOKEN', accessToken));
    }
    if (refreshToken) {
        tasks.push(addSecretVersion('FREEE_REFRESH_TOKEN', refreshToken));
    }

    if (tasks.length === 0) {
        console.warn('⚠️ persistTokens: no tokens to save');
        return;
    }

    console.log('💾 Persisting freee tokens to Secret Manager...');
    await Promise.all(tasks);
    console.log('✅ freee tokens persisted to Secret Manager');
}

async function getFreeeAccessToken() {
    if (accessToken) {
        return accessToken;
    }

    refreshToken = getCurrentRefreshToken();
    if (refreshToken) {
        return refreshAccessToken();
    }

    throw new Error('freee access token is not configured. Run the OAuth flow first.');
}

async function refreshAccessToken() {
    const clientId = process.env.FREEE_CLIENT_ID;
    const clientSecret = process.env.FREEE_CLIENT_SECRET;

    refreshToken = getCurrentRefreshToken();
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('freee OAuth credentials are not fully configured.');
    }

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
    }).toString();

    const result = await requestToken(body);
    try {
        await persistTokens();
    } catch (error) {
        console.error('❌ Failed to persist refreshed freee tokens:', error.message, error.stack);
    }

    return result.access_token;
}

async function exchangeCode(code) {
    const clientId = process.env.FREEE_CLIENT_ID;
    const clientSecret = process.env.FREEE_CLIENT_SECRET;
    const redirectUri = process.env.FREEE_REDIRECT_URI;

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
    }).toString();

    const result = await requestToken(body);
    try {
        await persistTokens();
    } catch (error) {
        console.error('❌ Failed to persist exchanged freee tokens:', error.message, error.stack);
    }

    return result;
}

function getAuthorizationUrl() {
    const clientId = process.env.FREEE_CLIENT_ID;
    const redirectUri = process.env.FREEE_REDIRECT_URI;

    return `https://accounts.secure.freee.co.jp/public_api/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&prompt=select_company`;
}

function isConfigured() {
    return !!(process.env.FREEE_CLIENT_ID && process.env.FREEE_CLIENT_SECRET && process.env.FREEE_COMPANY_ID);
}

module.exports = {
    clearCachedAccessToken,
    exchangeCode,
    getAuthorizationUrl,
    getFreeeAccessToken,
    isConfigured,
    refreshAccessToken,
};
