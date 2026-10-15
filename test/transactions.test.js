import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { bankStatements } from '../server/ledger.js';
import { finalBalance } from '../server/balance.js';
import { toCsv, toXlsx } from '../server/export.js';
import { setPool, q } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

// ── bank statements (pure) ──
const bank = { id: 1, name: 'Main', bank: 'HDFC', last4: '1234' };
const E = (kind, amount, date) => ({ kind, bank_id: 1, amount, date });

test('statement: opening, received, paid and closing for a period', () => {
  const r = bankStatements({
    banks: [bank], from: '2026-10-01', to: '2026-10-31',
    balances: [{ id: 1, bank_id: 1, amount: 100_000, as_of: '2026-09-25' }],
    entries: [E('IN', 5_000, '2026-09-20'), E('IN', 20_000, '2026-09-28'), E('IN', 50_000, '2026-10-05'), E('OUT', 30_000, '2026-10-10'), E('IN', 9_999, '2026-11-02')],
  }).rows[0];
  // 20 Sep is inside the 25 Sep balance; 28 Sep came after it; 2 Nov is after the period
  assert.deepEqual({ o: r.opening, i: r.received, p: r.paid, c: r.closing, x: r.corrections, n: r.count }, { o: 120_000, i: 50_000, p: 30_000, c: 140_000, x: 0, n: 2 });
});

test('statement: a balance entered inside the period shows up as a correction, not as money received', () => {
  const r = bankStatements({
    banks: [bank], from: '2026-10-01', to: '2026-10-31',
    balances: [{ id: 1, bank_id: 1, amount: 100_000, as_of: '2026-09-30' }, { id: 2, bank_id: 1, amount: 99_500, as_of: '2026-10-15' }], // ₹5 bank charges
    entries: [E('OUT', 1_000, '2026-10-20')],
  }).rows[0];
  assert.equal(r.opening, 100_000); assert.equal(r.closing, 98_500); assert.equal(r.paid, 1_000); assert.equal(r.corrections, -500);
});

test('statement: starting mid-period, the first balance gives the opening (not a correction)', () => {
  // first ever balance: ₹2,00,000 at the end of 14 Oct, which already includes ₹10,000 received on 5 Oct
  const r = bankStatements({
    banks: [bank], from: '2026-10-01', to: '2026-10-15',
    balances: [{ id: 1, bank_id: 1, amount: 200_000, as_of: '2026-10-14' }],
    entries: [E('IN', 10_000, '2026-10-05'), E('OUT', 5_000, '2026-10-15')],
  }).rows[0];
  assert.deepEqual({ o: r.opening, i: r.received, p: r.paid, c: r.closing, x: r.corrections }, { o: 190_000, i: 10_000, p: 5_000, c: 195_000, x: 0 });
});

test('statement: no balance entered yet starts from zero and says so', () => {
  const r = bankStatements({ banks: [bank], from: '2026-10-01', to: '2026-10-31', balances: [], entries: [E('IN', 7_000, '2026-10-02')] }).rows[0];
  assert.equal(r.balanceEntered, false); assert.equal(r.opening, 0); assert.equal(r.closing, 7_000);
});

test('statement: today’s closing balance equals the Bank position page’s “balance now”', () => {
  const T = '2026-10-15', balances = [{ id: 1, bank_id: 1, amount: 300_000, as_of: '2026-10-10' }];
  const entries = [E('IN', 40_000, '2026-10-09'), E('OUT', 25_000, '2026-10-12'), E('IN', 10_000, T)];
  const st = bankStatements({ banks: [bank], balances, entries, from: '2026-10-01', to: T }).rows[0];
  const pos = finalBalance({ banks: [bank], balances, entries, receipts: [], payments: [], today: T, upTo: T }).rows[0];
  assert.equal(st.closing, pos.today);
});

