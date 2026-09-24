const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { JWT_SECRET, requireAuth, requireAdmin, readToken, roleOf } = require('../middleware/auth');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function publicAdmin(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at };
}

function issueAdminSession(res, user) {
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.setHeader('Set-Cookie',
    'km_token=' + encodeURIComponent(token) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
  return token;
}

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || req.body.username || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password)
      return res.status(400).json({ success: false, error: 'Please enter admin email and password.' });
    const r = await pool.query(
      'SELECT id, name, email, role, is_active, password_hash, created_at FROM users WHERE email=$1', [email]);
    if (r.rowCount === 0)
      return res.status(401).json({ success: false, error: 'Invalid admin credentials.' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ success: false, error: 'Invalid admin credentials.' });
    if (u.is_active === false)
      return res.status(403).json({ success: false, error: 'This admin account has been deactivated.' });
    if (roleOf(u) !== 'admin')
      return res.status(403).json({ success: false, error: 'Access denied. Admin access required.' });
    const token = issueAdminSession(res, u);
    res.json({ success: true, message: 'Admin login successful.', token, user: publicAdmin(u) });
  } catch (e) {
    console.error('Admin login error:', e.message);
    res.status(500).json({ success: false, error: 'Could not sign in. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'km_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ success: true, message: 'Admin logged out successfully.' });
});

router.get('/me', async (req, res) => {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    let d;
    try { d = jwt.verify(token, JWT_SECRET); }
    catch (e) { return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' }); }
    if (roleOf(d) !== 'admin') return res.status(403).json({ success: false, error: 'Admin access required.' });
    const r = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id=$1', [d.id]);
    if (r.rowCount === 0) return res.status(401).json({ success: false, error: 'Admin not found.' });
    if (r.rows[0].is_active === false)
      return res.status(403).json({ success: false, error: 'This admin account has been deactivated.' });
    res.json({ success: true, user: publicAdmin(r.rows[0]) });
  } catch (e) {
    res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  }
});

router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const total = await pool.query('SELECT count(*)::int AS n FROM inquiries');
    const clients = await pool.query("SELECT count(*)::int AS n FROM users WHERE lower(role)='client'");
    const latest = await pool.query('SELECT max(created_at) AS latest FROM inquiries');
    const byService = await pool.query(
      "SELECT COALESCE(NULLIF(service,''),'General Service') AS service, count(*)::int AS n FROM inquiries GROUP BY 1 ORDER BY n DESC LIMIT 10");
    const byStatus = await pool.query('SELECT status, count(*)::int AS n FROM inquiries GROUP BY status ORDER BY n DESC');
    res.json({ success: true, total: total.rows[0].n, clients: clients.rows[0].n, latest: latest.rows[0].latest, byService: byService.rows, byStatus: byStatus.rows });
  } catch (e) {
    console.error('Admin stats error:', e.message);
    res.status(500).json({ success: false, error: 'Could not load dashboard stats.' });
  }
});

// Shared list logic (used by /submissions and /inquiries aliases).
// Returns EVERY field the client submitted + the owning client account (from the verified user_id link).
async function listSubmissions(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const service = String(req.query.service || '').trim();
    const status = String(req.query.status || '').trim();
    const sort = String(req.query.sort || 'latest').toLowerCase() === 'oldest' ? 'ASC' : 'DESC';
    const where = [];
    const vals = [];
    if (q) {
      vals.push('%' + q + '%');
      where.push('(i.name ILIKE $' + vals.length + ' OR i.email ILIKE $' + vals.length + ' OR i.phone ILIKE $' + vals.length + ')');
    }
    if (service) { vals.push(service); where.push('i.service = $' + vals.length); }
    if (status) { vals.push(status); where.push('i.status = $' + vals.length); }
    const sql = `SELECT i.id, i.name, i.email, i.phone, i.company, i.service, i.budget, i.details,
                        i.status, i.nda_requested, i.user_id, i.created_at,
                        u.name AS owner_name, u.email AS owner_email
                 FROM inquiries i
                 LEFT JOIN users u ON u.id = i.user_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY i.id ${sort} LIMIT 500`;
    const r = await pool.query(sql, vals);
    res.json({ success: true, count: r.rowCount, data: r.rows });
  } catch (e) {
    console.error('Admin submissions error:', e.message);
    res.status(500).json({ success: false, error: 'Could not load submissions.' });
  }
}
router.get('/submissions', requireAuth, requireAdmin, listSubmissions);
router.get('/inquiries', requireAuth, requireAdmin, listSubmissions);

// Distinct statuses present in the data (drives the filter dropdown — no invented values)
router.get('/statuses', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT DISTINCT status FROM inquiries ORDER BY status');
    res.json({ success: true, data: r.rows.map(function (x) { return x.status; }) });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not load statuses.' });
  }
});

router.get('/services', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT DISTINCT service FROM inquiries WHERE service IS NOT NULL AND service <> '' ORDER BY service");
    res.json({ success: true, data: r.rows.map(function (x) { return x.service; }) });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not load services.' });
  }
});

// Shared detail logic: EVERY submitted field + owning client account (real data, no raw DB exposure to UI).
async function getSubmissionById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ success: false, error: 'Invalid submission ID.' });
    const r = await pool.query(
      `SELECT i.id, i.name, i.email, i.phone, i.company, i.service, i.budget, i.details,
              i.status, i.nda_requested, i.user_id, i.created_at,
              u.name AS owner_name, u.email AS owner_email
       FROM inquiries i
       LEFT JOIN users u ON u.id = i.user_id
       WHERE i.id=$1`, [id]);
    if (r.rowCount === 0)
      return res.status(404).json({ success: false, error: 'Submission not found.' });
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    console.error('Admin detail error:', e.message);
    res.status(500).json({ success: false, error: 'Could not load submission.' });
  }
}
router.get('/submissions/:id', requireAuth, requireAdmin, getSubmissionById);
router.get('/inquiries/:id', requireAuth, requireAdmin, getSubmissionById);

module.exports = router;
