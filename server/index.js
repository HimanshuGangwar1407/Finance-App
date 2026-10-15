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
import * as A from './auth.js';
import { bad, deny, notFound, toPaise, normRef, str, need, ymd, oneOf, intId, todayIST } from './money.js';

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
    if (u && Number(u.lock_until) > Date.now()) throw err(429, 'locked', `Too many wrong attempts. Try again in ${Math.ceil((Number(u.lock_until) - Date.now()) / 60000)} minutes.`);
    if (!A.checkPassword(pw, u ? u.pw : DUMMY_HASH) || !u) {
      if (u) await q('UPDATE users SET fails = CASE WHEN fails + 1 >= $2 THEN 0 ELSE fails + 1 END, lock_until = CASE WHEN fails + 1 >= $2 THEN $3 ELSE lock_until END WHERE id = $1', [u.id, MAX_FAILS, Date.now() + LOCK_MS]);
      throw err(401, 'unauthenticated', 'Email or password is wrong.');
    }
    await q('UPDATE users SET fails = 0, lock_until = 0 WHERE id = $1', [u.id]);
    const user = { id: u.id, email: u.email, name: u.name, role: u.role, ver: u.ver };
    signIn(ctx, user);
    return { user };
  }],

  ['POST', /^\/api\/logout$/, null, async (ctx) => { ctx.headers.push(['Set-Cookie', A.cookieHeader('', ctx.secure, 0)]); return {}; }],

  ['GET', /^\/api\/position$/, 'viewer', async ({ url }) => {
    const today = todayIST(), p = url.searchParams;
    const date = p.get('date') ? ymd(p.get('date')) : today;
    if (date < today) bad('Pick today or a later date.');
    const [banks, balances, receipts, payments, entries] = await Promise.all([
      q('SELECT id, name, bank, last4 FROM banks ORDER BY name, id'),
      q('SELECT id, bank_id, amount, as_of FROM balances'),
      q("SELECT id, party, ref, amount, expected_date, certainty, bank_id, status FROM receipts WHERE status = 'OPEN'"),
      q("SELECT id, payee, ref, category, amount, due_date, bank_id, approved, status FROM payments WHERE status = 'OPEN'"),
      q('SELECT kind, receipt_id, payment_id, bank_id, amount, date FROM entries'),
    ]);
    const result = finalBalance({
      banks: banks.rows, balances: balances.rows, receipts: receipts.rows, payments: payments.rows, entries: entries.rows,
      today, upTo: date, approvedOnly: p.get('approvedOnly') === '1', uncertain: p.get('uncertain') !== '0',
    });
    return { today, date, banks: banks.rows, ...result };
  }],

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
        const { rows: [x] } = await c.query(`SELECT id, amount, bank_id, status FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!x) notFound('That record doesn’t exist.');
        if (x.status !== 'OPEN') bad('It was cancelled.');
        const { rows: [{ done }] } = await c.query(`SELECT coalesce(sum(amount), 0)::bigint AS done FROM entries WHERE ${isIn ? 'receipt_id' : 'payment_id'} = $1`, [id]);
        const left = Number(x.amount) - Number(done);
        if (left <= 0) bad(isIn ? 'It is already fully received.' : 'It is already fully paid.');
        const amount = body.amount === '' || body.amount == null ? left : toPaise(body.amount, 'Amount', { allowZero: false });
        if (amount > left) bad(`Only ${(left / 100).toFixed(2)} is left on it.`);
        const bankId = await bankExists(c, body.bank_id ? intId(body.bank_id, 'Account') : x.bank_id ?? bad('Choose the account.'));
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

async function localSetup() {
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
