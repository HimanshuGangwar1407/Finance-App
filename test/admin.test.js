import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setPool, q } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST } from '../server/money.js';

const pool = pglitePool();
setPool(pool);
process.env.SESSION_SECRET = 'x'.repeat(40);
const { handler } = await import('../server/index.js');
const server = http.createServer(handler).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); pool.end(); });

// one cookie jar per person signed in
const session = () => {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
};
const admin = session(), editor = session(), viewer = session(), anon = session();
const PW = { admin: 'adminpass123', editor: 'editorpass123', viewer: 'viewerpass123' };

test('setup: one admin, then an editor and a viewer', async () => {
  assert.equal((await admin('/api/setup', { name: 'Asha Admin', email: 'asha@x.in', password: PW.admin })).status, 200);
  assert.equal((await anon('/api/setup', { name: 'Second', email: 'b@x.in', password: 'otherpass123' })).status, 403); // only once
  assert.equal((await admin('/api/users', { name: 'Eli Editor', email: 'eli@x.in', role: 'editor', password: PW.editor })).status, 200);
  assert.equal((await admin('/api/users', { name: 'Vik Viewer', email: 'vik@x.in', role: 'viewer', password: PW.viewer })).status, 200);
  assert.equal((await editor('/api/login', { email: 'eli@x.in', password: PW.editor })).status, 200);
  assert.equal((await viewer('/api/login', { email: 'vik@x.in', password: PW.viewer })).status, 200);
  // passwords are stored only as salted scrypt hashes
  const { rows } = await q('SELECT pw FROM users');
  for (const r of rows) { assert.match(r.pw, /^s1\$/); assert.ok(!Object.values(PW).some((p) => r.pw.includes(p))); }
});

test('admin has full access; editors and viewers are kept out of admin-only areas', async () => {
  for (const p of ['/api/position', '/api/banks/day', '/api/emis', '/api/users', '/api/activity']) {
    assert.equal((await admin(p)).status, 200, `admin GET ${p}`);
  }
  for (const who of [editor, viewer]) {
    assert.equal((await who('/api/activity')).status, 403);
    assert.equal((await who('/api/users')).status, 403);
    assert.equal((await who('/api/users', { name: 'Z', email: 'z@x.in', role: 'admin', password: 'zzzzzzzzz1' })).status, 403);
    assert.equal((await who('/api/banks', { name: 'B', bank: 'B', last4: '1234' })).status, 403);
  }
  for (const p of ['/api/users', '/api/activity']) assert.equal((await anon(p)).status, 401);
  // People and Positions are gone
  for (const p of ['/api/people', '/api/positions']) assert.equal((await admin(p)).status, 404, p);
  // admin can do everything an editor can, across modules
  const b = await admin('/api/banks', { name: 'Main', bank: 'HDFC', last4: '1234' });
  assert.equal((await admin('/api/balances', { bank_id: b.body.id, amount: '1,00,000' })).status, 200);
  const pay = await admin('/api/payments', { payee: 'Rent', category: 'Rent', amount: '10,000', due_date: todayIST(), bank_id: b.body.id });
  assert.equal((await admin(`/api/payments/${pay.body.id}/approve`, {})).status, 200);
  assert.equal((await admin('/api/emis', { lender: 'Loan', amount: '5,000', bank_id: b.body.id, start_date: todayIST() })).status, 200);
});

