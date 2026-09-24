// Secure CLIENT account provisioning / password reset (server-side only, never frontend).
// Usage:  node scripts/create_client.js "Full Name" "email@example.com" "Password123"
//  - Existing email -> resets password_hash (bcrypt) and forces role='client', is_active=TRUE.
//                       name/phone of the existing row are PRESERVED.
//  - New email      -> inserts a new CLIENT account.
//  - Never stores plain text; only a bcrypt hash goes to PostgreSQL.
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function createClient(name, email, password) {
  email = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) throw new Error('Name required (2+ characters).');
  if (!EMAIL_RE.test(email)) throw new Error('Valid email required.');
  if (!(typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password)))
    throw new Error('Password must be 8+ chars with letters and numbers.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const hash = await bcrypt.hash(password, 10);
    const exists = await pool.query('SELECT id, name, phone, role FROM users WHERE email=$1', [email]);
    if (exists.rowCount > 0) {
      const prev = exists.rows[0];
      const upd = await pool.query(
        `UPDATE users
            SET role='client', password_hash=$1, is_active=TRUE, updated_at=NOW()
          WHERE email=$2
          RETURNING id, name, email, role, is_active`,
        [hash, email]);
      return { action: 'UPDATED', previous_role: prev.role, preserved_name: prev.name, user: upd.rows[0] };
    }
    const ins = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, is_active)
       VALUES ($1,$2,NULL,$3,'client',TRUE)
       RETURNING id, name, email, role, is_active`,
      [cleanName, email, hash]);
    return { action: 'CREATED', user: ins.rows[0] };
  } finally { await pool.end(); }
}

if (require.main === module) {
  // Accepts: node scripts/create_client.js <name words...> <email> <password>
  // (multi-word names safe: last two args are always email + password)
  const a = process.argv.slice(2);
  if (a.length < 3) { console.error('CLIENT_SETUP_FAILED: usage: node scripts/create_client.js "Full Name" email password'); process.exit(1); }
  const password = a[a.length - 1];
  const email = a[a.length - 2];
  const name = a.slice(0, a.length - 2).join(' ');
  createClient(name, email, password)
    .then((r) => {
      console.log(r.action + ' id=' + r.user.id + ' email=' + r.user.email + ' role=' + r.user.role + ' is_active=' + r.user.is_active +
        (r.action === 'UPDATED' ? ' (previous role=' + r.previous_role + ', name preserved="' + r.preserved_name + '")' : ''));
      process.exit(0);
    })
    .catch((e) => { console.error('CLIENT_SETUP_FAILED: ' + e.message); process.exit(1); });
}

module.exports = { createClient };
