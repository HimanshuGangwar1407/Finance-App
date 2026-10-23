import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { readTable } from '../server/sheet.js';
import { readStatement, matchStatement, similarity } from '../server/reconcile.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const csv = (text) => Buffer.from(text, 'utf8');
const statement = (buf, name = 'x.csv') => readStatement(readTable(buf, name));
const P = (id, name, amt, due, ref = '', bank_id = 1) => ({ id, name, outstanding: amt, amount: amt, due_date: due, ref, bank_id });

// ── reading statements ──
test('an HDFC statement written by Excel: account details above, dd/mm/yy text dates, a summary below', () => {
  const st = statement(fixture('hdfc-statement.xlsx'), 'hdfc.xlsx');
  assert.equal(st.headerRow, 8);
  assert.deepEqual(st.columns, { date: 'Date', narration: 'Narration', ref: 'Chq./Ref.No.', debit: 'Withdrawal Amt.', credit: 'Deposit Amt.', balance: 'Closing Balance' });
  assert.deepEqual(st.skipped, []);
  assert.deepEqual([st.from, st.to, st.closing], ['2026-10-21', '2026-10-22', { date: '2026-10-22', amount: 44_224_100 }]);
  assert.deepEqual(st.rows.map((r) => [r.row, r.date, r.debit, r.credit]), [
    [10, '2026-10-21', 0, 8_000_000], [11, '2026-10-22', 12_500_000, 0], [12, '2026-10-22', 820_000, 0], [13, '2026-10-22', 450_000, 0], [14, '2026-10-22', 5_900, 0]]);
  assert.equal(st.rows[1].ref, '0000N295123456');
});

test('other layouts: newest first (ICICI), Txn Date / Ref No./Cheque No. with wrapped narration (SBI), one Amount column with Dr/Cr', () => {
  let st = statement(csv('S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )\n'
    + '2,22/10/2026,22/10/2026,,NEFT-STEEL CO,"1,25,000.00",0.00,"3,75,000.00"\n1,21/10/2026,21/10/2026,,OPENING CREDIT,0.00,"10,000.00","5,00,000.00"\n'));
  assert.deepEqual(st.rows.map((r) => [r.date, r.debit, r.credit]), [['2026-10-21', 0, 1_000_000], ['2026-10-22', 12_500_000, 0]]); // oldest first
  assert.deepEqual(st.closing, { date: '2026-10-22', amount: 37_500_000 });

  st = statement(csv('Account Name : X\n\nTxn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance\n'
    + '22 Oct 2026,22 Oct 2026,TO TRANSFER-UPI/DR/1234/,TRANSFER TO 123,500.00,,9500.00\n,,GUPTA TRANSPORT/SBIN/,,,,\n23 Oct 2026,23 Oct 2026,BY CASH,,,100,9600\n'));
  assert.deepEqual(st.rows.map((r) => [r.date, r.narration, r.ref, r.debit]), [['2026-10-22', 'TO TRANSFER-UPI/DR/1234/ GUPTA TRANSPORT/SBIN/', 'TRANSFER TO 123', 50_000], ['2026-10-23', 'BY CASH', '', 0]]);

  st = statement(csv('Tran Date,Particulars,Amount,DR/CR,Balance\n22-10-2026,STEEL CO,125000,DR,375000\n22-10-2026,MEHTA,80000,CR,455000\n'));
  assert.deepEqual(st.rows.map((r) => [r.debit, r.credit]), [[12_500_000, 0], [0, 8_000_000]]);
});

test('a file that isn’t a statement gets a clear message', () => {
  assert.throws(() => statement(csv('Name,Amount\nA,1\n')), /doesn’t look like a bank statement/);
  assert.throws(() => statement(csv('Date,Narration,Debit,Credit\n')), /No transactions found/);
});

