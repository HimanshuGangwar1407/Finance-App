// Bank statement reconciliation: read a statement (the same .xlsx / .csv reader as the upload) and match its debits
// to payments yet to be paid. Pure functions; the routes in index.js do the database work.
import { parseDate } from './sheet.js';
import { toPaise, str, normRef } from './money.js';

const bad = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_argument' }); };
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// statement columns, by heading (first match wins); banks name them differently
const COLUMNS = {
  date: ['txndate', 'transactiondate', 'trandate', 'date', 'postdate', 'postingdate', 'valuedate', 'valuedt', 'dt'],
  narration: ['narration', 'description', 'particulars', 'transactiondetails', 'transactionremarks', 'transactiondescription', 'details', 'remarks', 'transactionparticulars'],
  ref: ['chqrefno', 'chequerefno', 'refnochequeno', 'chqno', 'chequeno', 'chequenumber', 'refno', 'referenceno', 'reference', 'utrno', 'utr', 'transactionid', 'tranid', 'refchqno', 'chano', 'chgno', 'cheqno', 'chqnumber'],
  debit: ['withdrawalamt', 'withdrawalamtinr', 'withdrawalamountinr', 'withdrawalamount', 'withdrawal', 'withdrawals', 'debit', 'debitamount', 'debitamt', 'debitinr', 'dr', 'debits', 'amountdebited'],
  credit: ['depositamt', 'depositamtinr', 'depositamountinr', 'depositamount', 'deposit', 'deposits', 'credit', 'creditamount', 'creditamt', 'creditinr', 'cr', 'credits', 'amountcredited'],
  amount: ['amount', 'amountinr', 'transactionamount', 'txnamount', 'amountrs'],
  drcr: ['drcr', 'crdr', 'type', 'debitcredit', 'transactiontype'],
  balance: ['closingbalance', 'balance', 'balanceinr', 'availablebalance', 'runningbalance'],
};
export function matchHeader(cells) {
  const heads = cells.map(norm), used = new Set(), cols = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    for (const name of names) {
      const i = heads.findIndex((x, j) => x === name && !used.has(j));
      if (i >= 0) { cols[key] = i; used.add(i); break; }
    }
  }
  return cols.date != null && (cols.debit != null || (cols.amount != null && cols.drcr != null)) ? cols : null;
}

