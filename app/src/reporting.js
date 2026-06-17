import { supabase } from './supabase.js';
import { fileToRows } from './reconcile.js';
import { jsPDF } from 'jspdf';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: import.meta.env.VITE_CLAUDE_API_KEY,
  dangerouslyAllowBrowser: true,
});

const esc  = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct   = (v, base) => base !== 0 ? ((v / Math.abs(base)) * 100).toFixed(1) + '%' : '—';
const sign  = n => n >= 0 ? '+' : '';

// account classification (same as Reporting Module)
const SUB  = ['total cost of services','gross profit','total operating expenses','ebitda','operating income','pre-tax income','net income'];
const INC  = ['revenue','gross profit','ebitda','operating income','pre-tax income','net income'];
const isSub   = a => SUB.some(k => a.toLowerCase().includes(k));
const isFavUp = a => INC.some(k => a.toLowerCase().includes(k));

// PDF branding (matches invoice.js)
const DARK  = [45, 41, 38];
const GREEN = [87, 161, 119];
const GRAY  = [92, 86, 80];
const LGRAY = [231, 227, 218];
const OFF   = [247, 245, 242];
const WHITE = [255, 255, 255];

// ── State ────────────────────────────────────────────────────────
let plData     = null; // { account: { month: number } }, acctOrder, months
let pyData     = null; // same shape, prior year
let bsData     = null; // { assets: [{name,balance}], liabilities: [...], equity: [...] }
let narrative  = '';
let signedOffAccounts = new Set();

// ── Public: render Reporting tab ─────────────────────────────────
export async function renderReportingView(container, toast) {
  await loadSignedOffAccounts();

  container.innerHTML = `
    <section class="card">
      <div class="task-header-row">
        <div>
          <h1>Financial Reporting</h1>
          <p class="sub">Upload financial data to generate P&L, balance sheet, and AI-powered CFO commentary.</p>
        </div>
        <button class="btn btn-primary" id="btnDownloadReport" disabled>Download PDF</button>
      </div>

      <div class="report-uploads">
        <label class="drop ${plData ? 'loaded' : ''}" id="dropPL">
          <input type="file" id="filePL" accept=".csv,.xlsx,.xls" hidden>
          <div class="drop-icon">${plData ? '✓' : '📄'}</div>
          <strong>P&L / Financial Actuals</strong>
          <span>${plData ? 'Loaded — click to replace' : 'CSV or XLSX with account, month, value columns'}</span>
        </label>
        <label class="drop ${pyData ? 'loaded' : ''}" id="dropPY">
          <input type="file" id="filePY" accept=".csv,.xlsx,.xls" hidden>
          <div class="drop-icon">${pyData ? '✓' : '📄'}</div>
          <strong>Prior Year (optional)</strong>
          <span>${pyData ? 'Loaded — click to replace' : 'Same format — used for YoY variance'}</span>
        </label>
        <label class="drop ${bsData ? 'loaded' : ''}" id="dropBS">
          <input type="file" id="fileBS" accept=".csv,.xlsx,.xls" hidden>
          <div class="drop-icon">${bsData ? '✓' : '📄'}</div>
          <strong>Balance Sheet Extract</strong>
          <span>${bsData ? 'Loaded — click to replace' : 'Account, balance, type (asset/liability/equity)'}</span>
        </label>
      </div>

      ${plData ? renderPeriodSelector() : '<p class="hint" style="margin-top:1rem;">Upload the P&L file to begin.</p>'}
    </section>

    <div id="plSection"></div>
    <div id="bsSection"></div>
    <div id="narrativeSection"></div>`;

  wireReportUploads(container, toast);

  if (plData) {
    renderPLStatement(container, toast);
    if (bsData) renderBalanceSheet(container);
  }
}

async function loadSignedOffAccounts() {
  const { data } = await supabase.from('account_recs')
    .select('account_name').eq('status', 'signed_off');
  signedOffAccounts = new Set((data || []).map(r => r.account_name));
}

