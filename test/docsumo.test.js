import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDocsumo, docsumoResult, linesFromDocsumo, setDocsumoFetch, docsumoConfigured, isoDates, statementType } from '../server/docsumo.js';
import { readStatement } from '../server/reconcile.js';
import { tableFromLines } from '../server/ai.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';
import { makePdf } from './pdf-maker.js';

// a stand-in for Docsumo's API: answers by path, and keeps what it was sent
const calls = [];
const res = (status, body) => ({ status, ok: status < 400, json: async () => body });
const fakeDocsumo = (routes) => async (url, init) => {
  const path = url.startsWith('https://app.docsumo.com/api/v1/eevee/apikey') ? url.replace('https://app.docsumo.com/api/v1/eevee/apikey', '') : url;
  calls.push({ path, init });
  const key = Object.keys(routes).find((k) => path.startsWith(k));
  return key ? (typeof routes[key] === 'function' ? routes[key](path, init) : routes[key]) : res(404, { error: 'not found' });
};
const cell = (value) => ({ confidence: 0.98, position: [0, 0, 1, 1], review_required: false, value });
const row = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cell(v)]));
const TYPES = res(200, { data: { document_types: [{ title: 'Invoice', value: 'invoice' }, { title: 'Bank Statement', value: 'bank_statement' }], monthly_doc_limit: 1000 } });
const UPLOADED = res(200, { data: { document: [{ doc_id: 'abc123', status: 'new' }] }, status: 'success' });
// what Docsumo reads from a (made-up) IDBI statement, its usual shape: sections of fields and a table of rows
const statement = (date) => ({
  'Account Details': { 'Account Number': cell('XXXXXXXX1198'), 'Account Holder': cell('AMINORICH') },
  Transactions: [
    row({ 'Transaction Date': date, Description: 'AT ,BROUGHT FORWARD', 'Cheque No': '', Debit: '', Credit: '', Balance: '21,44,089.85' }),
    row({ 'Transaction Date': date, Description: 'UPI/870008483904/PRINCE VERMA', 'Cheque No': '', Debit: '', Credit: 40000, Balance: '21,84,089.85' }),
    row({ 'Transaction Date': date, Description: 'SUNITA', 'Cheque No': '967712', Debit: 25422, Credit: '', Balance: '21,58,667.85' }),
    row({ 'Transaction Date': date, Description: 'NEFT-PUNB0486700-GEETA HHAH', 'Cheque No': '967708', Debit: '18,000.00', Credit: '', Balance: '21,40,667.85' }),
    row({ 'Transaction Date': date, Description: 'NEFT-CHARGE-DR-IBKL26102199181', 'Cheque No': '', Debit: 5.9, Credit: '', Balance: '21,40,661.95' }),
  ],
});
const pdf = makePdf([[40, 500, 'any statement']]); // has text, but no statement table: this app can't read it
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

test('not set up: no DOCSUMO_API_KEY → says how to turn it on, and nothing is sent', async () => {
  delete process.env.DOCSUMO_API_KEY;
  setDocsumoFetch(fakeDocsumo({}));
  calls.length = 0;
  assert.equal(docsumoConfigured(), false);
  await assert.rejects(startDocsumo(pdf), (e) => e.code === 'docsumo_not_configured' && /DOCSUMO_API_KEY/.test(e.message));
  assert.equal(calls.length, 0);
});

