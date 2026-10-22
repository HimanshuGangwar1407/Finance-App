import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

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
const today = todayIST(), from = addDays(today, -40), to = addDays(today, 40);
const count = async (sql, args = []) => (await pool.query(sql, args)).rows[0].n;
const records = async () => (await admin(`/api/transactions?view=records&from=${from}&to=${to}`)).body.rows;
const closing = async (bank) => (await admin(`/api/transactions/summary?from=${from}&to=${today}${bank ? `&bank=${bank}` : ''}`)).body.total.closing;
const find = async (name) => (await records()).find((r) => r.name === name);
let hdfc, icici;

test('setup: users, two banks with balances', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'v@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'v@x.in', password: 'viewerpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' })).body.id;
  icici = (await admin('/api/banks', { name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222' })).body.id;
  await admin('/api/balances', { bank_id: hdfc, amount: '1,00,000', as_of: addDays(from, -1) });
  await admin('/api/balances', { bank_id: icici, amount: '50,000', as_of: addDays(from, -1) });
});

// ── receipts and payments ──
test('deleting a pending payment removes it; balances don’t change', async () => {
  await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Landlord', amount: '15,000', date: addDays(today, 5), category: 'Rent' });
  const before = await closing(), p = await find('Landlord');
  assert.equal((await admin(`/api/payments/${p.id}/delete`, {})).status, 200);
  assert.equal(await find('Landlord'), undefined);
  assert.equal(await closing(), before);
  assert.equal((await admin(`/api/payments/${p.id}/delete`, {})).status, 404); // already gone
});

test('deleting a received receipt takes its money out of the bank balance too', async () => {
  await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'Mehta Retail', amount: '25,000', date: today, bank_id: hdfc, bank_ref: 'UTR-1' });
  assert.equal(await closing(hdfc), 12_500_000);
  const r = await find('Mehta Retail');
  const res = await admin(`/api/receipts/${r.id}/delete`, {});
  assert.deepEqual(res.body, { deleted: r.id, settled: 2_500_000 });
  assert.equal(await closing(hdfc), 10_000_000);
  assert.equal(await count('SELECT count(*)::int AS n FROM entries WHERE receipt_id = $1', [r.id]), 0);
  // the same bank reference can be used again now
  assert.equal((await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'Mehta Retail', amount: '1', date: today, bank_id: hdfc, bank_ref: 'UTR-1' })).status, 200);
  const log = (await admin('/api/activity?type=receipts')).body.activity.find((a) => a.action === 'receipt.delete');
  assert.deepEqual([log.user_name, log.detail.party, log.detail.amount, log.detail.settled, log.detail.entries[0].ref], ['Asha', 'Mehta Retail', 2_500_000, 2_500_000, 'UTR-1']);
});

test('only admins delete; EMI instalments can’t be deleted (they would come back)', async () => {
  await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Steel Co', amount: '500', date: today, category: 'Vendor' });
  const p = await find('Steel Co');
  assert.equal((await editor(`/api/payments/${p.id}/delete`, {})).status, 403);
  assert.equal((await viewer(`/api/payments/${p.id}/delete`, {})).status, 403);
  assert.ok(await find('Steel Co'));
  await admin('/api/emis', { lender: 'Car loan', amount: '5,000', bank_id: hdfc, start_date: today });
  const emi = (await records()).find((r) => r.emi);
  const res = await admin(`/api/payments/${emi.id}/delete`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /EMI instalment.*Cancel it instead/);
});

// ── bank accounts ──
test('deleting a bank account: what it would remove is shown first', async () => {
  // on ICICI: a receipt received, a payment paid half from ICICI and half from HDFC, a pending payment, an EMI with one instalment paid
  await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'Kumar Traders', amount: '10,000', date: today, bank_id: icici, bank_ref: 'UTR-K' });
  await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Split Co', amount: '2,000', date: today, bank_id: icici, category: 'Vendor' });
  const split = await find('Split Co');
  await editor(`/api/payments/${split.id}/settle`, { bank_id: icici, ref: 'S-1', amount: '1,000', date: today });
  await editor(`/api/payments/${split.id}/settle`, { bank_id: hdfc, ref: 'S-2', amount: '1,000', date: today });
  await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Later Co', amount: '700', date: addDays(today, 3), bank_id: icici, category: 'Vendor' });
  await admin('/api/emis', { lender: 'Home loan', amount: '3,000', bank_id: icici, start_date: today });
  const inst = (await records()).find((r) => r.name === 'Home loan');
  await editor(`/api/payments/${inst.id}/settle`, { bank_id: icici, ref: 'EMI-1', date: today });

  const u = await admin(`/api/banks/${icici}/usage`);
  assert.deepEqual(u.body, { id: icici, name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222', balances: 1, received: 1, received_amount: 1_000_000, paid: 2, paid_amount: 400_000, emis: 1, unassigned: 1 });
  assert.equal((await editor(`/api/banks/${icici}/usage`)).status, 403);
});