// ── exports (pure) ──
test('CSV: Excel-friendly, quoted where needed, and formulas are never run', () => {
  const csv = toCsv([['Party', 'Amount (₹)'], ['Shah, Mehta & "Co"', 1250.5], ['=HYPERLINK("x")', 1], ['+91 phone', 2], ['-5', 3]]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.deepEqual(csv.slice(1).trim().split('\r\n'), ['Party,Amount (₹)', '"Shah, Mehta & ""Co""",1250.5', `"'=HYPERLINK(""x"")",1`, "'+91 phone,2", "'-5,3"]);
});

// read a zip written by toXlsx back with zlib, file by file
function unzip(buf) {
  const files = {};
  for (let o = 0; buf.readUInt32LE(o) === 0x04034b50;) {
    const size = buf.readUInt32LE(o + 18), n = buf.readUInt16LE(o + 26), name = buf.toString('utf8', o + 30, o + 30 + n);
    files[name] = zlib.inflateRawSync(buf.subarray(o + 30 + n, o + 30 + n + size)).toString('utf8');
    o += 30 + n + size;
  }
  return files;
}
test('Excel: a valid .xlsx package with numbers as numbers and text escaped', () => {
  const buf = toXlsx([['Date', 'Party', 'Amount (₹)'], ['2026-10-01', 'A & B <Ltd>', 1234.56], ['2026-10-02', '=1+1', 7]], 'Receipts & payments');
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const f = unzip(buf);
  assert.deepEqual(Object.keys(f).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = f['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="C2" s="2"><v>1234\.56<\/v><\/c>/);
  assert.match(sheet, /A &amp; B &lt;Ltd&gt;/);
  assert.match(sheet, /<t xml:space="preserve">=1\+1<\/t>/); // stored as text, not a formula
  assert.ok(!sheet.includes('<f>'));
  assert.match(f['xl/workbook.xml'], /name="Receipts &amp; payments"/);
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
    return { status: r.status, headers: r.headers, body: type.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
};
const admin = session(), editor = session(), viewer = session(), anon = session();
const today = todayIST(), monthStart = `${today.slice(0, 8)}01`;
let hdfc, icici;

test('API setup: users, two banks with opening balances', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'v@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'v@x.in', password: 'viewerpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC', last4: '1111' })).body.id;
  icici = (await admin('/api/banks', { name: 'ICICI Current', bank: 'ICICI', last4: '2222' })).body.id;
  // balances at the end of the day before this month, so the whole month is "in the period"
  await editor('/api/balances', { bank_id: hdfc, amount: '1,00,000', as_of: addDays(monthStart, -1) });
  await editor('/api/balances', { bank_id: icici, amount: '50,000', as_of: addDays(monthStart, -1) });
});

const sum = async (qs = '', who = editor) => (await who(`/api/transactions/summary?${qs}`)).body;
const list = async (qs = '', who = editor) => (await who(`/api/transactions?${qs}`)).body.rows;

test('received and paid transactions move balances; pending ones do not', async () => {
  let s = await sum();
  assert.deepEqual({ o: s.total.opening, c: s.total.closing }, { o: 15_000_000, c: 15_000_000 });

  assert.equal((await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'Mehta Retail', amount: '25,000', date: today, bank_id: hdfc, bank_ref: 'UTR-IN-1', ref: 'INV-1', note: 'October order' })).status, 200);
  assert.equal((await editor('/api/transactions', { kind: 'OUT', status: 'completed', payee: 'Steel Co', amount: '10,000', date: today, bank_id: icici, bank_ref: 'UTR-OUT-1', category: 'Vendor' })).status, 200);
  assert.equal((await editor('/api/transactions', { kind: 'IN', status: 'pending', party: 'Kumar Traders', amount: '40,000', date: today, bank_id: hdfc })).status, 200);
  assert.equal((await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Landlord', amount: '15,000', date: today, category: 'Rent' })).status, 200);

  s = await sum();
  const H = s.banks.find((b) => b.id === hdfc), I = s.banks.find((b) => b.id === icici);
  assert.deepEqual([H.opening, H.received, H.paid, H.closing], [10_000_000, 2_500_000, 0, 12_500_000]);
  assert.deepEqual([I.opening, I.received, I.paid, I.closing], [5_000_000, 0, 1_000_000, 4_000_000]);
  assert.deepEqual([s.total.received, s.total.paid, s.total.closing], [2_500_000, 1_000_000, 16_500_000]);
  assert.deepEqual(s.pending, { IN: { count: 1, amount: 4_000_000 }, OUT: { count: 1, amount: 1_500_000 } });

  const hist = await list('view=history');
  assert.deepEqual(hist.map((r) => [r.kind, r.name, r.amount, r.bank_name, r.bank_ref]).sort(), [['IN', 'Mehta Retail', 2_500_000, 'HDFC Current', 'UTR-IN-1'], ['OUT', 'Steel Co', 1_000_000, 'ICICI Current', 'UTR-OUT-1']]);
  assert.equal(hist.find((r) => r.kind === 'IN').note, 'October order');
  assert.equal(hist.find((r) => r.kind === 'IN').doc_ref, 'INV-1');

  // the same balance is shown on the Bank position page
  const pos = (await editor('/api/position')).body;
  assert.equal(pos.total.today, s.total.closing);
});

test('status updates: pending → partly received → received; cancel', async () => {
  const kumar = (await list('view=records&q=Kumar'))[0];
  assert.equal(kumar.state, 'pending');
  assert.equal((await editor(`/api/receipts/${kumar.id}/settle`, { amount: '15,000', ref: 'UTR-K1', bank_id: hdfc })).status, 200);
  assert.equal((await list('view=records&q=Kumar'))[0].state, 'partial');
  assert.equal((await sum()).pending.IN.amount, 2_500_000);
  assert.equal((await editor(`/api/receipts/${kumar.id}/settle`, { ref: 'UTR-K2', bank_id: hdfc })).status, 200);
  const k = (await list('view=records&q=Kumar'))[0];
  assert.deepEqual([k.state, k.settled, k.bank_refs], ['completed', 4_000_000, 'UTR-K1, UTR-K2']);
  assert.equal((await sum()).banks.find((b) => b.id === hdfc).closing, 16_500_000);

  const landlord = (await list('view=records&q=Landlord'))[0];
  assert.equal((await editor(`/api/payments/${landlord.id}/cancel`, {})).status, 200);
  assert.equal((await list('view=records&q=Landlord'))[0].state, 'cancelled');
  assert.equal((await sum()).pending.OUT.count, 0);
  assert.equal((await editor(`/api/payments/${landlord.id}/settle`, { ref: 'UTR-L', bank_id: hdfc })).status, 400); // cancelled can't be paid
});

test('recording rules: bank reference, bank account and a past date are needed when received/paid', async () => {
  const base = { kind: 'IN', status: 'completed', party: 'Rules Ltd', amount: '1,000', date: today, bank_id: hdfc };
  assert.match((await editor('/api/transactions', { ...base })).body.error.message, /Bank reference/);
  assert.match((await editor('/api/transactions', { ...base, bank_id: '', bank_ref: 'R1' })).body.error.message, /bank account/);
  assert.match((await editor('/api/transactions', { ...base, date: addDays(today, 2), bank_ref: 'R1' })).body.error.message, /future/);
  assert.equal((await editor('/api/transactions', { ...base, kind: 'X', bank_ref: 'R1' })).status, 400);
  // nothing half-saved: a failed one leaves no receipt behind
  assert.equal((await q("SELECT count(*)::int AS n FROM receipts WHERE party = 'Rules Ltd'")).rows[0].n, 0);
});

test('duplicates: the same bank reference, or the same party/amount/date, is caught', async () => {
  const before = (await q('SELECT count(*)::int AS n FROM receipts')).rows[0].n;
  const r = await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'Other Co', amount: '500', date: today, bank_id: hdfc, bank_ref: 'utr in 1' });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /bank reference is already recorded/);
  assert.equal((await q('SELECT count(*)::int AS n FROM receipts')).rows[0].n, before); // rolled back
  // the same reference on another account is a different transaction
  assert.equal((await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'Other Co', amount: '500', date: today, bank_id: icici, bank_ref: 'UTR-IN-1' })).status, 200);

  const dup = await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'MEHTA RETAIL', amount: '25000', date: today, bank_id: hdfc, bank_ref: 'UTR-NEW' });
  assert.equal(dup.body.error.code, 'duplicate');
  assert.equal((await editor('/api/transactions', { kind: 'IN', status: 'completed', party: 'MEHTA RETAIL', amount: '25000', date: today, bank_id: hdfc, bank_ref: 'UTR-NEW', confirmDuplicate: true })).status, 200);
  // the older “add receipt” screen gets the same check, and an invoice number already open is caught too
  assert.equal((await editor('/api/receipts', { party: 'Pending Co', amount: '700', expected_date: today, ref: 'INV/77' })).status, 200);
  assert.equal((await editor('/api/receipts', { party: 'Pending Co', amount: '700', expected_date: today })).body.error.code, 'duplicate');
  assert.equal((await editor('/api/receipts', { party: 'Someone else', amount: '1', expected_date: addDays(today, 3), ref: 'inv 77' })).body.error.code, 'duplicate');
});

