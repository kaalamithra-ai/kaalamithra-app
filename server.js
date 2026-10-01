const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
// ---- Local .env loading (dev convenience only) ----
// dotenv must NEVER override real environment variables (Vercel dashboard).
// dotenv@17 also auto-injects via preload, so guard with DOTENV_CONFIG_OVERRIDE
// and only load when a .env file actually sits next to server.js.
if (!process.env.VERCEL && process.env.DOTENV_CONFIG_OVERRIDE !== 'false') {
  try {
    if (fs.existsSync(path.join(__dirname, '.env'))) require('dotenv').config({ override: false });
  } catch (e) { /* dotenv missing / no .env — fine */ }
}
const jwt = require('jsonwebtoken');
const { pool } = require('./lib/db');
// Additive schema self-heal (migrations 001/002/003 parity) shared with the
// read routes so the hosted DB is repaired before any SELECT touches the
// columns the Admin/Client dashboards need. See lib/schema.js.
const { ensureSchema, schemaStatus } = require('./lib/schema');
const { requireAuth, requireAdmin, optionalAuth, roleOf } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');

const app = express();
// Behind Vercel's proxy: honour X-Forwarded-Proto so req.secure/cookies behave.
app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'kaalamithra-secret-change-me';
const PORT = process.env.PORT || 5000;

// Auto-create tables on boot (matches pgAdmin inquiries table + company support)
// Skips entirely when DATABASE_URL is not configured (e.g. Vercel preview
// without env vars) so boot never crashes — /api/health reports the problem.
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.error('DB init skipped: DATABASE_URL is not set on this deployment.');
    return;
  }
  try {
    // Everything additive lives in lib/schema.js (one source of truth): create
    // tables if absent + ADD COLUMN IF NOT EXISTS for every column the Admin and
    // Client read APIs SELECT, including the ones the hosted (Neon) database was
    // missing — inquiries.status, inquiries.nda_requested, inquiries.user_id —
    // plus NULL-only backfills. This is the run that repairs production on the
    // first cold start after deploy (Vercel runs no migration step).
    // SAFE BY CONTRACT: no DROP / TRUNCATE / DELETE, existing rows are preserved.
    await ensureSchema();
    console.log('Using DATABASE_URL:', (process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':****@'));
    const existing = await pool.query('SELECT id, role FROM users WHERE email=$1', ['admin@kaalamithra-ai.com']);
    if (existing.rowCount === 0) {
      const hash = await bcrypt.hash('Admin@123', 10);
      await pool.query(
        'INSERT INTO users (name,email,password_hash,role,is_active) VALUES ($1,$2,$3,\'admin\',TRUE)',
        ['Admin', 'admin@kaalamithra-ai.com', hash]);
      console.log('Seeded default user: admin@kaalamithra-ai.com / Admin@123');
    }
    console.log('DB tables ready (inquiries, users)');
  } catch (e) { console.error('DB init error:', e.message); }
}
initDb();

// ================= AUTH (modular: routes/auth.js + middleware/auth.js) =================
// credentials:true -> browser sends the httpOnly cookie back to the API.
// NOTE: body parsers MUST come before auth routes (auth reads req.body).
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS: local dev stays open for Live Server; production locks to env allowlist.
// Set FRONTEND_URL=https://<your-frontend>.vercel.app on Vercel. Vercel preview
// deployments (*.vercel.app) are accepted automatically so previews don't CORS-fail.
const LOCAL_ORIGINS = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
];
const EXTRA_ORIGINS = String(process.env.FRONTEND_URL || process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / server-to-server / same-origin
  if (LOCAL_ORIGINS.includes(origin)) return true;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true; // Vercel previews
  return false;
}

app.use(cors({
  // NOTE: cors expects (origin, callback) — returning a boolean hangs every request.
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
app.post('/api/setup', require('./routes/setup'));

// Role-separated login UI (Kaala Mithra branding).
// PUBLIC (visible to everyone): /welcome | /login (client only) | /signup (client only)
//   | /client/login | /client/dashboard
// PRIVATE (admin only, direct URL — never linked from any public page):
//   /admin/login | /admin/dashboard
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/client', express.static(path.join(__dirname, 'public', 'client')));
// Full marketing/logo frontend (deployed to Vercel as the homepage).
// Served from public-site/ (copied from the local kaalamithra-complete app via scripts/copy_frontend.js).
// Backend auth/admin/client pages stay under /welcome, /login, /admin/*, /client/*.
// The root static mount MUST come after the page GET routes above (so /welcome etc.
// keep serving backend pages) but before /api + error handler: index.html refs
// images via relative URLs, so the browser requests /images/km-logo.png.
app.use('/site', express.static(path.join(__dirname, 'public-site')));
// index:false — never let the static middleware resolve "/" itself. On Vercel its
// internal sendFile of index.html can throw (surfacing as a 500 on the homepage),
// while the explicit route below (same file, same code path as /app) always works.
app.use(express.static(path.join(__dirname, 'public-site'), { index: false }));
const HOME_HTML = path.join(__dirname, 'public-site', 'index.html');
function sendHome(res) {
  fs.readFile(HOME_HTML, (err, buf) => {
    if (err) {
      console.error('HOME_READ_FAIL', err.code || err.message, HOME_HTML);
      return res.status(500).json({
        success: false,
        error: 'Homepage file unavailable: ' + (err.code || err.message),
      });
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(buf);
  });
}
app.get('/app', (req, res) => sendHome(res));
app.get('/', (req, res) => sendHome(res));
app.get('/welcome', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html'));
});
app.get('/client/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client', 'login.html'));
});
app.get('/client/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client', 'dashboard.html'));
});

