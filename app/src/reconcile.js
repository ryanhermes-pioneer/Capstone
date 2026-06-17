import * as XLSX from 'xlsx';
import Anthropic from '@anthropic-ai/sdk';

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
    // Projects export is windows-1252; also decodes plain UTF-8/ASCII fine.
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

// ── Build reconciliation records ────────────────────────────────
export function buildReconciliations(plRevenue, projectTotals) {
  const months = [...new Set([...Object.keys(plRevenue), ...Object.keys(projectTotals)])]
    .filter(m => MONTH_ORDER.includes(m))
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  return months.map(month => {
    const pl       = plRevenue[month]      ?? 0;
    const projects = projectTotals[month]  ?? 0;
    const variance = projects - pl;
    const pct      = pl !== 0 ? (variance / Math.abs(pl)) * 100 : 0;
    return { month, year: YEAR, pl_revenue: pl, projects_total: projects, variance, pct };
  });
}

// ── Claude discrepancy commentary ───────────────────────────────
const anthropic = new Anthropic({
  apiKey: import.meta.env.VITE_CLAUDE_API_KEY,
  dangerouslyAllowBrowser: true,
});

const THRESHOLD = 1;

export async function analyzeReconciliation(rec) {
  const { month, pl_revenue, projects_total, variance, pct } = rec;
  if (!import.meta.env.VITE_CLAUDE_API_KEY) return fallbackAnalysis(rec);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a senior management consultant reconciling a month-end close at a professional services firm. Compare the firm-wide P&L revenue against the sum of client/project revenue for the same month, then write exactly 2 sentences.

Month: ${month}
P&L revenue (actual): $${Math.round(pl_revenue).toLocaleString('en-US')}
Sum of project revenue: $${Math.round(projects_total).toLocaleString('en-US')}
Variance: ${variance >= 0 ? '+' : ''}$${Math.round(variance).toLocaleString('en-US')} (${pct.toFixed(1)}%)

Sentence 1: State whether the two sources reconcile and the most likely cause of any gap (e.g. unbilled work, timing, revenue not yet allocated to projects, intercompany items).
Sentence 2: State the specific action the client's financial analyst should verify before sign-off.

Output only the 2 sentences, no labels.`,
      }],
    });
    return response.content.find(b => b.type === 'text')?.text?.trim() || fallbackAnalysis(rec);
  } catch (err) {
    console.error('Claude analysis error:', err);
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

// ── Per-company helpers (consultant invoice) ─────────────────────
export function extractCompanies(rows) {
  if (rows.length < 2) return [];
  const headers   = rows[0];
  const clientCol = Math.max(0, findCol(headers, 'client', 'company', 'customer'));
  const seen      = new Set();
  for (const r of rows.slice(1)) {
    const co = String(r[clientCol]).trim();
    if (co) seen.add(co);
  }
  return [...seen].sort();
}

export function extractMonthsForCompany(rows, company) {
  if (rows.length < 2) return [];
  const headers   = rows[0];
  const monthCol  = Math.max(0, findCol(headers, 'month', 'period'));
  const clientCol = Math.max(0, findCol(headers, 'client', 'company', 'customer'));
  const seen      = new Set();
  for (const r of rows.slice(1)) {
    if (company && String(r[clientCol]).trim() !== company) continue;
    const m = monthName(r[monthCol]);
    if (MONTH_ORDER.includes(m)) seen.add(m);
  }
  return [...seen].sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));
}

export function extractProjectsForCompany(rows, company, month) {
  if (rows.length < 2) return [];
  const headers    = rows[0];
  const clientCol  = Math.max(0, findCol(headers, 'client', 'company', 'customer'));
  const projectCol = Math.max(0, findCol(headers, 'project', 'engagement', 'description'));
  const monthCol   = Math.max(0, findCol(headers, 'month', 'period'));
  let   valueCol   = findCol(headers, 'revenue', 'amount', 'sum');
  if (valueCol < 0) valueCol = rows[0].length - 1;

  const out = [];
  for (const r of rows.slice(1)) {
    if (String(r[clientCol]).trim() !== company) continue;
    if (monthName(r[monthCol]) !== month) continue;
    const project = String(r[projectCol]).trim();
    if (!project) continue;
    out.push({ project, revenue: num(r[valueCol]) });
  }
  return out;
}