test('an EMI hold also applies to payments recorded here', async () => {
  await admin('/api/emis', { lender: 'Car loan', amount: '1,60,000', bank_id: hdfc, start_date: today });
  // HDFC has ₹1,65,500 now (₹1,00,000 + 25,000 + 15,000 + 25,000 + 500 counted below); ₹1,60,000 is held
  const h = (await sum()).banks.find((b) => b.id === hdfc).closing;
  const r = await editor('/api/transactions', { kind: 'OUT', status: 'completed', payee: 'Big vendor', amount: String((h - 16_000_000) / 100 + 1), date: today, bank_id: hdfc, bank_ref: 'UTR-BIG', category: 'Vendor' });
  assert.equal(r.body.error?.code, 'emi_hold');
  assert.equal((await q("SELECT count(*)::int AS n FROM payments WHERE payee = 'Big vendor'")).rows[0].n, 0);
});

test('filters: dates, bank, type, status and search', async () => {
  // a receipt due last month but received today shows in this month's report and history
  const old = addDays(monthStart, -5);
  const x = (await editor('/api/transactions', { kind: 'IN', status: 'pending', party: 'Late Payer', amount: '3,000', date: old, bank_id: icici })).body;
  assert.equal((await editor(`/api/receipts/${x.id}/settle`, { ref: 'UTR-LATE', bank_id: icici })).status, 200);
  assert.ok((await list('view=records&q=Late')).length === 1);
  assert.ok((await list('view=history&q=late')).length === 1);
  assert.equal((await list(`view=records&q=Late&from=${addDays(monthStart, -40)}&to=${addDays(monthStart, -30)}`)).length, 0);

  assert.ok((await list(`view=history&bank=${icici}`)).every((r) => r.bank_id === icici));
  assert.ok((await list('view=history&type=OUT')).every((r) => r.kind === 'OUT'));
  assert.ok((await list('view=records&status=completed')).every((r) => r.state === 'completed'));
  assert.ok((await list('view=records&status=cancelled')).every((r) => r.state === 'cancelled'));
  assert.deepEqual((await list('view=history&q=UTR-OUT')).map((r) => r.name), ['Steel Co']); // bank reference
  assert.deepEqual((await list('view=history&q=october')).map((r) => r.name), ['Mehta Retail']); // description
  assert.deepEqual(await list('view=history&q=%25'), []);
  assert.equal((await list(`view=history&from=${addDays(today, 1)}&to=${addDays(today, 2)}`)).length, 0);

  // a bank-only summary
  const s = await sum(`bank=${icici}`);
  assert.deepEqual(s.banks.map((b) => b.id), [icici]); assert.equal(s.total.closing, s.banks[0].closing);

  for (const bad of ['from=2026-10-10&to=2026-10-01', 'type=X', 'status=done', 'view=x', 'from=2026-02-30', 'bank=abc']) assert.equal((await editor(`/api/transactions?${bad}`)).status, 400, bad);
});

