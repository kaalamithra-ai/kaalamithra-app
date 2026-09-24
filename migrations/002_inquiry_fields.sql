-- Migration 002: inquiry capture completeness (additive only — never drops/renames data)
-- 1) status: workflow status shown in the Admin Dashboard (defaults to 'New' for every row,
--    including existing rows — no data is lost or rewritten).
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'New';

-- 2) nda_requested: the inquiry form has an "automated mutual NDA" checkbox whose
--    state was previously not persisted; capture it going forward.
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS nda_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
