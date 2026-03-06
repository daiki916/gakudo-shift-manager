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

    // API Routes
    const staffRouter = require('./routes/staff');
    const shiftsRouter = require('./routes/shifts');
    const lineworksRouter = require('./routes/lineworks');

    app.use('/api', staffRouter);
    app.use('/api', shiftsRouter);
    app.use('/api', lineworksRouter);

    // Server info API (for share tab to get base URL)
    app.get('/api/server-info', (req, res) => {
        // In production, use the request's host; locally, use LAN IP
        if (process.env.NODE_ENV === 'production') {
            res.json({ url: `https://${req.get('host')}` });
        } else {
            res.json({ ip: getLocalIP(), port: PORT });
        }
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
