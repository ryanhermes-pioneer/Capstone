-- Reset financial data for a clean demo run.
-- Preserves: auth.users, user_roles
-- Run in: Supabase Dashboard → SQL Editor → New query

TRUNCATE TABLE rec_line_items  RESTART IDENTITY CASCADE;
TRUNCATE TABLE account_recs    RESTART IDENTITY CASCADE;
TRUNCATE TABLE reconciliations RESTART IDENTITY CASCADE;
TRUNCATE TABLE audit_log       RESTART IDENTITY CASCADE;
TRUNCATE TABLE close_tasks     RESTART IDENTITY CASCADE;