// the account number printed above the table ("Account No :50200012341111", "Statement Of A/c : 0191…",
// "A/C No. XXXXXXXX1111"): its last 4 digits, or null. Never from the lines themselves (they name other accounts).
// The number may be masked and written in groups ("XXXX XXXX 5678", "1234-5678-0042").
const ACCOUNT_NO = /\b(?:a\/?c|account|acct)\.?(?:\s*(?:no|number|num)\b\.?)?\s*[:.#-]?\s*'?([x*\d]{2,}(?:[ -][x*\d]{2,})*)/i;
export function accountOf(texts) {
  for (const t of texts) {
    const m = ACCOUNT_NO.exec(String(t ?? '').replace(/\s+/g, ' '));
    if (!m) continue;
    const groups = m[1].split(/[ -]/); // a short number after it ("… 10/23/26") isn't part of it
    while (groups.length > 1 && !/\d{4}$/.test(groups.at(-1))) groups.pop();
    if (/\d{4}$/.test(groups.at(-1))) return { last4: groups.at(-1).slice(-4) };
  }
  return null;
}

// a statement amount: 1,25,000.00 · ₹500 · "500.00 Dr" · a number; empty → 0
function money(v) {
  if (typeof v === 'number') return Math.abs(v) < 1e13 ? Math.round(Math.abs(v) * 100) : null; // (null: not understood, as for text that isn't an amount)
  const s = String(v ?? '').trim().replace(/\s*(dr|cr)\.?$/i, '');
  if (!s || s === '-') return 0;
  try { return Math.abs(toPaise(s.replace(/^\((.*)\)$/, '$1'), 'Amount', { allowNegative: true })); } catch { return null; }
}

/**
 * The statement's transactions, oldest first: { row, date, narration, ref, debit, credit, balance } (paise).
 * Skips opening / closing balance lines and joins narration that runs onto the next line.
 */
export function readStatement(table) {
  const top = table.rows.slice(0, 60);
  const at = top.findIndex((r) => matchHeader(r.cells));
  if (at < 0) bad('This doesn’t look like a bank statement: no heading row with a date and a withdrawal / debit amount column was found. Download the statement from net banking as Excel (.xlsx) or CSV.');
  const header = top[at], cols = matchHeader(header.cells);
  const cell = (r, k) => (cols[k] == null ? '' : r.cells[cols[k]] ?? '');
  const text = (r, k, max) => str(typeof cell(r, k) === 'number' ? String(cell(r, k)) : cell(r, k), max);
  const rows = [], skipped = [];
  for (const r of table.rows.slice(table.rows.indexOf(header) + 1)) {
    const rawDate = cell(r, 'date'), narration = text(r, 'narration', 300);
    if (rows.length && r.cells.some((x) => /^\s*(statement\s+summary|summary|opening\s+balance|closing\s+balance|total)\b/i.test(String(x))) && !parseDate(rawDate, table.base1904)) break; // the summary under the transactions
    if (rawDate === '' || rawDate == null) {
      // narration carried onto the next line
      if (narration && rows.length && money(cell(r, 'debit')) === 0 && money(cell(r, 'credit')) === 0) rows.at(-1).narration = str(`${rows.at(-1).narration} ${narration}`, 300);
      continue;
    }
    if (/^(opening|closing)\s+balance|^(statement\s+)?summary|^total/i.test(`${narration} ${rawDate}`.trim())) continue;
    const date = parseDate(rawDate, table.base1904);
    if (!date) { if (/\d/.test(String(rawDate))) skipped.push({ row: r.n, why: `date “${String(rawDate).slice(0, 20)}” not understood` }); continue; }
    let debit, credit;
    if (cols.debit != null) {
      debit = money(cell(r, 'debit')); credit = money(cell(r, 'credit'));
      // a reversal printed as a negative withdrawal ("-265,285.00") is money coming back, and the other way round
      const neg = (k) => /^\s*(-|\()/.test(String(cell(r, k)));
      if (debit != null && credit != null && (neg('debit') || neg('credit'))) [debit, credit] = [(neg('debit') ? 0 : debit) + (neg('credit') ? credit : 0), (neg('credit') ? 0 : credit) + (neg('debit') ? debit : 0)];
    } else {
      const a = money(cell(r, 'amount')), t = String(cell(r, 'drcr')).trim();
      debit = /^(d|dr|debit|withdrawal)/i.test(t) ? a : 0; credit = /^(c|cr|credit|deposit)/i.test(t) ? a : 0;
    }
    if (debit == null || credit == null) { skipped.push({ row: r.n, why: 'amount not understood' }); continue; }
    const bal = cols.balance != null && String(cell(r, 'balance')).trim() !== '' ? money(cell(r, 'balance')) : null;
    if (!debit && !credit && bal == null) continue;
    const neg = /dr$|^-|^\(/i.test(String(cell(r, 'balance')).trim()); // an overdrawn balance
    const reversal = cols.debit != null && (/^\s*(-|\()/.test(String(cell(r, 'debit'))) || /^\s*(-|\()/.test(String(cell(r, 'credit')))) || /^\s*reversal\b|\bRET(URN|URNED)?\b/i.test(narration); // a reversal, or a returned cheque ("CHQ DEP RET-…")
    rows.push({ row: r.n, date, narration, ref: text(r, 'ref', 80).replace(/^0+$/, ''), debit, credit, balance: bal == null ? null : neg ? -bal : bal, ...(reversal ? { reversal: true } : {}) });
  }
  // oldest first: by date, or (all on one day) by whichever order the running balance agrees with
  const fits = (list) => list.reduce((n, r, i) => n + (i > 0 && list[i - 1].balance != null && r.balance != null && list[i - 1].balance - r.debit + r.credit === r.balance ? 1 : 0), 0);
  if (rows.length > 1 && (rows[0].date > rows.at(-1).date || (rows[0].date === rows.at(-1).date && fits([...rows].reverse()) > fits(rows)))) rows.reverse();
  // the running balance: each line's balance is the one before it − withdrawal + deposit. A line that doesn't
  // add up has a figure misread or missing (likeliest when read from a picture): it is flagged, never matched by itself.
  let prev = null;
  for (const r of rows) {
    if (r.balance != null && prev != null && prev - r.debit + r.credit !== r.balance) r.mismatch = { expected: prev - r.debit + r.credit, shown: r.balance };
    if (r.balance != null) prev = r.balance;
  }
  // a reversal cancels the earlier line with the same reference and amount (a payment the bank sent back): neither is
  // a payment made, so neither is matched
  rows.forEach((rv, i) => {
    if (!rv.reversal) return;
    const amt = rv.credit || rv.debit, ref = normRef(rv.ref);
    const orig = rows.slice(0, i).reverse().find((x) => !x.reversal && !x.reversedBy && (rv.credit ? x.debit : x.credit) === amt && (!ref || normRef(x.ref) === ref));
    if (orig) { orig.reversedBy = rv.row; rv.reverses = orig.row; }
  });
  const opening = rows.find((r) => r.balance != null && !r.debit && !r.credit);
  rows.splice(0, rows.length, ...rows.filter((r) => r.debit || r.credit));
  if (!rows.length) bad('No transactions found under the statement’s headings.');
  if (rows.length > 5000) bad('That statement has more than 5,000 transactions. Upload a shorter period.');
  const found = Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, String(header.cells[i])]));
  const last = rows.at(-1);
  const withBal = rows.filter((r) => r.balance != null);
  // the account it is for: from the lines above the headings (a PDF's or the AI's come as table.head)
  const account = accountOf([...(table.head ?? []), ...table.rows.slice(0, table.rows.indexOf(header)).map((r) => r.cells.join(' '))]);
  return { headerRow: header.n, columns: found, rows, skipped, account, from: rows[0].date, to: last.date, closing: last.balance == null ? null : { date: last.date, amount: last.balance },
    opening: opening ? opening.balance : null,
    // how many lines the running balance confirms (null: the statement has no balance column)
    checked: withBal.length ? { ok: withBal.filter((r) => !r.mismatch).length, of: withBal.length } : null };
}

// words that say nothing about who was paid
const STOP = new Set(['ltd', 'limited', 'pvt', 'private', 'co', 'company', 'and', 'the', 'india', 'ms', 'mr', 'mrs', 'shri', 'sri', 'llp', 'inc', 'corp', 'corporation', 'enterprises', 'traders', 'trading', 'services', 'bank']);
// surnames shared by many people: on their own they don't say who was paid ("AJAY KUMAR" is not Shiv Kumar)
const COMMON = new Set(['kumar', 'kumari', 'singh', 'sharma', 'verma', 'gupta', 'devi', 'lal', 'ram', 'das', 'yadav', 'jain', 'khan', 'ali', 'prasad', 'chand', 'rani', 'bai', 'patel', 'shah', 'mishra', 'pandey', 'chauhan', 'agarwal', 'aggarwal', 'thakur', 'rao', 'reddy', 'nair', 'joshi', 'mehta', 'malik', 'ahmed', 'mohammad', 'mohd', 'md']);
const tokens = (name) => String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

/**
 * How well a statement line names a payment: { name: 0…1, ref: true if its bill / cheque / reference number appears }.
 * Banks cut names short ("ANKIT KUMA", "SOMYA RANJ"), so a word the narration ends early still counts.
 */
export function similarity(line, p) {
  const hay = norm(`${line.narration} ${line.ref}`);
  const words = String(`${line.narration} ${line.ref}`).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && /[a-z]/.test(w));
  const found = (t) => hay.includes(t) || words.some((w) => t.startsWith(w));
  const toks = tokens(p.name), weight = (t) => (COMMON.has(t) ? 0.4 : 1);
  const total = toks.reduce((n, t) => n + weight(t), 0), hit = toks.filter(found);
  let name = total ? hit.reduce((n, t) => n + weight(t), 0) / total : 0;
  const whole = norm(p.name);
  if (whole.length >= 5 && hay.includes(whole)) name = 1;
  if (name > 0 && name < 1 && !hit.some((t) => t.length >= 4 && !COMMON.has(t))) name /= 2; // only short or common words matched
  const r = normRef(p.ref), lineRef = normRef(line.ref);
  // a cheque / UTR number written with words around it ("CHQ 967712", "UTR: 4512...") still counts
  const nums = String(p.ref ?? '').match(/\d{5,}/g)?.map((n) => n.replace(/^0+/, '')) ?? [];
  const lineNums = new Set(String(`${line.narration} ${line.ref}`).match(/\d{5,}/g)?.map((n) => n.replace(/^0+/, '')) ?? []);
  const ref = (r.length >= 3 && (hay.includes(r.toLowerCase()) || lineRef === r)) || nums.some((n) => lineNums.has(n));
  return { name, ref };
}

/**
 * Statement debits ↔ payments yet to be paid (outstanding = what is left on each). Every debit gets
 *   match: { id, how: 'ref' | 'name' | 'amount', partial } — or null, with candidates: payment ids it could be.
 * A match on amount alone is made only when it can't be anything else (one debit and one payment of that amount).
 * A payment assigned to another account (its last 4 digits aren't this statement's) is never matched by itself: it
 * is only offered to choose by hand.
 */
export function matchStatement(debits, payments, bankId, key = 'debit') {
  // a line's amount; a line that doesn't add up, or a reversal pair, is never matched by itself
  const amt = (d) => d[key], off = (d) => d.mismatch || d.reversedBy || d.reverses;
  const here = payments.filter((p) => p.bank_id == null || p.bank_id === bankId), isHere = new Set(here);
  const pairs = [];
  for (const d of debits) {
    if (off(d)) continue;
    for (const p of here) {
      if (amt(d) > p.outstanding) continue;
      const s = similarity(d, p), exact = amt(d) === p.outstanding;
      const strong = s.ref || s.name >= 0.5;
      if (!exact && !strong) continue; // part payments only when the line names the payment
      const score = (s.ref ? 3 : 0) + 2 * s.name + (exact ? 1 : 0) + (p.bank_id === bankId ? 0.3 : 0.1) - Math.min(days(d.date, p.due_date), 60) / 100;
      pairs.push({ d, p, score, how: s.ref ? 'ref' : s.name >= 0.5 ? 'name' : 'amount', partial: !exact });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.d.row - b.d.row || a.p.id - b.p.id);
  const usedD = new Set(), usedP = new Set(), out = new Map();
  for (const x of pairs) {
    if (x.how === 'amount') continue; // second pass
    if (usedD.has(x.d.row) || usedP.has(x.p.id)) continue;
    usedD.add(x.d.row); usedP.add(x.p.id);
    out.set(x.d.row, { id: x.p.id, how: x.how, partial: x.partial });
  }
  // amount only: when exactly one free debit and one free payment have that amount
  // (a line the bank reversed isn't a payment: it doesn't make another line of the same amount ambiguous)
  const freeD = debits.filter((d) => !usedD.has(d.row) && !d.reversedBy && !d.reverses), freeP = here.filter((p) => !usedP.has(p.id));
  for (const d of freeD) {
    if (off(d)) continue;
    const sameD = freeD.filter((x) => amt(x) === amt(d)), sameP = freeP.filter((p) => p.outstanding === amt(d) && !usedP.has(p.id));
    if (sameD.length === 1 && sameP.length === 1) { usedP.add(sameP[0].id); usedD.add(d.row); out.set(d.row, { id: sameP[0].id, how: 'amount', partial: false }); }
  }
  return debits.map((d) => ({
    ...d,
    match: out.get(d.row) ?? null,
    // to choose by hand: payments of exactly this amount first, then larger ones that name it
    candidates: out.has(d.row) || d.reversedBy || d.reverses ? [] : payments.filter((p) => !usedP.has(p.id) && p.outstanding >= amt(d))
      .map((p) => ({ p, s: similarity(d, p) }))
      .filter(({ p, s }) => p.outstanding === amt(d) || s.ref || s.name > 0)
      .sort((a, b) => (b.p.outstanding === amt(d)) - (a.p.outstanding === amt(d)) || isHere.has(b.p) - isHere.has(a.p) || b.s.name - a.s.name || days(d.date, a.p.due_date) - days(d.date, b.p.due_date))
      .slice(0, 10).map(({ p }) => p.id),
  }));
}

/** a bank reference for a statement line: its own reference, else its narration; unique within the statement */
/**
 * Who a statement debit was paid to, from its narration — the default name when it is recorded as a new payment.
 * "NEFT DR-KKBK0004585-SAROJ BIOTECH-ANSALS ARCAD-…" → "SAROJ BIOTECH"; "UPI-WARSI PHARMA-…" → "WARSI PHARMA";
 * "AT 191-DELHI ,NEFT-PUNB0486700-GEETA HHAH" → "GEETA HHAH"; NEFT / GST charges → "Bank charges".
 */
export function guessPayee(narration) {
  let s = String(narration ?? '').replace(/\s+/g, ' ').trim();
  if (/charge|chrg|chgs|commission|\bfees?\b|service\s*tax|sms\s*alert|min(imum)?\s*bal/i.test(s)) return 'Bank charges';
  s = s.replace(/^AT [^,]*,\s*/i, ''); // IDBI: the branch it went through
  const segs = s.split(/\s*-\s*/).map((x) => x.trim()).filter(Boolean);
  const code = (x) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(x) || /^\d{6,}$/.test(x) || (/^[A-Z0-9]{12,}$/i.test(x) && /\d/.test(x));
  const kind = (segs[0] ?? '').toUpperCase();
  let name = null;
  if (/^(NEFT|RTGS|IMPS)( (DR|CR))?$/.test(kind)) name = segs.slice(1).find((x) => !code(x));
  else if (kind === 'UPI') name = segs[1];
  else if (kind === 'CHQ PAID' && /^TRANSFER IN$/i.test(segs[1] ?? '')) name = segs[2];
  else if (kind === 'FT') name = /^FT\s*-\s*(DR|CR)\s*-\s*\S+\s*-\s*(.+)$/i.exec(s)?.[2] ?? segs.slice(1).reverse().find((x) => !code(x) && !/^(DR|CR)$/i.test(x)); // the name may have a hyphen ("VET-KPI")
  else if ((segs[1] ?? '').toUpperCase() === 'TPT') name = segs.at(-1); // a transfer within the bank: "<account>-TPT-<ref>-<name>"
  else if (/\bIGST$/i.test(s)) name = 'IGST';
  else if (/^[A-Z0-9]{8,}\/([A-Z][A-Z0-9 &.]+)$/i.test(s)) name = /\/([^/]+)$/.exec(s)[1].toUpperCase(); // "<code>/EPFO", "<code>/PAYUFACEBOOK"
  else if (/^GST\//i.test(s)) name = 'GST';
  else if (/^IB BILLPAY/i.test(s)) name = 'Bill payment (net banking)';
  else if (/^BULK SALARY/i.test(s)) name = 'Salaries (bulk)';
  else if (/^BULK NEFT/i.test(s)) name = 'Bulk NEFT';
  else if (/ - CHQ PAID\b/i.test(s)) name = segs[0];
  // money in
  else if (/^CASH DEPOSIT\b/i.test(s)) name = `Cash deposit${segs[1] ? ` (${segs[1]})` : ''}`;
  else if (/^INW\b/i.test(s)) name = `Inward remittance${/\b(USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF)\s?[\d.]/i.test(s) ? ` (${/\b(USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF)/i.exec(s)[1].toUpperCase()})` : ''}`;
  else if (/^CHQ DEP\b.*?:\s*([^:]+?)\s*:/i.test(s)) name = /^CHQ DEP\b.*?:\s*([^:]+?)\s*:/i.exec(s)[1]; // "CHQ DEP - … -: BAXI MEDICAL STORE :INDIAN OVERSEAS BANK"
  else if (/\bCR - \d{6,} - (.+)$/i.test(s)) name = /\bCR - \d{6,} - (.+)$/i.exec(s)[1]; // "… CR - 99999810773791 - VET-KPI"
  else if (/^\d{6,}$/.test(segs[0] ?? '') && segs[1]) name = segs.slice(1).join('-').replace(/\s+R N BR$/i, ''); // "9004193861-MANKIND PHARMA LIMITED R N BR"
  // whatever else: without the long reference codes in it ("HDFCR52026102375837779 VET-KPI" → "VET-KPI")
  if (!name) s = s.replace(/\b[A-Z0-9]*\d[A-Z0-9]{10,}\b/gi, '').replace(/\s+/g, ' ').trim() || s;
  return str((name || s).replace(/^(M\/S\.?|MS)\s+/i, ''), 60) || 'Bank debit';
}

export function lineRef(line, taken) {
  // without a reference of its own, the narration and the date: the same charge next month ("SMS ALERT CHARGES") is
  // another line, not one already recorded. The date without its hyphens, so 2026-01-11 and 2026-11-01 stay apart.
  const day = line.date.replace(/-/g, '');
  let ref = line.ref ? str(line.ref, 70) : `${str(line.narration, 60)} ${day}`.trim();
  if (!normRef(ref.replace(day, ''))) ref = `Statement ${day}`;
  if (taken.has(normRef(ref))) ref = `${line.ref ? str(line.ref, 60) : `${str(line.narration, 48)} ${day}`} (row ${line.row})`;
  taken.add(normRef(ref));
  return ref;
}
