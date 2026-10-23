// Reading an uploaded sheet of receipts and payments: an Excel workbook (.xlsx) or a CSV, without any library.
// readTable gives the first sheet as rows of cells (strings and numbers; dated cells as YYYY-MM-DD);
// importRows finds the header row, matches the columns by name and checks each row.
import zlib from 'node:zlib';
import { toPaise, str } from './money.js';

export const MAX_BYTES = 3 * 1024 * 1024; // Vercel takes request bodies up to 4.5 MB, and the file arrives base64-encoded
export const MAX_ROWS = 2000;
export const CATEGORIES = ['Vendor', 'Salary', 'Tax / GST / TDS', 'Rent', 'Loan / EMI', 'Utilities', 'Refund', 'Other'];

const bad = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_argument' }); };

// ── a minimal ZIP reader, enough for an .xlsx package ──
function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) bad('That file couldn’t be read as an Excel workbook. Save it as .xlsx (or .csv) and try again.');
  const files = new Map(), count = buf.readUInt16LE(end + 10);
  for (let i = 0, p = buf.readUInt32LE(end + 16); i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen), local = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, () => {
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    });
  }
  return { has: (n) => files.has(n), text: (n) => files.get(n)?.() ?? '' };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const attr = (tag, name) => unxml(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '');
