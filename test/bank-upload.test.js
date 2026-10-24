import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { readTable, bankRows } from '../server/sheet.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const csv = (text) => Buffer.from(text, 'utf8');
const rowsOf = (buf, name, banks = []) => bankRows(readTable(buf, name), { banks, today: '2026-10-24' });

// ── the server (started before any test runs) ──
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
// ── reading the sheet (the .xlsx was written by Microsoft Excel itself) ──
test('an Excel sheet of bank accounts: a title row, “A/c No.” / “As on” headings, numbers typed as text or stored as numbers', () => {
  const x = rowsOf(fixture('bank-accounts.xlsx'), 'bank-accounts.xlsx');
  assert.equal(x.headerRow, 3);
  assert.deepEqual(x.columns, { name: 'Account Name', bank: 'Bank Name', number: 'A/c No.', balance: 'Opening Balance', date: 'As on' });
  assert.deepEqual(x.rows.map((r) => [r.row, r.status, r.name, r.bank, r.last4, r.balance, r.asOf]), [
    [4, 'ok', 'HDFC Current', 'HDFC Bank', '1111', 132_805_026, '2026-09-30'],
    [5, 'ok', 'IDBI Collections', 'IDBI Bank', '2222', 18_502_431, '2026-10-22'], // the number Excel stored as a number
    [6, 'ok', 'SBI Salary', 'State Bank of India', '3333', null, null], // masked "XXXXXXXX3333", no balance
    [7, 'ok', 'Axis Bank 4444', 'Axis Bank', '4444', 0, '2026-10-22'], // no name: one is made up
    [8, 'problem', 'Broken', 'ICICI Bank', '12', null, null],
    [9, 'problem', 'Huge', 'Kotak Bank', '4568', null, null], // 17 digits: Excel already changed the last one
    [10, 'duplicate', 'HDFC Current again', 'HDFC Bank', '1111', null, null],
  ]);
  assert.match(x.rows[4].problems[0], /needs at least 4 digits/);
  assert.match(x.rows[5].problems[0], /too long for Excel to keep exactly as a number: format that column as Text/);
  assert.equal(x.rows[6].duplicate, 'Same as row 4 of this sheet');
  assert.deepEqual(x.rows[3].notes, ['no name — called “Axis Bank 4444”']);
});

test('a CSV: the accounts already in the app are “already there”; balances, dates and what isn’t understood', () => {
  const x = rowsOf(csv('Name,Bank,Account Number,Balance,Balance Date\nMain,HDFC Bank,1234567890,"5,00,000",21/10/2026\nNew SBI,SBI,99887766,100,\n'
    + 'Main,Axis Bank,5555,abc,\nOld,ICICI,4321,10,2027-01-01\nX,Kotak,5.02E+13,,\nY,Kotak,6666,10,someday\n'), 'x.csv',
  [{ id: 1, name: 'Main', bank: 'HDFC Bank', last4: '7890' }]);
  assert.deepEqual(x.rows.map((r) => [r.name, r.status, r.balance, r.asOf, r.problems[0] ?? r.duplicate ?? r.notes[0] ?? '']), [
    ['Main', 'duplicate', 50_000_000, '2026-10-21', 'Already in the app (HDFC Bank XXXX7890)'],
    ['New SBI', 'ok', 10_000, '2026-10-24', 'no balance date — as of today'],
    ['Main', 'problem', null, null, 'Opening balance: “abc” isn’t an amount'],
    ['Old', 'problem', 1000, '2027-01-01', 'Balance date is in the future'],
    ['X', 'problem', null, null, 'Account number was turned into a number by Excel (e.g. 5.02E+13): format that column as Text and type it again'],
    ['Y', 'problem', 1000, null, 'Balance date “someday” not understood — use e.g. 21/10/2026'],
  ]);
  // a different account number at a bank already in the app, under a name already used
  const y = rowsOf(csv('Name,Bank,Account Number\nMain,Axis Bank,12345\n'), 'y.csv', [{ id: 1, name: 'Main', bank: 'HDFC Bank', last4: '7890' }]);
  assert.equal(y.rows[0].duplicate, 'An account called “Main” is already in the app');
  assert.throws(() => rowsOf(csv('Name,Amount\nA,1\n'), 'z.csv'), /needs a row of column headings with at least the Bank and the Account number/);
  assert.throws(() => rowsOf(csv('Bank,Account Number\n' + 'HDFC,12345\n'.repeat(201)), 'z.csv'), /at most 200/);
});

