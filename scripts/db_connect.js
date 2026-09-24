require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionTimeoutMillis: 8000 });

console.log('connecting to', process.env.DATABASE_URL ? 'DB (url set)' : 'DB (NO URL)');

pool.connect((e, c) => {
  if (e) {
    console.log('CONNECT ERROR:', e.message);
    pool.end();
    return;
  }
  console.log('CONNECTED OK');
  c.release();
  pool.end();
});
