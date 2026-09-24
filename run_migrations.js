require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Simple sequential migration runner (no external migration tool in this project).
async function runMigrations() {
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) { console.log('No migrations directory.'); return process.exit(0); }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  // Track applied migrations; create tracking table if missing.
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW())`);
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount > 0) { console.log('SKIP (already applied): ' + f); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      console.log('APPLIED: ' + f);
    } catch (e) {
      console.error('FAILED: ' + f + ' -> ' + e.message);
      process.exit(1);
    }
  }
  console.log('Migrations complete.');
  process.exit(0);
}
runMigrations();
