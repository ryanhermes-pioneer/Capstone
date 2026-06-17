import { supabase } from './supabase.js';
import { fileToRows } from './reconcile.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: import.meta.env.VITE_CLAUDE_API_KEY,
  dangerouslyAllowBrowser: true,
});

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const num = v => parseFloat(String(v).replace(/[$,\s]/g,'')) || 0;

// ── Templates ────────────────────────────────────────────────────
const TEMPLATES = {
  cash: {
    label: 'Cash',
    items: [
      'Book balance per GL',
      'Outstanding checks',
      'Deposits in transit',
      'Bank service charges',
      'NSF / returned items',
      'Adjusted bank balance',
    ],
  },
  prepaids: {
    label: 'Prepaids',
    items: [
      'Beginning prepaid balance',
      'Additions (new payments)',
      'Amortization for period',
      'Ending prepaid balance',
    ],
  },
  accruals: {
    label: 'Accrued Liabilities',
    items: [
      'Beginning accrual balance',
      'Accruals added this period',
      'Payments / reversals',
      'Ending accrual balance',
    ],
  },
  intercompany: {
    label: 'Intercompany',
    items: [
      'Receivable per entity A',
      'Payable per entity B',
      'Eliminating entry',
      'Net intercompany balance',
    ],
  },
  fixed_assets: {
    label: 'Fixed Assets',
    items: [
      'Beginning gross balance',
      'Additions',
      'Disposals',
      'Ending gross balance',
      'Accumulated depreciation — beginning',
      'Depreciation expense',
      'Accumulated depreciation — ending',
      'Net book value',
    ],
  },
};

// ── State ────────────────────────────────────────────────────────
let glRows = null;
let schedRows = null;
let currentPeriod = { month: null, year: 2026 };

// ── Public: render Account Rec tab ───────────────────────────────
export async function renderRecView(container, toast, currentRole, currentUser) {
  const recs = await fetchRecs();
  currentPeriod.month = currentPeriod.month || 'January';

  container.innerHTML = `
    <section class="card">
      <div class="task-header-row">
        <div>
          <h1>Account Reconciliation</h1>
          <p class="sub">Upload GL and supporting schedule to perform tie-out and account-level sign-off.</p>
        </div>
        <button class="btn btn-primary" id="btnNewRecFromTemplate">+ New Rec from Template</button>
      </div>

      <div class="rec-uploads">
        <label class="drop ${glRows ? 'loaded' : ''}" id="dropGL">
          <input type="file" id="fileGL" accept=".csv,.xlsx,.xls" hidden>
          <div class="drop-icon">${glRows ? '✓' : '📄'}</div>
          <strong>GL Extract</strong>
          <span>${glRows ? 'Loaded — click to replace' : 'Click or drop CSV / XLSX'}</span>
        </label>
        <label class="drop ${schedRows ? 'loaded' : ''}" id="dropSched">
          <input type="file" id="fileSched" accept=".csv,.xlsx,.xls" hidden>
          <div class="drop-icon">${schedRows ? '✓' : '📄'}</div>
          <strong>Supporting Schedule</strong>
          <span>${schedRows ? 'Loaded — click to replace' : 'Click or drop CSV / XLSX'}</span>
        </label>
        <div style="display:flex;align-items:flex-end;">
          <button class="btn btn-primary" id="btnRunTieOut" ${(!glRows || !schedRows) ? 'disabled' : ''}>Run Tie-Out</button>
        </div>
      </div>

      <div id="tieOutPreview"></div>
    </section>

    <section class="card">
      <h2 style="font-size:1rem;margin-bottom:0.75rem;">Account Reconciliations</h2>
      <div id="recList"></div>
    </section>

    ${templateModalHTML()}
    ${recDetailModalHTML()}`;

  renderRecList(recs, container, toast, currentRole, currentUser);
  wireRecUploads(container, toast, currentRole, currentUser);
  wireTemplateModal(container, toast, currentRole, currentUser);
}

