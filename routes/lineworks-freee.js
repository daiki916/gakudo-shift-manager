const express = require('express');
const { ORG_ID, queryOne } = require('../database');
const { generateDailyReport } = require('../services/daily-report');
const { findEmployeeByName, getEmployees, getWorkRecord, getWorkRecords, updateWorkRecord } = require('../services/freee-api');
const freeeAuth = require('../services/freee-auth');
const { MENU_COMMANDS } = require('../services/freee-bot-menu');
const { callGemini } = require('../services/gemini-freee');
const { getAccessToken, getUserProfile, isConfigured, sendMessage } = require('../services/lineworks-auth');

const router = express.Router();

const FREEE_BOT_ID = () => process.env.FREEE_BOT_ID;
const pendingConfirmations = new Map();
const userProfileCache = new Map();
let lastSeenChannel = null;

const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [key, value] of pendingConfirmations) {
        if (now > value.expiresAt) {
            pendingConfirmations.delete(key);
        }
    }

    for (const [key, value] of userProfileCache) {
        if (now > value.expiresAt) {
            userProfileCache.delete(key);
        }
    }
}, 10 * 60 * 1000);

if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
}

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const MENU_TEXTS = Object.fromEntries(MENU_COMMANDS.map(command => [command.key, command.commandText]));

const WELCOME_MESSAGE = `freee勤怠修正BOTです。

できること
- 今日の勤怠確認
- 前日レポート確認
- 出勤 / 退勤 / 休憩の修正

使い方の例
- 今日の勤怠
- 前日レポート
- 今日の出勤を8:00にして
- 今日の退勤を18:00にして
- 今日の休憩を12:00から13:00にして

困ったときは「ヘルプ」と送ってください。`;

const CLOCK_IN_GUIDANCE = `出勤修正は、次のように送ってください。

- 今日の出勤を8:00にして
- 3/10 の出勤を8:15にして

日付を書かない場合は今日として扱います。`;

const CLOCK_OUT_GUIDANCE = `退勤修正は、次のように送ってください。

- 今日の退勤を18:00にして
- 3/10 の退勤を17:30にして

日付を書かない場合は今日として扱います。`;

const BREAK_GUIDANCE = `休憩修正は、次のように送ってください。

- 今日の休憩を12:00から13:00にして
- 3/10 の休憩を12:15から13:00にして

複数回ある場合は、まず1件ずつ修正してください。`;

function normalizeText(text) {
    return (text || '').replace(/\s+/g, '').toLowerCase();
}

function includesAny(text, keywords) {
    return keywords.some(keyword => text.includes(normalizeText(keyword)));
}

