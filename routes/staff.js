const express = require('express');
const router = express.Router();
const { queryAll, queryOne, runSQL, insertReturningId, ORG_ID } = require('../database');
const { getOrgMembers } = require('../services/lineworks-auth');

// Get LINE WORKS members list
router.get('/lineworks-members', async (req, res) => {
    try {
        const members = await getOrgMembers();
        res.json(members.map(m => ({
            userId: m.userId,
            name: `${m.userName?.lastName || ''} ${m.userName?.firstName || ''}`.trim(),
            lastName: m.userName?.lastName || '',
            firstName: m.userName?.firstName || '',
            email: m.email || '',
        })));
    } catch (err) {
        console.error('Failed to get LINE WORKS members:', err);
        res.status(500).json({ error: err.message });
    }
});

// Bulk link LINE WORKS IDs with staff (auto-match by name)
router.post('/staff/bulk-link-lineworks', async (req, res) => {
    try {
        // Get LINE WORKS members
        let lwMembers;
        try {
            lwMembers = await getOrgMembers();
        } catch (err) {
            return res.status(500).json({ error: 'LINE WORKSメンバーの取得に失敗: ' + err.message });
        }

        // Get all staff
        const allStaff = await queryAll('SELECT id, name, lineworks_id FROM staff WHERE org_id = $1 AND is_active = 1', [ORG_ID]);

        const results = { linked: [], already_linked: [], no_match: [], multiple_match: [] };

        for (const member of lwMembers) {
            const lastName = (member.userName?.lastName || '').trim();
            const firstName = (member.userName?.firstName || '').trim();
            const fullName = `${lastName} ${firstName}`.trim();
            const userId = member.userId;

            if (!lastName) continue;

            // Find matching staff
            const matches = allStaff.filter(s => {
                const staffName = s.name.replace(/\s+/g, ' ').trim();
                const staffParts = staffName.split(/\s+/);
                // Full name match
                if (staffName === fullName) return true;
                // Last name + first name match
                if (staffParts[0] === lastName && (staffParts.slice(1).join(' ') === firstName || !firstName)) return true;
                // Last name only match (if unique)
                if (staffParts[0] === lastName) return true;
                return false;
            });

            if (matches.length === 0) {
                results.no_match.push({ userId, name: fullName });
            } else if (matches.length > 1) {
                // Narrow down with full name match
                const exactMatch = matches.find(s => s.name.replace(/\s+/g, ' ').trim() === fullName);
                if (exactMatch) {
                    if (exactMatch.lineworks_id === userId) {
                        results.already_linked.push({ userId, name: fullName, staff_id: exactMatch.id, staff_name: exactMatch.name });
                    } else {
                        await runSQL('UPDATE staff SET lineworks_id = $1 WHERE id = $2', [userId, exactMatch.id]);
                        results.linked.push({ userId, name: fullName, staff_id: exactMatch.id, staff_name: exactMatch.name });
                    }
                } else {
                    results.multiple_match.push({ userId, name: fullName, candidates: matches.map(s => ({ id: s.id, name: s.name })) });
                }
            } else {
                const staff = matches[0];
                if (staff.lineworks_id === userId) {
                    results.already_linked.push({ userId, name: fullName, staff_id: staff.id, staff_name: staff.name });
                } else {
                    await runSQL('UPDATE staff SET lineworks_id = $1 WHERE id = $2', [userId, staff.id]);
                    results.linked.push({ userId, name: fullName, staff_id: staff.id, staff_name: staff.name });
                }
            }
        }

        res.json({
            message: `${results.linked.length}件紐づけ完了、${results.already_linked.length}件紐づけ済み、${results.no_match.length}件マッチなし、${results.multiple_match.length}件複数候補`,
            ...results,
        });
    } catch (err) {
        console.error('Bulk link error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get all clubs
router.get('/clubs', async (req, res) => {
    try {
        const clubs = await queryAll('SELECT * FROM clubs ORDER BY display_order');
        res.json(clubs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'クラブ一覧の取得に失敗しました' });
    }
});

// Verify admin password (master admin)
router.post('/admin/verify', async (req, res) => {
    try {
        const org = await queryOne('SELECT * FROM organizations WHERE id = $1', [ORG_ID]);
        if (!org) return res.status(404).json({ error: '組織が見つかりません' });

        const { password } = req.body;
        if (org.admin_password && org.admin_password !== password) {
            return res.status(401).json({ error: 'パスワードが正しくありません' });
        }
        res.json({ success: true, role: 'admin', club_id: null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'エラーが発生しました' });
    }
});

// Club login (ID + password)
router.post('/club/login', async (req, res) => {
    try {
        const { login_id, password } = req.body;
        if (!login_id || !password) {
            return res.status(400).json({ error: 'IDとパスワードを入力してください' });
        }

        // Check master admin first (login_id: admin)
        if (login_id === 'admin') {
            const org = await queryOne('SELECT * FROM organizations WHERE id = $1', [ORG_ID]);
            if (org && (!org.admin_password || org.admin_password === password)) {
                return res.json({ success: true, role: 'admin', club_id: null, club_name: 'マスター管理者' });
            }
            return res.status(401).json({ error: 'パスワードが正しくありません' });
        }

        // Check club accounts
        const club = await queryOne('SELECT * FROM clubs WHERE login_id = $1', [login_id]);
        if (!club) {
            return res.status(401).json({ error: 'IDが見つかりません' });
        }
        if (club.password !== password) {
            return res.status(401).json({ error: 'パスワードが正しくありません' });
        }

        res.json({ success: true, role: 'club', club_id: club.id, club_name: club.name });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'ログインに失敗しました' });
    }
});

// Get all accounts (for admin)
router.get('/accounts', async (req, res) => {
    try {
        const clubs = await queryAll('SELECT id, name, login_id, password FROM clubs ORDER BY display_order');
        res.json({
            master: { login_id: 'admin', password: '', role: 'admin' },
            clubs: clubs.map(c => ({ id: c.id, name: c.name, login_id: c.login_id, password: c.password, role: 'club' })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'アカウント一覧の取得に失敗しました' });
    }
});

// Get all active staff (optionally filter by club_id)
router.get('/staff', async (req, res) => {
    try {
        const { club_id } = req.query;
        let sql = 'SELECT * FROM staff WHERE org_id = $1 AND is_active = 1';
        const params = [ORG_ID];

        if (club_id) {
            sql += ' AND club_id = $2';
            params.push(parseInt(club_id));
        }

        sql += ' ORDER BY club_id, display_order, name';
        const staffList = await queryAll(sql, params);
        res.json(staffList);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'スタッフ一覧の取得に失敗しました' });
    }
});

