// Reading a bank statement with Docsumo (a document-reading service): only for a statement this app can't read
// itself — a PDF its reader and the OCR here couldn't make sense of, or a photo / scan of one. Docsumo reads the file
// in the background: it is uploaded (startDocsumo), then asked for until it has finished (docsumoResult). Its lines
// are checked against the running balance like any other statement, and nothing changes until someone presses Apply.
// Needs DOCSUMO_API_KEY in the environment (Docsumo → Settings → Webhook & API; on Vercel: Settings → Environment
// Variables). DOCSUMO_DOC_TYPE picks the document type to read it as; without it, the account's bank-statement type.
import { str } from './money.js';
import { matchHeader } from './reconcile.js';

const BASE = 'https://app.docsumo.com/api/v1/eevee/apikey';
const fail = (message, code = 'invalid_argument', status = 400) => { throw Object.assign(new Error(message), { status, code }); };
export const docsumoConfigured = () => Boolean(process.env.DOCSUMO_API_KEY);

let fetcher = null;
/** tests put a stand-in for fetch here */
export function setDocsumoFetch(f) { fetcher = f; docType = null; }

async function call(path, init = {}) {
  if (!docsumoConfigured()) fail('Reading with Docsumo isn’t set up: add a DOCSUMO_API_KEY in the app’s settings (on Vercel: Settings → Environment Variables), then redeploy.', 'docsumo_not_configured');
  let r;
  try {
    r = await (fetcher ?? fetch)(BASE + path, { ...init, headers: { apikey: process.env.DOCSUMO_API_KEY, ...init.headers }, signal: AbortSignal.timeout(40_000) });
  } catch { fail('Docsumo didn’t answer. Try again.', 'docsumo_unavailable', 502); }
  let body = null;
  try { body = await r.json(); } catch {}
  if (r.status === 401 || r.status === 403) fail('Docsumo refused the DOCSUMO_API_KEY. Check it in the app’s settings.', 'docsumo_not_configured');
  if (r.status === 429) fail('Docsumo is busy right now. Try again in a minute.', 'docsumo_busy', 429);
  if (r.status >= 400 && r.status < 500) fail(`Docsumo couldn’t take this file: ${str(body?.error || body?.message || `error ${r.status}`, 200)}`);
  if (!r.ok || !body) fail('Docsumo didn’t answer. Try again.', 'docsumo_unavailable', 502);
  return { status: r.status, body };
}

// the document type to read it as: set by hand, or the account's bank-statement type (looked up once)
let docType = null;
async function statementType() {
  if (process.env.DOCSUMO_DOC_TYPE) return process.env.DOCSUMO_DOC_TYPE;
  if (docType) return docType;
  const types = (await call('/limit/')).body?.data?.document_types ?? [];
  const t = types.find((x) => /bank/i.test(`${x.title} ${x.value}`) && /statement/i.test(`${x.title} ${x.value}`));
  if (!t?.value) fail('Your Docsumo account has no bank statement document type turned on. Turn one on in Docsumo, or set DOCSUMO_DOC_TYPE in the app’s settings.', 'docsumo_not_configured');
  return (docType = String(t.value));
}

/** file: Buffer of a PDF, PNG, JPEG or TIFF → { docId } (Docsumo starts reading it) */
export async function startDocsumo(buf, fileName = '') {
  const head = buf.subarray(0, 8);
  const media = head.subarray(0, 5).toString('latin1') === '%PDF-' ? ['application/pdf', 'pdf']
    : head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? ['image/png', 'png']
      : head[0] === 0xff && head[1] === 0xd8 ? ['image/jpeg', 'jpg']
        : ['49492a00', '4d4d002a'].includes(head.subarray(0, 4).toString('hex')) ? ['image/tiff', 'tif'] : null;
  if (!media) fail('Docsumo reads a PDF, or a photo / scan of the statement (PNG, JPEG or TIFF).');
  if (media[1] === 'pdf' && /\/Encrypt\b/.test(buf.subarray(0, Math.min(buf.length, 4_000_000)).toString('latin1'))) {
    fail('This PDF is locked with a password, which Docsumo can’t open. Open it, print it with Chrome’s “Save as PDF” (that saves it unlocked), and upload that.');
  }
  const form = new FormData();
  const name = str(fileName, 200).replace(/\.[a-z0-9]{1,5}$/i, '') || 'statement';
  form.append('file', new Blob([buf], { type: media[0] }), `${name}.${media[1]}`);
  form.append('type', await statementType());
  const docId = (await call('/upload/', { method: 'POST', body: form })).body?.data?.document?.[0]?.doc_id;
  if (!docId) fail('Docsumo didn’t answer. Try again.', 'docsumo_unavailable', 502);
  return { docId: String(docId) };
}

