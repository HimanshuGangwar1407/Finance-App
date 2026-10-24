// HTTP server: the JSON API and the screen in public/. `npm start` runs it on PORT (default 3000).
// Without DATABASE_URL it keeps its data in ./data with an in-process Postgres (PGlite).
//
// The day's position (GET /api/position) is
//   bank balance today − payments due up to the date + receipts expected up to the date
// Overdue items (unpaid or unreceived from earlier days) are counted on the date too.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, withTx, ensureSchema, setPool } from './db.js';
import { finalBalance } from './balance.js';
import { emiDates } from './emi.js';
import { bankStatements } from './ledger.js';
import { toCsv, toXlsx } from './export.js';
import { readTable, importRows, MAX_BYTES } from './sheet.js';
import { readStatement, matchStatement, lineRef, guessPayee } from './reconcile.js';
import { readWithAi, tableFromLines, aiConfigured } from './ai.js';
import { dueReminders, projectDates, coverage, DEFAULT_BEFORE } from './reminders.js';
import { emailConfigured, sendEmail } from './email.js';
import * as A from './auth.js';
import { bad, deny, notFound, toPaise, normRef, str, need, ymd, oneOf, intId, todayIST, addDays, inr } from './money.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
// reading a picture-only statement in the browser: pdf.js draws the pages, Tesseract reads them (scripts/vendor-ocr.js)
for (const [name, type] of [['pdf.min.mjs', 'text/javascript'], ['pdf.worker.min.mjs', 'text/javascript'], ['tesseract.min.js', 'text/javascript'],
  ['tesseract-worker.min.js', 'text/javascript'], ['tesseract-core-simd-lstm.wasm.js', 'text/javascript'], ['eng.traineddata.gz', 'application/octet-stream']]) STATIC[`/vendor/${name}`] = [`vendor/${name}`, type];
const RANK = { viewer: 0, editor: 1, admin: 2 };
const MAX_FAILS = 5, LOCK_MS = 15 * 60000;
const DUMMY_HASH = A.hashPassword(crypto.randomBytes(12).toString('hex')); // unknown emails take as long as wrong passwords

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const audit = (c, uid, action, detail) => c.query('INSERT INTO audit (user_id, action, detail) VALUES ($1, $2, $3)', [uid, action, JSON.stringify(detail)]);
const email = (v) => { const s = str(v, 200).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) bad('Enter a valid email address.'); return s; };
const optBank = (v) => (v === '' || v == null ? null : intId(v, 'Account'));
const notFuture = (d, label) => { if (d > todayIST()) bad(`${label} can’t be in the future.`); return d; };
async function bankExists(c, id) { if (id != null && !(await c.query('SELECT 1 FROM banks WHERE id = $1', [id])).rowCount) bad('That account doesn’t exist.'); return id; }
const log = (uid, action, detail) => audit({ query: q }, uid, action, detail); // outside a transaction

// what changed (kept in the activity log as {field: [before, after]})
const changes = (before, after) => Object.fromEntries(Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, [before[k], after[k]]]));
// a unique name/email clash becomes a readable message
const unique = (message) => (e) => { throw e.code === 'conflict' ? err(409, 'conflict', message) : e; };
const likeTerm = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const ROLES = ['viewer', 'editor', 'admin'];
// a user an admin is about to change: never themselves (for role / access), and never the last active admin
async function userForChange(c, id, me, { notSelf } = {}) {
  const { rows: [u] } = await c.query('SELECT id, name, email, role, active FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
  if (!u) notFound('That user doesn’t exist.');
  if (notSelf && u.id === me) bad(notSelf);
  return u;
}
const lastAdmin = async (c, u) => u.role === 'admin' && u.active && Number((await c.query("SELECT count(*) AS n FROM users WHERE role = 'admin' AND active")).rows[0].n) <= 1;

// activity log filters: a type is the part of the action before the dot (older entries — people, positions, invites,
// sign-ups, account.* — keep their own names and stay findable)
const ACTIVITY_TYPES = { signin: ['login', 'logout', 'setup', 'admin'], people: ['person'], positions: ['position'], payments: ['payment'], receipts: ['receipt'], emis: ['emi'], balances: ['balance'], accounts: ['bank'], users: ['user', 'account', 'password', 'access', 'invite', 'signup'], reports: ['report', 'import', 'reconcile'] };
const istStart = (d) => new Date(`${d}T00:00:00+05:30`).toISOString();

// makes each active EMI's instalments into payments, up to `through` (once each: a cancelled one stays cancelled)
async function syncEmis(c, through) {
  const { rows } = await c.query('SELECT id, day, start_date, end_date FROM emis WHERE active');
  const ids = [], dates = [];
  for (const e of rows) for (const d of emiDates(e, through)) { ids.push(e.id); dates.push(d); }
  if (!ids.length) return;
  await c.query(`INSERT INTO payments (payee, ref, category, amount, due_date, bank_id, approved, note, emi_id, created_by)
    SELECT e.lender, e.ref, 'Loan / EMI', e.amount, x.d, e.bank_id, true, 'EMI', e.id, e.created_by
    FROM unnest($1::int[], $2::date[]) AS x(id, d) JOIN emis e ON e.id = x.id
    ON CONFLICT (emi_id, due_date) WHERE emi_id IS NOT NULL DO NOTHING`, [ids, dates]);
}

// db: the pool, or a transaction's client
async function position(db, { today, upTo, approvedOnly = false, uncertain = true }) {
  const sql = [
    'SELECT id, name, bank, last4 FROM banks ORDER BY name, id',
    'SELECT id, bank_id, amount, as_of FROM balances',
    "SELECT id, party, ref, amount, expected_date, certainty, bank_id, status FROM receipts WHERE status = 'OPEN'",
    `SELECT p.id, p.payee, p.ref, p.category, p.amount, p.due_date, p.bank_id, p.approved, p.status, p.emi_id, (p.due_date - e.hold_days) AS hold_from
       FROM payments p LEFT JOIN emis e ON e.id = p.emi_id WHERE p.status = 'OPEN'`,
    'SELECT kind, receipt_id, payment_id, bank_id, amount, date FROM entries',
  ];
  // a transaction's client runs one query at a time; the pool can run them side by side
  const out = [];
  if (db.release) for (const t of sql) out.push(await db.query(t));
  else out.push(...await Promise.all(sql.map((t) => db.query(t))));
  const [banks, balances, receipts, payments, entries] = out;
  const result = finalBalance({ banks: banks.rows, balances: balances.rows, receipts: receipts.rows, payments: payments.rows, entries: entries.rows, today, upTo, approvedOnly, uncertain });
  return { banks: banks.rows, ...result };
}
const HORIZON = 62; // EMI payments are made this many days ahead, enough for any hold to have started

// ── receipts & payments: one set of rules for their own routes and for POST /api/transactions ──
const REF_TAKEN = 'That bank reference is already recorded on this account.';
// the same party, amount and date already recorded (and not cancelled) is most likely the same transaction
async function noDuplicate(c, kind, name, amount, date) {
  const t = kind === 'IN' ? ['receipts', 'party', 'expected_date', 'A receipt from'] : ['payments', 'payee', 'due_date', 'A payment to'];
  const { rows: [d] } = await c.query(`SELECT ${t[1]} AS name FROM ${t[0]} WHERE status <> 'CANCELLED' AND lower(${t[1]}) = lower($1) AND amount = $2 AND ${t[2]} = $3 LIMIT 1`, [name, amount, date]);
  if (d) throw err(409, 'duplicate', `${t[3]} ${d.name} for ${inr(amount)} on ${date} is already recorded. Add it anyway?`);
}

async function addReceipt(c, body, user) {
  const r = {
    party: need(str(body.party, 120), 'Received from'), ref: str(body.ref, 80),
    amount: toPaise(body.amount, 'Amount', { allowZero: false }), date: ymd(body.expected_date, 'Expected date'),
    certainty: oneOf(body.certainty || 'LIKELY', ['FIRM', 'LIKELY', 'UNCERTAIN'], 'Certainty'), bankId: optBank(body.bank_id), note: str(body.note, 300),
  };
  await bankExists(c, r.bankId);
  if (!body.confirmDuplicate) {
    const refNorm = normRef(r.ref);
    if (refNorm) {
      const { rows } = await c.query("SELECT party, ref, expected_date FROM receipts WHERE status = 'OPEN' AND ref <> ''");
      const d = rows.find((x) => normRef(x.ref) === refNorm);
      if (d) throw err(409, 'duplicate', `A receipt with reference “${r.ref}” is already open (${d.party}, expected ${d.expected_date}). Add it anyway?`);
    }
    await noDuplicate(c, 'IN', r.party, r.amount, r.date);
  }
  const { rows: [x] } = await c.query('INSERT INTO receipts (party, ref, amount, expected_date, certainty, bank_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [r.party, r.ref, r.amount, r.date, r.certainty, r.bankId, r.note, user.id]);
  await audit(c, user.id, 'receipt.add', { id: x.id, ...r });
  return x;
}

async function addPayment(c, body, user) {
  const p = {
    payee: need(str(body.payee, 120), 'Pay to'), ref: str(body.ref, 80), category: need(str(body.category, 40), 'Category'),
    amount: toPaise(body.amount, 'Amount', { allowZero: false }), date: ymd(body.due_date, 'Due date'), bankId: optBank(body.bank_id),
    approved: user.role === 'admin' && body.approved === true, note: str(body.note, 300),
  };
  const refNorm = normRef(p.ref);
  await bankExists(c, p.bankId);
  if (!body.confirmDuplicate) {
    if (refNorm) {
      const { rows: [d] } = await c.query("SELECT payee, amount, due_date FROM payments WHERE ref_norm = $1 AND status = 'OPEN' LIMIT 1", [refNorm]);
      if (d) throw err(409, 'duplicate', `A payment with reference “${p.ref}” is already open (${d.payee}, due ${d.due_date}). Add it anyway?`);
    }
    await noDuplicate(c, 'OUT', p.payee, p.amount, p.date);
  }
  const { rows: [x] } = await c.query('INSERT INTO payments (payee, ref, ref_norm, category, amount, due_date, bank_id, approved, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
    [p.payee, p.ref, refNorm, p.category, p.amount, p.date, p.bankId, p.approved, p.note, user.id]);
  await audit(c, user.id, 'payment.add', { id: x.id, ...p });
  return x;
}

// money that actually arrived / left: all of what is left on a receipt or payment, or part of it. Only this moves balances.
async function settle(c, { table, id, body, user }) {
  const isIn = table === 'receipts';
  const ref = need(str(body.ref, 80), 'Bank reference (UTR / cheque no.)'), refNorm = normRef(ref);
  if (!refNorm) bad('Bank reference: use letters or numbers.');
  const date = notFuture(ymd(body.date || todayIST(), 'Date'), 'Date');
  const { rows: [x] } = await c.query(`SELECT id, amount, bank_id, status, ${isIn ? 'NULL' : 'emi_id'} AS emi_id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!x) notFound('That record doesn’t exist.');
  if (x.status !== 'OPEN') bad('It was cancelled.');
  const { rows: [{ done }] } = await c.query(`SELECT coalesce(sum(amount), 0)::bigint AS done FROM entries WHERE ${isIn ? 'receipt_id' : 'payment_id'} = $1`, [id]);
  const left = Number(x.amount) - Number(done);
  if (left <= 0) bad(isIn ? 'It is already fully received.' : 'It is already fully paid.');
  const amount = body.amount === '' || body.amount == null ? left : toPaise(body.amount, 'Amount', { allowZero: false });
  if (amount > left) bad(`Only ${(left / 100).toFixed(2)} is left on it.`);
  const bankId = await bankExists(c, body.bank_id ? intId(body.bank_id, 'Account') : x.bank_id ?? bad('Choose the account.'));
  if (!isIn && !x.emi_id && !body.fromStatement) {
    // money reserved for EMIs (in this app) can't go to anyone else; one payment per account checks at a time
    const today = todayIST();
    await c.query('SELECT pg_advisory_xact_lock(2, $1)', [bankId]);
    await syncEmis(c, addDays(today, HORIZON));
    const row = (await position(c, { today, upTo: today })).rows.find((r) => r.id === bankId);
    if (row && row.held > 0 && amount > row.free) {
      throw err(409, 'emi_hold', `Not allowed: ${inr(row.held)} in ${row.name} is reserved for EMIs. Of its ${inr(row.today)} balance, only ${inr(Math.max(row.free, 0))} can be paid to others. Bring in money or pay from another account.`);
    }
  }
  let overdraft = false;
  if (!isIn && x.emi_id && !body.fromStatement) {
    // confirming an EMI payment: if the account doesn't have the money, say so and ask before recording it
    const today = todayIST();
    const row = (await position(c, { today, upTo: today })).rows.find((r) => r.id === bankId);
    if (row && amount > row.today) {
      if (!body.confirmShortfall) throw err(409, 'insufficient', `${row.name} has ${inr(row.today)}. Paying ${inr(amount)} takes it to ${inr(row.today - amount)}. Record this payment anyway (for example, it went through on an overdraft)?`);
      overdraft = true;
    }
  }
  const { rows: [e] } = await c.query(`INSERT INTO entries (kind, ${isIn ? 'receipt_id' : 'payment_id'}, bank_id, amount, date, ref, ref_norm, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [isIn ? 'IN' : 'OUT', id, bankId, amount, date, ref, refNorm, user.id]);
  await audit(c, user.id, isIn ? 'receipt.received' : 'payment.paid', { id, entry: e.id, bankId, amount, date, ref, ...(overdraft ? { overdraft: true } : {}), ...(body.fromStatement ? { fromStatement: true } : {}) });
  return { id: e.id, left: left - amount };
}

// ── EMI management: settings, schedule, money held, reminders ──
const flag = (v, fallback) => (v === undefined ? fallback : v === true || v === 'true');
const emailList = (v) => {
  const list = [...new Set(str(v, 600).toLowerCase().split(/[\s,;]+/).filter(Boolean))];
  if (list.length > 5) bad('Email reminders: up to 5 addresses.');
  for (const x of list) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)) bad(`Email reminders: “${x}” is not a valid email address.`);
  return list.join(', ');
};
// reminder points: whole days before the due date, 1 to 30, newest last ("7, 3, 1")
const beforeList = (v) => {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).filter((x) => x !== '' && x != null).map(Number);
  for (const n of list) if (!Number.isInteger(n) || n < 1 || n > 30) bad('Remind before: use days from 1 to 30.');
  const out = [...new Set(list)].sort((a, b) => b - a);
  if (out.length > 6) bad('Remind before: up to 6 reminder points.');
  return out;
};
// reservation and reminder settings, from a form; anything not sent keeps its current value
const NEW_EMI = { hold_days: 0, remind_before: DEFAULT_BEFORE, remind_due: true, remind_overdue: true, remind_in_app: true, remind_email: false, remind_to: '' };
function emiSettings(body, old = NEW_EMI) {
  const days = (k, label, max) => {
    if (!(k in body) || body[k] === '' || body[k] == null) return old[k];
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > max) bad(`${label}: enter 0 to ${max} days.`);
    return n;
  };
  let before = old.remind_before;
  if ('remind_before' in body) before = beforeList(body.remind_before);
  else if (body.remind_days !== undefined && body.remind_days !== '' && body.remind_days !== null) { const n = days('remind_days', 'Remind before', 30); before = n ? [n] : []; } // older forms: one point
  return {
    hold_days: days('hold_days', 'Reserve from', 31), remind_before: before,
    remind_due: flag(body.remind_due, old.remind_due), remind_overdue: flag(body.remind_overdue, old.remind_overdue),
    remind_in_app: flag(body.remind_in_app, old.remind_in_app), remind_email: flag(body.remind_email, old.remind_email),
    remind_to: 'remind_to' in body ? emailList(body.remind_to) : old.remind_to,
  };
}

