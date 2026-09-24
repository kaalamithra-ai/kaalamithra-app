// Shared PostgreSQL pool factory (local + hosted).
// Local dev: plain DATABASE_URL (e.g. postgres://...@localhost:5432/db) — no SSL.
// Hosted (Vercel / Neon / Supabase / RDS): providers require TLS, so enable SSL
// when the URL asks for it (sslmode=require), PGSSL=true, or NODE_ENV=production
// against a NON-local host. Localhost is never forced to SSL (avoids boot hangs).
const { Pool } = require('pg');

function isLocalHost(url) {
  if (!url) return true;
  try {
    const u = new URL(url.replace(/^postgres:\/\//i, 'http://'));
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  } catch (e) {
    return /localhost|127\.0\.0\.1/i.test(url);
  }
}

function needsSSL(url) {
  if (!url) return false;
  if (process.env.PGSSL === 'true') return true;
  if (process.env.PGSSL === 'false') return false;
  if (/sslmode=require/i.test(url)) return true;
  if (isLocalHost(url)) return false; // never force TLS to a local DB
  if (process.env.NODE_ENV === 'production') return true;
  return false;
}

function createPool(url) {
  const connectionString = url || process.env.DATABASE_URL;
  const pool = new Pool(
    needsSSL(connectionString)
      ? { connectionString, ssl: { rejectUnauthorized: false } }
      : { connectionString }
  );
  pool.on('error', (err) => console.error('PG pool error:', err.message));
  return pool;
}

// Shared singleton (serverless-friendly: reused across warm invocations).
const pool = createPool();

module.exports = { pool, createPool, needsSSL };

