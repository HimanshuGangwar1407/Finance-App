import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { readTable } from '../server/sheet.js';
import { readStatement, matchStatement, similarity, guessPayee, accountOf } from '../server/reconcile.js';
import { tableFromLines } from '../server/ai.js';
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

test('the account number above the table: its last 4 digits; never a number in the lines, never another field', () => {
  assert.deepEqual(statement(fixture('hdfc-statement.xlsx'), 'hdfc.xlsx').account, { last4: '1111' }); // "Account No :50200012341111"
  for (const [text, last4] of [['Account No :50200012341111', '1111'], ['IDBI Bank Statement Of A/c : 0191100000099999', '9999'], ['A/C No. XXXXXXXX4321', '4321'],
    ['Account Number \'XXXX XXXX 5678', '5678'], ['Acct No: 1234-5678-0042 Customer ID: 998877', '0042'], ['Account Name : X', null], ['Account Branch : SECTOR 18 NOIDA', null],
    ['Account Statement from 1 Oct 2026 to 22 Oct 2026', null]]) {
    assert.deepEqual(accountOf([text])?.last4 ?? null, last4, text);
  }
  // a beneficiary's account in a narration ("…-XXXXXXXX1234-…") isn't the statement's
  assert.equal(statement(csv('Date,Narration,Debit,Credit,Balance\n21/10/2026,IMPS-GUPTA-SBIN-XXXXXXXX1234-FREIGHT,500,,9500\n')).account, null);
  // what the AI read comes with the account number it saw
  assert.deepEqual(readStatement(tableFromLines([['Date', 'Narration', 'Ref', 'Withdrawal', 'Deposit', 'Balance'], ['21/10/2026', 'X', '', '5.00', '', '95.00']], 'XXXXXXXX7777')).account, { last4: '7777' });
});

