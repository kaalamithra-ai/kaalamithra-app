// Secure admin provisioning / promotion (NOT a public signup).
// Requires the ADMIN_SETUP_KEY secret from .env — there is no admin signup route.
// Usage:  node scripts/create_admin.js "Full Name" "admin@x.com" "StrongPass1" "<ADMIN_SETUP_KEY>"
//
// Behaviour:
//  - Existing email  -> promotes to role='admin', resets password_hash (bcrypt), is_active=TRUE.
//                       name/phone of the existing row are PRESERVED (not clobbered).
//  - New email       -> inserts a new user with role='admin'.
//  - Never stores plain text; only a bcrypt hash goes to PostgreSQL.
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function createAdmin(name, email, password, key) {
  const need = process.env.ADMIN_SETUP_KEY;
  if (!need) throw new Error('ADMIN_SETUP_KEY is not configured in .env (refusing to create admin).');
  if (String(key || '').trim() !== String(need).trim()) throw new Error('Invalid setup key.');
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
            SET role='admin', password_hash=$1, is_active=TRUE, updated_at=NOW()
          WHERE email=$2
          RETURNING id, name, email, role, is_active`,
        [hash, email]);
      return { action: 'UPDATED', previous_role: prev.role, preserved_name: prev.name, user: upd.rows[0] };
    }
    const ins = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, is_active)
       VALUES ($1,$2,NULL,$3,'admin',TRUE)
       RETURNING id, name, email, role, is_active`,
      [cleanName, email, hash]);
    return { action: 'CREATED', user: ins.rows[0] };
  } finally { await pool.end(); }
}

if (require.main === module) {
  const [name, email, password, keyArg] = process.argv.slice(2);
  // The key may be passed as the 4th argument, or simply left in .env (ADMIN_SETUP_KEY).
  // Either way it is a server-side secret — there is no public/admin signup route.
  const key = keyArg || process.env.ADMIN_SETUP_KEY;
  console.log('args received: ' + process.argv.slice(2).length + ' (name, email, password, key' + (keyArg ? '' : ' from .env') + ')');
  createAdmin(name, email, password, key)
    .then((r) => {
      console.log(r.action + ' id=' + r.user.id + ' email=' + r.user.email + ' role=' + r.user.role + ' is_active=' + r.user.is_active +
        (r.action === 'UPDATED' ? ' (previous role=' + r.previous_role + ', name preserved="' + r.preserved_name + '")' : ''));
      process.exit(0);
    })
    .catch((e) => { console.error('ADMIN_SETUP_FAILED: ' + e.message); process.exit(1); });
}

module.exports = { createAdmin };

