const { getEmployees, getWorkRecord } = require('./freee-api');
const { sendChannelMessage, sendMessage } = require('./lineworks-auth');

function getYesterdayJST() {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
    return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

function parseDateParts(date) {
    const [year, month, day] = date.split('-').map(Number);
    const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

    return {
        year,
        month,
        day,
        dayName: dayNames[base.getUTCDay()],
    };
}

function formatTime(value) {
    if (!value) {
        return '--:--';
    }

    const match = String(value).match(/(?:T|\s)?(\d{2}):(\d{2})/);
    if (match) {
        return `${match[1]}:${match[2]}`;
    }

    return String(value);
}

function extractAttendanceTimes(record) {
    if (!record) {
        return { clockIn: null, clockOut: null };
    }

    let clockIn = record.clock_in_at || null;
    let clockOut = record.clock_out_at || null;

    if (Array.isArray(record.work_record_segments) && record.work_record_segments.length > 0) {
        const firstSegment = record.work_record_segments[0];
        const lastSegment = record.work_record_segments[record.work_record_segments.length - 1];
        clockIn = clockIn || firstSegment.clock_in_at || null;
        clockOut = clockOut || lastSegment.clock_out_at || null;
    }

    return { clockIn, clockOut };
}

function hasAnyAttendance(result) {
    return !!(result.clockIn || result.clockOut);
}

function classifyAttendance(result) {
    if (result.error) {
        return 'freee_error';
    }

    if (!result.clockIn || !result.clockOut) {
        return 'missing_punch';
    }

    return 'ok';
}

function sortKey(status) {
    const order = {
        freee_error: 0,
        missing_punch: 1,
        ok: 2,
    };

    return order[status] ?? 99;
}

async function buildAttendanceResults(date) {
    const data = await getEmployees();
    const employees = data.employees || [];
    const activeEmployees = employees.filter(employee => !employee.retire_date || employee.retire_date >= date);
    const results = [];

    for (const employee of activeEmployees) {
        try {
            const record = await getWorkRecord(employee.id, date);
            const { clockIn, clockOut } = extractAttendanceTimes(record);
            const result = {
                employeeId: employee.id,
                employeeName: employee.display_name || `${employee.last_name || ''} ${employee.first_name || ''}`.trim(),
                clockIn,
                clockOut,
            };

            if (!hasAnyAttendance(result)) {
                continue;
            }

            result.status = classifyAttendance(result);
            results.push(result);
        } catch (error) {
            results.push({
                employeeId: employee.id,
                employeeName: employee.display_name || `${employee.last_name || ''} ${employee.first_name || ''}`.trim(),
                error: error.message,
                status: 'freee_error',
            });
        }
    }

    results.sort((left, right) => {
        const byStatus = sortKey(left.status) - sortKey(right.status);
        if (byStatus !== 0) {
            return byStatus;
        }

        return left.employeeName.localeCompare(right.employeeName, 'ja');
    });

    return results;
}

function buildIssueLine(result) {
    if (result.status === 'freee_error') {
        return `- freee取得エラー: ${result.employeeName}`;
    }

    return `- 打刻漏れ: ${result.employeeName} / 実績 ${formatTime(result.clockIn)}-${formatTime(result.clockOut)}`;
}

function buildOkLine(result) {
    return `- ${result.employeeName} / 実績 ${formatTime(result.clockIn)}-${formatTime(result.clockOut)}`;
}

function buildMessage(date, results) {
    const { month, day, dayName } = parseDateParts(date);
    const issues = results.filter(result => result.status !== 'ok');
    const okResults = results.filter(result => result.status === 'ok');
    const stats = {
        date,
        attended: results.filter(result => result.status !== 'freee_error').length,
        issues: issues.length,
        freeeErrors: results.filter(result => result.status === 'freee_error').length,
        missingPunch: results.filter(result => result.status === 'missing_punch').length,
        ok: okResults.length,
    };

    if (results.length === 0) {
        return {
            message: `勤怠修正BOT 前日レポート (${month}/${day} ${dayName})\n\n前日に打刻があった人は 0 名でした。`,
            stats,
        };
    }

    const lines = [
        `勤怠修正BOT 前日レポート (${month}/${day} ${dayName})`,
        '',
        `打刻者: ${stats.attended}名`,
        `要確認: ${stats.issues}名`,
        '',
    ];

    if (issues.length > 0) {
        lines.push('要確認');
        for (const issue of issues) {
            lines.push(buildIssueLine(issue));
        }
        lines.push('');
    }

    if (okResults.length > 0) {
        lines.push('確認済み');
        for (const item of okResults) {
            lines.push(buildOkLine(item));
        }
    }

    return {
        message: lines.join('\n').trim(),
        stats,
    };
}

async function generateDailyReport(targetDate) {
    const date = targetDate || getYesterdayJST();
    const results = await buildAttendanceResults(date);
    return buildMessage(date, results);
}

async function sendDailyReport(targetDate) {
    const { message, stats } = await generateDailyReport(targetDate);
    const botId = process.env.FREEE_BOT_ID;
    const channelId = process.env.DAILY_REPORT_CHANNEL_ID || '';
    const recipientId = process.env.DAILY_REPORT_RECIPIENT || '452ff3c7-cf67-4a86-169c-043d41306310';

    if (channelId) {
        await sendChannelMessage(channelId, message, botId);
    } else {
        await sendMessage(recipientId, message, botId);
    }

    return {
        ...stats,
        destination: channelId ? 'channel' : 'dm',
    };
}

module.exports = {
    generateDailyReport,
    getYesterdayJST,
    sendDailyReport,
};
