import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dueReminders, projectDates } from '../server/reminders.js';
import { setPool, q } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';

// ── reminder rules (pure) ──
const T = '2026-10-15';
const inst = (o) => ({ payment_id: 1, emi_id: 1, lender: 'Car loan', bank_id: 1, bank_name: 'HDFC', due_date: '2026-10-20', left: 50_000, remind_days: 3, hold_days: 0, ...o });
const kinds = (i, free = new Map([[1, 100_000]]), today = T) => dueReminders({ instalments: [inst(i)], free, today }).map((r) => r.kind);

test('reminders: upcoming from N days before, due on the day, overdue after, never once paid', () => {
  assert.deepEqual(kinds({ due_date: '2026-10-19' }), []); // 4 days ahead, reminder window is 3
  assert.deepEqual(kinds({ due_date: '2026-10-18' }), ['upcoming']);
  assert.deepEqual(kinds({ due_date: T }), ['due']);
  assert.deepEqual(kinds({ due_date: '2026-10-10' }), ['overdue']);
  assert.deepEqual(kinds({ due_date: '2026-10-16', remind_days: 0 }), []); // no advance reminder
  assert.deepEqual(kinds({ due_date: T, left: 0 }), []);
  assert.equal(dueReminders({ instalments: [inst({ due_date: T, payment_id: 7 })], free: new Map(), today: T })[0].key, 'emi:7:due');
});

test('reminders: a shortfall warning when the account can’t cover what is held, within the hold or reminder window', () => {
  const short = new Map([[1, -5_000]]);
  assert.deepEqual(kinds({ due_date: '2026-10-17' }, short), ['upcoming', 'shortfall']);
  assert.deepEqual(kinds({ due_date: '2026-10-25', hold_days: 10 }, short), ['shortfall']); // held from the 15th
  assert.deepEqual(kinds({ due_date: '2026-11-25' }, short), []); // too far ahead
  assert.match(dueReminders({ instalments: [inst({ due_date: '2026-10-17' })], free: short, today: T })[1].title, /short by ₹50/);
});

test('schedule: monthly dates, the last day in short months, stopping at the last EMI date', () => {
  assert.deepEqual(projectDates({ day: 31, start_date: '2026-01-31' }, '2026-01-01', 4), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(projectDates({ day: 5, start_date: '2026-10-05', end_date: '2026-12-05' }, '2026-10-06', 12), ['2026-11-05', '2026-12-05']);
  assert.equal(projectDates({ day: 10, start_date: '2026-01-10' }, '2026-03-01', 12).length, 12);
});

// ── the API, with a fake email service ──
const mail = [];
let mailFails = new Set();
const mailServer = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const m = JSON.parse(b);
  if (mailFails.has(m.to[0])) { res.writeHead(500); return res.end('{}'); }
  mail.push({ auth: req.headers.authorization, ...m });
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}');
}).listen(0);
const emailOn = () => Object.assign(process.env, { RESEND_API_KEY: 'test-key', EMAIL_FROM: 'Finance <finance@x.in>', EMAIL_API_URL: `http://localhost:${mailServer.address().port}/emails` });
const emailOff = () => { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; };

const pool = pglitePool();
setPool(pool);
process.env.SESSION_SECRET = 'x'.repeat(40);
const { handler } = await import('../server/index.js');
const server = http.createServer(handler).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); mailServer.close(); pool.end(); });
const session = () => {
  let cookie = '';
  return async (p, body, headers = {}) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie, ...headers } } : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
};
const admin = session(), editor = session(), viewer = session(), anon = session();
const today = todayIST();
let bank, carLoan, oldLoan;
const overview = async () => (await editor('/api/emis/overview')).body;
const schedule = async (qs = '') => (await editor(`/api/emis/schedule?${qs}`)).body.rows;

test('setup: users and an account with ₹1,00,000', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'asha@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'eli@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'vik@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'eli@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'vik@x.in', password: 'viewerpass12' });
  bank = (await admin('/api/banks', { name: 'HDFC Current', bank: 'HDFC', last4: '1111' })).body.id;
  await editor('/api/balances', { bank_id: bank, amount: '1,00,000', as_of: addDays(today, -1) });
});