// ── Fetch ────────────────────────────────────────────────────────
async function fetchRecs() {
  const { data } = await supabase.from('account_recs').select('*').order('created_at', { ascending: false });
  return data || [];
}

async function fetchLineItems(recId) {
  const { data } = await supabase.from('rec_line_items').select('*').eq('rec_id', recId);
  return data || [];
}

// ── Rec list ─────────────────────────────────────────────────────
function renderRecList(recs, container, toast, currentRole, currentUser) {
  const wrap = container.querySelector('#recList');
  if (!wrap) return;
  if (!recs.length) { wrap.innerHTML = '<p class="hint">No reconciliations yet. Upload files or use a template to get started.</p>'; return; }

  const STATUS_MAP = {
    draft:          { label: 'Draft',          cls: 'st-gray' },
    pending_review: { label: 'Pending Review', cls: 'st-amber' },
    signed_off:     { label: 'Signed Off',     cls: 'st-green' },
    locked:         { label: 'Locked',         cls: 'st-blue' },
  };

  const rows = recs.map(r => {
    const variance = (r.gl_balance ?? 0) - (r.schedule_balance ?? 0);
    const st = STATUS_MAP[r.status] || STATUS_MAP.draft;
    const canSign   = r.status === 'draft'          && currentRole === 'analyst';
    const canApprove = r.status === 'pending_review' && (currentRole === 'director' || currentRole === 'cfo');
    return `
      <tr>
        <td>${esc(r.account_name)}</td>
        <td class="muted">${esc(r.template_type || r.account_type || '—')}</td>
        <td class="num">${r.gl_balance != null ? money(r.gl_balance) : '—'}</td>
        <td class="num">${r.schedule_balance != null ? money(r.schedule_balance) : '—'}</td>
        <td class="num ${Math.abs(variance) > 0 ? 'bad' : ''}">${r.gl_balance != null ? money(variance) : '—'}</td>
        <td><span class="st ${st.cls}">${st.label}</span>
          ${r.status === 'pending_review' && r.preparer_signed_at ? `<div class="muted" style="font-size:0.72rem;margin-top:0.2rem;">Signed ${new Date(r.preparer_signed_at).toLocaleDateString()}</div>` : ''}
        </td>
        <td class="act">
          <button class="btn btn-sm btn-view-rec" data-id="${r.id}">View</button>
          ${canSign    ? `<button class="btn btn-sm btn-primary btn-sign-rec" data-id="${r.id}">Sign Off</button>` : ''}
          ${canApprove ? `<button class="btn btn-sm btn-primary btn-approve-rec" data-id="${r.id}">Approve</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="tscroll">
      <table class="ledger">
        <thead><tr>
          <th>Account</th><th>Type</th><th class="num">GL Balance</th>
          <th class="num">Schedule</th><th class="num">Variance</th><th>Status</th><th>Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  wrap.querySelectorAll('.btn-view-rec').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rec = recs.find(r => r.id === btn.dataset.id);
      const items = await fetchLineItems(rec.id);
      openRecDetail(container, rec, items, toast, currentRole, currentUser, recs);
    });
  });

  wrap.querySelectorAll('.btn-sign-rec').forEach(btn => {
    btn.addEventListener('click', async () => {
      await supabase.from('account_recs').update({
        status: 'pending_review',
        preparer_id: currentUser?.id ?? null,
        preparer_signed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', btn.dataset.id);
      toast('Signed off — awaiting review.');
      const updated = await fetchRecs();
      renderRecList(updated, container, toast, currentRole, currentUser);
    });
  });

  wrap.querySelectorAll('.btn-approve-rec').forEach(btn => {
    btn.addEventListener('click', async () => {
      await supabase.from('account_recs').update({
        status: 'signed_off',
        reviewer_id: currentUser?.id ?? null,
        reviewer_signed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', btn.dataset.id);
      toast('Account reconciliation approved and locked.');
      const updated = await fetchRecs();
      renderRecList(updated, container, toast, currentRole, currentUser);
    });
  });
}

// ── Rec detail modal ─────────────────────────────────────────────
function recDetailModalHTML() {
  return `
    <div class="modal-backdrop hidden" id="recDetailBackdrop">
      <div class="modal-box modal-wide">
        <div class="modal-hdr">
          <span id="recDetailTitle">Account Detail</span>
          <button class="modal-close" id="recDetailClose">✕</button>
        </div>
        <div id="recDetailBody" style="padding:1.25rem;"></div>
      </div>
    </div>`;
}

function openRecDetail(container, rec, items, toast, currentRole, currentUser, allRecs) {
  const backdrop = container.querySelector('#recDetailBackdrop');
  const body     = container.querySelector('#recDetailBody');
  const title    = container.querySelector('#recDetailTitle');
  if (!backdrop || !body) return;

  title.textContent = rec.account_name;

  const variance = (rec.gl_balance ?? 0) - (rec.schedule_balance ?? 0);
  const isLocked = rec.status === 'signed_off' || rec.status === 'locked';

  const itemRows = items.map(item => `
    <tr>
      <td>${esc(item.description || '—')}</td>
      <td class="num">${item.gl_amount != null ? money(item.gl_amount) : '—'}</td>
      <td class="num">${item.schedule_amount != null ? money(item.schedule_amount) : '—'}</td>
      <td><span class="st ${item.match_status === 'matched' ? 'st-green' : item.match_status === 'suggested' ? 'st-amber' : 'st-gray'}">${item.match_status || 'unmatched'}</span></td>
      <td class="muted" style="font-size:0.8rem;">${esc(item.preparer_override || item.ai_explanation || '')}</td>
      ${!isLocked ? `<td class="act"><button class="btn btn-sm btn-toggle-match" data-id="${item.id}" data-status="${item.match_status}">Toggle match</button></td>` : '<td></td>'}
    </tr>`).join('');

  body.innerHTML = `
    <div class="rec-detail-meta">
      <div><span class="field-lbl">GL Balance</span><div class="stat-val">${rec.gl_balance != null ? money(rec.gl_balance) : '—'}</div></div>
      <div><span class="field-lbl">Schedule Balance</span><div class="stat-val">${rec.schedule_balance != null ? money(rec.schedule_balance) : '—'}</div></div>
      <div><span class="field-lbl">Variance</span><div class="stat-val ${Math.abs(variance) > 0 ? 'bad' : 'st-green'}">${rec.gl_balance != null ? money(variance) : '—'}</div></div>
    </div>
    ${rec.ai_commentary ? `<div class="ai-commentary-block"><span class="ai-tag">Claude</span> ${esc(rec.ai_commentary)}</div>` : `<button class="btn" id="btnGenAI" data-id="${rec.id}">Generate AI Commentary</button>`}
    <div class="tscroll" style="margin-top:1rem;">
      <table class="ledger">
        <thead><tr><th>Description</th><th class="num">GL Amount</th><th class="num">Schedule Amount</th><th>Match</th><th>Explanation</th><th></th></tr></thead>
        <tbody id="recItemsBody">${itemRows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:1rem;">No line items.</td></tr>'}</tbody>
      </table>
    </div>`;

  backdrop.classList.remove('hidden');
  backdrop.querySelector('#recDetailClose').addEventListener('click', () => backdrop.classList.add('hidden'));
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.classList.add('hidden'); });

  backdrop.querySelectorAll('.btn-toggle-match').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.status === 'matched' ? 'unmatched' : 'matched';
      await supabase.from('rec_line_items').update({ match_status: next }).eq('id', btn.dataset.id);
      const updated = await fetchLineItems(rec.id);
      const updatedRec = (await supabase.from('account_recs').select('*').eq('id', rec.id).single()).data;
      openRecDetail(container, updatedRec, updated, toast, currentRole, currentUser, allRecs);
    });
  });

  const btnAI = backdrop.querySelector('#btnGenAI');
  if (btnAI) {
    btnAI.addEventListener('click', async () => {
      btnAI.disabled = true; btnAI.textContent = 'Analyzing…';
      const commentary = await analyzeRecVariance(rec, items);
      await supabase.from('account_recs').update({ ai_commentary: commentary, updated_at: new Date().toISOString() }).eq('id', rec.id);
      const updatedRec = (await supabase.from('account_recs').select('*').eq('id', rec.id).single()).data;
      const updatedItems = await fetchLineItems(rec.id);
      openRecDetail(container, updatedRec, updatedItems, toast, currentRole, currentUser, allRecs);
    });
  }
}

