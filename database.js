const { Pool } = require('pg');

// Fixed org ID for single-organization mode
const ORG_ID = 'nikoniko-ohisama';
const ORG_NAME = 'にこにこおひさまクラブ';
const ADMIN_PASSWORD = '';

let pool = null;

async function initDB() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  // Test connection
  const client = await pool.connect();
  console.log('✅ PostgreSQL connected');

  try {
    // Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        admin_password TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS clubs (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        login_id TEXT UNIQUE,
        password TEXT DEFAULT ''
      )
    `);

    // Add login columns to existing clubs table
    try { await client.query('ALTER TABLE clubs ADD COLUMN IF NOT EXISTS login_id TEXT UNIQUE'); } catch (e) { }
    try { await client.query('ALTER TABLE clubs ADD COLUMN IF NOT EXISTS password TEXT DEFAULT \'\''); } catch (e) { }

    await client.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
        name TEXT NOT NULL,
        pay_type TEXT NOT NULL CHECK(pay_type IN ('hourly', 'monthly')),
        hourly_rate INTEGER DEFAULT 0,
        monthly_salary INTEGER DEFAULT 0,
        commute_allowance INTEGER DEFAULT 0,
        qualification_allowance INTEGER DEFAULT 0,
        other_allowance INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Add allowance columns to existing table (safe to run multiple times)
    const alterQueries = [
      'ALTER TABLE staff ADD COLUMN IF NOT EXISTS commute_allowance INTEGER DEFAULT 0',
      'ALTER TABLE staff ADD COLUMN IF NOT EXISTS qualification_allowance INTEGER DEFAULT 0',
      'ALTER TABLE staff ADD COLUMN IF NOT EXISTS other_allowance INTEGER DEFAULT 0',
      'ALTER TABLE staff ADD COLUMN IF NOT EXISTS lineworks_id TEXT DEFAULT NULL',
    ];
    for (const q of alterQueries) {
      try { await client.query(q); } catch (e) { /* column may already exist */ }
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_requests (
        id SERIAL PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        is_available INTEGER DEFAULT 1,
        note TEXT DEFAULT '',
        submitted_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        break_minutes INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'confirmed')),
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_patterns (
        id SERIAL PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        color TEXT DEFAULT '#3B82F6',
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create indexes (ignore if they already exist)
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_staff_org ON staff(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_staff_club ON staff(club_id)',
      'CREATE INDEX IF NOT EXISTS idx_shift_requests_org ON shift_requests(org_id, year, month)',
      'CREATE INDEX IF NOT EXISTS idx_shift_requests_staff ON shift_requests(staff_id, date)',
      'CREATE INDEX IF NOT EXISTS idx_shifts_org ON shifts(org_id, date)',
      'CREATE INDEX IF NOT EXISTS idx_shifts_staff ON shifts(staff_id, date)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_unique ON shifts(staff_id, date)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_unique ON shift_requests(staff_id, date)',
    ];
    for (const sql of indexes) {
      try { await client.query(sql); } catch (e) { /* index may already exist */ }
    }

    // Seed default organization
    const orgResult = await client.query('SELECT * FROM organizations WHERE id = $1', [ORG_ID]);
    if (orgResult.rows.length === 0) {
      await client.query(
        'INSERT INTO organizations (id, name, code, admin_password) VALUES ($1, $2, $3, $4)',
        [ORG_ID, ORG_NAME, 'MASTER', ADMIN_PASSWORD]
      );
    }

    // Seed 6 clubs with login credentials
    const clubAccounts = [
      { id: 1, name: 'クラブ1', login_id: 'club1', password: 'niko2025c1' },
      { id: 2, name: 'クラブ2', login_id: 'club2', password: 'niko2025c2' },
      { id: 3, name: 'クラブ3', login_id: 'club3', password: 'niko2025c3' },
      { id: 4, name: 'クラブ4', login_id: 'club4', password: 'niko2025c4' },
      { id: 5, name: 'クラブ5', login_id: 'club5', password: 'niko2025c5' },
      { id: 6, name: 'クラブ6', login_id: 'club6', password: 'niko2025c6' },
    ];
    for (const club of clubAccounts) {
      const clubResult = await client.query('SELECT * FROM clubs WHERE id = $1', [club.id]);
      if (clubResult.rows.length === 0) {
        await client.query(
          'INSERT INTO clubs (id, name, display_order, login_id, password) VALUES ($1, $2, $3, $4, $5)',
          [club.id, club.name, club.id, club.login_id, club.password]
        );
      } else {
        // Update existing clubs with login credentials if not set
        await client.query(
          'UPDATE clubs SET login_id = $1, password = $2 WHERE id = $3 AND (login_id IS NULL OR login_id = \'\')',
          [club.login_id, club.password, club.id]
        );
      }
    }
  } finally {
    client.release();
  }

  return pool;
}

// Query helpers — same interface as before but async
async function queryAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows.length > 0 ? result.rows[0] : null;
}

async function runSQL(sql, params = []) {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount, rows: result.rows };
}

// Helper to get last inserted ID (for INSERT ... RETURNING id)
async function insertReturningId(sql, params = []) {
  const result = await pool.query(sql + ' RETURNING id', params);
  return result.rows[0]?.id;
}

module.exports = { initDB, queryAll, queryOne, runSQL, insertReturningId, ORG_ID, ORG_NAME };