// Get all staff including inactive
router.get('/staff/all', async (req, res) => {
    try {
        const { club_id } = req.query;
        let sql = 'SELECT * FROM staff WHERE org_id = $1';
        const params = [ORG_ID];

        if (club_id) {
            sql += ' AND club_id = $2';
            params.push(parseInt(club_id));
        }

        sql += ' ORDER BY club_id, display_order, name';
        const staffList = await queryAll(sql, params);
        res.json(staffList);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'スタッフ一覧の取得に失敗しました' });
    }
});

// Add staff
router.post('/staff', async (req, res) => {
    try {
        const { name, pay_type, hourly_rate, monthly_salary, display_order, club_id } = req.body;
        if (!name) return res.status(400).json({ error: '名前は必須です' });
        if (!pay_type || !['hourly', 'monthly'].includes(pay_type)) {
            return res.status(400).json({ error: '給与タイプが不正です' });
        }

        const clubId = club_id || 1;
        const maxOrder = await queryOne(
            'SELECT MAX(display_order) as max_order FROM staff WHERE org_id = $1',
            [ORG_ID]
        );

        const newId = await insertReturningId(
            'INSERT INTO staff (org_id, club_id, name, pay_type, hourly_rate, monthly_salary, display_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [ORG_ID, clubId, name, pay_type, hourly_rate || 0, monthly_salary || 0,
                display_order ?? ((maxOrder?.max_order ?? 0) + 1)]
        );

        const newStaff = await queryOne('SELECT * FROM staff WHERE id = $1', [newId]);
        res.status(201).json(newStaff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'スタッフの追加に失敗しました' });
    }
});

// Update staff
router.put('/staff/:id', async (req, res) => {
    try {
        const { name, pay_type, hourly_rate, monthly_salary, commute_allowance, qualification_allowance, other_allowance, is_active, display_order, club_id, lineworks_id } = req.body;
        const staff = await queryOne('SELECT * FROM staff WHERE id = $1 AND org_id = $2', [parseInt(req.params.id), ORG_ID]);
        if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

        const updates = [];
        const params = [];
        let paramIdx = 1;

        if (name !== undefined) { updates.push(`name = $${paramIdx++}`); params.push(name); }
        if (pay_type !== undefined) { updates.push(`pay_type = $${paramIdx++}`); params.push(pay_type); }
        if (hourly_rate !== undefined) { updates.push(`hourly_rate = $${paramIdx++}`); params.push(hourly_rate); }
        if (monthly_salary !== undefined) { updates.push(`monthly_salary = $${paramIdx++}`); params.push(monthly_salary); }
        if (commute_allowance !== undefined) { updates.push(`commute_allowance = $${paramIdx++}`); params.push(commute_allowance); }
        if (qualification_allowance !== undefined) { updates.push(`qualification_allowance = $${paramIdx++}`); params.push(qualification_allowance); }
        if (other_allowance !== undefined) { updates.push(`other_allowance = $${paramIdx++}`); params.push(other_allowance); }
        if (is_active !== undefined) { updates.push(`is_active = $${paramIdx++}`); params.push(is_active); }
        if (display_order !== undefined) { updates.push(`display_order = $${paramIdx++}`); params.push(display_order); }
        if (club_id !== undefined) { updates.push(`club_id = $${paramIdx++}`); params.push(club_id); }
        if (lineworks_id !== undefined) { updates.push(`lineworks_id = $${paramIdx++}`); params.push(lineworks_id || null); }

        if (updates.length > 0) {
            params.push(parseInt(req.params.id), ORG_ID);
            await runSQL(`UPDATE staff SET ${updates.join(', ')} WHERE id = $${paramIdx++} AND org_id = $${paramIdx}`, params);
        }

        const updated = await queryOne('SELECT * FROM staff WHERE id = $1', [parseInt(req.params.id)]);
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'スタッフの更新に失敗しました' });
    }
});

