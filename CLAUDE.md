# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is the **EPiC Capstone** project for Pioneer Management Consulting — a month-end **close reconciliation** tool. A single web app walks three roles through one workflow, with all state persisted in Supabase:

1. **Consultant** uploads the firm P&L and the revenue-by-client/project export. Claude reconciles total project revenue against the P&L "Revenue" line for each month and flags discrepancies.
2. **Financial analyst** (client side) reviews Claude's reconciliation and confirms each month.
3. **CFO** approves or denies each confirmed month.

Status machine on `reconciliations`: `pending_analyst → pending_cfo → approved | denied`. A denied month returns to the analyst to re-submit.

Sample data lives in `sample-data/` (`financial-data.csv`, `revenue-by-client.csv`).

## Commands

```bash
npm run dev       # Start Vite dev server (localhost:5173)
npm run build     # Production build → dist/
npm run preview   # Preview production build locally
```

## Architecture

**Vite + vanilla JS**, single-page, no framework. Entry: `index.html` → `main.js`.

- `main.js` — role switcher + the three role views, wired to Supabase.
- `src/reconcile.js` — file parsing (CSV/XLSX), per-month P&L-vs-projects reconciliation, and discrepancy commentary via the Edge Function (with a local fallback when it's unreachable or has no key).
- `src/supabase.js` — Supabase client (publishable key, no auth session).
- `supabase/functions/analyze-reconciliation/` — Deno Edge Function that proxies the Anthropic API so the key never reaches the browser.

Dependencies: `@supabase/supabase-js` (persistence + Edge Function invocation), `xlsx` (spreadsheet parsing). The Anthropic call lives in the Edge Function, not the client bundle.

Roles are selected with a **client-side switcher** (prototype — no login). The Supabase project keeps three seeded `user_roles`/auth users from an earlier auth-based design; the switcher does not depend on them.

## Environment

Env vars go in `.env` (gitignored), exposed to the client via Vite's `VITE_` prefix:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` — the Capstone Supabase project + publishable key (publishable keys are safe in the client bundle).

The Anthropic key is **not** a client var. It is set as the `ANTHROPIC_API_KEY` secret on the `analyze-reconciliation` Edge Function (`supabase secrets set ANTHROPIC_API_KEY=…`, or the dashboard under Edge Functions → Secrets). Without it the function returns no commentary and the client renders a local fallback.

## Database

Supabase project **Capstone** (`tvhmtjxzrlmynmjhkkse`). Core table `reconciliations` (one row per month/year, unique on `(month, year)`). Prototype RLS grants the `anon` role select/insert/update so the role switcher works without auth. Schema changes are tracked as Supabase migrations.

## Infrastructure

All backend infrastructure must use Pioneer Management Consulting's official **Supabase**, **Azure**, and **GitHub** accounts. Do not deploy to, configure, or integrate with any other platforms. Involve the National DA Team before connecting to production data sources (HubSpot, NetSuite, etc.) or provisioning databases.

## Data

`sample-data/financial-data.csv` is the core financial dataset (firm P&L). Treat financial data as sensitive — do not expose its contents in logs or outputs.
