import { supabase } from './src/supabase.js';
import { downloadInvoicePDF } from './src/invoice.js';
import {
  MONTH_ORDER, THRESHOLD,
  fileToRows,
  extractPLRevenue, extractProjectTotals, buildReconciliations, analyzeReconciliation,
  extractProjectLineItems, extractAllClientMonths,
  extractCompanies, extractMonthsForCompany, extractProjectsForCompany,
} from './src/reconcile.js';

// ── Constants ─────────────────────────────────────────────────────
const QUARTERS = {
  Q1: ['January','February','March'],
  Q2: ['April','May','June'],
  Q3: ['July','August','September'],
  Q4: ['October','November','December'],
};

// ── State ────────────────────────────────────────────────────────
let currentUser = null;
let currentRole = null;
let _sidebarTasks = [];

const consultant = { projRows: null, selectedCompany: null, selectedMonth: null };
const analyst    = {
  plRows: null, projRows: null,
  allRecords:     [],
  analyzedMonths: {},
  periodType:     'month',  // 'month' | 'quarter' | 'year'
  period:         null,     // month name | 'Q1'-'Q4' | '2026'
};

// ── DOM refs ─────────────────────────────────────────────────────
const view        = document.getElementById('view');
const toastEl     = document.getElementById('toast');
const userInfoEl  = document.getElementById('userInfo');
const userRoleEl  = document.getElementById('userRoleBadge');
const userEmailEl = document.getElementById('userEmail');

const ROLE_LABEL = { director: 'Director', analyst: 'Analyst', cfo: 'CFO' };
const STATUS = {
  pending_analyst: { label: 'Pending Review', cls: 'st-amber' },
  pending_cfo:     { label: 'Pending CFO',    cls: 'st-amber' },
  approved:        { label: 'Approved',       cls: 'st-green' },
  denied:          { label: 'Denied',         cls: 'st-red'   },
};

// ── Utils ────────────────────────────────────────────────────────
const money       = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const esc         = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sortByMonth = rows => [...rows].sort((a,b) => MONTH_ORDER.indexOf(a.month) - MONTH_ORDER.indexOf(b.month));

let toastTimer;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className   = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), 3200);
}

function getSelectedMonths() {
  const available = analyst.allRecords.map(r => r.month);
  if (analyst.periodType === 'month')   return analyst.period ? [analyst.period] : [];
  if (analyst.periodType === 'quarter') return (QUARTERS[analyst.period] || []).filter(m => available.includes(m));
  if (analyst.periodType === 'year')    return available;
  return [];
}

// ── Realtime ─────────────────────────────────────────────────────
let realtimeChannel = null;

function initRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase.channel('app-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reconciliations' }, () => {
      fetchRecs().then(updateProgress);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log' }, () => {
      updateAuditTrail();
    })
    .subscribe();
}

// ── Auth ─────────────────────────────────────────────────────────
async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await onSignIn(session.user);
  else renderLanding();

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) await onSignIn(session.user);
    else if (event === 'SIGNED_OUT') {
      if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
      currentUser = null; currentRole = null; _sidebarTasks = [];
      setHeader(false); renderLanding();
    }
  });
}

async function onSignIn(user) {
  currentUser = user;
  const { data, error } = await supabase
    .from('user_roles').select('role').eq('user_id', user.id).single();
  if (error || !data) {
    toast('No role assigned — contact your administrator.', 'err');
    await supabase.auth.signOut(); return;
  }
  currentRole = data.role;
  setHeader(true, user.email, currentRole);
  fetchRecs().then(updateProgress);
  initRealtime();
  renderForRole();
}

function setHeader(loggedIn, email = '', role = '') {
  const track = document.getElementById('progressTrack');
  if (loggedIn) {
    userRoleEl.textContent   = ROLE_LABEL[role] || role;
    userEmailEl.textContent  = email;
    userInfoEl.style.display = 'flex';
    if (track) track.style.display = 'flex';
  } else {
    userInfoEl.style.display = 'none';
    if (track) track.style.display = 'none';
  }
}

function updateProgress(recs) {
  const hasData      = recs.length > 0;
  const hasSubmitted = recs.some(r => ['pending_cfo','approved'].includes(r.status));
  const allApproved  = hasData && recs.every(r => r.status === 'approved');
  const states       = [hasData, hasSubmitted, allApproved];

  states.forEach((done, i) => {
    const el = document.getElementById(`pStep${i + 1}`);
    if (!el) return;
    const isActive = !done && (i === 0 || states[i - 1]);
    el.className = `progress-step${done ? ' done' : isActive ? ' active' : ''}`;
  });
  states.slice(0, -1).forEach((done, i) => {
    const conn = document.getElementById(`pConn${i + 1}`);
    if (conn) conn.className = `progress-conn${done ? ' done' : ''}`;
  });
}

document.getElementById('homeBadge').addEventListener('click',  async () => supabase.auth.signOut());
document.getElementById('btnSignOut').addEventListener('click', async () => supabase.auth.signOut());
async function renderForRole() {
  _sidebarTasks = await loadSidebarTasks();
  if (currentRole === 'director') return renderConsultant();
  if (currentRole === 'analyst')  return renderAnalyst();
  if (currentRole === 'cfo')      return renderCFO();
}

