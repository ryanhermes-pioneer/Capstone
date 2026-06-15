import * as XLSX from 'xlsx';
import Anthropic from '@anthropic-ai/sdk';

// ── State ──────────────────────────────────────────────────────
let csvData = {};        // { account: { month: number } }
let acctOrder = [];
let months = [];
let acknowledged = new Set();
let openAcct = null;
const DUMMY_EMAIL = 'finance-close@pioneer-demo.com';

const S = { upload: false, select: false, review: false, ack: false, send: false };
const commentaryCache = new Map();

const anthropic = new Anthropic({
  apiKey: import.meta.env.VITE_CLAUDE_API_KEY,
  dangerouslyAllowBrowser: true,
});

const SUB  = ['total cost of services','gross profit','total operating expenses','ebitda','operating income','pre-tax income','net income'];
const SECE = ['billable travel & expenses','gross profit','total operating expenses','ebitda','operating income (ebit)','pre-tax income'];
const INC  = ['revenue','gross profit','ebitda','operating income','pre-tax income','net income'];

const isSub  = a => SUB.some(k  => a.toLowerCase().includes(k));
const isSecE = a => SECE.includes(a.toLowerCase());
const isFavUp= a => INC.some(k  => a.toLowerCase().includes(k));

// ── DOM ────────────────────────────────────────────────────────
const upZone  = document.getElementById('upZone');
const fileInp = document.getElementById('fileInput');
const ctrlBar = document.getElementById('ctrlBar');
const tCard   = document.getElementById('tCard');
const selFrom = document.getElementById('selFrom');
const selTo   = document.getElementById('selTo');
const btnSend = document.getElementById('btnSend');
const btnExp  = document.getElementById('btnExport');
const tBody   = document.getElementById('tBody');
const tt      = document.getElementById('tt');
const ttSent  = document.getElementById('ttSent');
const ttBody  = document.getElementById('ttBody');
const ttAck   = document.getElementById('ttAck');
const ttClose  = document.getElementById('ttClose');
const btnAckAll = document.getElementById('btnAckAll');

// ── Upload ─────────────────────────────────────────────────────
upZone.addEventListener('click', () => fileInp.click());
fileInp.addEventListener('change', e => { if (e.target.files[0]) readFile(e.target.files[0]); });
upZone.addEventListener('dragover',  e => { e.preventDefault(); upZone.classList.add('drag'); });
upZone.addEventListener('dragleave', ()  => upZone.classList.remove('drag'));
upZone.addEventListener('drop', e => {
  e.preventDefault(); upZone.classList.remove('drag');
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});

function readFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  const reader = new FileReader();

  if (ext === 'csv') {
    reader.onload = async e => {
      const rows = csvToRows(e.target.result);
      showUploadLoading();
      const colMap = await normalizeColumns(rows);
      parseTable(rows, colMap);
    };
    reader.readAsText(f);
  } else {
    reader.onload = async e => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).map(r => r.map(String));
      showUploadLoading();
      const colMap = await normalizeColumns(rows);
      parseTable(rows, colMap);
    };
    reader.readAsArrayBuffer(f);
  }
}

function showUploadLoading() {
  const strong = upZone.querySelector('strong');
  if (strong) strong.textContent = 'Analyzing file structure…';
  const p = upZone.querySelector('p');
  if (p) p.textContent = 'Claude is identifying your column layout…';
}

// ── Parsing ────────────────────────────────────────────────────
function csvToRows(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const out = []; let cur = '', q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  });
}

function parseTable(rows, { accountCol = 0, monthCol = 1, valueCol = 2 } = {}) {
  if (rows.length < 2) { alert('File appears empty.'); return; }

  csvData = {}; acctOrder = [];
  const monthFirst = {};

  rows.slice(1).forEach((cols, li) => {
    if (!cols[accountCol] || !cols[monthCol]) return;
    const acct  = String(cols[accountCol]).trim();
    const month = String(cols[monthCol]).trim();
    const val   = parseFloat(cols[valueCol]) || 0;
    if (!csvData[acct]) { csvData[acct] = {}; acctOrder.push(acct); }
    csvData[acct][month] = val;
    if (monthFirst[month] === undefined) monthFirst[month] = li;
  });

  months = Object.keys(monthFirst).sort((a, b) => monthFirst[a] - monthFirst[b]);

  [selFrom, selTo].forEach(s => {
    s.innerHTML = '';
    months.forEach(m => {
      const o = document.createElement('option');
      o.value = o.textContent = m;
      s.appendChild(o);
    });
  });
  if (months.length >= 2) {
    selFrom.value = months[months.length - 2];
    selTo.value   = months[months.length - 1];
  }

  upZone.classList.add('hidden');
  ctrlBar.classList.remove('hidden');
  tCard.classList.remove('hidden');

  complete('upload');
  render();
  preloadCommentary();
}

