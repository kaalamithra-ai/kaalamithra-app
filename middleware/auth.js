// Authentication middleware: verifies JWT from httpOnly cookie OR Authorization: Bearer header.
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'kaalamithra-secret-change-me';

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)km_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Single place for role normalisation: PostgreSQL stores role as TEXT,
// so treat role comparisons case-insensitively ('admin' === 'ADMIN').
function roleOf(user) {
  return String((user && user.role) || '').trim().toLowerCase();
}

// Blocks unauthenticated access to private APIs.
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET); // { id, email, name, role }
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Your session has expired. Please log in again.' });
  }
}

// Blocks non-admin access to admin APIs. MUST be chained after requireAuth.
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (roleOf(req.user) !== 'admin')
    return res.status(403).json({ success: false, error: 'Access denied. Admin access required.' });
  next();
}

// Blocks non-client access to client APIs. MUST be chained after requireAuth.
// Generic message so public users never learn an admin role exists.
function requireClient(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (roleOf(req.user) !== 'client')
    return res.status(403).json({ success: false, error: 'Access denied.' });
  next();
}

// Attaches req.user when a valid token exists; never blocks (public endpoints like inquiry POST).
function optionalAuth(req, res, next) {
  const token = readToken(req);
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) { req.user = null; }
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireClient, optionalAuth, readToken, roleOf, JWT_SECRET };