test('recurring schedule: an EMI repeats monthly; the next 12 months are projected', async () => {
  const r = await editor('/api/emis', { lender: 'Car loan', amount: '30,000', bank_id: bank, start_date: addDays(today, 2), hold_days: '3', remind_days: '3', remind_in_app: true, remind_email: true, remind_to: 'Ops@X.in' });
  assert.equal(r.status, 200); carLoan = r.body.id;
  const rows = (await schedule('status=')).filter((x) => x.emi_id === carLoan);
  assert.ok(rows.length >= 13, `${rows.length} rows`);
  const day = Number(addDays(today, 2).slice(8));
  for (const x of rows) assert.ok(Number(x.due_date.slice(8)) === day || Number(x.due_date.slice(8)) < day); // same day, or month end
  const months = rows.map((x) => x.due_date.slice(0, 7));
  assert.equal(new Set(months).size, months.length); // one per month
  assert.ok(rows.some((x) => x.projected) && rows.some((x) => !x.projected));
  assert.equal(rows[0].state, 'upcoming'); assert.equal(rows[0].reserved, true); // held from 3 days before
  const e = (await editor('/api/emis')).body.emis.find((x) => x.id === carLoan);
  assert.deepEqual([e.hold_days, e.remind_days, e.remind_in_app, e.remind_email, e.remind_to], [3, 3, true, true, 'ops@x.in']);
});

test('duplicate prevention: the same loan twice is caught; instalments are never doubled', async () => {
  const again = { lender: 'CAR LOAN', amount: '30000', bank_id: bank, start_date: addDays(today, 2) };
  const r = await editor('/api/emis', again);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'duplicate');
  const forced = await editor('/api/emis', { ...again, confirmDuplicate: true });
  assert.equal(forced.status, 200);
  assert.equal((await editor(`/api/emis/${forced.body.id}/stop`, {})).status, 200);
  for (let i = 0; i < 3; i++) await editor('/api/emis/overview'); // generating again and again adds nothing
  const { rows } = await q('SELECT emi_id, due_date, count(*)::int AS n FROM payments WHERE emi_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1');
  assert.deepEqual(rows, []);
});

test('overdue tracking and fund reservation: available = balance − reserved', async () => {
  oldLoan = (await editor('/api/emis', { lender: 'Old loan', amount: '20,000', bank_id: bank, start_date: addDays(today, -3), remind_days: '0' })).body.id;
  const ov = await overview();
  assert.deepEqual([ov.totals.balance, ov.totals.reserved, ov.totals.available], [10_000_000, 5_000_000, 5_000_000]);
  assert.deepEqual(ov.totals.overdue, { count: 1, amount: 2_000_000 });
  assert.equal(ov.accounts[0].next.lender, 'Old loan');
  assert.deepEqual((await schedule('status=overdue')).map((x) => x.lender), ['Old loan']);
  assert.deepEqual((await schedule(`emi=${oldLoan}&status=overdue`)).map((x) => [x.state, x.reserved]), [['overdue', true]]);
  assert.ok((await schedule('status=open')).every((x) => !x.projected && ['overdue', 'due', 'upcoming', 'scheduled'].includes(x.state)));
  assert.ok((await schedule(`emi=${carLoan}`)).every((x) => x.emi_id === carLoan));
  // reserved money can't be paid to anyone else
  const v = (await editor('/api/payments', { payee: 'Vendor', category: 'Vendor', amount: '60,000', due_date: today, bank_id: bank })).body.id;
  assert.equal((await editor(`/api/payments/${v}/settle`, { ref: 'V1' })).body.error.code, 'emi_hold');
  assert.equal((await editor(`/api/payments/${v}/cancel`, {})).status, 200);
});

