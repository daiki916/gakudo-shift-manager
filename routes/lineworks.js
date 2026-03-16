/**
 * LINE WORKS Bot webhook endpoint
 * Receives messages from staff, parses with Gemini, registers shifts
 * 
 * Flow:
 * 1. First message → send usage guide
 * 2. Shift message → parse with Gemini → show confirmation → wait for OK
 * 3. "OK" / "はい" → register the pending shift
 * 4. "キャンセル" → cancel
 */
const express = require('express');
const router = express.Router();
const { callGemini } = require('../services/gemini');
const { sendMessage, isConfigured } = require('../services/lineworks-auth');
const { queryAll, queryOne, runSQL, insertReturningId, ORG_ID } = require('../database');

// ============================================================
// In-memory state for pending confirmations
// Map<userId, { parsed, staff, expiresAt }>
// ============================================================
const pendingConfirmations = new Map();

// Clean up expired confirmations every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingConfirmations) {
        if (now > val.expiresAt) pendingConfirmations.delete(key);
    }
}, 600000);

// ============================================================
// Welcome / Usage Guide
// ============================================================
const WELCOME_MESSAGE = `📋 シフト管理BOTへようこそ！

このBOTでは、シフト希望を基本的に1か月単位で受け付けています。
できるだけ最初に「4月のシフト希望です」のように月を入れて送ってください。

━━━━━━━━━━━━━━━━
🗓 送り方の例
━━━━━━━━━━━━━━━━
「4月のシフト希望です」
「5月分の希望を送ります」

━━━━━━━━━━━━━━━━
🕐 シフト登録
━━━━━━━━━━━━━━━━
「4月のシフト希望です。4/10は10時から17時」
「4月分で、4/14は9:30〜16:00」
「4月分で、4/10〜4/14は毎日10時から17時」

━━━━━━━━━━━━━━━━
🚫 お休み登録
━━━━━━━━━━━━━━━━
「4月分で、4/15はお休みです」
「4月分で、毎週水曜は休みます」

━━━━━━━━━━━━━━━━
📋 シフト確認
━━━━━━━━━━━━━━━━
「今月のシフトを確認」
「4月のシフト確認して」

━━━━━━━━━━━━━━━━
📖 使い方を見る
━━━━━━━━━━━━━━━━
「ヘルプ」「使い方」

自然な日本語でメッセージを送ってください！`;

// ============================================================
// Webhook callback from LINE WORKS
// ============================================================
router.post('/lineworks/callback', async (req, res) => {
    // Immediately respond 200 to LINE WORKS (required within 1 second)
    res.status(200).json({ status: 'ok' });

    try {
        const event = req.body;
        console.log('📨 LINE WORKS callback:', JSON.stringify(event).substring(0, 200));

        // Only handle text messages
        if (event.type !== 'message' || event.content?.type !== 'text') {
            return;
        }

        const userId = event.source?.userId;
        const userMessage = event.content?.text?.trim();

        if (!userId || !userMessage) return;

        // Check for help / welcome commands
        if (isHelpMessage(userMessage)) {
            await sendMessage(userId, WELCOME_MESSAGE);
            return;
        }

        // Check for confirmation response (OK / cancel)
        if (pendingConfirmations.has(userId)) {
            await handleConfirmationResponse(userId, userMessage);
            return;
        }

        // Find staff by LINE WORKS user ID
        const staff = await findStaffByLineWorksId(userId);

        // Call Gemini to parse the message
        const parsed = await callGemini(userMessage);
        console.log('🤖 Gemini parsed:', JSON.stringify(parsed));

        // Handle check action immediately (no confirmation needed)
        if (parsed.action === 'check') {
            const replyText = await handleCheckShifts(staff, parsed);
            await sendMessage(userId, replyText);
            return;
        }

        // Handle unknown action
        if (parsed.action === 'unknown' || !parsed.action) {
            await sendMessage(userId, parsed.message || '⚠️ シフト情報を読み取れませんでした。\n「ヘルプ」と送信すると使い方を確認できます。');
            return;
        }

        // For register and dayoff: show confirmation first
        if (parsed.action === 'register' || parsed.action === 'dayoff') {
            if (!staff.id) {
                await sendMessage(userId, `⚠️ あなたのLINE WORKSアカウントはまだスタッフに紐付けされていません。\n管理者に連絡してください。\nユーザーID: ${userId}`);
                return;
            }

            // Store pending confirmation (expires in 10 minutes)
            pendingConfirmations.set(userId, {
                parsed,
                staff,
                expiresAt: Date.now() + 600000,
            });

            // Build confirmation message
            const confirmMsg = buildConfirmationMessage(staff, parsed);
            await sendMessage(userId, confirmMsg);
            return;
        }

        // Fallback
        await sendMessage(userId, '⚠️ メッセージを処理できませんでした。\n「ヘルプ」と送信すると使い方を確認できます。');

    } catch (err) {
        console.error('❌ Webhook processing error:', err);
        try {
            const userId = req.body?.source?.userId;
            if (userId) {
                pendingConfirmations.delete(userId);
                await sendMessage(userId, '⚠️ 処理中にエラーが発生しました。もう一度お試しください。');
            }
        } catch (e) { /* ignore */ }
    }
});