// ── what Docsumo read → the six columns the AI reader gives (Date, Narration, Ref No., Withdrawal, Deposit, Balance) ──
const val = (c) => (c && typeof c === 'object' && !Array.isArray(c) ? c.value : c);
const text = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isRow = (x) => x && typeof x === 'object' && !Array.isArray(x);
// every table (an array of rows, each { column: { value } }) and every single field, wherever they are in the answer
function walk(node, tables, fields, key = '') {
  if (Array.isArray(node)) {
    if (node.length && node.every(isRow) && node.some((r) => Object.values(r).some((c) => isRow(c) && 'value' in c))) tables.push(node);
    else for (const x of node) walk(x, tables, fields);
  } else if (isRow(node)) {
    if ('value' in node && !Array.isArray(node.value) && !isRow(node.value)) fields.push([key, text(node.value)]);
    else for (const [k, v] of Object.entries(node)) walk(v, tables, fields, k);
  }
}
// columns by heading: the statement reader's names first, then any heading that contains one of these words
const LOOSE = { date: /date|\bdt\b/i, narration: /narration|descr|particular|detail|remark/i, ref: /ref|che?q|chq|utr/i,
  debit: /withdraw|debit|\bdr\b/i, credit: /deposit|credit|\bcr\b/i, amount: /amount|amt/i, drcr: /dr.?cr|cr.?dr|type/i, balance: /balance|bal\b/i };
function columnsOf(heads) {
  const exact = matchHeader(heads);
  if (exact) return exact;
  const cols = {}, used = new Set();
  for (const [key, re] of Object.entries(LOOSE)) {
    const i = heads.findIndex((h, j) => !used.has(j) && re.test(h) && !(key === 'date' && /value/i.test(h) && heads.some((x) => /date/i.test(x) && !/value/i.test(x))));
    if (i >= 0) { cols[key] = i; used.add(i); }
  }
  return cols.date != null && (cols.debit != null || cols.credit != null || cols.amount != null) ? cols : null;
}

/** Docsumo's answer (data/simplified) → { lines: [[6 strings]] with the headings first, account } */
export function linesFromDocsumo(data) {
  const tables = [], fields = [];
  walk(data, tables, fields);
  // the transactions: the biggest table with a date and an amount column
  let best = null;
  for (const t of tables) {
    const heads = [...new Set(t.flatMap((r) => Object.keys(r)))], cols = columnsOf(heads);
    if (cols && (!best || t.length > best.t.length)) best = { t, heads, cols };
  }
  if (!best) fail('Docsumo didn’t find a table of transactions in this file. Check that it is a bank statement.', 'docsumo_unreadable');
  const { t, heads, cols } = best;
  const cell = (r, k) => (cols[k] == null ? '' : text(val(r[heads[cols[k]]])));
  const lines = [['Date', 'Narration', 'Ref No.', 'Withdrawal', 'Deposit', 'Balance']];
  for (const r of t.slice(0, 5000)) {
    let out = cell(r, 'debit'), inn = cell(r, 'credit');
    if (cols.debit == null && cols.credit == null) { // one amount column: by its Dr / Cr, or its sign
      const a = cell(r, 'amount'), kind = cell(r, 'drcr');
      if (/^-|^\(|\bdr\.?$/i.test(a) || /^d/i.test(kind)) out = a.replace(/^-|^\((.*)\)$/g, '$1'); else inn = a;
    } else if (cols.debit == null && cols.credit != null && cols.amount != null && !inn) out = cell(r, 'amount');
    const line = [cell(r, 'date'), cell(r, 'narration'), cell(r, 'ref'), out, inn, cell(r, 'balance')].map((s) => s.slice(0, 300));
    if (line.some(Boolean)) lines.push(line);
  }
  if (lines.length < 2) fail('Docsumo didn’t find any transactions in this file.', 'docsumo_unreadable');
  // the account number: a field named like one, with digits in it
  const acct = fields.find(([k, v]) => /a\/?c|account|acct/i.test(k) && /(no|num|#)/i.test(k) && /\d{4}/.test(v))
    ?? fields.find(([k, v]) => /a\/?c|account|acct/i.test(k) && /\d{4}\W*$/.test(v));
  return { lines, account: acct ? str(acct[1], 40) : '' };
}

/** { ready: false } while Docsumo is still reading; then { ready: true, lines, account } */
export async function docsumoResult(docId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(docId ?? ''))) fail('That Docsumo document isn’t known. Read the statement again.');
  const { status, body } = await call(`/data/simplified/${docId}/`);
  if (status === 202 || !body.data) return { ready: false };
  return { ready: true, ...linesFromDocsumo(body.data) };
}
