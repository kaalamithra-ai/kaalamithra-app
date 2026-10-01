// One-shot hosted bootstrap: POST /api/setup on the deployed app, then prove the
// hosted DB is live (health + admin login + inquiry write/read round trip).
//   node scripts/run_hosted_setup.js <base-url> <ADMIN_SETUP_KEY>
// Env vars required on Vercel BEFORE this works: DATABASE_URL, ADMIN_SETUP_KEY,
// (JWT_SECRET recommended). Add them in Vercel -> Settings -> Environment Variables,
// then Redeploy so the running function picks them up.
const BASE = (process.argv[2] || 'https://kaalamithra-app.vercel.app').replace(/\/$/, '');
const KEY = process.argv[3] || process.env.ADMIN_SETUP_KEY || '';
if (!KEY) {
  console.log('Usage: node scripts/run_hosted_setup.js <base-url> <ADMIN_SETUP_KEY>');
  process.exit(1);
}
const ADMIN_EMAIL = 'admin@kaalamithra-ai.com';
const ADMIN_PASS = 'Admin@123';
async function hit(p, opts = {}) {
  try {
    const r = await fetch(BASE + p, { cache: 'no-store', ...opts });
    const t = await r.text();
    return { status: r.status, body: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
  } catch (e) {
    return { status: 0, body: 'FETCH_ERR ' + e.message, json: null };
  }
}
const j = (o) => ({ 'Content-Type': 'application/json' });
(async () => {
  console.log('BASE = ' + BASE);
  const s = await hit('/api/setup', { method: 'POST', headers: j(), body: JSON.stringify({ key: KEY }) });
  console.log('POST /api/setup -> ' + s.status + ' ' + s.body.slice(0, 400));
  if (!s.json || !s.json.success) {
    console.log('SETUP_BLOCKED — set DATABASE_URL + ADMIN_SETUP_KEY in Vercel env vars and redeploy, then re-run.');
    process.exit(1);
  }
  const h = await hit('/api/health');
  console.log('GET  /api/health -> ' + h.status + ' ' + h.body.slice(0, 200));
  // The dashboards only work once every column they SELECT exists; /api/health
  // reports them, so a missing column is caught here instead of in the UI.
  const missing = (h.json && h.json.missing_columns) || [];
  console.log('schema_ready = ' + (h.json && h.json.schema_ready) + ' missing_columns=' + JSON.stringify(missing));
  if (h.json && h.json.schema_ready === false) {
    console.log('SCHEMA_INCOMPLETE — missing: ' + missing.join(', '));
    process.exit(1);
  }
  const l = await hit('/api/admin/login', { method: 'POST', headers: j(), body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }) });
  console.log('POST /api/admin/login -> ' + l.status + ' ' + l.body.slice(0, 160));
  const token = l.json && l.json.token;
  if (!token) { console.log('ADMIN_LOGIN_FAILED'); process.exit(1); }
  const hdr = { Authorization: 'Bearer ' + token };
  const mark = 'hosted-setup-' + Date.now() + '@example.com';
  const w = await hit('/api/inquiries', { method: 'POST', headers: { ...j(), ...hdr }, body: JSON.stringify({ name: 'Hosted Setup Probe', email: mark, phone: '+910000000000', company: 'KM', service: 'General Service', budget: '<1L', details: 'created by scripts/run_hosted_setup.js — safe to delete' }) });
  console.log('POST /api/inquiries -> ' + w.status + ' ' + w.body.slice(0, 200));
  const r = await hit('/api/inquiries', { headers: hdr });
  const found = r.json && r.json.data && r.json.data.some((x) => x.email === mark);
  console.log('GET  /api/inquiries -> ' + r.status + ' count=' + (r.json && r.json.count) + ' roundtrip_row_found=' + found);
  console.log(found ? 'HOSTED_DB_READY' : 'HOSTED_DB_ROUNDTRIP_FAILED');
})();
