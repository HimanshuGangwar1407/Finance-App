// Fixes from the pre-launch check: each test below failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';
import { bankRows } from '../server/sheet.js';
import { readStatement } from '../server/reconcile.js';

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
const admin = session(), editor = session();
const today = todayIST(), dmy = (d) => d.split('-').reverse().join('/');
const csv = (t) => Buffer.from(t, 'utf8');
const balanceOf = async (id) => (await editor('/api/position')).body.rows.find((r) => r.id === id).today;
let hdfc, icici;

test('setup', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' })).body.id;
  icici = (await admin('/api/banks', { name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222' })).body.id;
  for (const id of [hdfc, icici]) await admin('/api/balances', { bank_id: id, amount: '1,00,000', as_of: addDays(today, -5) });
});

test('deleting an account keeps an EMI instalment that was paid from another account (that account’s balance doesn’t change)', async () => {
  const sbi = (await admin('/api/banks', { name: 'SBI Loans', bank: 'SBI', last4: '3333' })).body.id;
  await admin('/api/emis', { lender: 'Truck loan', amount: '5,000', bank_id: sbi, start_date: today });
  const inst = (await pool.query("SELECT p.id FROM payments p JOIN emis e ON e.id = p.emi_id WHERE e.lender = 'Truck loan' AND p.due_date = $1", [today])).rows[0].id;
  const r = await editor(`/api/payments/${inst}/settle`, { bank_id: icici, ref: 'UTR-TRUCK-1', date: today, confirmShortfall: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const before = await balanceOf(icici);
  assert.equal(before, 10_000_000 - 500_000);
  assert.equal((await admin(`/api/banks/${sbi}/delete`, { confirm: 'SBI Loans' })).status, 200);
  assert.equal(await balanceOf(icici), before); // ICICI's ₹5,000 payment is still there
  const { rows: [p] } = await pool.query('SELECT emi_id, payee FROM payments WHERE id = $1', [inst]);
  assert.deepEqual(p, { emi_id: null, payee: 'Truck loan' });
});

test('a statement line with no reference of its own: next month’s same charge is a new line, and can be recorded', async () => {
  const stmt = (date, amount) => ({ name: 'hdfc.csv', file: csv(`Account No : 50200012341111\nDate,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n${dmy(date)},SMS ALERT CHARGES,000000000000,${amount},,99000.00\n`).toString('base64') });
  const m1 = stmt(addDays(today, -31), '17.70'), m2 = stmt(today, '29.50');
  let d = (await editor('/api/reconcile/check', m1)).body;
  assert.equal((await editor('/api/reconcile/apply', { ...m1, record: [{ row: d.debits[0].row, payee: 'Bank charges' }] })).status, 200);
  d = (await editor('/api/reconcile/check', m2)).body;
  assert.equal(d.debits[0].recorded, null); // not “already in the app”
  const r = await editor('/api/reconcile/apply', { ...m2, record: [{ row: d.debits[0].row, payee: 'Bank charges' }] });
  assert.deepEqual([r.status, r.body.recorded], [200, 1]);
  assert.ok((await editor('/api/reconcile/check', m1)).body.debits[0].recorded); // month 1 again: still recognised
  // two dates whose digits are the same once leading zeros go (11 Jan / 1 Nov) don't clash either
  const a = (await editor('/api/reconcile/check', { name: 'x.csv', file: csv(`Account No : 1111\nDate,Narration,Withdrawal Amt.,Deposit Amt.\n11/01/2026,,5.00,\n01/11/2025,,5.00,\n`).toString('base64') })).body;
  assert.notEqual(a.debits[0].bankRef.replace(/\D/g, ''), a.debits[1].bankRef.replace(/\D/g, ''));
});

test('marking a payment paid by hand can’t skip the EMI reserve by claiming to come from a statement', async () => {
  await admin('/api/emis', { lender: 'Car loan', amount: '90,000', bank_id: hdfc, start_date: addDays(today, 1), hold_days: 7 });
  const id = (await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Vendor X', amount: '50,000', date: today, category: 'Vendor', bank_id: hdfc })).body.id;
  const r = await editor(`/api/payments/${id}/settle`, { ref: 'UTR-X', date: today, fromStatement: true });
  assert.equal(r.body.error?.code, 'emi_hold');
});

test('the activity filter refuses a made-up type instead of failing', async () => {
  for (const type of ['constructor', 'toString', '__proto__']) assert.equal((await admin(`/api/activity?type=${type}`)).status, 400, type);
});

test('a huge amount stored as a number in a sheet is a problem on its row (not a server error)', () => {
  const x = bankRows({ rows: [{ n: 1, cells: ['Bank', 'Account number', 'Opening balance'] }, { n: 2, cells: ['HDFC', 'XXXX9999', 1e20] }] }, { banks: [], today });
  assert.match(x.rows[0].problems[0], /too large/);
  const st = readStatement({ rows: [{ n: 1, cells: ['Date', 'Narration', 'Withdrawal Amt.', 'Closing Balance'] }, { n: 2, cells: ['21/10/2026', 'A', 1e20, 5] }, { n: 3, cells: ['22/10/2026', 'B', 5, 0] }] });
  assert.deepEqual(st.skipped, [{ row: 2, why: 'amount not understood' }]);
});

test('receipts & payments: “yet to be paid” includes partly paid; a period up to today also lists what is due later', async () => {
  const later = addDays(today, 10), first = `${today.slice(0, 8)}01`;
  await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Next Week Co', amount: '1,000', date: later, category: 'Vendor', bank_id: icici });
  const part = (await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Part Paid Co', amount: '2,000', date: today, category: 'Vendor', bank_id: icici })).body.id;
  await editor(`/api/payments/${part}/settle`, { amount: '500', ref: 'UTR-PART', date: today, bank_id: icici });
  const list = async (qs) => (await editor(`/api/transactions?view=records&from=${first}&to=${today}&${qs}`)).body.rows.map((r) => r.name);
  const pending = await list('status=pending');
  assert.ok(pending.includes('Next Week Co') && pending.includes('Part Paid Co'), JSON.stringify(pending));
  assert.ok((await list('status=partial')).includes('Part Paid Co'));
  assert.ok(!(await list('status=completed')).includes('Next Week Co'));
  // a period that ended in the past stays as it was
  assert.ok(!(await editor(`/api/transactions?view=records&from=${addDays(today, -60)}&to=${addDays(today, -40)}`)).body.rows.some((r) => r.name === 'Next Week Co'));
  // the pending banner counts the same ones
  const s = (await editor(`/api/transactions/summary?from=${first}&to=${today}&bank=${icici}`)).body.pending.OUT;
  assert.ok(s.count >= 2 && s.amount >= 100_000 + 150_000, JSON.stringify(s));
});
