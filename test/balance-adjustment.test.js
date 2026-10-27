// A payment slip (or a receipt) often doesn't say which bank account the money will go through. Reconciling a bank's
// statement finds it there: it is marked paid / received from that account, and is that account's from then on —
// so each account's balance moves, and nothing stays under "Account not decided".
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
const admin = session(), editor = session();
const today = todayIST(), yday = addDays(today, -1), dmy = (d) => d.split('-').reverse().join('/');
const statement = (no, lines) => ({ name: 'statement.csv', file: Buffer.from(`Account No : ${no}\nDate,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n${lines}`).toString('base64') });
const pay = async (payee, amount, x = {}) => (await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee, amount, date: yday, category: 'Vendor', ...x })).body.id;
const rec = async (party, amount, x = {}) => (await editor('/api/transactions', { kind: 'IN', status: 'pending', party, amount, date: yday, ...x })).body.id;
const accountOf = async (table, id) => (await pool.query(`SELECT bank_id FROM ${table} WHERE id = $1`, [id])).rows[0].bank_id;
const position = async () => (await editor('/api/position')).body;
const row = (pos, id) => pos.rows.find((r) => r.id === id);
// apply everything the check matched
const applyMatched = async (body) => {
  const d = (await editor('/api/reconcile/check', body)).body;
  const r = await editor('/api/reconcile/apply', { ...body, matches: d.debits.filter((x) => x.match).map((x) => ({ row: x.row, id: x.match.id })), matchesIn: d.credits.filter((x) => x.match).map((x) => ({ row: x.row, id: x.match.id })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { check: d, result: r.body };
};
let hdfc, icici, ids = {};

test('setup: two accounts, and a payment and receipt with no account on the slip', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' })).body.id;
  icici = (await admin('/api/banks', { name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222' })).body.id;
  for (const id of [hdfc, icici]) await admin('/api/balances', { bank_id: id, amount: '5,00,000', as_of: addDays(today, -5) });
  ids.steel = await pay('Steel Co', '1,25,000');
  ids.gupta = await pay('Gupta Transport', '8,200');
  ids.mehta = await rec('Mehta Retail', '80,000');
  const pos = await position();
  const none = pos.rows.find((r) => r.id == null);
  assert.deepEqual([none.name, none.pay, none.receive], ['Account not decided', 13_320_000, 8_000_000]);
});

const hdfcStmt = statement('50200012341111', `${dmy(yday)},NEFT DR-STEEL CO PVT LTD-N295123456,N295123456,"1,25,000.00",,"3,75,000.00"
${dmy(yday)},NEFT CR-MEHTA RETAIL-ORDER 42,N29400001,,"80,000.00","4,55,000.00"\n`);
const iciciStmt = statement('XXXXXXXX2222', `${dmy(yday)},IMPS-229512345678-GUPTA TRANSPORT-SBIN,229512345678,8200.00,,"4,91,800.00"\n`);

test('HDFC’s statement: the payment and receipt found in it are recorded from / into HDFC, and become HDFC’s', async () => {
  const { check, result } = await applyMatched(hdfcStmt);
  assert.deepEqual([check.debits[0].match?.id, check.credits[0].match?.id], [ids.steel, ids.mehta]);
  // Gupta Transport has no account either: it may be in this statement, so it is listed as due — but it isn't in it
  assert.ok(check.due.includes(ids.gupta));
  assert.deepEqual([result.paid, result.received, result.assigned, result.assignedIn], [1, 1, 1, 1]);
  assert.deepEqual([await accountOf('payments', ids.steel), await accountOf('receipts', ids.mehta), await accountOf('payments', ids.gupta)], [hdfc, hdfc, null]);
  const pos = await position();
  assert.equal(row(pos, hdfc).today, 50_000_000 - 12_500_000 + 8_000_000); // HDFC's balance moved
  assert.equal(row(pos, icici).today, 50_000_000); // ICICI's didn't
  // the activity log says it
  const { rows: [a] } = await pool.query("SELECT detail FROM audit WHERE action = 'payment.paid' ORDER BY id DESC LIMIT 1");
  assert.equal(a.detail.accountAssigned, true);
});

test('ICICI’s statement: the payment still without an account is found there, and becomes ICICI’s', async () => {
  const { check, result } = await applyMatched(iciciStmt);
  assert.equal(check.debits[0].match?.id, ids.gupta);
  assert.equal(result.assigned, 1);
  assert.equal(await accountOf('payments', ids.gupta), icici);
  const pos = await position();
  assert.equal(row(pos, icici).today, 50_000_000 - 820_000);
  assert.equal(pos.rows.find((r) => r.id == null), undefined); // nothing left under "Account not decided"
  // applied again, nothing is matched twice
  const again = (await editor('/api/reconcile/check', iciciStmt)).body;
  assert.ok(again.debits[0].recorded);
});

test('part paid: the account the first part went through is the payment’s, and what is left is due from it', async () => {
  const id = await pay('Kumar Packaging', '50,000');
  const body = statement('50200012341111', `${dmy(yday)},NEFT DR-KUMAR PACKAGING-PART 1,N555,"20,000.00",,"4,35,000.00"\n`);
  const { result } = await applyMatched(body);
  assert.deepEqual([result.paid, result.paidAmount, result.assigned], [1, 2_000_000, 1]);
  assert.equal(await accountOf('payments', id), hdfc);
  assert.equal(row(await position(), hdfc).pay, 3_000_000); // ₹30,000 still to pay, from HDFC
});

test('only a payment / receipt with no account takes the statement’s: one already assigned keeps its own', async () => {
  const id = await pay('Sharma & Sons', '10,000', { bank_id: icici });
  const body = statement('50200012341111', `${dmy(yday)},UPI-SHARMA AND SONS,U777,"10,000.00",,"4,25,000.00"\n`);
  const d = (await editor('/api/reconcile/check', body)).body;
  assert.equal(d.debits[0].match, null); // another account's: not matched by itself
  const r = await editor('/api/reconcile/apply', { ...body, matches: [{ row: d.debits[0].row, id }] }); // chosen by hand
  assert.deepEqual([r.status, r.body.paid, r.body.assigned], [200, 1, 0]);
  assert.equal(await accountOf('payments', id), icici);
});

test('marked paid / received by hand without an account on it: it becomes the account chosen', async () => {
  const p = await pay('Office rent', '45,000'), r = await rec('Kapoor Traders', '12,000');
  assert.equal((await editor(`/api/payments/${p}/settle`, { bank_id: icici, ref: 'UTR-RENT-1', date: today })).status, 200);
  assert.equal((await editor(`/api/receipts/${r}/settle`, { bank_id: hdfc, ref: 'UTR-KAP-1', date: today })).status, 200);
  assert.deepEqual([await accountOf('payments', p), await accountOf('receipts', r)], [icici, hdfc]);
});