// ── matching ──
test('matching: by bill no. in the narration, by name, or by amount when it can’t be anything else', () => {
  const st = statement(fixture('hdfc-statement.xlsx'), 'hdfc.xlsx');
  const pays = [P(1, 'Steel Co', 12_500_000, '2026-10-25', 'BILL-2291'), P(2, 'Office rent', 4_500_050, '2026-10-21', '', null), P(3, 'Gupta Transport', 820_000, '2026-10-22', 'GT-9', null),
    P(4, 'Office Supplies', 450_000, '2026-10-20'), P(5, 'Sharma & Sons', 1_000_000, '2026-10-22')];
  const m = matchStatement(st.rows.filter((r) => r.debit), pays, 1);
  assert.deepEqual(m.map((l) => [l.row, l.match]), [
    [11, { id: 1, how: 'ref', partial: false }], [12, { id: 3, how: 'name', partial: false }], [13, { id: 4, how: 'amount', partial: false }], [14, null]]);
});

test('matching: two payments of the same amount and no name → not guessed; the choices are offered', () => {
  const lines = [{ row: 1, date: '2026-10-22', narration: 'UPI-XYZ', ref: '', debit: 100_000 }];
  const m = matchStatement(lines, [P(1, 'Alpha', 100_000, '2026-10-22'), P(2, 'Beta', 100_000, '2026-10-21'), P(3, 'Gamma', 50_000, '2026-10-22')], 1);
  assert.equal(m[0].match, null);
  assert.deepEqual(m[0].candidates.sort(), [1, 2]);
});

test('matching: a part payment only when the narration names it; the name beats the amount', () => {
  const lines = [{ row: 1, date: '2026-10-22', narration: 'NEFT DR-KUMAR PACKAGING-PART', ref: '', debit: 30_000 }, { row: 2, date: '2026-10-22', narration: 'IMPS-SOMEONE', ref: '', debit: 40_000 }];
  const m = matchStatement(lines, [P(7, 'Kumar Packaging Pvt Ltd', 100_000, '2026-10-22'), P(8, 'Other', 30_000, '2026-10-22'), P(9, 'Big Co', 90_000, '2026-10-22')], 1);
  assert.deepEqual(m[0].match, { id: 7, how: 'name', partial: true });
  assert.equal(m[1].match, null); // 40,000 isn't anyone's amount and names no one
  assert.equal(similarity({ narration: 'NEFT-CO LTD', ref: '' }, { name: 'Steel Co Ltd', ref: '' }).name, 0); // "co", "ltd" say nothing
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
    return { status: r.status, body: await r.json() };
  };
};
const admin = session(), editor = session(), viewer = session();
const today = todayIST(), yday = addDays(today, -1), dmy = (d) => d.split('-').reverse().join('/');
const stmt = csv(`Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
${dmy(yday)},NEFT DR-STEEL CO PVT LTD-N295123456-BILL 2291,N295123456,"1,25,000.00",,"3,75,000.00"
${dmy(yday)},IMPS-229512345678-GUPTA TRANSPORT-SBIN,229512345678,8200.00,,"3,66,800.00"
${dmy(yday)},UPI-AB ENTERPRISE-123456789012,123456789012,4500.00,,"3,62,300.00"
${dmy(yday)},SERVICE CHARGES - NEFT GST,,59.00,,"3,62,241.00"
${dmy(yday)},NEFT CR-MEHTA RETAIL,N29400001,,80000.00,"4,42,241.00"
`);
const send = (who, path, extra = {}, buf = stmt) => who(`/api/reconcile/${path}`, { file: buf.toString('base64'), name: 'hdfc.csv', bank_id: hdfc, ...extra });
const pay = async (payee, amount, date, extra = {}) => (await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee, amount, date, category: 'Vendor', ...extra })).body.id;
let hdfc, ids = {};

test('API setup: an account, the sheet’s payments, an EMI', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'v@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'v@x.in', password: 'viewerpass12' });
  hdfc = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC Bank', last4: '1111' })).body.id;
  await admin('/api/balances', { bank_id: hdfc, amount: '5,00,000', as_of: addDays(today, -5) });
  ids.steel = await pay('Steel Co', '1,25,000', yday, { bank_id: hdfc, ref: 'BILL-2291' });
  ids.gupta = await pay('Gupta Transport', '8,200', yday);
  ids.supplies = await pay('Office Supplies', '4,500', addDays(today, -3), { bank_id: hdfc });
  ids.rent = await pay('Office rent', '45,000', yday, { bank_id: hdfc });
  ids.sharma = await pay('Sharma & Sons', '10,000', addDays(today, -2));
  ids.later = await pay('Later Co', '1,000', addDays(today, 10), { bank_id: hdfc });
  await admin('/api/emis', { lender: 'Car loan', amount: '5,000', bank_id: hdfc, start_date: yday });
  ids.emi = (await pool.query("SELECT id FROM payments WHERE payee = 'Car loan' AND due_date = $1", [yday])).rows[0].id;
});