test('a PDF is uploaded with the API key, as the account’s bank-statement type; then read once Docsumo has finished', async () => {
  process.env.DOCSUMO_API_KEY = 'test-key';
  let ready = false;
  setDocsumoFetch(fakeDocsumo({ '/limit/': TYPES, '/upload/': UPLOADED, '/data/simplified/abc123/': () => (ready ? res(200, { data: statement('21/10/2026'), meta_data: { status: 'reviewing' } }) : res(202, { message: 'The document is still being processed.' })) }));
  calls.length = 0;
  assert.deepEqual(await startDocsumo(pdf, 'IDBI Oct.pdf'), { docId: 'abc123' });
  const up = calls.find((c) => c.path === '/upload/');
  assert.equal(up.init.method, 'POST');
  assert.equal(up.init.headers.apikey, 'test-key');
  assert.equal(up.init.body.get('type'), 'bank_statement');
  const f = up.init.body.get('file');
  assert.deepEqual([f.name, f.type, Buffer.from(await f.arrayBuffer()).equals(pdf)], ['IDBI Oct.pdf', 'application/pdf', true]);
  // the type is looked up once
  await startDocsumo(png, 'photo.png');
  assert.equal(calls.filter((c) => c.path === '/limit/').length, 1);
  assert.equal(calls.at(-1).init.body.get('file').type, 'image/png');

  assert.deepEqual(await docsumoResult('abc123'), { ready: false });
  ready = true;
  const r = await docsumoResult('abc123');
  assert.equal(r.ready, true);
  assert.equal(r.account, 'XXXXXXXX1198');
  assert.deepEqual(r.lines[0], ['Date', 'Narration', 'Ref No.', 'Withdrawal', 'Deposit', 'Balance']);
  assert.deepEqual(r.lines[3], ['2026-10-21', 'SUNITA', '967712', '25422', '', '21,58,667.85']);
  // the lines are a statement like any other: checked against the running balance, the account found by its last 4
  const st = readStatement(tableFromLines(r.lines, r.account));
  assert.deepEqual([st.rows.length, st.checked, st.account], [4, { ok: 4, of: 4 }, { last4: '1198' }]);
  assert.deepEqual(st.rows.map((x) => [x.ref, x.debit, x.credit]), [['', 0, 4_000_000], ['967712', 2_542_200, 0], ['967708', 1_800_000, 0], ['', 590, 0]]);
  await assert.rejects(docsumoResult('../etc'), /isn’t known/);
});

test('DOCSUMO_DOC_TYPE picks the type; other files, locked PDFs, a refused key and a busy service get a plain message', async () => {
  process.env.DOCSUMO_DOC_TYPE = 'us_bank_statement';
  setDocsumoFetch(fakeDocsumo({ '/upload/': UPLOADED }));
  calls.length = 0;
  await startDocsumo(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]), 'scan.jpg');
  assert.deepEqual([calls.length, calls[0].init.body.get('type'), calls[0].init.body.get('file').type], [1, 'us_bank_statement', 'image/jpeg']);
  delete process.env.DOCSUMO_DOC_TYPE;
  await assert.rejects(startDocsumo(Buffer.from('Date,Narration\n1,2')), /reads a PDF, or a photo/);
  await assert.rejects(startDocsumo(Buffer.from('%PDF-1.4 /Encrypt 5 0 R')), /locked with a password/);
  setDocsumoFetch(fakeDocsumo({ '/limit/': TYPES, '/upload/': res(401, { error: 'token is invalid' }) }));
  await assert.rejects(startDocsumo(pdf), (e) => e.code === 'docsumo_not_configured' && /refused/.test(e.message));
  setDocsumoFetch(fakeDocsumo({ '/limit/': TYPES, '/upload/': res(429, {}) }));
  await assert.rejects(startDocsumo(pdf), (e) => e.status === 429);
  setDocsumoFetch(fakeDocsumo({ '/limit/': TYPES, '/upload/': res(400, { error: 'Only .jpg, .jpeg, .png, .tiff, .pdf, and .tif file types are allowed.' }) }));
  await assert.rejects(startDocsumo(pdf), /couldn’t take this file: Only \.jpg/);
  setDocsumoFetch(fakeDocsumo({ '/limit/': res(200, { data: { document_types: [{ title: 'Invoice', value: 'invoice' }] } }) }));
  await assert.rejects(startDocsumo(pdf), /no bank statement document type/);
  setDocsumoFetch(async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(startDocsumo(pdf), (e) => e.status === 502);
});

