import { jsPDF } from 'jspdf';

const MONTH_ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const upZone      = document.getElementById('upZone');
const fileInput   = document.getElementById('fileInput');
const srcLocal    = document.getElementById('srcLocal');
const srcFabric   = document.getElementById('srcFabric');
const fabricIcon  = document.getElementById('fabricIcon');
const selClient   = document.getElementById('selClient');
const selMonth    = document.getElementById('selMonth');
const btnDownload = document.getElementById('btnDownload');
const btnSend     = document.getElementById('btnSend');
const emailRow    = document.getElementById('emailRow');
const emailInput  = document.getElementById('emailInput');
const btnMailto   = document.getElementById('btnMailto');
const invCard     = document.getElementById('invCard');
const summaryPanel= document.getElementById('summaryPanel');
const sPill       = document.getElementById('sPill');
const sTxt        = document.getElementById('sTxt');

let data = {}; // { client: { month: [{ project, revenue }] } }

// ── Upload (local CSV) ────────────────────────────────────────────────────────

srcLocal.addEventListener('click', () => fileInput.click());
upZone.addEventListener('dragover', e => { e.preventDefault(); upZone.classList.add('drag'); });
upZone.addEventListener('dragleave', () => upZone.classList.remove('drag'));
upZone.addEventListener('drop', e => {
  e.preventDefault();
  upZone.classList.remove('drag');
  handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

// ── Load from Fabric ──────────────────────────────────────────────────────────

srcFabric.addEventListener('click', async () => {
  fabricIcon.textContent = '…';
  srcFabric.classList.add('loading');
  setStatus('progress', 'Connecting to Fabric…');
  try {
    const res = await fetch('http://localhost:5050/api/fabric-data');
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('No data returned');
    data = buildIndex(rows.slice(1));
    populateClients();
    upZone.classList.add('hidden');
    setStatus('progress', 'Fabric data loaded');
  } catch (err) {
    fabricIcon.textContent = '⚠';
    srcFabric.classList.remove('loading');
    setStatus('idle', 'Fabric connection failed');
    alert(`Could not reach Fabric server.\n\nMake sure server.py is running:\n  python "Close Tracker/server.py"\n\nError: ${err.message}`);
    fabricIcon.textContent = '⬡';
  }
});

async function handleFile(file) {
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const text = new TextDecoder('windows-1252').decode(buffer);
  const rows = parseCSV(text);
  if (rows.length < 2) return;

  data = buildIndex(rows.slice(1));
  populateClients();
  upZone.classList.add('hidden');
  setStatus('progress', 'Data loaded');
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n').map(line => {
    const fields = [];
    let field = '', inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { fields.push(field.trim()); field = ''; }
      else { field += ch; }
    }
    fields.push(field.trim());
    return fields;
  });
}

function parseCurrency(str) {
  return parseFloat(String(str).replace(/[$,]/g, '')) || 0;
}

function buildIndex(rows) {
  const index = {};
  for (const [client, project, month, revenueStr] of rows) {
    if (!client?.trim() || !month?.trim()) continue;
    const c = client.trim(), m = month.trim();
    const revenue = parseCurrency(revenueStr);
    if (!index[c]) index[c] = {};
    if (!index[c][m]) index[c][m] = [];
    index[c][m].push({ project: project?.trim() ?? '', revenue });
  }
  return index;
}

// ── Dropdowns ─────────────────────────────────────────────────────────────────

function populateClients() {
  selClient.innerHTML = '<option value="">Select client…</option>';
  Object.keys(data).sort().forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    selClient.appendChild(opt);
  });
  selClient.disabled = false;
}

selClient.addEventListener('change', () => {
  const client = selClient.value;
  selMonth.innerHTML = '<option value="">Select month…</option>';
  invCard.classList.add('hidden');
  summaryPanel.style.display = 'none';
  btnDownload.disabled = true;
  btnSend.disabled = true;
  emailRow.classList.add('hidden');

  if (!client) { selMonth.disabled = true; return; }

  const months = Object.keys(data[client]).sort(
    (a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b)
  );
  months.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    selMonth.appendChild(opt);
  });
  selMonth.disabled = false;
});

