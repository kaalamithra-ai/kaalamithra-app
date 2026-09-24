// Safe inspection of the authentication table. NEVER prints password hashes
// (only the bcrypt prefix + length so we can confirm hashing without leaking secrets).
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position");
  console.log('=== users table structure ===');
  cols.rows.forEach((c) => console.log('  ' + c.column_name.padEnd(14) + ' ' + c.data_type.padEnd(12) + ' null=' + c.is_nullable.padEnd(3) + ' default=' + (c.column_default || '-')));

  const users = await pool.query(`SELECT id, name, email, role, is_active, phone, created_at, updated_at,
                                          left(password_hash, 7) AS hash_prefix, length(password_hash) AS hash_len
                                   FROM users ORDER BY id`);
  console.log('=== accounts (password hashes NOT printed — prefix/length only) ===');
  users.rows.forEach((u) => console.log('  id=' + u.id + '  ' + String(u.email).padEnd(34) + ' role=' + String(u.role).padEnd(7) +
    ' active=' + u.is_active + '  hash=' + u.hash_prefix + '…(len ' + u.hash_len + ')'));

  const clients = await pool.query("SELECT id, email, role FROM users WHERE lower(role)='client' ORDER BY id");
  console.log('=== CLIENT accounts found: ' + clients.rows.length + ' ===');
  clients.rows.forEach((c) => console.log('  id=' + c.id + ' ' + c.email));

  const t = await pool.query("SELECT id, name, email, role, is_active FROM users WHERE lower(email)='client@test.com'");
  console.log('=== client@test.com ===');
  console.log(t.rowCount ? '  EXISTS id=' + t.rows[0].id + ' role=' + t.rows[0].role + ' active=' + t.rows[0].is_active : '  DOES NOT EXIST');

  const inq = await pool.query('SELECT count(*)::int AS n FROM inquiries');
  console.log('inquiries rows (must remain untouched): ' + inq.rows[0].n);
  process.exit(0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
