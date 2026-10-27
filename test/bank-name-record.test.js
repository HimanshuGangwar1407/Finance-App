// The account written in a sheet, or printed on a statement, decides where things are recorded: an uploaded
// receipt / payment goes to the account with those last 4 digits, and a statement is reconciled with — and records
// what isn't in the app into — the account its own account number ends in.
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
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
let hdfc, icici;

test('setup: two accounts', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' })).body.id;
  icici = (await admin('/api/banks', { name: 'ICICI Current', bank: 'ICICI Bank', last4: '2222' })).body.id;
  await admin('/api/balances', { bank_id: hdfc, amount: '5,00,000', as_of: addDays(today, -5) });
  await admin('/api/balances', { bank_id: icici, amount: '1,00,000', as_of: addDays(today, -5) });
});

test('upload: each payment / receipt goes to the account its Account No. ends in', async () => {
  const sheet = b64(`Type,Name,Amount,Due date,Account No.\nPayment,Steel Co,"1,25,000",${dmy(yday)},50200012341111\nPayment,Gupta Transport,8200,${dmy(yday)},XXXXXXXX2222\n`
    + `Receipt,Mehta Retail,80000,${dmy(yday)},XXXX2222\nPayment,Landlord,45000,${dmy(yday)},\nPayment,Unknown Bank Co,100,${dmy(yday)},XXXX5555\n`);
  const check = await editor('/api/import/check', { file: sheet, name: 'october.csv' });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.rows.map((r) => [r.name, r.bank_id, r.bank_name]), [
    ['Steel Co', hdfc, 'HDFC Current (XXXX1111)'], ['Gupta Transport', icici, 'ICICI Current (XXXX2222)'], ['Mehta Retail', icici, 'ICICI Current (XXXX2222)'],
    ['Landlord', null, null], ['Unknown Bank Co', null, null]]);
  assert.match(check.body.rows[4].notes.join(), /XXXX5555 not found/);
  const add = await editor('/api/import/add', { file: sheet, name: 'october.csv' });
  assert.deepEqual([add.status, add.body.added], [200, 5]);
  assert.deepEqual(await one("SELECT bank_id FROM payments WHERE payee = 'Steel Co'"), { bank_id: hdfc });
  assert.deepEqual(await one("SELECT bank_id FROM payments WHERE payee = 'Gupta Transport'"), { bank_id: icici });
  assert.deepEqual(await one("SELECT bank_id FROM receipts WHERE party = 'Mehta Retail'"), { bank_id: icici });
});

// an HDFC statement: its account number is above the table. Gupta Transport's ₹8,200 is assigned to ICICI, so it isn't
// matched here by itself; Steel Co (HDFC) is; the bank charge and the deposit aren't in the app.
const stmt = b64(`HDFC BANK Ltd.\nAccount No :50200012341111\n\nDate,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
${dmy(yday)},NEFT DR-STEEL CO PVT LTD-N295123456,N295123456,"1,25,000.00",,"3,75,000.00"
${dmy(yday)},IMPS-229512345678-GUPTA TRANSPORT-SBIN,229512345678,8200.00,,"3,66,800.00"
${dmy(yday)},CHRG: NEFT CHARGES,,59.00,,"3,66,741.00"
${dmy(yday)},NEFT CR-KAPOOR TRADERS,N29400009,,"20,000.00","3,86,741.00"
`);
const body = { file: stmt, name: 'hdfc.csv' };

test('reconcile: the statement’s account no. picks the account; another account’s payment isn’t matched by itself', async () => {
  const r = await editor('/api/reconcile/check', { ...body, bank_id: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.bank.id, r.body.account], [hdfc, { last4: '1111', by: 'statement', agrees: true }]);
  const steel = (await one("SELECT id FROM payments WHERE payee = 'Steel Co'")).id, gupta = (await one("SELECT id FROM payments WHERE payee = 'Gupta Transport'")).id;
  assert.deepEqual(r.body.debits.map((d) => [d.amount, d.match?.id ?? null]), [[12_500_000, steel], [820_000, null], [5_900, null]]);
  assert.ok(r.body.debits[1].candidates.includes(gupta)); // still offered, to choose by hand
  assert.ok(!r.body.due.includes(gupta)); // and not "left out" of this account's statement
});