function getTodayJST() {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

function getFreeeReauthUrl() {
    const redirectUri = process.env.FREEE_REDIRECT_URI || '';
    if (redirectUri.includes('/callback/freee')) {
        return redirectUri.replace('/callback/freee', '/auth/freee');
    }

    return 'https://gakudo-shift-manager-229549757994.asia-northeast1.run.app/auth/freee';
}

function createFreeeAuthExpiredMessage() {
    return `freee の認証が切れています。
次の URL から 1 回だけ再認証してください。
${getFreeeReauthUrl()}`;
}

function isFreeeAuthError(error) {
    const message = error?.message || '';
    return message.includes('invalid_grant') || message.includes('freee token request failed: 401');
}

function isHelpMessage(message) {
    const normalized = normalizeText(message);
    return includesAny(normalized, [
        MENU_TEXTS.help,
        'help',
        '使い方',
        'なにができる',
        '何ができる',
        'メニュー',
        'はじめまして',
    ]);
}

function isDailyReportMessage(message) {
    const normalized = normalizeText(message);
    return includesAny(normalized, [
        MENU_TEXTS.daily_report,
        '前日レポートみせて',
        '前日レポート見せて',
        '昨日レポート',
        '昨日のレポート',
        '前日のレポート',
        'レポートみせて',
        'レポート見せて',
        '日報みせて',
        '日報見せて',
    ]);
}

function isTodayAttendanceMessage(message) {
    const normalized = normalizeText(message);
    return includesAny(normalized, [
        MENU_TEXTS.today_attendance,
        '今日の勤怠をみせて',
        '今日の勤怠を見せて',
        '今日の勤怠を確認',
        '今日の打刻を確認',
        '今日の出勤状況',
    ]);
}

function isClockInGuidanceMessage(message) {
    const normalized = normalizeText(message);
    return includesAny(normalized, [
        MENU_TEXTS.clock_in_help,
        '出勤を修正',
        '出勤を修正したい',
    ]);
}

function isClockOutGuidanceMessage(message) {
    const normalized = normalizeText(message);
    return includesAny(normalized, [
        MENU_TEXTS.clock_out_help,
        '退勤を修正',
        '退勤を修正したい',
    ]);
}

function isBreakGuidanceMessage(message) {
    const normalized = normalizeText(message);
    return includesAny(normalized, [
        MENU_TEXTS.break_help,
        '休憩を修正',
        '休憩を修正したい',
    ]);
}

function parseDateParts(dateStr) {
    const [year, month, day] = (dateStr || '').split('-').map(value => parseInt(value, 10));
    const base = new Date(Date.UTC(year || 2026, (month || 1) - 1, day || 1, 12, 0, 0));

    return {
        year: year || 2026,
        month: month || 1,
        day: day || 1,
        dayName: DAY_NAMES[base.getUTCDay()],
    };
}

function formatTime(value) {
    if (!value) {
        return '--:--';
    }

    const match = String(value).match(/(?:T|\s)(\d{2}):(\d{2})/);
    if (match) {
        return `${match[1]}:${match[2]}`;
    }

    return String(value);
}

function formatWorkRecord(employee, record) {
    const targetDate = record?.date || getTodayJST();
    const { month, day, dayName } = parseDateParts(targetDate);
    const clockIn = record?.clock_in_at ? formatTime(record.clock_in_at) : '未打刻';
    const clockOut = record?.clock_out_at ? formatTime(record.clock_out_at) : '未打刻';
    const lines = [
        `${employee.displayName} さんの ${month}/${day}(${dayName}) の勤怠`,
        '',
        `出勤: ${clockIn}`,
        `退勤: ${clockOut}`,
    ];

    if (Array.isArray(record?.break_records) && record.break_records.length > 0) {
        lines.push('', '休憩:');
        for (const breakRecord of record.break_records) {
            lines.push(`- ${formatTime(breakRecord.clock_in_at)} - ${formatTime(breakRecord.clock_out_at)}`);
        }
    }

    if (record?.day_pattern) {
        const dayPatterns = {
            normal_day: '通常勤務',
            prescribed_holiday: '所定休日',
            legal_holiday: '法定休日',
        };
        lines.push('', `勤務区分: ${dayPatterns[record.day_pattern] || record.day_pattern}`);
    }

    return lines.join('\n');
}

function formatWorkRecordLine(record) {
    const { month, day, dayName } = parseDateParts(record.date || getTodayJST());
    return `${month}/${day}(${dayName}) ${formatTime(record.clock_in_at)} - ${formatTime(record.clock_out_at)}`;
}

function buildConfirmationMessage(employee, parsed) {
    const { month, day, dayName } = parseDateParts(parsed.date);
    const lines = [
        `${employee.displayName} さんの勤怠を次の内容で修正します。`,
        '',
        `対象日: ${month}/${day}(${dayName})`,
    ];

    if (parsed.clock_in_at) {
        lines.push(`出勤: ${formatTime(parsed.clock_in_at)}`);
    }
    if (parsed.clock_out_at) {
        lines.push(`退勤: ${formatTime(parsed.clock_out_at)}`);
    }
    if (Array.isArray(parsed.break_records)) {
        for (const breakRecord of parsed.break_records) {
            lines.push(`休憩: ${formatTime(breakRecord.clock_in_at)} - ${formatTime(breakRecord.clock_out_at)}`);
        }
    }

    lines.push('', '問題なければ「OK」、やめる場合は「キャンセル」と送ってください。');
    return lines.join('\n');
}

async function sendLinkedEmployeeHelp(userId) {
    await sendMessage(
        userId,
        'LINE WORKS ID に紐づく従業員が見つかりませんでした。\n管理画面で LINE WORKS ID を連携してください。',
        FREEE_BOT_ID()
    );
}

async function resolveEmployee(userId) {
    const cached = userProfileCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached;
    }

    async function resolveFromStaffName(staffName) {
        if (!staffName) {
            return null;
        }

        const parts = staffName.trim().split(/\s+/).filter(Boolean);
        const lastName = parts[0] || '';
        const firstName = parts.slice(1).join(' ');
        if (!lastName) {
            return null;
        }

        return findEmployeeByName(lastName, firstName);
    }

    // 1. Check linked staff in DB
    try {
        const linkedStaff = await queryOne(
            'SELECT id, name FROM staff WHERE lineworks_id = $1 AND org_id = $2 AND is_active = 1',
            [userId, ORG_ID]
        );
        if (linkedStaff) {
            // Try to get freee employee by name
            try {
                const employee = await resolveFromStaffName(linkedStaff.name);
                if (employee) {
                    const resolved = {
                        id: employee.id,
                        lastName: employee.last_name,
                        firstName: employee.first_name,
                        displayName: `${employee.last_name} ${employee.first_name}`.trim(),
                        staffDbId: linkedStaff.id,
                        expiresAt: Date.now() + 60 * 60 * 1000,
                    };
                    userProfileCache.set(userId, resolved);
                    return resolved;
                }
            } catch (freeeErr) {
                console.warn('freee lookup failed, using staff name as fallback:', freeeErr.message);
            }

            // Fallback: use staff name directly (freee ID will be resolved lazily)
            const parts = linkedStaff.name.trim().split(/\s+/).filter(Boolean);
            const resolved = {
                id: null, // freee employee ID unknown, will resolve on demand
                lastName: parts[0] || '',
                firstName: parts.slice(1).join(' ') || '',
                displayName: linkedStaff.name,
                staffDbId: linkedStaff.id,
                expiresAt: Date.now() + 10 * 60 * 1000, // shorter cache for fallback
            };
            userProfileCache.set(userId, resolved);
            return resolved;
        }
    } catch (error) {
        console.warn('Failed to resolve employee from linked staff:', error.message);
    }

    // 2. Try LINE WORKS profile name
    try {
        const profile = await getUserProfile(userId);
        const lastName = profile.userName?.lastName || '';
        const firstName = profile.userName?.firstName || '';

        if (lastName) {
            const employee = await findEmployeeByName(lastName, firstName);
            if (employee) {
                const resolved = {
                    id: employee.id,
                    lastName: employee.last_name,
                    firstName: employee.first_name,
                    displayName: `${employee.last_name} ${employee.first_name}`.trim(),
                    expiresAt: Date.now() + 60 * 60 * 1000,
                };
                userProfileCache.set(userId, resolved);
                return resolved;
            }
        }
    } catch (error) {
        console.warn('Failed to resolve employee from LINE WORKS profile:', error.message);
    }

    // 3. Try freee employee list (if only 1 employee)
    try {
        const data = await getEmployees();
        const employees = data.employees || [];
        if (employees.length === 1) {
            const employee = employees[0];
            const resolved = {
                id: employee.id,
                lastName: employee.last_name || '',
                firstName: employee.first_name || '',
                displayName: employee.display_name || `${employee.last_name || ''} ${employee.first_name || ''}`.trim(),
                expiresAt: Date.now() + 60 * 60 * 1000,
            };
            userProfileCache.set(userId, resolved);
            return resolved;
        }
    } catch (error) {
        console.warn('Failed to resolve employee from freee employee list:', error.message);
    }

    return null;
}