// API-only server: marketing frontend is served by Live Server at http://127.0.0.1:5500/kaalamithra-complete/app/
// (frontend file lives at C:\Users\Lenovo\Downloads\kaalamithra-complete (1)\kaalamithra-complete\app\index.html).
// On Vercel the same file is copied to public-site/ and served as the homepage at / (see routes above).

// API status (backend pages live under /welcome, /login, /admin/*, /client/*;
// the marketing/logo app is the homepage at / and /app, static assets under /site)
app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'Kaalamithra backend API running. Marketing app at / (public-site).',
    endpoints: ['GET /api/health', 'GET /api/inquiries', 'POST /api/inquiries'],
  });
});

// ================= AUTH =================
// (Moved to routes/auth.js — signup/login/logout/me with bcrypt + JWT + httpOnly cookie.)


// Idempotency guard: collapses accidental double-click / retry duplicates (same payload within 10s -> 1 row)
const __recentInquiries = new Map(); // key -> { id, at }
function __dupKey(o){ return [o.name||'',o.email||'',o.phone||'',o.company||'',o.service||'',o.budget||'',o.details||''].join('|').toLowerCase(); }

// POST Route: Receives Form Submissions -> PostgreSQL inquiries
// Public form still works for anonymous users; when authenticated, the inquiry is linked to the user.
app.post('/api/inquiries', optionalAuth, async (req, res) => {

  try {
    // Best-effort schema heal so a valid submission is never stored without the
    // user_id association (or the defaults) on a DB predating migrations 001/002.
    // Never fatal — the 42703 fallbacks below still persist the inquiry.
    try { await ensureSchema(); } catch (healErr) { console.error('Schema heal skipped on submit:', healErr.message); }
    console.log('\n========================================');
    console.log('NEW INQUIRY RECEIVED:');
    console.log(req.body);
    console.log('========================================');

    const s = (v) => (v === undefined || v === null ? '' : String(v)).trim();

    // Map every frontend field -> inquiries columns (incl. company/message aliases)
    const name = s(req.body.name || req.body.fullName || req.body.full_name || req.body.userName || req.body.inputName);
    const email = s(req.body.email || req.body.userEmail || req.body.inputEmail);
    const phone = s(req.body.phone || req.body.userPhone || req.body.mobile || req.body.inputPhone || req.body.phoneNumber);
    const company = s(req.body.company || req.body.companyName || req.body.organization || req.body.organisation);
    const service = s(req.body.service || req.body.service_type || req.body.serviceCategory || req.body.domain || req.body.projectDomain) || 'General Service';
    const budget = s(req.body.budget || req.body.projectBudget || req.body.budgetTier || req.body.estimatedBudget) || 'N/A';
    const details = s(req.body.details || req.body.message || req.body.projectDescription || req.body.specs || req.body.projectSpecs || req.body.requirements);
    // NDA checkbox state from the form (existing UI field — previously dropped, now persisted)
    const ndaRequested = !!(req.body.nda_requested || req.body.nda || req.body.ndaCheckbox === true ||
      req.body.nda_requested === 'true' || req.body.nda === 'true' || req.body.nda === 'on');

    if (!name || !email || !details) {
      console.error('VALIDATION FAILED: name, email, details(message) are required. Got:', { name, email, details: details.slice(0, 80) });
      return res.status(400).json({ success: false, error: 'Name, email and message/details are required.' });
    }

    // Terminal Output (exact format requested)
    console.log('NEW INQUIRY RECEIVED:');
    console.log({ name, email, phone, company, service, budget, message: details });

    // Duplicate guard: same payload within 10s -> return first row, do NOT insert again
    const __key = __dupKey({ name, email, phone, company, service, budget, details });
    const __prev = __recentInquiries.get(__key);
    if (__prev && (Date.now() - __prev.at) < 10000) {
      console.log('DUPLICATE IGNORED (same payload within 10s). Returning existing Inquiry ID:', __prev.id);
      console.log('========================================'+'\n');
      const existing = await pool.query('SELECT * FROM inquiries WHERE id = $1', [__prev.id]);
      return res.status(201).json({ success: true, message: 'Inquiry submitted and stored successfully!', data: existing.rows[0] || { id: __prev.id }, duplicate: true });
    }

    // Parameterized SQL insert (safe against SQL injection)
    // When logged in, associate the inquiry with the authenticated user (user_id added by migration 001).
    // status/nda_requested added by migration 002 (status defaults to 'New').
    const __userId = req.user && req.user.id ? req.user.id : null;
    const query = `
      INSERT INTO inquiries (name, email, phone, company, service, budget, details, user_id, nda_requested)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    const values = [name, email, phone, company, service, budget, details, __userId, ndaRequested];


    let result;
    try {
      result = await pool.query(query, values);
    } catch (err) {
      // Fallback if pgAdmin DB was created without company column
      if (err && err.code === '42703' && /company/i.test(err.message)) {
        console.error('Company column missing, retrying without it:', err.message);
        result = await pool.query(
          `INSERT INTO inquiries (name, email, phone, service, budget, details, user_id, nda_requested)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;`,
          [name, email, phone, service, budget, company ? `[Company: ${company}] ${details}` : details, __userId, ndaRequested]
        );
      } else if (err && err.code === '42703' && /user_id/i.test(err.message)) {
        // Pre-migration DB without user_id: insert without the association
        console.error('user_id column missing, retrying without it (run: node run_migrations.js):', err.message);
        result = await pool.query(
          `INSERT INTO inquiries (name, email, phone, company, service, budget, details, nda_requested)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;`,
          [name, email, phone, company, service, budget, details, ndaRequested]
        );
      } else if (err && err.code === '42703' && /nda_requested/i.test(err.message)) {
        // Pre-migration DB without nda_requested (migration 002 not run yet)
        console.error('nda_requested column missing, retrying without it (run: node run_migrations.js):', err.message);
        result = await pool.query(
          `INSERT INTO inquiries (name, email, phone, company, service, budget, details, user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;`,
          [name, email, phone, company, service, budget, details, __userId]
        );
      } else throw err;

    }

    console.log('\nDATABASE INSERT SUCCESS:');
    __recentInquiries.set(__key, { id: result.rows[0].id, at: Date.now() });
    if (__recentInquiries.size > 500) { const k = __recentInquiries.keys().next().value; __recentInquiries.delete(k); }
    console.log('Inquiry ID:', result.rows[0].id);
    console.log(result.rows[0]);
    console.log('========================================\n');

    res.status(201).json({
      success: true,
      message: 'Inquiry submitted and stored successfully!',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('DATABASE INSERT FAILED:', err.stack || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check for frontend debugging
app.get('/api/health', async (req, res) => {
  if (!process.env.DATABASE_URL || pool.isUnconfigured) {
    console.error('Health: DATABASE_URL is not set on this deployment.');
    return res.status(500).json({
      success: false,
      error: 'DATABASE_URL is not set. Add a hosted Postgres DATABASE_URL in Vercel env vars.',
    });
  }
  try {
    // Heal the schema first (idempotent) so one request both repairs and reports.
    // Best-effort: a failed heal must not turn /api/health into a 500 by itself.
    try {
      await ensureSchema();
    } catch (healErr) {
      console.error('Health: schema heal skipped:', healErr.message);
    }
    const r = await pool.query('SELECT NOW() as now, count(*)::int AS inquiries FROM inquiries');
    // Read-only schema introspection (no secrets): confirms on production that the
    // columns the Admin/Client dashboards need are actually present.
    let schema = { ready: false, missing: ['<introspection failed>'] };
    try {
      schema = await schemaStatus();
    } catch (e) {
      console.error('Health: schema introspection failed:', e.message);
    }
    res.json({
      success: true,
      db: 'connected',
      now: r.rows[0].now,
      inquiries: r.rows[0].inquiries,
      schema_ready: schema.ready,
      missing_columns: schema.missing,
    });
  } catch (e) {
    console.error('Health DB error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET Route: Fetch Inquiries (PRIVATE: client data -> requires authenticated session).
// ROLE-SCOPED: admins see everything; a client only ever sees rows they own
// (row linked by user_id, or submitted with their own account email). Without
// this scoping any logged-in client could read every other client's enquiry.
app.get('/api/inquiries', requireAuth, async (req, res) => {
  try {
    // client scoping filters on user_id -> guarantee the column exists first
    // (idempotent, memoized per instance; see lib/schema.js).
    await ensureSchema();
    const isAdmin = roleOf(req.user) === 'admin';
    const result = isAdmin
      ? await pool.query('SELECT * FROM inquiries ORDER BY id DESC;')
      : await pool.query(
          `SELECT * FROM inquiries
            WHERE user_id = $1
               OR email = (SELECT email FROM users WHERE id = $1)
            ORDER BY id DESC;`,
          [req.user.id]
        );
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    console.error('❌ Database FETCH Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Explicit error handler so Vercel recycles the function cleanly on 500s.
// NOTE: must be registered AFTER all routes (including the public-site
// static/homepage routes above) so page + API errors are handled, not skipped.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  // Set KM_DEBUG_ERRORS='true' in Vercel env to surface the real reason
  // (e.g. ENOENT on a bundled file) without redeploying.
  const detail = process.env.KM_DEBUG_ERRORS === 'true' && (err.code || err.message)
    ? ' Internal detail: ' + (err.code || err.message)
    : '';
  res.status(500).json({ success: false, error: 'Internal server error.' + detail });
});

// Local dev: long-lived server. Vercel: imported via api/index.js (no listen).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;