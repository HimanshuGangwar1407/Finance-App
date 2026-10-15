import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setPool, q } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';

const mail = [];
const mailServer = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  mail.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
}).listen(0);
const emailOn = () => Object.assign(process.env, { RESEND_API_KEY: 'k', EMAIL_FROM: 'Finance <f@x.in>', EMAIL_API_URL: `http://localhost:${mailServer.address().port}/emails` });
const emailOff = () => { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; };

const pool = pglitePool();
setPool(pool);
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.VERCEL = '1'; // so each test can come from its own address (x-real-ip), as behind Vercel's proxy
const { handler } = await import('../server/index.js');
const server = http.createServer(handler).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); mailServer.close(); pool.end(); delete process.env.VERCEL; emailOff(); });
let ipNo = 0;
const session = (ip = `10.0.0.${++ipNo}`) => {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie, 'x-real-ip': ip } } : { method: 'POST', headers: { cookie, 'x-real-ip': ip, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, text: await r.text().then((t) => t), get body() { return JSON.parse(this.text); } };
  };
};
const admin = session(), admin2 = session(), editor = session();
const tokenOf = (text) => /#invite=([A-Za-z0-9_-]+)/.exec(text)[1];
const ids = {};

test('setup: two admins, an editor, and people', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'asha@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Bina', email: 'bina@x.in', role: 'admin', password: 'adminpass456' });
  await admin('/api/users', { name: 'Eli', email: 'eli@x.in', role: 'editor', password: 'editorpass12' });
  await admin2('/api/login', { email: 'bina@x.in', password: 'adminpass456' });
  await editor('/api/login', { email: 'eli@x.in', password: 'editorpass12' });
  for (const [k, name, email] of [['ravi', 'Ravi', 'ravi@x.in'], ['meena', 'Meena', 'meena@x.in'], ['gone', 'Gone', 'gone@x.in'], ['eli', 'Eli', 'eli@x.in'], ['kiran', 'Kiran', 'kiran@x.in']]) {
    ids[k] = (await admin('/api/people', { name, email })).body.id;
  }
  await admin(`/api/people/${ids.gone}/active`, { active: false });
});

test('the reply is the same for every email, so nobody can find out who is in People', async () => {
  emailOff();
  const replies = [];
  for (const email of ['ravi@x.in', 'nobody@else.com', 'eli@x.in', 'gone@x.in']) {
    const r = await session()('/api/signup', { email });
    replies.push([r.status, r.text]);
  }
  assert.ok(replies.every((r) => r[0] === 200 && r[1] === replies[0][1]), JSON.stringify(replies));
  assert.equal((await session()('/api/signup', { email: 'not an email' })).status, 400);
});

test('without email set up: the admins are told (in the bell); no link is made', async () => {
  const notes = (await admin('/api/notifications')).body.items.filter((n) => n.kind === 'signup');
  assert.deepEqual(notes.map((n) => [n.title, n.link]), [['Ravi (ravi@x.in) wants to sign up', 'people']]);
  assert.equal((await admin2('/api/notifications')).body.items.filter((n) => n.kind === 'signup').length, 1);
  assert.equal((await editor('/api/notifications')).body.items.filter((n) => n.kind === 'signup').length, 0); // admins only
  assert.equal((await q('SELECT count(*)::int AS n FROM invites')).rows[0].n, 0);
  // asking again the same day doesn't notify again
  await session()('/api/signup', { email: 'RAVI@x.in' });
  assert.equal((await admin('/api/notifications')).body.items.filter((n) => n.kind === 'signup').length, 1);
  // the activity log says what happened, including attempts with unknown emails
  const log = (await admin('/api/activity?type=users')).body.activity.filter((a) => a.action === 'signup.request');
  assert.ok(log.some((a) => a.detail.email === 'ravi@x.in' && a.detail.matched && a.detail.emailed === 'not set up' && a.detail.admins === 2));
  assert.ok(log.some((a) => a.detail.email === 'nobody@else.com' && !a.detail.matched));
  assert.ok(log.every((a) => a.user_id === null));
});