// ── Period selector ──────────────────────────────────────────────
function renderPeriodSelector() {
  if (!plData) return '';
  const months = plData.months;
  const opts = months.map(m => `<option value="${m}">${m}</option>`).join('');
  const optsPY = months.map(m => `<option value="${m}">${m}</option>`).join('');
  return `
    <div class="period-row" style="margin-top:1.2rem;">
      <div class="select-group">
        <label class="sel-lbl">Current Period</label>
        <select class="sel" id="selCurrent">${opts}</select>
      </div>
      <div class="select-group">
        <label class="sel-lbl">Compare to (Prior Month)</label>
        <select class="sel" id="selPrior">${optsPY}</select>
      </div>
      <button class="btn btn-primary" id="btnGenNarrative">Generate CFO Narrative</button>
    </div>`;
}

// ── P&L Statement ────────────────────────────────────────────────
function renderPLStatement(container, toast) {
  const section = container.querySelector('#plSection');
  if (!section || !plData) return;

  const currentSel = container.querySelector('#selCurrent');
  const priorSel   = container.querySelector('#selPrior');
  if (!currentSel) return;

  const curMo  = currentSel.value  || plData.months[plData.months.length - 1];
  const priorMo = priorSel?.value  || plData.months[Math.max(0, plData.months.length - 2)];

  // Group accounts into P&L sections
  const SECTIONS = [
    { key: 'revenue',  label: 'Revenue',          keywords: ['revenue','net revenue','total revenue'] },
    { key: 'cogs',     label: 'Cost of Services',  keywords: ['cost of service','subcontractor','direct cost','cost of revenue','cogs'] },
    { key: 'gross',    label: 'Gross Profit',       keywords: ['gross profit'] },
    { key: 'opex',     label: 'Operating Expenses', keywords: ['operating expense','salary','wages','marketing','rent','depreciation','general','administrative','professional fee','travel','software','insurance'] },
    { key: 'ebitda',   label: 'EBITDA',             keywords: ['ebitda'] },
    { key: 'other',    label: 'Other / Below Line', keywords: ['interest','tax','pre-tax','net income'] },
  ];

  const assigned = new Set();
  const buckets  = {};
  SECTIONS.forEach(s => { buckets[s.key] = []; });

  for (const acct of plData.acctOrder) {
    const lc = acct.toLowerCase();
    for (const s of SECTIONS) {
      if (s.keywords.some(k => lc.includes(k))) {
        buckets[s.key].push(acct); assigned.add(acct); break;
      }
    }
  }
  // uncategorized → opex
  for (const acct of plData.acctOrder) {
    if (!assigned.has(acct)) buckets.opex.push(acct);
  }

  const acctRow = (acct) => {
    const cur   = plData.data[acct]?.[curMo]  ?? 0;
    const prior = plData.data[acct]?.[priorMo] ?? 0;
    const delta = cur - prior;
    const p     = prior !== 0 ? (delta / Math.abs(prior)) * 100 : 0;
    const fav   = isFavUp(acct) ? delta >= 0 : delta <= 0;
    const mat   = Math.abs(p) >= 5;
    const pillCls = !mat ? '' : (fav ? 'pill-ok' : 'pill-bad');
    const sub   = isSub(acct);

    // prior year comparison
    const pyVal = pyData?.data[acct]?.[curMo] ?? null;
    const pyDelta = pyVal != null ? cur - pyVal : null;
    const pyP = pyVal && pyVal !== 0 ? (pyDelta / Math.abs(pyVal)) * 100 : null;

    return `
      <tr class="${sub ? 'pl-subtotal' : ''}">
        <td class="${sub ? 'pl-sub-lbl' : ''}">${esc(acct)}</td>
        <td class="num">${money(prior)}</td>
        ${pyData ? `<td class="num muted">${pyVal != null ? money(pyVal) : '—'}</td>` : ''}
        <td class="num"><strong>${money(cur)}</strong></td>
        <td class="num">${sign(delta)}${money(delta)}</td>
        <td class="num">${mat ? `<span class="pct ${pillCls}">${sign(p)}${Math.abs(p).toFixed(1)}%</span>` : `<span class="muted">${sign(p)}${Math.abs(p).toFixed(1)}%</span>`}</td>
        ${pyData ? `<td class="num">${pyDelta != null ? sign(pyDelta)+money(pyDelta) : '—'}</td><td class="num">${pyP != null ? sign(pyP)+Math.abs(pyP).toFixed(1)+'%' : '—'}</td>` : ''}
      </tr>`;
  };

  let html = `
    <section class="card">
      <h2 style="font-size:1rem;margin-bottom:0.75rem;">Income Statement — ${curMo} 2026</h2>
      <div class="tscroll">
        <table class="ledger pl-table">
          <thead><tr>
            <th>Account</th>
            <th class="num">${esc(priorMo)}</th>
            ${pyData ? '<th class="num">Prior Year</th>' : ''}
            <th class="num"><strong>${esc(curMo)}</strong></th>
            <th class="num">Δ vs PM</th>
            <th class="num">% PM</th>
            ${pyData ? '<th class="num">Δ vs PY</th><th class="num">% PY</th>' : ''}
          </tr></thead>
          <tbody>`;

  for (const s of SECTIONS) {
    if (!buckets[s.key].length) continue;
    html += `<tr class="pl-section-hdr"><td colspan="${pyData ? 8 : 6}">${s.label}</td></tr>`;
    html += buckets[s.key].map(acctRow).join('');
  }

  html += `</tbody></table></div></section>`;
  section.innerHTML = html;

  container.querySelector('#selCurrent')?.addEventListener('change', () => renderPLStatement(container, toast));
  container.querySelector('#selPrior')?.addEventListener('change',   () => renderPLStatement(container, toast));
  container.querySelector('#btnGenNarrative')?.addEventListener('click', () => generateNarrative(container, toast, curMo, priorMo));

  const btnDl = container.querySelector('#btnDownloadReport');
  if (btnDl) btnDl.disabled = false;
  btnDl?.addEventListener('click', () => downloadReportPDF(curMo, priorMo));
}

