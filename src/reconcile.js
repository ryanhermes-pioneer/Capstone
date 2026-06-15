import * as XLSX from 'xlsx';
import { supabase } from './supabase.js';

export const MONTH_ORDER = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const YEAR = 2026;

// ── File → rows (array of arrays) ───────────────────────────────
export async function fileToRows(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buffer = await file.arrayBuffer();

  if (ext === 'csv') {
    // Projects export is windows-1252; this also decodes plain UTF-8/ASCII fine.
    const text = new TextDecoder('windows-1252').decode(buffer);
    return parseCSV(text);
  }
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).map(r => r.map(String));
}

function parseCSV(text) {
  return text.replace(/\r\n?/g, '\n').trim().split('\n').map(line => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

const num = v => parseFloat(String(v).replace(/[$,\s]/g, '')) || 0;
const monthName = v => {
  const m = String(v).trim();
  return MONTH_ORDER.find(mo => m.toLowerCase().startsWith(mo.slice(0, 3).toLowerCase())) || m;
};
const findCol = (headers, ...needles) => {
  const i = headers.findIndex(h =>
    needles.some(n => String(h).toLowerCase().includes(n)));
  return i;
};

// ── P&L → { month: revenueActual } ──────────────────────────────
// Reads the firm-wide "Revenue" line item per month from the actuals column.
export function extractPLRevenue(rows) {
  if (rows.length < 2) return {};
  const headers = rows[0];
  const acctCol  = Math.max(0, findCol(headers, 'account', 'line'));
  const monthCol = Math.max(1, findCol(headers, 'month', 'period'));
  let valueCol   = findCol(headers, 'actual');
  if (valueCol < 0) valueCol = 2;

  const out = {};
  for (const r of rows.slice(1)) {
    if (String(r[acctCol]).trim().toLowerCase() !== 'revenue') continue;
    out[monthName(r[monthCol])] = num(r[valueCol]);
  }
  return out;
}

// ── Projects → { month: total } ─────────────────────────────────
// Sums every client/project revenue line into a firm-wide monthly total.
export function extractProjectTotals(rows) {
  if (rows.length < 2) return {};
  const headers = rows[0];
  const monthCol = Math.max(0, findCol(headers, 'month', 'period'));
  let valueCol   = findCol(headers, 'revenue', 'amount', 'sum');
  if (valueCol < 0) valueCol = rows[0].length - 1;
  const clientCol = Math.max(0, findCol(headers, 'client', 'company', 'customer'));

  const out = {};
  for (const r of rows.slice(1)) {
    if (!String(r[clientCol]).trim() || !String(r[monthCol]).trim()) continue;
    const m = monthName(r[monthCol]);
    out[m] = (out[m] || 0) + num(r[valueCol]);
  }
  return out;
}

// ── Build reconciliation records from both files ────────────────
export function buildReconciliations(plRevenue, projectTotals) {
  const months = [...new Set([...Object.keys(plRevenue), ...Object.keys(projectTotals)])]
    .filter(m => MONTH_ORDER.includes(m))
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  return months.map(month => {
    const pl = plRevenue[month] ?? 0;
    const projects = projectTotals[month] ?? 0;
    const variance = projects - pl;
    const pct = pl !== 0 ? (variance / Math.abs(pl)) * 100 : 0;
    return { month, year: YEAR, pl_revenue: pl, projects_total: projects, variance, pct };
  });
}

// ── Claude discrepancy commentary ───────────────────────────────
// The Anthropic key lives only in the `analyze-reconciliation` Supabase Edge
// Function. The browser sends figures and receives commentary; if the function
// is unreachable or has no key configured, we fall back to a local summary.
const THRESHOLD = 1; // % variance considered material

export async function analyzeReconciliation(rec) {
  try {
    const { data, error } = await supabase.functions.invoke('analyze-reconciliation', {
      body: {
        month: rec.month,
        pl_revenue: rec.pl_revenue,
        projects_total: rec.projects_total,
        variance: rec.variance,
        pct: rec.pct,
      },
    });
    if (error) throw error;
    return data?.analysis || fallbackAnalysis(rec);
  } catch (err) {
    console.error('analyze-reconciliation error:', err);
    return fallbackAnalysis(rec);
  }
}

function fallbackAnalysis(rec) {
  const { month, variance, pct } = rec;
  const abs = '$' + Math.abs(Math.round(variance)).toLocaleString('en-US');
  if (Math.abs(pct) < THRESHOLD) {
    return `${month} project revenue ties to the P&L within ${Math.abs(pct).toFixed(1)}% (${abs}); no material discrepancy. Confirm the immaterial residual is rounding before sign-off.`;
  }
  const dir = variance > 0 ? 'exceeds' : 'falls short of';
  return `${month} project revenue ${dir} the P&L by ${abs} (${pct.toFixed(1)}%), suggesting timing differences or work billed but not yet allocated to projects. The analyst should reconcile unbilled/deferred revenue and confirm all client invoices are captured before approving.`;
}

export { THRESHOLD };
