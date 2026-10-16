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
const signIn = async (email, password) => { const s = session(); const r = await s('/api/login', { email, password }); return r.status === 200 ? s : r.status; };
const users = async () => new Map((await admin('/api/users')).body.users.map((u) => [u.name, u]));
const id = async (name) => (await users()).get(name).id;

test('the Users page lists everyone who can sign in, starting with the admin', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'asha@x.in', password: 'adminpass123' });
  const a = (await users()).get('Asha');
  assert.deepEqual([a.email, a.role, a.active], ['asha@x.in', 'admin', true]);
  assert.ok(a.last_login); // setting up the app counts as signing in
});

test('add a user: they sign in with that email and the password the admin set', async () => {
  assert.equal((await admin('/api/users', { name: 'Ravi', email: 'Ravi@Firm.in', role: 'editor', password: 'ravispass123' })).status, 200);
  const r = await signIn('ravi@firm.in', 'ravispass123');
  assert.equal(typeof r, 'function');
  assert.deepEqual((({ email, name, role }) => [email, name, role])((await r('/api/state')).body.user), ['ravi@firm.in', 'Ravi', 'editor']);
  const { rows: [u] } = await q("SELECT pw FROM users WHERE email = 'ravi@firm.in'");
  assert.match(u.pw, /^s1\$/); assert.ok(!u.pw.includes('ravispass123'));
  // checks
  assert.match((await admin('/api/users', { name: 'W', email: 'w@firm.in', role: 'viewer', password: 'short' })).body.error.message, /Password: Use at least 10/);
  assert.equal((await admin('/api/users', { name: 'Dup', email: 'RAVI@firm.in', role: 'viewer', password: 'goodpass1234' })).body.error.message, 'Someone already signs in with that email.');
  assert.equal((await admin('/api/users', { name: 'X', email: 'not-an-email', role: 'viewer', password: 'goodpass1234' })).status, 400);
  assert.equal((await admin('/api/users', { name: 'X', email: 'x@firm.in', role: 'boss', password: 'goodpass1234' })).status, 400);
  assert.equal((await admin('/api/users', { name: '', email: 'y@firm.in', role: 'viewer', password: 'goodpass1234' })).status, 400);
  assert.equal((await admin('/api/users', { name: 'Meena', email: 'meena@firm.in', role: 'viewer', password: 'meenapass123' })).status, 200);
});

test('edit: name and email (the login ID); the new email is used to sign in', async () => {
  const meena = await id('Meena');
  assert.equal((await admin(`/api/users/${meena}`, { name: 'Meena Shah', email: 'Meena.Shah@firm.in' })).status, 200);
  assert.equal(await signIn('meena@firm.in', 'meenapass123'), 401);
  assert.equal(typeof await signIn('meena.shah@firm.in', 'meenapass123'), 'function');
  assert.equal((await admin(`/api/users/${meena}`, { email: 'ravi@firm.in' })).body.error.message, 'Someone already signs in with that email.');
  assert.equal((await admin(`/api/users/${await id('Asha')}`, { name: 'Asha Admin' })).status, 200); // an admin can rename themselves
});

test('change role: applies straight away; never your own', async () => {
  const meena = await id('Meena Shah');
  const m = await signIn('meena.shah@firm.in', 'meenapass123');
  assert.equal((await m('/api/payments', { payee: 'X', category: 'Vendor', amount: '1', due_date: '2026-10-16' })).status, 403);
  assert.equal((await admin(`/api/users/${meena}/role`, { role: 'editor' })).status, 200);
  assert.equal((await m('/api/state')).body.user.role, 'editor');
  assert.match((await admin(`/api/users/${await id('Asha Admin')}/role`, { role: 'viewer' })).body.error.message, /your own role/);
  assert.equal((await admin(`/api/users/${meena}/role`, { role: 'owner' })).status, 400);
});

test('set password: they are signed out everywhere and use the new one; not for yourself', async () => {
  const ravi = await id('Ravi');
  const before = await signIn('ravi@firm.in', 'ravispass123');
  assert.equal((await admin(`/api/users/${ravi}/password`, { password: 'short' })).status, 400);
  assert.equal((await admin(`/api/users/${ravi}/password`, { password: 'ravisnew1234' })).status, 200);
  assert.equal((await before('/api/position')).status, 401);
  assert.equal(await signIn('ravi@firm.in', 'ravispass123'), 401);
  assert.equal(typeof await signIn('ravi@firm.in', 'ravisnew1234'), 'function');
  assert.match((await admin(`/api/users/${await id('Asha Admin')}/password`, { password: 'whatever1234' })).body.error.message, /Change password/);
  // and anyone can still change their own password
  const r = await signIn('ravi@firm.in', 'ravisnew1234');
  assert.equal((await r('/api/me/password', { current: 'ravisnew1234', password: 'ravisown1234' })).status, 200);
  assert.equal(typeof await signIn('ravi@firm.in', 'ravisown1234'), 'function');
});

test('remove and restore access: signed out, can’t sign in, history kept; not yourself', async () => {
  const ravi = await id('Ravi');
  const r = await signIn('ravi@firm.in', 'ravisown1234');
  assert.equal((await admin(`/api/users/${ravi}/access`, { active: false })).status, 200);
  assert.equal((await r('/api/position')).status, 401);
  assert.equal(await signIn('ravi@firm.in', 'ravisown1234'), 401);
  assert.equal((await users()).get('Ravi').active, false); // still listed
  assert.match((await admin(`/api/users/${ravi}/password`, { password: 'whatever1234' })).body.error.message, /removed/);
  assert.equal((await admin(`/api/users/${ravi}/access`, { active: true })).status, 200);
  assert.equal(typeof await signIn('ravi@firm.in', 'ravisown1234'), 'function');
  assert.match((await admin(`/api/users/${await id('Asha Admin')}/access`, { active: false })).body.error.message, /your own access/);
});

test('only admins see or manage users', async () => {
  const ed = await signIn('meena.shah@firm.in', 'meenapass123'); // an editor now
  const ravi = await id('Ravi');
  for (const [p, body] of [['/api/users'], ['/api/users', { name: 'Z', email: 'z@x.in', role: 'admin', password: 'takeover1234' }], [`/api/users/${ravi}`, { name: 'Z' }],
    [`/api/users/${ravi}/role`, { role: 'admin' }], [`/api/users/${ravi}/password`, { password: 'takeover1234' }], [`/api/users/${ravi}/access`, { active: false }]]) {
    assert.equal((await ed(p, body)).status, 403, p);
    assert.equal((await session()(p, body)).status, 401, p);
  }
  assert.equal((await admin('/api/users/999999/role', { role: 'viewer' })).status, 404);
});

test('activity log: every change to users, with who did it — never a password', async () => {
  const log = (await admin('/api/activity?type=users')).body.activity;
  for (const a of ['user.add', 'user.edit', 'user.role', 'user.password', 'user.remove', 'user.restore']) assert.ok(log.some((x) => x.action === a && x.user_name === 'Asha Admin'), a);
  assert.deepEqual(log.find((x) => x.action === 'user.edit' && x.detail.name === 'Meena Shah').detail.changes.email, ['meena@firm.in', 'meena.shah@firm.in']);
  const all = JSON.stringify((await q('SELECT detail FROM audit')).rows);
  for (const pw of ['ravispass123', 'ravisnew1234', 'ravisown1234', 'meenapass123', 'takeover1234', 'goodpass1234']) assert.ok(!all.includes(pw), pw);
});