// the text of a cell or shared string: its <t> runs, leaving out phonetic hints (<rPh>)
const runs = (x) => unxml([...x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// Excel keeps dates as day numbers; a cell is a date when its number format is one
const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
export const serialDate = (n, base1904 = false) => new Date(Date.UTC(1899, 11, 30) + (Math.floor(n) + (base1904 ? 1462 : 0)) * 864e5).toISOString().slice(0, 10);

function readXlsx(buf) {
  const z = unzip(buf);
  const wb = z.text('xl/workbook.xml');
  if (!wb) bad('That file couldn’t be read as an Excel workbook. Save it as .xlsx (or .csv) and try again.');
  const base1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);
  const rels = new Map([...z.text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(([t]) => [attr(t, 'Id'), attr(t, 'Target')]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(([t]) => {
    const target = rels.get(attr(t, 'r:id')) ?? '';
    return { name: attr(t, 'name'), path: target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, '/') };
  }).filter((s) => z.has(s.path));
  if (!sheets.length) bad('That workbook has no sheets.');
  const shared = [...z.text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g)].map((m) => runs(m[1] ?? ''));
  const styles = z.text('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*>/g)].map(([t]) => [Number(attr(t, 'numFmtId')), attr(t, 'formatCode')]));
  const isDateFmt = (id) => DATE_FORMATS.has(id) || (custom.has(id) && /[dmy]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')));
  const xfs = [.../<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1].matchAll(/<xf\b[^>]*>/g) ?? []].map(([t]) => isDateFmt(Number(attr(t, 'numFmtId'))));

  // the first sheet with something in it
  for (const sheet of sheets) {
    const rows = [];
    for (const [, rowAttrs, body = ''] of z.text(sheet.path).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(rowAttrs, 'r')) || rows.length + 1;
      const cells = [];
      let next = 0;
      for (const [, cellAttrs, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cellAttrs, 'r'), c = ref ? colIndex(ref) : next;
        next = c + 1;
        const t = attr(cellAttrs, 't'), v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value;
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = runs(inner);
        else if (t === 'str' || t === 'e') value = unxml(v ?? '');
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null && v !== '') { const n = Number(v); value = Number.isFinite(n) && xfs[Number(attr(cellAttrs, 's')) || 0] ? serialDate(n, base1904) : n; }
        if (value != null && value !== '' && c < 200) cells[c] = typeof value === 'string' ? value.trim() : value;
      }
      if (cells.length) rows[r - 1] = Array.from(cells, (x) => x ?? '');
    }
    if (rows.length) return { sheet: sheet.name, rows: Array.from(rows, (x, i) => ({ n: i + 1, cells: x ?? [] })).filter((r) => r.cells.length), base1904 };
  }
  return { sheet: sheets[0].name, rows: [], base1904 };
}

// CSV: comma, semicolon or tab separated; "quoted, fields" and "" inside quotes
function readCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  // the separator used most in the first lines (pasted text can start with a few lines of account details)
  const head = text.split(/\r?\n/, 30).join('\n');
  // a table copied from a web page or email is tab-separated (its amounts are full of commas: 21,84,089.85)
  const sep = head.includes('\t') ? '\t' : [',', ';'].map((s) => [s, head.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false, n = 1;
  const push = () => { row.push(cell.trim()); cell = ''; };
  const endRow = () => { push(); if (row.some((x) => x !== '')) rows.push({ n, cells: row }); row = []; n++; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { cell = ''; quoted = true; } else if (ch === sep) push();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return { sheet: '', rows };
}

/** the uploaded file → { sheet, rows: [{ n: row number in the file, cells }] } */
export function readTable(buf, fileName = '') {
  if (!buf.length) bad('That file is empty.');
  if (buf.length > MAX_BYTES) bad('That file is too big. Upload at most 3 MB (about 20,000 rows).');
  if (buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04') return readXlsx(buf);
  if (buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') bad('That is an old Excel file (.xls). In Excel, choose File → Save As → Excel Workbook (.xlsx), then upload that.');
  if (/\.(xlsx|xlsm|xls)$/i.test(fileName)) bad('That file couldn’t be read as an Excel workbook. Save it as .xlsx (or .csv) and try again.');
  if (buf.includes(0)) bad('That file isn’t a spreadsheet. Upload an Excel workbook (.xlsx) or a CSV file.');
  // Excel's "CSV UTF-8" is UTF-8; its plain "CSV" is the Windows code page, read here as Latin-1
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = buf.toString('latin1'); }
  return readCsv(text);
}

// ── columns, recognised by their heading (case, spaces and punctuation don't matter); first match wins ──
const COLUMNS = {
  type: ['type', 'kind', 'receiptpayment', 'paymentreceipt', 'transactiontype', 'txntype', 'entrytype', 'drcr', 'crdr', 'inout', 'nature'],
  name: ['name', 'party', 'partyname', 'payee', 'payeename', 'paidto', 'payto', 'tobepaidto', 'receivedfrom', 'vendor', 'vendorname', 'supplier', 'suppliername', 'customer', 'customername', 'client', 'clientname', 'beneficiary', 'beneficiaryname', 'particulars', 'ledger', 'ledgername'],
  amount: ['amount', 'amountrs', 'amountinr', 'amountinrs', 'amt', 'amountpayable', 'payableamount', 'amountdue', 'dueamount', 'amountreceivable', 'receivableamount', 'pendingamount', 'outstandingamount', 'outstanding', 'balanceamount', 'netamount', 'netpayable', 'totalamount', 'invoiceamount', 'billamount', 'total', 'value'],
  out: ['payment', 'payments', 'paymentamount', 'debit', 'debitamount', 'dr', 'withdrawal', 'outflow', 'payable'],
  in: ['receipt', 'receipts', 'receiptamount', 'credit', 'creditamount', 'cr', 'deposit', 'inflow', 'receivable'],
  date: ['duedate', 'dueon', 'paymentdate', 'paydate', 'expecteddate', 'receiptdate', 'date', 'duedt', 'dt', 'invoicedate', 'billdate'],
  ref: ['invoiceno', 'invoicenumber', 'invno', 'invoice', 'billno', 'billnumber', 'bill', 'refno', 'reference', 'referenceno', 'ref', 'docno', 'documentno', 'voucherno', 'vchno'],
  note: ['description', 'narration', 'remarks', 'remark', 'note', 'notes', 'details', 'purpose'],
  category: ['category', 'expensehead', 'head', 'ledgergroup', 'group'],
  bank: ['bankaccount', 'bank', 'bankname', 'account', 'fromaccount', 'paidfrom', 'paythrough'],
};
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// which column holds what, from a header row; null if this isn't one
function matchHeader(cells) {
  const heads = cells.map(norm), used = new Set(), cols = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    for (const name of names) {
      const i = heads.findIndex((x, j) => x === name && !used.has(j));
      if (i >= 0) { cols[key] = i; used.add(i); break; }
    }
  }
  return cols.name != null && (cols.amount != null || cols.out != null || cols.in != null) ? cols : null;
}

const TYPE_IN = /^(r|receipt|receipts|received|receive|receivable|in|incoming|inflow|credit|cr|collection|income|sale|sales)\b/i;
const TYPE_OUT = /^(p|payment|payments|paid|pay|payable|out|outgoing|outflow|debit|dr|expense|expenses|purchase|purchases)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const valid = (y, m, d) => { const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return m >= 1 && m <= 12 && d >= 1 && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s ? s : null; };
const year = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** a date as written in India: 21/10/2026, 21-10-26, 21.10.2026, 21-Oct-2026, 21 October 2026, 2026-10-21, or an Excel day number */
export function parseDate(v, base1904 = false) {
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialDate(v, base1904) : null;
  const s = String(v ?? '').trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?$/i, '');
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) return valid(year(m[3]), Number(m[2]), Number(m[1])); // day first
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[-/.\s]+([a-z]{3,9})\.?[-/.,\s]+(\d{2}|\d{4})$/i.exec(s))) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); return mo < 0 ? null : valid(year(m[3]), mo + 1, Number(m[1])); }
  if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s))) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); return mo < 0 ? null : valid(Number(m[3]), mo + 1, Number(m[2])); }
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s), base1904);
  return null;
}

// an amount cell: a number, or text like "₹ 1,25,000.50", "Rs. 500", "(500)" or "500 Dr"
function amountOf(v) {
  if (typeof v === 'number') { if (!Number.isFinite(v)) return { error: 'isn’t a number' }; return { paise: Math.round(v * 100) }; }
  const s = String(v ?? '').trim().replace(/\s*(dr|cr)\.?$/i, '').replace(/^\((.*)\)$/, '-$1');
  if (!s) return { paise: null };
  try { return { paise: toPaise(s, 'Amount', { allowNegative: true }) }; } catch { return { error: `“${String(v).slice(0, 30)}” isn’t an amount` }; }
}

