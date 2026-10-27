import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { readTable, importRows, parseDate } from '../server/sheet.js';
import { toXlsx } from '../server/export.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const banks = [{ id: 1, name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' }, { id: 2, name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222' }];
const rowsOf = (buf, name, opts = {}) => importRows(readTable(buf, name), { kind: 'OUT', banks, today: '2026-10-21', ...opts });
const csv = (text) => Buffer.from(text, 'utf8');

// ── reading sheets (both files were written by Microsoft Excel itself) ──
test('an Excel workbook: title rows above the headings, date cells, a SUM total row, and rows with problems', () => {
  const x = rowsOf(fixture('excel-payables.xlsx'), 'excel-payables.xlsx');
  assert.equal(x.headerRow, 3);
  assert.deepEqual(x.columns, { name: 'Vendor Name', amount: 'Amount (Rs.)', date: 'Due Date', ref: 'Bill No', note: 'Remarks', bank: 'Bank' });
  assert.deepEqual(x.rows.map((r) => [r.row, r.name, r.amount, r.date, r.bank_id, r.problems.length]), [
    [4, 'Steel Co', 12_500_000, '2026-10-25', 1, 0], // the due date, not the bill date; "HDFC" → the HDFC account
    [5, 'Office rent', 4_500_050, '2026-11-01', null, 0],
    [6, 'Sharma & Sons', 0, '2026-10-30', null, 1], // no amount
    [7, 'Gupta Transport', 820_000, '2026-10-21', null, 0], // no due date → today, with a note
    [8, 'Kumar Packaging', 310_000, null, null, 1], // "soon"
  ]); // the Total row is left out
  assert.deepEqual(x.rows[3].notes, ['no date — due today']);
  assert.match(x.rows[4].problems[0], /Date “soon” not understood/);
  assert.ok(x.rows.every((r) => r.kind === 'OUT' && r.category === 'Other'));
});

test('the same sheet saved by Excel as CSV reads the same (Indian 1,25,000.00 amounts, dd-mm-yyyy dates)', () => {
  const a = rowsOf(fixture('excel-payables.xlsx'), 'a.xlsx').rows, b = rowsOf(fixture('excel-payables.csv'), 'a.csv').rows;
  assert.deepEqual(b, a);
});

test('a Type column, or separate Payment / Receipt (Debit / Credit) columns, decide receipt or payment', () => {
  let r = rowsOf(csv('Type,Party,Amount,Date,Category\nPayment,Steel Co,500,21/10/2026,vendor\nReceipt,Mehta Retail,"₹ 1,200.50",22-Oct-2026,\nDr,Tax office,99,2026-10-23,GST\nfoo,X,1,21/10/2026,\n'), 'x.csv').rows;
  assert.deepEqual(r.map((x) => [x.kind, x.name, x.amount, x.date, x.category]), [
    ['OUT', 'Steel Co', 50_000, '2026-10-21', 'Vendor'], ['IN', 'Mehta Retail', 120_050, '2026-10-22', ''],
    ['OUT', 'Tax office', 9_900, '2026-10-23', 'Other'], ['OUT', 'X', 100, '2026-10-21', 'Other']]);
  assert.match(r[3].problems[0], /Type “foo”/);
  assert.deepEqual(r[2].notes, ['category “GST” → Other']);

  r = rowsOf(csv('Particulars;Debit;Credit;Due on\nRent;45000;;01.11.2026\nMehta Retail;;80000;28.10.2026\nBoth;1;2;28.10.2026\n'), 'x.csv', { kind: 'IN' }).rows;
  assert.deepEqual(r.map((x) => [x.kind, x.name, x.amount, x.date]), [['OUT', 'Rent', 4_500_000, '2026-11-01'], ['IN', 'Mehta Retail', 8_000_000, '2026-10-28'], ['IN', 'Both', 0, '2026-10-28']]);
  assert.match(r[2].problems[0], /Both a payment and a receipt/);
  // without a type, the choice made on the upload screen
  assert.equal(rowsOf(csv('Name,Amount\nA,1\n'), 'x.csv', { kind: 'IN' }).rows[0].kind, 'IN');
});

test('an Account No. column puts each row in the account with those last 4 digits', () => {
  const two = [...banks, { id: 3, name: 'SBI Current', bank: 'State Bank of India', last4: '1111' }];
  const r = rowsOf(csv('Name,Amount,Bank,Account No.\nA,10,,50200012342222\nB,10,HDFC,XXXXXXXX1111\nC,10,SBI,1111\nD,10,,1111\nE,10,ICICI,9999\nF,10,,12\nG,10,HDFC,\n'), 'x.csv', { banks: two }).rows;
  assert.deepEqual(r.map((x) => [x.name, x.bank_id, x.problems[0] ?? '', x.notes.at(-1)]), [
    ['A', 2, '', 'no date — due today'], // the number alone decides
    ['B', 1, '', 'no date — due today'], ['C', 3, '', 'no date — due today'], // two accounts end in 1111: the bank tells them apart
    ['D', null, '', '2 accounts end in 1111 — write the bank too; left as “Not decided”'],
    ['E', null, '', 'bank account XXXX9999 not found — left as “Not decided”'], // the number wins over the bank's name
    ['F', null, 'Account number “12”: needs at least its last 4 digits', 'no date — due today'],
    ['G', 1, '', 'no date — due today']]); // no number: by the bank, as before
  // an account number Excel stored as a number: exact up to 15 digits; longer ones it can't keep
  const x = importRows({ rows: [{ n: 1, cells: ['Name', 'Amount', 'A/c No'] }, { n: 2, cells: ['A', 10, 50200012342222] }, { n: 3, cells: ['B', 10, 12345678901234567890] }] }, { kind: 'OUT', banks, today: '2026-10-21' });
  assert.deepEqual(x.columns, { name: 'Name', amount: 'Amount', acct: 'A/c No' });
  assert.deepEqual(x.rows.map((y) => [y.bank_id, y.problems.length]), [[2, 0], [null, 1]]);
  assert.match(x.rows[1].problems[0], /too long for Excel/);
});

test('amounts, names and banks: what is a problem and what is only noted', () => {
  const r = rowsOf(csv('Name,Amount,Bank account\nA,-5,\nB,0,\nC,abc,\n,100,\nD,(250),\nE,"1,000 Dr",XXXX2222\nF,10,SBI\nG,10,icici\nGrand Total,111,\n'), 'x.csv').rows;
  assert.deepEqual(r.map((x) => [x.name, x.problems[0] ?? '', x.bank_id]), [
    ['A', 'Amount is negative', null], ['B', 'Amount is zero', null], ['C', 'Amount: “abc” isn’t an amount', null], ['', 'No name', null],
    ['D', 'Amount is negative', null], ['E', '', 2], ['F', '', null], ['G', '', 2]]);
  assert.deepEqual(r[6].notes, ['no date — due today', 'bank account “SBI” not found — left as “Not decided”']);
});

test('dates as written in India, and Excel day numbers', () => {
  for (const [v, want] of [['21/10/2026', '2026-10-21'], ['1-2-26', '2026-02-01'], ['21.10.2026', '2026-10-21'], ['2026-10-21', '2026-10-21'], ['21-Oct-2026', '2026-10-21'],
    ['21 October 2026', '2026-10-21'], ['Oct 21, 2026', '2026-10-21'], ['21st Oct 2026', '2026-10-21'], ['21/10/2026 10:30', '2026-10-21'], [46316, '2026-10-21'], ['46316', '2026-10-21'],
    ['31/02/2026', null], ['13/13/2026', null], ['next week', null], [12, null]]) assert.equal(parseDate(v), want, String(v));
  assert.equal(parseDate(44854, true), '2026-10-21'); // a workbook using the 1904 date system
});

test('files that can’t be read get a clear message', () => {
  const msg = (buf, name) => { try { rowsOf(buf, name); return 'no error'; } catch (e) { return e.message; } };
  assert.match(msg(csv('Hello,World\n1,2\n'), 'x.csv'), /No heading row found/);
  assert.match(msg(Buffer.from('d0cf11e0a1b11ae100000000', 'hex'), 'old.xls'), /old Excel file \(\.xls\)/);
  assert.match(msg(csv('not really'), 'x.xlsx'), /couldn’t be read as an Excel workbook/);
  assert.match(msg(Buffer.alloc(0), 'x.csv'), /empty/);
  assert.match(msg(Buffer.alloc(3 * 1024 * 1024 + 1, 65), 'x.csv'), /too big/);
  assert.match(msg(csv('Name,Amount\n' + 'A,1\n'.repeat(2001)), 'x.csv'), /at most 2000/);
  // plain "CSV" from Excel is the Windows code page, not UTF-8
  assert.equal(rowsOf(Buffer.from('Name,Amount\nCafé Noël,10\n', 'latin1'), 'x.csv').rows[0].name, 'Café Noël');
});

test('our own Excel export format reads back too', () => {
  const r = rowsOf(toXlsx([['Name', 'Amount', 'Due date'], ['A & B <Ltd>', 1234.56, '25/10/2026']]), 'x.xlsx').rows;
  assert.deepEqual([r[0].name, r[0].amount, r[0].date], ['A & B <Ltd>', 123_456, '2026-10-25']);
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
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
};
const admin = session(), editor = session(), viewer = session();
const today = todayIST(), soon = addDays(today, 5), later = addDays(today, 20);
const dmy = (d) => d.split('-').reverse().join('/');
const sheet = csv(`Type,Name,Amount,Due date,Bill no.,Description,Category,Bank\nPayment,Steel Co,"1,25,000",${dmy(soon)},BILL-1,October steel,Vendor,HDFC\nPayment,Landlord,45000,${dmy(later)},,Rent,Rent,\nReceipt,Mehta Retail,80000,${dmy(soon)},INV-9,,,\nPayment,Broken,,${dmy(soon)},,,,\n`);
const upload = (who, extra = {}, buf = sheet) => who(`/api/import/${extra.add ? 'add' : 'check'}`, { file: buf.toString('base64'), name: 'october.csv', kind: 'OUT', ...extra });
let hdfc;

test('API setup', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'v@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'v@x.in', password: 'viewerpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' })).body.id;
  await editor('/api/balances', { bank_id: hdfc, amount: '5,00,000', as_of: addDays(today, -1) });
});

const records = async (qs) => (await editor(`/api/transactions?view=records&from=${addDays(today, -40)}&to=${addDays(today, 40)}&${qs}`)).body.rows;

test('check: says what each row will become, and saves nothing', async () => {
  const r = await upload(editor);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows.map((x) => [x.row, x.kind, x.name, x.status, x.bank_id]), [
    [2, 'OUT', 'Steel Co', 'ok', hdfc], [3, 'OUT', 'Landlord', 'ok', null], [4, 'IN', 'Mehta Retail', 'ok', null], [5, 'OUT', 'Broken', 'problem', null]]);
  assert.equal((await records('')).length, 0);
});

