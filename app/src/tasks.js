import { supabase } from './supabase.js';

const MONTH_ORDER = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const TASK_STATUS = {
  not_started: { label: 'Not Started', cls: 'st-gray' },
  in_progress:  { label: 'In Progress', cls: 'st-blue' },
  complete:     { label: 'Complete',    cls: 'st-green' },
  blocked:      { label: 'Blocked',     cls: 'st-red' },
};

const PRIORITY_CLS = { high: 'pri-high', medium: 'pri-med', low: 'pri-low' };

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money = () => {};

// ── Public: render Tasks tab ────────────────────────────────────
export async function renderTasksView(container, toast, currentUser) {
  const tasks = await fetchTasks();
  const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));

  container.innerHTML = `
    <section class="card">
      <div class="task-header-row">
        <div>
          <h1>Close Tasks</h1>
          <p class="sub">Track, assign, and monitor all month-end close activities.</p>
        </div>
        <button class="btn btn-primary" id="btnNewTask">+ New Task</button>
      </div>
      <div class="task-filters">
        <select class="sel sel-sm" id="filterStatus">
          <option value="">All Statuses</option>
          <option value="not_started">Not Started</option>
          <option value="in_progress">In Progress</option>
          <option value="complete">Complete</option>
          <option value="blocked">Blocked</option>
        </select>
        <select class="sel sel-sm" id="filterPriority">
          <option value="">All Priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div id="taskList" style="margin-top:1rem;"></div>
    </section>
    <section class="card">
      <h2 style="font-size:1rem;margin-bottom:0.75rem;">Close Calendar</h2>
      <div id="calendarView"></div>
    </section>
    ${taskModalHTML()}`;

  renderTaskList(tasks, taskMap, container);
  renderCalendar(tasks, container);
  wireTaskModal(container, toast, currentUser, tasks, taskMap);
  wireFilters(container, tasks, taskMap);
}

// ── Fetch ────────────────────────────────────────────────────────
async function fetchTasks() {
  const { data, error } = await supabase
    .from('close_tasks').select('*').order('due_date', { ascending: true, nullsFirst: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

// ── Task list rendering ─────────────────────────────────────────
function renderTaskList(tasks, taskMap, container, filterStatus = '', filterPriority = '') {
  const wrap = container.querySelector('#taskList');
  if (!wrap) return;

  let filtered = tasks;
  if (filterStatus)   filtered = filtered.filter(t => t.status   === filterStatus);
  if (filterPriority) filtered = filtered.filter(t => t.priority === filterPriority);

  if (!filtered.length) {
    wrap.innerHTML = '<p class="hint">No tasks found.</p>';
    return;
  }

  // Sort: top-level first, then children grouped under parents
  const topLevel  = filtered.filter(t => !t.parent_task_id);
  const children  = filtered.filter(t =>  t.parent_task_id);

  let html = '<div class="task-table-wrap"><table class="ledger task-ledger"><thead><tr>';
  html += '<th>Task</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th><th>Action</th>';
  html += '</tr></thead><tbody>';

  for (const task of topLevel) {
    html += taskRow(task, 0);
    const kids = children.filter(c => c.parent_task_id === task.id);
    for (const kid of kids) html += taskRow(kid, 1, taskMap);
  }
  // orphaned children whose parent was filtered out
  const renderedParents = new Set(topLevel.map(t => t.id));
  for (const kid of children) {
    if (!renderedParents.has(kid.parent_task_id)) html += taskRow(kid, 1, taskMap);
  }

  html += '</tbody></table></div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.status-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      const id = e.target.dataset.id;
      const { error } = await supabase.from('close_tasks')
        .update({ status: e.target.value, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) console.error(error);
    });
  });

  wrap.querySelectorAll('.btn-del-task').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      await supabase.from('close_tasks').delete().eq('id', btn.dataset.id);
      const updated = await fetchTasks();
      const updatedMap = Object.fromEntries(updated.map(t => [t.id, t]));
      renderTaskList(updated, updatedMap, container, filterStatus, filterPriority);
      renderCalendar(updated, container);
    });
  });
}