// ============================================================
// Helper: detect help/welcome message
// ============================================================
function isHelpMessage(msg) {
    const helpKeywords = ['ヘルプ', 'へるぷ', 'help', '使い方', 'つかいかた', '初めまして', 'はじめまして', 'こんにちは', 'こんばんは'];
    return helpKeywords.some(k => msg.toLowerCase().includes(k));
}

// ============================================================
// Build confirmation message
// ============================================================
function buildConfirmationMessage(staff, parsed) {
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    let msg = `📝 ${staff.name}さん、以下の内容で登録します。\n\n`;

    if (parsed.action === 'register') {
        msg += '【シフト希望】\n';
        for (const s of (parsed.shifts || [])) {
            const d = new Date(s.date + 'T00:00:00');
            const day = dayNames[d.getDay()];
            msg += `  📅 ${d.getMonth() + 1}/${d.getDate()}(${day}) ${s.start_time}〜${s.end_time}\n`;
        }
    } else if (parsed.action === 'dayoff') {
        msg += '【お休み希望】\n';
        for (const date of (parsed.dates || [])) {
            const d = new Date(date + 'T00:00:00');
            const day = dayNames[d.getDay()];
            msg += `  🚫 ${d.getMonth() + 1}/${d.getDate()}(${day}) お休み\n`;
        }
    }

    msg += '\n━━━━━━━━━━━━━━━━\n';
    msg += '✅「OK」で登録\n';
    msg += '❌「キャンセル」で取消\n';
    msg += '━━━━━━━━━━━━━━━━';

    return msg;
}

// ============================================================
// Handle confirmation response
// ============================================================
async function handleConfirmationResponse(userId, message) {
    const lowerMsg = message.toLowerCase();
    const pending = pendingConfirmations.get(userId);

    // Check if expired
    if (Date.now() > pending.expiresAt) {
        pendingConfirmations.delete(userId);
        await sendMessage(userId, '⏰ 確認の有効期限が切れました。もう一度メッセージを送信してください。');
        return;
    }

    // Cancel
    const cancelKeywords = ['キャンセル', 'きゃんせる', 'cancel', 'いいえ', 'いえ', 'no', 'やめる', 'やめて', '取消', '中止'];
    if (cancelKeywords.some(k => lowerMsg.includes(k))) {
        pendingConfirmations.delete(userId);
        await sendMessage(userId, '❌ 登録をキャンセルしました。');
        return;
    }

    // Confirm
    const confirmKeywords = ['ok', 'おk', 'はい', 'うん', 'いい', 'お願い', 'おねがい', '登録', 'yes', '確定', 'おっけー', 'オッケー', 'OK'];
    if (confirmKeywords.some(k => lowerMsg.includes(k))) {
        pendingConfirmations.delete(userId);

        let replyText = '';
        try {
            if (pending.parsed.action === 'register') {
                replyText = await handleRegisterShifts(pending.staff, pending.parsed);
            } else if (pending.parsed.action === 'dayoff') {
                replyText = await handleDayOff(pending.staff, pending.parsed);
            }
        } catch (e) {
            console.error('Registration error:', e);
            replyText = '⚠️ 登録処理中にエラーが発生しました。もう一度お試しください。';
        }

        await sendMessage(userId, replyText);
        return;
    }

    // Unknown response - remind to confirm or cancel
    await sendMessage(userId, '確認待ちです。\n✅「OK」で登録\n❌「キャンセル」で取消');
}