// ── Balance Sheet ────────────────────────────────────────────────
function renderBalanceSheet(container) {
  const section = container.querySelector('#bsSection');
  if (!section || !bsData) return;

  const sectionRows = (items) => items.map(item => {
    const notSigned = !signedOffAccounts.has(item.name);
    return `<tr>
      <td>${esc(item.name)}${notSigned && item.balance != null ? ' <span class="bs-unsigned" title="Not yet signed off">⚠</span>' : ''}</td>
      <td class="num">${item.balance != null ? money(item.balance) : '—'}</td>
    </tr>`;
  }).join('');

  const totalA = bsData.assets.reduce((s, r)      => s + (r.balance ?? 0), 0);
  const totalL = bsData.liabilities.reduce((s, r) => s + (r.balance ?? 0), 0);
  const totalE = bsData.equity.reduce((s, r)      => s + (r.balance ?? 0), 0);
  const balanced = Math.abs(totalA - (totalL + totalE)) < 1;

  section.innerHTML = `
    <section class="card">
      <h2 style="font-size:1rem;margin-bottom:0.75rem;">Balance Sheet</h2>
      ${!balanced ? `<div class="balance-warn">⚠ Out of balance: Assets ${money(totalA)} ≠ Liabilities + Equity ${money(totalL + totalE)}</div>` : ''}
      <div class="bs-grid">
        <div class="bs-col">
          <h3 class="bs-section-hdr">Assets</h3>
          <table class="ledger">
            <tbody>${sectionRows(bsData.assets)}</tbody>
            <tfoot><tr class="total-row"><td><strong>Total Assets</strong></td><td class="num"><strong>${money(totalA)}</strong></td></tr></tfoot>
          </table>
        </div>
        <div class="bs-col">
          <h3 class="bs-section-hdr">Liabilities</h3>
          <table class="ledger">
            <tbody>${sectionRows(bsData.liabilities)}</tbody>
            <tfoot><tr class="total-row"><td><strong>Total Liabilities</strong></td><td class="num"><strong>${money(totalL)}</strong></td></tr></tfoot>
          </table>
          <h3 class="bs-section-hdr" style="margin-top:1.25rem;">Equity</h3>
          <table class="ledger">
            <tbody>${sectionRows(bsData.equity)}</tbody>
            <tfoot><tr class="total-row"><td><strong>Total Equity</strong></td><td class="num"><strong>${money(totalE)}</strong></td></tr></tfoot>
          </table>
          <table class="ledger" style="margin-top:0.5rem;">
            <tfoot><tr class="total-row"><td><strong>Total L + E</strong></td><td class="num"><strong>${money(totalL + totalE)}</strong></td></tr></tfoot>
          </table>
        </div>
      </div>
    </section>`;
}

