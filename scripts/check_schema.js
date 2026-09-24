require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionTimeoutMillis: 10000 });

async function main() {
  try {
    // Check if users table has role and is_active columns
    const r = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position");
    console.log('USERS TABLE COLUMNS:');
    r.rows.forEach(c => console.log('  ' + c.column_name + ' (' + c.data_type + ')'));
    
    // Check if inquiries table has all expected columns
    const r2 = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='inquiries' ORDER BY ordinal_position");
    console.log('\nINQUIRIES TABLE COLUMNS:');
    r2.rows.forEach(c => console.log('  ' + c.column_name + ' (' + c.data_type + ')'));
    
    // Check if the default admin exists
    const r3 = await pool.query("SELECT id, email, role, is_active FROM users WHERE email='admin@kaalamithra-ai.com'");
    console.log('\nDEFAULT ADMIN:');
    if (r3.rows.length === 0) console.log('  NOT FOUND');
    else console.log('  FOUND: ' + JSON.stringify(r3.rows[0]));
    
    pool.end();
  } catch (e) {
    console.log('ERROR:', e.message);
    pool.end();
  }
}

main();