// ============================================================
// Staff lookup
// ============================================================
async function findStaffByLineWorksId(lineWorksUserId) {
    let staff = await queryOne(
        'SELECT * FROM staff WHERE lineworks_id = $1 AND org_id = $2 AND is_active = 1',
        [lineWorksUserId, ORG_ID]
    );

    if (!staff) {
        console.log(`⚠️ No staff linked for LINE WORKS user: ${lineWorksUserId}`);
        return { id: null, name: lineWorksUserId, lineworks_id: lineWorksUserId };
    }

    return staff;
}

// ============================================================
// Action handlers
// ============================================================

/**
 * Register shift requests
 */
async function handleRegisterShifts(staff, parsed) {
    const shifts = parsed.shifts || [];
    if (!shifts.length) return '⚠️ シフト情報が見つかりませんでした。';

    let registered = 0;
    let errors = [];
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

    for (const shift of shifts) {
        try {
            const existing = await queryOne(
                'SELECT id FROM shift_requests WHERE staff_id = $1 AND date = $2',
                [staff.id, shift.date]
            );

            if (existing) {
                await runSQL(
                    'UPDATE shift_requests SET start_time = $1, end_time = $2, is_available = 1, submitted_at = NOW() WHERE id = $3',
                    [shift.start_time, shift.end_time, existing.id]
                );
            } else {
                const year = parseInt(shift.date.split('-')[0]);
                const month = parseInt(shift.date.split('-')[1]);
                await runSQL(
                    'INSERT INTO shift_requests (org_id, staff_id, year, month, date, start_time, end_time, is_available) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)',
                    [ORG_ID, staff.id, year, month, shift.date, shift.start_time, shift.end_time]
                );
            }
            registered++;
        } catch (e) {
            console.error('Shift register error:', e.message);
            errors.push(shift.date);
        }
    }

    let reply = `✅ ${staff.name}さんのシフト希望を${registered}件登録しました！\n\n`;
    for (const shift of shifts) {
        const d = new Date(shift.date + 'T00:00:00');
        const day = dayNames[d.getDay()];
        reply += `  📅 ${d.getMonth() + 1}/${d.getDate()}(${day}) ${shift.start_time}〜${shift.end_time}\n`;
    }
    if (errors.length) {
        reply += `\n⚠️ ${errors.join(', ')} の登録でエラーが発生しました`;
    }

    return reply;
}

/**
 * Register day-off requests
 */