test('matching: a payment assigned to another account isn’t matched by itself — it is only offered', () => {
  const lines = [{ row: 1, date: '2026-10-22', narration: 'NEFT DR-STEEL CO PVT LTD-BILL 2291', ref: '', debit: 100_000 }, { row: 2, date: '2026-10-22', narration: 'UPI-XYZ', ref: '', debit: 50_000 }];
  const m = matchStatement(lines, [P(1, 'Steel Co', 100_000, '2026-10-22', 'BILL-2291', 2), P(2, 'Gamma', 50_000, '2026-10-22', '', 2)], 1);
  assert.deepEqual(m.map((l) => [l.match, l.candidates]), [[null, [1]], [null, [2]]]);
  // the same payments on this account (or not decided) are matched as before
  assert.deepEqual(matchStatement(lines, [P(1, 'Steel Co', 100_000, '2026-10-22', 'BILL-2291', 1), P(2, 'Gamma', 50_000, '2026-10-22', '', null)], 1).map((l) => l.match?.how), ['ref', 'amount']);
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
  assert.deepEqual(d.credits.map((x) => [x.amount, x.payee, x.match, x.recorded]), [[8_000_000, 'MEHTA RETAIL', null, null]]); // money in: no receipt expected for it
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
  assert.deepEqual(r.body, { paid: 3, paidAmount: 13_770_000, recorded: 1, recordedAmount: 5_900, today: 1, tomorrow: 1, cancelled: 1,
    received: 0, receivedAmount: 0, recordedIn: 0, recordedInAmount: 0, inToday: 0, inTomorrow: 0, inCancelled: 0, balanceSaved: false,
    assigned: 1, assignedIn: 0 }); // Gupta Transport had no account: it is HDFC's now
  assert.equal((await pool.query('SELECT bank_id FROM payments WHERE id = $1', [ids.gupta])).rows[0].bank_id, hdfc);
  const { rows: e } = await pool.query("SELECT p.payee, e.amount, e.date, e.ref, e.bank_id FROM entries e JOIN payments p ON p.id = e.payment_id ORDER BY e.id");
  assert.deepEqual(e.map((x) => [x.payee, Number(x.amount), x.date, x.ref, x.bank_id]), [
    ['Steel Co', 12_500_000, yday, 'N295123456', hdfc], ['Gupta Transport', 820_000, yday, '229512345678', hdfc], ['Office Supplies', 450_000, yday, '123456789012', hdfc],
    ['HDFC bank charges', 5_900, yday, `SERVICE CHARGES - NEFT GST ${yday.replace(/-/g, '')}`, hdfc]]); // no reference of its own: the narration and the date
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
  // the account is found from the statement's "Account No. : 0191100000099999" (its last 4 digits)
  const idbi = (await admin('/api/banks', { name: 'IDBI Collections', bank: 'IDBI Bank', last4: '9999' })).body.id;
  const r = await editor('/api/reconcile/check', { file: pdf.toString('base64'), name: 'idbi.pdf' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.debits.length, 16);
  assert.deepEqual([r.body.bank.id, r.body.account], [idbi, { last4: '9999', by: 'statement', agrees: true }]);
});

// ── a picture-only PDF read with OCR (in the browser), and the running-balance check ──
const { tableFromPages, ocrPages } = await import('../server/pdf.js');
const ocrWords = () => JSON.parse(fixture('idbi-ocr-words.json').toString('utf8'));

test('OCR words of an IDBI statement (as the browser reads them) make the same statement, every line confirmed', () => {
  const st = readStatement(tableFromPages(ocrPages(ocrWords())));
  assert.deepEqual(st.columns, { date: 'Post-date', narration: 'Particulars', ref: 'Chq. No.', debit: 'Withdrawals', credit: 'Deposits', balance: 'Balance' });
  assert.deepEqual([st.rows.length, st.checked, st.closing, st.opening], [19, { ok: 19, of: 19 }, { date: '2026-10-21', amount: 200_444_053 }, 214_408_985]);
});

test('OCR slips that are put right: two amounts read as one word, a date whose hyphen was lost, “Cha: No.” for “Chq. No.”', () => {
  const W = (x, y, s, w = s.length * 4.5) => ({ x, y, w, h: 8, s });
  const page = { top: 800, words: [
    W(54, 700, 'Post-'), W(55, 690, 'date'), W(206, 695, 'Particulars'), W(378, 700, 'Cha:'), W(381, 690, 'No.'), W(406, 695, 'Withdrawals'), W(466, 695, 'Deposits'), W(524, 695, 'Balance'),
    W(45, 670, '21-10-'), W(45, 660, '2026'), W(83, 665, 'AT'), W(95, 665, 'BROUGHT'), W(139, 665, 'FORWARD'), W(510, 665, '21,44,089.85', 56),
    W(45, 640, '21-10'), W(45, 630, '2026'), W(83, 635, 'NEFT-SUNNY'), W(130, 635, 'STORE'), W(465, 635, '20,288.0021,64,377.85', 101), // deposit and balance as one word
    W(45, 610, '21-10-'), W(45, 600, '2026'), W(83, 605, 'GEETA'), W(110, 605, 'HHAH'), W(371, 605, '967708', 26), W(412, 605, '18,000.00', 43), W(510, 605, '21,46,377.85', 56),
  ] };
  const st = readStatement(tableFromPages(ocrPages([page])));
  assert.equal(st.columns.ref, 'Cha: No.');
  assert.deepEqual(st.rows.map((r) => [r.date, r.narration, r.ref, r.debit, r.credit, r.balance]), [
    ['2026-10-21', 'NEFT-SUNNY STORE', '', 0, 2_028_800, 216_437_785], ['2026-10-21', 'GEETA HHAH', '967708', 1_800_000, 0, 214_637_785]]);
  assert.deepEqual(st.checked, { ok: 2, of: 2 });
  assert.throws(() => ocrPages('nope'), /couldn’t be read/);
  assert.throws(() => ocrPages([{ top: 'x', words: [] }]), /couldn’t be read/);
});

test('a line that doesn’t add up with the running balance is flagged and never matched by itself', () => {
  const words = ocrWords();
  const w = words.flatMap((p) => p.words).find((x) => x.s === '25,422.00');
  w.s = '25,472.00'; // a misread 2 → 7
  const st = readStatement(tableFromPages(ocrPages(words)));
  assert.deepEqual(st.checked, { ok: 18, of: 19 });
  const bad = st.rows.find((r) => r.mismatch);
  assert.deepEqual([bad.debit, bad.mismatch], [2_547_200, { expected: 237_890_585, shown: 237_895_585 }]);
  const m = matchStatement([bad], [P(1, 'Sunita', 2_547_200, '2026-10-21', 'CHQ 967712')], 1);
  assert.equal(m[0].match, null); // even with its cheque no. and the same amount
  assert.deepEqual(m[0].candidates, [1]); // but it can be chosen by hand
  // an ordinary CSV is checked the same way
  const c = statement(csv('Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n21/10/2026,A,100.00,,900.00\n21/10/2026,B,50.00,,860.00\n'));
  assert.deepEqual([c.checked, c.rows[1].mismatch], [{ ok: 1, of: 2 }, { expected: 85_000, shown: 86_000 }]);
});

test('API: a picture PDF’s OCR words are checked and applied like any statement', async () => {
  const pdf = makePdf(SBI, { shapesOnly: true }); // what arrives: the picture PDF, and the words read from it
  const body = { file: pdf.toString('base64'), name: 'AMINORICH IDBI.pdf', ocr: ocrWords() }; // the account: from the words read (A/c …9999)
  assert.equal((await editor('/api/reconcile/check', { ...body, ocr: undefined })).body.error.code, 'pdf_no_text');
  const r = await editor('/api/reconcile/check', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ocr, r.body.checked, r.body.debits.length, r.body.debits.every((d) => d.mismatch === null)], [true, { ok: 19, of: 19 }, 16, true]);
  assert.deepEqual([r.body.bank.name, r.body.account.last4], ['IDBI Collections', '9999']);
  assert.equal((await editor('/api/reconcile/check', { ...body, ocr: [{ top: 800, words: [{ x: 'a' }] }] })).status, 400);
});

