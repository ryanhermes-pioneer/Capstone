-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)

-- Checklist engine
CREATE TABLE IF NOT EXISTS close_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  description    TEXT,
  owner_email    TEXT,
  due_date       DATE,
  status         TEXT DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','complete','blocked')),
  priority       TEXT DEFAULT 'medium'
    CHECK (priority IN ('high','medium','low')),
  period_month   TEXT,
  period_year    INT DEFAULT 2026,
  parent_task_id UUID REFERENCES close_tasks(id),
  blocked_reason TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Account-level reconciliations
CREATE TABLE IF NOT EXISTS account_recs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name        TEXT NOT NULL,
  account_type        TEXT,
  template_type       TEXT,
  gl_balance          NUMERIC,
  schedule_balance    NUMERIC,
  status              TEXT DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','signed_off','locked')),
  preparer_id         UUID REFERENCES auth.users(id),
  reviewer_id         UUID REFERENCES auth.users(id),
  period_month        TEXT,
  period_year         INT DEFAULT 2026,
  ai_commentary       TEXT,
  preparer_signed_at  TIMESTAMPTZ,
  reviewer_signed_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Reconciling line items
CREATE TABLE IF NOT EXISTS rec_line_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rec_id            UUID REFERENCES account_recs(id) ON DELETE CASCADE,
  description       TEXT,
  gl_amount         NUMERIC,
  schedule_amount   NUMERIC,
  match_status      TEXT DEFAULT 'unmatched'
    CHECK (match_status IN ('matched','unmatched','suggested')),
  ai_explanation    TEXT,
  preparer_override TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (all authenticated users can read/write for now)
ALTER TABLE close_tasks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_recs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rec_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_close_tasks"    ON close_tasks    FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_all_account_recs"   ON account_recs   FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_all_rec_line_items" ON rec_line_items FOR ALL USING (auth.role() = 'authenticated');