test('activity log: sign-ins, failures, lockouts and changes, with who and when — never passwords', async () => {
  const other = session();
  assert.equal((await other('/api/login', { email: 'nobody@x.in', password: 'whatever123' })).status, 401);
  for (let i = 0; i < 5; i++) await other('/api/login', { email: 'vik@x.in', password: 'wrongpass99' });
  assert.equal((await other('/api/login', { email: 'vik@x.in', password: PW.viewer })).status, 429); // locked
  assert.equal((await editor('/api/logout', {})).status, 200);

  const all = (await admin('/api/activity')).body.activity;
  const actions = all.map((a) => a.action);
  for (const a of ['setup', 'user.add', 'login', 'login.failed', 'login.locked', 'logout', 'payment.approve', 'emi.add', 'bank.add']) assert.ok(actions.includes(a), `logged: ${a}`);
  const unknown = all.find((a) => a.action === 'login.failed' && a.detail.email === 'nobody@x.in');
  assert.equal(unknown.user_id, null);
  const add = all.find((a) => a.action === 'user.add' && a.detail.email === 'vik@x.in');
  assert.equal(add.user_name, 'Asha Admin');
  assert.ok(Math.abs(Date.parse(add.at) - Date.now()) < 120000);

  // no password, typed or stored, appears anywhere in the log
  const { rows } = await q('SELECT detail::text AS d FROM audit');
  const hashes = (await q('SELECT pw FROM users')).rows.map((r) => r.pw);
  for (const r of rows) for (const s of [...Object.values(PW), 'wrongpass99', 'whatever123', ...hashes]) assert.ok(!r.d.includes(s), `log leaks ${s.slice(0, 4)}…`);

  // filters
  const ids = async (qs) => (await admin(`/api/activity?${qs}`)).body.activity;
  const eli = (await admin('/api/users')).body.users.find((u) => u.email === 'eli@x.in').id;
  assert.ok((await ids(`user=${eli}`)).every((a) => a.user_id === eli));
  assert.ok((await ids('user=none')).every((a) => a.user_id === null));
  assert.ok((await ids('type=signin')).every((a) => /^(login|logout|setup|admin)/.test(a.action)));
  assert.ok((await ids('type=users')).every((a) => /^(user|account|password|access|invite|signup)\./.test(a.action)));
  assert.ok((await ids('q=Vik')).length > 0);
  assert.equal((await ids('from=2000-01-01&to=2000-01-02')).length, 0);
  assert.ok((await ids(`from=${todayIST()}&to=${todayIST()}`)).length > 0);
  assert.equal((await admin('/api/activity?type=bogus')).status, 400);

  // pages of 50, newest first, no overlap
  for (let i = 0; i < 45; i++) await admin('/api/banks', { name: `Bulk ${i}`, bank: 'Bank', last4: String(1000 + i) });
  const p1 = (await admin('/api/activity')).body;
  assert.equal(p1.activity.length, 50); assert.equal(p1.more, true);
  const p2 = (await admin(`/api/activity?before=${p1.activity.at(-1).id}`)).body;
  assert.ok(p2.activity[0].id < p1.activity.at(-1).id);
  assert.ok(p1.activity.every((a, i, xs) => i === 0 || xs[i - 1].id > a.id));
});

test('create-admin script: reads the details from the environment, creates one admin, refuses a second', async () => {
  const run = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-admin-'));
  const go = (env) => run(process.execPath, ['scripts/create-admin.js'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATA_DIR: dir, ...env } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: e.stdout + e.stderr }));
  try {
    let r = await go({});
    assert.equal(r.code, 1); assert.match(r.out, /ADMIN_EMAIL/);
    r = await go({ ADMIN_EMAIL: 'root@x.in', ADMIN_NAME: 'Root', ADMIN_PASSWORD: 'short' });
    assert.equal(r.code, 1); assert.match(r.out, /ADMIN_PASSWORD/);
    r = await go({ ADMIN_EMAIL: 'root@x.in', ADMIN_NAME: 'Root', ADMIN_PASSWORD: 'rootpassword1' });
    assert.equal(r.code, 0, r.out); assert.match(r.out, /Admin account created for root@x\.in/);
    assert.ok(!r.out.includes('rootpassword1'));
    r = await go({ ADMIN_EMAIL: 'second@x.in', ADMIN_NAME: 'Second', ADMIN_PASSWORD: 'secondpassword1' });
    assert.equal(r.code, 1); assert.match(r.out, /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
