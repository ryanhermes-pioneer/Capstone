import { supabase } from './src/supabase.js';
import {
  MONTH_ORDER, fileToRows, extractPLRevenue, extractProjectTotals,
  buildReconciliations, analyzeReconciliation, THRESHOLD,
} from './src/reconcile.js';

// ── State ───────────────────────────────────────────────────────
let role = 'consultant';
const upload = { plRows: null, projRows: null, preview: [] };

const view  = document.getElementById('view');
const toastEl = document.getElementById('toast');

// ── Status metadata ─────────────────────────────────────────────
const STATUS = {
  pending_analyst: { label: 'Pending Analyst', cls: 'st-amber' },
  pending_cfo:     { label: 'Pending CFO',     cls: 'st-blue'  },
  approved:        { label: 'Approved',        cls: 'st-green' },
  denied:          { label: 'Denied',          cls: 'st-red'   },
};

// ── Utils ───────────────────────────────────────────────────────
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sortByMonth = rows => [...rows].sort((a, b) => MONTH_ORDER.indexOf(a.month) - MONTH_ORDER.indexOf(b.month));

let toastTimer;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), 3200);
}

// ── Data layer ──────────────────────────────────────────────────
async function fetchRecs() {
  const { data, error } = await supabase.from('reconciliations').select('*');
  if (error) { toast(error.message, 'err'); return []; }
  return sortByMonth(data);
}