function taskRow(task, depth = 0, taskMap = {}) {
  const st  = TASK_STATUS[task.status] || TASK_STATUS.not_started;
  const due = task.due_date ? new Date(task.due_date + 'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—';
  const overdue = task.due_date && task.status !== 'complete' && new Date(task.due_date) < new Date();
  const indent = depth > 0 ? 'style="padding-left:2rem;"' : '';
  const arrow  = depth > 0 ? '<span class="dep-arrow">↳</span>' : '';

  let blockedNote = '';
  if (task.status === 'blocked' && task.parent_task_id && taskMap[task.parent_task_id]) {
    const parent = taskMap[task.parent_task_id];
    blockedNote = `<div class="blocked-note">Blocked by: ${esc(parent.title)} — Owner: ${esc(parent.owner_email || '—')}</div>`;
  } else if (task.status === 'blocked' && task.blocked_reason) {
    blockedNote = `<div class="blocked-note">Reason: ${esc(task.blocked_reason)}</div>`;
  }

  const statusOpts = Object.entries(TASK_STATUS).map(([v, {label}]) =>
    `<option value="${v}" ${task.status === v ? 'selected' : ''}>${label}</option>`
  ).join('');

  return `
    <tr class="${overdue ? 'row-overdue' : ''}">
      <td ${indent}>${arrow}${esc(task.title)}
        ${blockedNote}
        ${task.description ? `<div class="task-desc">${esc(task.description)}</div>` : ''}
      </td>
      <td class="muted">${esc(task.owner_email || '—')}</td>
      <td class="${overdue ? 'bad' : 'muted'}">${due}${overdue ? ' ⚠' : ''}</td>
      <td><span class="pri-badge ${PRIORITY_CLS[task.priority] || 'pri-med'}">${task.priority || 'medium'}</span></td>
      <td>
        <select class="sel sel-xs status-sel" data-id="${task.id}">
          ${statusOpts}
        </select>
      </td>
      <td class="act">
        <button class="btn btn-sm btn-deny btn-del-task" data-id="${task.id}">✕</button>
      </td>
    </tr>`;
}

// ── Calendar ────────────────────────────────────────────────────
function renderCalendar(tasks, container) {
  const wrap = container.querySelector('#calendarView');
  if (!wrap) return;

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth();
  const monthName = MONTH_ORDER[month];
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lastDay = new Date(year, month, daysInMonth);

  // days-to-close = working days until last day of month
  let workingDays = 0;
  const today = new Date(); today.setHours(0,0,0,0);
  for (let d = new Date(today); d <= lastDay; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) workingDays++;
  }

  // tasks this month keyed by day
  const byDay = {};
  for (const t of tasks) {
    if (!t.due_date) continue;
    const td = new Date(t.due_date + 'T00:00:00');
    if (td.getFullYear() === year && td.getMonth() === month) {
      const d = td.getDate();
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(t);
    }
  }

  const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  let html = `
    <div class="cal-meta">
      <span class="cal-month">${monthName} ${year}</span>
      <span class="days-to-close">${workingDays} working day${workingDays !== 1 ? 's' : ''} to close</span>
    </div>
    <table class="cal-grid">
      <thead><tr>${dayNames.map(d => `<th>${d}</th>`).join('')}</tr></thead>
      <tbody><tr>`;

  let col = 0;
  for (let i = 0; i < firstDay; i++) { html += '<td></td>'; col++; }

  for (let d = 1; d <= daysInMonth; d++) {
    const chips = (byDay[d] || []).map(t =>
      `<div class="cal-chip ${PRIORITY_CLS[t.priority] || 'pri-med'}" title="${esc(t.title)}">${esc(t.title.slice(0,14))}${t.title.length > 14 ? '…' : ''}</div>`
    ).join('');
    const isToday = d === now.getDate();
    html += `<td class="${isToday ? 'cal-today' : ''}">${isToday ? `<span class="cal-day-num today-num">${d}</span>` : `<span class="cal-day-num">${d}</span>`}${chips}</td>`;
    col++;
    if (col % 7 === 0 && d < daysInMonth) html += '</tr><tr>';
  }

  while (col % 7 !== 0) { html += '<td></td>'; col++; }
  html += '</tr></tbody></table>';
  wrap.innerHTML = html;
}

