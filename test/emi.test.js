import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { emiDates } from '../server/emi.js';
import { finalBalance } from '../server/balance.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

test('EMI dates repeat monthly and fall back to the last day of short months', () => {
  assert.deepEqual(emiDates({ day: 31, start_date: '2026-01-31' }, '2026-05-01'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(emiDates({ day: 5, start_date: '2026-11-05', end_date: '2027-01-05' }, '2030-01-01'), ['2026-11-05', '2026-12-05', '2027-01-05']);
});

test('an EMI is held from its hold date, and what is free for others is the balance minus the hold', () => {
  const T = '2026-10-15';
  const run = (upTo) => finalBalance({
    banks: [{ id: 1, name: 'Main', bank: 'HDFC', last4: '1234' }], today: T, upTo, receipts: [], entries: [],
    balances: [{ id: 1, bank_id: 1, amount: 100_000, as_of: '2026-10-14' }],
    payments: [{ id: 1, payee: 'Bank loan', amount: 60_000, due_date: '2026-10-20', hold_from: '2026-10-17', bank_id: 1, approved: true, emi_id: 9 }],
  }).rows[0];
  assert.equal(run(T).held, 0); // hold starts on the 17th
  assert.equal(run('2026-10-17').held, 60_000);
  assert.equal(run('2026-10-17').free, 40_000);
  assert.equal(run('2026-10-17').pay, 0); // held, but not due yet
  assert.equal(run('2026-10-20').pay, 60_000);
});

test('the API blocks paying others out of EMI money, and releases it once the EMI is paid', async (t) => {
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
  await call('/api/setup', { name: 'A', email: 'a@x.in', password: 'longpassword1' });
  const { body: b } = await call('/api/banks', { name: 'Main', bank: 'HDFC', last4: '1234' });
  await call('/api/balances', { bank_id: b.id, amount: '1,00,000', as_of: addDays(today, -1) });

  // EMI of ₹60,000 due in 2 days, held from 3 days before → held today
  assert.equal((await call('/api/emis', { lender: 'Car loan', amount: '60,000', bank_id: b.id, start_date: addDays(today, 2), hold_days: 3 })).status, 200);
  let pos = (await call('/api/position')).body;
  assert.equal(pos.total.held, 6_000_000);
  assert.equal(pos.total.free, 4_000_000);
  assert.equal(pos.total.pay, 0); // not due today

  const { body: v } = await call('/api/payments', { payee: 'Vendor', category: 'Vendor', amount: '50,000', due_date: today, bank_id: b.id, approved: true });
  const blocked = await call(`/api/payments/${v.id}/settle`, { ref: 'UTR1' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'emi_hold');
  assert.equal((await call(`/api/payments/${v.id}/settle`, { amount: '40,000', ref: 'UTR2' })).status, 200); // exactly what is free

  // paying the EMI itself is allowed, and releases the hold
  pos = (await call(`/api/position?date=${addDays(today, 2)}`)).body;
  const emiItem = pos.rows[0].items.find((i) => i.emi);
  assert.equal(emiItem.amount, 6_000_000);
  assert.equal((await call(`/api/payments/${emiItem.id}/settle`, { ref: 'EMI-OCT' })).status, 200);
  // the next EMI isn't held yet, so this is allowed (the EMI rule only protects held money)
  assert.equal((await call(`/api/payments/${v.id}/settle`, { amount: '10,000', ref: 'UTR3' })).status, 200);
  pos = (await call('/api/position')).body;
  assert.equal(pos.total.held, 0);

  // only one EMI payment per month even when the position is loaded again and again
  const { body: { emis } } = await call('/api/emis');
  assert.equal(emis.length, 1);
  assert.equal(emis[0].next_due, emiDates({ day: Number(addDays(today, 2).slice(8)), start_date: addDays(today, 2) }, '9999-12-31').at(1) ?? null);
  assert.equal((await call(`/api/emis/${emis[0].id}/stop`, {})).status, 200);
  assert.equal((await call('/api/emis')).body.emis[0].next_due, null);
});