test('API: a photo of a statement (JPG / PNG) with the words read from it is checked like any statement; one that isn’t a statement says so', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const r = await editor('/api/reconcile/check', { file: png.toString('base64'), name: 'IMG_2041.png', ocr: ocrWords() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ocr, r.body.checked, r.body.debits.length, r.body.bank.name], [true, { ok: 19, of: 19 }, 16, 'IDBI Collections']);
  // a photo with no statement table in it: a plain message, and marked as one this app can't read (Docsumo is offered)
  const W = (x, y, s) => ({ x, y, w: s.length * 5, h: 9, s });
  const greeting = await editor('/api/reconcile/check', { file: png.toString('base64'), name: 'greeting.jpg', ocr: [{ top: 800, words: [W(60, 400, 'Happy'), W(100, 400, 'Diwali')] }] });
  assert.deepEqual([greeting.status, greeting.body.error.detail], [400, { unreadable: true }]);
  assert.match(greeting.body.error.message, /No statement table found in this picture/);
});

test('the browser’s OCR files are served by the app, and the page may run them (WebAssembly) but nothing else', async () => {
  for (const [p, type] of [['/vendor/pdf.min.mjs', 'text/javascript'], ['/vendor/pdf.worker.min.mjs', 'text/javascript'], ['/vendor/tesseract.min.js', 'text/javascript'],
    ['/vendor/tesseract-worker.min.js', 'text/javascript'], ['/vendor/tesseract-core-simd-lstm.wasm.js', 'text/javascript'], ['/vendor/eng.traineddata.gz', 'application/octet-stream']]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.ok(r.headers.get('content-type').startsWith(type), p);
  }
  assert.equal((await fetch(`${base}/vendor/../server/index.js`)).status, 404);
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(csp, /unsafe-inline|'unsafe-eval'/);
});