// ── Modal ────────────────────────────────────────────────────────
function taskModalHTML() {
  return `
    <div class="modal-backdrop hidden" id="taskModalBackdrop">
      <div class="modal-box">
        <div class="modal-hdr">
          <span>New Task</span>
          <button class="modal-close" id="taskModalClose">✕</button>
        </div>
        <form id="taskForm" class="modal-form">
          <div class="field-group">
            <label class="field-lbl">Title *</label>
            <input class="field-input" id="tTitle" required placeholder="e.g. Reconcile cash accounts">
          </div>
          <div class="field-group">
            <label class="field-lbl">Description</label>
            <input class="field-input" id="tDesc" placeholder="Optional detail">
          </div>
          <div class="field-row">
            <div class="field-group">
              <label class="field-lbl">Owner Email</label>
              <input class="field-input" id="tOwner" type="email" placeholder="analyst@thepioneerteam.com">
            </div>
            <div class="field-group">
              <label class="field-lbl">Due Date</label>
              <input class="field-input" id="tDue" type="date">
            </div>
          </div>
          <div class="field-row">
            <div class="field-group">
              <label class="field-lbl">Priority</label>
              <select class="sel" id="tPriority">
                <option value="high">High</option>
                <option value="medium" selected>Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div class="field-group">
              <label class="field-lbl">Status</label>
              <select class="sel" id="tStatus">
                <option value="not_started" selected>Not Started</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
          </div>
          <div class="field-row">
            <div class="field-group">
              <label class="field-lbl">Period Month</label>
              <select class="sel" id="tMonth">
                <option value="">— None —</option>
                ${MONTH_ORDER.map(m => `<option value="${m}">${m}</option>`).join('')}
              </select>
            </div>
            <div class="field-group">
              <label class="field-lbl">Blocked Reason</label>
              <input class="field-input" id="tBlocked" placeholder="If blocked, explain why">
            </div>
          </div>
          <p class="form-err hidden" id="taskFormErr"></p>
          <div class="modal-actions">
            <button type="button" class="btn" id="taskModalCancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Task</button>
          </div>
        </form>
      </div>
    </div>`;
}

function wireTaskModal(container, toast, currentUser, tasks, taskMap) {
  const backdrop = container.querySelector('#taskModalBackdrop');
  const form     = container.querySelector('#taskForm');
  const errEl    = container.querySelector('#taskFormErr');

  const open  = () => backdrop.classList.remove('hidden');
  const close = () => { backdrop.classList.add('hidden'); form.reset(); errEl.classList.add('hidden'); };

  container.querySelector('#btnNewTask').addEventListener('click', open);
  container.querySelector('#taskModalClose').addEventListener('click', close);
  container.querySelector('#taskModalCancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const title = container.querySelector('#tTitle').value.trim();
    if (!title) return;

    const due = container.querySelector('#tDue').value || null;
    const { error } = await supabase.from('close_tasks').insert({
      title,
      description:    container.querySelector('#tDesc').value.trim() || null,
      owner_email:    container.querySelector('#tOwner').value.trim() || null,
      due_date:       due,
      priority:       container.querySelector('#tPriority').value,
      status:         container.querySelector('#tStatus').value,
      period_month:   container.querySelector('#tMonth').value || null,
      period_year:    2026,
      blocked_reason: container.querySelector('#tBlocked').value.trim() || null,
      created_at:     new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    });

    if (error) {
      errEl.textContent = error.message;
      errEl.classList.remove('hidden');
      return;
    }

    close();
    toast('Task created.');
    const updated = await fetchTasks();
    const updatedMap = Object.fromEntries(updated.map(t => [t.id, t]));
    renderTaskList(updated, updatedMap, container);
    renderCalendar(updated, container);
  });
}

function wireFilters(container, tasks, taskMap) {
  const onFilter = async () => {
    const status   = container.querySelector('#filterStatus').value;
    const priority = container.querySelector('#filterPriority').value;
    const all = await fetchTasks();
    const allMap = Object.fromEntries(all.map(t => [t.id, t]));
    renderTaskList(all, allMap, container, status, priority);
  };
  container.querySelector('#filterStatus')?.addEventListener('change', onFilter);
  container.querySelector('#filterPriority')?.addEventListener('change', onFilter);
}

// ── Downstream task creation (called from main.js on approval) ──
export async function triggerDownstreamTasks(month, year, ownerEmail) {
  const dueDate = addBusinessDays(new Date(), 5).toISOString().slice(0, 10);
  const tasks = [
    { title: `Prepare financial statements for ${month}`,           priority: 'high',   status: 'not_started' },
    { title: `Review and sign off GL accounts for ${month}`,        priority: 'high',   status: 'not_started' },
    { title: `Distribute close report to stakeholders for ${month}`, priority: 'medium', status: 'not_started' },
  ];
  const rows = tasks.map(t => ({
    ...t, owner_email: ownerEmail, due_date: dueDate,
    period_month: month, period_year: year || 2026,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('close_tasks').insert(rows);
  if (error) console.error('Downstream tasks error:', error);
}

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}