test('Docsumo’s tables in other shapes: one Amount column with Dr / Cr, signed amounts, loose headings; no table → a plain message', () => {
  const drcr = linesFromDocsumo({ 'Line Items': [row({ Date: '01-10-2026', Particulars: 'RENT', Amount: '5,000.00', 'Dr/Cr': 'DR', Balance: '95,000.00' }), row({ Date: '02-10-2026', Particulars: 'SALE', Amount: '700.00', 'Dr/Cr': 'CR', Balance: '95,700.00' })] });
  assert.deepEqual(drcr.lines.slice(1).map((l) => [l[3], l[4]]), [['5,000.00', ''], ['', '700.00']]);
  const signed = linesFromDocsumo({ table: [row({ 'Txn Date': '01-10-2026', Narration: 'RENT', Amount: '-5,000.00', 'Closing Balance': '95,000.00' }), row({ 'Txn Date': '02-10-2026', Narration: 'SALE', Amount: '700.00', 'Closing Balance': '95,700.00' })] });
  assert.deepEqual(signed.lines.slice(1).map((l) => [l[3], l[4], l[5]]), [['5,000.00', '', '95,000.00'], ['', '700.00', '95,700.00']]);
  const loose = linesFromDocsumo({ txns: [row({ 'Posting Date (DD/MM)': '01-10-2026', 'Value Date': '30-09-2026', 'Transaction Details': 'RENT', 'Withdrawals (INR)': '5,000.00', 'Deposits (INR)': '', 'Running Bal': '95,000.00' })], 'A/C No.': cell('123456785555') });
  assert.deepEqual(loose.lines[1], ['2026-10-01', 'RENT', '', '5,000.00', '', '95,000.00']);
  assert.equal(loose.account, '123456785555');
  assert.throws(() => linesFromDocsumo({ 'Basic Information': { 'Invoice Number': cell('2020') } }), (e) => e.code === 'docsumo_unreadable');
});

test('Docsumo’s answer in other forms: plain values, a headers + rows table, US-style dates, Money Out / Money In, a Type column', () => {
  // plain values (no { value }), month-first dates (told apart by a day over 12), "Money Out" / "Money In"
  const us = linesFromDocsumo({ account_number: 'XXXX1198', transactions: [
    { 'Txn Date': '10/09/2026', Details: 'RENT', 'Money Out': '5,000.00', 'Money In': '', 'Closing Balance': '95,000.00' },
    { 'Txn Date': '10/21/2026', Details: 'SALE', 'Money Out': '', 'Money In': '700.00', 'Closing Balance': '95,700.00' },
  ] });
  assert.deepEqual(us.lines.slice(1), [['2026-10-09', 'RENT', '', '5,000.00', '', '95,000.00'], ['2026-10-21', 'SALE', '', '', '700.00', '95,700.00']]);
  assert.equal(us.account, 'XXXX1198');
  // day-first stays day-first; when no part is over 12, the order that keeps the statement in date order wins
  assert.deepEqual(isoDates(['09/10/2026', '21/10/2026']), ['2026-10-09', '2026-10-21']);
  assert.deepEqual(isoDates(['10/02/2026', '10/05/2026', '11/01/2026']), ['2026-10-02', '2026-10-05', '2026-11-01']); // only in date order month-first
  assert.deepEqual(isoDates(['10/02/2026', '10/05/2026', '10/11/2026']), ['2026-02-10', '2026-05-10', '2026-11-10']); // in order either way: day-first, as Indian banks write it
  assert.deepEqual(isoDates(['02/10/2026', '05/10/2026', '11/10/2026']), ['2026-10-02', '2026-10-05', '2026-10-11']); // day-first
  assert.deepEqual(isoDates(['21 Oct 2026', '']), ['21 Oct 2026', '']);
  // a table given as headings and rows; one Amount column with a Type of Debit / Credit / Withdrawal
  const grid = linesFromDocsumo({ Statement: { headers: ['Date', 'Description', 'Amount', 'Type', 'Balance'], rows: [
    ['01-10-2026', 'RENT', '5,000.00', 'Withdrawal', '95,000.00'], ['02-10-2026', 'SALE', '700.00', 'Credit', '95,700.00'], ['03-10-2026', 'FEE', '10.00', 'Debit', '95,690.00']] } });
  assert.deepEqual(grid.lines.slice(1).map((l) => [l[3], l[4]]), [['5,000.00', ''], ['', '700.00'], ['10.00', '']]);
  // nothing usable: the message says what Docsumo sent, so it can be looked into
  assert.throws(() => linesFromDocsumo({ 'Basic Information': { Bank: cell('IDBI') }, Summary: [row({ Month: 'Oct', Total: 5 })] }),
    (e) => e.code === 'docsumo_unreadable' && /Docsumo returned: Basic Information; Summary \(1 rows: Month, Total\)/.test(e.message));
});

