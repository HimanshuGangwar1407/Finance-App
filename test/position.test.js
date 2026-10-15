import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { finalBalance } from '../server/balance.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

const T = '2026-10-15';
const bank = { id: 1, name: 'Main', bank: 'HDFC', last4: '1234' };

test('today = opening balance − payments due today + receipts due today', () => {
  const r = finalBalance({
    banks: [bank], today: T, upTo: T, entries: [],
    balances: [{ id: 1, bank_id: 1, amount: 1_000_000, as_of: addDays(T, -1) }],
    payments: [
      { id: 1, payee: 'Rent', amount: 300_000, due_date: T, bank_id: 1, approved: true },
      { id: 2, payee: 'Late vendor', amount: 50_000, due_date: addDays(T, -3), bank_id: 1, approved: true }, // overdue: still counts today
      { id: 3, payee: 'Next week', amount: 999_999, due_date: addDays(T, 7), bank_id: 1, approved: true }, // later: not today
    ],
    receipts: [{ id: 1, party: 'Client', amount: 200_000, expected_date: T, certainty: 'FIRM', bank_id: 1 }],
  });
  assert.deepEqual(r.total, { today: 1_000_000, pay: 350_000, receive: 200_000, final: 850_000, held: 0, free: 1_000_000 });
  assert.equal(r.rows[0].items.find((i) => i.id === 2).overdue, true);
});

test('a payment marked paid today leaves "to pay" and comes off the balance — counted once', () => {
  const base = {
    banks: [bank], today: T, upTo: T, receipts: [],
    balances: [{ id: 1, bank_id: 1, amount: 1_000_000, as_of: addDays(T, -1) }],
    payments: [{ id: 1, payee: 'Rent', amount: 300_000, due_date: T, bank_id: 1, approved: true }],
  };
  const before = finalBalance({ ...base, entries: [] });
  const after = finalBalance({ ...base, entries: [{ kind: 'OUT', payment_id: 1, bank_id: 1, amount: 300_000, date: T }] });
  assert.equal(before.total.final, 700_000);
  assert.deepEqual(after.total, { today: 700_000, pay: 0, receive: 0, final: 700_000, held: 0, free: 700_000 });
});

test('the API end to end', async (t) => {
  const pool = pglitePool();
  setPool(pool);
  process.env.SESSION_SECRET = 'x'.repeat(40);
  const { handler } = await import('../server/index.js');
  const server = http.createServer(handler).listen(0);
  t.after(() => { server.close(); pool.end(); });
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (path, body) => {
    const r = await fetch(base + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  const today = todayIST();

  assert.equal((await call('/api/state')).body.needsSetup, true);
  assert.equal((await call('/api/position')).status, 401);
  assert.equal((await call('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'weak' })).status, 400);
  assert.equal((await call('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'longpassword1' })).status, 200);
  assert.equal((await call('/api/setup', { name: 'B', email: 'b@x.in', password: 'longpassword1' })).status, 403);

  const { body: b } = await call('/api/banks', { name: 'Main', bank: 'HDFC', last4: '1234' });
  await call('/api/balances', { bank_id: b.id, amount: '10,00,000', as_of: addDays(today, -1) });
  const { body: pay } = await call('/api/payments', { payee: 'Rent', category: 'Rent', amount: '3,00,000', due_date: today, bank_id: b.id, ref: 'INV/01', approved: true });
  await call('/api/receipts', { party: 'Client', amount: '2,00,000.50', expected_date: today, bank_id: b.id });
  await call('/api/payments', { payee: 'Later', category: 'Vendor', amount: '5000', due_date: addDays(today, 3), bank_id: b.id });

  // duplicate reference is flagged, and allowed when confirmed
  const dup = await call('/api/payments', { payee: 'Rent', category: 'Rent', amount: '1', due_date: today, ref: 'inv 1' });
  assert.equal(dup.body.error.code, 'duplicate');

  let pos = (await call('/api/position')).body;
  assert.deepEqual(pos.total, { today: 100_000_000, pay: 30_000_000, receive: 20_000_050, final: 90_000_050, held: 0, free: 100_000_000 });

  // a part payment, then the bank reference can't be reused on the same account
  assert.equal((await call(`/api/payments/${pay.id}/settle`, { amount: '1,00,000', ref: 'UTR123' })).status, 200);
  assert.equal((await call(`/api/payments/${pay.id}/settle`, { amount: '1', ref: 'utr 123' })).status, 409);
  assert.equal((await call(`/api/payments/${pay.id}/settle`, { amount: '2,00,001', ref: 'UTR124' })).status, 400);
  pos = (await call('/api/position')).body;
  assert.deepEqual(pos.total, { today: 90_000_000, pay: 20_000_000, receive: 20_000_050, final: 90_000_050, held: 0, free: 90_000_000 });

  // looking 3 days ahead picks up the later payment
  pos = (await call(`/api/position?date=${addDays(today, 3)}`)).body;
  assert.equal(pos.total.pay, 20_500_000);

  // viewers can look but not change anything
  await call('/api/users', { name: 'V', email: 'v@x.in', role: 'viewer', password: 'longpassword2' });
  await call('/api/logout', {});
  assert.equal((await call('/api/login', { email: 'v@x.in', password: 'nope' })).status, 401);
  assert.equal((await call('/api/login', { email: 'V@x.in', password: 'longpassword2' })).status, 200);
  assert.equal((await call('/api/position')).status, 200);
  assert.equal((await call('/api/receipts', { party: 'X', amount: '1', expected_date: today })).status, 403);
});
