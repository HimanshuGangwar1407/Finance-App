// Statement PDF layouts read without AI: each figure is checked against the running balance.
// All names, references and amounts are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPdf } from '../server/pdf.js';
import { readStatement } from '../server/reconcile.js';
import { makePdf } from './pdf-maker.js';

// an amount right-aligned at `right` (Helvetica digits are about 0.52 em wide)
const amt = (right, s, y, size = 7) => [right - s.length * size * 0.52, y, s, size];
const lines = (st) => st.rows.map((r) => [r.date, r.narration, r.ref, r.debit, r.credit, r.balance]);

// ── HDFC-style: an account-details box whose last lines run into the headings ("RTGS/NEFT IFSC … MICR",
//    "Branch Code", "Account Type"), "Value Dt Withdrawal Amt." printed as one piece of text, a slanted watermark ──
function detailsBesideHeadings() {
  const details = [['Account Branch', 'SAMPLE BRANCH, NOIDA'], ['City', 'NOIDA 201301'], ['Currency', 'INR'], ['Account No', 'XXXXXX000000'],
    ['Account Status', 'ACTIVE'], ['RTGS/NEFT IFSC', 'EXMP0000001'], ['Branch Code', '001'], ['Account Type', 'CURRENT ACCOUNT']]
    .flatMap(([k, v], i) => [[335, 584 - 12 * i, k, 8], [418, 584 - 12 * i, v, 8]]);
  const row = (y, date, desc, ref, wd, dep, bal) => [[30, y, date, 7], [98, y, desc, 7], [310, y, ref, 7], [400, y, date, 7],
    ...(wd ? [amt(484, wd, y)] : []), ...(dep ? [amt(563, dep, y)] : []), amt(610, bal, y)];
  return makePdf([
    [30, 560, 'EXAMPLE TRADING PRIVATE LIMITED', 9], [30, 545, 'PLOT 1, SAMPLE ENCLAVE', 8], ...details, [480.7, 524, 'MICR : 000000000', 8],
    [30, 543 - 12, 'From : 01/10/2026', 8], [487, 543 - 12, 'Statement of account', 9],
    [30, 518, 'Date', 7], [98, 518, 'Narration', 7], [310, 518, 'Chq./Ref.No.', 7], [400, 518, 'Value Dt Withdrawal Amt.', 7], [519.8, 518, 'Deposit Amt.', 7], [555.5, 518, 'Closing Balance', 7],
    ...row(494, '01/10/26', 'NEFT CR-EXAMPLE TRADERS - INVOICE 101', 'TEST0001', '', '150,000.00', '650,000.00'),
    ...row(452, '02/10/26', 'RTGS DR-SAMPLE SUPPLIES PVT LTD', 'TEST0002', '200,000.50', '', '449,999.50'),
    ...row(410, '03/10/26', 'BANK CHARGES - TEST', 'TEST0003', '1,180.00', '', '448,819.50'),
    [150, 380, 'SAMPLE \x95 TEST DATA ONLY', 27, 30], // the watermark, across the table
    ...row(368, '04/10/26', 'IMPS CR-DEMO CLIENT', 'TEST0004', '', '25,000.00', '473,819.50'),
    [30, 320, 'STATEMENT SUMMARY (SAMPLE DATA)', 9], [30, 305, 'Opening Balance', 8], [200, 305, 'INR 500,000.00', 8],
    [30, 24, 'Opening balance for statement: INR 500,000.00', 7],
  ]);
}

test('PDF: account details running into the headings, two headings printed as one, a slanted watermark', async () => {
  const st = readStatement(await readPdf(detailsBesideHeadings()));
  assert.deepEqual(st.columns, { date: 'Date', narration: 'Narration', ref: 'Chq./Ref.No.', debit: 'Withdrawal Amt.', credit: 'Deposit Amt.', balance: 'Closing Balance' });
  assert.deepEqual(lines(st), [
    ['2026-10-01', 'NEFT CR-EXAMPLE TRADERS - INVOICE 101', 'TEST0001', 0, 15_000_000, 65_000_000],
    ['2026-10-02', 'RTGS DR-SAMPLE SUPPLIES PVT LTD', 'TEST0002', 20_000_050, 0, 44_999_950],
    ['2026-10-03', 'BANK CHARGES - TEST', 'TEST0003', 118_000, 0, 44_881_950], // nothing of the watermark
    ['2026-10-04', 'IMPS CR-DEMO CLIENT', 'TEST0004', 0, 2_500_000, 47_381_950],
  ]);
  assert.deepEqual([st.checked, st.skipped, st.closing], [{ ok: 4, of: 4 }, [], { date: '2026-10-04', amount: 47_381_950 }]);
});