// ── Column normalization ────────────────────────────────────────
const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)/i;

function looksLikeMonths(rows, col) {
  return rows.slice(1, 8).some(r => MONTH_RE.test(String(r[col] ?? '').trim()));
}

function detectColumnsLocally(rows) {
  const sampleRows = rows.slice(1, 8);
  let monthCol = -1;
  for (let c = 0; c < rows[0].length; c++) {
    if (looksLikeMonths(rows, c)) { monthCol = c; break; }
  }
  if (monthCol === -1) return { accountCol: 0, monthCol: 1, valueCol: 2 };

  let accountCol = -1, valueCol = -1;
  for (let c = 0; c < rows[0].length; c++) {
    if (c === monthCol) continue;
    const vals = sampleRows.map(r => String(r[c] ?? '').trim()).filter(Boolean);
    const numericCount = vals.filter(v => !isNaN(parseFloat(v.replace(/[$,]/g, '')))).length;
    if (numericCount >= vals.length * 0.8) { if (valueCol === -1) valueCol = c; }
    else { if (accountCol === -1) accountCol = c; }
  }
  return {
    accountCol: accountCol >= 0 ? accountCol : 0,
    monthCol,
    valueCol:   valueCol   >= 0 ? valueCol   : 2,
  };
}

async function normalizeColumns(rows) {
  if (rows.length < 2) return { accountCol: 0, monthCol: 1, valueCol: 2 };

  const headers = rows[0];
  const sample  = rows.slice(1, 5);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Identify column indices (0-based) in this financial spreadsheet. Return JSON only — no explanation, no markdown fences.

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sample)}