// ── AI variance commentary ────────────────────────────────────────
async function analyzeRecVariance(rec, items) {
  try {
    const itemSummary = items.slice(0, 10).map(i =>
      `${i.description}: GL ${i.gl_amount ?? 'N/A'}, Schedule ${i.schedule_amount ?? 'N/A'} (${i.match_status})`
    ).join('\n');
    const variance = (rec.gl_balance ?? 0) - (rec.schedule_balance ?? 0);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a CPA reviewing an account reconciliation for a management consulting firm. Write exactly 2 sentences.

Account: ${rec.account_name}
GL balance: ${money(rec.gl_balance ?? 0)}
Schedule balance: ${money(rec.schedule_balance ?? 0)}
Variance: ${money(variance)}
Line items:\n${itemSummary || 'None provided.'}

Sentence 1: Most likely explanation for the variance.
Sentence 2: Specific action to resolve it before sign-off.

Output only the 2 sentences, no labels.`,
      }],
    });
    return response.content.find(b => b.type === 'text')?.text?.trim() || 'Unable to generate commentary.';
  } catch (err) {
    console.error('AI rec analysis error:', err);
    return 'AI commentary unavailable — review variance manually before sign-off.';
  }
}

// ── GL upload & tie-out ──────────────────────────────────────────
function wireRecUploads(container, toast, currentRole, currentUser) {
  const wireFile = (inputId, key) => {
    const input = container.querySelector(`#${inputId}`);
    const drop  = container.querySelector(`#drop${key === 'glRows' ? 'GL' : 'Sched'}`);
    if (!input || !drop) return;
    const load = async file => {
      try {
        if (key === 'glRows') glRows = await fileToRows(file);
        else schedRows = await fileToRows(file);
        drop.classList.add('loaded');
        drop.querySelector('.drop-icon').textContent = '✓';
        drop.querySelector('span').textContent = 'Loaded — click to replace';
        const btn = container.querySelector('#btnRunTieOut');
        if (btn && glRows && schedRows) btn.disabled = false;
      } catch (err) { toast(`Could not read ${file.name}: ${err.message}`, 'err'); }
    };
    input.addEventListener('change', e => e.target.files[0] && load(e.target.files[0]));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
  };

  wireFile('fileGL', 'glRows');
  wireFile('fileSched', 'schedRows');

  container.querySelector('#btnRunTieOut')?.addEventListener('click', async () => {
    const btn = container.querySelector('#btnRunTieOut');
    btn.disabled = true; btn.textContent = 'Analyzing…';
    await runTieOut(container, toast, currentRole, currentUser);
    btn.disabled = false; btn.textContent = 'Run Tie-Out';
  });
}