test('reminders: in-app for editors and admins, email to the chosen address — each only once', async () => {
  emailOn();
  const r = (await admin('/api/reminders/run', {})).body;
  assert.equal(r.reminders, 2); // car loan upcoming, old loan overdue
  assert.equal(r.inApp, 4); // 2 reminders × (admin + editor)
  assert.deepEqual([r.queued, r.sent], [1, 1]); // only the car loan has email on
  assert.equal(mail.length, 1);
  assert.deepEqual(mail[0].to, ['ops@x.in']);
  assert.equal(mail[0].auth, 'Bearer test-key');
  assert.match(mail[0].subject, /^Upcoming: Car loan EMI of ₹30,000/);

  const again = (await admin('/api/reminders/run', {})).body;
  assert.deepEqual([again.inApp, again.queued, again.sent], [0, 0, 0]);
  assert.equal(mail.length, 1);

  const n = (await editor('/api/notifications')).body;
  assert.equal(n.unread, 2);
  assert.deepEqual(n.items.map((x) => x.kind).sort(), ['overdue', 'upcoming']);
  assert.equal((await viewer('/api/notifications')).body.items.length, 0); // viewers aren't reminded
  await editor('/api/notifications/read', { id: n.items[0].id });
  assert.equal((await editor('/api/notifications')).body.unread, 1);
  await editor('/api/notifications/read', { all: true });
  assert.equal((await editor('/api/notifications')).body.unread, 0);
  assert.equal((await admin('/api/notifications')).body.unread, 2); // each person has their own
});

test('insufficient balance: a shortfall reminder, and confirming the payment asks first', async () => {
  const big = (await editor('/api/emis', { lender: 'Machine loan', amount: '1,50,000', bank_id: bank, start_date: addDays(today, 1), hold_days: '2', remind_email: true, remind_to: 'fail@x.in' })).body.id;
  assert.ok((await overview()).totals.available < 0);
  mailFails = new Set(['fail@x.in']);
  const r = (await admin('/api/reminders/run', {})).body;
  const notes = (await editor('/api/notifications')).body.items;
  assert.ok(notes.some((x) => x.kind === 'shortfall' && /short by/.test(x.title)));
  assert.equal(r.failed, 2); // upcoming + shortfall emails to fail@x.in
  let out = (await admin('/api/reminders/status')).body.outbox.filter((m) => m.to_addr === 'fail@x.in');
  assert.ok(out.every((m) => m.status === 'failed' && m.attempts === 1 && /answered 500/.test(m.error)));
  mailFails = new Set();
  await admin('/api/reminders/run', {}); // failed ones are retried
  out = (await admin('/api/reminders/status')).body.outbox.filter((m) => m.to_addr === 'fail@x.in');
  assert.ok(out.every((m) => m.status === 'sent' && m.attempts === 2));

  // email not set up: queued emails are marked as not sent, never lost silently
  emailOff();
  await editor(`/api/emis/${big}`, { remind_to: 'second@x.in' });
  await admin('/api/reminders/run', {});
  out = (await admin('/api/reminders/status')).body.outbox.filter((m) => m.to_addr === 'second@x.in');
  assert.ok(out.length > 0 && out.every((m) => m.status === 'skipped' && /not set up/.test(m.error)));
  assert.equal((await admin('/api/reminders/status')).body.emailConfigured, false);

  // the account has ₹1,00,000; paying ₹1,50,000 needs a confirmation (e.g. an overdraft)
  const inst = (await schedule(`emi=${big}&status=open`))[0];
  const ask = await editor(`/api/payments/${inst.payment_id}/settle`, { ref: 'M1' });
  assert.equal(ask.status, 409); assert.equal(ask.body.error.code, 'insufficient');
  assert.match(ask.body.error.message, /has ₹1,00,000\. Paying ₹1,50,000 takes it to −₹50,000/);
  assert.equal((await editor(`/api/payments/${inst.payment_id}/settle`, { ref: 'M1', confirmShortfall: true })).status, 200);
  const logged = (await admin('/api/activity?type=payments')).body.activity.find((a) => a.action === 'payment.paid' && a.detail.ref === 'M1');
  assert.equal(logged.detail.overdraft, true);
  await editor(`/api/emis/${big}/stop`, {});
});

