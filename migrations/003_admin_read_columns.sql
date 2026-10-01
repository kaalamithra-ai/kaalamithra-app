-- Migration 003: close the deployed-schema gap behind "Could not load submissions."
--
-- WHY
--   GET /api/admin/submissions, /api/admin/submissions/:id, /api/admin/stats,
--   /api/admin/statuses and GET /api/client/inquiries all SELECT (or filter on)
--   inquiries.status, inquiries.nda_requested and inquiries.user_id. Those three
--   columns come from migrations 001 + 002, which were never applied to the
--   hosted (Neon) database, so each of those queries failed with PostgreSQL
--   42703 (undefined_column) -> HTTP 500 -> "Could not load submissions."
--   /api/admin/me and /api/health kept working because they only touch users /
--   count(*), which is exactly the symptom that was reported.
--
-- SAFETY (this file never destroys anything)
--   * CREATE TABLE IF NOT EXISTS + ALTER TABLE ... ADD COLUMN IF NOT EXISTS only
--   * NO DROP / DROP COLUMN / TRUNCATE / DELETE / RENAME / type change
--   * The UPDATEs only touch rows whose value is NULL or empty; real values are
--     never rewritten, so every existing user and inquiry row is preserved
--   * Fully idempotent: applying it twice is a no-op
--
-- NOTE: lib/schema.js applies these same statements automatically on every cold
-- start (and the read routes await it), so on Vercel this file only needs to be
-- run manually via psql / the Neon SQL editor. To apply it with the repo tooling:
--   node run_migrations.js        (uses DATABASE_URL from .env)
--   or POST /api/setup with the admin key.

-- 1) Tables (no-ops when they already exist) ---------------------------------
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  service TEXT,
  budget TEXT,
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2) users columns (login, /api/admin/me, "Total clients" card, scripts) ------
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'client';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

-- 3) inquiries columns referenced by the Admin + Client dashboards ------------
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS service TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS budget TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS details TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

-- The three that were missing on the deployed database:
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'New';
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS nda_requested BOOLEAN DEFAULT FALSE;

-- 4) Backfill ONLY valueless rows — existing values are never overwritten ------
UPDATE inquiries SET status = 'New' WHERE status IS NULL OR status = '';
UPDATE inquiries SET nda_requested = FALSE WHERE nda_requested IS NULL;
UPDATE users SET role = 'client' WHERE role IS NULL OR role = '';
UPDATE users SET is_active = TRUE WHERE is_active IS NULL;

-- 5) Defaults so app INSERTs that omit these columns never land on NULL --------
--    (POST /api/inquiries does not send status at all — see server.js)
ALTER TABLE inquiries ALTER COLUMN status SET DEFAULT 'New';
ALTER TABLE inquiries ALTER COLUMN nda_requested SET DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'client';
ALTER TABLE users ALTER COLUMN is_active SET DEFAULT TRUE;

-- 6) Indexes behind the admin status filter and the client row-scoping WHERE ---
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_inquiries_user_id ON inquiries(user_id);

-- 7) Optional association (same as migration 001). Only attached when absent,
--    and ON DELETE SET NULL guarantees that deleting a user can never take their
--    submitted inquiries with it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_user_id_fkey') THEN
    ALTER TABLE inquiries ADD CONSTRAINT inquiries_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Verification (read-only): run this afterwards to confirm the gap is closed.
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'inquiries'
--    ORDER BY ordinal_position;
