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
import * as A from './auth.js';
import { bad, deny, notFound, toPaise, normRef, str, need, ymd, oneOf, intId, todayIST, addDays, inr } from './money.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
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

// people & positions: input checks, and what changed (kept in the activity log as {field: [before, after]})
const optEmail = (v) => (str(v, 200) ? email(v) : '');
const phone = (v) => { const s = str(v, 30); if (s && !/^\+?[\d\s()-]{6,20}$/.test(s)) bad('Phone: use digits, spaces, + or -, e.g. +91 98765 43210.'); return s; };
const optPosition = (v) => (v === '' || v == null ? null : intId(v, 'Position'));
async function usablePosition(c, id) {
  if (id == null) return null;
  const { rows: [p] } = await c.query('SELECT active FROM positions WHERE id = $1', [id]);
  if (!p) bad('That position doesn’t exist.');
  if (!p.active) bad('That position is inactive. Activate it first, or choose another.');
  return id;
}
const changes = (before, after) => Object.fromEntries(Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => [k, [before[k], after[k]]]));
// a unique name/email clash becomes a readable message
const unique = (message) => (e) => { throw e.code === 'conflict' ? err(409, 'conflict', message) : e; };
const likeTerm = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
// activity log filters: a type is the part of the action before the dot
const ACTIVITY_TYPES = { signin: ['login', 'logout', 'setup', 'admin'], people: ['person'], positions: ['position'], payments: ['payment'], receipts: ['receipt'], emis: ['emi'], balances: ['balance'], accounts: ['bank'], users: ['user'] };
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
    return { needsSetup: n === 0, user, today: todayIST() };
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
      holdDays: Number(body.hold_days || 0),
    };
    if (e.start < addDays(today, -31)) bad('First EMI date: enter the next EMI you still have to pay, not one from long ago.');
    if (e.end && e.end < e.start) bad('Last EMI date must be after the first one.');
    if (!Number.isInteger(e.holdDays) || e.holdDays < 0 || e.holdDays > 31) bad('Hold from: enter 0 to 31 days.');
    return withTx(async (c) => {
      await bankExists(c, e.bankId);
      const { rows: [x] } = await c.query('INSERT INTO emis (lender, ref, amount, day, bank_id, start_date, end_date, hold_days, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [e.lender, e.ref, e.amount, Number(e.start.slice(8)), e.bankId, e.start, e.end, e.holdDays, user.id]);
      await audit(c, user.id, 'emi.add', { id: x.id, ...e });
      await syncEmis(c, addDays(today, HORIZON));
      return x;
    });
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

  ['POST', /^\/api\/receipts$/, 'editor', async ({ body, user }) => {
    const r = {
      party: need(str(body.party, 120), 'Received from'), ref: str(body.ref, 80),
      amount: toPaise(body.amount, 'Amount', { allowZero: false }), date: ymd(body.expected_date, 'Expected date'),
      certainty: oneOf(body.certainty || 'LIKELY', ['FIRM', 'LIKELY', 'UNCERTAIN'], 'Certainty'), bankId: optBank(body.bank_id), note: str(body.note, 300),
    };
    return withTx(async (c) => {
      await bankExists(c, r.bankId);
      const { rows: [x] } = await c.query('INSERT INTO receipts (party, ref, amount, expected_date, certainty, bank_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [r.party, r.ref, r.amount, r.date, r.certainty, r.bankId, r.note, user.id]);
      await audit(c, user.id, 'receipt.add', { id: x.id, ...r });
      return x;
    });
  }],

  ['POST', /^\/api\/payments$/, 'editor', async ({ body, user }) => {
    const p = {
      payee: need(str(body.payee, 120), 'Pay to'), ref: str(body.ref, 80), category: need(str(body.category, 40), 'Category'),
      amount: toPaise(body.amount, 'Amount', { allowZero: false }), date: ymd(body.due_date, 'Due date'), bankId: optBank(body.bank_id),
      approved: user.role === 'admin' && body.approved === true, note: str(body.note, 300),
    };
    const refNorm = normRef(p.ref);
    return withTx(async (c) => {
      await bankExists(c, p.bankId);
      if (refNorm && !body.confirmDuplicate) {
        const { rows: [d] } = await c.query("SELECT payee, amount, due_date FROM payments WHERE ref_norm = $1 AND status = 'OPEN' LIMIT 1", [refNorm]);
        if (d) throw err(409, 'duplicate', `A payment with reference “${p.ref}” is already open (${d.payee}, due ${d.due_date}). Add it anyway?`);
      }
      const { rows: [x] } = await c.query('INSERT INTO payments (payee, ref, ref_norm, category, amount, due_date, bank_id, approved, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
        [p.payee, p.ref, refNorm, p.category, p.amount, p.date, p.bankId, p.approved, p.note, user.id]);
      await audit(c, user.id, 'payment.add', { id: x.id, ...p });
      return x;
    });
  }],

  // record money that actually left / arrived in the bank — all of what is left, or part of it
  ['POST', /^\/api\/(receipts|payments)\/(\d+)\/settle$/, 'editor', async ({ body, user, m }) => {
    const isIn = m[1] === 'receipts', table = m[1], id = intId(m[2]);
    const ref = need(str(body.ref, 80), 'Bank reference (UTR / cheque no.)'), refNorm = normRef(ref);
    if (!refNorm) bad('Bank reference: use letters or numbers.');
    const date = notFuture(ymd(body.date || todayIST(), 'Date'), 'Date');
    try {
      return await withTx(async (c) => {
        const { rows: [x] } = await c.query(`SELECT id, amount, bank_id, status, ${isIn ? 'NULL' : 'emi_id'} AS emi_id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!x) notFound('That record doesn’t exist.');
        if (x.status !== 'OPEN') bad('It was cancelled.');
        const { rows: [{ done }] } = await c.query(`SELECT coalesce(sum(amount), 0)::bigint AS done FROM entries WHERE ${isIn ? 'receipt_id' : 'payment_id'} = $1`, [id]);
        const left = Number(x.amount) - Number(done);
        if (left <= 0) bad(isIn ? 'It is already fully received.' : 'It is already fully paid.');
        const amount = body.amount === '' || body.amount == null ? left : toPaise(body.amount, 'Amount', { allowZero: false });
        if (amount > left) bad(`Only ${(left / 100).toFixed(2)} is left on it.`);
        const bankId = await bankExists(c, body.bank_id ? intId(body.bank_id, 'Account') : x.bank_id ?? bad('Choose the account.'));
        if (!isIn && !x.emi_id) {
          // money held for EMIs can't go to anyone else; one payment per account checks at a time
          const today = todayIST();
          await c.query('SELECT pg_advisory_xact_lock(2, $1)', [bankId]);
          await syncEmis(c, addDays(today, HORIZON));
          const row = (await position(c, { today, upTo: today })).rows.find((r) => r.id === bankId);
          if (row && row.held > 0 && amount > row.free) {
            throw err(409, 'emi_hold', `Not allowed: ${inr(row.held)} in ${row.name} is held for EMIs. Of its ${inr(row.today)} balance, only ${inr(Math.max(row.free, 0))} can be paid to others. Bring in money or pay from another account.`);
          }
        }
        const { rows: [e] } = await c.query(`INSERT INTO entries (kind, ${isIn ? 'receipt_id' : 'payment_id'}, bank_id, amount, date, ref, ref_norm, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [isIn ? 'IN' : 'OUT', id, bankId, amount, date, ref, refNorm, user.id]);
        await audit(c, user.id, isIn ? 'receipt.received' : 'payment.paid', { id, entry: e.id, bankId, amount, date, ref });
        return { id: e.id, left: left - amount };
      });
    } catch (e) {
      if (e.code === 'conflict') throw err(409, 'conflict', 'That bank reference is already recorded on this account.');
      throw e;
    }
  }],

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

  ['GET', /^\/api\/users$/, 'admin', async () => ({ users: (await q('SELECT id, email, name, role, active FROM users ORDER BY name')).rows })],

  ['POST', /^\/api\/users$/, 'admin', async ({ body, user }) => {
    const e = email(body.email), name = need(str(body.name, 100), 'Name'), role = oneOf(body.role, ['viewer', 'editor', 'admin'], 'Role'), problem = A.passwordProblem(body.password);
    if (problem) bad(problem);
    try {
      return await withTx(async (c) => {
        const { rows: [u] } = await c.query('INSERT INTO users (email, name, pw, role) VALUES ($1, $2, $3, $4) RETURNING id', [e, name, A.hashPassword(body.password), role]);
        await audit(c, user.id, 'user.add', { id: u.id, email: e, role });
        return u;
      });
    } catch (x) {
      if (x.code === 'conflict') throw err(409, 'conflict', 'Someone with that email already has an account.');
      throw x;
    }
  }],

  // ── positions: admins define them; editors assign them to people ──
  ['GET', /^\/api\/positions$/, 'viewer', async () => ({
    positions: (await q(`SELECT p.id, p.name, p.description, p.active, p.updated_at,
        (SELECT count(*)::int FROM people x WHERE x.position_id = p.id AND x.active) AS people
      FROM positions p ORDER BY p.active DESC, lower(p.name), p.id`)).rows,
  })],

  ['POST', /^\/api\/positions$/, 'admin', async ({ body, user }) => {
    const v = { name: need(str(body.name, 80), 'Position name'), description: str(body.description, 300) };
    return withTx(async (c) => {
      const { rows: [x] } = await c.query('INSERT INTO positions (name, description, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id', [v.name, v.description, user.id]);
      await audit(c, user.id, 'position.add', { id: x.id, ...v });
      return x;
    }).catch(unique('A position with that name already exists.'));
  }],

  // edit the name / description, or activate / deactivate (send only what changes)
  ['POST', /^\/api\/positions\/(\d+)$/, 'admin', async ({ body, user, m }) => {
    const id = intId(m[1]);
    return withTx(async (c) => {
      const { rows: [old] } = await c.query('SELECT name, description, active FROM positions WHERE id = $1 FOR UPDATE', [id]);
      if (!old) notFound('That position doesn’t exist.');
      const next = {
        name: 'name' in body ? need(str(body.name, 80), 'Position name') : old.name,
        description: 'description' in body ? str(body.description, 300) : old.description,
        active: 'active' in body ? body.active === true : old.active,
      };
      const diff = changes(old, next);
      if (!Object.keys(diff).length) return {};
      await c.query('UPDATE positions SET name = $2, description = $3, active = $4, updated_by = $5, updated_at = now() WHERE id = $1', [id, next.name, next.description, next.active, user.id]);
      const only = Object.keys(diff).join() === 'active';
      await audit(c, user.id, only ? (next.active ? 'position.activate' : 'position.deactivate') : 'position.edit', { id, name: next.name, changes: diff });
      return {};
    }).catch(unique('A position with that name already exists.'));
  }],

  ['POST', /^\/api\/positions\/(\d+)\/assign$/, 'editor', async ({ body, user, m }) => withTx(async (c) => {
    const positionId = await usablePosition(c, intId(m[1], 'Position')), personId = intId(body.person_id, 'Person');
    const { rows: [p] } = await c.query('SELECT name, position_id, active FROM people WHERE id = $1 FOR UPDATE', [personId]);
    if (!p) notFound('That person doesn’t exist.');
    if (!p.active) bad(`${p.name} is inactive. Activate them first.`);
    if (p.position_id === positionId) return {};
    await c.query('UPDATE people SET position_id = $2, updated_by = $3, updated_at = now() WHERE id = $1', [personId, positionId, user.id]);
    await audit(c, user.id, 'person.assign', { id: personId, name: p.name, changes: { position_id: [p.position_id, positionId] } });
    return {};
  })],

  // ── people ──
  // viewers see names and positions; contact details and notes are for editors and admins
  ['GET', /^\/api\/people$/, 'viewer', async ({ url, user }) => {
    const p = url.searchParams, where = [], args = [], arg = (v) => { args.push(v); return `$${args.length}`; };
    const hide = RANK[user.role] < RANK.editor;
    const status = p.get('status') || 'active';
    if (status === 'active') where.push('x.active');
    else if (status === 'inactive') where.push('NOT x.active');
    else if (status !== 'all') bad('Status: choose active, inactive or all.');
    const pos = p.get('position');
    if (pos === 'none') where.push('x.position_id IS NULL');
    else if (pos) where.push(`x.position_id = ${arg(intId(pos, 'Position'))}`);
    const term = str(p.get('q'), 100);
    if (term) {
      const t = arg(likeTerm(term));
      where.push(`(x.name ILIKE ${t} OR coalesce(ps.name, '') ILIKE ${t}${hide ? '' : ` OR x.email ILIKE ${t} OR x.phone ILIKE ${t}`})`);
    }
    const { rows } = await q(`SELECT x.id, x.name, x.email, x.phone, x.notes, x.position_id, ps.name AS position, ps.active AS position_active, x.active,
        x.created_at, cu.name AS created_by, x.updated_at, uu.name AS updated_by
      FROM people x LEFT JOIN positions ps ON ps.id = x.position_id LEFT JOIN users cu ON cu.id = x.created_by LEFT JOIN users uu ON uu.id = x.updated_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(x.name), x.id LIMIT 500`, args);
    return { contactsHidden: hide, people: hide ? rows.map(({ email: _e, phone: _p, notes: _n, ...r }) => r) : rows };
  }],

  ['POST', /^\/api\/people$/, 'editor', async ({ body, user }) => {
    const v = { name: need(str(body.name, 120), 'Name'), email: optEmail(body.email), phone: phone(body.phone), position_id: optPosition(body.position_id), notes: str(body.notes, 500) };
    return withTx(async (c) => {
      await usablePosition(c, v.position_id);
      const { rows: [x] } = await c.query('INSERT INTO people (name, email, phone, position_id, notes, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id',
        [v.name, v.email, v.phone, v.position_id, v.notes, user.id]);
      await audit(c, user.id, 'person.add', { id: x.id, name: v.name, position_id: v.position_id });
      return x;
    }).catch(unique('Someone in People already has that email.'));
  }],

  ['POST', /^\/api\/people\/(\d+)$/, 'editor', async ({ body, user, m }) => {
    const id = intId(m[1]);
    return withTx(async (c) => {
      const { rows: [old] } = await c.query('SELECT name, email, phone, position_id, notes FROM people WHERE id = $1 FOR UPDATE', [id]);
      if (!old) notFound('That person doesn’t exist.');
      const next = {
        name: 'name' in body ? need(str(body.name, 120), 'Name') : old.name,
        email: 'email' in body ? optEmail(body.email) : old.email,
        phone: 'phone' in body ? phone(body.phone) : old.phone,
        position_id: 'position_id' in body ? optPosition(body.position_id) : old.position_id,
        notes: 'notes' in body ? str(body.notes, 500) : old.notes,
      };
      const diff = changes(old, next);
      if (!Object.keys(diff).length) return {};
      if ('position_id' in diff) await usablePosition(c, next.position_id);
      await c.query('UPDATE people SET name = $2, email = $3, phone = $4, position_id = $5, notes = $6, updated_by = $7, updated_at = now() WHERE id = $1',
        [id, next.name, next.email, next.phone, next.position_id, next.notes, user.id]);
      // the log says which contact fields changed, not their values
      for (const k of ['email', 'phone', 'notes']) if (diff[k]) diff[k] = ['…', 'changed'];
      await audit(c, user.id, 'person.edit', { id, name: next.name, changes: diff });
      return {};
    }).catch(unique('Someone in People already has that email.'));
  }],

  ['POST', /^\/api\/people\/(\d+)\/active$/, 'editor', async ({ body, user, m }) => withTx(async (c) => {
    const id = intId(m[1]), active = body.active === true;
    const { rows: [p] } = await c.query('UPDATE people SET active = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND active <> $2 RETURNING name', [id, active, user.id]);
    if (!p) notFound(active ? 'That person is already active.' : 'That person is already inactive.');
    await audit(c, user.id, active ? 'person.activate' : 'person.deactivate', { id, name: p.name });
    return {};
  })],

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
    const { rows } = await q(`SELECT a.id, a.at, a.action, a.detail, a.user_id, u.name AS user_name, u.email AS user_email, u.role AS user_role
      FROM audit a LEFT JOIN users u ON u.id = a.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 51`, args);
    return { activity: rows.slice(0, 50), more: rows.length > 50 };
  }],
];

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw err(415, 'invalid_argument', 'Send JSON.');
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw err(413, 'invalid_argument', 'That is too much data.'); parts.push(chunk); }
  try { const v = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { throw err(400, 'invalid_argument', 'That request couldn’t be read.'); }
}

const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
};

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const ctx = { req, url, headers: [], secure: req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted };
  const send = (status, type, data) => {
    for (const [k, v] of ctx.headers) res.appendHeader(k, v);
    res.writeHead(status, { ...SECURITY, 'Content-Type': `${type}; charset=utf-8` });
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
      ctx.body = await readJson(req);
    }
    await ensureSchema();
    ctx.user = await currentUser(req);
    if (route[2]) {
      if (!ctx.user) throw err(401, 'unauthenticated', 'Please sign in.');
      if (RANK[ctx.user.role] < RANK[route[2]]) deny('Your role can’t do that.');
    }
    ctx.m = route[1].exec(url.pathname);
    send(200, 'application/json', JSON.stringify(await route[3](ctx)));
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