async function handleCheckAttendance(employee, date) {
    try {
        // If freee employee ID is unknown, try to resolve it
        if (!employee.id) {
            const emp = await findEmployeeByName(employee.lastName, employee.firstName);
            if (emp) {
                employee.id = emp.id;
            } else {
                return `${employee.displayName} さんのfreee従業員情報が見つかりません。\nfreeeの再認証が必要かもしれません。\n${getFreeeReauthUrl()}`;
            }
        }
        const record = await getWorkRecord(employee.id, date);
        return formatWorkRecord(employee, record);
    } catch (error) {
        if (isFreeeAuthError(error)) {
            return createFreeeAuthExpiredMessage();
        }

        return `${date} の勤怠データを取得できませんでした。`;
    }
}

async function handleCheckRange(employee, startDate, endDate) {
    try {
        const records = await getWorkRecords(employee.id, startDate, endDate);
        const lines = [`${employee.displayName} さんの ${startDate} から ${endDate} の勤怠`, ''];

        for (const record of records) {
            if (record.error) {
                lines.push(`- ${record.date}: 取得エラー`);
                continue;
            }

            lines.push(`- ${formatWorkRecordLine(record)}`);
        }

        return lines.join('\n');
    } catch (error) {
        if (isFreeeAuthError(error)) {
            return createFreeeAuthExpiredMessage();
        }

        return '勤怠データの取得に失敗しました。';
    }
}