const admin = session(), editor = session();
const today = todayIST();
const upload = (who, path, buf = fixture('bank-accounts.xlsx')) => who(`/api/import/banks/${path}`, { file: buf.toString('base64'), name: 'bank-accounts.xlsx' });

test('API: check shows each row and changes nothing; add creates the accounts with their opening balances', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  assert.equal((await upload(editor, 'check')).status, 403); // adding accounts is for admins, as one at a time
  assert.equal((await upload(editor, 'add')).status, 403);
  const c = await upload(admin, 'check');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.rows.map((r) => r.status), ['ok', 'ok', 'ok', 'ok', 'problem', 'problem', 'duplicate']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM banks')).rows[0].n, 0);

  const r = await upload(admin, 'add');
  assert.deepEqual([r.status, r.body], [200, { added: 4, balances: 3, skipped: 3 }]);
  const { rows } = await pool.query('SELECT b.name, b.bank, b.last4, l.amount, l.as_of FROM banks b LEFT JOIN balances l ON l.bank_id = b.id ORDER BY b.id');
  assert.deepEqual(rows.map((x) => [x.name, x.bank, x.last4, x.amount == null ? null : Number(x.amount), x.as_of]), [
    ['HDFC Current', 'HDFC Bank', '1111', 132_805_026, '2026-09-30'], ['IDBI Collections', 'IDBI Bank', '2222', 18_502_431, '2026-10-22'],
    ['SBI Salary', 'State Bank of India', '3333', null, null], ['Axis Bank 4444', 'Axis Bank', '4444', 0, '2026-10-22']]);
  // they are ordinary accounts: on the Banks page, with their balances
  const day = (await admin(`/api/banks/day?date=${today}`)).body;
  assert.deepEqual(day.banks.map((b) => [b.name, b.closing]), [['Axis Bank 4444', 0], ['HDFC Current', 132_805_026], ['IDBI Collections', 18_502_431], ['SBI Salary', 0]]);
});

test('API: the same sheet again adds nothing; it is in the Activity Log; the sample sheet reads back', async () => {
  const c = (await upload(admin, 'check')).body;
  assert.deepEqual(c.rows.map((r) => r.status), ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'problem', 'problem', 'duplicate']);
  assert.match((await upload(admin, 'add')).body.error.message, /Nothing to add/);
  const log = (await admin('/api/activity?type=accounts')).body.activity;
  const imp = log.find((a) => a.action === 'bank.import');
  assert.deepEqual([imp.user_name, imp.detail.file, imp.detail.added, imp.detail.balances, imp.detail.skipped], ['Asha', 'bank-accounts.xlsx', 4, 3, 3]);
  assert.equal(log.filter((a) => a.action === 'bank.add').length, 4);
  const sample = await admin('/api/import/banks/sample');
  assert.equal(sample.status, 200);
  const s = (await upload(admin, 'check', sample.body)).body;
  assert.deepEqual(s.rows.map((r) => [r.name, r.last4, r.status]), [['HDFC Current', '1111', 'duplicate'], ['IDBI Collections', '2222', 'duplicate'], ['SBI Salary', '3333', 'duplicate']]);
  assert.equal((await admin('/api/import/banks/check', { file: '%%', name: 'x.csv' })).status, 400);
  void addDays;
});