async function handleDayOff(staff, parsed) {
    const dates = parsed.dates || [];
    let registered = 0;
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

    for (const date of dates) {
        try {
            const existing = await queryOne(
                'SELECT id FROM shift_requests WHERE staff_id = $1 AND date = $2',
                [staff.id, date]
            );

            if (existing) {
                await runSQL(
                    'UPDATE shift_requests SET is_available = 0, start_time = NULL, end_time = NULL, submitted_at = NOW() WHERE id = $1',
                    [existing.id]
                );
            } else {
                const year = parseInt(date.split('-')[0]);
                const month = parseInt(date.split('-')[1]);
                await runSQL(
                    'INSERT INTO shift_requests (org_id, staff_id, year, month, date, is_available) VALUES ($1, $2, $3, $4, $5, 0)',
                    [ORG_ID, staff.id, year, month, date]
                );
            }
            registered++;
        } catch (e) {
            console.error('Day-off register error:', e.message);
        }
    }

    let reply = `✅ ${staff.name}さんの休み希望を${registered}件登録しました！\n\n`;
    for (const date of dates) {
        const d = new Date(date + 'T00:00:00');
        const day = dayNames[d.getDay()];
        reply += `  🚫 ${d.getMonth() + 1}/${d.getDate()}(${day}) お休み\n`;
    }

    return reply;
}

/**
 * Check current shift registrations
 */
async function handleCheckShifts(staff, parsed) {
    if (!staff.id) {
        return '⚠️ あなたのLINE WORKSアカウントはまだスタッフに紐付けされていません。';
    }

    const year = parsed.year || new Date().getFullYear();
    const month = parsed.month || (new Date().getMonth() + 1);

    const requests = await queryAll(
        'SELECT * FROM shift_requests WHERE staff_id = $1 AND year = $2 AND month = $3 ORDER BY date',
        [staff.id, year, month]
    );

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
    const shifts = await queryAll(
        'SELECT * FROM shifts WHERE staff_id = $1 AND date >= $2 AND date <= $3 ORDER BY date',
        [staff.id, startDate, endDate]
    );

    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    let reply = `📋 ${staff.name}さん ${year}年${month}月のシフト\n\n`;

    if (shifts.length) {
        reply += '【確定シフト】\n';
        for (const s of shifts) {
            const d = new Date(s.date);
            const day = dayNames[d.getDay()];
            reply += `  📅 ${d.getMonth() + 1}/${d.getDate()}(${day}) ${s.start_time || '?'}〜${s.end_time || '?'}\n`;
        }
        reply += '\n';
    }

    if (requests.length) {
        reply += '【希望提出済み】\n';
        for (const r of requests) {
            const d = new Date(r.date);
            const day = dayNames[d.getDay()];
            if (r.is_available) {
                reply += `  📅 ${d.getMonth() + 1}/${d.getDate()}(${day}) ${r.start_time || '?'}〜${r.end_time || '?'}\n`;
            } else {
                reply += `  🚫 ${d.getMonth() + 1}/${d.getDate()}(${day}) 休み\n`;
            }
        }
    }

    if (!shifts.length && !requests.length) {
        reply += 'まだシフト情報がありません。\n\nシフト希望を送信するには「ヘルプ」と入力してください。';
    }

    return reply;
}

// ============================================================
// Status endpoint
// ============================================================
router.get('/lineworks/status', (req, res) => {
    res.json({
        configured: isConfigured(),
        gemini_configured: !!process.env.GEMINI_API_KEY,
        bot_id: process.env.LINEWORKS_BOT_ID ? '***' + process.env.LINEWORKS_BOT_ID.slice(-4) : null,
        pending_confirmations: pendingConfirmations.size,
        version: 'diag-v4',
    });
});

