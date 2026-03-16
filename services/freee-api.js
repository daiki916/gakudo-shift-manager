const https = require('https');
const { clearCachedAccessToken, getFreeeAccessToken } = require('./freee-auth');

let employeeCache = null;
let employeeCacheExpiresAt = 0;

async function freeeRequest(method, path, body = null) {
    const token = await getFreeeAccessToken();
    const bodyString = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.freee.co.jp',
            path,
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(bodyString ? { 'Content-Length': Buffer.byteLength(bodyString) } : {}),
            },
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 401) {
                        clearCachedAccessToken();
                        reject(new Error('freee token expired. Retrying...'));
                        return;
                    }

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data ? JSON.parse(data) : {});
                        return;
                    }

                    reject(new Error(`freee API ${res.statusCode}: ${data}`));
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);
        if (bodyString) {
            req.write(bodyString);
        }
        req.end();
    });
}

async function freeeRequestWithRetry(method, path, body = null) {
    try {
        return await freeeRequest(method, path, body);
    } catch (error) {
        if (error.message.includes('token expired')) {
            return freeeRequest(method, path, body);
        }

        throw error;
    }
}

async function getEmployees() {
    const companyId = process.env.FREEE_COMPANY_ID;
    if (!companyId) {
        throw new Error('FREEE_COMPANY_ID is not set.');
    }

    if (employeeCache && Date.now() < employeeCacheExpiresAt) {
        return employeeCache;
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const result = await freeeRequestWithRetry(
        'GET',
        `/hr/api/v1/employees?company_id=${companyId}&year=${year}&month=${month}&limit=100`
    );

    employeeCache = result;
    employeeCacheExpiresAt = Date.now() + 10 * 60 * 1000;
    return result;
}

function normalizeEmployee(employee) {
    const profile = employee.profile_rule || {};
    const parts = (employee.display_name || '').trim().split(/\s+/);

    return {
        id: employee.id,
        last_name: profile.last_name || parts[0] || '',
        first_name: profile.first_name || parts[1] || '',
        display_name: employee.display_name || `${profile.last_name || ''} ${profile.first_name || ''}`.trim(),
    };
}

async function findEmployeeByName(lastName, firstName) {
    const data = await getEmployees();
    const employees = data.employees || [];
    const fullName = `${lastName} ${firstName}`.trim();
    const compactName = `${lastName}${firstName}`.trim();

    let match = employees.find(employee => employee.display_name === fullName);
    if (match) {
        return normalizeEmployee(match);
    }

    match = employees.find(employee => {
        const profile = employee.profile_rule;
        return profile && profile.last_name === lastName && profile.first_name === firstName;
    });
    if (match) {
        return normalizeEmployee(match);
    }

    const lastNameMatches = employees.filter(employee =>
        employee.display_name && employee.display_name.includes(lastName)
    );
    if (lastNameMatches.length === 1) {
        return normalizeEmployee(lastNameMatches[0]);
    }

    const profileMatches = employees.filter(employee =>
        employee.profile_rule && employee.profile_rule.last_name === lastName
    );
    if (profileMatches.length === 1) {
        return normalizeEmployee(profileMatches[0]);
    }

    match = employees.find(employee => {
        if (!employee.display_name) {
            return false;
        }

        const displayName = employee.display_name.replace(/\s/g, '');
        return displayName === compactName || displayName.includes(compactName) || compactName.includes(displayName);
    });

    return match ? normalizeEmployee(match) : null;
}

async function getWorkRecord(employeeId, date) {
    const companyId = process.env.FREEE_COMPANY_ID;
    return freeeRequestWithRetry(
        'GET',
        `/hr/api/v1/employees/${employeeId}/work_records/${date}?company_id=${companyId}`
    );
}

async function updateWorkRecord(employeeId, date, data) {
    const companyId = process.env.FREEE_COMPANY_ID;
    if (!companyId) {
        throw new Error('FREEE_COMPANY_ID is not set.');
    }

    function toFreeeTime(value) {
        if (!value) {
            return null;
        }

        // Remove timezone offset if present (e.g., +09:00)
        const match = value.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
        if (!match) {
            return value;
        }

        const timePart = match[2].length === 5 ? `${match[2]}:00` : match[2];
        return `${match[1]} ${timePart}`;
    }

    const body = { company_id: parseInt(companyId, 10) };
    let clockIn = toFreeeTime(data.clock_in_at);
    let clockOut = toFreeeTime(data.clock_out_at);

    // If only one of clock_in/clock_out is being updated, fetch existing record to fill in the other
    if ((clockIn && !clockOut) || (!clockIn && clockOut)) {
        try {
            const existing = await getWorkRecord(employeeId, date);
            if (!clockIn && existing.clock_in_at) {
                clockIn = toFreeeTime(existing.clock_in_at);
            }
            if (!clockOut && existing.clock_out_at) {
                clockOut = toFreeeTime(existing.clock_out_at);
            }
        } catch (err) {
            console.warn('Could not fetch existing work record for merge:', err.message);
        }
    }

    if (clockIn || clockOut) {
        const segment = {};
        if (clockIn) segment.clock_in_at = clockIn;
        if (clockOut) segment.clock_out_at = clockOut;
        body.work_record_segments = [segment];
    }

    if (Array.isArray(data.break_records) && data.break_records.length > 0) {
        body.break_records = data.break_records.map(item => ({
            clock_in_at: toFreeeTime(item.clock_in_at),
            clock_out_at: toFreeeTime(item.clock_out_at),
        }));
    }

    console.log('[freee API] updateWorkRecord body:', JSON.stringify(body));

    return freeeRequestWithRetry(
        'PUT',
        `/hr/api/v1/employees/${employeeId}/work_records/${date}`,
        body
    );
}

async function getWorkRecords(employeeId, startDate, endDate) {
    const records = [];
    const current = new Date(startDate);
    const last = new Date(endDate);

    while (current <= last) {
        const date = current.toISOString().slice(0, 10);
        try {
            records.push(await getWorkRecord(employeeId, date));
        } catch (error) {
            records.push({ date, error: error.message });
        }

        current.setDate(current.getDate() + 1);
    }

    return records;
}

module.exports = {
    findEmployeeByName,
    getEmployees,
    getWorkRecord,
    getWorkRecords,
    updateWorkRecord,
};