// ── an HDFC net-banking statement PDF: headings only on page 1, the address block and footer on every page,
//    descriptions wrapping across lines and pages, a reversal printed as a negative withdrawal ──
function hdfcPdf() {
  const block = [[34, 545, 'M/S. EXAMPLE PRIVATE LIMITED'], [340, 548, 'Account Branch : SECTOR 18 NOIDA'], [403, 540, 'NOIDA'],
    [34, 530, 'KAILASH ENCLAVE PART-1'], [340, 530, 'OD Limit'], [397, 530, ': 0.00'], [34, 505, 'From : 01/10/2026'], [154, 505, 'To : 24/10/2026'], [340, 505, 'Statement of account']];
  const footer = [[28, 50, 'HDFC BANK LIMITED'], [28, 41, '*Closing balance includes funds earmarked for hold and uncleared funds']];
  const amt = (right, s, y) => [right - s.length * 4.5, y, s, 8];
  // one statement line: date, description lines, ref, withdrawal / deposit, balance
  // (8 pt, as the bank prints it)
  const line = (y, date, desc, ref, wd, dep, bal) => [[34, y, date, 8], ...desc.map((d, i) => [d.startsWith('~') ? 68 : 72, y - 17 * i, d.replace('~', ''), 8]),
    [353 - ref.length * 4.5, y, ref, 8], [362, y, date, 8], ...(wd ? [amt(470, wd, y)] : []), ...(dep ? [amt(548, dep, y)] : []), amt(627, bal, y)];
  const page1 = [...block, [40, 485, 'Date'], [144, 485, 'Narration'], [284, 485, 'Chq./Ref.No.'], [362, 485, 'Value Dt'], [405, 485, 'Withdrawal Amt.'], [491, 485, 'Deposit Amt.'], [564, 485, 'Closing Balance'],
    ...line(467, '01/10/26', ['CASH DEPOSIT BY - RAMESH - GURDASPUR ROA', 'D PATHANKOT'], '000000000000000', '', '15,800.00', '1,015,800.00'),
    ...line(433, '01/10/26', ['RTGS DR-JAKA0SHARAN-SHRI SAI LOGISTICS.-', 'ANSALS ARCAD-HDFCR52026100166151258'], '0000000000002151', '561,805.00', '', '453,995.00'),
    ...line(399, '01/10/26', ['RTGS CR-IBKL0000191-EXAMPLE-EXAMPLE', '~PRIV', 'ATE LIMITED-IBKLR92026100100044771'], 'IBKLR92026100100', '', '600,000.00', '1,053,995.00'), [326, 365, '044771', 8],
    ...line(348, '06/10/26', ['RTGS DR-KKBK0004629-ALPHAFACTS HEALTH'], '0000000000002154', '500,000.00', '', '553,995.00'),
    ...footer];
  const page2 = [...block, [68, 490, 'SO', 8], [72, 473, 'LUTIONS -ANSALS ARCAD-HDFCR5202610066810', 8], [72, 456, '4539', 8],
    ...line(439, '07/10/26', ['NEFT DR-UBIN0931675-UNIFY LABELS AND INN', 'OVATIONS PVT LTD-ANSALS', '~ARCAD-HDFCH0131', '5718991'], '0000000000002160', '44,406.00', '', '509,589.00'),
    ...line(371, '08/10/26', ['NEFT DR-KKBK0004585-SAROJ', '~BIOTECH-ANSALS'], '0000000000002153', '48,050.00', '', '461,539.00'),
    ...line(337, '13/10/26', ['BULK NEFT- EXAMPLE PRIVATE LIMITED DR -'], '0000000000002169', '265,285.00', '', '196,254.00'),
    ...line(320, '13/10/26', ['REVERSAL BULK NEFT- EXAMPLE PRIVATE', '~LIMI'], '0000000000002169', '-265,285.00', '', '461,539.00'),
    ...line(286, '14/10/26', ['BULK SALARY-EXAMPLE PRIVATE LIMITED DR'], '0000000000002169', '265,285.00', '', '196,254.00'),
    ...footer];
  const page3 = [...block, ...line(490, '23/10/26', ['RTGS DR-ICIC0001353-TITAN BIOTECH LTD-A'], '0000000000001903', '16,250.00', '', '180,004.00'),
    [60, 440, 'STATEMENT SUMMARY :-'], [100, 425, 'Opening Balance'], [300, 425, 'Dr Count'], [100, 410, '1,000,000.00'], [300, 410, '7'], [100, 380, 'Generated On: 24-Oct-2026 12:26'], ...footer];
  return makePdf({ pages: [page1, page2, page3] });
}