test('check: matches the statement, lists what is due, changes nothing', async () => {
  const r = await send(editor, 'check');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.deepEqual([d.bank.name, d.from, d.to, d.closing], ['HDFC Current', yday, yday, { date: yday, amount: 44_224_100 }]); // the last line is the ₹80,000 credit
  assert.equal(d.appClosing, 50_000_000);
  assert.deepEqual(d.credits, { count: 1, amount: 8_000_000 });
  assert.deepEqual(d.debits.map((x) => [x.amount, x.match?.id ?? null, x.match?.how ?? null, x.recorded]), [
    [12_500_000, ids.steel, 'ref', null], [820_000, ids.gupta, 'name', null], [450_000, ids.supplies, 'amount', null], [5_900, null, null, null]]);
  // due by the statement's day, for this account or not decided: the matched three, rent, Sharma, the EMI — not Later Co
  assert.deepEqual(d.due.sort((a, b) => a - b), [ids.steel, ids.gupta, ids.supplies, ids.rent, ids.sharma, ids.emi].sort((a, b) => a - b));
  assert.equal(await (await pool.query("SELECT count(*)::int AS n FROM entries")).rows[0].n, 0);
});

test('apply: refuses what doesn’t add up', async () => {
  const bad = async (extra) => (await send(editor, 'apply', extra)).body.error?.message;
  assert.match(await bad({ matches: [{ row: 2, id: ids.rent }] }), /statement shows ₹1,25,000, more than the ₹45,000 left to pay/);
  assert.match(await bad({ matches: [{ row: 2, id: ids.steel }, { row: 3, id: ids.steel }] }), /matched to two statement rows/);
  assert.match(await bad({ matches: [{ row: 6, id: ids.steel }] }), /isn’t a payment out/);
  assert.match(await bad({ leftOut: [{ id: ids.emi, action: 'today' }] }), /EMI instalment: it keeps its due date/);
  assert.match(await bad({}), /Nothing chosen/);
  assert.equal((await send(viewer, 'check')).status, 403);
  assert.equal((await send(viewer, 'apply', { leftOut: [{ id: ids.rent, action: 'cancel' }] })).status, 403);
  assert.equal(await (await pool.query("SELECT count(*)::int AS n FROM entries")).rows[0].n, 0); // nothing half-done
});

