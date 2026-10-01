// Additive, idempotent schema self-heal — the single source of truth for every
// column the Admin/Client read APIs SELECT.
//
// WHY THIS EXISTS
// The dashboards SELECT inquiries.status / nda_requested / user_id, which come
// from migrations 001 + 002. A hosted database (Neon) that predates those
// migrations answers those SELECTs with PostgreSQL 42703 (undefined_column),
// which surfaced as "Could not load submissions." on the Admin Dashboard.
// On Vercel there is no deploy step that runs migrations/, so the heal must
// happen inside the app: initDb() runs it on cold start AND the read routes
// await it, so no request can ever race ahead of the schema fix.
//
// SAFE BY CONTRACT
//   * CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS only
//   * Backfills touch ONLY rows whose value is NULL/empty — real data is never rewritten
//   * NO DROP, NO DROP COLUMN, NO TRUNCATE, NO DELETE, NO type change
//   * Every statement is idempotent: running it a second time changes nothing.
const { getPool } = require('./db');

// Tables + columns every read API depends on. `user_id` is added WITHOUT the
// foreign key here (a missing users PK must never veto the column itself);
// the constraint is attached best-effort in OPTIONAL_SQL below.
const REQUIRED_SQL = [
  'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())',
  'CREATE TABLE IF NOT EXISTS inquiries (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, company TEXT, service TEXT, budget TEXT, details TEXT, created_at TIMESTAMP DEFAULT NOW())',
  // users: auth + the admin "Total clients" card
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'client'",
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()',
  // inquiries: the columns GET /api/admin/submissions, /submissions/:id,
  // /stats, /statuses, /services and /api/client/inquiries actually reference.
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS phone TEXT',
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS company TEXT',
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS service TEXT',
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS budget TEXT',
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS details TEXT',
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()',
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS user_id INTEGER',
  "ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'New'",
  'ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS nda_requested BOOLEAN DEFAULT FALSE',
  // Backfill ONLY valueless rows (matches migration 001/002 intent).
  "UPDATE inquiries SET status = 'New' WHERE status IS NULL OR status = ''",
  'UPDATE inquiries SET nda_requested = FALSE WHERE nda_requested IS NULL',
  "UPDATE users SET role = 'client' WHERE role IS NULL OR role = ''",
  'UPDATE users SET is_active = TRUE WHERE is_active IS NULL',
  // Indexes behind the admin status filter + the client row-scoping WHERE.
  'CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status)',
  'CREATE INDEX IF NOT EXISTS idx_inquiries_user_id ON inquiries(user_id)',
];

// Nice-to-have tightening that must NEVER break a request: if one of these
// fails (e.g. a pre-existing constraint, or a legacy users table without a PK)
// the columns above are already in place and the dashboards work.
const OPTIONAL_SQL = [
  // POST /api/inquiries omits status/nda_requested, so the DB default is what
  // keeps those rows out of NULL even on a hand-created table.
  "ALTER TABLE inquiries ALTER COLUMN status SET DEFAULT 'New'",
  'ALTER TABLE inquiries ALTER COLUMN nda_requested SET DEFAULT FALSE',
  "ALTER TABLE users ALTER COLUMN role SET DEFAULT 'client'",
  'ALTER TABLE users ALTER COLUMN is_active SET DEFAULT TRUE',
  // Optional association, attached only when absent. ON DELETE SET NULL mirrors
  // migration 001: deleting a client never deletes their submitted inquiries.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_user_id_fkey') THEN
       ALTER TABLE inquiries ADD CONSTRAINT inquiries_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
     END IF;
   END $$`,
];

// The exact columns the deployed schema must expose for the dashboards to work
// (used read-only by /api/health so production can be verified without a shell).
const REQUIRED_COLUMNS = {
  users: ['id', 'name', 'email', 'password_hash', 'role', 'is_active', 'created_at'],
  inquiries: [
    'id', 'name', 'email', 'phone', 'company', 'service', 'budget',
    'details', 'status', 'nda_requested', 'user_id', 'created_at',
  ],
};

function notConfigured() {
  const e = new Error(
    'DATABASE_URL is not set. Add a hosted Postgres DATABASE_URL in Vercel env vars.'
  );
  e.code = 'KM_DB_NOT_CONFIGURED';
  return e;
}

// One batched simple-query per group = 2 round trips per cold start instead of
// ~25. If the optional batch fails as a whole, its statements are retried
// individually so one bad statement cannot veto the rest.
async function runHeal(p) {
  await p.query(REQUIRED_SQL.join(';\n') + ';');
  try {
    await p.query(OPTIONAL_SQL.join(';\n') + ';');
  } catch (firstErr) {
    for (const sql of OPTIONAL_SQL) {
      try {
        await p.query(sql);
      } catch (e) {
        console.error('Schema heal (optional, skipped):', e.message);
      }
    }
    console.error('Schema heal (optional batch retried individually):', firstErr.message);
  }
  return true;
}

let __promise = null;
let __healed = false;

// Resolves true once the additive schema is guaranteed present on this instance.
// Memoized: the DDL runs at most once per (cold) instance, every later call is
// an already-resolved promise. Safe to call from any number of routes.
function ensureSchema(poolArg) {
  if (__healed) return Promise.resolve(true);
  if (!__promise) {
    __promise = (async () => {
      const p = poolArg || getPool();
      if (!p) throw notConfigured();
      await runHeal(p);
      __healed = true;
      return true;
    })();
    // Never cache a rejection: a later request may find the DB reachable again
    // and must retry the (idempotent) heal instead of failing forever.
    __promise.catch(() => {
      __promise = null;
    });
  }
  return __promise;
}

// Read-only introspection: which required columns are still missing.
async function schemaStatus(poolArg) {
  const p = poolArg || getPool();
  if (!p) return { configured: false, healed: __healed, ready: false, missing: [notConfigured().message] };
  const r = await p.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('users','inquiries')`
  );
  const have = {};
  r.rows.forEach((row) => {
    have[row.table_name] = have[row.table_name] || {};
    have[row.table_name][row.column_name] = true;
  });
  const missing = [];
  Object.keys(REQUIRED_COLUMNS).forEach((table) => {
    REQUIRED_COLUMNS[table].forEach((col) => {
      if (!have[table] || !have[table][col]) missing.push(table + '.' + col);
    });
  });
  return { configured: true, healed: __healed, ready: missing.length === 0, missing };
}

module.exports = { ensureSchema, schemaStatus, REQUIRED_COLUMNS, REQUIRED_SQL, OPTIONAL_SQL };

