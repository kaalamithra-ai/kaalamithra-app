const fs = require('fs');
const path = require('path');
// One-time hosted-DB bootstrap for Vercel: creates tables + seeds the default
// admin WITHOUT needing psql/Neon SQL editor. Guarded by ADMIN_SETUP_KEY so it
// can never be abused to wipe data (additive DDL only, no DROPs).
//   POST /api/setup  { "key": "<ADMIN_SETUP_KEY>" }
// Run once after setting DATABASE_URL on Vercel, then it reports "already ready".
const bcrypt = require('bcryptjs');
const { getPool } = require('../lib/db');
// Additive schema self-heal shared with boot + the read routes (lib/schema.js).
const { ensureSchema, schemaStatus } = require('../lib/schema');

module.exports = async function setupHandler(req, res) {
  try {
    const need = process.env.ADMIN_SETUP_KEY;
    if (!need)
      return res.status(500).json({ success: false, error: 'ADMIN_SETUP_KEY is not configured on this deployment.' });
    if (String((req.body && req.body.key) || '').trim() !== String(need).trim())
      return res.status(403).json({ success: false, error: 'Invalid setup key.' });
    const pool = getPool();
    if (!pool)
      return res.status(500).json({
        success: false,
        error: 'DATABASE_URL is not set. Add a hosted Postgres DATABASE_URL in Vercel env vars.',
      });
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
    const applied = [];
    await pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW())'
    );
    for (const f of files) {
      const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rowCount > 0) continue;
      await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
    }
    // Same self-heal as local boot and the read routes — single source of truth
    // in lib/schema.js, so a hosted DB created without these columns (and the
    // migration 001/002 columns the dashboards SELECT) is repaired here too.
    await ensureSchema(pool);
    const existing = await pool.query('SELECT id, role FROM users WHERE email=$1', ['admin@kaalamithra-ai.com']);
    let admin = 'exists';
    if (existing.rowCount === 0) {
      const hash = await bcrypt.hash('Admin@123', 10);
      await pool.query(
        "INSERT INTO users (name,email,password_hash,role,is_active) VALUES ($1,$2,$3,'admin',TRUE)",
        ['Admin', 'admin@kaalamithra-ai.com', hash]
      );
      admin = 'seeded (admin@kaalamithra-ai.com / Admin@123 — change it after login)';
    }
    const counts = await pool.query(
      'SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM inquiries) AS inquiries'
    );
    // Read-only proof that every column the dashboards need now exists.
    const schema = await schemaStatus(pool);
    res.json({
      success: true,
      applied,
      admin,
      counts: counts.rows[0],
      schema_ready: schema.ready,
      missing_columns: schema.missing,
    });
  } catch (e) {
    console.error('Setup error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
};