// ══════════════════════════════════════════════════════════════════
// LANDING — Login
// ══════════════════════════════════════════════════════════════════

function workingDaysLeft() {
  const today = new Date(); today.setHours(0,0,0,0);
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  let count = 0;
  for (let d = new Date(today); d <= last; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function staticCalendarHTML(now) {
  const year = now.getFullYear(), month = now.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const eomTasks = {
    [daysInMonth]: [
      { title: 'Send Invoices',    priority: 'high' },
      { title: 'Submit P&L Rec',   priority: 'high' },
      { title: 'CFO Sign-off',     priority: 'high' },
    ],
    [daysInMonth - 1]: [
      { title: 'Reconcile Accts',  priority: 'med' },
      { title: 'Review Variances', priority: 'med' },
    ],
    [daysInMonth - 4]: [
      { title: 'Draft P&L',        priority: 'low' },
    ],
  };

  let html = `<table class="cal-grid"><thead><tr>${dayNames.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody><tr>`;
  let col = 0;
  for (let i = 0; i < firstDay; i++) { html += '<td></td>'; col++; }
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === now.getDate();
    const chips = (eomTasks[d] || []).map(t =>
      `<div class="cal-chip pri-${t.priority === 'med' ? 'med' : t.priority}" title="${t.title}">${t.title}</div>`
    ).join('');
    html += `<td class="${isToday ? 'cal-today' : ''}"><span class="cal-day-num${isToday ? ' today-num' : ''}">${d}</span>${chips}</td>`;
    col++;
    if (col % 7 === 0 && d < daysInMonth) html += '</tr><tr>';
  }
  while (col % 7 !== 0) { html += '<td></td>'; col++; }
  html += '</tr></tbody></table>';
  return html;
}

async function renderLanding() {
  const now = new Date();
  const monthName = MONTH_ORDER[now.getMonth()];
  const year = now.getFullYear();

  // Fetch reconciliation + invoice state — anon RLS allows select on both
  let recs = [], inv = [];
  try {
    const [recRes, invRes] = await Promise.all([
      supabase.from('reconciliations').select('status, claude_analysis'),
      supabase.from('invoice_status').select('sent').eq('month', monthName).eq('year', year),
    ]);
    recs = recRes.data ?? [];
    inv  = invRes.data ?? [];
  } catch (_) {}

  // Director subtask completion (tracked via invoice_status)
  const dSub = [
    inv.length > 0,                              // file uploaded → clients seeded
    inv.some(r => r.sent),                       // at least one invoice sent
    inv.length > 0 && inv.every(r => r.sent),    // all clients invoiced
  ];

  // Analyst subtask completion
  const aSub = [
    recs.length > 0,
    recs.some(r => r.claude_analysis),
    recs.length > 0 && recs.every(r => r.status !== 'pending_analyst'),
  ];

  // CFO subtask completion
  const cSub = [
    recs.some(r => ['pending_cfo', 'approved', 'denied'].includes(r.status)),
    recs.some(r => ['approved', 'denied'].includes(r.status)),
    recs.length > 0 && recs.every(r => r.status === 'approved'),
  ];

  const sub = (labels, done) => labels.map((t, i) =>
    `<li class="${done[i] ? 'sub-done' : ''}">${t}</li>`).join('');

  view.innerHTML = `
    <div class="landing-split">

      <div class="landing-left">
        <div class="role-track">
          <div class="role-step">
            <div class="role-step-icon${dSub.every(Boolean) ? ' complete' : ''}">1</div>
            <div class="role-step-body">
              <div class="role-step-name">Director</div>
              <div class="role-step-desc">Generate &amp; distribute client invoices</div>
              <ul class="role-subtasks">
                ${sub(['Upload project revenue data', 'Generate per-client invoices', 'Send monthly statements'], dSub)}
              </ul>
            </div>
          </div>
          <div class="role-connector"></div>
          <div class="role-step">
            <div class="role-step-icon${aSub.every(Boolean) ? ' complete' : ''}">2</div>
            <div class="role-step-body">
              <div class="role-step-name">Analyst</div>
              <div class="role-step-desc">Reconcile P&amp;L against projects &amp; run Claude analysis</div>
              <ul class="role-subtasks">
                ${sub(['Upload P&amp;L &amp; projects CSVs', 'Review Claude variance analysis', 'Submit months for CFO review'], aSub)}
              </ul>
            </div>
          </div>
          <div class="role-connector"></div>
          <div class="role-step">
            <div class="role-step-icon${cSub.every(Boolean) ? ' complete' : ''}">3</div>
            <div class="role-step-body">
              <div class="role-step-name">CFO</div>
              <div class="role-step-desc">Review variances, approve or deny months</div>
              <ul class="role-subtasks">
                ${sub(['Review pending reconciliations', 'Approve or deny with notes', 'Download approved month report'], cSub)}
              </ul>
            </div>
          </div>
        </div>

        <div class="landing-cal-card">
          <div class="cal-meta">
            <span class="cal-month">${monthName} ${year}</span>
            <span class="days-to-close">${workingDaysLeft()} working days to close</span>
          </div>
          ${staticCalendarHTML(now)}
        </div>
      </div>

      <div class="landing-right">
        <div class="landing-card">
          <div class="landing-logo">
            <img class="p-badge-lg" src="/logo_green.png" alt="Pioneer">
            <h1 class="landing-title">Sign in</h1>
            <p class="landing-sub">Access your close dashboard</p>
          </div>
          <form class="login-form" id="loginForm" novalidate>
            <div class="field-group">
              <label class="field-lbl" for="loginEmail">Email</label>
              <input class="field-input" type="email" id="loginEmail"
                placeholder="you@thepioneerteam.com" required autocomplete="email">
            </div>
            <div class="field-group">
              <label class="field-lbl" for="loginPw">Password</label>
              <input class="field-input" type="password" id="loginPw"
                placeholder="••••••••" required autocomplete="current-password">
            </div>
            <p class="login-err" id="loginErr"></p>
            <button class="btn btn-primary btn-full" type="submit" id="btnLogin">Sign in</button>
          </form>
        </div>
      </div>

    </div>`;

  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPw').value;
    const errEl    = document.getElementById('loginErr');
    const btn      = document.getElementById('btnLogin');
    btn.disabled = true; btn.textContent = 'Signing in…'; errEl.textContent = '';
    await supabase.auth.signOut();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { errEl.textContent = error.message; btn.disabled = false; btn.textContent = 'Sign in'; }
  });
}