test('exports: CSV and Excel with the current filters, logged in the activity log', async () => {
  const csv = await viewer(`/api/transactions/export?view=history&format=csv&bank=${hdfc}`);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="transactions-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = csv.body.toString('utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Date,Type,Party,Amount (₹),Bank account,Bank reference,Invoice / bill no.,Description,Recorded by');
  assert.ok(lines.slice(1).every((l) => l.includes('HDFC Current')));
  assert.ok(lines.some((l) => l.startsWith(`${today},Receipt,Mehta Retail,25000,`)));

  const xl = await viewer('/api/transactions/export?view=records&format=xlsx&status=completed');
  assert.equal(xl.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(xl.body.subarray(0, 2).toString(), 'PK');
  assert.match(xl.headers.get('content-disposition'), /receipts-payments-.*\.xlsx/);
  assert.equal((await viewer('/api/transactions/export?format=pdf')).status, 400);

  const log = (await admin('/api/activity?type=reports')).body.activity;
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].detail.format, log[0].detail.status, log[0].user_name], ['xlsx', 'completed', 'Vik']);
});

test('permissions: viewers can look and export, only editors and admins record; signed-out users get nothing', async () => {
  assert.equal((await viewer('/api/transactions/summary')).status, 200);
  assert.equal((await viewer('/api/transactions')).status, 200);
  assert.equal((await viewer('/api/transactions', { kind: 'IN', status: 'pending', party: 'X', amount: '1', date: today })).status, 403);
  assert.equal((await viewer(`/api/receipts/1/settle`, { ref: 'V1' })).status, 403);
  for (const p of ['/api/transactions/summary', '/api/transactions', '/api/transactions/export?format=csv']) assert.equal((await anon(p)).status, 401);
  assert.equal((await anon('/api/transactions', { kind: 'IN' })).status, 401);
  assert.equal((await admin('/api/transactions', { kind: 'IN', status: 'pending', party: 'By admin', amount: '1', date: today })).status, 200);
});

test('audit: recording, receiving, paying and cancelling are all in the activity log with who did it', async () => {
  const log = (await admin('/api/activity')).body.activity;
  const has = (action, name, who) => log.some((a) => a.action === action && (a.detail.party ?? a.detail.payee ?? '') .includes(name) && a.user_name === who);
  assert.ok(has('receipt.add', 'Mehta Retail', 'Eli'));
  assert.ok(has('payment.add', 'Steel Co', 'Eli'));
  assert.ok(log.some((a) => a.action === 'receipt.received' && a.detail.ref === 'UTR-K1' && a.user_name === 'Eli'));
  assert.ok(log.some((a) => a.action === 'payment.paid' && a.detail.ref === 'UTR-OUT-1'));
  assert.ok(log.some((a) => a.action === 'payment.cancel'));
});
