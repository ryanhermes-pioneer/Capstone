# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is the **EPiC Capstone** project for Pioneer Management Consulting — a financial data analysis tool. The primary data source (`financial-data.csv`) contains monthly P&L actuals, budget, and prior-year comparisons across revenue, COGS, and operating expense line items for consulting engagements.

Reference documents in `information/` provide context on closed projects and revenue breakdowns by client and project.

## Commands

```bash
npm run dev       # Start Vite dev server (localhost:5173)
npm run build     # Production build → dist/
npm run preview   # Preview production build locally
```

Python scripts (if any): activate `.venv/` first — `.venv\Scripts\activate` on Windows.

## Architecture

This is a **Vite + vanilla JS** frontend app (no framework). Key dependencies:

- `@anthropic-ai/sdk` — Claude API integration for AI-powered financial analysis
- `xlsx` — parsing `financial-data.csv` and Excel files client-side

The app reads financial CSV/spreadsheet data in the browser, sends it to Claude via the Anthropic SDK, and renders analysis results. Entry points follow standard Vite convention (`index.html` → `main.js`).

## Environment

API keys go in `.env` (gitignored). The Anthropic API key must be present for Claude features to work. Vite exposes env vars prefixed with `VITE_` to the client bundle.

## Infrastructure

All backend infrastructure must use Pioneer Management Consulting's official **Supabase**, **Azure**, and **GitHub** accounts. Do not deploy to, configure, or integrate with any other platforms. Involve the National DA Team before connecting to production data sources (HubSpot, NetSuite, etc.) or provisioning databases.

## Data

`financial-data.csv` (untracked) contains the core financial dataset. Treat it as sensitive — do not commit it or expose its contents in logs or outputs.