// ── CFO Narrative ────────────────────────────────────────────────
async function generateNarrative(container, toast, curMo, priorMo) {
  const btn = container.querySelector('#btnGenNarrative');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  // Build summary numbers
  const revenue  = plData?.data['Revenue']?.[curMo] ?? plData?.data['Net Revenue']?.[curMo] ?? 0;
  const revPrior = plData?.data['Revenue']?.[priorMo] ?? plData?.data['Net Revenue']?.[priorMo] ?? 0;
  const gp       = plData?.data['Gross Profit']?.[curMo]  ?? 0;
  const gpPrior  = plData?.data['Gross Profit']?.[priorMo] ?? 0;
  const ebitda   = plData?.data['EBITDA']?.[curMo]  ?? 0;
  const netInc   = plData?.data['Net Income']?.[curMo] ?? 0;

  const summaryLines = plData.acctOrder.slice(0, 20).map(a =>
    `${a}: ${money(plData.data[a]?.[curMo] ?? 0)} (prior: ${money(plData.data[a]?.[priorMo] ?? 0)})`
  ).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a CFO writing a board-level monthly close commentary for a management consulting firm. Write a single paragraph of 3–4 sentences.

Period: ${curMo} 2026 vs ${priorMo} 2026
Revenue: ${money(revenue)} (prior: ${money(revPrior)}, change: ${sign(revenue-revPrior)}${money(revenue-revPrior)})
Gross Profit: ${money(gp)} | EBITDA: ${money(ebitda)} | Net Income: ${money(netInc)}

Key line items:
${summaryLines}

Lead with revenue performance, then margin movement, then key expense drivers. Use specific dollar amounts and percentages. Be concise and executive in tone.

Output only the paragraph, no labels.`,
      }],
    });
    narrative = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  } catch (err) {
    console.error('CFO narrative error:', err);
    narrative = `${curMo} revenue of ${money(revenue)} represents a ${sign(revenue-revPrior)}${money(revenue-revPrior)} change versus ${priorMo}. Gross profit was ${money(gp)}. Review complete — all figures pending final sign-off.`;
  }

  const narSection = container.querySelector('#narrativeSection');
  if (narSection) {
    narSection.innerHTML = `
      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
          <h2 style="font-size:1rem;">CFO Commentary — ${curMo} 2026</h2>
          <span class="ai-tag">Claude</span>
        </div>
        <textarea class="narrative-editor" id="narrativeEditor" rows="5">${esc(narrative)}</textarea>
      </section>`;
    container.querySelector('#narrativeEditor')?.addEventListener('input', e => { narrative = e.target.value; });
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Regenerate CFO Narrative'; }
}

// ── File uploads ─────────────────────────────────────────────────
function wireReportUploads(container, toast) {
  const wireFile = (inputId, dropId, handler) => {
    const input = container.querySelector(`#${inputId}`);
    const drop  = container.querySelector(`#${dropId}`);
    if (!input || !drop) return;
    const load = f => { handler(f, drop); };
    input.addEventListener('change', e => e.target.files[0] && load(e.target.files[0]));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
  };

  wireFile('filePL', 'dropPL', async (f, drop) => {
    try {
      drop.querySelector('.drop-icon').textContent = '…';
      const rows = await fileToRows(f);
      plData = await parsePLFile(rows);
      drop.classList.add('loaded');
      drop.querySelector('.drop-icon').textContent = '✓';
      drop.querySelector('span').textContent = 'Loaded — click to replace';
      renderReportingView(container, toast);
    } catch (err) { toast(`Could not read ${f.name}: ${err.message}`, 'err'); drop.querySelector('.drop-icon').textContent = '📄'; }
  });

  wireFile('filePY', 'dropPY', async (f, drop) => {
    try {
      const rows = await fileToRows(f);
      pyData = await parsePLFile(rows);
      drop.classList.add('loaded');
      drop.querySelector('.drop-icon').textContent = '✓';
      drop.querySelector('span').textContent = 'Loaded — click to replace';
      if (plData) renderPLStatement(container, toast);
    } catch (err) { toast(`Could not read ${f.name}: ${err.message}`, 'err'); }
  });

  wireFile('fileBS', 'dropBS', async (f, drop) => {
    try {
      const rows = await fileToRows(f);
      bsData = await parseBSFile(rows, toast);
      drop.classList.add('loaded');
      drop.querySelector('.drop-icon').textContent = '✓';
      drop.querySelector('span').textContent = 'Loaded — click to replace';
      renderBalanceSheet(container);
    } catch (err) { toast(`Could not read ${f.name}: ${err.message}`, 'err'); }
  });
}