// ── Data layer ───────────────────────────────────────────────────
async function fetchRecs() {
  const { data, error } = await supabase.from('reconciliations').select('*');
  if (error) { toast(error.message, 'err'); return []; }
  return sortByMonth(data);
}

async function upsertRec(rec) {
  const { error } = await supabase.from('reconciliations').upsert({
    month: rec.month, year: rec.year,
    pl_revenue: rec.pl_revenue, projects_total: rec.projects_total,
    claude_analysis: rec.claude_analysis,
    status: 'pending_cfo',
    analyst_user_id: currentUser?.id ?? null,
    analyst_confirmed_at: new Date().toISOString(),
    cfo_user_id: null, cfo_decided_at: null, denial_note: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'month,year' });
  if (error) { toast(error.message, 'err'); return false; }
  await insertAuditLog('Submitted to CFO', rec.month, rec.year);
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

async function insertAuditLog(action, month, year, details = null) {
  const { error } = await supabase.from('audit_log').insert({
    action, month, year: year || 2026,
    user_email: currentUser?.email ?? null,
    details,
  });
  if (error) console.error('audit_log insert failed:', error.message);
}

async function fetchAuditLog() {
  const { data } = await supabase
    .from('audit_log').select('*')
    .order('created_at', { ascending: false }).limit(50);
  return data || [];
}

const AUDIT_ACTION_CLS = { 'Submitted to CFO': 'st-amber', 'Approved': 'st-green', 'Denied': 'st-red' };

function auditLogRows(log) {
  if (!log.length) return '<tr><td colspan="5" class="muted" style="text-align:center;padding:1rem;">No activity yet.</td></tr>';
  return log.map(e => `
    <tr>
      <td>${new Date(e.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</td>
      <td><span class="st ${AUDIT_ACTION_CLS[e.action]||''}">${esc(e.action)}</span></td>
      <td>${esc(e.month||'—')} ${e.year||''}</td>
      <td class="muted">${esc(e.user_email||'—')}</td>
      <td class="muted">${esc(e.details||'')}</td>
    </tr>`).join('');
}

async function updateAuditTrail() {
  const tbody = document.querySelector('.audit-card tbody');
  if (!tbody) return;
  const log = await fetchAuditLog();
  tbody.innerHTML = auditLogRows(log);
}

// ── CSV download ─────────────────────────────────────────────────
function downloadCSV(recs, filename) {
  const headers = [
    'Record ID','Month','Year',
    'P&L Revenue','Projects Total','Variance ($)','Variance (%)','Material',
    'Status',
    'Analyst Confirmed At (UTC)','CFO Decided At (UTC)',
    'Denial Note','Claude AI Analysis',
  ];
  const rows = recs.map(r => {
    const v   = r.projects_total - r.pl_revenue;
    const pct = r.pl_revenue ? (v / Math.abs(r.pl_revenue)) * 100 : 0;
    const mat = Math.abs(pct) >= THRESHOLD ? 'Yes' : 'No';
    return [
      r.id || '',
      r.month, r.year || 2026,
      r.pl_revenue, r.projects_total,
      v.toFixed(2), pct.toFixed(2) + '%', mat,
      r.status,
      r.analyst_confirmed_at ? new Date(r.analyst_confirmed_at).toISOString() : '',
      r.cfo_decided_at       ? new Date(r.cfo_decided_at).toISOString()       : '',
      r.denial_note          || '',
      r.claude_analysis      || '',
    ].map(val => `"${String(val).replace(/"/g,'""')}"`).join(',');
  });
  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════
// DIRECTOR — Invoice generator
// ══════════════════════════════════════════════════════════════════

// ── Sidebar helpers ──────────────────────────────────────────────
async function loadSidebarTasks() {
  if (!currentUser) return [];
  const { data, error } = await supabase
    .from('close_tasks')
    .select('*')
    .eq('owner_email', currentUser.email)
    .order('due_date', { ascending: true, nullsLast: true });
  if (error) { console.error('close_tasks:', error.message); return []; }
  return data ?? [];
}

function sidebarHTML() {
  const now = new Date();
  const monthName = MONTH_ORDER[now.getMonth()];
  const year = now.getFullYear();
  const items = _sidebarTasks.length
    ? _sidebarTasks.map(t => {
        const done   = t.status === 'complete';
        const dueFmt = t.due_date
          ? new Date(t.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
        return `
          <div class="sidebar-task${done ? ' done' : ''}" data-task-id="${t.id}" data-done="${done}">
            <button class="task-check">${done ? '✓' : ''}</button>
            <div class="task-body">
              <span class="task-title">${esc(t.title)}</span>
              ${dueFmt ? `<span class="task-due">${dueFmt}</span>` : ''}
            </div>
          </div>`;
      }).join('')
    : '<p class="sidebar-empty">No tasks assigned</p>';
  return `
    <div class="sidebar-section">
      <div class="sidebar-cal-wrap">
        <div class="cal-meta">
          <span class="cal-month">${monthName} ${year}</span>
          <span class="days-to-close">${workingDaysLeft()} days</span>
        </div>
        ${staticCalendarHTML(now)}
      </div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-hdr">My Tasks</div>
      <div class="sidebar-tasks">${items}</div>
    </div>`;
}

function wireSidebar() {
  view.querySelectorAll('.sidebar-task .task-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row    = btn.closest('.sidebar-task');
      const id     = row.dataset.taskId;
      const isDone = row.dataset.done === 'true';
      const { error } = await supabase
        .from('close_tasks')
        .update({ status: isDone ? 'not_started' : 'complete', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (!error) {
        const nowDone = !isDone;
        row.dataset.done = String(nowDone);
        row.classList.toggle('done', nowDone);
        btn.textContent = nowDone ? '✓' : '';
        const cached = _sidebarTasks.find(t => t.id === id);
        if (cached) cached.status = nowDone ? 'complete' : 'not_started';
      }
    });
  });
}

async function renderConsultant() {
  view.innerHTML = `
    <div class="role-layout">
      <div class="role-sidebar">${sidebarHTML()}</div>
      <div class="role-content">
        <section class="card">
          <h1>Generate invoice</h1>
          <p class="sub">Upload the projects file, then select a client and billing month to preview and send the invoice.</p>
          <div class="source-row">
            <label class="drop ${consultant.projRows ? 'loaded' : ''}" id="drop-cproj">
              <input type="file" id="file-cproj" accept=".csv,.xlsx,.xls" hidden>
              <div class="drop-icon">${consultant.projRows ? '✓' : '📄'}</div>
              <strong>Projects / Revenue file</strong>
              <span>${consultant.projRows ? 'Loaded — click to replace' : 'Click or drop CSV / XLSX'}</span>
            </label>
            <button class="btn fabric-btn" id="btnFabric">
              <span class="fabric-icon">⬡</span> Load from Fabric
            </button>
          </div>
          <div id="invoiceWrap"></div>
        </section>
      </div>
    </div>`;

  wireSidebar();
  const drop  = document.getElementById('drop-cproj');
  const input = document.getElementById('file-cproj');
  input.addEventListener('change', e => e.target.files[0] && loadConsultantFile(e.target.files[0]));
  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', ()  => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag');
    if (e.dataTransfer.files[0]) loadConsultantFile(e.dataTransfer.files[0]);
  });
  document.getElementById('btnFabric').addEventListener('click', () =>
    toast('Fabric connection is managed by the DA Team — contact them to enable live data.', 'err')
  );
  if (consultant.projRows) renderInvoiceSelectors();
}

