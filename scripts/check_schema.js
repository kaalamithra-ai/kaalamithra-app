require('dotenv').config();
// Shared pool factory: honours DATABASE_URL (local OR hosted) plus the repo's
// SSL rules. A bare `new Pool({})` only reads PG* env vars and ignores
// DATABASE_URL, which made this checker fail with
// "client password must be a string" instead of checking anything.
const { createPool } = require('../lib/db');
// Shared introspection: the exact columns the Admin/Client read APIs SELECT.
const { schemaStatus } = require('../lib/schema');
const pool = createPool();

async function main() {
  if (!pool) {
    console.log('ERROR: DATABASE_URL is not set — nothing to check.');
    process.exit(2);
  }
  try {
    // Assert the drift FIRST — missing inquiries.status / nda_requested / user_id
    // is what produced "Could not load submissions." — so the verdict is printed
    // even when a later diagnostic query fails on an older schema.
    let ready = null;
    let missing = [];
    try {
      const st = await schemaStatus(pool);
      ready = st.ready;
      missing = st.missing;
    } catch (e) {
      console.log('SCHEMA_INTROSPECTION_FAILED: ' + e.message);
    }

    // Check if users table has role and is_active columns
    const r = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position");
    console.log('USERS TABLE COLUMNS:');
    r.rows.forEach(c => console.log('  ' + c.column_name + ' (' + c.data_type + ')'));
    
    // Check if inquiries table has all expected columns
    const r2 = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='inquiries' ORDER BY ordinal_position");
    console.log('\nINQUIRIES TABLE COLUMNS:');
    r2.rows.forEach(c => console.log('  ' + c.column_name + ' (' + c.data_type + ')'));
    
    // Check if the default admin exists (wrapped: an older users table may lack
    // role/is_active and that must not hide the verdict above).
    console.log('\nDEFAULT ADMIN:');
    try {
      const r3 = await pool.query("SELECT id, email, role, is_active FROM users WHERE email='admin@kaalamithra-ai.com'");
      if (r3.rows.length === 0) console.log('  NOT FOUND');
      else console.log('  FOUND: ' + JSON.stringify(r3.rows[0]));
    } catch (e) {
      console.log('  (query failed: ' + e.message + ')');
    }

    // Verdict: exit 1 = required columns missing = the dashboards 500 until healed.
    console.log('\nSCHEMA_READY=' + ready + '  MISSING=' + JSON.stringify(missing));
    pool.end();
    process.exit(ready === true ? 0 : 1);
  } catch (e) {
    console.log('ERROR:', e.message);
    if (pool) pool.end();
    process.exit(2);
  }
}

main();