// ── File parsers ─────────────────────────────────────────────────
async function parsePLFile(rows) {
  if (rows.length < 2) throw new Error('File appears empty.');
  const colMap = await normalizeColumns(rows);
  const data = {}; const acctOrder = []; const monthFirst = {};

  rows.slice(1).forEach((cols, li) => {
    const acct  = String(cols[colMap.accountCol] ?? '').trim();
    const month = String(cols[colMap.monthCol]   ?? '').trim();
    const val   = parseFloat(cols[colMap.valueCol]) || 0;
    if (!acct || !month) return;
    if (!data[acct]) { data[acct] = {}; acctOrder.push(acct); }
    data[acct][month] = val;
    if (monthFirst[month] === undefined) monthFirst[month] = li;
  });

  const months = Object.keys(monthFirst).sort((a, b) => monthFirst[a] - monthFirst[b]);
  return { data, acctOrder, months };
}

async function parseBSFile(rows, toast) {
  if (rows.length < 2) throw new Error('Balance sheet file appears empty.');
  const colMap = await normalizeBSColumns(rows);
  const assets = [], liabilities = [], equity = [];

  for (const r of rows.slice(1)) {
    const name    = String(r[colMap.nameCol]    ?? '').trim();
    const balance = parseFloat(String(r[colMap.balanceCol] ?? '').replace(/[$,]/g,'')) || 0;
    const type    = String(r[colMap.typeCol]    ?? '').trim().toLowerCase();
    if (!name) continue;
    const item = { name, balance };
    if (type.includes('asset'))     assets.push(item);
    else if (type.includes('liab')) liabilities.push(item);
    else if (type.includes('equit') || type.includes('capital')) equity.push(item);
    else assets.push(item); // default to assets
  }
  return { assets, liabilities, equity };
}

async function normalizeColumns(rows) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Return JSON only, no markdown. Identify 0-based column indices.
Headers: ${JSON.stringify(rows[0])}
Sample: ${JSON.stringify(rows.slice(1,4))}
Return: {"accountCol":<n>,"monthCol":<n>,"valueCol":<n>}
- accountCol: account/line-item names
- monthCol: month or period labels
- valueCol: primary actual dollar values` }],
    });
    const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '';
    return JSON.parse(raw.replace(/```(?:json)?/gi,'').trim());
  } catch { return { accountCol: 0, monthCol: 1, valueCol: 2 }; }
}

async function normalizeBSColumns(rows) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Return JSON only, no markdown. Identify 0-based column indices for a balance sheet extract.
Headers: ${JSON.stringify(rows[0])}
Sample: ${JSON.stringify(rows.slice(1,4))}
Return: {"nameCol":<n>,"balanceCol":<n>,"typeCol":<n>}
- nameCol: account name
- balanceCol: dollar balance
- typeCol: account type (asset/liability/equity)` }],
    });
    const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '';
    return JSON.parse(raw.replace(/```(?:json)?/gi,'').trim());
  } catch { return { nameCol: 0, balanceCol: 1, typeCol: 2 }; }
}