async function loadConsultantFile(file) {
  try { consultant.projRows = await fileToRows(file); }
  catch (err) { toast(`Could not read ${file.name}: ${err.message}`, 'err'); return; }
  consultant.selectedCompany = null; consultant.selectedMonth = null;

  // Seed invoice_status with every client-month from the file (ignoreDuplicates
  // preserves any already-sent rows)
  const pairs = extractAllClientMonths(consultant.projRows);
  if (pairs.length) {
    // Seed invoice_status (preserves already-sent rows)
    await supabase.from('invoice_status')
      .upsert(pairs.map(({ client, month }) => ({ client, month, year: 2026 })),
              { onConflict: 'client,month,year', ignoreDuplicates: true });

    // Seed close_tasks — one "Invoice: {client}" task per client/month, skip existing
    const months = [...new Set(pairs.map(p => p.month))];
    const { data: existing } = await supabase
      .from('close_tasks')
      .select('title, period_month')
      .eq('owner_email', currentUser?.email ?? null)
      .eq('period_year', 2026)
      .in('period_month', months)
      .like('title', 'Invoice:%');

    const existingKeys = new Set((existing ?? []).map(t => `${t.title}|${t.period_month}`));
    const newTasks = pairs
      .filter(({ client, month }) => !existingKeys.has(`Invoice: ${client}|${month}`))
      .map(({ client, month }) => ({
        title:        `Invoice: ${client}`,
        owner_email:  currentUser?.email ?? null,
        due_date:     new Date(2026, MONTH_ORDER.indexOf(month) + 1, 0).toISOString().slice(0, 10),
        priority:     'high',
        status:       'not_started',
        period_month: month,
        period_year:  2026,
      }));

    if (newTasks.length) await supabase.from('close_tasks').insert(newTasks);
    _sidebarTasks = await loadSidebarTasks();
  }

  renderConsultant();
}

