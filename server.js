const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
try { require('dotenv').config(); } catch (e) { /* dotenv optional on Vercel */ }
const jwt = require('jsonwebtoken');
const { pool } = require('./lib/db');
const { requireAuth, requireAdmin, optionalAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');

const app = express();
// Behind Vercel's proxy: honour X-Forwarded-Proto so req.secure/cookies behave.
app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'kaalamithra-secret-change-me';
const PORT = process.env.PORT || 5000;

// Auto-create tables on boot (matches pgAdmin inquiries table + company support)
async function initDb() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
      company TEXT, service TEXT, budget TEXT, details TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    // Self-heal columns if table was created earlier without company
    await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS company TEXT`);
    await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS phone TEXT`);
    await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS service TEXT`);
    await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS budget TEXT`);
    await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS details TEXT`);
    console.log('Using DATABASE_URL:', (process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':****@'));
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    // Self-heal auth columns on older DBs (role / is_active / phone).
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'client'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
    await pool.query(`UPDATE users SET role='client' WHERE role IS NULL OR role=''`);
    await pool.query(`UPDATE users SET is_active=TRUE WHERE is_active IS NULL`);
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

// Role-separated login UI (Kaala Mithra branding).
// PUBLIC (visible to everyone): /welcome | /login (client only) | /signup (client only)
//   | /client/login | /client/dashboard
// PRIVATE (admin only, direct URL — never linked from any public page):
//   /admin/login | /admin/dashboard
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/client', express.static(path.join(__dirname, 'public', 'client')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});
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
// (frontend file lives at C:\Users\Lenovo\Downloads\kaalamithra-complete\kaalamithra-complete\app\index.html,
//  NOT inside C:\Users\Lenovo\backend). So Express does NOT serve static frontend files.

// API status (moved off / so / can be the Welcome screen)
app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'Kaalamithra backend API running. Frontend is served by Live Server at http://127.0.0.1:5500/kaalamithra-complete/app/',
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
  if (!process.env.DATABASE_URL) {
    console.error('Health: DATABASE_URL is not set on this deployment.');
    return res.status(500).json({
      success: false,
      error: 'DATABASE_URL is not set. Add a hosted Postgres DATABASE_URL in Vercel env vars.',
    });
  }
  try {
    const r = await pool.query('SELECT NOW() as now, count(*)::int AS inquiries FROM inquiries');
    res.json({ success: true, db: 'connected', now: r.rows[0].now, inquiries: r.rows[0].inquiries });
  } catch (e) {
    console.error('Health DB error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET Route: Fetch Inquiries (PRIVATE: client data -> requires authenticated session)
app.get('/api/inquiries', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inquiries ORDER BY id DESC;');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ Database FETCH Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Explicit error handler so Vercel recycles the function cleanly on 500s.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// Local dev: long-lived server. Vercel: imported via api/index.js (no listen).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;