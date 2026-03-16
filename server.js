const express = require('express');
const path = require('path');
const os = require('os');
const { initDB } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Get local network IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

async function startServer() {
    // Initialize database
    await initDB();
    console.log('✅ Database initialized');

    // ============================================================
    // API Routes — シフト管理
    // ============================================================
    const staffRouter = require('./routes/staff');
    const shiftsRouter = require('./routes/shifts');
    const lineworksRouter = require('./routes/lineworks');     // シフトBOT

    app.use('/api', staffRouter);
    app.use('/api', shiftsRouter);
    app.use('/api', lineworksRouter);

    // ============================================================
    // API Routes — freee勤怠BOT
    // ============================================================
    const lineworksFreeeRouter = require('./routes/lineworks-freee');  // freee BOT
    app.use('/api', lineworksFreeeRouter);

    // freee OAuth2 flow
    app.get('/auth/freee', (req, res) => {
        const { getAuthorizationUrl } = require('./services/freee-auth');
        res.redirect(getAuthorizationUrl());
    });
    app.get('/callback/freee', async (req, res) => {
        const { code } = req.query;
        if (!code) return res.status(400).json({ error: '認可コードがありません' });
        try {
            const { exchangeCode, getFreeeAccessToken } = require('./services/freee-auth');
            const result = await exchangeCode(code);
            console.log('✅ freee OAuth success, token_saved:', !!result.access_token);
            res.json({
                status: 'success',
                message: 'freee認証が完了しました！BOTが利用可能です。',
                token_saved: true,
            });
        } catch (err) {
            console.error('❌ freee OAuth error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // freee従業員一覧
    app.get('/api/freee/employees', async (req, res) => {
        try {
            const { getEmployees } = require('./services/freee-api');
            const data = await getEmployees();
            const employees = (data.employees || []).map(e => ({
                id: e.id, name: `${e.last_name} ${e.first_name}`, display_name: e.display_name,
            }));
            res.json({ count: employees.length, employees: employees.slice(0, 5) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // freee会計API プロキシ（ローカルスクリプト用）
    app.get('/api/freee/accounting/*', async (req, res) => {
        try {
            const freeeAuth = require('./services/freee-auth');
            const token = await freeeAuth.getFreeeAccessToken();
            const companyId = process.env.FREEE_COMPANY_ID;
            const apiPath = req.params[0];
            const qs = new URLSearchParams(req.query);
            if (!qs.has('company_id')) qs.set('company_id', companyId);
            const freeeUrl = `https://api.freee.co.jp/api/1/${apiPath}?${qs.toString()}`;
            const isBinary = apiPath.includes('/download');

            const https = require('https');
            const u = new URL(freeeUrl);
            const freeeReq = https.request({
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
            }, freeeRes => {
                if (isBinary) {
                    // バイナリ（画像等）はそのまま転送
                    res.status(freeeRes.statusCode);
                    res.set('Content-Type', freeeRes.headers['content-type'] || 'application/octet-stream');
                    freeeRes.pipe(res);
                } else {
                    // JSONレスポンス
                    let data = '';
                    freeeRes.on('data', chunk => data += chunk);
                    freeeRes.on('end', () => {
                        try {
                            res.status(freeeRes.statusCode).json(JSON.parse(data));
                        } catch {
                            res.status(freeeRes.statusCode).send(data);
                        }
                    });
                }
            });
            freeeReq.on('error', err => res.status(500).json({ error: err.message }));
            freeeReq.end();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 日次レポート
    app.post('/api/daily-report', async (req, res) => {
        try {
            const { sendDailyReport } = require('./services/daily-report');
            const stats = await sendDailyReport(req.body?.date || null);
            res.json({ status: 'sent', ...stats });
        } catch (err) {
            console.error('❌ Daily report error:', err);
            res.status(500).json({ error: err.message });
        }
    });
    app.get('/api/daily-report', async (req, res) => {
        try {
            const { generateDailyReport, sendDailyReport } = require('./services/daily-report');
            const date = req.query.date || null;
            if (req.query.send === 'true') {
                const stats = await sendDailyReport(date);
                return res.json({ status: 'sent', ...stats });
            }
            const { message, stats } = await generateDailyReport(date);
            res.json({ status: 'preview', message, ...stats });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ============================================================
    // Server info & Health check
    // ============================================================
    app.get('/api/server-info', (req, res) => {
        if (process.env.NODE_ENV === 'production') {
            res.json({ url: `https://${req.get('host')}` });
        } else {
            res.json({ ip: getLocalIP(), port: PORT });
        }
    });
    app.get('/', (req, res) => {
        res.json({
            service: '学童シフト管理 + freee勤怠 統合BOT',
            status: 'ok',
            bots: {
                shift_bot: { callback: '/api/lineworks/callback', status: '/api/lineworks/status' },
                freee_bot: { callback: '/api/freee-bot/callback', status: '/api/freee-bot/status' },
            },
            endpoints: {
                admin: '/admin', daily_report: '/api/daily-report',
                freee_auth: '/auth/freee', freee_employees: '/api/freee/employees',
            },
        });
    });

    // SPA fallback routes
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
    });
    app.get('/admin/*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
    });
    app.get('/staff/:clubId', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'staff', 'index.html'));
    });

    // Start server on all interfaces
    const localIP = getLocalIP();
    app.listen(PORT, HOST, () => {
        console.log('');
        console.log('========================================');
        console.log('  📋 にこにこおひさまクラブ シフト管理');
        console.log('========================================');
        console.log(`  🖥️  管理画面:  http://localhost:${PORT}/admin`);
        if (process.env.NODE_ENV !== 'production') {
            console.log(`  📱 スマホ:    http://${localIP}:${PORT}`);
            console.log('----------------------------------------');
            console.log('  クラブ別スタッフ入力:');
            for (let i = 1; i <= 6; i++) {
                console.log(`    クラブ${i}: http://${localIP}:${PORT}/staff/${i}`);
            }
        }
        console.log('========================================');
        console.log('');
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