function renderInvoiceSelectors() {
  const wrap = document.getElementById('invoiceWrap');
  if (!wrap) return;
  const companies = extractCompanies(consultant.projRows);
  if (!companies.length) { wrap.innerHTML = '<p class="hint err-text">No companies found in file.</p>'; return; }
  if (!consultant.selectedCompany || !companies.includes(consultant.selectedCompany))
    consultant.selectedCompany = companies[0];
  const months = extractMonthsForCompany(consultant.projRows, consultant.selectedCompany);
  if (!consultant.selectedMonth || !months.includes(consultant.selectedMonth))
    consultant.selectedMonth = months[0] || null;

  const coOpts = companies.map(c => `<option value="${esc(c)}" ${c === consultant.selectedCompany ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const moOpts = months.length
    ? months.map(m => `<option value="${esc(m)}" ${m === consultant.selectedMonth ? 'selected' : ''}>${esc(m)}</option>`).join('')
    : '<option>—</option>';

  wrap.innerHTML = `
    <div class="selector-row">
      <div class="select-group">
        <label class="sel-lbl" for="selCo">Client</label>
        <select class="sel" id="selCo">${coOpts}</select>
      </div>
      <div class="select-group">
        <label class="sel-lbl" for="selMo">Month</label>
        <select class="sel" id="selMo"${!months.length ? ' disabled' : ''}>${moOpts}</select>
      </div>
    </div>
    <div id="invoiceCard"></div>`;

  document.getElementById('selCo').addEventListener('change', e => {
    consultant.selectedCompany = e.target.value; consultant.selectedMonth = null;
    renderInvoiceSelectors();
  });
  document.getElementById('selMo').addEventListener('change', e => {
    consultant.selectedMonth = e.target.value;
    renderInvoiceCard();
  });

  if (consultant.selectedMonth) renderInvoiceCard();
}

function renderInvoiceCard() {
  const { selectedCompany: co, selectedMonth: mo, projRows } = consultant;
  const card = document.getElementById('invoiceCard');
  if (!card || !co || !mo) return;

  const projects = extractProjectsForCompany(projRows, co, mo);
  if (!projects.length) {
    card.innerHTML = '<p class="hint">No projects found for this selection.</p>';
    return;
  }

  const total       = projects.reduce((s, p) => s + p.revenue, 0);
  const projectRows = projects.map(p => `<tr><td>${esc(p.project)}</td><td class="num">${money(p.revenue)}</td></tr>`).join('');

  card.innerHTML = `
    <div class="invoice-card">
      <div class="invoice-hdr">
        <div><div class="invoice-title">${esc(co)}</div><div class="invoice-period">${esc(mo)} 2026</div></div>
        <div style="display:flex;gap:0.5rem;">
          <button class="btn" id="btnDownloadPDF">Download PDF</button>
          <button class="btn btn-primary" id="btnSendInvoice">Send Invoice</button>
        </div>
      </div>
      <div class="tscroll">
        <table class="ledger">
          <thead><tr><th>Project</th><th class="num">Revenue</th></tr></thead>
          <tbody>${projectRows}</tbody>
          <tfoot><tr class="total-row"><td><strong>Total</strong></td><td class="num"><strong>${money(total)}</strong></td></tr></tfoot>
        </table>
      </div>
    </div>`;

  document.getElementById('btnDownloadPDF').addEventListener('click', () => {
    downloadInvoicePDF(co, mo, projects);
  });

  document.getElementById('btnSendInvoice').addEventListener('click', async () => {
    downloadInvoicePDF(co, mo, projects);
    await Promise.all([
      supabase.from('invoice_status')
        .update({ sent: true, sent_at: new Date().toISOString(), sent_by: currentUser?.email ?? null })
        .eq('client', co).eq('month', mo).eq('year', 2026),
      supabase.from('close_tasks')
        .update({ status: 'complete' })
        .eq('title', `Invoice: ${co}`)
        .eq('period_month', mo)
        .eq('period_year', 2026)
        .eq('owner_email', currentUser?.email ?? null),
    ]);
    _sidebarTasks = await loadSidebarTasks();
    toast(`Invoice downloaded — open Outlook, compose, and attach the PDF from your downloads`);
    renderConsultant();
  });
}

// ══════════════════════════════════════════════════════════════════
// ANALYST — P&L reconciliation with period selector
// ══════════════════════════════════════════════════════════════════

async function renderAnalyst() {
  if (analyst.plRows && analyst.projRows && !analyst.allRecords.length) {
    analyst.allRecords = buildReconciliations(
      extractPLRevenue(analyst.plRows),
      extractProjectTotals(analyst.projRows),
    );
    if (analyst.allRecords.length && !analyst.period)
      analyst.period = analyst.allRecords[0].month;
  }

  const available  = analyst.allRecords.map(r => r.month);
  const hasFiles   = analyst.plRows && analyst.projRows;
  const hasData    = hasFiles && available.length > 0;

  // Build period selector HTML
  let periodHTML = '';
  if (!hasFiles) {
    periodHTML = '<p class="hint">Upload both files to run the discrepancy check.</p>';
  } else if (!hasData) {
    periodHTML = '<p class="hint err-text">No overlapping months found. Check file formats.</p>';
  } else {
    // Validate current period selection
    if (analyst.periodType === 'month' && (!analyst.period || !available.includes(analyst.period)))
      analyst.period = available[0];
    if (analyst.periodType === 'quarter') {
      const qs = Object.keys(QUARTERS).filter(q => QUARTERS[q].some(m => available.includes(m)));
      if (!analyst.period || !qs.includes(analyst.period)) analyst.period = qs[0];
    }
    if (analyst.periodType === 'year') analyst.period = '2026';

    let periodDropdown = '';
    if (analyst.periodType === 'month') {
      const opts = available.map(m => `<option value="${esc(m)}" ${m === analyst.period ? 'selected':''}>${esc(m)} 2026</option>`).join('');
      periodDropdown = `<div class="select-group"><select class="sel" id="selPeriod">${opts}</select></div>`;
    } else if (analyst.periodType === 'quarter') {
      const qs   = Object.keys(QUARTERS).filter(q => QUARTERS[q].some(m => available.includes(m)));
      const opts = qs.map(q => `<option value="${q}" ${q === analyst.period ? 'selected':''}>${q} 2026</option>`).join('');
      periodDropdown = `<div class="select-group"><select class="sel" id="selPeriod">${opts}</select></div>`;
    }

    periodHTML = `
      <div class="period-row">
        <div class="period-type-group">
          <button class="period-btn ${analyst.periodType==='month'   ? 'active':''}" data-type="month">Month</button>
          <button class="period-btn ${analyst.periodType==='quarter' ? 'active':''}" data-type="quarter">Quarter</button>
          <button class="period-btn ${analyst.periodType==='year'    ? 'active':''}" data-type="year">Year</button>
        </div>
        ${periodDropdown}
      </div>
      <div id="periodAnalysis"></div>`;
  }

  view.innerHTML = `
    <div class="role-layout">
      <div class="role-sidebar">${sidebarHTML()}</div>
      <div class="role-content">
        <section class="card">
          <h1>P&L reconciliation</h1>
          <p class="sub">Select a reporting period to verify whether the P&L revenue matches the sum of client project revenues.</p>
          <div class="drops">
            ${dropHTML('pl',   'P&L (financial actuals)', analyst.plRows)}
            ${dropHTML('proj', 'Projects by company',     analyst.projRows)}
          </div>
          ${periodHTML}
        </section>
      </div>
    </div>`;

  wireSidebar();

  wireAnalystDrop('pl',   'plRows');
  wireAnalystDrop('proj', 'projRows');

  view.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      analyst.periodType = btn.dataset.type;
      analyst.period     = null;
      renderAnalyst();
    });
  });

  document.getElementById('selPeriod')?.addEventListener('change', e => {
    analyst.period = e.target.value;
    document.getElementById('periodAnalysis').innerHTML = '<p class="hint">Running Claude discrepancy check…</p>';
    renderPeriodAnalysis();
  });

  if (hasData && analyst.period) renderPeriodAnalysis();
}

async function renderPeriodAnalysis() {
  const wrap = document.getElementById('periodAnalysis');
  if (!wrap) return;

  const selectedMonths = getSelectedMonths();
  if (!selectedMonths.length) { wrap.innerHTML = '<p class="hint">No data for this period.</p>'; return; }

  // Run Claude for uncached months
  const uncached = selectedMonths.filter(m => !analyst.analyzedMonths[m]);
  if (uncached.length) {
    wrap.innerHTML = '<p class="hint">Running Claude discrepancy check…</p>';
    const results = await Promise.all(uncached.map(m =>
      analyzeReconciliation(
        analyst.allRecords.find(r => r.month === m),
        analyst.projRows ? extractProjectLineItems(analyst.projRows, m) : [],
      )
    ));
    uncached.forEach((m, i) => { analyst.analyzedMonths[m] = results[i]; });
  }

  const recs = selectedMonths.map(m => ({
    ...analyst.allRecords.find(r => r.month === m),
    claude_analysis: analyst.analyzedMonths[m],
  }));

  const existing = await fetchRecs();
  updateProgress(existing);
  const byMonth  = Object.fromEntries(existing.map(r => [r.month, r]));
  const merged   = recs.map(r => ({
    ...r,
    id:          byMonth[r.month]?.id          ?? null,
    status:      byMonth[r.month]?.status      ?? 'new',
    denial_note: byMonth[r.month]?.denial_note ?? null,
  }));

  // Table rows
  const rows = merged.map(r => {
    const v   = r.projects_total - r.pl_revenue;
    const pct = r.pl_revenue ? (v / Math.abs(r.pl_revenue)) * 100 : 0;
    const mat = Math.abs(pct) >= THRESHOLD;
    const st  = STATUS[r.status];
    const badge = st
      ? `<span class="st ${st.cls}">${st.label}</span>`
      : `<span class="pill ${mat ? 'pill-bad':'pill-ok'}">${mat ? 'Discrepancy':'Ties out'}</span>`;
    return `
      <tr>
        <td>${esc(r.month)} 2026</td>
        <td class="num">${money(r.pl_revenue)}</td>
        <td class="num">${money(r.projects_total)}</td>
        <td class="num ${mat ? 'bad':''}">${v>=0?'+':''}${money(v)}</td>
        <td class="num"><span class="pct ${mat?'pill-bad':'pill-ok'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span></td>
        <td>${badge}</td>
      </tr>
      <tr class="analysis-row">
        <td colspan="6"><span class="ai-tag">Claude</span> ${esc(r.claude_analysis)}
          ${r.denial_note ? `<div class="deny-note">Denied: ${esc(r.denial_note)}</div>` : ''}
        </td>
      </tr>`;
  }).join('');

  // Summary row for multi-month periods
  let summaryHTML = '';
  if (merged.length > 1) {
    const tPL   = merged.reduce((s,r) => s + r.pl_revenue, 0);
    const tProj = merged.reduce((s,r) => s + r.projects_total, 0);
    const tV    = tProj - tPL;
    const tPct  = tPL ? (tV / Math.abs(tPL)) * 100 : 0;
    const tMat  = Math.abs(tPct) >= THRESHOLD;
    summaryHTML = `
      <tr class="total-row">
        <td><strong>Period Total</strong></td>
        <td class="num"><strong>${money(tPL)}</strong></td>
        <td class="num"><strong>${money(tProj)}</strong></td>
        <td class="num ${tMat?'bad':''}"><strong>${tV>=0?'+':''}${money(tV)}</strong></td>
        <td class="num"><strong><span class="pct ${tMat?'pill-bad':'pill-ok'}">${tPct>=0?'+':''}${tPct.toFixed(1)}%</span></strong></td>
        <td></td>
      </tr>`;
  }

  const canSubmit = merged.filter(r => ['new','pending_analyst','denied'].includes(r.status));
  const canReset  = merged.filter(r => r.status === 'approved');

  wrap.innerHTML = `
    <div class="tscroll" style="margin-top:1rem;">
      <table class="ledger">
        <thead><tr>
          <th>Month</th><th class="num">P&amp;L Revenue</th><th class="num">Projects Total</th>
          <th class="num">Variance</th><th class="num">%</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}${summaryHTML}</tbody>
      </table>
    </div>
    <div class="actions-row">
      ${canSubmit.length ? `<button class="btn btn-primary" id="btnSubmitPeriod">Submit ${canSubmit.length} month${canSubmit.length!==1?'s':''} to CFO</button>` : ''}
      ${canReset.length  ? `<button class="btn btn-deny" id="btnResetPeriod">Reset ${canReset.length} approval${canReset.length!==1?'s':''}</button>` : ''}
    </div>`;

  document.getElementById('btnSubmitPeriod')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnSubmitPeriod');
    btn.disabled = true;
    await Promise.all(canSubmit.map(r => upsertRec(r)));
    toast(`${canSubmit.length} month${canSubmit.length!==1?'s':''} submitted for CFO review.`);
    renderPeriodAnalysis();
  });

  document.getElementById('btnResetPeriod')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnResetPeriod');
    btn.disabled = true;
    await Promise.all(canReset.map(r =>
      updateStatus(r.id, { status:'pending_analyst', cfo_user_id:null, cfo_decided_at:null, denial_note:null })
    ));
    toast('Approvals reset.');
    renderPeriodAnalysis();
  });
}

function dropHTML(id, label, loaded) {
  return `
    <label class="drop ${loaded?'loaded':''}" id="drop-${id}">
      <input type="file" id="file-${id}" accept=".csv,.xlsx,.xls" hidden>
      <div class="drop-icon">${loaded?'✓':'📄'}</div>
      <strong>${label}</strong>
      <span>${loaded?'Loaded — click to replace':'Click or drop CSV / XLSX'}</span>
    </label>`;
}

function wireAnalystDrop(id, key) {
  const drop  = document.getElementById(`drop-${id}`);
  const input = document.getElementById(`file-${id}`);
  input.addEventListener('change', e => e.target.files[0] && loadAnalystFile(e.target.files[0], key));
  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', ()  => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag');
    if (e.dataTransfer.files[0]) loadAnalystFile(e.dataTransfer.files[0], key);
  });
}

async function loadAnalystFile(file, key) {
  try { analyst[key] = await fileToRows(file); }
  catch (err) { toast(`Could not read ${file.name}: ${err.message}`, 'err'); return; }
  analyst.allRecords = []; analyst.analyzedMonths = {};
  analyst.periodType = 'month'; analyst.period = null;
  renderAnalyst();
}

// ══════════════════════════════════════════════════════════════════
// CFO — Sign-off (pending queue only + download approved)
// ══════════════════════════════════════════════════════════════════

async function renderCFO() {
  const [allRecs, log] = await Promise.all([fetchRecs(), fetchAuditLog()]);
  updateProgress(allRecs);
  const pendingRecs    = allRecs.filter(r => r.status === 'pending_cfo');
  const approvedRecs   = sortByMonth(allRecs.filter(r => r.status === 'approved'));

  const logRows = auditLogRows(log);

  view.innerHTML = `
    <div class="role-layout">
      <div class="role-sidebar">${sidebarHTML()}</div>
      <div class="role-content">
        <section class="card">
          <h1>CFO sign-off</h1>
          <p class="sub">Review pending reconciliations. Deny individual months or approve all at once.</p>
          ${pendingRecs.length ? cfoTable(pendingRecs) : '<p class="hint">No months pending review.</p>'}
          <div class="actions-row" style="gap:0.75rem;">
            ${pendingRecs.length ? `
              <button class="btn btn-primary" id="btnApproveAll">
                Approve all (${pendingRecs.length} month${pendingRecs.length!==1?'s':''})
              </button>` : ''}
            ${approvedRecs.length ? `
              <button class="btn" id="btnDownload">
                Download approved (${approvedRecs.length} month${approvedRecs.length!==1?'s':''})
              </button>` : ''}
          </div>
        </section>
        <section class="card audit-card">
          <div class="audit-hdr-row">
            <h2 class="audit-hdr">Audit trail</h2>
            <button class="btn btn-sm" id="btnDownloadAudit">Download CSV</button>
          </div>
          <div class="tscroll">
            <table class="ledger">
              <thead><tr><th>Time</th><th>Action</th><th>Month</th><th>By</th><th>Notes</th></tr></thead>
              <tbody>${logRows}</tbody>
            </table>
          </div>
        </section>
      </div>
    </div>`;

  wireSidebar();
  wireCFOActions(pendingRecs, approvedRecs, log);
}

function wireCFOActions(pendingRecs, approvedRecs, log = []) {
  view.querySelectorAll('button[data-act="deny"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const note = prompt('Reason for denial:');
      if (note === null) return;
      btn.disabled = true;
      const ok = await updateStatus(btn.dataset.id, {
        status:'denied', cfo_user_id: currentUser?.id ?? null,
        cfo_decided_at: new Date().toISOString(), denial_note: note,
      });
      if (ok) {
        await insertAuditLog('Denied', btn.dataset.month, parseInt(btn.dataset.year), note || null);
        toast('Denied.', 'err'); renderCFO();
      } else btn.disabled = false;
    });
  });

  document.getElementById('btnApproveAll')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnApproveAll');
    btn.disabled = true; btn.textContent = 'Approving…';
    await Promise.all(pendingRecs.map(r => Promise.all([
      updateStatus(r.id, {
        status:'approved', cfo_user_id: currentUser?.id ?? null,
        cfo_decided_at: new Date().toISOString(),
      }),
      insertAuditLog('Approved', r.month, r.year),
    ])));
    toast(`${pendingRecs.length} month${pendingRecs.length!==1?'s':''} approved.`);
    renderCFO();
  });

  document.getElementById('btnDownload')?.addEventListener('click', () => {
    downloadCSV(approvedRecs, `reconciliation-approved-${new Date().toISOString().slice(0,10)}.csv`);
  });

  document.getElementById('btnDownloadAudit')?.addEventListener('click', () => {
    const headers = ['Event ID','Timestamp (UTC)','Timestamp (Local)','Action','Month','Year','Performed By','Notes'];
    const rows = log.map(e => {
      const d = new Date(e.created_at);
      return [
        e.id || '',
        d.toISOString(),
        d.toLocaleString('en-US', { timeZoneName: 'short' }),
        e.action,
        e.month || '', e.year || '',
        e.user_email || '',
        e.details || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  });
}

function cfoTable(recs) {
  const rows = recs.map(r => {
    const v   = r.projects_total - r.pl_revenue;
    const pct = r.pl_revenue ? (v / Math.abs(r.pl_revenue)) * 100 : 0;
    const mat = Math.abs(pct) >= THRESHOLD;
    const st  = STATUS[r.status];
    const badge  = st ? `<span class="st ${st.cls}">${st.label}</span>` : '—';
    const action = r.status === 'pending_cfo'
      ? `<button class="btn btn-sm btn-deny" data-act="deny" data-id="${r.id}" data-month="${esc(r.month)}" data-year="${r.year||2026}">Deny</button>`
      : '<span class="muted">—</span>';
    return `
      <tr>
        <td>${esc(r.month)} ${r.year||2026}</td>
        <td class="num">${money(r.pl_revenue)}</td>
        <td class="num">${money(r.projects_total)}</td>
        <td class="num ${mat?'bad':''}">${v>=0?'+':''}${money(v)}</td>
        <td class="num"><span class="pct ${mat?'pill-bad':'pill-ok'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span></td>
        <td>${badge}</td>
        <td class="act">${action}</td>
      </tr>
      <tr class="analysis-row">
        <td colspan="7"><span class="ai-tag">Claude</span> ${esc(r.claude_analysis)||'—'}
          ${r.denial_note?`<div class="deny-note">Denied: ${esc(r.denial_note)}</div>`:''}
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="tscroll">
      <table class="ledger">
        <thead><tr>
          <th>Month</th><th class="num">P&amp;L Revenue</th><th class="num">Projects Total</th>
          <th class="num">Variance</th><th class="num">%</th><th>Status</th><th>Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

init();