async function runTieOut(container, toast, currentRole, currentUser) {
  const preview = container.querySelector('#tieOutPreview');
  if (!preview || !glRows || !schedRows) return;

  preview.innerHTML = '<p class="hint">Auto-mapping columns…</p>';
  const [glMap, schedMap] = await Promise.all([autoMapGL(glRows), autoMapGL(schedRows)]);

  // Build account → balance maps
  const glBalances    = extractBalances(glRows, glMap);
  const schedBalances = extractBalances(schedRows, schedMap);

  const allAccounts = [...new Set([...Object.keys(glBalances), ...Object.keys(schedBalances)])];
  const results = allAccounts.map(acct => {
    const gl   = glBalances[acct]   ?? null;
    const sched = schedBalances[acct] ?? null;
    const variance = gl != null && sched != null ? gl - sched : null;
    const absPct = gl && variance != null ? Math.abs(variance / Math.abs(gl)) * 100 : 0;
    const matchStatus = variance === 0 ? 'matched' : absPct <= 5 ? 'suggested' : 'unmatched';
    return { account_name: acct, gl_balance: gl, schedule_balance: sched, variance, matchStatus };
  });

  // Show preview
  const rows = results.map(r => `
    <tr>
      <td>${esc(r.account_name)}</td>
      <td class="num">${r.gl_balance != null ? money(r.gl_balance) : '—'}</td>
      <td class="num">${r.schedule_balance != null ? money(r.schedule_balance) : '—'}</td>
      <td class="num ${r.variance && Math.abs(r.variance) > 0 ? 'bad' : ''}">${r.variance != null ? money(r.variance) : '—'}</td>
      <td><span class="st ${r.matchStatus === 'matched' ? 'st-green' : r.matchStatus === 'suggested' ? 'st-amber' : 'st-gray'}">${r.matchStatus}</span></td>
    </tr>`).join('');

  preview.innerHTML = `
    <h2 style="font-size:0.95rem;margin:1.2rem 0 0.6rem;">Tie-Out Preview</h2>
    <div class="tscroll">
      <table class="ledger">
        <thead><tr><th>Account</th><th class="num">GL Balance</th><th class="num">Schedule</th><th class="num">Variance</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="actions-row" style="gap:0.75rem;">
      <button class="btn btn-primary" id="btnSaveTieOut">Save to Reconciliations</button>
    </div>`;

  preview.querySelector('#btnSaveTieOut').addEventListener('click', async () => {
    const btn = preview.querySelector('#btnSaveTieOut');
    btn.disabled = true; btn.textContent = 'Saving…';

    for (const r of results) {
      const { data: rec, error } = await supabase.from('account_recs').insert({
        account_name: r.account_name,
        gl_balance: r.gl_balance,
        schedule_balance: r.schedule_balance,
        status: 'draft',
        preparer_id: currentUser?.id ?? null,
        period_month: 'Manual',
        period_year: 2026,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select().single();
      if (!error && rec && r.matchStatus !== 'matched') {
        await supabase.from('rec_line_items').insert({
          rec_id: rec.id,
          description: 'Reconciling item',
          gl_amount: r.gl_balance,
          schedule_amount: r.schedule_balance,
          match_status: r.matchStatus,
          created_at: new Date().toISOString(),
        });
      }
    }
    toast('Tie-out saved. Run AI commentary per account in the list below.');
    glRows = null; schedRows = null;
    const updated = await fetchRecs();
    renderRecList(updated, container, toast, currentRole, currentUser);
    preview.innerHTML = '';
  });
}

async function autoMapGL(rows) {
  if (!rows || rows.length < 2) return { accountCol: 0, nameCol: 1, balanceCol: 2 };
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Identify 0-based column indices in this GL or schedule extract. Return JSON only, no markdown.

Headers: ${JSON.stringify(rows[0])}
Sample: ${JSON.stringify(rows.slice(1, 4))}

Return: {"accountCol":<number>,"balanceCol":<number>}
- accountCol: column with account names or descriptions (text)
- balanceCol: column with dollar balances (numeric)`,
      }],
    });
    const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '';
    const parsed = JSON.parse(raw.replace(/```(?:json)?/gi,'').trim());
    if (typeof parsed.accountCol === 'number' && typeof parsed.balanceCol === 'number') return parsed;
  } catch {}
  return { accountCol: 0, balanceCol: rows[0].length - 1 };
}

