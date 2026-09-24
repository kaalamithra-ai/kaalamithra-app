require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool();

pool.query('SELECT id, email, role, is_active FROM users ORDER BY id', (e, r) => {
  if (e) { console.log('DB ERROR:', e.message); pool.end(); return; }
  console.log('USERS:');
  r.rows.forEach(u => console.log(JSON.stringify(u)));
  pool.end();
});