test('still reading: a 202, an empty answer or a “processing” status all wait; a failed one says so', async () => {
  process.env.DOCSUMO_API_KEY = 'test-key';
  for (const answer of [res(202, {}), res(200, { data: {}, meta_data: { status: 'reviewing' } }), res(200, { data: statement('21/10/2026'), meta_data: { status: 'processing' } })]) {
    setDocsumoFetch(fakeDocsumo({ '/data/simplified/': answer }));
    assert.deepEqual(await docsumoResult('d1'), { ready: false });
  }
  setDocsumoFetch(fakeDocsumo({ '/data/simplified/': res(200, { data: {}, meta_data: { status: 'erred' } }) }));
  await assert.rejects(docsumoResult('d1'), /marked it as failed/);
  setDocsumoFetch(fakeDocsumo({ '/data/simplified/': res(200, { data: statement('21/10/2026'), meta_data: { status: 'reviewing' } }) }));
  assert.equal((await docsumoResult('d1')).lines.length, 6);
});

test('the bank-statement type: an Indian / general one before a US one; from the enabled types if the first list has none; else names what there is', async () => {
  const pick = async (routes) => { setDocsumoFetch(fakeDocsumo(routes)); return statementType(); };
  assert.equal(await pick({ '/limit/': res(200, { data: { document_types: [{ title: 'US Bank Statement', value: 'us_bank_statement' }, { title: 'Bank Statement', value: 'bank_statement_v2' }] } }) }), 'bank_statement_v2');
  assert.equal(await pick({ '/limit/': res(200, { data: { document_types: [{ title: 'Invoice', value: 'invoice' }] } }),
    'https://app.docsumo.com/api/v1/mew/documents/types/': res(200, { data: { document: [{ title: 'Bank Statements India', doc_type: 'in_bank_statement' }] } }) }), 'in_bank_statement');
  await assert.rejects(pick({ '/limit/': res(404, {}), 'https://app.docsumo.com/api/v1/mew/documents/types/': res(200, { data: { document: [{ title: 'Invoice', doc_type: 'invoice' }] } }) }),
    /no bank statement document type \(it has: Invoice\)/);
  process.env.DOCSUMO_DOC_TYPE = ' my_statements ';
  assert.equal(await pick({}), 'my_statements');
  delete process.env.DOCSUMO_DOC_TYPE;
});

// ── the API ──
const pool = pglitePool();
setPool(pool);
process.env.SESSION_SECRET = 'x'.repeat(40);
const { handler } = await import('../server/index.js');
const server = http.createServer(handler).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); pool.end(); });
const session = () => {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
};
const admin = session(), editor = session(), viewer = session();
const today = todayIST(), yday = addDays(today, -1), dmy = (d) => d.split('-').reverse().join('/');