selMonth.addEventListener('change', () => {
  const client = selClient.value;
  const month  = selMonth.value;
  if (client && month) renderInvoice(client, month);
});

// ── Invoice render ────────────────────────────────────────────────────────────

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderInvoice(client, month) {
  const lineItems = data[client][month];
  const total = lineItems.reduce((s, r) => s + r.revenue, 0);

  document.getElementById('invClient').textContent = client;
  document.getElementById('invMonth').textContent  = `${month} 2026`;
  document.getElementById('invTotal').textContent  = `$${fmt(total)}`;

  document.getElementById('invBody').innerHTML = lineItems.map(({ project, revenue }) =>
    `<tr><td>${project}</td><td>$${fmt(revenue)}</td></tr>`
  ).join('');

  // Sidebar summary
  document.getElementById('summaryMonth').textContent    = month;
  document.getElementById('summaryTotal').textContent    = `$${fmt(total)}`;
  document.getElementById('summaryProjects').textContent = `${lineItems.length} project${lineItems.length !== 1 ? 's' : ''}`;
  summaryPanel.style.display = 'block';

  invCard.classList.remove('hidden');
  btnDownload.disabled = false;
  btnSend.disabled = false;
  setStatus('closed', 'Invoice ready');

  // Cache for download
  invCard.dataset.client = client;
  invCard.dataset.month  = month;
}

// ── Download PDF ──────────────────────────────────────────────────────────────

btnDownload.addEventListener('click', () => {
  const client = invCard.dataset.client;
  const month  = invCard.dataset.month;
  buildPDFDoc(client, month, data[client][month])
    .save(`${client} - ${month} 2026.pdf`);
});

function generatePDF(client, month, lineItems) {
  buildPDFDoc(client, month, lineItems).save(`${client} - ${month} 2026.pdf`);
}