test('PDF: an HDFC statement — every line on every page, nothing from the page header or footer, the running balance confirms all', async () => {
  const st = readStatement(await readPdf(hdfcPdf()));
  assert.deepEqual(st.columns, { date: 'Date', narration: 'Narration', ref: 'Chq./Ref.No.', debit: 'Withdrawal Amt.', credit: 'Deposit Amt.', balance: 'Closing Balance' });
  assert.deepEqual([st.rows.length, st.checked, st.skipped, st.from, st.to, st.closing], [10, { ok: 10, of: 10 }, [], '2026-10-01', '2026-10-23', { date: '2026-10-23', amount: 18_000_400 }]);
  assert.deepEqual([st.rows.filter((r) => r.debit).length, st.rows.filter((r) => r.credit).length], [7, 3]);
  const by = (re) => st.rows.find((r) => re.test(r.narration));
  // carried over to page 2, and put back together from the bank's 40-character pieces
  assert.equal(by(/ALPHAFACTS/).narration, 'RTGS DR-KKBK0004629-ALPHAFACTS HEALTH SOLUTIONS -ANSALS ARCAD-HDFCR52026100668104539');
  assert.equal(by(/UNIFY/).narration, 'NEFT DR-UBIN0931675-UNIFY LABELS AND INNOVATIONS PVT LTD-ANSALS ARCAD-HDFCH0131 5718991'); // and a wrapped 7-digit number (a piece one short of the width keeps its space)
  assert.equal(by(/RTGS CR/).narration, 'RTGS CR-IBKL0000191-EXAMPLE-EXAMPLE PRIVATE LIMITED-IBKLR92026100100044771');
  assert.equal(by(/CASH DEPOSIT/).narration, 'CASH DEPOSIT BY - RAMESH - GURDASPUR ROAD PATHANKOT');
  assert.deepEqual([by(/SAROJ/).debit, by(/SAROJ/).date], [4_805_000, '2026-10-08']);
  assert.equal(by(/RTGS CR/).ref, 'IBKLR92026100100 044771');
  assert.ok(st.rows.every((r) => !/NOIDA|KAILASH|HDFC BANK LIMITED|Statement of account|SUMMARY/.test(r.narration)));
});

test('a reversal (a negative withdrawal) is money back, and it cancels the payment it reverses — that one is never matched', async () => {
  const st = readStatement(await readPdf(hdfcPdf()));
  const [bulk, rev, salary] = st.rows.filter((r) => r.ref === '0000000000002169');
  assert.deepEqual([bulk.debit, bulk.reversedBy, rev.credit, rev.debit, rev.reverses, salary.debit, salary.reversedBy], [26_528_500, rev.row, 26_528_500, 0, bulk.row, 26_528_500, undefined]);
  const m = matchStatement([bulk, salary], [P(1, 'Example Private Limited salaries', 26_528_500, '2026-10-14')], 1);
  assert.equal(m[0].match, null);
  assert.deepEqual(m[0].candidates, []); // the reversed one can't even be chosen
  assert.equal(m[1].match.id, 1); // the salary that went through is
  // and on amount alone too: the reversed line of the same amount doesn't make it ambiguous
  assert.deepEqual(matchStatement([bulk, salary], [P(2, 'Staff salaries', 26_528_500, '2026-10-13')], 1)[1].match, { id: 2, how: 'amount', partial: false });
});

test('the name a statement debit is recorded under, from its narration', () => {
  for (const [narration, payee] of [
    ['NEFT DR-KKBK0004585-SAROJ BIOTECH-ANSALS ARCAD-HDFCH01315780237', 'SAROJ BIOTECH'],
    ['RTGS DR-JAKA0SHARAN-SHRI SAI LOGISTICS.-ANSALS ARCAD-HDFCR52026100166151258', 'SHRI SAI LOGISTICS.'],
    ['UPI-WARSI PHARMA-8958678808@PTYES-PUNB0363300-316057346656-SENT USING PAYTM U', 'WARSI PHARMA'],
    ['IMPS-628367942372-CHARMING PUPPIES-YESB-XXXXXXXXXXX0452-IFB', 'CHARMING PUPPIES'],
    ['AT 191-DELHI - LAJPAT NAGAR ,NEFT-PUNB0486700-GEETA HHAH', 'GEETA HHAH'],
    ['AT 191-DELHI - LAJPAT NAGAR ,SUNITA', 'SUNITA'],
    ['AT 191-DELHI - LAJPAT NAGAR ,NEFT-CHARGE-DR-IBKL26102199181', 'Bank charges'],
    ['FT - DR - 50100231612823 - NEELAM SHARMA', 'NEELAM SHARMA'],
    ['CHQ PAID-TRANSFER IN-BABA TRANSPORT CO', 'BABA TRANSPORT CO'],
    ['RAJEEV - CHQ PAID - ANSALS ARCAD', 'RAJEEV'],
    ['EHREZVU1ZR0KX6/EPFO', 'EPFO'], ['06126142079091/ESIC', 'ESIC'],
    ['KYQHS4UEANZ2LPOVDY/PAYUFACEBOOK', 'PAYUFACEBOOK'], ['011026I049903378 DPO2727408602841 IGST', 'IGST'],
    ['50200078706901-TPT-NBANWGBNGMP8AVT9-AE 1 FASHION HOUSE PRIVATE LIMITED', 'AE 1 FASHION HOUSE PRIVATE LIMITED'],
    ['GST/BANK REFERENCE NO: R2629376501077/CI N NO: HDFC26100500049069', 'GST'],
    ['IB BILLPAY DR-HDFC1P-442145XXXXXX0858', 'Bill payment (net banking)'],
    ['BULK SALARY-EXAMPLE PRIVATE LIMITED DR', 'Salaries (bulk)'],
    ['SOMETHING UNUSUAL', 'SOMETHING UNUSUAL'], ['', 'Bank debit'],
  ]) assert.equal(guessPayee(narration), payee, narration);
});

