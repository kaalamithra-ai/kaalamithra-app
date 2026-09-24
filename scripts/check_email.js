require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool();

const email = process.argv[2] || 'bvasha2004@gmail.com';

pool.query(
  "SELECT id, email, role, is_active, password_hash FROM users WHERE LOWER(email) = LOWER($1)",
  [email],
  (e, r) => {
    if (e) { console.log('DB ERROR:', e.message); pool.end(); return; }
    if (r.rows.length === 0) {
      console.log('EMAIL NOT FOUND: ' + email);
    } else {
      console.log('FOUND:');
      console.log('  id:', r.rows[0].id);
      console.log('  email:', r.rows[0].email);
      console.log('  role:', r.rows[0].role);
      console.log('  is_active:', r.rows[0].is_active);
      console.log('  password_hash present:', !!r.rows[0].password_hash);
      console.log('  password_hash (first 30 chars):', (r.rows[0].password_hash || '').substring(0, 30));
    }
    pool.end();
  }
);