function extractBalances(rows, { accountCol = 0, balanceCol = 1 }) {
  const out = {};
  for (const r of rows.slice(1)) {
    const acct = String(r[accountCol] ?? '').trim();
    if (!acct) continue;
    out[acct] = num(r[balanceCol]);
  }
  return out;
}

// ── Template modal ───────────────────────────────────────────────
function templateModalHTML() {
  return `
    <div class="modal-backdrop hidden" id="templateModalBackdrop">
      <div class="modal-box">
        <div class="modal-hdr">
          <span>New Rec from Template</span>
          <button class="modal-close" id="templateModalClose">✕</button>
        </div>
        <form id="templateForm" class="modal-form">
          <div class="field-group">
            <label class="field-lbl">Template Type</label>
            <select class="sel" id="tplType">
              ${Object.entries(TEMPLATES).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
            </select>
          </div>
          <div class="field-group">
            <label class="field-lbl">Account Name *</label>
            <input class="field-input" id="tplAcct" required placeholder="e.g. Operating Cash — Chase #1234">
          </div>
          <div class="field-row">
            <div class="field-group">
              <label class="field-lbl">Period Month</label>
              <select class="sel" id="tplMonth">
                <option value="January">January</option><option value="February">February</option>
                <option value="March">March</option><option value="April">April</option>
                <option value="May">May</option><option value="June">June</option>
                <option value="July">July</option><option value="August">August</option>
                <option value="September">September</option><option value="October">October</option>
                <option value="November">November</option><option value="December">December</option>
              </select>
            </div>
            <div class="field-group">
              <label class="field-lbl">GL Balance</label>
              <input class="field-input" id="tplGL" type="number" step="0.01" placeholder="0.00">
            </div>
          </div>
          <div id="tplPreview" class="tpl-preview"></div>
          <div class="modal-actions">
            <button type="button" class="btn" id="templateModalCancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>`;
}