test('add: the good rows become payments yet to be paid / receipts yet to be received — balances don’t move', async () => {
  const before = (await editor('/api/transactions/summary')).body.total.closing;
  const r = await upload(editor, { add: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { added: 3, receipts: 1, payments: 2, skipped: 1, from: soon, to: later });
  const rows = await records('status=pending');
  assert.deepEqual(rows.map((x) => [x.kind, x.name, x.amount, x.date, x.state, x.bank_id, x.recorded_by]).sort(), [
    ['IN', 'Mehta Retail', 8_000_000, soon, 'pending', null, 'Eli'], ['OUT', 'Landlord', 4_500_000, later, 'pending', null, 'Eli'], ['OUT', 'Steel Co', 12_500_000, soon, 'pending', hdfc, 'Eli']]);
  const steel = rows.find((x) => x.name === 'Steel Co');
  assert.deepEqual([steel.ref, steel.note, steel.category], ['BILL-1', 'October steel', 'Vendor']);
  assert.equal((await editor('/api/transactions/summary')).body.total.closing, before);
  // an editor's payments wait for an admin's approval, as when added by hand
  const { rows: pays } = await pool.query("SELECT payee, approved FROM payments ORDER BY id");
  assert.ok(pays.every((p) => p.approved === false));
  // the Excel export says "Yet to be paid" / "Yet to be received"
  const out = (await editor(`/api/transactions/export?view=records&format=csv&from=${today}&to=${later}`)).body.toString('utf8');
  assert.match(out, /Steel Co,125000,0,125000,Yet to be paid,/);
  assert.match(out, /Mehta Retail,80000,0,80000,Yet to be received,/);
  // and they can be paid like any other
  assert.equal((await editor(`/api/payments/${steel.id}/settle`, { bank_id: hdfc, ref: 'UTR-555', date: today })).status, 200);
  assert.equal((await records('status=completed'))[0].name, 'Steel Co');
});

test('uploading the same sheet again adds nothing twice', async () => {
  const c = (await upload(editor)).body.rows;
  assert.deepEqual(c.map((x) => x.status), ['duplicate', 'duplicate', 'duplicate', 'problem']);
  assert.match(c[0].duplicate, /Already in the app/);
  const r = await upload(editor, { add: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /Nothing to add/);
  // a new sheet: one repeat of an open invoice number, one row twice in the sheet, one new
  const next = csv(`Name,Amount,Due date,Invoice no\nMehta Retail,1,${dmy(soon)},inv 9\nNew Co,10,${dmy(soon)},\nNew Co,10,${dmy(soon)},\nOther Co,20,${dmy(soon)},\n`);
  const c2 = (await upload(editor, { kind: 'IN' }, next)).body.rows;
  assert.deepEqual(c2.map((x) => [x.status, x.duplicate ?? '']), [['duplicate', 'Invoice / bill no. “inv 9” is already in the app'], ['ok', ''], ['duplicate', 'Same as row 3 of this sheet'], ['ok', '']]);
  assert.equal((await upload(editor, { kind: 'IN', add: true }, next)).body.added, 2);
  // unless asked to add those too
  assert.equal((await upload(admin, { kind: 'IN', add: true, includeDuplicates: true }, next)).body.added, 4);
});

test('an admin’s uploaded payments count as approved; viewers can’t upload; it is in the activity log', async () => {
  const s = csv(`Name,Amount,Due date\nAdmin Co,10,${dmy(soon)}\n`);
  assert.equal((await upload(viewer, {}, s)).status, 403);
  assert.equal((await upload(viewer, { add: true }, s)).status, 403);
  assert.equal((await upload(admin, { add: true }, s)).status, 200);
  assert.equal((await pool.query("SELECT approved FROM payments WHERE payee = 'Admin Co'")).rows[0].approved, true);
  const log = (await admin('/api/activity?type=reports')).body.activity.filter((a) => a.action === 'import.add');
  assert.equal(log.length, 4);
  assert.deepEqual([log.at(-1).user_name, log.at(-1).detail.file, log.at(-1).detail.added, log.at(-1).detail.paymentAmount], ['Eli', 'october.csv', 3, 17_000_000]);
});

test('bad uploads: no file, not base64, too big, and the sample sheet reads back', async () => {
  assert.match((await editor('/api/import/check', { name: 'x.csv' })).body.error.message, /Choose an Excel/);
  assert.match((await editor('/api/import/check', { file: '%%%', name: 'x.csv' })).body.error.message, /Choose an Excel/);
  assert.equal((await editor('/api/import/check', { file: 'A'.repeat(4_500_000), name: 'x.csv' })).status, 413);
  assert.equal((await editor('/api/import/check', { file: 'x', kind: 'BOTH' })).status, 400);
  const sample = await viewer('/api/import/sample');
  assert.equal(sample.status, 200);
  const r = (await upload(editor, {}, sample.body)).body;
  // every sample row reads without a problem ("duplicate" is possible: on some days a row added above has the same date)
  assert.deepEqual(r.rows.map((x) => [x.kind, x.name, x.problems.length]), [['OUT', 'Steel Co', 0], ['OUT', 'Office rent', 0], ['IN', 'Mehta Retail', 0]]);
});