test('apply: matched debits are paid (only these leave the balance); left-out ones move or are cancelled', async () => {
  const r = await send(editor, 'apply', {
    matches: [{ row: 2, id: ids.steel }, { row: 3, id: ids.gupta }, { row: 4, id: ids.supplies }],
    record: [{ row: 5, payee: 'HDFC bank charges' }],
    leftOut: [{ id: ids.rent, action: 'today' }, { id: ids.sharma, action: 'tomorrow' }, { id: ids.emi, action: 'cancel' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { paid: 3, paidAmount: 13_770_000, recorded: 1, recordedAmount: 5_900, today: 1, tomorrow: 1, cancelled: 1, balanceSaved: false });
  const { rows: e } = await pool.query("SELECT p.payee, e.amount, e.date, e.ref, e.bank_id FROM entries e JOIN payments p ON p.id = e.payment_id ORDER BY e.id");
  assert.deepEqual(e.map((x) => [x.payee, Number(x.amount), x.date, x.ref, x.bank_id]), [
    ['Steel Co', 12_500_000, yday, 'N295123456', hdfc], ['Gupta Transport', 820_000, yday, '229512345678', hdfc], ['Office Supplies', 450_000, yday, '123456789012', hdfc],
    ['HDFC bank charges', 5_900, yday, 'SERVICE CHARGES - NEFT GST', hdfc]]);
  const sum = (await editor(`/api/transactions/summary?bank=${hdfc}&from=${addDays(today, -4)}&to=${today}`)).body.total;
  assert.equal(sum.closing, 50_000_000 - 13_770_000 - 5_900);
  const { rows: p } = await pool.query('SELECT id, due_date, status FROM payments WHERE id = ANY($1::int[]) ORDER BY id', [[ids.rent, ids.sharma, ids.emi, ids.later]]);
  assert.deepEqual(Object.fromEntries(p.map((x) => [x.id, [x.due_date, x.status]])), { [ids.rent]: [today, 'OPEN'], [ids.sharma]: [addDays(today, 1), 'OPEN'], [ids.emi]: [yday, 'CANCELLED'], [ids.later]: [addDays(today, 10), 'OPEN'] });
  const log = (await admin('/api/activity?type=reports')).body.activity.find((a) => a.action === 'reconcile.apply');
  assert.deepEqual([log.user_name, log.detail.bank, log.detail.paid, log.detail.cancelled, log.detail.file], ['Eli', 'HDFC Current', 3, 1, 'hdfc.csv']);
});

test('the same statement again: everything is already in the app, nothing is paid twice', async () => {
  const d = (await send(editor, 'check')).body;
  assert.ok(d.debits.every((x) => x.recorded && x.recorded.by === 'reference'), JSON.stringify(d.debits));
  assert.match((await send(editor, 'apply', { matches: [{ row: 2, id: ids.rent }] })).body.error.message, /already in the app/);
});

test('a payment marked paid by hand with another reference is recognised by amount and date', async () => {
  const id = await pay('Hand Paid', '777', yday, { bank_id: hdfc });
  await editor(`/api/payments/${id}/settle`, { bank_id: hdfc, ref: 'MY-OWN-REF', date: yday });
  const s2 = csv(`Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n${dmy(yday)},CHQ PAID-000123,000123,777.00,,"1,000.00"\n`);
  const d = (await send(editor, 'check', {}, s2)).body;
  assert.deepEqual(d.debits[0].recorded, { payment_id: id, by: 'amount and date', ref: 'MY-OWN-REF', date: yday });
});

test('saving the statement’s closing balance makes the app match the bank', async () => {
  const s3 = csv(`Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n${dmy(today)},NEFT CR-MEHTA,N1,,80000.00,"4,40,000.00"\n`);
  const r = await send(admin, 'apply', { saveBalance: true }, s3);
  assert.deepEqual([r.status, r.body.balanceSaved], [200, true]);
  assert.equal((await editor(`/api/transactions/summary?bank=${hdfc}&from=${today}&to=${today}`)).body.total.closing, 44_000_000);
  // a statement with dates after today is refused
  const future = csv(`Date,Narration,Withdrawal Amt.\n${dmy(addDays(today, 2))},X,1\n`);
  assert.match((await send(editor, 'check', {}, future)).body.error.message, /dates after today/);
});

// ── PDF statements, pasted statements, and the names banks cut short ──
const { readPdf } = await import('../server/pdf.js');
const { makePdf } = await import('./pdf-maker.js');
const SBI = [[40, 520, 'STATE BANK OF INDIA', 12], [40, 500, 'Account Statement from 1 Oct 2026 to 22 Oct 2026'],
  [40, 470, 'Txn Date'], [100, 470, 'Value Date'], [170, 470, 'Description'], [420, 470, 'Ref No./Cheque No.'], [560, 470, 'Debit'], [640, 470, 'Credit'], [720, 470, 'Balance'],
  [40, 450, '21 Oct 2026'], [100, 450, '21 Oct 2026'], [170, 450, 'TO TRANSFER-INB IMPS/P2A/629469827904/'], [420, 450, 'MAA DURGA'], [555, 450, '12,500.00'], [715, 450, '1,87,500.00'],
  [170, 440, 'MAA DURGA TRANSPORT'],
  [40, 425, '22 Oct 2026'], [100, 425, '22 Oct 2026'], [170, 425, 'BY TRANSFER-NEFT*HDFC0000001*MEHTA RETAIL'], [637, 425, '50,000.00'], [715, 425, '2,37,500.00'],
  [40, 405, '22 Oct 2026'], [100, 405, '22 Oct 2026'], [170, 405, 'IMPS CHARGES'], [565, 405, '5.90'], [715, 405, '2,37,494.10'],
  [40, 380, '**** END OF STATEMENT ****']];

test('PDF: an IDBI e-statement email saved with Chrome’s “Save as PDF” (dates and particulars on two lines, headings on two lines, two pages)', async () => {
  const st = readStatement(await readPdf(fixture('idbi-email-statement.pdf')));
  assert.deepEqual(st.columns, { date: 'Post-date', narration: 'Particulars', ref: 'Chq. No.', debit: 'Withdrawals', credit: 'Deposits', balance: 'Balance' });
  assert.deepEqual([st.from, st.to, st.closing, st.skipped], ['2026-10-21', '2026-10-21', { date: '2026-10-21', amount: 200_444_053 }, []]);
  assert.equal(st.rows.length, 19); // "BROUGHT FORWARD" has no amount
  assert.deepEqual([st.rows.filter((r) => r.debit).length, st.rows.filter((r) => r.credit).length], [16, 3]);
  const r = st.rows.find((x) => x.ref === '967709');
  assert.deepEqual([r.narration, r.debit, r.balance], ['AT 191-DELHI - LAJPAT NAGAR ,NEFT-ICIC0000191-EUDD 11 SR', 17_014_900, 208_449_859]);
  assert.equal(st.rows[1].narration, 'AT 191-DELHI - LAJPAT NAGAR ,NEFT-HDFCH01344033888-MS SUNNY MEDICAL STORE'); // joined across lines
  assert.equal(st.rows[2].narration, 'AT 191-DELHI - LAJPAT NAGAR ,NEFT-JAKAH26294008447-NOBLE ENTERPRISES PROP A'); // no space after a hyphen
});

test('PDF: a locked statement (SBI layout) opens with its password; a picture-only PDF says what to do instead', async () => {
  const locked = makePdf(SBI, { password: 'CUST1234' });
  await assert.rejects(readPdf(locked), (e) => e.code === 'pdf_password' && /locked with a password/.test(e.message));
  await assert.rejects(readPdf(locked, 'nope'), (e) => e.code === 'pdf_password' && /didn’t open/.test(e.message));
  const st = readStatement(await readPdf(locked, 'CUST1234'));
  assert.deepEqual(st.rows.map((x) => [x.date, x.narration, x.ref, x.debit, x.credit]), [
    ['2026-10-21', 'TO TRANSFER-INB IMPS/P2A/629469827904/MAA DURGA TRANSPORT', 'MAA DURGA', 1_250_000, 0],
    ['2026-10-22', 'BY TRANSFER-NEFT*HDFC0000001*MEHTA RETAIL', '', 0, 5_000_000], ['2026-10-22', 'IMPS CHARGES', '', 590, 0]]);
  await assert.rejects(readPdf(makePdf(SBI, { shapesOnly: true })), (e) => e.code === 'pdf_no_text' && /Microsoft Print to PDF/.test(e.message) && /paste the statement table/.test(e.message));
  await assert.rejects(readPdf(makePdf([[40, 500, 'Hello'], [40, 480, 'Not a statement']])), /No statement table found/);
});

test('pasted from the bank’s email: tab-separated, with account details above', () => {
  const text = 'Name\t: EXAMPLE NUTRIENTS\nAccount No.\t: 0191100000099999\n\nPost-date\tParticulars\tChq. No.\tWithdrawals\tDeposits\tBalance\n'
    + '21-10-2026\tAT ,BROUGHT FORWARD\t\t\t\t21,44,089.85\n21-10-2026\tAT 191-DELHI ,NEFT-PUNB0486700-GEETA SHAH\t967708\t18,000.00\t\t21,26,089.85\n'
    + '21-10-2026\tAT 191-DELHI ,UPI/870008483904/PRINCE VERMA\t\t\t40,000.00\t21,66,089.85\n';
  const st = statement(csv(text), 'pasted statement.txt');
  assert.deepEqual(st.rows.map((x) => [x.ref, x.debit, x.credit]), [['967708', 1_800_000, 0], ['', 0, 4_000_000]]);
  assert.deepEqual(st.closing, { date: '2026-10-21', amount: 216_608_985 });
});

test('names banks cut short count; a shared surname alone doesn’t', async () => {
  const l = (narration) => ({ narration, ref: '' });
  assert.equal(similarity(l('NEFT-UTIB0005503-ANKIT KUMA'), { name: 'Ankit Kumar' }).name, 1);
  assert.ok(similarity(l('NEFT-IDIB000S534-SOMYA RANJ'), { name: 'Somya Ranjan' }).name >= 0.5);
  assert.equal(similarity(l('NEFT-UBIN0549916-MOHKAN SIN'), { name: 'Mohkan Singh' }).name, 1);
  assert.ok(similarity(l('NEFT-SBIN0001188-AJAY KUMAR'), { name: 'Shiv Kumar' }).name < 0.5); // only "Kumar"
  assert.ok(similarity(l('NEFT-KKBK0005303-HARJEET'), { name: 'Harjeet Singh' }).name >= 0.5);
  assert.equal(similarity({ narration: 'AT 191 ,SUNITA', ref: '967712' }, { name: 'Someone', ref: 'CHQ 967712' }).ref, true); // the cheque number
  // the whole IDBI statement against a purchase sheet: each name finds its line; lines not in the sheet stay unmatched
  const st = readStatement(await readPdf(fixture('idbi-email-statement.pdf')));
  const sheet = [[1, 'Geeta Shah', 1_800_000], [2, 'Ankit Kumar', 4_200_000], [3, 'Somya Ranjan', 2_333_000], [4, 'Harjeet Singh', 3_800_000], [5, 'Mohkan Singh', 720_000],
    [6, 'Sunita Devi', 2_542_200, 'CHQ 967712'], [7, 'Rahul Dev', 2_756_000], [8, 'Shiv Kumar', 1_089_000], [9, 'Ajay Kumar', 297_000], [10, 'Unpaid Vendor', 500_000]]
    .map(([id, name, amt, ref]) => P(id, name, amt, '2026-10-21', ref ?? ''));
  const m = matchStatement(st.rows.filter((x) => x.debit), sheet, 1);
  assert.deepEqual(Object.fromEntries(m.filter((x) => x.match).map((x) => [x.match.id, x.match.how])),
    { 1: 'name', 2: 'name', 3: 'name', 4: 'name', 5: 'name', 6: 'ref', 7: 'name', 8: 'name', 9: 'name' });
  assert.equal(m.filter((x) => !x.match).length, 7); // 4 bank charges, EUDD, MONU, SAIYAM SAINI: not in the sheet
});

test('API: a locked PDF asks for its password, then reconciles', async () => {
  const idbi = (await admin('/api/banks', { name: 'SBI Current', bank: 'State Bank of India', last4: '4321' })).body.id;
  await pay('Maa Durga Transport', '12,500', '2026-10-21', { bank_id: idbi });
  const body = { file: makePdf(SBI, { password: 'CUST1234' }).toString('base64'), name: 'sbi.pdf', bank_id: idbi };
  let r = await editor('/api/reconcile/check', body);
  assert.deepEqual([r.status, r.body.error.code], [400, 'pdf_password']);
  r = await editor('/api/reconcile/check', { ...body, password: 'CUST1234' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const line = r.body.debits.find((x) => x.amount === 1_250_000);
  assert.equal(line.match.how, 'name');
  r = await editor('/api/reconcile/apply', { ...body, password: 'CUST1234', matches: [{ row: line.row, id: line.match.id }] });
  assert.deepEqual([r.status, r.body.paid, r.body.paidAmount], [200, 1, 1_250_000]);
  assert.equal((await editor('/api/reconcile/apply', { ...body, matches: [{ row: line.row, id: line.match.id }] })).body.error.code, 'pdf_password');
});

test('API: a statement file of a realistic size (hundreds of KB) is accepted', async () => {
  const pdf = fixture('idbi-email-statement.pdf');
  assert.ok(pdf.length > 100_000);
  const r = await editor('/api/reconcile/check', { file: pdf.toString('base64'), name: 'idbi.pdf', bank_id: hdfc });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.debits.length, 16);
});