async function submitForReview(records) {
  const rows = records.map(r => ({
    month: r.month,
    year: r.year,
    pl_revenue: r.pl_revenue,
    projects_total: r.projects_total,
    claude_analysis: r.claude_analysis,
    status: 'pending_analyst',
    analyst_confirmed_at: null,
    cfo_user_id: null,
    cfo_decided_at: null,
    denial_note: null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('reconciliations')
    .upsert(rows, { onConflict: 'month,year' });
  if (error) { toast(error.message, 'err'); return false; }
  return true;
}

async function updateStatus(id, patch) {
  const { error } = await supabase
    .from('reconciliations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) { toast(error.message, 'err'); return false; }
  return true;
}

// ── Role switching ──────────────────────────────────────────────
document.getElementById('roleSwitch').addEventListener('click', e => {
  const btn = e.target.closest('.role-btn');
  if (!btn) return;
  role = btn.dataset.role;
  document.querySelectorAll('.role-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

// ── Render dispatch ─────────────────────────────────────────────
async function render() {
  if (role === 'consultant') return renderConsultant();
  if (role === 'analyst')    return renderLedger('analyst');
  if (role === 'cfo')        return renderLedger('cfo');
}

// ── Consultant: upload + discrepancy check + submit ─────────────
async function renderConsultant() {
  const recs = await fetchRecs();
  view.innerHTML = `
    <section class="card">
      <h1>Upload close files</h1>
      <p class="sub">Provide the firm P&amp;L and the revenue-by-client/project export. Claude reconciles project revenue against the P&amp;L and flags discrepancies for the client's financial analyst.</p>
      <div class="drops">
        ${dropHTML('pl', 'P&L (financial actuals)', upload.plRows)}
        ${dropHTML('proj', 'Projects by company', upload.projRows)}
      </div>
      <div id="previewWrap"></div>
    </section>
    ${recs.length ? `<section class="card"><h2>Workflow status</h2>${ledgerTable(recs, 'consultant')}</section>` : ''}
  `;
  wireDrop('pl', 'plRows');
  wireDrop('proj', 'projRows');
  renderPreview();
}

function dropHTML(id, label, loaded) {
  return `
    <label class="drop ${loaded ? 'loaded' : ''}" id="drop-${id}">
      <input type="file" id="file-${id}" accept=".csv,.xlsx,.xls" hidden>
      <div class="drop-icon">${loaded ? '✓' : '📄'}</div>
      <strong>${label}</strong>
      <span>${loaded ? 'Loaded — click to replace' : 'Click or drop CSV / XLSX'}</span>
    </label>`;
}

function wireDrop(id, key) {
  const drop = document.getElementById(`drop-${id}`);
  const input = document.getElementById(`file-${id}`);
  input.addEventListener('change', e => e.target.files[0] && loadFile(e.target.files[0], key));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0], key);
  });
}

async function loadFile(file, key) {
  try {
    upload[key] = await fileToRows(file);
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, 'err');
    return;
  }
  upload.preview = [];
  renderConsultant();
}

async function renderPreview() {
  const wrap = document.getElementById('previewWrap');
  if (!wrap) return;
  if (!upload.plRows || !upload.projRows) {
    wrap.innerHTML = '<p class="hint">Upload both files to run the discrepancy check.</p>';
    return;
  }

  const records = buildReconciliations(
    extractPLRevenue(upload.plRows),
    extractProjectTotals(upload.projRows),
  );
  if (!records.length) {
    wrap.innerHTML = '<p class="hint err-text">No overlapping months found. Check that both files use month names and the P&amp;L has a "Revenue" line.</p>';
    return;
  }

  wrap.innerHTML = `<p class="hint">Running Claude discrepancy check…</p>`;
  const analyses = await Promise.all(records.map(analyzeReconciliation));
  records.forEach((r, i) => (r.claude_analysis = analyses[i]));
  upload.preview = records;

  wrap.innerHTML = `
    <h2>Discrepancy check</h2>
    ${ledgerTable(records.map(r => ({ ...r, status: 'preview' })), 'preview')}
    <div class="actions-row">
      <button class="btn btn-primary" id="btnSubmit">Submit ${records.length} month(s) for analyst review</button>
    </div>`;
  document.getElementById('btnSubmit').addEventListener('click', async e => {
    e.target.disabled = true;
    const ok = await submitForReview(upload.preview);
    if (ok) {
      toast('Submitted for analyst review.');
      upload.plRows = upload.projRows = null; upload.preview = [];
      renderConsultant();
    } else e.target.disabled = false;
  });
}

// ── Analyst / CFO ledger ────────────────────────────────────────
async function renderLedger(forRole) {
  const recs = await fetchRecs();
  const intro = forRole === 'analyst'
    ? { h: 'Analyst approvals', s: 'Review Claude\'s reconciliation and confirm each month before it advances to the CFO.' }
    : { h: 'CFO sign-off', s: 'Approve or deny each reconciliation confirmed by the financial analyst.' };
  view.innerHTML = `
    <section class="card">
      <h1>${intro.h}</h1>
      <p class="sub">${intro.s}</p>
      ${recs.length ? ledgerTable(recs, forRole) : '<p class="hint">Nothing submitted yet.</p>'}
    </section>`;
  wireLedgerActions(forRole);
}

function ledgerTable(recs, forRole) {
  const rows = sortByMonth(recs).map(r => {
    const variance = r.projects_total - r.pl_revenue;
    const pct = r.pl_revenue ? (variance / Math.abs(r.pl_revenue)) * 100 : 0;
    const material = Math.abs(pct) >= THRESHOLD;
    const st = STATUS[r.status];
    const badge = forRole === 'preview'
      ? `<span class="pill ${material ? 'pill-bad' : 'pill-ok'}">${material ? 'Discrepancy' : 'Ties out'}</span>`
      : `<span class="st ${st?.cls || ''}">${st?.label || r.status}</span>`;

    return `
      <tr>
        <td>${esc(r.month)} ${r.year || ''}</td>
        <td class="num">${money(r.pl_revenue)}</td>
        <td class="num">${money(r.projects_total)}</td>
        <td class="num ${material ? 'bad' : ''}">${variance >= 0 ? '+' : ''}${money(variance)}</td>
        <td class="num"><span class="pct ${material ? 'pill-bad' : 'pill-ok'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span></td>
        <td>${badge}</td>
        ${forRole === 'analyst' || forRole === 'cfo'
          ? `<td class="act">${actionButtons(r, forRole)}</td>` : ''}
      </tr>
      <tr class="analysis-row">
        <td colspan="${forRole === 'analyst' || forRole === 'cfo' ? 7 : 6}">
          <span class="ai-tag">Claude</span> ${esc(r.claude_analysis) || '—'}
          ${r.denial_note ? `<div class="deny-note">Denied: ${esc(r.denial_note)}</div>` : ''}
        </td>
      </tr>`;
  }).join('');

  const actCol = (forRole === 'analyst' || forRole === 'cfo') ? '<th>Action</th>' : '';
  return `
    <div class="tscroll">
      <table class="ledger">
        <thead><tr>
          <th>Month</th><th class="num">P&amp;L revenue</th><th class="num">Projects total</th>
          <th class="num">Variance</th><th class="num">%</th><th>Status</th>${actCol}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function actionButtons(r, forRole) {
  if (forRole === 'analyst') {
    if (r.status === 'pending_analyst') return `<button class="btn btn-sm btn-primary" data-act="confirm" data-id="${r.id}">Confirm</button>`;
    if (r.status === 'denied') return `<button class="btn btn-sm btn-primary" data-act="confirm" data-id="${r.id}">Re-submit</button>`;
    return '<span class="muted">—</span>';
  }
  // cfo
  return r.status === 'pending_cfo'
    ? `<button class="btn btn-sm btn-primary" data-act="approve" data-id="${r.id}">Approve</button>
       <button class="btn btn-sm btn-deny" data-act="deny" data-id="${r.id}">Deny</button>`
    : '<span class="muted">—</span>';
}

function wireLedgerActions(forRole) {
  view.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      let ok = false;
      if (btn.dataset.act === 'confirm') {
        ok = await updateStatus(id, { status: 'pending_cfo', analyst_confirmed_at: new Date().toISOString(), denial_note: null, cfo_decided_at: null });
        if (ok) toast('Confirmed — sent to CFO.');
      } else if (btn.dataset.act === 'approve') {
        ok = await updateStatus(id, { status: 'approved', cfo_decided_at: new Date().toISOString() });
        if (ok) toast('Approved.');
      } else if (btn.dataset.act === 'deny') {
        const note = prompt('Reason for denial (returned to analyst):');
        if (note === null) return;
        ok = await updateStatus(id, { status: 'denied', cfo_decided_at: new Date().toISOString(), denial_note: note });
        if (ok) toast('Denied.', 'err');
      }
      if (ok) renderLedger(forRole);
    });
  });
}

render();
