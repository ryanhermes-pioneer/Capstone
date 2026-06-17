import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY')   ?? '';
const ESCALATION_EMAIL = Deno.env.get('ESCALATION_EMAIL') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')     ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Claude Close <noreply@thepioneerteam.com>',
      to: [to],
      subject,
      html,
    }),
  });
}

Deno.serve(async (_req) => {
  const now = new Date().toISOString();

  // Overdue tasks (due_date past, not complete)
  const { data: overdueTasks } = await supabase
    .from('close_tasks')
    .select('*')
    .lt('due_date', new Date().toISOString().slice(0, 10))
    .neq('status', 'complete');

  const tasks = overdueTasks ?? [];

  // Send owner reminders
  const emailsByOwner: Record<string, typeof tasks> = {};
  for (const task of tasks) {
    if (!task.owner_email) continue;
    if (!emailsByOwner[task.owner_email]) emailsByOwner[task.owner_email] = [];
    emailsByOwner[task.owner_email].push(task);
  }

  for (const [email, ownerTasks] of Object.entries(emailsByOwner)) {
    const taskList = ownerTasks.map(t =>
      `<li><strong>${t.title}</strong> — Due: ${t.due_date} — Status: ${t.status}</li>`
    ).join('');
    await sendEmail(
      email,
      `[Claude Close] ${ownerTasks.length} overdue task${ownerTasks.length !== 1 ? 's' : ''}`,
      `<p>Hi,</p>
       <p>The following tasks assigned to you are overdue in Claude Close (EPiC 2026):</p>
       <ul>${taskList}</ul>
       <p>Please update the status or contact your team lead if blocked.</p>
       <p style="color:#9c9690;font-size:0.85em;">Claude Close · Pioneer Management Consulting</p>`
    );
  }

  // Escalation: blocked for > 2 days → email team lead
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const blockedTasks = tasks.filter(t =>
    t.status === 'blocked' && t.updated_at < twoDaysAgo
  );

  if (blockedTasks.length && ESCALATION_EMAIL) {
    const list = blockedTasks.map(t =>
      `<li><strong>${t.title}</strong> — Owner: ${t.owner_email || 'unassigned'} — Reason: ${t.blocked_reason || 'none'}</li>`
    ).join('');
    await sendEmail(
      ESCALATION_EMAIL,
      `[Claude Close] Escalation: ${blockedTasks.length} task${blockedTasks.length !== 1 ? 's' : ''} blocked for 2+ days`,
      `<p>The following tasks have been blocked for more than 2 days and require attention:</p>
       <ul>${list}</ul>
       <p style="color:#9c9690;font-size:0.85em;">Claude Close · Pioneer Management Consulting</p>`
    );
  }

  return new Response(JSON.stringify({
    processed: tasks.length,
    escalated: blockedTasks.length,
    timestamp: now,
  }), { headers: { 'Content-Type': 'application/json' } });
});
