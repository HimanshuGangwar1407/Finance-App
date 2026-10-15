import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setPool, q } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';

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
const admin = session();
const people = async () => new Map((await admin('/api/people?status=all')).body.people.map((p) => [p.name, p]));
const signIn = async (email, password) => { const s = session(); const r = await s('/api/login', { email, password }); return r.status === 200 ? s : r.status; };
let ravi, editor;

test('the first admin appears in People with Admin access', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'asha@x.in', password: 'adminpass123' });
  const a = (await people()).get('Asha');
  assert.deepEqual([a.email, a.access_role, a.access_active], ['asha@x.in', 'admin', true]);
});

test('adding a person with a login: they sign in with the email in People and the password the admin set', async () => {
  const r = await admin('/api/people', { name: 'Eli', email: 'Eli@Firm.in', login_role: 'editor', password: 'elispass1234' });
  assert.equal(r.status, 200);
  editor = await signIn('eli@firm.in', 'elispass1234');
  assert.equal(typeof editor, 'function');
  const st = (await editor('/api/state')).body.user;
  assert.deepEqual([st.email, st.name, st.role], ['eli@firm.in', 'Eli', 'editor']);
  assert.equal((await people()).get('Eli').access_role, 'editor');
  // stored only as a hash
  const { rows: [u] } = await q("SELECT pw FROM users WHERE email = 'eli@firm.in'");
  assert.match(u.pw, /^s1\$/); assert.ok(!u.pw.includes('elispass1234'));
});

test('adding a person with a login checks the password and email — and adds nothing if it fails', async () => {
  assert.match((await admin('/api/people', { name: 'Weak', email: 'weak@firm.in', login_role: 'viewer', password: 'short' })).body.error.message, /Password: Use at least 10/);
  assert.match((await admin('/api/people', { name: 'NoMail', login_role: 'viewer', password: 'goodpass1234' })).body.error.message, /email address first/);
  assert.match((await admin('/api/people', { name: 'Same', email: 'asha@x.in', login_role: 'viewer', password: 'goodpass1234' })).body.error.message, /already has that email|already signs in/);
  assert.equal((await admin('/api/people', { name: 'X', email: 'x@firm.in', login_role: 'boss', password: 'goodpass1234' })).status, 400);
  const p = await people();
  for (const n of ['Weak', 'NoMail', 'Same', 'X']) assert.equal(p.has(n), false, n); // rolled back
  // without a role, it's just a person (no login) — the password is ignored
  assert.equal((await admin('/api/people', { name: 'Ravi', email: 'ravi@firm.in' })).status, 200);
  ravi = (await people()).get('Ravi');
  assert.equal(ravi.user_id, null);
});

test('create a login for someone already in People', async () => {
  assert.match((await admin(`/api/people/${ravi.id}/login`, { role: 'viewer', password: 'short' })).body.error.message, /Password/);
  assert.equal((await admin(`/api/people/${ravi.id}/login`, { role: 'viewer', password: 'ravispass123' })).status, 200);
  const r = await signIn('ravi@firm.in', 'ravispass123');
  assert.equal((await r('/api/state')).body.user.role, 'viewer');
  assert.match((await admin(`/api/people/${ravi.id}/login`, { role: 'viewer', password: 'ravispass123' })).body.error.message, /already has a login/);
  const noMail = (await admin('/api/people', { name: 'Nomail' })).body.id;
  assert.match((await admin(`/api/people/${noMail}/login`, { role: 'viewer', password: 'goodpass1234' })).body.error.message, /email address first/);
  const off = (await admin('/api/people', { name: 'Off', email: 'off@firm.in' })).body.id;
  await admin(`/api/people/${off}/active`, { active: false });
  assert.match((await admin(`/api/people/${off}/login`, { role: 'viewer', password: 'goodpass1234' })).body.error.message, /inactive/);
});