function wireTemplateModal(container, toast, currentRole, currentUser) {
  const backdrop = container.querySelector('#templateModalBackdrop');
  const form     = container.querySelector('#templateForm');
  const preview  = container.querySelector('#tplPreview');
  const tplSel   = container.querySelector('#tplType');

  const showPreview = () => {
    const items = TEMPLATES[tplSel.value]?.items || [];
    preview.innerHTML = items.length
      ? `<p class="field-lbl" style="margin:0.5rem 0 0.3rem;">Line items to create:</p>
         <ul style="padding-left:1.25rem;font-size:0.82rem;color:var(--gray6);">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
      : '';
  };

  const open  = () => { showPreview(); backdrop.classList.remove('hidden'); };
  const close = () => { backdrop.classList.add('hidden'); form.reset(); preview.innerHTML = ''; };

  container.querySelector('#btnNewRecFromTemplate').addEventListener('click', open);
  container.querySelector('#templateModalClose').addEventListener('click', close);
  container.querySelector('#templateModalCancel').addEventListener('click', close);
  tplSel.addEventListener('change', showPreview);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const tplKey  = tplSel.value;
    const acctName = container.querySelector('#tplAcct').value.trim();
    const month   = container.querySelector('#tplMonth').value;
    const glBal   = parseFloat(container.querySelector('#tplGL').value) || null;
    if (!acctName) return;

    const { data: rec, error } = await supabase.from('account_recs').insert({
      account_name: acctName,
      account_type: tplKey,
      template_type: TEMPLATES[tplKey].label,
      gl_balance: glBal,
      schedule_balance: null,
      status: 'draft',
      preparer_id: currentUser?.id ?? null,
      period_month: month,
      period_year: 2026,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select().single();

    if (!error && rec) {
      const lineItems = TEMPLATES[tplKey].items.map(desc => ({
        rec_id: rec.id, description: desc,
        gl_amount: null, schedule_amount: null,
        match_status: 'unmatched', created_at: new Date().toISOString(),
      }));
      if (lineItems.length) await supabase.from('rec_line_items').insert(lineItems);
    }

    close();
    toast('Reconciliation created from template.');
    const updated = await fetchRecs();
    renderRecList(updated, container, toast, currentRole, currentUser);
  });
}