Return exactly: {"accountCol":<number>,"monthCol":<number>,"valueCol":<number>}
- accountCol: column containing account/line-item names (text, not numbers)
- monthCol: column containing month or period labels (e.g. "January", "Feb 2026", "2026-01")
- valueCol: column with the primary actual/current-period dollar values (prefer "Actual" over Budget or Prior Year)`
      }]
    });

    const raw     = response.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed  = JSON.parse(jsonStr);

    if (
      typeof parsed.accountCol === 'number' &&
      typeof parsed.monthCol   === 'number' &&
      typeof parsed.valueCol   === 'number' &&
      looksLikeMonths(rows, parsed.monthCol)
    ) {
      console.log('Normalization via API:', parsed);
      return parsed;
    }
    console.warn('API normalization result invalid, falling back to local detection', parsed);
  } catch (err) {
    console.error('Column normalization error:', err);
  }

  const local = detectColumnsLocally(rows);
  console.log('Normalization via local detection:', local);
  return local;
}

// ── Selectors ──────────────────────────────────────────────────
function onPeriodChange() { acknowledged.clear(); S.ack = false; render(); checkSelect(); preloadCommentary(); }
selFrom.addEventListener('change', onPeriodChange);
selTo.addEventListener('change',   onPeriodChange);

function checkSelect() {
  if (selFrom.value && selTo.value && selFrom.value !== selTo.value) complete('select');
}

// ── Render ─────────────────────────────────────────────────────
function render() {
  const fm = selFrom.value, tm = selTo.value;
  if (!fm || !tm) return;

  document.getElementById('hFrom').textContent  = fm;
  document.getElementById('hTo').textContent    = tm;
  document.getElementById('tTitle').textContent = `${fm} → ${tm}  ·  Variance Analysis`;

  let pending = 0, total = 0;
  tBody.innerHTML = '';

  acctOrder.forEach(acct => {
    const fv = csvData[acct]?.[fm]; const tv = csvData[acct]?.[tm];
    if (fv == null || tv == null) return;

    const delta   = tv - fv;
    const pct     = fv !== 0 ? (delta / Math.abs(fv)) * 100 : 0;
    const flagged = Math.abs(pct) > 5;
    const fav     = isFavUp(acct) ? delta > 0 : delta < 0;
    const acked   = acknowledged.has(acct);

    const pillCls = !flagged ? 'pill-flat' : (fav ? 'pill-fav' : 'pill-bad');
    const sign    = delta >= 0 ? '+' : '';

    if (flagged) { total++; if (!acked) pending++; }

    const tr = document.createElement('tr');
    if (isSub(acct))  tr.classList.add('sub');
    if (isSecE(acct)) tr.classList.add('sec-end');

    let flagCell = '';
    if (flagged) {
      const cls = acked ? 'acked' : 'unacked';
      const lbl = acked ? '✓' : '!';
      flagCell = `<button class="flag-btn ${cls}" data-acct="${esc(acct)}" data-delta="${delta}" data-pct="${pct}" data-fm="${esc(fm)}" data-tm="${esc(tm)}">${lbl}</button>`;
    }

    tr.innerHTML =
      `<td>${esc(acct)}</td>` +
      `<td>${fmt(fv)}</td>` +
      `<td>${fmt(tv)}</td>` +
      `<td>${sign}${fmt(delta)}</td>` +
      `<td><span class="pill ${pillCls}">${sign}${Math.abs(pct).toFixed(1)}%</span></td>` +
      `<td style="text-align:center">${flagCell}</td>`;

    tBody.appendChild(tr);
  });

  const fb = document.getElementById('fBadge');
  if (total === 0)        { fb.textContent = 'No flags'; fb.className = 'flag-badge clear'; btnAckAll.style.display = 'none'; }
  else if (pending === 0) { fb.textContent = `${total} acknowledged`; fb.className = 'flag-badge clear'; btnAckAll.style.display = 'none'; }
  else                    { fb.textContent = `${pending} of ${total} pending`; fb.className = 'flag-badge pending'; btnAckAll.style.display = ''; }

  tBody.querySelectorAll('.flag-btn').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); openTT(b); })
  );

  complete('review');
  checkSelect();
  checkAck(total, pending);
}

// ── Tooltip ────────────────────────────────────────────────────
async function openTT(btn) {
  openAcct = btn.dataset.acct;
  const delta = parseFloat(btn.dataset.delta);
  const pct   = parseFloat(btn.dataset.pct);
  const fm    = btn.dataset.fm;
  const tm    = btn.dataset.tm;

  const fav = isFavUp(openAcct) ? delta > 0 : delta < 0;
  ttSent.textContent = fav ? '✦ Favorable Variance' : '⚑ Unfavorable Variance';
  ttSent.className   = `tt-sent ${fav ? 'fav' : 'bad'}`;
  ttBody.textContent = 'Generating commentary…';
  ttAck.disabled     = true;
  ttAck.textContent  = acknowledged.has(openAcct) ? '✓ Acknowledged' : '✓ Acknowledge';

  tt.classList.add('open');
  const r  = btn.getBoundingClientRect();
  const h  = tt.getBoundingClientRect().height || 140;
  let top  = r.top - h - 8;
  let left = r.right - 278;
  if (top < 8)  top  = r.bottom + 8;
  if (left < 8) left = 8;
  tt.style.top  = top  + 'px';
  tt.style.left = left + 'px';

  const { sent, text } = await commentary(openAcct, fm, tm, delta, pct);
  if (openAcct !== btn.dataset.acct) return;
  ttSent.textContent = sent === 'fav' ? '✦ Favorable Variance' : '⚑ Unfavorable Variance';
  ttSent.className   = `tt-sent ${sent}`;
  ttBody.textContent = text;
  ttAck.disabled     = acknowledged.has(openAcct);
  ttAck.textContent  = acknowledged.has(openAcct) ? '✓ Acknowledged' : '✓ Acknowledge';
}

ttAck.addEventListener('click', () => {
  if (!openAcct) return;
  acknowledged.add(openAcct);
  tt.classList.remove('open');
  openAcct = null;
  render();
});

ttClose.addEventListener('click', () => { tt.classList.remove('open'); openAcct = null; });
document.addEventListener('click', e => {
  if (!tt.contains(e.target) && !e.target.classList.contains('flag-btn')) {
    tt.classList.remove('open'); openAcct = null;
  }
});

// ── Commentary ─────────────────────────────────────────────────
async function commentary(acct, fm, tm, delta, pct) {
  const key = `${acct}|${fm}|${tm}`;
  if (commentaryCache.has(key)) return commentaryCache.get(key);

  const fav      = isFavUp(acct) ? delta > 0 : delta < 0;
  const absPct   = Math.abs(pct).toFixed(1);
  const absDelta = (delta > 0 ? '+$' : '-$') + Math.abs(Math.round(delta)).toLocaleString('en-US');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: `You are a senior management consultant reviewing a month-end financial close at a professional services firm. Write exactly 2 sentences of variance commentary.