test('deleting a bank account needs its name typed, and an admin', async () => {
  assert.equal((await editor(`/api/banks/${icici}/delete`, { confirm: 'ICICI Current' })).status, 403);
  const r = await admin(`/api/banks/${icici}/delete`, { confirm: 'ICICI' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /type the account’s name exactly: ICICI Current/);
  assert.equal(await count('SELECT count(*)::int AS n FROM banks WHERE id = $1', [icici]), 1);
});

test('deleting a bank account removes what was recorded on it; other accounts are unchanged', async () => {
  const hdfcBefore = await closing(hdfc);
  const instalments = await count("SELECT count(*)::int AS n FROM payments WHERE payee = 'Home loan' AND emi_id IS NOT NULL");
  assert.ok(instalments >= 2); // this month's and the next, made ahead
  const r = await admin(`/api/banks/${icici}/delete`, { confirm: ' icici current ' });
  assert.equal(r.status, 200);
  // entries: Kumar's receipt, Split Co's ICICI half, the EMI paid; payments deleted: the EMI's instalments (Split Co stays)
  assert.deepEqual(r.body, { id: icici, name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222', balances: 1, entries: 3, receivedAmount: 1_000_000, paidAmount: 400_000,
    emis: 1, receiptsDeleted: 1, paymentsDeleted: instalments, nowNotDecided: 2 });
  assert.equal((await admin('/api/banks/day')).body.banks.map((b) => b.name).join(), 'HDFC Current');
  for (const t of ['balances', 'entries', 'emis']) assert.equal(await count(`SELECT count(*)::int AS n FROM ${t} WHERE bank_id = $1`, [icici]), 0, t);
  const rows = await records();
  assert.equal(rows.find((x) => x.name === 'Kumar Traders'), undefined); // received only into ICICI: deleted
  assert.equal(rows.find((x) => x.name === 'Home loan'), undefined); // the EMI and its instalments: deleted
  assert.equal(await count("SELECT count(*)::int AS n FROM emis WHERE lender = 'Home loan'"), 0);
  const split = rows.find((x) => x.name === 'Split Co'); // paid partly through HDFC: kept, with the HDFC part
  assert.deepEqual([split.state, split.settled, split.bank_id], ['partial', 100_000, null]);
  assert.deepEqual([rows.find((x) => x.name === 'Later Co').bank_id, rows.find((x) => x.name === 'Later Co').state], [null, 'pending']); // kept, "Not decided"
  assert.equal(await closing(hdfc), hdfcBefore);
  // every page still loads
  for (const p of ['/api/position', '/api/banks/day', '/api/emis', '/api/transactions/summary', `/api/transactions?view=records&from=${from}&to=${to}`, '/api/activity']) assert.equal((await admin(p)).status, 200, p);
  const log = (await admin('/api/activity?type=accounts')).body.activity[0];
  assert.deepEqual([log.action, log.user_name, log.detail.name, log.detail.entries], ['bank.delete', 'Asha', 'ICICI Current', 3]);
  assert.equal((await admin(`/api/banks/${icici}/delete`, { confirm: 'ICICI Current' })).status, 404);
});

test('an account with nothing on it is deleted cleanly', async () => {
  const id = (await admin('/api/banks', { name: 'Spare', bank: 'SBI', last4: '9999' })).body.id;
  assert.deepEqual((await admin(`/api/banks/${id}/usage`)).body, { id, name: 'Spare', bank: 'SBI', last4: '9999', balances: 0, received: 0, received_amount: 0, paid: 0, paid_amount: 0, emis: 0, unassigned: 0 });
  assert.equal((await admin(`/api/banks/${id}/delete`, { confirm: 'Spare' })).status, 200);
  assert.equal(await count('SELECT count(*)::int AS n FROM banks WHERE id = $1', [id]), 0);
});