// marks each unpaid instalment covered or not: can its account's balance pay it together with its earlier EMIs?
async function withCoverage(rows, today) {
  const balances = new Map((await position({ query: q }, { today, upTo: today })).rows.filter((r) => r.id != null).map((r) => [r.id, r.today]));
  const cover = coverage(rows.filter((r) => !r.projected && r.left > 0), balances);
  return rows.map((r) => { const c = cover.get(r.payment_id); return c && !r.projected ? { ...r, covered: c.covered, short_by: c.shortBy } : r; });
}

// every EMI instalment with its state: paid · overdue · due (today) · upcoming (next 30 days) · scheduled (later) · cancelled.
// reserved = its money is set aside in this app now (an internal reservation, not a hold at the bank). Future months beyond the records are projected (projected: true).
async function emiSchedule(db, today) {
  const { rows } = await db.query(`SELECT p.id AS payment_id, p.emi_id, e.lender, e.ref AS loan_ref, p.bank_id, b.name AS bank_name, p.due_date, p.amount, p.status,
      coalesce(s.paid, 0)::bigint AS paid, s.last_date, s.refs, (p.due_date - e.hold_days) AS hold_from
    FROM payments p JOIN emis e ON e.id = p.emi_id JOIN banks b ON b.id = p.bank_id
    LEFT JOIN (SELECT payment_id, sum(amount) AS paid, max(date) AS last_date, string_agg(ref, ', ' ORDER BY id) AS refs FROM entries WHERE payment_id IS NOT NULL GROUP BY payment_id) s ON s.payment_id = p.id
    ORDER BY p.due_date, p.id`);
  const soon = addDays(today, 30);
  const state = (r) => (r.status === 'CANCELLED' ? 'cancelled' : r.paid >= r.amount ? 'paid' : r.due_date < today ? 'overdue' : r.due_date === today ? 'due' : r.due_date <= soon ? 'upcoming' : 'scheduled');
  const out = rows.map((r) => {
    const s = state(r), open = s !== 'paid' && s !== 'cancelled';
    return { ...r, left: open ? r.amount - r.paid : 0, state: s, reserved: open && r.hold_from <= today, projected: false };
  });
  const last = new Map();
  for (const r of rows) if (!last.has(r.emi_id) || r.due_date > last.get(r.emi_id)) last.set(r.emi_id, r.due_date);
  const { rows: emis } = await db.query('SELECT e.id, e.lender, e.ref, e.amount, e.day, e.bank_id, e.start_date, e.end_date, e.hold_days, b.name AS bank_name FROM emis e JOIN banks b ON b.id = e.bank_id WHERE e.active');
  for (const e of emis) {
    const after = addDays(last.get(e.id) ?? addDays(today, -1), 1);
    for (const d of projectDates(e, after < e.start_date ? e.start_date : after, 12)) {
      out.push({ payment_id: null, emi_id: e.id, lender: e.lender, loan_ref: e.ref, bank_id: e.bank_id, bank_name: e.bank_name, due_date: d, amount: Number(e.amount), status: 'OPEN',
        paid: 0, last_date: null, refs: null, hold_from: addDays(d, -e.hold_days), left: Number(e.amount), state: d <= soon ? 'upcoming' : 'scheduled', reserved: false, projected: true });
    }
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.emi_id - b.emi_id);
}

// per account: balance now, money held for EMIs (reserved), and what is available for anything else
async function emiOverview(today) {
  await withTx((c) => syncEmis(c, addDays(today, HORIZON)));
  const [pos, sched, { rows: [act] }] = await Promise.all([
    position({ query: q }, { today, upTo: today }), emiSchedule({ query: q }, today),
    q('SELECT count(*)::int AS n, coalesce(sum(amount), 0)::bigint AS monthly FROM emis WHERE active'),
  ]);
  const open = sched.filter((r) => !r.projected && ['overdue', 'due', 'upcoming', 'scheduled'].includes(r.state));
  const sum = (xs) => ({ count: xs.length, amount: xs.reduce((s, r) => s + r.left, 0) });
  const accounts = pos.rows.filter((r) => r.id != null).map((r) => ({
    id: r.id, name: r.name, bank: r.bank, balance: r.today, reserved: r.held, available: r.free, balanceEntered: r.balance != null,
    next: open.find((s) => s.bank_id === r.id) ?? null,
  }));
  const add = (k) => accounts.reduce((s, a) => s + a[k], 0);
  return {
    today, accounts,
    totals: {
      balance: add('balance'), reserved: add('reserved'), available: add('available'), active: act.n, monthly: Number(act.monthly),
      overdue: sum(open.filter((r) => r.state === 'overdue')), due: sum(open.filter((r) => r.state === 'due')), upcoming: sum(open.filter((r) => r.state === 'upcoming')),
    },
  };
}