test('with email set up: a link goes to their email; they choose a password and start as a viewer', async () => {
  emailOn();
  assert.equal((await session()('/api/signup', { email: 'meena@x.in' })).status, 200);
  const m = mail.at(-1);
  assert.deepEqual(m.to, ['meena@x.in']);
  assert.equal(m.subject, 'Finish signing up for the Finance app');
  assert.match(m.text, /Someone — hopefully you — asked to sign up/);
  const token = tokenOf(m.text);
  const meena = session();
  assert.equal((await meena('/api/invites/check', { token })).body.role, 'viewer');
  const ok = await meena('/api/invites/accept', { token, password: 'meenapass123' });
  assert.deepEqual([ok.status, ok.body.user.email, ok.body.user.role], [200, 'meena@x.in', 'viewer']);
  assert.equal((await meena('/api/people')).status, 200);
  assert.equal((await admin('/api/people')).body.people.find((p) => p.name === 'Meena').access_role, 'viewer');
  // the link is never stored, and nobody else is emailed
  assert.ok(!JSON.stringify((await q('SELECT * FROM invites')).rows).includes(token));
  assert.equal(mail.filter((x) => x.to[0] !== 'meena@x.in').length, 0);
});

test('with email set up: no email for unknown, signed-up or inactive people; at most one link per 10 minutes', async () => {
  const before = mail.length;
  for (const email of ['nobody@else.com', 'eli@x.in', 'gone@x.in', 'meena@x.in']) await session()('/api/signup', { email });
  assert.equal(mail.length, before);
  await session()('/api/signup', { email: 'kiran@x.in' });
  await session()('/api/signup', { email: 'kiran@x.in' });
  assert.equal(mail.length, before + 1);
});

test('an invite an admin already sent keeps its role when the person signs up', async () => {
  await admin(`/api/people/${ids.ravi}/invite`, { role: 'editor' });
  await q("UPDATE invites SET created_at = now() - interval '1 hour' WHERE person_id = $1", [ids.ravi]);
  await session()('/api/signup', { email: 'ravi@x.in' });
  const token = tokenOf(mail.at(-1).text);
  assert.equal((await session()('/api/invites/check', { token })).body.role, 'editor');
});

test('too many tries from one address are slowed down', async () => {
  const same = session('10.9.9.9');
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await same('/api/signup', { email: `x${i}@nowhere.in` })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  assert.equal((await session('10.9.9.10')('/api/signup', { email: 'y@nowhere.in' })).status, 200); // others aren't affected
});

test('change role: admins only; not your own; never the last admin', async () => {
  assert.equal((await admin(`/api/people/${ids.meena}/role`, { role: 'editor' })).status, 200);
  assert.equal((await admin('/api/people')).body.people.find((p) => p.name === 'Meena').access_role, 'editor');
  assert.equal((await editor(`/api/people/${ids.meena}/role`, { role: 'admin' })).status, 403);
  assert.match((await admin(`/api/people/${ids.kiran}/role`, { role: 'editor' })).body.error.message, /doesn’t have access yet/);
  assert.equal((await admin(`/api/people/${ids.meena}/role`, { role: 'boss' })).status, 400);
  const asha = (await admin('/api/people', { name: 'Asha', email: 'asha@x.in' })).body.id;
  assert.match((await admin(`/api/people/${asha}/role`, { role: 'viewer' })).body.error.message, /your own role/);
  const bina = (await admin('/api/people', { name: 'Bina', email: 'bina@x.in' })).body.id;
  assert.equal((await admin(`/api/people/${bina}/role`, { role: 'viewer' })).status, 200); // Asha is still an admin
  assert.match((await admin2(`/api/people/${asha}/role`, { role: 'viewer' })).body.error.message, /Your role can’t do that/); // Bina is a viewer now
  const log = (await admin('/api/activity?type=users')).body.activity.find((a) => a.action === 'access.role' && a.detail.name === 'Meena');
  assert.deepEqual(log.detail.changes.role, ['viewer', 'editor']);
});