// ── a description on two lines with the date row centred between them, "—" for an empty amount, "Withdrawal (Dr.)"
//    / "Deposit (Cr.)" headings, two pages, and a summary box right under the last line ──
function twoLineDescriptions() {
  const heads = [[83.4, 431.8, 'Date', 6.8], [137.2, 431.8, 'Narration', 6.8], [403.7, 431.8, 'Chq./Ref. No.', 6.8],
    [497.2, 431.8, 'Withdrawal (Dr.)', 6.8], [585.1, 431.8, 'Deposit (Cr.)', 6.8], [673, 431.8, 'Closing Balance', 6.8]];
  const row = (y, date, [what, who], ref, wd, dep, bal) => [[83.4, y, date, 6.8], [137.2, y + 4, what, 6.8], [137.2, y - 4, who, 6], [403.7, y, ref, 6.8],
    wd ? amt(577.1, wd, y, 6.8) : [570.3, y, '\x97', 6.8], dep ? amt(664.9, dep, y, 6.8) : [658.2, y, '\x97', 6.8], amt(758.5, bal, y, 6.8)];
  const top = [[318, 548.8, 'SAMPLE BANK STATEMENT', 15], [105.6, 507.1, 'Account Name', 7.5], [182.2, 507.1, 'M/S EXAMPLE TRADING PRIVATE LIMITED', 7.5],
    [34.3, 448.8, 'Opening Balance:', 7.5], [105.9, 448.8, '500,000.00', 7.5]];
  return makePdf({ pages: [
    [...top, ...heads,
      ...row(413.8, '01/10/26', ['NEFT DR - LOGISTICS', 'Example Logistics Pvt Ltd'], 'SMPL0001', '60,000.00', '', '440,000.00'),
      ...row(391.8, '01/10/26', ['NEFT CR - EXPORT RECEIPT', 'Overseas Customer BV'], 'SMPL0002', '', '125,000.25', '565,000.25'),
      [28.3, 17, 'FICTIONAL SAMPLE', 7], [791.4, 17, 'Page 1', 7]],
    [...heads.map(([x, , t, s]) => [x, 554, t, s]),
      ...row(536, '02/10/26', ['CASH DEPOSIT', 'Office Collection'], 'SMPL0003', '', '10,000.00', '575,000.25'),
      ...row(514, '03/10/26', ['RTGS DR - SUPPLIER PAYMENT', 'Demo Biotech Ltd'], 'SMPL0004', '75,000.00', '', '500,000.25'),
      [177.9, 482.9, 'Opening Balance', 7.5], [319.7, 482.9, '500,000.00', 7.5], [373.5, 482.9, 'Debit Count', 7.5], [471.4, 482.9, '2', 7.5],
      [177.9, 461.4, 'Total Withdrawals (Dr.)', 7.5], [315.5, 461.4, '135,000.00', 7.5],
      [28.3, 17, 'FICTIONAL SAMPLE', 7], [791.4, 17, 'Page 2', 7]],
  ] });
}

test('PDF: a description on two lines around its date, a dash for an empty amount, a summary box under the last line', async () => {
  const st = readStatement(await readPdf(twoLineDescriptions()));
  assert.deepEqual(st.columns, { date: 'Date', narration: 'Narration', ref: 'Chq./Ref. No.', debit: 'Withdrawal (Dr.)', credit: 'Deposit (Cr.)', balance: 'Closing Balance' });
  assert.deepEqual(lines(st), [
    ['2026-10-01', 'NEFT DR - LOGISTICS Example Logistics Pvt Ltd', 'SMPL0001', 6_000_000, 0, 44_000_000],
    ['2026-10-01', 'NEFT CR - EXPORT RECEIPT Overseas Customer BV', 'SMPL0002', 0, 12_500_025, 56_500_025],
    ['2026-10-02', 'CASH DEPOSIT Office Collection', 'SMPL0003', 0, 1_000_000, 57_500_025],
    ['2026-10-03', 'RTGS DR - SUPPLIER PAYMENT Demo Biotech Ltd', 'SMPL0004', 7_500_000, 0, 50_000_025], // the summary box isn't part of it
  ]);
  assert.deepEqual([st.checked, st.skipped], [{ ok: 4, of: 4 }, []]);
});