// Delete staff (soft delete)
router.delete('/staff/:id', async (req, res) => {
    try {
        const staff = await queryOne('SELECT * FROM staff WHERE id = $1 AND org_id = $2', [parseInt(req.params.id), ORG_ID]);
        if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

        await runSQL('UPDATE staff SET is_active = 0 WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'スタッフの削除に失敗しました' });
    }
});

// Bulk import staff
router.post('/staff/bulk-import', async (req, res) => {
    try {
        const { staff_list } = req.body;
        if (!Array.isArray(staff_list) || staff_list.length === 0) {
            return res.status(400).json({ error: 'staff_list（配列）は必須です' });
        }

        // Get existing staff names to avoid duplicates
        const existing = await queryAll('SELECT name FROM staff WHERE org_id = $1', [ORG_ID]);
        const existingNames = new Set(existing.map(s => s.name.trim()));

        let imported = 0;
        let skipped = 0;
        const maxOrder = await queryOne('SELECT MAX(display_order) as max_order FROM staff WHERE org_id = $1', [ORG_ID]);
        let order = (maxOrder?.max_order ?? 0) + 1;

        for (const s of staff_list) {
            const name = (s.name || '').trim();
            if (!name) { skipped++; continue; }

            // Skip if already exists
            if (existingNames.has(name)) { skipped++; continue; }

            // Parse club from staff_master.json format (e.g. "5クラブ" → 5, "1クラブ" → 1)
            let clubId = 1;
            if (s.club_id) {
                clubId = parseInt(s.club_id) || 1;
            } else if (s.club) {
                const match = s.club.match(/(\d+)/);
                clubId = match ? parseInt(match[1]) : 1;
            }
            if (clubId < 1 || clubId > 6) clubId = 1;

            const payType = s.pay_type || 'hourly';
            const hourlyRate = s.hourly_rate || 0;
            const monthlySalary = s.monthly_salary || 0;

            await runSQL(
                'INSERT INTO staff (org_id, club_id, name, pay_type, hourly_rate, monthly_salary, display_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [ORG_ID, clubId, name, payType, hourlyRate, monthlySalary, order++]
            );
            existingNames.add(name);
            imported++;
        }

        res.json({
            success: true,
            message: `${imported}名をインポートしました（スキップ: ${skipped}名）`,
            imported,
            skipped
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'スタッフの一括インポートに失敗しました' });
    }
});

// Bulk update salary info (match by name)
router.post('/staff/bulk-update-salary', async (req, res) => {
    try {
        const { staff_list } = req.body;
        if (!Array.isArray(staff_list) || staff_list.length === 0) {
            return res.status(400).json({ error: 'staff_list（配列）は必須です' });
        }

        const existing = await queryAll('SELECT * FROM staff WHERE org_id = $1', [ORG_ID]);
        let updated = 0;
        let notFound = 0;

        for (const s of staff_list) {
            const name = (s.name || '').trim();
            if (!name) continue;

            const staff = existing.find(e => e.name.trim() === name);
            if (!staff) { notFound++; continue; }

            const payType = s.pay_type || staff.pay_type;
            const hourlyRate = s.hourly_rate !== undefined ? s.hourly_rate : staff.hourly_rate;
            const monthlySalary = s.monthly_salary !== undefined ? s.monthly_salary : staff.monthly_salary;
            const commuteAllowance = s.commute_allowance !== undefined ? s.commute_allowance : staff.commute_allowance;
            const qualAllowance = s.qualification_allowance !== undefined ? s.qualification_allowance : staff.qualification_allowance;
            const otherAllowance = s.other_allowance !== undefined ? s.other_allowance : staff.other_allowance;

            await runSQL(
                'UPDATE staff SET pay_type = $1, hourly_rate = $2, monthly_salary = $3, commute_allowance = $4, qualification_allowance = $5, other_allowance = $6 WHERE id = $7',
                [payType, hourlyRate, monthlySalary, commuteAllowance, qualAllowance, otherAllowance, staff.id]
            );
            updated++;
        }

        res.json({
            success: true,
            message: `${updated}名の給与情報を更新しました（未一致: ${notFound}名）`,
            updated,
            notFound
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '給与情報の一括更新に失敗しました' });
    }
});

module.exports = router;
