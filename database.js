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
        display_order INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
        name TEXT NOT NULL,
        pay_type TEXT NOT NULL CHECK(pay_type IN ('hourly', 'monthly')),
        hourly_rate INTEGER DEFAULT 0,
        monthly_salary INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

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

    // Seed 6 clubs
    for (let i = 1; i <= 6; i++) {
      const clubResult = await client.query('SELECT * FROM clubs WHERE id = $1', [i]);
      if (clubResult.rows.length === 0) {
        await client.query('INSERT INTO clubs (id, name, display_order) VALUES ($1, $2, $3)', [i, `クラブ${i}`, i]);
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