// ── PDF Export ───────────────────────────────────────────────────
function downloadReportPDF(curMo, priorMo) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = 612; let y = 0;

  // Header bar
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, 80, 'F');
  doc.setFillColor(...GREEN);
  doc.roundedRect(36, 18, 44, 44, 6, 6, 'F');
  doc.setTextColor(...WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('P', 58, 47, { align: 'center' });
  doc.setFontSize(13);
  doc.text('Pioneer Management Consulting', 92, 38);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(176, 170, 162);
  doc.text(`Claude Close  ·  ${curMo} 2026  ·  EPiC Capstone`, 92, 53);
  doc.setTextColor(...WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Financial Report', W - 36, 47, { align: 'right' });
  y = 100;

  // CFO Narrative
  if (narrative) {
    doc.setFillColor(...OFF);
    doc.rect(36, y, W - 72, 10, 'F');
    doc.setFontSize(7); doc.setFont('helvetica','bold'); doc.setTextColor(...GRAY);
    doc.text('CFO COMMENTARY', 44, y + 7);
    y += 16;
    doc.setFontSize(9.5); doc.setFont('helvetica','normal'); doc.setTextColor(...DARK);
    const lines = doc.splitTextToSize(narrative, W - 72);
    doc.text(lines, 36, y);
    y += lines.length * 14 + 16;
  }

  // P&L table
  if (plData) {
    doc.setFillColor(...OFF);
    doc.rect(36, y, W - 72, 10, 'F');
    doc.setFontSize(7); doc.setFont('helvetica','bold'); doc.setTextColor(...GRAY);
    doc.text('INCOME STATEMENT', 44, y + 7);
    y += 16;

    const colW = [220, 90, 90, 80, 72];
    const cols = ['Account', priorMo, curMo, '$ Change', '% Change'];
    doc.setFontSize(7.5); doc.setTextColor(...GRAY);
    let x = 36;
    cols.forEach((c, i) => { doc.text(c, x + (i > 0 ? colW[i] : 0), y, { align: i > 0 ? 'right' : 'left' }); x += colW[i]; });
    y += 4;
    doc.setDrawColor(...LGRAY); doc.line(36, y, W - 36, y); y += 8;

    doc.setFontSize(8.5); doc.setTextColor(...DARK);
    for (const acct of plData.acctOrder) {
      if (y > 740) { doc.addPage(); y = 40; }
      const cur   = plData.data[acct]?.[curMo]   ?? 0;
      const prior = plData.data[acct]?.[priorMo] ?? 0;
      const delta = cur - prior;
      const p     = prior !== 0 ? (delta / Math.abs(prior)) * 100 : 0;
      const sub   = isSub(acct);
      if (sub) { doc.setFont('helvetica','bold'); doc.setTextColor(...GREEN); }
      else     { doc.setFont('helvetica','normal'); doc.setTextColor(...DARK); }

      doc.text(acct.slice(0,36), 36, y);
      doc.text(money(prior), 36 + colW[0] + colW[1], y, { align: 'right' });
      doc.text(money(cur),   36 + colW[0] + colW[1] + colW[2], y, { align: 'right' });
      doc.text((delta >= 0 ? '+' : '') + money(delta), 36 + colW[0] + colW[1] + colW[2] + colW[3], y, { align: 'right' });
      doc.text(sign(p)+Math.abs(p).toFixed(1)+'%', W - 36, y, { align: 'right' });
      doc.setDrawColor(...LGRAY); doc.line(36, y + 3, W - 36, y + 3);
      y += 14;
    }
    y += 10;
  }

  // Balance Sheet
  if (bsData) {
    if (y > 600) { doc.addPage(); y = 40; }
    doc.setFillColor(...OFF);
    doc.rect(36, y, W - 72, 10, 'F');
    doc.setFontSize(7); doc.setFont('helvetica','bold'); doc.setTextColor(...GRAY);
    doc.text('BALANCE SHEET', 44, y + 7);
    y += 16;

    const printBSSection = (label, items) => {
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...GREEN);
      doc.text(label.toUpperCase(), 36, y); y += 10;
      doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...DARK);
      for (const item of items) {
        if (y > 740) { doc.addPage(); y = 40; }
        doc.text(item.name.slice(0, 42), 44, y);
        doc.text(money(item.balance), W - 36, y, { align: 'right' });
        y += 12;
      }
      const total = items.reduce((s,i) => s + (i.balance ?? 0), 0);
      doc.setFont('helvetica','bold');
      doc.text(`Total ${label}`, 36, y); doc.text(money(total), W - 36, y, { align: 'right' });
      doc.setDrawColor(...LGRAY); doc.line(36, y + 3, W - 36, y + 3);
      y += 16;
    };

    printBSSection('Assets', bsData.assets);
    printBSSection('Liabilities', bsData.liabilities);
    printBSSection('Equity', bsData.equity);
  }

  doc.save(`Pioneer-Financial-Report-${curMo}-2026.pdf`);
}