async function handleConfirmationResponse(userId, message) {
    const pending = pendingConfirmations.get(userId);
    if (!pending) {
        return;
    }

    if (Date.now() > pending.expiresAt) {
        pendingConfirmations.delete(userId);
        await sendMessage(userId, '確認待ちの修正は期限切れになりました。もう一度内容を送ってください。', FREEE_BOT_ID());
        return;
    }

    const normalized = normalizeText(message);
    const cancelKeywords = ['キャンセル', 'cancel', 'やめる', '中止', 'no'];
    if (includesAny(normalized, cancelKeywords)) {
        pendingConfirmations.delete(userId);
        await sendMessage(userId, '修正をキャンセルしました。', FREEE_BOT_ID());
        return;
    }

    const confirmKeywords = ['ok', 'はい', 'お願いします', '確定', 'yes'];
    if (includesAny(normalized, confirmKeywords)) {
        pendingConfirmations.delete(userId);

        try {
            const { employee, parsed } = pending;
            const updateData = {};
            if (parsed.clock_in_at) {
                updateData.clock_in_at = parsed.clock_in_at;
            }
            if (parsed.clock_out_at) {
                updateData.clock_out_at = parsed.clock_out_at;
            }
            if (Array.isArray(parsed.break_records) && parsed.break_records.length > 0) {
                updateData.break_records = parsed.break_records;
            }

            await updateWorkRecord(employee.id, parsed.date, updateData);
            const updatedRecord = await getWorkRecord(employee.id, parsed.date);
            await sendMessage(userId, `修正しました。\n\n${formatWorkRecord(employee, updatedRecord)}`, FREEE_BOT_ID());
        } catch (error) {
            console.error('Failed to update freee work record:', error);
            if (isFreeeAuthError(error)) {
                await sendMessage(userId, createFreeeAuthExpiredMessage(), FREEE_BOT_ID());
                return;
            }

            await sendMessage(userId, '勤怠修正の反映中にエラーが発生しました。', FREEE_BOT_ID());
        }
        return;
    }

    await sendMessage(userId, '確認待ちです。「OK」で確定、「キャンセル」で中止できます。', FREEE_BOT_ID());
}

async function handleMenuShortcut(userId, message) {
    if (isHelpMessage(message)) {
        await sendMessage(userId, WELCOME_MESSAGE, FREEE_BOT_ID());
        return true;
    }

    if (isDailyReportMessage(message)) {
        try {
            const { message: reportMessage } = await generateDailyReport();
            await sendMessage(userId, reportMessage, FREEE_BOT_ID());
        } catch (error) {
            if (isFreeeAuthError(error)) {
                await sendMessage(userId, createFreeeAuthExpiredMessage(), FREEE_BOT_ID());
            } else {
                throw error;
            }
        }
        return true;
    }

    if (isTodayAttendanceMessage(message)) {
        const employee = await resolveEmployee(userId);
        if (!employee) {
            await sendLinkedEmployeeHelp(userId);
            return true;
        }

        const reply = await handleCheckAttendance(employee, getTodayJST());
        await sendMessage(userId, reply, FREEE_BOT_ID());
        return true;
    }

    if (isClockInGuidanceMessage(message)) {
        await sendMessage(userId, CLOCK_IN_GUIDANCE, FREEE_BOT_ID());
        return true;
    }

    if (isClockOutGuidanceMessage(message)) {
        await sendMessage(userId, CLOCK_OUT_GUIDANCE, FREEE_BOT_ID());
        return true;
    }

    if (isBreakGuidanceMessage(message)) {
        await sendMessage(userId, BREAK_GUIDANCE, FREEE_BOT_ID());
        return true;
    }

    return false;
}

