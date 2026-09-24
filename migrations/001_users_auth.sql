-- Migration 001: authentication support (additive only — never drops data)
-- users: extend the EXISTING table (convention: name column kept as full name)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- existing seeded admin becomes admin; everyone else stays 'client'
UPDATE users SET role = 'admin' WHERE email = 'admin@kaalamithra-ai.com' AND role = 'client';

-- inquiries: optional association with the logged-in user (safe: nullable FK)
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inquiries_user_id ON inquiries(user_id);