test('reconcile: an account chosen by hand must agree with the statement’s number — or the person goes ahead', async () => {
  let r = await editor('/api/reconcile/check', { ...body, bank_id: icici });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'account_mismatch');
  assert.deepEqual(r.body.error.detail, { last4: '1111', suggest: hdfc });
  assert.match(r.body.error.message, /for account XXXX1111, but ICICI Current \(ICICI Bank XXXX2222\) was chosen\. Reconcile it with HDFC Current/);
  // nothing can be applied to the wrong account either
  assert.equal((await editor('/api/reconcile/apply', { ...body, bank_id: icici, record: [{ row: 6 }] })).body.error.code, 'account_mismatch');
  r = await editor('/api/reconcile/check', { ...body, bank_id: icici, anyAccount: true });
  assert.deepEqual([r.status, r.body.bank.id, r.body.account.agrees], [200, icici, false]);
  r = await editor('/api/reconcile/check', { ...body, bank_id: hdfc });
  assert.deepEqual([r.status, r.body.account], [200, { last4: '1111', by: 'chosen', agrees: true }]);
});

test('reconcile: an account number not in the app, or no number at all, asks for the account', async () => {
  const other = b64(`Account No : XXXXXXXX3333\nDate,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n${dmy(yday)},X,1.00,,99.00\n`);
  let r = await editor('/api/reconcile/check', { file: other, name: 'x.csv' });
  assert.deepEqual([r.status, r.body.error.code], [400, 'account_unknown']);
  assert.match(r.body.error.message, /account XXXX3333, which isn’t in the app/);
  const bare = b64(`Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n${dmy(yday)},X,1.00,,99.00\n`);
  r = await editor('/api/reconcile/check', { file: bare, name: 'x.csv' });
  assert.match(r.body.error.message, /doesn’t show its account number/);
  r = await editor('/api/reconcile/check', { file: bare, name: 'x.csv', bank_id: icici }); // chosen by hand: as before
  assert.deepEqual([r.status, r.body.bank.id, r.body.account], [200, icici, { last4: null, by: 'chosen', agrees: null }]);
});

test('reconcile: what isn’t in the app is recorded in the statement’s account', async () => {
  const d = (await editor('/api/reconcile/check', body)).body;
  const charge = d.debits.find((x) => x.amount === 5_900), deposit = d.credits.find((x) => x.amount === 2_000_000), steel = d.debits.find((x) => x.match);
  const r = await editor('/api/reconcile/apply', { ...body, matches: [{ row: steel.row, id: steel.match.id }], record: [{ row: charge.row, payee: 'Bank charges' }], recordIn: [{ row: deposit.row, party: 'Kapoor Traders' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.paid, r.body.recorded, r.body.recordedIn], [1, 1, 1]);
  // the new payment and receipt, and the money moved, are all on HDFC (the statement's account)
  assert.deepEqual(await one("SELECT p.bank_id, e.bank_id AS paid_from FROM payments p JOIN entries e ON e.payment_id = p.id WHERE p.payee = 'Bank charges'"), { bank_id: hdfc, paid_from: hdfc });
  assert.deepEqual(await one("SELECT r.bank_id, e.bank_id AS paid_into FROM receipts r JOIN entries e ON e.receipt_id = r.id WHERE r.party = 'Kapoor Traders'"), { bank_id: hdfc, paid_into: hdfc });
  assert.deepEqual(await one("SELECT e.bank_id FROM entries e JOIN payments p ON p.id = e.payment_id WHERE p.payee = 'Steel Co'"), { bank_id: hdfc });
  // ICICI's Gupta Transport payment is untouched
  assert.deepEqual(await one("SELECT count(*)::int AS n FROM entries e JOIN payments p ON p.id = e.payment_id WHERE p.payee = 'Gupta Transport'"), { n: 0 });
  // checked again: what was just applied shows as already in the app, on this account
  const again = (await editor('/api/reconcile/check', body)).body;
  assert.deepEqual(again.debits.map((x) => Boolean(x.recorded)), [true, false, true]);
});
