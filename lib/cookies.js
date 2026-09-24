// Shared session-cookie helpers: local dev stays plain-http friendly,
// HTTPS production (Vercel) upgrades to Secure + SameSite=None for cross-site use.
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function isSecureRequest(req) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.NODE_ENV === 'production') return true;
  if (req && req.secure) return true;
  const proto = req && req.headers ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  return proto === 'https';
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  const sameSite = secure ? 'None' : 'Lax';
  return (
    'km_token=' + encodeURIComponent(token) +
    '; HttpOnly; Path=/; SameSite=' + sameSite +
    '; Max-Age=' + SESSION_MAX_AGE +
    (secure ? '; Secure' : '')
  );
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  return (
    'km_token=; HttpOnly; Path=/; SameSite=' + (secure ? 'None' : 'Lax') +
    '; Max-Age=0' + (secure ? '; Secure' : '')
  );
}

module.exports = { sessionCookie, clearSessionCookie, isSecureRequest, SESSION_MAX_AGE };
