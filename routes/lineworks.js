/**
 * LINE WORKS Bot webhook endpoint
 * Receives messages from staff, parses with Gemini, registers shifts
 */
const express = require('express');
const router = express.Router();
const { callGemini } = require('../services/gemini');
const { sendMessage, isConfigured } = require('../services/lineworks-auth');
const { queryAll, queryOne, runSQL, insertReturningId, ORG_ID } = require('../database');

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
        const userMessage = event.content?.text;

        if (!userId || !userMessage) return;

        // Find staff by LINE WORKS user ID
        const staff = await findStaffByLineWorksId(userId);

        // Call Gemini to parse the message
        const parsed = await callGemini(userMessage);
        console.log('🤖 Gemini parsed:', JSON.stringify(parsed));

        let replyText = '';

        switch (parsed.action) {
            case 'register':
                replyText = await handleRegisterShifts(staff, parsed);
                break;

            case 'dayoff':
                replyText = await handleDayOff(staff, parsed);
                break;

            case 'check':
                replyText = await handleCheckShifts(staff, parsed);
                break;

            default:
                replyText = parsed.message || 'すみません、シフト情報を読み取れませんでした。\n例: 「3/10は10時から17時」「来週月曜はお休み」';
        }

        // Send reply back to user
        await sendMessage(userId, replyText);
        console.log('✅ Reply sent to', staff?.name || userId);

    } catch (err) {
        console.error('❌ Webhook processing error:', err);
        // Try to send error message back
        try {
            const userId = req.body?.source?.userId;
            if (userId) {
                await sendMessage(userId, '⚠️ 処理中にエラーが発生しました。もう一度お試しください。');
            }
        } catch (e) { /* ignore */ }
    }
});

// ============================================================
// Staff lookup
// ============================================================
async function findStaffByLineWorksId(lineWorksUserId) {
    // First try to find by lineworks_id column
    let staff = await queryOne(
        'SELECT * FROM staff WHERE lineworks_id = $1 AND org_id = $2 AND is_active = 1',
        [lineWorksUserId, ORG_ID]
    );

    if (!staff) {
        // If not found, return a stub with the LINE WORKS user ID
        // Admin will need to link the staff member
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
    if (!staff.id) {
        return `⚠️ あなたのLINE WORKSアカウントはまだスタッフに紐付けされていません。\n管理者に連絡してください。\nユーザーID: ${staff.lineworks_id}`;
    }

    const shifts = parsed.shifts || [];
    if (!shifts.length) {
        return '⚠️ シフト情報が見つかりませんでした。';
    }

    let registered = 0;
    let errors = [];

    for (const shift of shifts) {
        try {
            // Upsert into shift_requests
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

    let reply = `✅ ${staff.name}さんのシフト希望を${registered}件登録しました\n\n`;
    reply += parsed.message || '';
    if (errors.length) {
        reply += `\n\n⚠️ ${errors.join(', ')} の登録でエラーが発生しました`;
    }

    return reply;
}

/**
 * Register day-off requests
 */
async function handleDayOff(staff, parsed) {
    if (!staff.id) {
        return `⚠️ あなたのLINE WORKSアカウントはまだスタッフに紐付けされていません。\n管理者に連絡してください。`;
    }

    const dates = parsed.dates || [];
    let registered = 0;

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

    return `✅ ${staff.name}さんの休み希望を${registered}件登録しました\n\n${parsed.message || ''}`;
}

/**
 * Check current shift registrations
 */
async function handleCheckShifts(staff, parsed) {
    if (!staff.id) {
        return `⚠️ あなたのLINE WORKSアカウントはまだスタッフに紐付けされていません。`;
    }

    const year = parsed.year || new Date().getFullYear();
    const month = parsed.month || (new Date().getMonth() + 1);

    // Get shift requests
    const requests = await queryAll(
        'SELECT * FROM shift_requests WHERE staff_id = $1 AND year = $2 AND month = $3 ORDER BY date',
        [staff.id, year, month]
    );

    // Get confirmed shifts
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
            reply += `  ${d.getMonth() + 1}/${d.getDate()}(${day}) ${s.start_time || '?'}〜${s.end_time || '?'}\n`;
        }
        reply += '\n';
    }

    if (requests.length) {
        reply += '【希望提出済み】\n';
        for (const r of requests) {
            const d = new Date(r.date);
            const day = dayNames[d.getDay()];
            if (r.is_available) {
                reply += `  ${d.getMonth() + 1}/${d.getDate()}(${day}) ${r.start_time || '?'}〜${r.end_time || '?'}\n`;
            } else {
                reply += `  ${d.getMonth() + 1}/${d.getDate()}(${day}) 休み\n`;
            }
        }
    }

    if (!shifts.length && !requests.length) {
        reply += 'まだシフト情報がありません。';
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
    });
});

module.exports = router;