router.post('/freee-bot/callback', async (req, res) => {
    res.status(200).json({ status: 'ok' });

    try {
        const event = req.body;
        console.log('[freee BOT] callback:', JSON.stringify(event).slice(0, 200));

        if (event.source?.channelId) {
            lastSeenChannel = {
                channelId: event.source.channelId,
                type: event.source.type || null,
                seenAt: new Date().toISOString(),
            };
        }

        if (event.type !== 'message' || event.content?.type !== 'text') {
            return;
        }

        const userId = event.source?.userId;
        const userMessage = (event.content?.text || event.content?.postback || '').trim();
        if (!userId || !userMessage) {
            return;
        }

        if (await handleMenuShortcut(userId, userMessage)) {
            return;
        }

        if (pendingConfirmations.has(userId)) {
            await handleConfirmationResponse(userId, userMessage);
            return;
        }

        const employee = await resolveEmployee(userId);
        if (!employee) {
            await sendLinkedEmployeeHelp(userId);
            return;
        }

        const parsed = await callGemini(userMessage);
        console.log('[freee BOT] Gemini parsed:', JSON.stringify(parsed));

        if (parsed.action === 'check') {
            const reply = await handleCheckAttendance(employee, parsed.date);
            await sendMessage(userId, reply, FREEE_BOT_ID());
            return;
        }

        if (parsed.action === 'check_range') {
            const reply = await handleCheckRange(employee, parsed.start_date, parsed.end_date);
            await sendMessage(userId, reply, FREEE_BOT_ID());
            return;
        }

        if (parsed.action === 'update') {
            pendingConfirmations.set(userId, {
                parsed,
                employee,
                expiresAt: Date.now() + 10 * 60 * 1000,
            });
            await sendMessage(userId, buildConfirmationMessage(employee, parsed), FREEE_BOT_ID());
            return;
        }

        await sendMessage(
            userId,
            parsed.message || '内容をうまく理解できませんでした。ヘルプと送ると使い方を表示します。',
            FREEE_BOT_ID()
        );
    } catch (error) {
        console.error('[freee BOT] Webhook error:', error);

        try {
            const userId = req.body?.source?.userId;
            if (!userId) {
                return;
            }

            pendingConfirmations.delete(userId);
            if (isFreeeAuthError(error)) {
                await sendMessage(userId, createFreeeAuthExpiredMessage(), FREEE_BOT_ID());
                return;
            }

            await sendMessage(userId, '処理中にエラーが発生しました。時間をおいてもう一度お試しください。', FREEE_BOT_ID());
        } catch (sendError) {
            console.error('[freee BOT] Failed to send fallback error message:', sendError);
        }
    }
});

// Send a test message from freee BOT to a specific user
router.post('/freee-bot/send-test', async (req, res) => {
    try {
        const { userId, text, botId } = req.body;
        if (!userId || !text) {
            return res.status(400).json({ error: 'userId and text are required' });
        }
        const bid = botId || FREEE_BOT_ID();
        await sendMessage(userId, text, bid);
        res.json({ status: 'sent', userId, botId: bid });
    } catch (err) {
        console.error('Send test error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/freee-bot/status', (req, res) => {
    res.json({
        configured: isConfigured(),
        gemini_configured: !!process.env.GEMINI_API_KEY,
        freee_configured: freeeAuth.isConfigured(),
        bot_id: process.env.FREEE_BOT_ID ? `***${process.env.FREEE_BOT_ID.slice(-4)}` : null,
        daily_report_destination: process.env.DAILY_REPORT_CHANNEL_ID ? 'channel' : 'dm',
        daily_report_channel_configured: !!process.env.DAILY_REPORT_CHANNEL_ID,
        pending_confirmations: pendingConfirmations.size,
        cached_users: userProfileCache.size,
        last_seen_channel_id: lastSeenChannel?.channelId || null,
        last_seen_channel_at: lastSeenChannel?.seenAt || null,
    });
});

router.get('/freee-bot/debug', async (req, res) => {
    const results = {
        lineworks: {
            has_client_id: !!process.env.LINEWORKS_CLIENT_ID,
            has_bot_id: !!process.env.FREEE_BOT_ID,
        },
        freee: {
            has_client_id: !!process.env.FREEE_CLIENT_ID,
            has_access_token: !!process.env.FREEE_ACCESS_TOKEN,
        },
        gemini: {
            has_api_key: !!process.env.GEMINI_API_KEY,
        },
        daily_report: {
            destination: process.env.DAILY_REPORT_CHANNEL_ID ? 'channel' : 'dm',
            configured_channel_id: process.env.DAILY_REPORT_CHANNEL_ID || null,
            last_seen_channel_id: lastSeenChannel?.channelId || null,
            last_seen_channel_at: lastSeenChannel?.seenAt || null,
        },
        lineworks_auth_test: null,
        freee_auth_test: null,
    };

    try {
        const token = await getAccessToken();
        results.lineworks_auth_test = {
            success: true,
            token_present: !!token,
        };
    } catch (error) {
        results.lineworks_auth_test = {
            success: false,
            error: error.message,
        };
    }

    try {
        const token = await freeeAuth.getFreeeAccessToken();
        results.freee_auth_test = {
            success: true,
            token_present: !!token,
        };
    } catch (error) {
        results.freee_auth_test = {
            success: false,
            error: error.message,
        };
    }

    res.json(results);
});

module.exports = router;