/**
 * The sheet's rows as receipts and payments to add, each checked:
 * { row, kind, name, amount (paise), date, ref, note, category, bank_id, problems: [why it can't be added], notes: [what was assumed] }
 * kind: 'IN' or 'OUT' for rows whose type the sheet doesn't say. banks: [{ id, name, bank, last4 }].
 */
export function importRows(table, { kind, banks, today }) {
  const top = table.rows.slice(0, 15);
  const at = top.findIndex((r) => matchHeader(r.cells));
  if (at < 0) bad('No heading row found. The sheet needs a row of column headings with at least a name (e.g. “Party” or “Vendor”) and an amount (e.g. “Amount”) — download the sample sheet to see the layout.');
  const header = top[at], cols = matchHeader(header.cells);
  const body = table.rows.slice(table.rows.indexOf(header) + 1);
  if (body.length > MAX_ROWS) bad(`That sheet has ${body.length} rows. Upload at most ${MAX_ROWS} at a time.`);
  const cell = (r, k) => (cols[k] == null ? '' : r.cells[cols[k]] ?? '');
  const text = (r, k, max) => str(typeof cell(r, k) === 'number' ? String(cell(r, k)) : cell(r, k), max);

  const findBank = (v) => {
    const s = norm(v);
    if (!s) return { id: null };
    const digits = /(\d{4})\D*$/.exec(String(v))?.[1];
    const hit = banks.find((b) => digits && b.last4 === digits) ?? banks.find((b) => norm(b.name) === s) ?? banks.filter((b) => norm(b.bank) === s || norm(b.bank).startsWith(s) || s.startsWith(norm(b.bank))).find((_, __, all) => all.length === 1);
    return hit ? { id: hit.id } : { id: null, note: `bank account “${String(v).slice(0, 40)}” not found — left as “Not decided”` };
  };

  const out = [];
  for (const r of body) {
    const name = text(r, 'name', 120);
    if (/^(sub\s*-?\s*|grand\s+)?totals?\b/i.test(name) || /^(sub\s*-?\s*|grand\s+)?totals?\b/i.test(String(r.cells[0] ?? ''))) continue; // a totals line
    const problems = [], notes = [];
    let k = kind, amount = null;
    if (cols.out != null || cols.in != null) { // separate Payment / Receipt (Debit / Credit) amount columns
      const o = amountOf(cell(r, 'out')), i = amountOf(cell(r, 'in'));
      if (o.error || i.error) problems.push(`Amount: ${o.error || i.error}`);
      else if (o.paise && i.paise) problems.push('Both a payment and a receipt amount — put them on separate rows');
      else if (o.paise) { k = 'OUT'; amount = o.paise; } else if (i.paise) { k = 'IN'; amount = i.paise; }
    }
    if (amount == null && cols.amount != null) {
      const a = amountOf(cell(r, 'amount'));
      if (a.error) problems.push(`Amount: ${a.error}`); else amount = a.paise;
    }
    if (cols.type != null && cell(r, 'type') !== '') {
      const t = String(cell(r, 'type')).trim();
      if (TYPE_IN.test(t)) k = 'IN'; else if (TYPE_OUT.test(t)) k = 'OUT';
      else problems.push(`Type “${t.slice(0, 20)}”: write Payment or Receipt`);
    }
    if (!name && amount == null && !problems.length) continue; // an empty line, or only notes
    if (!name) problems.push('No name');
    if (amount == null) { if (!problems.some((p) => p.startsWith('Amount'))) problems.push('No amount'); }
    else if (amount < 0) problems.push('Amount is negative');
    else if (amount === 0) problems.push('Amount is zero');
    else if (amount > 99_99_99_99_99_999) problems.push('Amount is too large');

    let date = null;
    const rawDate = cell(r, 'date');
    if (rawDate === '') { date = today; notes.push('no date — due today'); }
    else if (!(date = parseDate(rawDate, table.base1904))) problems.push(`Date “${String(rawDate).slice(0, 20)}” not understood — use e.g. 21/10/2026`);

    let category = '';
    if (k === 'OUT') {
      const c = text(r, 'category', 40);
      category = CATEGORIES.find((x) => norm(x) === norm(c) || (norm(c) && norm(x).startsWith(norm(c)))) ?? 'Other';
      if (c && category === 'Other' && norm(c) !== 'other') notes.push(`category “${c}” → Other`);
    }
    const bank = findBank(cell(r, 'bank'));
    if (bank.note) notes.push(bank.note);
    out.push({ row: r.n, kind: k, name, amount: amount ?? 0, date, ref: text(r, 'ref', 80), note: text(r, 'note', 300), category, bank_id: bank.id, problems, notes });
  }
  const found = Object.fromEntries(Object.entries(cols).map(([key, i]) => [key, String(header.cells[i])]));
  return { headerRow: header.n, columns: found, rows: out };
}
