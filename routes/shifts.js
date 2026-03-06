const express = require('express');
const router = express.Router();
const { queryAll, queryOne, runSQL, insertReturningId, ORG_ID } = require('../database');

// ============================================================
// Shift Requests (スタッフが入力するシフト希望)
// ============================================================

router.get('/shift-requests', async (req, res) => {
    try {
        const { year, month, club_id } = req.query;
        if (!year || !month) return res.status(400).json({ error: 'yearとmonthは必須です' });

        let sql = `
      SELECT sr.*, s.name as staff_name, s.club_id
      FROM shift_requests sr
      JOIN staff s ON sr.staff_id = s.id
      WHERE sr.org_id = $1 AND sr.year = $2 AND sr.month = $3`;
        const params = [ORG_ID, parseInt(year), parseInt(month)];

        if (club_id) {
            sql += ' AND s.club_id = $4';
            params.push(parseInt(club_id));
        }

        sql += ' ORDER BY sr.date, s.display_order, s.name';
        const requests = await queryAll(sql, params);
        res.json(requests);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフト希望の取得に失敗しました' });
    }
});

router.post('/shift-requests', async (req, res) => {
    try {
        const { staff_id, year, month, requests } = req.body;
        if (!staff_id || !year || !month) {
            return res.status(400).json({ error: 'staff_id, year, monthは必須です' });
        }

        const staff = await queryOne('SELECT * FROM staff WHERE id = $1 AND org_id = $2', [staff_id, ORG_ID]);
        if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

        // Delete existing requests for this staff/month
        await runSQL('DELETE FROM shift_requests WHERE staff_id = $1 AND year = $2 AND month = $3', [staff_id, year, month]);

        // Insert new ones
        if (Array.isArray(requests)) {
            for (const r of requests) {
                if (r.is_available || r.start_time) {
                    await runSQL(`
            INSERT INTO shift_requests (org_id, staff_id, year, month, date, start_time, end_time, is_available, note)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [
                        ORG_ID, staff_id, year, month,
                        r.date, r.start_time || null, r.end_time || null,
                        r.is_available !== undefined ? r.is_available : 1,
                        r.note || ''
                    ]);
                }
            }
        }

        res.json({ success: true, message: 'シフト希望を保存しました' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフト希望の保存に失敗しました' });
    }
});

// ============================================================
// Shift Patterns (管理者が設定するシフトパターン)
// ============================================================

// Break calculation helper (labor standards law)
function calculateBreakMinutes(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const start = parseTime(startTime);
    const end = parseTime(endTime);
    const totalMinutes = end - start;
    if (totalMinutes > 480) return 60;  // 8時間超 → 60分
    if (totalMinutes > 360) return 45;  // 6時間超 → 45分
    return 0;
}

router.get('/shift-patterns', async (req, res) => {
    try {
        const patterns = await queryAll(
            'SELECT * FROM shift_patterns WHERE org_id = $1 ORDER BY display_order, name',
            [ORG_ID]
        );
        res.json(patterns);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'パターンの取得に失敗しました' });
    }
});

router.post('/shift-patterns', async (req, res) => {
    try {
        const { name, start_time, end_time, color } = req.body;
        if (!name || !start_time || !end_time) {
            return res.status(400).json({ error: 'name, start_time, end_timeは必須です' });
        }
        const maxOrder = await queryOne('SELECT MAX(display_order) as m FROM shift_patterns WHERE org_id = $1', [ORG_ID]);
        const order = (maxOrder?.m || 0) + 1;
        const newId = await insertReturningId(
            'INSERT INTO shift_patterns (org_id, name, start_time, end_time, color, display_order) VALUES ($1, $2, $3, $4, $5, $6)',
            [ORG_ID, name, start_time, end_time, color || '#3B82F6', order]
        );
        const pattern = await queryOne('SELECT * FROM shift_patterns WHERE id = $1', [newId]);
        res.json(pattern);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'パターンの追加に失敗しました' });
    }
});

router.put('/shift-patterns/:id', async (req, res) => {
    try {
        const { name, start_time, end_time, color } = req.body;
        const pattern = await queryOne('SELECT * FROM shift_patterns WHERE id = $1 AND org_id = $2',
            [parseInt(req.params.id), ORG_ID]);
        if (!pattern) return res.status(404).json({ error: 'パターンが見つかりません' });

        await runSQL('UPDATE shift_patterns SET name = $1, start_time = $2, end_time = $3, color = $4 WHERE id = $5',
            [name || pattern.name, start_time || pattern.start_time, end_time || pattern.end_time,
            color || pattern.color, parseInt(req.params.id)]);

        const updated = await queryOne('SELECT * FROM shift_patterns WHERE id = $1', [parseInt(req.params.id)]);
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'パターンの更新に失敗しました' });
    }
});

router.delete('/shift-patterns/:id', async (req, res) => {
    try {
        const pattern = await queryOne('SELECT * FROM shift_patterns WHERE id = $1 AND org_id = $2',
            [parseInt(req.params.id), ORG_ID]);
        if (!pattern) return res.status(404).json({ error: 'パターンが見つかりません' });

        await runSQL('DELETE FROM shift_patterns WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'パターンの削除に失敗しました' });
    }
});

// Break calculation API
router.get('/calculate-break', (req, res) => {
    const { start_time, end_time } = req.query;
    res.json({ break_minutes: calculateBreakMinutes(start_time, end_time) });
});

// ============================================================
// Confirmed Shifts (管理者が確定するシフト)
// ============================================================

router.get('/shifts', async (req, res) => {
    try {
        const { year, month, club_id } = req.query;
        if (!year || !month) return res.status(400).json({ error: 'yearとmonthは必須です' });

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

        let sql = `
      SELECT sh.*, s.name as staff_name, s.pay_type, s.hourly_rate, s.monthly_salary, s.club_id
      FROM shifts sh
      JOIN staff s ON sh.staff_id = s.id
      WHERE sh.org_id = $1 AND sh.date >= $2 AND sh.date <= $3`;
        const params = [ORG_ID, startDate, endDate];

        if (club_id) {
            sql += ' AND s.club_id = $4';
            params.push(parseInt(club_id));
        }

        sql += ' ORDER BY sh.date, s.display_order, s.name';
        const shifts = await queryAll(sql, params);
        res.json(shifts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフトの取得に失敗しました' });
    }
});

// Apply shift requests to confirmed shifts
router.post('/shifts/apply-requests', async (req, res) => {
    try {
        const { year, month, overwrite, club_id } = req.body;
        if (!year || !month) return res.status(400).json({ error: 'yearとmonthは必須です' });

        let sql = `
      SELECT sr.* FROM shift_requests sr
      JOIN staff s ON sr.staff_id = s.id
      WHERE sr.org_id = $1 AND sr.year = $2 AND sr.month = $3 AND sr.is_available = 1`;
        const params = [ORG_ID, parseInt(year), parseInt(month)];

        if (club_id) {
            sql += ' AND s.club_id = $4';
            params.push(parseInt(club_id));
        }

        const requests = await queryAll(sql, params);

        let count = 0;
        for (const r of requests) {
            const breakMin = calculateBreakMinutes(r.start_time, r.end_time);
            if (overwrite) {
                await runSQL('DELETE FROM shifts WHERE staff_id = $1 AND date = $2', [r.staff_id, r.date]);
                await runSQL(
                    'INSERT INTO shifts (org_id, staff_id, date, start_time, end_time, break_minutes, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [ORG_ID, r.staff_id, r.date, r.start_time, r.end_time, breakMin, r.note || '']
                );
                count++;
            } else {
                const existing = await queryOne('SELECT id FROM shifts WHERE staff_id = $1 AND date = $2', [r.staff_id, r.date]);
                if (!existing) {
                    await runSQL(
                        'INSERT INTO shifts (org_id, staff_id, date, start_time, end_time, break_minutes, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                        [ORG_ID, r.staff_id, r.date, r.start_time, r.end_time, breakMin, r.note || '']
                    );
                    count++;
                }
            }
        }

        res.json({ success: true, message: `${count}件のシフトを転記しました`, count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフトの転記に失敗しました' });
    }
});

// Update a single shift
router.put('/shifts/:id', async (req, res) => {
    try {
        const { start_time, end_time, break_minutes, status, note } = req.body;
        const shift = await queryOne('SELECT * FROM shifts WHERE id = $1 AND org_id = $2', [parseInt(req.params.id), ORG_ID]);
        if (!shift) return res.status(404).json({ error: 'シフトが見つかりません' });

        const updates = [];
        const params = [];
        let paramIdx = 1;
        if (start_time !== undefined) { updates.push(`start_time = $${paramIdx++}`); params.push(start_time); }
        if (end_time !== undefined) { updates.push(`end_time = $${paramIdx++}`); params.push(end_time); }
        if (break_minutes !== undefined) { updates.push(`break_minutes = $${paramIdx++}`); params.push(break_minutes); }
        if (status !== undefined) { updates.push(`status = $${paramIdx++}`); params.push(status); }
        if (note !== undefined) { updates.push(`note = $${paramIdx++}`); params.push(note); }
        updates.push('updated_at = NOW()');

        if (updates.length > 0) {
            params.push(parseInt(req.params.id));
            await runSQL(`UPDATE shifts SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);
        }

        const updated = await queryOne('SELECT * FROM shifts WHERE id = $1', [parseInt(req.params.id)]);
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフトの更新に失敗しました' });
    }
});

// Add/upsert a single shift
router.post('/shifts', async (req, res) => {
    try {
        const { staff_id, date, start_time, end_time, break_minutes, note } = req.body;
        if (!staff_id || !date) return res.status(400).json({ error: 'staff_idとdateは必須です' });

        // Check if exists
        const existing = await queryOne('SELECT id FROM shifts WHERE staff_id = $1 AND date = $2', [staff_id, date]);
        if (existing) {
            await runSQL(
                `UPDATE shifts SET start_time = $1, end_time = $2, break_minutes = $3, note = $4, 
         updated_at = NOW()
         WHERE staff_id = $5 AND date = $6`,
                [start_time || null, end_time || null, break_minutes || 0, note || '', staff_id, date]
            );
        } else {
            await runSQL(
                'INSERT INTO shifts (org_id, staff_id, date, start_time, end_time, break_minutes, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [ORG_ID, staff_id, date, start_time || null, end_time || null, break_minutes || 0, note || '']
            );
        }

        const shift = await queryOne('SELECT * FROM shifts WHERE staff_id = $1 AND date = $2', [staff_id, date]);
        res.json(shift);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフトの追加に失敗しました' });
    }
});

// Delete a shift
router.delete('/shifts/:id', async (req, res) => {
    try {
        const shift = await queryOne('SELECT * FROM shifts WHERE id = $1 AND org_id = $2', [parseInt(req.params.id), ORG_ID]);
        if (!shift) return res.status(404).json({ error: 'シフトが見つかりません' });

        await runSQL('DELETE FROM shifts WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'シフトの削除に失敗しました' });
    }
});

// ============================================================
// Cost Simulation
// ============================================================

router.get('/cost-simulation', async (req, res) => {
    try {
        const { year, month, club_id } = req.query;
        if (!year || !month) return res.status(400).json({ error: 'yearとmonthは必須です' });

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

        let staffSql = 'SELECT * FROM staff WHERE org_id = $1 AND is_active = 1';
        const staffParams = [ORG_ID];
        if (club_id) {
            staffSql += ' AND club_id = $2';
            staffParams.push(parseInt(club_id));
        }
        staffSql += ' ORDER BY display_order, name';

        const staffList = await queryAll(staffSql, staffParams);

        const shifts = await queryAll(
            'SELECT * FROM shifts WHERE org_id = $1 AND date >= $2 AND date <= $3',
            [ORG_ID, startDate, endDate]
        );

        const results = staffList.map(staff => {
            const staffShifts = shifts.filter(s => s.staff_id === staff.id);
            let totalMinutes = 0;
            let totalDays = staffShifts.length;

            for (const shift of staffShifts) {
                if (shift.start_time && shift.end_time) {
                    const start = parseTime(shift.start_time);
                    const end = parseTime(shift.end_time);
                    const worked = end - start - (shift.break_minutes || 0);
                    if (worked > 0) totalMinutes += worked;
                }
            }

            const totalHours = totalMinutes / 60;
            const allowanceTotal = (staff.commute_allowance || 0) + (staff.qualification_allowance || 0) + (staff.other_allowance || 0);
            let baseCost = 0;
            if (staff.pay_type === 'hourly') {
                baseCost = Math.round(totalHours * staff.hourly_rate);
            } else {
                baseCost = staff.monthly_salary;
            }
            const cost = baseCost + allowanceTotal;

            return {
                staff_id: staff.id,
                staff_name: staff.name,
                club_id: staff.club_id,
                pay_type: staff.pay_type,
                hourly_rate: staff.hourly_rate,
                monthly_salary: staff.monthly_salary,
                commute_allowance: staff.commute_allowance || 0,
                qualification_allowance: staff.qualification_allowance || 0,
                other_allowance: staff.other_allowance || 0,
                allowance_total: allowanceTotal,
                total_days: totalDays,
                total_hours: Math.round(totalHours * 10) / 10,
                total_minutes: totalMinutes,
                base_cost: baseCost,
                cost: cost
            };
        });

        const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
        const totalAllowance = results.reduce((sum, r) => sum + r.allowance_total, 0);
        const hourlyTotal = results.filter(r => r.pay_type === 'hourly').reduce((sum, r) => sum + r.cost, 0);
        const monthlyTotal = results.filter(r => r.pay_type === 'monthly').reduce((sum, r) => sum + r.cost, 0);

        res.json({
            year: parseInt(year),
            month: parseInt(month),
            staff: results,
            summary: {
                total_cost: totalCost,
                total_allowance: totalAllowance,
                hourly_staff_cost: hourlyTotal,
                monthly_staff_cost: monthlyTotal,
                staff_count: staffList.length,
                hourly_count: results.filter(r => r.pay_type === 'hourly').length,
                monthly_count: results.filter(r => r.pay_type === 'monthly').length
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '人件費計算に失敗しました' });
    }
});

// CSV Export
router.get('/shifts/export-csv', async (req, res) => {
    try {
        const { year, month } = req.query;
        if (!year || !month) return res.status(400).json({ error: 'yearとmonthは必須です' });

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

        const shifts = await queryAll(`
      SELECT sh.date, s.name as staff_name, s.pay_type, s.hourly_rate, s.monthly_salary,
             sh.start_time, sh.end_time, sh.break_minutes, sh.status
      FROM shifts sh
      JOIN staff s ON sh.staff_id = s.id
      WHERE sh.org_id = $1 AND sh.date >= $2 AND sh.date <= $3
      ORDER BY sh.date, s.display_order, s.name
    `, [ORG_ID, startDate, endDate]);

        const BOM = '\uFEFF';
        let csv = BOM + '日付,スタッフ名,給与タイプ,時給,月給,出勤時刻,退勤時刻,休憩(分),ステータス,勤務時間(h),人件費(円)\n';

        for (const s of shifts) {
            let hours = 0;
            let cost = 0;
            if (s.start_time && s.end_time) {
                const minutes = parseTime(s.end_time) - parseTime(s.start_time) - (s.break_minutes || 0);
                hours = Math.round(minutes / 60 * 10) / 10;
                cost = s.pay_type === 'hourly' ? Math.round(hours * s.hourly_rate) : 0;
            }
            const payTypeLabel = s.pay_type === 'hourly' ? '時給' : '月給';
            csv += `${s.date},${s.staff_name},${payTypeLabel},${s.hourly_rate},${s.monthly_salary},${s.start_time || ''},${s.end_time || ''},${s.break_minutes || 0},${s.status},${hours},${cost}\n`;
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="shifts_${year}_${month}.csv"`);
        res.send(csv);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'CSVエクスポートに失敗しました' });
    }
});

function parseTime(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

module.exports = router;