Account: ${acct}
Period: ${fm} → ${tm}
Change: ${absDelta} (${absPct}% — ${fav ? 'favorable' : 'unfavorable'})

Sentence 1: Name the most likely operational driver specific to this account type.
Sentence 2: State the specific close action the finance team should take before sign-off.

Output only the 2 sentences, no labels or headers.`
      }]
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim() ?? 'Commentary unavailable.';
    const result = { sent: fav ? 'fav' : 'bad', text };
    commentaryCache.set(key, result);
    return result;
  } catch (err) {
    console.error('Claude API error:', err);
    return fallbackCommentary(acct, fm, tm, delta, pct);
  }
}

function fallbackCommentary(acct, fm, tm, delta, pct) {
  const fav      = isFavUp(acct) ? delta > 0 : delta < 0;
  const dir      = delta > 0 ? 'increased' : 'decreased';
  const absPct   = Math.abs(pct).toFixed(1);
  const absDelta = (delta > 0 ? '+$' : '-$') + Math.abs(Math.round(delta)).toLocaleString('en-US');
  const lc = acct.toLowerCase();

  let ctx;
  if      (lc.includes('revenue'))       ctx = delta > 0 ? 'Strong top-line growth — confirm project billing is complete.' : 'Revenue decline — review pipeline activity and unbilled work.';
  else if (lc.includes('subcontractor')) ctx = delta > 0 ? 'Subcontractor spend up — confirm against project budgets and client reimbursement.' : 'Subcontractor usage reduced, improving margins.';
  else if (lc.includes('marketing') || lc.includes('business development')) ctx = delta > 0 ? 'BD spend increased — confirm against approved budget.' : 'Marketing spend below prior month.';
  else if (lc.includes('salary') || lc.includes('wages')) ctx = delta > 0 ? 'Labor up — check for new hires, bonus accruals, or retro adjustments.' : 'Labor down — verify no missing accruals or timing gaps.';
  else if (lc.includes('travel'))        ctx = delta > 0 ? 'Travel up — verify billable items are tagged for client reimbursement.' : 'Travel reduced.';
  else if (lc.includes('professional fees')) ctx = delta > 0 ? 'Professional fees up — confirm invoice timing.' : 'Professional fees reduced.';
  else if (lc.includes('gross profit'))  ctx = delta > 0 ? 'Margin expanding — positive trend.' : 'Margin compression — review cost of services drivers.';
  else if (lc.includes('ebitda'))        ctx = delta > 0 ? 'Operating leverage improving.' : 'EBITDA under pressure — investigate cost overruns.';
  else if (lc.includes('net income'))    ctx = delta > 0 ? 'Bottom line growth.' : 'Net income decline — review non-operating items.';
  else ctx = fav ? 'Within expected range — monitor going forward.' : 'Exceeds threshold — confirm with budget owner.';

  return { sent: fav ? 'fav' : 'bad', text: `${acct} ${dir} ${absPct}% (${absDelta}) from ${fm} to ${tm}. ${ctx}` };
}

async function preloadCommentary() {
  const fm = selFrom.value, tm = selTo.value;
  if (!fm || !tm) return;
  const flagged = acctOrder.filter(acct => {
    const fv = csvData[acct]?.[fm], tv = csvData[acct]?.[tm];
    if (fv == null || tv == null) return false;
    return Math.abs(fv !== 0 ? ((tv - fv) / Math.abs(fv)) * 100 : 0) > 5;
  });
  await Promise.all(flagged.map(acct => {
    const fv = csvData[acct][fm], tv = csvData[acct][tm];
    const delta = tv - fv;
    const pct   = fv !== 0 ? (delta / Math.abs(fv)) * 100 : 0;
    return commentary(acct, fm, tm, delta, pct);
  }));
}

btnAckAll.addEventListener('click', () => {
  const fm = selFrom.value, tm = selTo.value;
  acctOrder.forEach(acct => {
    const fv = csvData[acct]?.[fm], tv = csvData[acct]?.[tm];
    if (fv == null || tv == null) return;
    const d = tv - fv, p = fv !== 0 ? (d / Math.abs(fv)) * 100 : 0;
    if (Math.abs(p) > 5) acknowledged.add(acct);
  });
  render();
});

// ── Checklist / Progress ───────────────────────────────────────
function checkAck(total, pending) {
  if (total === 0 || pending === 0) complete('ack');
  else { S.ack = false; updateProgress(); }
  btnSend.disabled = !(S.upload && S.select && S.review && S.ack);
}

function complete(key) {
  if (S[key]) return;
  S[key] = true;
  updateProgress();
}

function updateProgress() {
  const keys = Object.keys(S);
  const done = keys.filter(k => S[k]).length;
  const pct  = Math.round((done / keys.length) * 100);

  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progLbl').textContent  = `${done} of ${keys.length}`;
  document.getElementById('progPct').textContent  = pct + '%';

  document.querySelectorAll('.step').forEach(el => {
    const k = el.dataset.k;
    el.classList.toggle('done',   !!S[k]);
    el.classList.toggle('active', !S[k]);
  });

  const pill = document.getElementById('sPill');
  const txt  = document.getElementById('sTxt');
  if      (done === 0)         { pill.dataset.s = 'idle';     txt.textContent = 'Not Started'; }
  else if (done < keys.length) { pill.dataset.s = 'progress'; txt.textContent = 'In Progress'; }
  else                         { pill.dataset.s = 'closed';   txt.textContent = 'Closed'; }
}

// ── Send email ─────────────────────────────────────────────────
btnSend.addEventListener('click', () => {
  const fm = selFrom.value, tm = selTo.value;
  let body = `Month-End Close Report: ${fm} → ${tm}\nPrepared via Closed by Claude · EPiC 2026\n\n`;
  body += `VARIANCE SUMMARY (>5% MoM)\n${'─'.repeat(42)}\n`;

  acctOrder.forEach(acct => {
    const fv = csvData[acct]?.[fm]; const tv = csvData[acct]?.[tm];
    if (fv == null || tv == null) return;
    const d = tv - fv, pct = fv !== 0 ? (d / Math.abs(fv)) * 100 : 0;
    if (Math.abs(pct) <= 5) return;
    const sign = d >= 0 ? '+' : '';
    body += `${acct}: ${sign}${Math.round(d).toLocaleString('en-US')} (${sign}${pct.toFixed(1)}%) — ${acknowledged.has(acct) ? 'Acknowledged' : 'Pending'}\n`;
  });

  body += `\n${acknowledged.size} flag(s) acknowledged.\nGenerated automatically — reply to discuss.\n`;
  const sub = encodeURIComponent(`Month-End Close Report: ${fm} → ${tm}`);
  window.location.href = `mailto:${DUMMY_EMAIL}?subject=${sub}&body=${encodeURIComponent(body)}`;
  complete('send');
});

// ── Export CSV ─────────────────────────────────────────────────
btnExp.addEventListener('click', () => {
  const fm = selFrom.value, tm = selTo.value;
  const rows = [['Account', fm, tm, 'Change $', 'Change %', 'Flagged', 'Acknowledged']];
  acctOrder.forEach(acct => {
    const fv = csvData[acct]?.[fm]; const tv = csvData[acct]?.[tm];
    if (fv == null || tv == null) return;
    const d   = tv - fv;
    const pct = fv !== 0 ? (d / Math.abs(fv)) * 100 : 0;
    const fl  = Math.abs(pct) > 5;
    rows.push([acct, Math.round(fv), Math.round(tv), Math.round(d), pct.toFixed(2) + '%', fl ? 'Yes' : '', fl && acknowledged.has(acct) ? 'Yes' : '']);
  });
  const blob = new Blob([rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `variance-${fm}-${tm}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
});

// ── Utils ──────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