test('set password: the admin sets a new one; they are signed out everywhere and use the new one', async () => {
  const before = await signIn('ravi@firm.in', 'ravispass123');
  assert.equal((await admin(`/api/people/${ravi.id}/password`, { password: 'short' })).status, 400);
  assert.equal((await admin(`/api/people/${ravi.id}/password`, { password: 'newravipass1' })).status, 200);
  assert.equal((await before('/api/people')).status, 401);
  assert.equal(await signIn('ravi@firm.in', 'ravispass123'), 401);
  assert.equal(typeof await signIn('ravi@firm.in', 'newravipass1'), 'function');
  const asha = (await people()).get('Asha');
  assert.match((await admin(`/api/people/${asha.id}/password`, { password: 'whatever1234' })).body.error.message, /Change password/);
  const noLogin = (await people()).get('Nomail');
  assert.match((await admin(`/api/people/${noLogin.id}/password`, { password: 'whatever1234' })).body.error.message, /doesn’t have a login/);
  // the person can still change their own password
  const r = await signIn('ravi@firm.in', 'newravipass1');
  assert.equal((await r('/api/me/password', { current: 'newravipass1', password: 'ravisown1234' })).status, 200);
  assert.equal(typeof await signIn('ravi@firm.in', 'ravisown1234'), 'function');
});

test('change role, remove and restore access still work', async () => {
  assert.equal((await admin(`/api/people/${ravi.id}/role`, { role: 'editor' })).status, 200);
  const r = await signIn('ravi@firm.in', 'ravisown1234');
  assert.equal((await r('/api/state')).body.user.role, 'editor');
  assert.equal((await admin(`/api/people/${ravi.id}/access`, { active: false })).status, 200);
  assert.equal((await r('/api/people')).status, 401);
  assert.equal(await signIn('ravi@firm.in', 'ravisown1234'), 401);
  assert.match((await admin(`/api/people/${ravi.id}/password`, { password: 'whatever1234' })).body.error.message, /removed/);
  assert.equal((await admin(`/api/people/${ravi.id}/access`, { active: true })).status, 200);
  assert.equal(typeof await signIn('ravi@firm.in', 'ravisown1234'), 'function');
});

test('only admins create logins or set passwords; invite links and sign-up are gone', async () => {
  const nobody = (await admin('/api/people', { name: 'Kiran', email: 'kiran@firm.in' })).body.id;
  assert.equal((await editor(`/api/people/${nobody}/login`, { role: 'admin', password: 'takeover1234' })).status, 403);
  assert.equal((await editor(`/api/people/${ravi.id}/password`, { password: 'takeover1234' })).status, 403);
  assert.equal((await editor('/api/people', { name: 'Sneaky', email: 's@firm.in', login_role: 'admin', password: 'takeover1234' })).status, 403);
  assert.equal((await session()(`/api/people/${nobody}/login`, { role: 'admin', password: 'takeover1234' })).status, 401);
  for (const p of ['/api/signup', '/api/invites/check', '/api/invites/accept', `/api/people/${nobody}/invite`, `/api/people/${ravi.id}/reset-link`]) {
    assert.equal((await admin(p, { email: 'kiran@firm.in', token: 'x'.repeat(43), password: 'whatever1234' })).status, 404, p);
  }
});

test('activity log: logins created and passwords set, with who did it — never the passwords', async () => {
  const log = (await admin('/api/activity?type=users')).body.activity;
  const create = log.find((a) => a.action === 'account.create' && a.detail.name === 'Eli');
  assert.deepEqual([create.user_name, create.detail.email, create.detail.role], ['Asha', 'eli@firm.in', 'editor']);
  assert.ok(log.some((a) => a.action === 'account.password' && a.detail.name === 'Ravi' && a.user_name === 'Asha'));
  const all = JSON.stringify((await q('SELECT detail FROM audit')).rows);
  for (const pw of ['elispass1234', 'ravispass123', 'newravipass1', 'ravisown1234', 'takeover1234', 'goodpass1234']) assert.ok(!all.includes(pw), pw);
});