function buildPDFDoc(client, month, lineItems) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = 612, H = 792, ML = 54, MR = 54;
  const contentW = W - ML - MR;
  const right    = W - MR;
  const total    = lineItems.reduce((s, r) => s + r.revenue, 0);
  const monthNum = String(MONTH_ORDER.indexOf(month) + 1).padStart(2, '0');
  const invoiceNum = `PMC-2026-${monthNum}`;

  const G900   = [45,  41,  38];   // Pioneer dark #2D2926
  const G500   = [87, 161, 119];   // Pioneer green #57A177
  const GR900  = [45,  41,  38];   // Pioneer dark
  const GR600  = [92,  86,  80];   // warm mid-gray
  const GR400  = [156,150, 144];   // warm light gray
  const GR200  = [214,210, 196];   // Pioneer beige #D6D2C4
  const GR50   = [247,245, 242];   // warm off-white
  const WHITE  = [255,255, 255];
  const ROW_H  = 23;

  // ── Header banner ───────────────────────────────────────────────────────────
  doc.setFillColor(...G900);
  doc.rect(0, 0, W, 84, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(...WHITE);
  doc.text('PIONEER MANAGEMENT CONSULTING', ML, 36);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...G500);
  doc.text('Management Consulting', ML, 54);

  // PMC badge
  doc.setDrawColor(...G500);
  doc.setLineWidth(1.5);
  doc.rect(right - 46, 22, 46, 26);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...G500);
  doc.text('PMC', right - 23, 40, { align: 'center' });

  // ── Invoice title ───────────────────────────────────────────────────────────
  let y = 116;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(...G900);
  doc.text('INVOICE', ML, y);

  y += 34;

  // ── Bill-to / meta row ──────────────────────────────────────────────────────
  const c2 = ML + contentW * 0.45;
  const c3 = ML + contentW * 0.70;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...GR400);
  doc.text('BILLED TO',    ML, y);
  doc.text('INVOICE #',    c2, y);
  doc.text('INVOICE DATE', c3, y);

  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(...GR900);
  // Truncate very long client names
  const clientLabel = doc.splitTextToSize(client, c2 - ML - 8)[0];
  doc.text(clientLabel, ML, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...GR600);
  doc.text(invoiceNum,    c2, y);
  doc.text(`${month} 2026`, c3, y);

  y += 30;

  // ── Divider ─────────────────────────────────────────────────────────────────
  doc.setDrawColor(...GR200);
  doc.setLineWidth(1);
  doc.line(ML, y, right, y);
  y += 18;

  // ── Table header ────────────────────────────────────────────────────────────
  doc.setFillColor(...GR50);
  doc.rect(ML, y, contentW, ROW_H, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...GR400);
  doc.text('PROJECT', ML + 8, y + 15);
  doc.text('AMOUNT',  right - 8, y + 15, { align: 'right' });
  y += ROW_H;

  // ── Line items ───────────────────────────────────────────────────────────────
  const maxProjW = contentW - 120;
  doc.setFontSize(9.5);

  lineItems.forEach(({ project, revenue }, i) => {
    if (y > H - 110) {
      doc.addPage();
      y = ML;
    }

    if (i % 2 === 1) {
      doc.setFillColor(...GR50);
      doc.rect(ML, y, contentW, ROW_H, 'F');
    }

    const label = doc.splitTextToSize(project, maxProjW)[0];

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GR900);
    doc.text(label, ML + 8, y + 15);

    doc.setTextColor(...GR600);
    doc.text(`$${fmt(revenue)}`, right - 8, y + 15, { align: 'right' });

    y += ROW_H;
  });

  // ── Total bar ────────────────────────────────────────────────────────────────
  const TOTAL_H = 34;
  doc.setFillColor(...G900);
  doc.rect(ML, y, contentW, TOTAL_H, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...WHITE);
  doc.text('TOTAL',        ML + 8,   y + 21);
  doc.text(`$${fmt(total)}`, right - 8, y + 21, { align: 'right' });

  // ── Footer ───────────────────────────────────────────────────────────────────
  const generated = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  doc.setDrawColor(...GR200);
  doc.setLineWidth(0.5);
  doc.line(ML, H - 46, right, H - 46);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...GR400);
  doc.text(
    `Pioneer Management Consulting  ·  Confidential  ·  Generated ${generated}`,
    W / 2, H - 30, { align: 'center' }
  );

  return doc;
}

// ── Send — EML with PDF attachment ───────────────────────────────────────────

btnSend.addEventListener('click', () => {
  emailRow.classList.toggle('hidden');
  if (!emailRow.classList.contains('hidden')) emailInput.focus();
});

btnMailto.addEventListener('click', () => {
  const to     = emailInput.value.trim();
  const client = invCard.dataset.client;
  const month  = invCard.dataset.month;
  const items  = data[client][month];
  generateEML(to, client, month, items);
});

function generateEML(to, client, month, lineItems) {
  const total    = lineItems.reduce((s, r) => s + r.revenue, 0);
  const filename = `${client} - ${month} 2026.pdf`;
  const subject  = `Invoice – ${client} – ${month} 2026`;

  // Get PDF as base64
  const pdfBuffer = buildPDFDoc(client, month, lineItems).output('arraybuffer');
  const pdfBytes  = new Uint8Array(pdfBuffer);
  let binary = '';
  pdfBytes.forEach(b => binary += String.fromCharCode(b));
  const pdfB64 = btoa(binary).match(/.{1,76}/g).join('\r\n');

  // Plain-text body
  const textBody = [
    'Pioneer Management Consulting',
    `Invoice · ${client} · ${month} 2026`,
    '',
    ...lineItems.map(({ project, revenue }) => `  ${project}:  $${fmt(revenue)}`),
    '',
    `Total:  $${fmt(total)}`,
  ].join('\r\n');

  const boundary = `----=_PMC_${Date.now()}`;

  const eml = [
    'MIME-Version: 1.0',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    textBody,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    pdfB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const blob = new Blob([eml], { type: 'message/rfc822' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `Invoice - ${client} - ${month}.eml`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  sPill.dataset.s = state;
  sTxt.textContent = text;
}