test('API: record every statement debit not in the app at once — each under its name; a reversed one is refused', async () => {
  const id = (await admin('/api/banks', { name: 'HDFC Bulk', bank: 'HDFC Bank', last4: '7777' })).body.id;
  const body = { file: hdfcPdf().toString('base64'), name: 'hdfc.pdf', bank_id: id };
  const d = (await editor('/api/reconcile/check', body)).body;
  const open = d.debits.filter((x) => !x.recorded && !x.match);
  const reversed = open.find((x) => x.reversedBy);
  assert.ok(reversed);
  assert.deepEqual(open.filter((x) => !x.reversedBy).map((x) => x.payee).sort(),
    ['ALPHAFACTS HEALTH SOLUTIONS', 'SAROJ BIOTECH', 'SHRI SAI LOGISTICS.', 'Salaries (bulk)', 'TITAN BIOTECH LTD', 'UNIFY LABELS AND INNOVATIONS PVT LTD']);
  assert.match((await editor('/api/reconcile/apply', { ...body, record: [{ row: reversed.row }] })).body.error.message, /reversed by the bank/);
  const all = open.filter((x) => !x.reversedBy);
  const r = await editor('/api/reconcile/apply', { ...body, record: all.map((x) => ({ row: x.row })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.recorded, r.body.recordedAmount], [6, all.reduce((n, x) => n + x.amount, 0)]);
  const { rows } = await pool.query("SELECT p.payee, p.amount, e.date FROM payments p JOIN entries e ON e.payment_id = p.id WHERE e.bank_id = $1 ORDER BY e.date, p.id", [id]);
  assert.deepEqual(rows.map((x) => x.payee), ['SHRI SAI LOGISTICS.', 'ALPHAFACTS HEALTH SOLUTIONS', 'UNIFY LABELS AND INNOVATIONS PVT LTD', 'SAROJ BIOTECH', 'Salaries (bulk)', 'TITAN BIOTECH LTD']);
  // the same statement again: all of them now already in the app; the reversed one still just shown
  const again = (await editor('/api/reconcile/check', body)).body.debits.filter((x) => !x.recorded);
  assert.deepEqual(again.map((x) => x.row), [reversed.row]);
});

test('PDF: an IDBI email with its columns packed tight (the date 1.5 pt from the particulars, “Chq. No.” 1.4 pt from “Withdrawals”)', () => {
  // the text pieces and places pdf.js gives for such a statement (the wording made up)
  const T = (x, y, w, s) => ({ x, y, w, h: 9, s });
  const page = [T(50.2, 553.9, 21.8, 'Name'), T(103.5, 553.9, 178.7, ': EXAMPLE HEALTH SOLUTIONS BVBA'), T(50.2, 517.9, 17.3, 'Date'), T(99.1, 517.9, 132.4, ': From:23-10-2026 To:23-10-2026'),
    T(47.2, 470.7, 36.4, 'Post-date'), T(163.9, 470.7, 41.3, 'Particulars'), T(283.3, 470.7, 32.9, 'Chq. No.'), T(317.6, 470.7, 47, 'Withdrawals'), T(375, 470.7, 33.8, 'Deposits'), T(429.6, 470.7, 30.7, 'Balance'),
    T(45, 446.7, 40.9, '23-10-2026'), T(87.4, 446.7, 96.9, 'AT ,BROUGHT FORWARD'), T(419.2, 446.7, 51.5, '1,85,024.31'),
    T(45, 414.4, 40.9, '23-10-2026'), T(87.4, 414.4, 194.4, 'AT 9990-ETPC ,HDFCR52026102375837779 VET-KPI'), T(366.2, 414.4, 51.5, '4,00,000.00'), T(419.2, 414.4, 51.5, '5,85,024.31'),
    T(43.5, 391.9, 22.6, 'Note :'), T(68.4, 391.9, 161.9, 'Clearing credits are subject to realisation.')];
  const t = tableFromPages([page]);
  assert.deepEqual(t.rows[0].cells, ['Post-date', 'Particulars', 'Chq. No.', 'Withdrawals', 'Deposits', 'Balance']);
  const st = readStatement(t);
  assert.deepEqual(st.rows.map((r) => [r.date, r.narration, r.debit, r.credit, r.balance]), [['2026-10-23', 'AT 9990-ETPC ,HDFCR52026102375837779 VET-KPI', 0, 40_000_000, 58_502_431]]);
  assert.deepEqual([st.opening, st.checked], [18_502_431, { ok: 1, of: 1 }]);
});

// ── money in: receipts reconciled too, for the bank's actual position ──
test('who money came from, from the narration', () => {
  for (const [narration, payer] of [
    ['9004193861-MANKIND PHARMA LIMITED R N BR', 'MANKIND PHARMA LIMITED'],
    ['CASH DEPOSIT BY - RANISH - GURDASPUR ROAD PATHANKOT', 'Cash deposit (RANISH)'],
    ['INW 011026I049903378 EUR16330.0@106.31', 'Inward remittance (EUR)'],
    ['CHQ DEP - CTS CLG2 - NOIDA - CTS CLG2 -: BAXI MEDICAL STORE :INDIAN OVERSEAS BANK', 'BAXI MEDICAL STORE'],
    ['NEFT CR-SBIN0004266-EPAO CUSTOMS DUTY DRAWBACK PAYMENTS-EXAMPLE PRIVATE LIMITED-SBIC300359490828', 'EPAO CUSTOMS DUTY DRAWBACK PAYMENTS'],
    ['FT - CR - 99999810773791 - VET-KPI', 'VET-KPI'], ['EXAMPLE PRIVATE LIMITED CR - 50200076549894 - GHENT NUTRITION', 'GHENT NUTRITION'],
    ['AT 9990-ETPC ,HDFCR52026102375837779 VET-KPI', 'VET-KPI'], ['UPI-WARSI PHARMA-8958678808@PTYES-PUNB0363300-316057346656-SENT USING PAYTM U', 'WARSI PHARMA'],
  ]) assert.equal(guessPayee(narration), payer, narration);
});

test('a returned cheque (“CHQ DEP RET”) cancels the deposit it returns: neither is a receipt or a payment', () => {
  const st = statement(csv('Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n'
    + '09/10/26,CHQ DEP - TRANSFER OW 1 - NOIDA WBO: VET-KPI :HDFC BANK LTD,0000000000002002,,50000.00,150000.00\n'
    + '09/10/26,CHQ DEP RET- DRAWER SIGNATURE DIFFERS,0000000000002002,50000.00,,100000.00\n'));
  const [dep, ret] = st.rows;
  assert.deepEqual([dep.credit, dep.reversedBy, ret.debit, ret.reverses], [5_000_000, ret.row, 5_000_000, dep.row]);
  assert.equal(matchStatement([dep], [P(1, 'VET-KPI', 5_000_000, '2026-10-09')], 1, 'credit')[0].match, null);
  assert.equal(matchStatement([ret], [P(2, 'Anyone', 5_000_000, '2026-10-09')], 1)[0].match, null);
});

test('API: money in — receipts found in the statement are received, new ones recorded, the missing one moved; the app then matches the bank', async () => {
  const bank = (await admin('/api/banks', { name: 'Receipts Bank', bank: 'HDFC Bank', last4: '4444' })).body.id;
  await admin('/api/balances', { bank_id: bank, amount: '1,00,000', as_of: addDays(today, -5) });
  const rec = async (party, amount, x = {}) => (await editor('/api/transactions', { kind: 'IN', status: 'pending', party, amount, date: yday, bank_id: bank, ...x })).body.id;
  const ids = { mankind: await rec('Mankind Pharma Ltd', '1,07,365'), baxi: await rec('Baxi Medical Store', '14,417'), late: await rec('Late Customer', '20,000'),
    saroj: await pay('Saroj Biotech', '48,050', yday, { bank_id: bank }) };
  const s = csv(`Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
${dmy(yday)},9004193861-MANKIND PHARMA LIMITED R N BR,0000610018639090,,"1,07,365.00","2,07,365.00"
${dmy(yday)},CHQ DEP - CTS CLG2 - NOIDA - CTS CLG2 -: BAXI MEDICAL STORE :INDIAN OVERSEAS BANK,0000000000559812,,"14,417.00","2,21,782.00"
${dmy(yday)},CASH DEPOSIT BY - RANISH - GURDASPUR ROAD PATHANKOT,000000000000000,,"15,800.00","2,37,582.00"
${dmy(yday)},CHQ DEP - TRANSFER OW 1 - NOIDA WBO: VET-KPI :HDFC BANK LTD,0000000000002002,,"50,000.00","2,87,582.00"
${dmy(yday)},CHQ DEP RET- DRAWER SIGNATURE DIFFERS,0000000000002002,"50,000.00",,"2,37,582.00"
${dmy(yday)},NEFT DR-KKBK0004585-SAROJ BIOTECH-ANSALS ARCAD-HDFCH01315780237,0000000000002153,"48,050.00",,"1,89,532.00"
${dmy(yday)},SERVICE CHARGES - NEFT GST,,59.00,,"1,89,473.00"
`);
  const body = { file: s.toString('base64'), name: 'hdfc.csv', bank_id: bank };
  const d = (await editor('/api/reconcile/check', body)).body;
  assert.deepEqual(d.credits.map((x) => [x.amount, x.match?.id ?? null, x.match?.how ?? null, x.payee, Boolean(x.reversedBy)]), [
    [10_736_500, ids.mankind, 'name', 'MANKIND PHARMA LIMITED', false], [1_441_700, ids.baxi, 'name', 'BAXI MEDICAL STORE', false],
    [1_580_000, null, null, 'Cash deposit (RANISH)', false], [5_000_000, null, null, 'VET-KPI', true]]);
  assert.ok(d.dueIn.includes(ids.late) && d.receipts.some((r) => r.id === ids.late));
  const cheque = d.credits.find((x) => x.reversedBy), charges = d.debits.find((x) => /SERVICE/.test(x.narration)), cash = d.credits.find((x) => /CASH/.test(x.narration));
  assert.match((await editor('/api/reconcile/apply', { ...body, recordIn: [{ row: cheque.row }] })).body.error.message, /reversed by the bank/);

  const r = await editor('/api/reconcile/apply', { ...body,
    matches: [{ row: d.debits.find((x) => x.match).row, id: ids.saroj }], record: [{ row: charges.row }],
    matchesIn: d.credits.filter((x) => x.match).map((x) => ({ row: x.row, id: x.match.id })), recordIn: [{ row: cash.row }], leftOutIn: [{ id: ids.late, action: 'tomorrow' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.paid, r.body.recorded, r.body.received, r.body.receivedAmount, r.body.recordedIn, r.body.recordedInAmount, r.body.inTomorrow], [1, 1, 2, 12_178_200, 1, 1_580_000, 1]);
  // the app now shows the bank's actual position: its balance is the statement's closing balance
  const sum = (await editor(`/api/transactions/summary?bank=${bank}&from=${addDays(today, -4)}&to=${yday}`)).body.total;
  assert.equal(sum.closing, 18_947_300);
  const { rows } = await pool.query("SELECT party, expected_date, (SELECT sum(amount) FROM entries e WHERE e.receipt_id = r.id)::bigint AS got FROM receipts r WHERE bank_id = $1 ORDER BY id", [bank]);
  assert.deepEqual(rows.map((x) => [x.party, x.expected_date, Number(x.got ?? 0)]), [
    ['Mankind Pharma Ltd', yday, 10_736_500], ['Baxi Medical Store', yday, 1_441_700], ['Late Customer', addDays(today, 1), 0], ['Cash deposit (RANISH)', yday, 1_580_000]]);
  // the same statement again: everything already in the app, except the returned cheque and its return
  const again = (await editor('/api/reconcile/check', body)).body;
  assert.deepEqual([...again.debits, ...again.credits].filter((x) => !x.recorded).map((x) => x.narration.slice(0, 12)).sort(), ['CHQ DEP - TR', 'CHQ DEP RET-']);
});