test('payment confirmation: a paid instalment is marked paid and its money is no longer held', async () => {
  await editor('/api/balances', { bank_id: bank, amount: '2,00,000', as_of: today });
  const before = await overview();
  const inst = (await schedule(`emi=${carLoan}&status=open`))[0];
  assert.equal((await editor(`/api/payments/${inst.payment_id}/settle`, { ref: 'CAR-1' })).status, 200);
  const after = await overview();
  assert.equal(after.totals.reserved, before.totals.reserved - 3_000_000);
  assert.equal((await schedule(`emi=${carLoan}&status=paid`)).length, 1);
  // a paid instalment no longer reminds: a new run adds nothing for it
  const count = async () => (await q(`SELECT (SELECT count(*) FROM notifications WHERE dedupe_key LIKE $1) + (SELECT count(*) FROM email_outbox WHERE dedupe_key LIKE $1) AS n`, [`emi:${inst.payment_id}:%`])).rows[0].n;
  const before2 = await count();
  await admin('/api/reminders/run', {});
  assert.equal(await count(), before2);
});

test('settings: reminders and holds can be changed, with checks and an audit entry', async () => {
  assert.equal((await editor(`/api/emis/${carLoan}`, { remind_days: '7', remind_email: false })).status, 200);
  const e = (await editor('/api/emis')).body.emis.find((x) => x.id === carLoan);
  assert.deepEqual([e.remind_days, e.remind_email, e.hold_days], [7, false, 3]); // hold unchanged
  assert.equal((await editor(`/api/emis/${carLoan}`, { remind_to: 'not-an-email' })).status, 400);
  assert.equal((await editor(`/api/emis/${carLoan}`, { hold_days: '40' })).status, 400);
  assert.equal((await editor(`/api/emis/${carLoan}`, { remind_to: 'a@x.in b@x.in c@x.in d@x.in e@x.in f@x.in' })).status, 400);
  const a = (await admin('/api/activity?type=emis')).body.activity.find((x) => x.action === 'emi.edit');
  assert.deepEqual(a.detail.changes.remind_days, [3, 7]);
  assert.equal(a.user_name, 'Eli');
});

test('daily schedule: the cron endpoint needs CRON_SECRET', async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await anon('/api/cron/reminders')).status, 503);
  process.env.CRON_SECRET = 'c'.repeat(32);
  assert.equal((await anon('/api/cron/reminders')).status, 401);
  assert.equal((await anon('/api/cron/reminders', undefined, { authorization: 'Bearer wrong' })).status, 401);
  const r = await anon('/api/cron/reminders', undefined, { authorization: `Bearer ${'c'.repeat(32)}` });
  assert.equal(r.status, 200); assert.ok('reminders' in r.body);
  assert.ok((await admin('/api/activity?type=emis')).body.activity.some((x) => x.action === 'emi.reminders' && x.detail.via === 'schedule' && x.user_id === null));
  assert.equal((await admin('/api/reminders/status')).body.scheduleConfigured, true);
});

test('permissions: viewers see EMIs but can’t add, change, run reminders or see the outbox', async () => {
  for (const p of ['/api/emis', '/api/emis/overview', '/api/emis/schedule', '/api/notifications']) assert.equal((await viewer(p)).status, 200, p);
  assert.equal((await viewer('/api/emis', { lender: 'X', amount: '1', bank_id: bank, start_date: today })).status, 403);
  assert.equal((await viewer(`/api/emis/${carLoan}`, { remind_days: '1' })).status, 403);
  assert.equal((await editor('/api/reminders/run', {})).status, 403);
  assert.equal((await editor('/api/reminders/status')).status, 403);
  for (const p of ['/api/emis/overview', '/api/emis/schedule', '/api/notifications']) assert.equal((await anon(p)).status, 401);
  assert.equal((await editor('/api/emis/schedule?status=bogus')).status, 400);
});