// ============================================================
// Diagnostic endpoint - test JWT signing and token acquisition
// ============================================================
router.get('/lineworks/debug', async (req, res) => {
    const { getAccessToken } = require('../services/lineworks-auth');
    const results = {
        env: {
            has_client_id: !!process.env.LINEWORKS_CLIENT_ID,
            has_client_secret: !!process.env.LINEWORKS_CLIENT_SECRET,
            has_service_account: !!process.env.LINEWORKS_SERVICE_ACCOUNT,
            has_private_key_der: !!process.env.LINEWORKS_PRIVATE_KEY_DER,
            has_private_key_file: !!process.env.LINEWORKS_PRIVATE_KEY_FILE,
            has_private_key_base64: !!process.env.LINEWORKS_PRIVATE_KEY_BASE64,
            has_private_key_raw: !!process.env.LINEWORKS_PRIVATE_KEY,
            private_key_der_length: (process.env.LINEWORKS_PRIVATE_KEY_DER || '').length,
            private_key_base64_length: (process.env.LINEWORKS_PRIVATE_KEY_BASE64 || '').length,
            has_bot_id: !!process.env.LINEWORKS_BOT_ID,
        },
        jwt_sign: null,
        access_token: null,
    };

    // Detailed key diagnostics
    try {
        const crypto = require('crypto');
        const fs = require('fs');
        let derBuffer = null;
        let pem;
        let keySource = 'none';

        if (process.env.LINEWORKS_PRIVATE_KEY_DER) {
            derBuffer = Buffer.from(process.env.LINEWORKS_PRIVATE_KEY_DER, 'base64');
            keySource = 'der_base64';
        } else if (process.env.LINEWORKS_PRIVATE_KEY_FILE) {
            pem = fs.readFileSync(process.env.LINEWORKS_PRIVATE_KEY_FILE, 'utf8').trim();
            keySource = 'file';
        } else if (process.env.LINEWORKS_PRIVATE_KEY_BASE64) {
            pem = Buffer.from(process.env.LINEWORKS_PRIVATE_KEY_BASE64, 'base64').toString('utf8').replace(/\r/g, '').trim();
            keySource = 'base64';
        } else if (process.env.LINEWORKS_PRIVATE_KEY) {
            pem = process.env.LINEWORKS_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
            keySource = 'raw';
        }

        if (pem) {
            const lines = pem.split('\n');
            const b64Body = pem.replace(/-----BEGIN .*-----/, '').replace(/-----END .*-----/, '').replace(/\s/g, '');
            derBuffer = Buffer.from(b64Body, 'base64');

            results.jwt_sign = {
                key_source: keySource,
                pem_length: pem.length,
                pem_lines: lines.length,
                pem_first_line: lines[0],
                pem_last_line: lines[lines.length - 1],
                b64_body_length: b64Body.length,
                der_bytes: derBuffer.length,
                der_first_bytes: derBuffer.slice(0, 10).toString('hex'),
                node_version: process.version,
                openssl_version: process.versions.openssl,
            };
        } else if (derBuffer) {
            results.jwt_sign = {
                key_source: keySource,
                der_bytes: derBuffer.length,
                der_first_bytes: derBuffer.slice(0, 10).toString('hex'),
                node_version: process.version,
                openssl_version: process.versions.openssl,
            };
        }

        if (derBuffer) {
            try {
                const key = crypto.createPrivateKey({ key: derBuffer, format: 'der', type: 'pkcs8' });
                const sig = crypto.sign('sha256', Buffer.from('test'), key);
                results.jwt_sign.der_pkcs8 = { success: true, sig_length: sig.length };
            } catch (e) {
                results.jwt_sign.der_pkcs8 = { success: false, error: e.message };
            }
        }

        if (pem) {
            try {
                const key = crypto.createPrivateKey(pem);
                const sig = crypto.sign('sha256', Buffer.from('test'), key);
                results.jwt_sign.pem_direct = { success: true, sig_length: sig.length };
            } catch (e) {
                results.jwt_sign.pem_direct = { success: false, error: e.message };
            }
        }

        if (results.jwt_sign) {
            results.jwt_sign.success = !!(
                (results.jwt_sign.der_pkcs8 && results.jwt_sign.der_pkcs8.success) ||
                (results.jwt_sign.pem_direct && results.jwt_sign.pem_direct.success)
            );
        }
    } catch (err) {
        results.jwt_sign = { success: false, error: err.message };
    }

    // Test access token acquisition
    try {
        const token = await getAccessToken();
        results.access_token = { success: true, token_present: !!token };
    } catch (err) {
        results.access_token = { success: false, error: err.message };
    }

    res.json(results);
});

module.exports = router;