// works out which reminders are due and stores them: in-app for every editor and admin, email per the EMI's settings.
// Checked at most every few minutes when people use the app, on the daily schedule, or on demand by an admin.
let lastReminderRun = 0;
async function runReminders({ force = false } = {}) {
  if (!force && Date.now() - lastReminderRun < 5 * 60000) return null;
  lastReminderRun = Date.now();
  const today = todayIST();
  return withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7103)'); // one run at a time
    await syncEmis(c, addDays(today, HORIZON));
    const balances = new Map((await position(c, { today, upTo: today })).rows.filter((r) => r.id != null).map((r) => [r.id, r.today]));
    const { rows: settings } = await c.query('SELECT id, remind_before, remind_due, remind_overdue, remind_in_app, remind_email, remind_to, hold_days FROM emis');
    const cfg = new Map(settings.map((s) => [s.id, s]));
    const instalments = (await emiSchedule(c, today)).filter((r) => !r.projected && r.left > 0).map((r) => ({ ...r, ...cfg.get(r.emi_id), id: undefined }));
    const events = dueReminders({ instalments, balances, today });
    const { rows: users } = await c.query("SELECT id, email, role FROM users WHERE active AND role IN ('editor', 'admin')");
    const admins = users.filter((u) => u.role === 'admin').map((u) => u.email);
    let inApp = 0, queued = 0;
    for (const ev of events) {
      const s = cfg.get(ev.emi_id);
      if (s.remind_in_app) for (const u of users) {
        inApp += (await c.query(`INSERT INTO notifications (user_id, kind, title, body, link, dedupe_key) VALUES ($1, $2, $3, $4, 'emis', $5)
          ON CONFLICT (user_id, dedupe_key) DO NOTHING`, [u.id, ev.kind, ev.title, ev.body, ev.key])).rowCount;
      }
      if (s.remind_email) for (const to of s.remind_to ? s.remind_to.split(', ') : admins) {
        queued += (await c.query(`INSERT INTO email_outbox (to_addr, subject, body, dedupe_key) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
          [to, ev.title, `${ev.title}\n\n${ev.body}\n\n— Finance app`, `${ev.key}:${to}`])).rowCount;
      }
    }
    return { reminders: events.length, inApp, queued };
  });
}

// sends queued reminder emails; each is claimed before sending so two runs never send the same one
async function deliverEmails(limit = 20) {
  const { rows } = await q("SELECT id, to_addr, subject, body, status, attempts FROM email_outbox WHERE status = 'pending' OR (status = 'failed' AND attempts < 5) ORDER BY id LIMIT $1", [limit]);
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const m of rows) {
    if (!emailConfigured()) {
      await q("UPDATE email_outbox SET status = 'skipped', error = 'Email is not set up (RESEND_API_KEY and EMAIL_FROM).' WHERE id = $1 AND status = $2", [m.id, m.status]);
      out.skipped++; continue;
    }
    const claim = await q('UPDATE email_outbox SET attempts = attempts + 1 WHERE id = $1 AND status = $2 AND attempts = $3', [m.id, m.status, m.attempts]);
    if (!claim.rowCount) continue;
    try {
      await sendEmail({ to: m.to_addr, subject: m.subject, text: m.body });
      await q("UPDATE email_outbox SET status = 'sent', error = '', sent_at = now() WHERE id = $1", [m.id]);
      out.sent++;
    } catch (e) {
      await q("UPDATE email_outbox SET status = 'failed', error = $2 WHERE id = $1", [m.id, String(e.message).slice(0, 300)]);
      out.failed++;
    }
  }
  return out;
}

// filters shared by the transaction lists, the summary and the exports; the period defaults to this month so far
function txFilters(url) {
  const p = url.searchParams, today = todayIST();
  const f = {
    view: oneOf(p.get('view') || 'history', ['history', 'records'], 'View'),
    from: ymd(p.get('from') || `${today.slice(0, 8)}01`, 'From'), to: ymd(p.get('to') || today, 'To'),
    bank: p.get('bank') ? intId(p.get('bank'), 'Bank account') : null,
    type: oneOf(p.get('type') || '', ['', 'IN', 'OUT'], 'Type'),
    status: oneOf(p.get('status') || '', ['', 'pending', 'partial', 'completed', 'cancelled'], 'Status'),
    q: str(p.get('q'), 100),
    field: oneOf(p.get('field') || '', ['', ...SEARCH_FIELDS], 'Search in'),
  };
  if (f.from > f.to) bad('The “from” date must be on or before the “to” date.');
  if (f.to > addDays(f.from, 36600)) bad('Pick a period of a hundred years or less.');
  return f;
}

// ── search: in one field, or in everything (field '') ──
const SEARCH_FIELDS = ['name', 'id', 'bank_ref', 'doc_ref', 'note', 'amount', 'bank', 'user'];
// IDs as shown in the app: T-00042 (money received or paid), R-12 (a receipt), P-34 (a payment); a bare number works too
const idTerm = (term) => { const m = /^\s*([TRP])?\s*-?\s*0*(\d{1,9})\s*$/i.exec(term); return m ? { prefix: (m[1] || '').toUpperCase(), n: Number(m[2]) } : null; };
// an amount as typed: 25000, 25,000, ₹25,000.50
const amountTerm = (term) => { try { return toPaise(term, 'Amount', { allowZero: false }); } catch { return null; } };
// builds "(a OR b OR …)" from each field's condition. Each field is a function, called only if that field is searched,
// so a query never carries a value it doesn't use. A field that can't match this term (an ID search for "mehta")
// gives nothing.
function searchWhere(f, arg, fields) {
  let like;
  const t = () => (like ??= arg(likeTerm(f.q))); // the "contains" pattern, added once if any field uses it
  const ctx = { t, id: idTerm(f.q), amt: amountTerm(f.q), arg };
  const conds = Object.entries(fields)
    .filter(([k]) => !f.field || k === f.field)
    .flatMap(([, make]) => [].concat(make(ctx) || []));
  return conds.length ? `(${conds.join(' OR ')})` : 'false';
}

// money actually received and paid in the period (newest first)
async function history(f) {
  const where = ['e.date BETWEEN $1 AND $2'], args = [f.from, f.to], arg = (v) => { args.push(v); return `$${args.length}`; };
  if (f.bank) where.push(`e.bank_id = ${arg(f.bank)}`);
  if (f.type) where.push(`e.kind = ${arg(f.type)}`);
  if (f.q) {
    where.push(searchWhere(f, arg, {
      name: ({ t }) => `coalesce(r.party, p.payee) ILIKE ${t()}`,
      id: ({ id, arg }) => id && (id.prefix === 'R' ? `e.receipt_id = ${arg(id.n)}` : id.prefix === 'P' ? `e.payment_id = ${arg(id.n)}` : `e.id = ${arg(id.n)}`),
      bank_ref: ({ t }) => `e.ref ILIKE ${t()}`,
      doc_ref: ({ t }) => `coalesce(r.ref, p.ref) ILIKE ${t()}`,
      note: ({ t }) => [`coalesce(r.note, p.note) ILIKE ${t()}`, `coalesce(p.category, '') ILIKE ${t()}`],
      amount: ({ amt, arg }) => amt && `e.amount = ${arg(amt)}`,
      bank: ({ t }) => [`b.name ILIKE ${t()}`, `b.bank ILIKE ${t()}`, `b.last4 ILIKE ${t()}`],
      user: ({ t }) => `coalesce(u.name, '') ILIKE ${t()}`,
    }));
  }
  const { rows } = await q(`SELECT e.id, e.kind, e.date, e.amount, e.bank_id, b.name AS bank_name, b.bank AS bank_label, b.last4, e.ref AS bank_ref,
      coalesce(r.party, p.payee) AS name, coalesce(r.ref, p.ref) AS doc_ref, coalesce(r.note, p.note) AS note, coalesce(p.category, '') AS category,
      p.emi_id IS NOT NULL AS emi, coalesce(e.receipt_id, e.payment_id) AS record_id, e.created_at, u.name AS recorded_by
    FROM entries e JOIN banks b ON b.id = e.bank_id LEFT JOIN receipts r ON r.id = e.receipt_id LEFT JOIN payments p ON p.id = e.payment_id LEFT JOIN users u ON u.id = e.created_by
    WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC LIMIT 5000`, args);
  return rows;
}

// every receipt and payment that is dated in the period or had money move in it, with how much has been settled:
// pending (nothing yet), partial, completed, or cancelled
async function records(f) {
  const where = [`(t.date BETWEEN $1 AND $2 OR EXISTS (SELECT 1 FROM entries e WHERE (CASE WHEN t.kind = 'IN' THEN e.receipt_id ELSE e.payment_id END) = t.id AND e.date BETWEEN $1 AND $2))`];
  const args = [f.from, f.to], arg = (v) => { args.push(v); return `$${args.length}`; };
  if (f.bank) { const b = arg(f.bank); where.push(`(t.bank_id = ${b} OR ${b} = ANY(t.banks))`); }
  if (f.type) where.push(`t.kind = ${arg(f.type)}`);
  if (f.status) where.push(`t.state = ${arg(f.status)}`);
  if (f.q) {
    where.push(searchWhere(f, arg, {
      name: ({ t }) => `t.name ILIKE ${t()}`,
      id: ({ id, arg }) => id && (id.prefix === 'R' ? `(t.kind = 'IN' AND t.id = ${arg(id.n)})` : id.prefix === 'P' ? `(t.kind = 'OUT' AND t.id = ${arg(id.n)})`
        : id.prefix === 'T' ? `EXISTS (SELECT 1 FROM entries e WHERE e.id = ${arg(id.n)} AND (CASE WHEN t.kind = 'IN' THEN e.receipt_id ELSE e.payment_id END) = t.id)`
        : `t.id = ${arg(id.n)}`),
      bank_ref: ({ t }) => `coalesce(t.bank_refs, '') ILIKE ${t()}`,
      doc_ref: ({ t }) => `t.ref ILIKE ${t()}`,
      note: ({ t }) => [`t.note ILIKE ${t()}`, `t.category ILIKE ${t()}`],
      amount: ({ amt, arg }) => amt && `t.amount = ${arg(amt)}`,
      bank: ({ t }) => `coalesce(t.bank_name, '') ILIKE ${t()}`,
      user: ({ t }) => `coalesce(t.recorded_by, '') ILIKE ${t()}`,
    }));
  }
  const { rows } = await q(`SELECT * FROM (
      SELECT x.*, coalesce(d.settled, 0)::bigint AS settled, d.last_date, d.bank_refs, coalesce(d.banks, '{}') AS banks, b.name AS bank_name, cu.name AS recorded_by,
        CASE WHEN x.status = 'CANCELLED' THEN 'cancelled' WHEN coalesce(d.settled, 0) >= x.amount THEN 'completed' WHEN coalesce(d.settled, 0) > 0 THEN 'partial' ELSE 'pending' END AS state
      FROM (
        SELECT 'IN' AS kind, r.id, r.expected_date AS date, r.party AS name, r.ref, r.note, '' AS category, r.amount, r.bank_id, r.status, false AS emi, r.created_by FROM receipts r
        UNION ALL
        SELECT 'OUT', p.id, p.due_date, p.payee, p.ref, p.note, p.category, p.amount, p.bank_id, p.status, p.emi_id IS NOT NULL, p.created_by FROM payments p
      ) x
      LEFT JOIN (
        SELECT CASE WHEN receipt_id IS NULL THEN 'OUT' ELSE 'IN' END AS kind, coalesce(receipt_id, payment_id) AS id, sum(amount) AS settled, max(date) AS last_date,
          string_agg(ref, ', ' ORDER BY id) AS bank_refs, array_agg(DISTINCT bank_id) AS banks
        FROM entries GROUP BY 1, 2
      ) d ON d.kind = x.kind AND d.id = x.id
      LEFT JOIN banks b ON b.id = coalesce(x.bank_id, d.banks[1])
      LEFT JOIN users cu ON cu.id = x.created_by
    ) t WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.kind, t.id DESC LIMIT 5000`, args);
  return rows;
}

// ── an uploaded Excel / CSV sheet → receipts and payments yet to be paid / received (pending: balances don't move) ──
// "check" reads the sheet and says what each row will become; "add" reads the same file again and adds the good rows.
async function sheetImport(c, body) {
  const kind = oneOf(body.kind || 'OUT', ['IN', 'OUT'], 'These rows are');
  const file = String(body.file ?? '');
  if (!file || !/^[A-Za-z0-9+/=\s]+$/.test(file)) bad('Choose an Excel (.xlsx) or CSV file to upload.');
  const buf = Buffer.from(file, 'base64');
  if (buf.length > MAX_BYTES) bad('That file is too big. Upload at most 3 MB (about 20,000 rows).');
  const table = readTable(buf, str(body.name, 200));
  const banks = (await c.query('SELECT id, name, bank, last4 FROM banks ORDER BY id')).rows;
  const out = importRows(table, { kind, banks, today: todayIST() });
  if (!out.rows.length) bad('No rows found under the headings.');
  // already in the app: the same name, amount and date (not cancelled), or the same invoice / bill no. still open
  const [rec, pay] = [
    await c.query("SELECT 'IN' AS kind, party AS name, amount, expected_date AS date, ref, status FROM receipts WHERE status <> 'CANCELLED'"),
    await c.query("SELECT 'OUT' AS kind, payee AS name, amount, due_date AS date, ref, status FROM payments WHERE status <> 'CANCELLED'"),
  ];
  const key = (x) => `${x.kind}|${x.name.toLowerCase()}|${Number(x.amount)}|${x.date}`;
  const have = new Set([...rec.rows, ...pay.rows].map(key));
  const refs = new Set([...rec.rows, ...pay.rows].filter((x) => x.status === 'OPEN' && normRef(x.ref)).map((x) => `${x.kind}|${normRef(x.ref)}`));
  const seen = new Map(); // rows of this sheet so far, to spot the same row twice
  for (const r of out.rows) {
    if (r.problems.length) { r.status = 'problem'; continue; }
    const k = key(r), ref = normRef(r.ref), again = seen.get(`${k}|${ref}`);
    if (have.has(k)) r.duplicate = 'Already in the app (same name, amount and date)';
    else if (ref && refs.has(`${r.kind}|${ref}`)) r.duplicate = `Invoice / bill no. “${r.ref}” is already in the app`;
    else if (again) r.duplicate = `Same as row ${again} of this sheet`;
    if (!again) seen.set(`${k}|${ref}`, r.row);
    r.status = r.duplicate ? 'duplicate' : 'ok';
  }
  return { fileName: str(body.name, 200), sheet: table.sheet, ...out }; // not "file": that is a download
}

// ── reconciling a bank statement: its debits are payments made; payments due but not in it are left out ──
// Each debit is: already in the app (recorded before, by reference or same amount and date), matched to a payment
// yet to be paid, or not in the app. Nothing changes until "apply".
async function reconcileCheck(c, body) {
  const bankId = intId(body.bank_id, 'Bank account');
  const { rows: [bank] } = await c.query('SELECT id, name, bank, last4 FROM banks WHERE id = $1', [bankId]);
  if (!bank) bad('Choose the bank account this statement is for.');
  const file = String(body.file ?? '');
  if (!file || !/^[A-Za-z0-9+/=\s]+$/.test(file)) bad('Choose the bank statement file (.xlsx or .csv).');
  const buf = Buffer.from(file, 'base64');
  if (buf.length > MAX_BYTES) bad('That file is too big. Upload at most 3 MB.');
  // a PDF (with text in it), or Excel / CSV / text pasted from the bank's email
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  // a picture-only PDF is read in the browser (OCR): its words and their places come with the file
  const pdf = isPdf || body.ocr ? await import('./pdf.js') : null;
  // or the lines the AI read from it (POST /api/reconcile/ai-read), sent back with the file
  const st = readStatement(body.lines ? tableFromLines(body.lines) : body.ocr ? pdf.tableFromPages(pdf.ocrPages(body.ocr))
    : isPdf ? await pdf.readPdf(buf, str(body.password, 100)) : readTable(buf, str(body.name, 200)));
  if (st.to > todayIST()) bad(`The statement has dates after today (${st.to}). Check that it is the right file.`);
  await syncEmis(c, addDays(todayIST(), HORIZON));

  const taken = new Set(), debits = st.rows.filter((r) => r.debit > 0).map((r) => ({ ...r, bankRef: lineRef(r, taken) }));
  // recorded before: the same reference on this account, or the same amount within two days (each entry counted once)
  const { rows: ents } = await c.query("SELECT id, amount, date, ref, ref_norm, payment_id FROM entries WHERE bank_id = $1 AND kind = 'OUT' AND date BETWEEN $2 AND $3 ORDER BY date, id",
    [bankId, addDays(st.from, -3), addDays(st.to, 3)]);
  const { rows: refEnts } = await c.query("SELECT ref_norm, payment_id FROM entries WHERE bank_id = $1 AND kind = 'OUT' AND ref_norm = ANY($2::text[])",
    [bankId, [...new Set(debits.flatMap((d) => [normRef(d.bankRef), normRef(d.ref)]).filter(Boolean))]]);
  const byRef = new Map(refEnts.map((e) => [e.ref_norm, e])), claimed = new Set();
  for (const d of debits) {
    const e = byRef.get(normRef(d.bankRef)) ?? (d.ref && byRef.get(normRef(d.ref)));
    if (e) { d.recorded = { payment_id: e.payment_id, by: 'reference' }; const x = ents.find((y) => y.ref_norm === e.ref_norm); if (x) claimed.add(x.id); }
  }
  for (const d of debits.filter((x) => !x.recorded)) {
    const e = ents.find((y) => !claimed.has(y.id) && Number(y.amount) === d.debit && Math.abs(Date.parse(y.date) - Date.parse(d.date)) <= 2 * 864e5);
    if (e) { claimed.add(e.id); d.recorded = { payment_id: e.payment_id, by: 'amount and date', ref: e.ref, date: e.date }; }
  }

  // payments yet to be paid (or partly paid), with what is left on each
  const { rows: pays } = await c.query(`SELECT p.id, p.payee AS name, p.ref, p.category, p.note, p.due_date, p.bank_id, p.emi_id IS NOT NULL AS emi, b.name AS bank_name,
      (p.amount - coalesce((SELECT sum(e.amount) FROM entries e WHERE e.payment_id = p.id), 0))::bigint AS outstanding, p.amount
    FROM payments p LEFT JOIN banks b ON b.id = p.bank_id WHERE p.status = 'OPEN' ORDER BY p.due_date, p.id`);
  const payments = pays.map((p) => ({ ...p, outstanding: Number(p.outstanding), amount: Number(p.amount) })).filter((p) => p.outstanding > 0);
  const lines = matchStatement(debits.filter((d) => !d.recorded), payments, bankId);
  const byRow = new Map(lines.map((l) => [l.row, l]));

  // the app's balance for this account at the statement's last date, before reconciling
  const [bal, en] = [await c.query('SELECT id, bank_id, amount, as_of FROM balances WHERE bank_id = $1', [bankId]), await c.query('SELECT kind, bank_id, amount, date FROM entries WHERE bank_id = $1', [bankId])];
  const app = bankStatements({ banks: [bank], balances: bal.rows, entries: en.rows, from: st.to, to: st.to }).rows[0];
  const credits = st.rows.filter((r) => r.credit > 0);
  return {
    bank, fileName: str(body.name, 200), ocr: Boolean(body.ocr) && !body.lines, ai: Boolean(body.lines), checked: st.checked, from: st.from, to: st.to, columns: st.columns, skipped: st.skipped, closing: st.closing,
    appClosing: app.closing, balanceEntered: app.balanceEntered,
    debits: debits.map((d) => ({ row: d.row, date: d.date, narration: d.narration, ref: d.ref, bankRef: d.bankRef, amount: d.debit, recorded: d.recorded ?? null, mismatch: d.mismatch ?? null, reversedBy: d.reversedBy ?? null, payee: guessPayee(d.narration),
      match: byRow.get(d.row)?.match ?? null, candidates: byRow.get(d.row)?.candidates ?? [] })),
    credits: { count: credits.length, amount: credits.reduce((n, r) => n + r.credit, 0) },
    payments,
    // the ones due by the statement's last date, for this account or not decided: if not matched, they are left out
    due: payments.filter((p) => p.due_date <= st.to && (p.bank_id === bankId || p.bank_id == null)).map((p) => p.id),
    today: todayIST(),
  };
}

// ── deleting a bank account: what goes with it ──
// The account's balances, the money received / paid through it, its EMIs (and their instalments), and the receipts
// and payments settled only through it. Pending receipts and payments assigned to it stay, as "Not decided".
async function bankUsage(c, id) {
  const { rows: [b] } = await c.query('SELECT id, name, bank, last4 FROM banks WHERE id = $1', [id]);
  if (!b) notFound('That bank account doesn’t exist (it may already be deleted).');
  const { rows: [u] } = await c.query(`SELECT
      (SELECT count(*) FROM balances WHERE bank_id = $1)::int AS balances,
      (SELECT count(*) FROM entries WHERE bank_id = $1 AND kind = 'IN')::int AS received,
      (SELECT coalesce(sum(amount), 0) FROM entries WHERE bank_id = $1 AND kind = 'IN')::bigint AS received_amount,
      (SELECT count(*) FROM entries WHERE bank_id = $1 AND kind = 'OUT')::int AS paid,
      (SELECT coalesce(sum(amount), 0) FROM entries WHERE bank_id = $1 AND kind = 'OUT')::bigint AS paid_amount,
      (SELECT count(*) FROM emis WHERE bank_id = $1)::int AS emis,
      (SELECT count(*) FROM receipts r WHERE r.bank_id = $1 AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.receipt_id = r.id))::int
        + (SELECT count(*) FROM payments p WHERE p.bank_id = $1 AND p.emi_id IS NULL AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.payment_id = p.id))::int AS unassigned`, [id]);
  return { ...b, ...u, received_amount: Number(u.received_amount), paid_amount: Number(u.paid_amount) };
}

// export tables: a header row, then rows; amounts in rupees as numbers so spreadsheets can add them up
const rupeeNum = (p) => Math.round(Number(p)) / 100;
const TYPE = { IN: 'Receipt', OUT: 'Payment' };
const STATE = { pending: 'Yet to be paid', partial: 'Partly settled', completed: 'Completed', cancelled: 'Cancelled' };
// IDs as shown in the app
const txId = (r) => `T-${String(r.id).padStart(5, '0')}`;
const recId = (r) => `${r.kind === 'IN' ? 'R' : 'P'}-${r.id}`;
const historyTable = (rows) => [
  ['ID', 'Date', 'Type', 'Party', 'Amount (₹)', 'Bank account', 'Bank reference', 'Invoice / bill no.', 'Description', 'Recorded by'],
  ...rows.map((r) => [txId(r), r.date, TYPE[r.kind], r.name, rupeeNum(r.amount), `${r.bank_name} (${r.bank_label} XXXX${r.last4})`, r.bank_ref, r.doc_ref, r.note || (r.emi ? 'EMI' : r.category), r.recorded_by ?? '']),
];
const recordsTable = (rows) => [
  ['ID', 'Date', 'Type', 'Party', 'Amount (₹)', 'Settled (₹)', 'Outstanding (₹)', 'Status', 'Bank account', 'Bank references', 'Last settled on', 'Invoice / bill no.', 'Description'],
  ...rows.map((r) => [recId(r), r.date, TYPE[r.kind], r.name, rupeeNum(r.amount), rupeeNum(r.settled), r.state === 'cancelled' ? 0 : rupeeNum(r.amount - r.settled), r.state === 'pending' && r.kind === 'IN' ? 'Yet to be received' : STATE[r.state], r.bank_name ?? 'Not decided', r.bank_refs ?? '', r.last_date ?? '', r.ref, r.note || (r.emi ? 'EMI' : r.category)]),
];

async function currentUser(req) {
  const t = A.readToken(A.cookieValue(req.headers));
  if (!t) return null;
  const { rows: [u] } = await q('SELECT id, email, name, role, ver FROM users WHERE id = $1 AND active', [t.uid]);
  return u && u.ver === t.ver ? { id: u.id, email: u.email, name: u.name, role: u.role, ver: u.ver } : null;
}
const signIn = (ctx, user) => ctx.headers.push(['Set-Cookie', A.cookieHeader(A.makeToken(user), ctx.secure)]);

// ── routes: [method, path pattern, minimum role (null = anyone), handler] ──
const routes = [
  ['GET', /^\/api\/state$/, null, async ({ user }) => {
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM users');
    return { needsSetup: n === 0, user, today: todayIST(), ai: aiConfigured() };
  }],

  // the first person to open the app creates the admin account
  ['POST', /^\/api\/setup$/, null, async (ctx) => {
    const { body } = ctx;
    const e = email(body.email), name = need(str(body.name, 100), 'Name'), problem = A.passwordProblem(body.password);
    if (problem) bad(problem);
    const user = await withTx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7102)');
      if ((await c.query('SELECT 1 FROM users')).rowCount) throw err(403, 'permission_denied', 'The app is already set up. Sign in instead.');
      const { rows: [u] } = await c.query("INSERT INTO users (email, name, pw, role) VALUES ($1, $2, $3, 'admin') RETURNING id, email, name, role, ver", [e, name, A.hashPassword(body.password)]);
      await audit(c, u.id, 'setup', { email: e });
      return u;
    });
    signIn(ctx, user);
    return { user };
  }],

  ['POST', /^\/api\/login$/, null, async (ctx) => {
    const e = str(ctx.body.email, 200).toLowerCase(), pw = String(ctx.body.password ?? '');
    const { rows: [u] } = await q('SELECT * FROM users WHERE email = $1 AND active', [e]);
    // every attempt is logged with the email typed — never the password
    if (u && Number(u.lock_until) > Date.now()) {
      await log(u.id, 'login.failed', { email: e, reason: 'locked' });
      throw err(429, 'locked', `Too many wrong attempts. Try again in ${Math.ceil((Number(u.lock_until) - Date.now()) / 60000)} minutes.`);
    }
    if (!A.checkPassword(pw, u ? u.pw : DUMMY_HASH) || !u) {
      if (u) {
        const { rows: [x] } = await q('UPDATE users SET fails = CASE WHEN fails + 1 >= $2 THEN 0 ELSE fails + 1 END, lock_until = CASE WHEN fails + 1 >= $2 THEN $3 ELSE lock_until END WHERE id = $1 RETURNING lock_until',
          [u.id, MAX_FAILS, Date.now() + LOCK_MS]);
        await log(u.id, Number(x.lock_until) > Date.now() ? 'login.locked' : 'login.failed', { email: e, reason: 'wrong password' });
      } else await log(null, 'login.failed', { email: e, reason: 'unknown email' });
      throw err(401, 'unauthenticated', 'Email or password is wrong.');
    }
    await q('UPDATE users SET fails = 0, lock_until = 0 WHERE id = $1', [u.id]);
    await log(u.id, 'login', { email: u.email });
    const user = { id: u.id, email: u.email, name: u.name, role: u.role, ver: u.ver };
    signIn(ctx, user);
    return { user };
  }],

  // ── reminders: in-app notifications for the signed-in person ──
  ['GET', /^\/api\/notifications$/, 'viewer', async ({ user }) => {
    try { if (await runReminders()) await deliverEmails(); } catch (e) { console.error('reminders', e); } // never blocks the page
    const { rows } = await q('SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [user.id]);
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    return { unread: n, items: rows };
  }],

  ['POST', /^\/api\/notifications\/read$/, 'viewer', async ({ body, user }) => {
    if (body.all === true) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    else await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = $2 AND read_at IS NULL', [user.id, intId(body.id, 'Notification')]);
    return {};
  }],

  // check and send reminders now (admins), and see what email reminders did
  ['POST', /^\/api\/reminders\/run$/, 'admin', async ({ user }) => {
    const made = await runReminders({ force: true }), mail = await deliverEmails();
    await log(user.id, 'emi.reminders', { ...made, ...mail });
    return { ...made, ...mail };
  }],

  ['GET', /^\/api\/reminders\/status$/, 'admin', async () => ({
    emailConfigured: emailConfigured(), scheduleConfigured: !!process.env.CRON_SECRET,
    outbox: (await q('SELECT id, to_addr, subject, status, error, attempts, created_at, sent_at FROM email_outbox ORDER BY id DESC LIMIT 30')).rows,
  })],

  // the daily scheduled run (Vercel Cron sends "Authorization: Bearer <CRON_SECRET>")
  ['GET', /^\/api\/cron\/reminders$/, null, async ({ req }) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw err(503, 'config', 'Scheduled reminders are not set up: add CRON_SECRET.');
    if (!A.safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) throw err(401, 'unauthenticated', 'Not allowed.');
    const made = await runReminders({ force: true }), mail = await deliverEmails(50);
    await log(null, 'emi.reminders', { ...made, ...mail, via: 'schedule' });
    return { ...made, ...mail };
  }],

  ['POST', /^\/api\/logout$/, null, async (ctx) => {
    if (ctx.user) await log(ctx.user.id, 'logout', { email: ctx.user.email });
    ctx.headers.push(['Set-Cookie', A.cookieHeader('', ctx.secure, 0)]);
    return {};
  }],

  ['GET', /^\/api\/position$/, 'viewer', async ({ url }) => {
    const today = todayIST(), p = url.searchParams;
    const date = p.get('date') ? ymd(p.get('date')) : today;
    if (date < today) bad('Pick today or a later date.');
    await withTx((c) => syncEmis(c, addDays(date, HORIZON)));
    const result = await position({ query: q }, { today, upTo: date, approvedOnly: p.get('approvedOnly') === '1', uncertain: p.get('uncertain') !== '0' });
    return { today, date, ...result };
  }],

  ['GET', /^\/api\/emis$/, 'viewer', async () => {
    const today = todayIST();
    const { rows } = await q(`SELECT e.id, e.lender, e.ref, e.amount, e.day, e.bank_id, e.start_date, e.end_date, e.hold_days, e.active, b.name AS bank_name,
        e.remind_before, e.remind_due, e.remind_overdue, e.remind_in_app, e.remind_email, e.remind_to,
        (SELECT min(p.due_date) FROM payments p WHERE p.emi_id = e.id AND p.status = 'OPEN'
           AND p.amount > coalesce((SELECT sum(x.amount) FROM entries x WHERE x.payment_id = p.id), 0)) AS next_due
      FROM emis e JOIN banks b ON b.id = e.bank_id ORDER BY e.active DESC, e.lender, e.id`);
    return { today, emis: rows };
  }],

  ['POST', /^\/api\/emis$/, 'editor', async ({ body, user }) => {
    const today = todayIST();
    const e = {
      lender: need(str(body.lender, 120), 'Lender / loan'), ref: str(body.ref, 80), amount: toPaise(body.amount, 'EMI amount', { allowZero: false }),
      bankId: intId(body.bank_id, 'Account'), start: ymd(body.start_date, 'First EMI date'), end: ymd(body.end_date, 'Last EMI date', { optional: true }),
      ...emiSettings(body),
    };
    if (e.start < addDays(today, -31)) bad('First EMI date: enter the next EMI you still have to pay, not one from long ago.');
    if (e.end && e.end < e.start) bad('Last EMI date must be after the first one.');
    return withTx(async (c) => {
      await bankExists(c, e.bankId);
      // the same loan twice would hold and pay the money twice
      if (!body.confirmDuplicate) {
        const { rows: [d] } = await c.query('SELECT lender FROM emis WHERE active AND lower(lender) = lower($1) AND bank_id = $2 AND amount = $3 AND day = $4 LIMIT 1',
          [e.lender, e.bankId, e.amount, Number(e.start.slice(8))]);
        if (d) throw err(409, 'duplicate', `An active EMI “${d.lender}” for ${inr(e.amount)} on day ${Number(e.start.slice(8))} from this account already exists. Add another one anyway?`);
      }
      const { rows: [x] } = await c.query(`INSERT INTO emis (lender, ref, amount, day, bank_id, start_date, end_date, hold_days, remind_before, remind_due, remind_overdue, remind_in_app, remind_email, remind_to, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::smallint[], $10, $11, $12, $13, $14, $15) RETURNING id`,
        [e.lender, e.ref, e.amount, Number(e.start.slice(8)), e.bankId, e.start, e.end, e.hold_days, e.remind_before, e.remind_due, e.remind_overdue, e.remind_in_app, e.remind_email, e.remind_to, user.id]);
      await audit(c, user.id, 'emi.add', { id: x.id, ...e });
      await syncEmis(c, addDays(today, HORIZON));
      return x;
    });
  }],

  // change how far ahead money is held and how reminders are sent (send only what changes)
  ['POST', /^\/api\/emis\/(\d+)$/, 'editor', async ({ body, user, m }) => withTx(async (c) => {
    const id = intId(m[1]);
    const { rows: [old] } = await c.query('SELECT lender, hold_days, remind_before, remind_due, remind_overdue, remind_in_app, remind_email, remind_to FROM emis WHERE id = $1 FOR UPDATE', [id]);
    if (!old) notFound('That EMI doesn’t exist.');
    const next = emiSettings(body, old), diff = changes(old, next);
    if (!Object.keys(diff).length) return {};
    await c.query('UPDATE emis SET hold_days = $2, remind_before = $3::smallint[], remind_due = $4, remind_overdue = $5, remind_in_app = $6, remind_email = $7, remind_to = $8 WHERE id = $1',
      [id, next.hold_days, next.remind_before, next.remind_due, next.remind_overdue, next.remind_in_app, next.remind_email, next.remind_to]);
    await audit(c, user.id, 'emi.edit', { id, lender: old.lender, changes: diff });
    return {};
  })],

  // the dashboard: balances, money reserved for EMIs, what is available, EMIs due soon or overdue, accounts that can't
  // cover their EMIs, and the money received and paid this month
  ['GET', /^\/api\/dashboard$/, 'viewer', async () => {
    const today = todayIST(), from = `${today.slice(0, 8)}01`;
    const ov = await emiOverview(today);
    const [open, banks, balances, entries] = await Promise.all([
      emiSchedule({ query: q }, today).then((rows) => withCoverage(rows.filter((r) => !r.projected && r.left > 0), today)),
      q('SELECT id, name, bank, last4 FROM banks ORDER BY name, id'), q('SELECT id, bank_id, amount, as_of FROM balances'), q('SELECT kind, bank_id, amount, date FROM entries'),
    ]);
    const month = bankStatements({ banks: banks.rows, balances: balances.rows, entries: entries.rows, from, to: today }).total;
    const sum = (xs) => ({ count: xs.length, amount: xs.reduce((n, r) => n + r.left, 0) });
    const within = (days) => sum(open.filter((r) => r.due_date >= today && r.due_date <= addDays(today, days)));
    return {
      today, from, balance: ov.totals.balance, reserved: ov.totals.reserved, available: ov.totals.available,
      next7: within(7), next30: within(30), overdue: sum(open.filter((r) => r.due_date < today)),
      received: month.received, paid: month.paid,
      shortfalls: open.filter((r) => r.covered === false && r.due_date <= addDays(today, 30))
        .map((r) => ({ payment_id: r.payment_id, lender: r.lender, bank_id: r.bank_id, bank_name: r.bank_name, due_date: r.due_date, left: r.left, short_by: r.short_by })),
    };
  }],

  // money reserved for EMIs and what is left to spend, per account; overdue and upcoming instalments
  ['GET', /^\/api\/emis\/overview$/, 'viewer', async () => emiOverview(todayIST())],

  // every instalment: past and current ones from the records, future ones projected 12 months ahead
  ['GET', /^\/api\/emis\/schedule$/, 'viewer', async ({ url }) => {
    const today = todayIST(), p = url.searchParams;
    const status = oneOf(p.get('status') || '', ['', 'open', 'overdue', 'due', 'upcoming', 'scheduled', 'paid', 'cancelled'], 'Status');
    const emi = p.get('emi') ? intId(p.get('emi'), 'EMI') : null, bank = p.get('bank') ? intId(p.get('bank'), 'Bank account') : null;
    const from = ymd(p.get('from'), 'From', { optional: true }), to = ymd(p.get('to'), 'To', { optional: true });
    if (from && to && from > to) bad('The “from” date must be on or before the “to” date.');
    await withTx((c) => syncEmis(c, addDays(today, HORIZON)));
    const rows = (await withCoverage(await emiSchedule({ query: q }, today), today)).filter((r) =>
      (!status || (status === 'open' ? ['overdue', 'due', 'upcoming', 'scheduled'].includes(r.state) && !r.projected : r.state === status)) &&
      (!emi || r.emi_id === emi) && (!bank || r.bank_id === bank) && (!from || r.due_date >= from) && (!to || r.due_date <= to));
    return { today, rows };
  }],

  // no more EMIs after today: instalments due later that have nothing paid are cancelled
  ['POST', /^\/api\/emis\/(\d+)\/stop$/, 'editor', async ({ user, m }) => withTx(async (c) => {
    const id = intId(m[1]), today = todayIST();
    const { rowCount } = await c.query('UPDATE emis SET active = false, end_date = $2 WHERE id = $1 AND active', [id, today]);
    if (!rowCount) notFound('That EMI is already stopped.');
    const { rowCount: dropped } = await c.query(`UPDATE payments p SET status = 'CANCELLED' WHERE p.emi_id = $1 AND p.status = 'OPEN' AND p.due_date > $2
      AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.payment_id = p.id)`, [id, today]);
    await audit(c, user.id, 'emi.stop', { id, cancelledInstalments: dropped });
    return {};
  })],

  ['POST', /^\/api\/banks$/, 'admin', async ({ body, user }) => {
    const name = need(str(body.name, 80), 'Account name'), bank = need(str(body.bank, 80), 'Bank'), last4 = str(body.last4, 4);
    if (!/^\d{4}$/.test(last4)) bad('Last 4 digits: enter exactly 4 digits of the account number.');
    return withTx(async (c) => {
      const { rows: [b] } = await c.query('INSERT INTO banks (name, bank, last4, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [name, bank, last4, user.id]);
      await audit(c, user.id, 'bank.add', { id: b.id, name, bank, last4 });
      return b;
    });
  }],

  // what deleting an account would remove, shown before the admin confirms
  ['GET', /^\/api\/banks\/(\d+)\/usage$/, 'admin', async ({ m }) => bankUsage({ query: q }, intId(m[1], 'Bank account'))],

  // delete an account; the admin types its name to confirm
  ['POST', /^\/api\/banks\/(\d+)\/delete$/, 'admin', async ({ body, user, m }) => withTx(async (c) => {
    const id = intId(m[1], 'Bank account');
    await c.query('SELECT id FROM banks WHERE id = $1 FOR UPDATE', [id]);
    const u = await bankUsage(c, id);
    if (str(body.confirm, 80).toLowerCase() !== u.name.toLowerCase()) bad(`To confirm, type the account’s name exactly: ${u.name}`);
    // receipts and payments settled only through this account, and the instalments of its EMIs, go with it
    const only = (col) => `SELECT DISTINCT e.${col} FROM entries e WHERE e.bank_id = $1 AND e.${col} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.${col} = e.${col} AND x.bank_id <> $1)`;
    const recs = (await c.query(only('receipt_id'), [id])).rows.map((r) => r.receipt_id);
    const pays = [...new Set([...(await c.query(only('payment_id'), [id])).rows.map((r) => r.payment_id),
      ...(await c.query('SELECT p.id FROM payments p JOIN emis e ON e.id = p.emi_id WHERE e.bank_id = $1', [id])).rows.map((r) => r.id)])];
    const { rowCount: entries } = await c.query('DELETE FROM entries WHERE bank_id = $1 OR receipt_id = ANY($2::int[]) OR payment_id = ANY($3::int[])', [id, recs, pays]);
    await c.query('DELETE FROM receipts WHERE id = ANY($1::int[])', [recs]);
    await c.query('DELETE FROM payments WHERE id = ANY($1::int[])', [pays]);
    await c.query('DELETE FROM emis WHERE bank_id = $1', [id]);
    const moved = (await c.query('UPDATE receipts SET bank_id = NULL WHERE bank_id = $1', [id])).rowCount + (await c.query('UPDATE payments SET bank_id = NULL WHERE bank_id = $1', [id])).rowCount;
    await c.query('DELETE FROM balances WHERE bank_id = $1', [id]);
    await c.query('DELETE FROM banks WHERE id = $1', [id]);
    const result = { id, name: u.name, bank: u.bank, last4: u.last4, balances: u.balances, entries, receivedAmount: u.received_amount, paidAmount: u.paid_amount,
      emis: u.emis, receiptsDeleted: recs.length, paymentsDeleted: pays.length, nowNotDecided: moved };
    await audit(c, user.id, 'bank.delete', result);
    return result;
  })],

  // the balance shown in net banking / the statement at the end of a day (or right now, dated today)
  ['POST', /^\/api\/balances$/, 'editor', async ({ body, user }) => {
    const bankId = intId(body.bank_id, 'Account'), amount = toPaise(body.amount, 'Balance', { allowNegative: true });
    const asOf = notFuture(ymd(body.as_of || todayIST(), 'Balance date'), 'Balance date'), note = str(body.note, 300);
    return withTx(async (c) => {
      await bankExists(c, bankId);
      const { rows: [b] } = await c.query('INSERT INTO balances (bank_id, amount, as_of, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [bankId, amount, asOf, note, user.id]);
      await audit(c, user.id, 'balance.add', { id: b.id, bankId, amount, asOf });
      return b;
    });
  }],

  ['POST', /^\/api\/receipts$/, 'editor', async ({ body, user }) => withTx((c) => addReceipt(c, body, user))],

  ['POST', /^\/api\/payments$/, 'editor', async ({ body, user }) => withTx((c) => addPayment(c, body, user))],

  // record money that actually left / arrived in the bank — all of what is left, or part of it
  ['POST', /^\/api\/(receipts|payments)\/(\d+)\/settle$/, 'editor', async ({ body, user, m }) =>
    withTx((c) => settle(c, { table: m[1], id: intId(m[2]), body, user })).catch(unique(REF_TAKEN))],

  // ── transactions: money actually received / paid, bank statements for a period, and reports ──
  // add a receipt or payment as pending (no effect on balances), or as already received / paid in one step
  ['POST', /^\/api\/transactions$/, 'editor', async ({ body, user }) => {
    const kind = oneOf(body.kind, ['IN', 'OUT'], 'Type'), status = oneOf(body.status || 'pending', ['pending', 'completed'], 'Status');
    const date = ymd(body.date, 'Date'), b = { ...body, expected_date: date, due_date: date };
    if (status === 'completed' && !b.bank_id) bad('Choose the bank account the money went through.');
    return withTx(async (c) => {
      const x = kind === 'IN' ? await addReceipt(c, b, user) : await addPayment(c, b, user);
      if (status === 'completed') await settle(c, { table: kind === 'IN' ? 'receipts' : 'payments', id: x.id, body: { bank_id: b.bank_id, date, ref: b.bank_ref }, user });
      return { id: x.id, kind, status };
    }).catch(unique(REF_TAKEN));
  }],

  ['POST', /^\/api\/import\/check$/, 'editor', async ({ body }) => withTx((c) => sheetImport(c, body))],

  // adds the sheet's good rows as yet to be paid / received; rows that look like duplicates only when asked
  ['POST', /^\/api\/import\/add$/, 'editor', async ({ body, user }) => withTx(async (c) => {
    const x = await sheetImport(c, body);
    const add = x.rows.filter((r) => r.status === 'ok' || (r.status === 'duplicate' && body.includeDuplicates === true));
    if (!add.length) bad('Nothing to add: every row has a problem or is already in the app.');
    const cols = (rows, ...keys) => keys.map((k) => rows.map((r) => (typeof k === 'function' ? k(r) : r[k])));
    const ins = add.filter((r) => r.kind === 'IN'), outs = add.filter((r) => r.kind === 'OUT');
    if (ins.length) {
      await c.query(`INSERT INTO receipts (party, ref, amount, expected_date, bank_id, note, created_by)
        SELECT t.party, t.ref, t.amount, t.d, t.bank, t.note, $7 FROM unnest($1::text[], $2::text[], $3::bigint[], $4::date[], $5::int[], $6::text[]) AS t(party, ref, amount, d, bank, note)`,
      [...cols(ins, 'name', 'ref', 'amount', 'date', 'bank_id', 'note'), user.id]);
    }
    if (outs.length) {
      await c.query(`INSERT INTO payments (payee, ref, ref_norm, category, amount, due_date, bank_id, note, approved, created_by)
        SELECT t.payee, t.ref, t.ref_norm, t.category, t.amount, t.d, t.bank, t.note, $9, $10 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::date[], $7::int[], $8::text[]) AS t(payee, ref, ref_norm, category, amount, d, bank, note)`,
      [...cols(outs, 'name', 'ref', (r) => normRef(r.ref), 'category', 'amount', 'date', 'bank_id', 'note'), user.role === 'admin', user.id]);
    }
    const dates = add.map((r) => r.date).sort();
    const result = { added: add.length, receipts: ins.length, payments: outs.length, skipped: x.rows.length - add.length, from: dates[0], to: dates.at(-1) };
    await audit(c, user.id, 'import.add', { file: x.fileName, sheet: x.sheet, ...result, receiptAmount: ins.reduce((n, r) => n + r.amount, 0), paymentAmount: outs.reduce((n, r) => n + r.amount, 0) });
    return result;
  })],

  ['POST', /^\/api\/reconcile\/check$/, 'editor', async ({ body }) => withTx((c) => reconcileCheck(c, body))],

  // read a statement (any PDF, or a photo of one) with Claude: returns its lines, which then go to check / apply
  ['POST', /^\/api\/reconcile\/ai-read$/, 'editor', async ({ body, user }) => {
    const file = String(body.file ?? '');
    if (!file || !/^[A-Za-z0-9+/=\s]+$/.test(file)) bad('Choose the bank statement file.');
    const buf = Buffer.from(file, 'base64');
    if (buf.length > MAX_BYTES) bad('That file is too big. Upload at most 3 MB.');
    const r = await readWithAi(buf, str(body.name, 200));
    await log(user.id, 'reconcile.ai_read', { file: r.file, model: r.model, lines: r.table.rows.length - 1, tokens: r.usage });
    return { lines: r.table.rows.map((x) => x.cells), note: r.note };
  }],

  // apply what was chosen: matched debits are recorded as paid (dated as in the statement); left-out payments are
  // moved to today or tomorrow, or cancelled; debits not in the app can be recorded as new payments
  ['POST', /^\/api\/reconcile\/apply$/, 'editor', async ({ body, user }) => withTx(async (c) => {
    const x = await reconcileCheck(c, body), bankId = x.bank.id, today = todayIST();
    const lines = new Map(x.debits.map((d) => [d.row, d])), pays = new Map(x.payments.map((p) => [p.id, p]));
    const rows = new Set(), paid = new Set(), out = { paid: 0, paidAmount: 0, recorded: 0, recordedAmount: 0, today: 0, tomorrow: 0, cancelled: 0, balanceSaved: false };
    const useLine = (row) => {
      const l = lines.get(Number(row));
      if (!l) bad(`Statement row ${row} isn’t a payment out.`);
      if (l.recorded) bad(`Statement row ${row} is already in the app.`);
      if (rows.has(l.row)) bad(`Statement row ${row} is used twice.`);
      rows.add(l.row);
      return l;
    };
    for (const m of [].concat(body.matches ?? [])) {
      const l = useLine(m.row), p = pays.get(Number(m.id));
      if (!p) bad(`Payment P-${m.id} isn’t waiting to be paid any more.`);
      if (paid.has(p.id)) bad(`${p.name} is matched to two statement rows.`);
      if (l.amount > p.outstanding) bad(`${p.name}: the statement shows ${inr(l.amount)}, more than the ${inr(p.outstanding)} left to pay.`);
      paid.add(p.id);
      await settle(c, { table: 'payments', id: p.id, body: { bank_id: bankId, date: l.date, ref: l.bankRef, amount: (l.amount / 100).toFixed(2), fromStatement: true }, user });
      out.paid++; out.paidAmount += l.amount;
    }
    for (const r of [].concat(body.record ?? [])) {
      const l = useLine(r.row);
      if (l.reversedBy) bad(`Statement row ${l.row} was reversed by the bank (row ${l.reversedBy}): it isn’t a payment to record.`);
      const p = await addPayment(c, { payee: str(r.payee, 120) || l.payee || 'Bank debit', category: r.category || 'Other', amount: (l.amount / 100).toFixed(2), due_date: l.date,
        bank_id: bankId, note: str(`From the bank statement: ${l.narration}`, 300), approved: true, confirmDuplicate: true }, user);
      await settle(c, { table: 'payments', id: p.id, body: { bank_id: bankId, date: l.date, ref: l.bankRef, fromStatement: true }, user });
      out.recorded++; out.recordedAmount += l.amount;
    }
    for (const a of [].concat(body.leftOut ?? [])) {
      const action = oneOf(a.action, ['today', 'tomorrow', 'cancel'], 'Left out'), p = pays.get(Number(a.id));
      if (!p) bad(`Payment P-${a.id} isn’t waiting to be paid any more.`);
      if (paid.has(p.id)) bad(`${p.name} is both matched and left out.`);
      if (action === 'cancel') {
        await c.query("UPDATE payments SET status = 'CANCELLED' WHERE id = $1 AND status = 'OPEN'", [p.id]);
        await audit(c, user.id, 'payment.cancel', { id: p.id, payee: p.name, reason: 'Not in the bank statement (reconciliation)' });
        out.cancelled++;
      } else {
        // an EMI's instalment keeps its date (the EMI would make it again); it can be paid or cancelled
        if (p.emi) bad(`${p.name} is an EMI instalment: it keeps its due date. Mark it paid, or cancel it.`);
        const date = action === 'today' ? today : addDays(today, 1);
        await c.query('UPDATE payments SET due_date = $2 WHERE id = $1', [p.id, date]);
        await audit(c, user.id, 'payment.reschedule', { id: p.id, payee: p.name, amount: p.outstanding, from: p.due_date, to: date, reason: 'Not in the bank statement (reconciliation)' });
        out[action]++;
      }
    }
    if (body.saveBalance === true) {
      if (!x.closing) bad('This statement has no balance column, so there is no closing balance to save.');
      await c.query('INSERT INTO balances (bank_id, amount, as_of, note, created_by) VALUES ($1, $2, $3, $4, $5)', [bankId, x.closing.amount, x.closing.date, 'From the bank statement', user.id]);
      await audit(c, user.id, 'balance.add', { bankId, amount: x.closing.amount, asOf: x.closing.date, fromStatement: true });
      out.balanceSaved = true;
    }
    if (!out.paid && !out.recorded && !out.today && !out.tomorrow && !out.cancelled && !out.balanceSaved) bad('Nothing chosen to apply.');
    await audit(c, user.id, 'reconcile.apply', { bank: x.bank.name, bankId, file: x.fileName, from: x.from, to: x.to, ...out });
    return out;
  })],

  // a sample sheet with the headings the upload understands
  ['GET', /^\/api\/import\/sample$/, 'viewer', async () => ({ file: {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'receipts-payments-upload-sample.xlsx',
    body: toXlsx([
      ['Type', 'Name', 'Amount', 'Due date', 'Invoice / bill no.', 'Description', 'Category', 'Bank account'],
      ['Payment', 'Steel Co', 125000, '25/10/2026', 'BILL-2291', 'October steel', 'Vendor', 'HDFC'],
      ['Payment', 'Office rent', 45000, '01/11/2026', '', 'November rent', 'Rent', ''],
      ['Receipt', 'Mehta Retail', 80000, '28/10/2026', 'INV-118', 'Order 42', '', ''],
    ], 'Upload'),
  } })],

  // the Banks page: each account's day — opening balance, debits (money paid out), credits (money received), closing
  // balance, the day's transactions, and its EMIs (due that day, reserved now, the next one). Same figures as Transactions.
  ['GET', /^\/api\/banks\/day$/, 'viewer', async ({ url }) => {
    const today = todayIST(), date = url.searchParams.get('date') ? ymd(url.searchParams.get('date'), 'Date') : today;
    if (date > today) bad('Pick today or an earlier day.');
    await withTx((c) => syncEmis(c, addDays(today, HORIZON)));
    const [banks, balances, entries, moves, sched, pos] = await Promise.all([
      q('SELECT id, name, bank, last4 FROM banks ORDER BY name, id'), q('SELECT id, bank_id, amount, as_of FROM balances'),
      q('SELECT kind, bank_id, amount, date FROM entries'), history({ from: date, to: date, bank: null, type: '', q: '' }),
      emiSchedule({ query: q }, today), position({ query: q }, { today, upTo: today }),
    ]);
    const st = bankStatements({ banks: banks.rows, balances: balances.rows, entries: entries.rows, from: date, to: date });
    const held = new Map(pos.rows.filter((r) => r.id != null).map((r) => [r.id, r.held]));
    const real = sched.filter((r) => !r.projected);
    const rows = st.rows.map((b) => ({
      ...b,
      debits: moves.filter((m) => m.bank_id === b.id && m.kind === 'OUT').map((m) => ({ name: m.name, amount: m.amount, ref: m.bank_ref, note: m.note || (m.emi ? 'EMI' : m.category) })),
      credits: moves.filter((m) => m.bank_id === b.id && m.kind === 'IN').map((m) => ({ name: m.name, amount: m.amount, ref: m.bank_ref, note: m.note })),
      emisDue: real.filter((r) => r.bank_id === b.id && r.due_date === date && r.state !== 'cancelled')
        .map((r) => ({ lender: r.lender, amount: r.amount, paid: r.paid, left: r.left, state: r.state, paid_on: r.last_date })),
      reserved: held.get(b.id) ?? 0,
      nextEmi: (({ lender, left, due_date } = {}) => (lender ? { lender, amount: left, due_date } : null))(real.find((r) => r.bank_id === b.id && r.due_date > date && r.left > 0)),
    }));
    const total = { ...st.total, reserved: rows.reduce((n, r) => n + r.reserved, 0), emiDue: rows.reduce((n, r) => n + r.emisDue.reduce((m, e) => m + e.amount, 0), 0) };
    return { date, today, banks: rows, total };
  }],

  ['GET', /^\/api\/transactions\/summary$/, 'viewer', async ({ url }) => {
    const f = txFilters(url), today = todayIST();
    await withTx((c) => syncEmis(c, addDays(today, HORIZON)));
    const [banks, balances, entries, open] = await Promise.all([
      q('SELECT id, name, bank, last4 FROM banks ORDER BY name, id'), q('SELECT id, bank_id, amount, as_of FROM balances'),
      q('SELECT kind, bank_id, amount, date FROM entries'), records({ ...f, status: '', type: '', q: '' }),
    ]);
    const st = bankStatements({ banks: banks.rows, balances: balances.rows, entries: entries.rows, from: f.from, to: f.to, only: f.bank });
    const pending = { IN: { count: 0, amount: 0 }, OUT: { count: 0, amount: 0 } };
    for (const r of open) if ((r.state === 'pending' || r.state === 'partial') && r.date >= f.from && r.date <= f.to) { pending[r.kind].count++; pending[r.kind].amount += r.amount - r.settled; }
    return { today, from: f.from, to: f.to, accounts: banks.rows, banks: st.rows, total: st.total, pending };
  }],

  // view=history: money actually received and paid · view=records: every receipt and payment with its status
  ['GET', /^\/api\/transactions$/, 'viewer', async ({ url }) => {
    const f = txFilters(url);
    return { from: f.from, to: f.to, view: f.view, rows: f.view === 'history' ? await history(f) : await records(f) };
  }],

  ['GET', /^\/api\/transactions\/export$/, 'viewer', async ({ url, user }) => {
    const f = txFilters(url), format = oneOf(url.searchParams.get('format') || 'csv', ['csv', 'xlsx'], 'Format');
    const rows = f.view === 'history' ? await history(f) : await records(f);
    const table = f.view === 'history' ? historyTable(rows) : recordsTable(rows);
    await log(user.id, 'report.export', { view: f.view, format, from: f.from, to: f.to, bank: f.bank, type: f.type, status: f.status, q: f.q, field: f.field, rows: rows.length });
    const name = `${f.view === 'history' ? 'transactions' : 'receipts-payments'}-${f.from}-to-${f.to}.${format}`;
    return format === 'csv'
      ? { file: { type: 'text/csv; charset=utf-8', name, body: toCsv(table) } }
      : { file: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name, body: toXlsx(table, f.view === 'history' ? 'Transactions' : 'Receipts & payments') } };
  }],

  // delete a receipt or payment, with any money recorded on it (balances change accordingly). Admins only.
  ['POST', /^\/api\/(receipts|payments)\/(\d+)\/delete$/, 'admin', async ({ user, m }) => withTx(async (c) => {
    const isIn = m[1] === 'receipts', id = intId(m[2]);
    const { rows: [x] } = await c.query(isIn
      ? 'SELECT party AS name, amount, expected_date AS date, ref, NULL AS emi_id FROM receipts WHERE id = $1 FOR UPDATE'
      : 'SELECT payee AS name, amount, due_date AS date, ref, emi_id FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (!x) notFound('That record doesn’t exist (it may already be deleted).');
    // an EMI's instalments are made from the EMI; a deleted one would only be made again
    if (x.emi_id != null) bad('This is an EMI instalment, so it can’t be deleted. Cancel it instead, or stop the EMI on EMI Management.');
    const { rows: gone } = await c.query(`DELETE FROM entries WHERE ${isIn ? 'receipt_id' : 'payment_id'} = $1 RETURNING amount, bank_id, date, ref`, [id]);
    await c.query(`DELETE FROM ${m[1]} WHERE id = $1`, [id]);
    await audit(c, user.id, `${m[1].slice(0, -1)}.delete`, { id, [isIn ? 'party' : 'payee']: x.name, amount: Number(x.amount), date: x.date, ref: x.ref,
      settled: gone.reduce((n, e) => n + Number(e.amount), 0), entries: gone.map((e) => ({ amount: Number(e.amount), bank_id: e.bank_id, date: e.date, ref: e.ref })) });
    return { deleted: id, settled: gone.reduce((n, e) => n + Number(e.amount), 0) };
  })],

  ['POST', /^\/api\/(receipts|payments)\/(\d+)\/cancel$/, 'editor', async ({ body, user, m }) => withTx(async (c) => {
    const { rowCount } = await c.query(`UPDATE ${m[1]} SET status = 'CANCELLED' WHERE id = $1 AND status = 'OPEN'`, [intId(m[2])]);
    if (!rowCount) notFound('Nothing to cancel — it may already be cancelled.');
    await audit(c, user.id, `${m[1].slice(0, -1)}.cancel`, { id: Number(m[2]), reason: str(body.reason, 300) });
    return {};
  })],

  ['POST', /^\/api\/payments\/(\d+)\/approve$/, 'admin', async ({ user, m }) => withTx(async (c) => {
    const { rowCount } = await c.query("UPDATE payments SET approved = true WHERE id = $1 AND status = 'OPEN' AND NOT approved", [intId(m[1])]);
    if (!rowCount) notFound('Nothing to approve — it may already be approved or cancelled.');
    await audit(c, user.id, 'payment.approve', { id: Number(m[1]) });
    return {};
  })],

  // ── users: everyone who can sign in. Only admins see and manage them; each signs in with their email and the
  // password the admin set (and can change it themselves) ──
  ['GET', /^\/api\/users$/, 'admin', async () => ({
    users: (await q(`SELECT u.id, u.email, u.name, u.role, u.active, u.created_at,
        (SELECT max(a.at) FROM audit a WHERE a.user_id = u.id AND a.action IN ('login', 'setup')) AS last_login
      FROM users u WHERE u.deleted_at IS NULL ORDER BY u.active DESC, lower(u.name), u.id`)).rows,
  })],

  ['POST', /^\/api\/users$/, 'admin', async ({ body, user }) => {
    const e = email(body.email), name = need(str(body.name, 100), 'Name'), role = oneOf(body.role, ROLES, 'Role'), problem = A.passwordProblem(body.password);
    if (problem) bad(`Password: ${problem}`);
    return withTx(async (c) => {
      const { rows: [u] } = await c.query('INSERT INTO users (email, name, pw, role) VALUES ($1, $2, $3, $4) RETURNING id', [e, name, A.hashPassword(body.password), role]);
      await audit(c, user.id, 'user.add', { id: u.id, name, email: e, role });
      return u;
    }).catch(unique('Someone already signs in with that email.'));
  }],

  // name and email (the login ID); changing the email takes effect at their next sign-in
  ['POST', /^\/api\/users\/(\d+)$/, 'admin', async ({ body, user, m }) => withTx(async (c) => {
    const u = await userForChange(c, intId(m[1], 'User'), user.id);
    const next = { name: 'name' in body ? need(str(body.name, 100), 'Name') : u.name, email: 'email' in body ? email(body.email) : u.email };
    const diff = changes({ name: u.name, email: u.email }, next);
    if (!Object.keys(diff).length) return {};
    await c.query('UPDATE users SET name = $2, email = $3 WHERE id = $1', [u.id, next.name, next.email]);
    await audit(c, user.id, 'user.edit', { id: u.id, name: next.name, changes: diff });
    return {};
  }).catch(unique('Someone already signs in with that email.'))],

  ['POST', /^\/api\/users\/(\d+)\/role$/, 'admin', async ({ body, user, m }) => withTx(async (c) => {
    const role = oneOf(body.role, ROLES, 'Role');
    const u = await userForChange(c, intId(m[1], 'User'), user.id, { notSelf: 'You can’t change your own role.' });
    if (u.role === role) return {};
    if (await lastAdmin(c, u)) bad('This is the only admin. Make someone else an admin first.');
    await c.query('UPDATE users SET role = $2 WHERE id = $1', [u.id, role]);
    await audit(c, user.id, 'user.role', { id: u.id, name: u.name, changes: { role: [u.role, role] } });
    return {};
  })],

  // a new password for someone who forgot theirs: they are signed out everywhere and use the new one
  ['POST', /^\/api\/users\/(\d+)\/password$/, 'admin', async ({ body, user, m }) => withTx(async (c) => {
    const u = await userForChange(c, intId(m[1], 'User'), user.id, { notSelf: 'To change your own password, use “Change password” at the top.' });
    if (!u.active) bad(`${u.name}’s access is removed. Restore it first.`);
    const problem = A.passwordProblem(body.password);
    if (problem) bad(`Password: ${problem}`);
    await c.query('UPDATE users SET pw = $2, ver = ver + 1, fails = 0, lock_until = 0 WHERE id = $1', [u.id, A.hashPassword(body.password)]);
    await audit(c, user.id, 'user.password', { id: u.id, name: u.name });
    return {};
  })],

  // delete a user for good: they can't sign in again and leave the Users page. Their name stays on what they recorded
  // and in the activity log; their email is released (so it can be added again) and their password is wiped.
  ['POST', /^\/api\/users\/(\d+)\/delete$/, 'admin', async ({ user, m }) => withTx(async (c) => {
    const u = await userForChange(c, intId(m[1], 'User'), user.id, { notSelf: 'You can’t delete yourself.' });
    if (await lastAdmin(c, u)) bad('This is the only admin. Make someone else an admin first.');
    await c.query(`UPDATE users SET deleted_at = now(), active = false, ver = ver + 1, email = $2, pw = $3 WHERE id = $1`,
      [u.id, `deleted-${u.id}-${Date.now()}@deleted.invalid`, A.hashPassword(crypto.randomBytes(24).toString('hex'))]);
    await c.query('DELETE FROM notifications WHERE user_id = $1', [u.id]);
    await audit(c, user.id, 'user.delete', { id: u.id, name: u.name, email: u.email, role: u.role });
    return {};
  })],

  // remove (or give back) access; removing signs them out everywhere. Nothing is deleted: their history stays.
  ['POST', /^\/api\/users\/(\d+)\/access$/, 'admin', async ({ body, user, m }) => withTx(async (c) => {
    const active = body.active === true;
    const u = await userForChange(c, intId(m[1], 'User'), user.id, { notSelf: 'You can’t remove your own access.' });
    if (u.active === active) return {};
    if (!active && await lastAdmin(c, u)) bad('This is the only admin. Make someone else an admin first.');
    await c.query('UPDATE users SET active = $2, ver = ver + 1 WHERE id = $1', [u.id, active]);
    await audit(c, user.id, active ? 'user.restore' : 'user.remove', { id: u.id, name: u.name });
    return {};
  })],

  // anyone signed in can change their own password; their other sessions end
  ['POST', /^\/api\/me\/password$/, 'viewer', async (ctx) => {
    const { body } = ctx;
    const { rows: [u] } = await q('SELECT pw FROM users WHERE id = $1', [ctx.user.id]);
    if (!A.checkPassword(String(body.current ?? ''), u.pw)) bad('Your current password is wrong.');
    const problem = A.passwordProblem(body.password);
    if (problem) bad(problem);
    const user = await withTx(async (c) => {
      const { rows: [x] } = await c.query('UPDATE users SET pw = $2, ver = ver + 1 WHERE id = $1 RETURNING id, email, name, role, ver', [ctx.user.id, A.hashPassword(body.password)]);
      await audit(c, x.id, 'password.change', {});
      return x;
    });
    signIn(ctx, user); // this session carries on
    return {};
  }],

  // ── activity log: who did what and when, newest first, 50 at a time (admins only) ──
  ['GET', /^\/api\/activity$/, 'admin', async ({ url }) => {
    const p = url.searchParams, where = [], args = [], arg = (v) => { args.push(v); return `$${args.length}`; };
    const who = p.get('user');
    if (who === 'none') where.push('a.user_id IS NULL');
    else if (who) where.push(`a.user_id = ${arg(intId(who, 'User'))}`);
    const type = p.get('type');
    if (type) where.push(`split_part(a.action, '.', 1) = ANY(${arg(ACTIVITY_TYPES[type] ?? bad('Type: choose one of the options.'))}::text[])`);
    const from = ymd(p.get('from'), 'From', { optional: true }), to = ymd(p.get('to'), 'To', { optional: true });
    if (from) where.push(`a.at >= ${arg(istStart(from))}::timestamptz`);
    if (to) where.push(`a.at < ${arg(istStart(addDays(to, 1)))}::timestamptz`);
    const term = str(p.get('q'), 100);
    if (term) { const t = arg(likeTerm(term)); where.push(`(a.action ILIKE ${t} OR a.detail::text ILIKE ${t} OR coalesce(u.name, '') ILIKE ${t} OR coalesce(u.email, '') ILIKE ${t})`); }
    if (p.get('before')) where.push(`a.id < ${arg(intId(p.get('before'), 'Page'))}`);
    const { rows } = await q(`SELECT a.id, a.at, a.action, a.detail, a.user_id, u.name AS user_name, u.email AS user_email, u.role AS user_role, u.deleted_at IS NOT NULL AS user_deleted
      FROM audit a LEFT JOIN users u ON u.id = a.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 51`, args);
    return { activity: rows.slice(0, 50), more: rows.length > 50 };
  }],
];

// an uploaded sheet arrives base64-encoded (3 MB → 4 MB); everything else is small
async function readJson(req, limit = 32768) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw err(415, 'invalid_argument', 'Send JSON.');
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw err(413, 'invalid_argument', limit > 32768 ? 'That file is too big. Upload at most 3 MB.' : 'That is too much data.'); parts.push(chunk); }
  try { const v = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { throw err(400, 'invalid_argument', 'That request couldn’t be read.'); }
}

const SECURITY = {
  // 'wasm-unsafe-eval': the OCR engine (WebAssembly, served from here) — no other script can be evaluated
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data:; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
};

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const ctx = { req, url, headers: [], secure: req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted };
  const send = (status, type, data) => {
    for (const [k, v] of ctx.headers) res.appendHeader(k, v);
    // text and JSON say they are UTF-8; downloads (Excel) and types that already name a charset go as they are
    const textual = /^(text\/|application\/json)/.test(type) && !type.includes(';');
    res.writeHead(status, { ...SECURITY, 'Content-Type': textual ? `${type}; charset=utf-8` : type });
    res.end(data);
  };
  try {
    if (!url.pathname.startsWith('/api/')) {
      const f = STATIC[url.pathname];
      if (req.method !== 'GET' || !f) return send(404, 'text/plain', 'Not found');
      return send(200, f[1], await fs.readFile(path.join(ROOT, 'public', f[0])));
    }
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) throw err(404, 'not_found', 'Not found.');
    if (req.method !== 'GET') {
      // the cookie is SameSite=Lax and writes need a JSON body; refusing other origins closes the rest of CSRF
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) deny('Requests from other sites are refused.');
      ctx.body = await readJson(req, ['/api/import/', '/api/reconcile/'].some((p) => url.pathname.startsWith(p)) ? 4_400_000 : 32768);
    }
    await ensureSchema();
    ctx.user = await currentUser(req);
    if (route[2]) {
      if (!ctx.user) throw err(401, 'unauthenticated', 'Please sign in.');
      if (RANK[ctx.user.role] < RANK[route[2]]) deny('Your role can’t do that.');
    }
    ctx.m = route[1].exec(url.pathname);
    const out = await route[3](ctx);
    if (out?.file) { // a download
      ctx.headers.push(['Content-Disposition', `attachment; filename="${out.file.name}"`]);
      return send(200, out.file.type, out.file.body);
    }
    send(200, 'application/json', JSON.stringify(out));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(status, 'application/json', JSON.stringify({ error: { code: e.code || 'internal', message: status >= 500 && e.code !== 'config' ? 'Something went wrong. Try again.' : e.message } }));
  }
}

export async function localSetup() {
  if (process.env.DATABASE_URL || process.env.POSTGRES_URL) return;
  const dir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  await fs.mkdir(dir, { recursive: true });
  const { pglitePool } = await import('./local-db.js');
  setPool(pglitePool(path.join(dir, 'pg')));
  if (!process.env.SESSION_SECRET) {
    const file = path.join(dir, 'session-secret');
    let s = await fs.readFile(file, 'utf8').catch(() => '');
    if (s.length < 32) { s = crypto.randomBytes(32).toString('hex'); await fs.writeFile(file, s, { mode: 0o600 }); }
    process.env.SESSION_SECRET = s;
  }
  console.log(`Using the local database in ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await localSetup();
  await ensureSchema();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(port, () => console.log(`Finance app on http://localhost:${port}`));
}
