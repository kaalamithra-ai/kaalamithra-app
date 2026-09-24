const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { JWT_SECRET, requireAuth, requireClient, readToken, roleOf } = require('../middleware/auth');
const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function pub(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone || null, role: u.role, created_at: u.created_at };
}
function sess(res, user) {
  const t = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.setHeader('Set-Cookie', 'km_token=' + encodeURIComponent(t) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
  return t;
}
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ success: false, error: 'Please enter email and password.' });
    const r = await pool.query('SELECT id,name,email,phone,role,is_active,password_hash,created_at FROM users WHERE email=$1', [email]);
    if (!r.rowCount) return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    const u = r.rows[0];
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    if (u.is_active === false) return res.status(403).json({ success: false, error: 'Account deactivated. Contact support.' });
    // Generic error: never reveal that an admin account exists on the client endpoint.
    if (roleOf(u) !== 'client') return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    const token = sess(res, u);
    res.json({ success: true, message: 'Client login successful.', token, user: pub(u) });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not sign in.' }); }
});
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'km_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ success: true, message: 'Logged out successfully.' });
});
router.get('/me', async (req, res) => {
  try {
    const t = readToken(req);
    if (!t) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    let d; try { d = jwt.verify(t, JWT_SECRET); } catch (e) { return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' }); }
    if (roleOf(d) !== 'client') return res.status(403).json({ success: false, error: 'Client access required.' });
    const r = await pool.query('SELECT id,name,email,phone,role,is_active,created_at FROM users WHERE id=$1', [d.id]);
    if (!r.rowCount) return res.status(401).json({ success: false, error: 'User not found.' });
    res.json({ success: true, user: pub(r.rows[0]) });
  } catch (e) { res.status(401).json({ success: false, error: 'Session expired.' }); }
});
router.get('/inquiries', requireAuth, requireClient, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, email, phone, company, service, budget, details, status, nda_requested, created_at
                                FROM inquiries WHERE user_id=$1 OR email=(SELECT email FROM users WHERE id=$1) ORDER BY id DESC LIMIT 200`, [req.user.id]);
    res.json({ success: true, count: r.rowCount, data: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load your requests.' }); }
});
router.get('/profile', requireAuth, requireClient, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,phone,role,created_at FROM users WHERE id=$1', [req.user.id]);
    if (!r.rowCount) return res.status(401).json({ success: false, error: 'User not found.' });
    res.json({ success: true, user: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load profile.' }); }
});
router.get('/stats', requireAuth, requireClient, async (req, res) => {
  try {
    const r = await pool.query('SELECT count(*)::int AS n, max(created_at) AS latest FROM inquiries WHERE user_id=$1 OR email=(SELECT email FROM users WHERE id=$1)', [req.user.id]);
    res.json({ success: true, myInquiries: r.rows[0].n, latest: r.rows[0].latest });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load stats.' }); }
});
module.exports = router;