test('API: the app says when it can’t read a statement itself; only then is Docsumo used, and its lines are checked and applied', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'v@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'v@x.in', password: 'viewerpass12' });
  const bank = (await admin('/api/banks', { name: 'IDBI Current', bank: 'IDBI Bank', last4: '1198' })).body.id;
  const geeta = (await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Geeta Shah', amount: '18,000', date: yday, category: 'Vendor', bank_id: bank })).body.id;
  const body = { file: pdf.toString('base64'), name: 'IDBI Oct.pdf' };

  // the app's own reader can't read this PDF: it says so (that is when Docsumo is offered)
  const own = await editor('/api/reconcile/check', { ...body, bank_id: bank });
  assert.deepEqual([own.status, own.body.error.detail], [400, { unreadable: true }]);
  // a statement it can read, or a mistake that isn't about reading, isn't "unreadable"
  const csv = `Date,Narration,Chq No,Withdrawal,Deposit,Balance\n${dmy(yday)},NEFT GEETA,967708,"18,000.00",,"1,00,000.00"\n`;
  const ok = await editor('/api/reconcile/check', { file: Buffer.from(csv).toString('base64'), name: 's.csv', bank_id: bank });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.docsumo, ok.body.ai], [false, false]);
  const later = csv.replace(dmy(yday), dmy(addDays(today, 3)));
  assert.equal((await editor('/api/reconcile/check', { file: Buffer.from(later).toString('base64'), name: 's.csv', bank_id: bank })).body.error.detail, undefined);

  delete process.env.DOCSUMO_API_KEY;
  assert.equal((await editor('/api/state')).body.docsumo, false);
  assert.equal((await editor('/api/reconcile/docsumo-read', body)).body.error.code, 'docsumo_not_configured');

  process.env.DOCSUMO_API_KEY = 'test-key'; // only switches the feature on: the stand-in answers
  let polls = 0;
  setDocsumoFetch(fakeDocsumo({ '/limit/': TYPES, '/upload/': UPLOADED, '/data/simplified/abc123/': () => (++polls < 2 ? res(202, {}) : res(200, { data: statement(dmy(yday)) })) }));
  assert.equal((await editor('/api/state')).body.docsumo, true);
  assert.equal((await viewer('/api/reconcile/docsumo-read', body)).status, 403);
  const start = await editor('/api/reconcile/docsumo-read', body);
  assert.deepEqual([start.status, start.body], [200, { docId: 'abc123' }]);
  assert.deepEqual((await editor('/api/reconcile/docsumo-result', { docId: 'abc123', name: body.name })).body, { ready: false });
  const r = await editor('/api/reconcile/docsumo-result', { docId: 'abc123', name: body.name });
  assert.deepEqual([r.status, r.body.ready, r.body.lines.length, r.body.account], [200, true, 6, 'XXXXXXXX1198']);

  // checked like any other statement: the account found from its last 4 digits, the lines balance, Geeta matched
  const sent = { ...body, lines: r.body.lines, account: r.body.account, reader: 'docsumo' };
  const check = await editor('/api/reconcile/check', sent);
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual([check.body.docsumo, check.body.ai, check.body.ocr, check.body.checked, check.body.bank.id, check.body.account.by], [true, false, false, { ok: 4, of: 4 }, bank, 'statement']);
  const line = check.body.debits.find((d) => d.match?.id === geeta);
  assert.ok(line, 'GEETA HHAH matched to Geeta Shah');
  const apply = await editor('/api/reconcile/apply', { ...sent, matches: [{ row: line.row, id: geeta }] });
  assert.deepEqual([apply.status, apply.body.paid, apply.body.paidAmount], [200, 1, 1_800_000]);

  const log = (await admin('/api/activity?type=reports')).body.activity.find((a) => a.action === 'reconcile.docsumo_read');
  assert.deepEqual([log.user_name, log.detail.file, log.detail.doc, log.detail.lines], ['Eli', 'IDBI Oct.pdf', 'abc123', 5]);
});
