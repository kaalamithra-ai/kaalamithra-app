// Auth routes: signup / login / logout / me.
// Uses bcryptjs hashing + JWT (Bearer header + httpOnly cookie) against the existing users table.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { JWT_SECRET, roleOf } = require('../middleware/auth');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Reasonable policy: 8+ chars, at least one letter and one digit.
const strongPassword = (p) => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

function issueSession(res, user) {
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  // httpOnly cookie (primary for browser) + token in body (Bearer fallback / desktop clients).
  // Secure flag omitted intentionally: local dev runs over plain http. Enable in HTTPS production.
  res.setHeader('Set-Cookie',
    `km_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);
  return token;
}

function publicUser(u) {
  // NEVER expose password_hash.
  return { id: u.id, name: u.name, email: u.email, phone: u.phone || null, role: u.role || 'client', created_at: u.created_at };
}

// ---------- SIGNUP ----------
router.post('/signup', async (req, res) => {
  try {
    const name = (req.body.name || req.body.full_name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const phone = (req.body.phone || '').trim();
    const password = req.body.password || '';

    if (!name || name.length < 2)
      return res.status(400).json({ success: false, error: 'Please enter your full name.' });
    if (!email || !EMAIL_RE.test(email))
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    if (!phone || !/^\+?[0-9][0-9\s\-()]{7,17}$/.test(phone) || phone.replace(/\D/g, '').length < 10)
      return res.status(400).json({ success: false, error: 'Please enter a valid phone number (10-15 digits).' });
    if (!strongPassword(password))
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters and include letters and numbers.' });

    const dup = await pool.query('SELECT id, role FROM users WHERE email=$1', [email]);
    if (dup.rowCount > 0) {
      // Generic message: never reveal whether an email belongs to an admin or client.
      return res.status(409).json({ success: false, error: 'Account already exists. Please login.' });
    }

    const hash = await bcrypt.hash(password, 10);
    // role defaults to 'client' at the DB level too; never allow self-registered admins.
    const ins = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'client', TRUE)
       RETURNING id, name, email, phone, role, created_at`,
      [name, email, phone, hash]
    );
    const user = ins.rows[0];
    const token = issueSession(res, user);
    console.log(`AUTH: new signup id=${user.id} email=${user.email} role=${user.role}`);
    res.status(201).json({ success: true, message: 'Account created successfully.', token, user: publicUser(user) });
  } catch (e) {
    console.error('Signup error:', e.message);
    res.status(500).json({ success: false, error: 'Could not create the account. Please try again.' });
  }
});

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password)
      return res.status(400).json({ success: false, error: 'Invalid email or password.' });
    const r = await pool.query(
      'SELECT id, name, email, phone, role, is_active, password_hash FROM users WHERE email=$1', [email]);
    if (r.rowCount === 0)
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    if (u.is_active === false)
      return res.status(403).json({ success: false, error: 'This account has been deactivated. Contact support.' });
    // ONE login endpoint for everyone. The stored credentials decide the
    // destination: admins get role='admin' (the frontend hands them off to the
    // admin dashboard) and clients stay in the normal web app.
    const role = roleOf(u);
    const token = issueSession(res, u);
    console.log(`AUTH: login ok id=${u.id} email=${u.email} role=${role}`);
    res.json({
      success: true,
      message: 'Login successful!',
      token,
      role,
      user: publicUser(u)
    });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ success: false, error: 'Could not sign in. Please try again.' });
  }
});

// ---------- LOGOUT ----------
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'km_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// ---------- ME (session check) ----------
router.get('/me', async (req, res) => {
  try {
    const { readToken } = require('../middleware/auth');
    const token = readToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    let d;
    try { d = jwt.verify(token, JWT_SECRET); }
    catch (e) { return res.status(401).json({ success: false, error: 'Your session has expired. Please log in again.' }); }
    const r = await pool.query(
      'SELECT id, name, email, phone, role, is_active, created_at FROM users WHERE id=$1', [d.id]);
    if (r.rowCount === 0) return res.status(401).json({ success: false, error: 'User not found.' });
    if (r.rows[0].is_active === false)
      return res.status(403).json({ success: false, error: 'This account has been deactivated.' });
    res.json({ success: true, user: publicUser(r.rows[0]) });
  } catch (e) {
    res.status(401).json({ success: false, error: 'Your session has expired. Please log in again.' });
  }
});

module.exports = router;

