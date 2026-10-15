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
const admin = session(), viewer = session();
const today = todayIST(), yday = addDays(today, -1), before = addDays(today, -2);
const day = async (d, who = admin) => (await who(`/api/banks/day${d ? `?date=${d}` : ''}`)).body;
const bank = (d, name) => d.banks.find((b) => b.name === name);
let hdfc, icici;

test('setup: two banks with balances two days ago, and a few days of money in and out', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'asha@x.in', password: 'adminpass123' });
  await admin('/api/people', { name: 'Vik', email: 'vik@x.in', login_role: 'viewer', password: 'viewerpass12' });
  await viewer('/api/login', { email: 'vik@x.in', password: 'viewerpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC', bank: 'HDFC Bank', last4: '1111' })).body.id;
  icici = (await admin('/api/banks', { name: 'ICICI', bank: 'ICICI Bank', last4: '2222' })).body.id;
  await admin('/api/balances', { bank_id: hdfc, amount: '1,00,000', as_of: before });
  await admin('/api/balances', { bank_id: icici, amount: '50,000', as_of: before });
  const tx = (kind, name, amount, date, bank_id, ref, extra = {}) => admin('/api/transactions', { kind, status: 'completed', [kind === 'IN' ? 'party' : 'payee']: name, amount, date, bank_id, bank_ref: ref, category: 'Vendor', ...extra });
  assert.equal((await tx('IN', 'Client A', '20,000', yday, hdfc, 'U1', { note: 'Invoice 7' })).status, 200);
  assert.equal((await tx('OUT', 'Steel Co', '30,000', today, hdfc, 'U2')).status, 200);
  assert.equal((await tx('IN', 'Client B', '10,000', today, icici, 'U3')).status, 200);
  // an EMI due today, paid today; and one due today on ICICI, still unpaid
  await admin('/api/emis', { lender: 'Car loan', amount: '15,000', bank_id: hdfc, start_date: today });
  await admin('/api/emis', { lender: 'Bike loan', amount: '5,000', bank_id: icici, start_date: today });
  const car = (await admin('/api/emis/schedule?status=open')).body.rows.find((r) => r.lender === 'Car loan' && r.due_date === today);
  assert.equal((await admin(`/api/payments/${car.payment_id}/settle`, { ref: 'EMI-1' })).status, 200);
});

test('a past day: opening, debits, credits and closing per bank', async () => {
  const d = await day(yday);
  const h = bank(d, 'HDFC'), i = bank(d, 'ICICI');
  assert.deepEqual([h.opening, h.paid, h.received, h.closing], [10_000_000, 0, 2_000_000, 12_000_000]);
  assert.deepEqual(h.credits, [{ name: 'Client A', amount: 2_000_000, ref: 'U1', note: 'Invoice 7' }]);
  assert.deepEqual(h.debits, []);
  assert.deepEqual([i.opening, i.paid, i.received, i.closing], [5_000_000, 0, 0, 5_000_000]);
  assert.deepEqual([d.total.opening, d.total.paid, d.total.received, d.total.closing], [15_000_000, 0, 2_000_000, 17_000_000]);
  assert.equal(h.emisDue.length, 0);
  // the next EMI still to pay after that day: today's was paid, so next month's
  assert.equal(h.nextEmi.lender, 'Car loan'); assert.ok(h.nextEmi.due_date > today); assert.equal(h.nextEmi.amount, 1_500_000);
  assert.deepEqual([bank(d, 'ICICI').nextEmi.lender, bank(d, 'ICICI').nextEmi.due_date], ['Bike loan', today]);
});

test('today: the EMI paid today is a debit; EMIs due today show paid / due', async () => {
  const d = await day();
  assert.equal(d.date, today);
  const h = bank(d, 'HDFC'), i = bank(d, 'ICICI');
  assert.deepEqual([h.opening, h.paid, h.received, h.closing], [12_000_000, 4_500_000, 0, 7_500_000]);
  assert.deepEqual(h.debits.map((x) => [x.name, x.amount, x.note]).sort(), [['Car loan', 1_500_000, 'EMI'], ['Steel Co', 3_000_000, 'Vendor']]);
  assert.deepEqual(h.emisDue.map((e) => [e.lender, e.amount, e.state, e.paid_on]), [['Car loan', 1_500_000, 'paid', today]]);
  assert.equal(h.nextEmi.lender, 'Car loan'); assert.ok(h.nextEmi.due_date > today); // next month
  assert.deepEqual([i.opening, i.paid, i.received, i.closing], [5_000_000, 0, 1_000_000, 6_000_000]);
  assert.deepEqual(i.emisDue.map((e) => [e.lender, e.state, e.left]), [['Bike loan', 'due', 500_000]]);
  assert.equal(i.reserved, 500_000); // the unpaid EMI's money is reserved
  assert.equal(d.total.emiDue, 2_000_000);
});

test('each day opens with the previous day’s closing balance', async () => {
  for (const d of [before, yday, today]) {
    const prev = await day(addDays(d, -1)), cur = await day(d);
    for (const b of cur.banks) assert.equal(b.opening, bank(prev, b.name).closing, `${b.name} on ${d}`);
  }
});

test('the figures agree with Transactions and the Dashboard', async () => {
  const d = await day();
  const t = (await admin(`/api/transactions/summary?from=${today}&to=${today}`)).body.total;
  assert.deepEqual([d.total.opening, d.total.paid, d.total.received, d.total.closing], [t.opening, t.paid, t.received, t.closing]);
  const pos = (await admin('/api/position')).body.total;
  assert.equal(d.total.closing, pos.today);
});

test('dates and permissions', async () => {
  assert.equal((await admin(`/api/banks/day?date=${addDays(today, 1)}`)).status, 400); // not the future
  assert.equal((await admin('/api/banks/day?date=2026-02-30')).status, 400);
  assert.equal((await viewer('/api/banks/day')).status, 200); // anyone signed in can see it
  assert.equal((await session()('/api/banks/day')).status, 401);
});
