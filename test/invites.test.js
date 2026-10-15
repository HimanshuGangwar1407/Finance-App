import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setPool, q } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';

// a fake email service, to see invite emails
const mail = [];
const mailServer = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  mail.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
}).listen(0);

const pool = pglitePool();
setPool(pool);
process.env.SESSION_SECRET = 'x'.repeat(40);
const { handler } = await import('../server/index.js');
const server = http.createServer(handler).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); mailServer.close(); pool.end(); });
const session = () => {
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  call.signedIn = () => !!cookie && !cookie.endsWith('=');
  return call;
};
const admin = session(), editor = session();
const tokenOf = (link) => /#(?:invite|reset)=([A-Za-z0-9_-]+)$/.exec(link)[1];
const people = async () => new Map((await admin('/api/people?status=all')).body.people.map((p) => [p.name, p]));
let ravi, meena;

test('setup: an admin, an editor, and people to invite', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'asha@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'eli@x.in', role: 'editor', password: 'editorpass12' });
  await editor('/api/login', { email: 'eli@x.in', password: 'editorpass12' });
  ravi = (await admin('/api/people', { name: 'Ravi Kumar', email: 'Ravi@Firm.in' })).body.id;
  meena = (await admin('/api/people', { name: 'Meena Shah', email: 'meena@firm.in' })).body.id;
  await admin('/api/people', { name: 'No Email' });
  await admin('/api/people', { name: 'Eli Editor', email: 'eli@x.in' }); // already a user: shows as having access
  const p = await people();
  assert.deepEqual([p.get('Eli Editor').access_role, p.get('Eli Editor').access_active], ['editor', true]);
  assert.equal(p.get('Ravi Kumar').user_id, null);
});

test('invite: an admin creates a one-time link; the person chooses their own password and is signed in', async () => {
  const r = await admin(`/api/people/${ravi}/invite`, { role: 'editor' });
  assert.equal(r.status, 200);
  assert.match(r.body.link, /^http:\/\/localhost:\d+\/#invite=[A-Za-z0-9_-]{40,}$/);
  assert.equal(r.body.emailed, 'not set up');
  assert.ok(new Date(r.body.expires_at) - Date.now() > 6.9 * 864e5);
  const token = tokenOf(r.body.link);
  // only a hash is stored: the link itself appears nowhere in the database
  const { rows } = await q('SELECT token_hash FROM invites');
  assert.ok(rows.every((x) => x.token_hash !== token && x.token_hash.length === 64));
  assert.ok(!JSON.stringify((await q('SELECT detail FROM audit')).rows).includes(token));
  assert.deepEqual((await people()).get('Ravi Kumar').open_link.role, 'editor');

  const ravis = session();
  const check = await ravis('/api/invites/check', { token });
  assert.deepEqual([check.body.kind, check.body.name, check.body.email, check.body.role], ['invite', 'Ravi Kumar', 'ravi@firm.in', 'editor']);
  assert.match((await ravis('/api/invites/accept', { token, password: 'short' })).body.error.message, /at least 10/);
  const ok = await ravis('/api/invites/accept', { token, password: 'ravispass123', name: 'Ravi K.' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.user.email, ok.body.user.role, ok.body.user.name], ['ravi@firm.in', 'editor', 'Ravi K.']);
  assert.equal((await ravis('/api/state')).body.user.email, 'ravi@firm.in'); // signed in
  assert.equal((await ravis('/api/people')).status, 200); // and can work as an editor

  // the password is stored as a hash; the person now shows as having access; the link is spent
  const { rows: [u] } = await q("SELECT pw FROM users WHERE email = 'ravi@firm.in'");
  assert.match(u.pw, /^s1\$/); assert.ok(!u.pw.includes('ravispass123'));
  const p = (await people()).get('Ravi Kumar');
  assert.deepEqual([p.access_role, p.access_active, p.open_link], ['editor', true, null]);
  assert.equal((await session()('/api/invites/accept', { token, password: 'otherpass123' })).status, 410);
  assert.equal((await session()('/api/invites/check', { token })).status, 410);
  // and they can sign in with it later
  assert.equal((await session()('/api/login', { email: 'ravi@firm.in', password: 'ravispass123' })).status, 200);
});

test('invite rules: email needed, no second account, a new link replaces the old one, links can be cancelled', async () => {
  const p = await people();
  assert.match((await admin(`/api/people/${p.get('No Email').id}/invite`, {})).body.error.message, /email address first/);
  assert.match((await admin(`/api/people/${ravi}/invite`, {})).body.error.message, /already has access/);
  assert.match((await admin(`/api/people/${p.get('Eli Editor').id}/invite`, {})).body.error.message, /already has access/);
  const first = tokenOf((await admin(`/api/people/${meena}/invite`, { role: 'viewer' })).body.link);
  const second = tokenOf((await admin(`/api/people/${meena}/invite`, { role: 'admin' })).body.link);
  assert.equal((await session()('/api/invites/check', { token: first })).status, 410); // replaced
  assert.equal((await session()('/api/invites/check', { token: second })).body.role, 'admin');
  assert.equal((await admin(`/api/people/${meena}/invite/cancel`, {})).status, 200);
  assert.equal((await session()('/api/invites/check', { token: second })).status, 410);
  assert.equal((await admin(`/api/people/${meena}/invite/cancel`, {})).status, 404);
  // bad or made-up tokens
  for (const token of ['', 'x', 'a'.repeat(43), '../../etc', null]) assert.equal((await session()('/api/invites/check', { token })).status, 410);
  // expired links don't work
  const old = tokenOf((await admin(`/api/people/${meena}/invite`, { role: 'viewer' })).body.link);
  await q("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE person_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [meena]);
  assert.equal((await session()('/api/invites/accept', { token: old, password: 'meenapass123' })).status, 410);
  assert.equal((await people()).get('Meena Shah').open_link, null);
  // an inactive person can't be invited, and their open link stops working
  const live = tokenOf((await admin(`/api/people/${meena}/invite`, { role: 'viewer' })).body.link);
  await admin(`/api/people/${meena}/active`, { active: false });
  assert.match((await admin(`/api/people/${meena}/invite`, {})).body.error.message, /inactive/);
  assert.equal((await session()('/api/invites/accept', { token: live, password: 'meenapass123' })).status, 410);
  await admin(`/api/people/${meena}/active`, { active: true });
});

test('invite emails: sent straight away when email is set up — the link is not kept anywhere', async () => {
  Object.assign(process.env, { RESEND_API_KEY: 'k', EMAIL_FROM: 'Finance <f@x.in>', EMAIL_API_URL: `http://localhost:${mailServer.address().port}/emails` });
  const r = await admin(`/api/people/${meena}/invite`, { role: 'viewer' });
  assert.equal(r.body.emailed, 'sent');
  assert.deepEqual(mail.at(-1).to, ['meena@firm.in']);
  assert.equal(mail.at(-1).subject, 'Your invitation to the Finance app');
  assert.ok(mail.at(-1).text.includes(r.body.link) && /Asha has given you viewer access/.test(mail.at(-1).text));
  assert.equal((await q('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n, 0);
  delete process.env.RESEND_API_KEY;
  const a = (await admin('/api/activity?type=users')).body.activity.find((x) => x.action === 'invite.create' && x.detail.emailed === 'sent');
  assert.equal(a.detail.email, 'meena@firm.in');
});

test('password reset link: for someone who already has access; their other sessions end', async () => {
  const ravis = session();
  await ravis('/api/login', { email: 'ravi@firm.in', password: 'ravispass123' });
  assert.match((await admin(`/api/people/${meena}/reset-link`, {})).body.error.message, /doesn’t have access yet/);
  const token = tokenOf((await admin(`/api/people/${ravi}/reset-link`, {})).body.link);
  const check = await session()('/api/invites/check', { token });
  assert.deepEqual([check.body.kind, check.body.role], ['reset', 'editor']);
  const fresh = session();
  assert.equal((await fresh('/api/invites/accept', { token, password: 'ravisnewpass1' })).status, 200);
  assert.equal((await fresh('/api/state')).body.user.email, 'ravi@firm.in');
  assert.equal((await ravis('/api/people')).status, 401); // the old session ended
  assert.equal((await session()('/api/login', { email: 'ravi@firm.in', password: 'ravispass123' })).status, 401);
  assert.equal((await session()('/api/login', { email: 'ravi@firm.in', password: 'ravisnewpass1' })).status, 200);
  assert.equal((await session()('/api/invites/accept', { token, password: 'again12345a' })).status, 410); // once only
});

test('change your own password: needs the current one; this session stays, others end', async () => {
  const here = session(), there = session();
  await here('/api/login', { email: 'ravi@firm.in', password: 'ravisnewpass1' });
  await there('/api/login', { email: 'ravi@firm.in', password: 'ravisnewpass1' });
  assert.match((await here('/api/me/password', { current: 'wrong', password: 'brandnewpass1' })).body.error.message, /current password is wrong/);
  assert.match((await here('/api/me/password', { current: 'ravisnewpass1', password: 'short' })).body.error.message, /at least 10/);
  assert.equal((await here('/api/me/password', { current: 'ravisnewpass1', password: 'brandnewpass1' })).status, 200);
  assert.equal((await here('/api/people')).status, 200);
  assert.equal((await there('/api/people')).status, 401);
  assert.equal((await session()('/api/login', { email: 'ravi@firm.in', password: 'brandnewpass1' })).status, 200);
  assert.equal((await session()('/api/me/password', { current: 'x', password: 'y' })).status, 401);
});

test('remove and restore access: signs them out, blocks sign-in, cancels links; protects the last admin', async () => {
  const ravis = session();
  await ravis('/api/login', { email: 'ravi@firm.in', password: 'brandnewpass1' });
  assert.equal((await admin(`/api/people/${ravi}/access`, { active: false })).status, 200);
  assert.equal((await ravis('/api/people')).status, 401);
  assert.equal((await session()('/api/login', { email: 'ravi@firm.in', password: 'brandnewpass1' })).status, 401);
  assert.equal((await people()).get('Ravi Kumar').access_active, false);
  assert.match((await admin(`/api/people/${ravi}/reset-link`, {})).body.error.message, /access is removed/);
  assert.equal((await admin(`/api/people/${ravi}/access`, { active: true })).status, 200);
  assert.equal((await session()('/api/login', { email: 'ravi@firm.in', password: 'brandnewpass1' })).status, 200);
  // the admin can't lock themselves out, nor remove the only admin
  const asha = (await admin('/api/people', { name: 'Asha', email: 'asha@x.in' })).body.id;
  assert.match((await admin(`/api/people/${asha}/access`, { active: false })).body.error.message, /your own access/);
  // the sign-in email of someone with access can't be changed from People
  assert.match((await admin(`/api/people/${ravi}`, { email: 'other@firm.in' })).body.error.message, /signs in with ravi@firm\.in/);
  assert.equal((await admin(`/api/people/${ravi}`, { phone: '+91 98765 43210' })).status, 200);
});

test('permissions: only admins invite or manage access; viewers don’t see access details', async () => {
  for (const p of [`/api/people/${meena}/invite`, `/api/people/${ravi}/reset-link`, `/api/people/${meena}/invite/cancel`, `/api/people/${ravi}/access`]) {
    assert.equal((await editor(p, { role: 'admin', active: false })).status, 403, p);
  }
  assert.equal((await session()(`/api/people/${meena}/invite`, {})).status, 401);
  // an editor sees who has access; a viewer doesn't
  assert.equal((await editor('/api/people')).body.people.find((x) => x.name === 'Ravi Kumar').access_role, 'editor');
  const v = session();
  const vt = tokenOf((await admin(`/api/people/${meena}/invite`, { role: 'viewer' })).body.link);
  await v('/api/invites/accept', { token: vt, password: 'meenapass123' });
  const seen = (await v('/api/people')).body.people.find((x) => x.name === 'Ravi Kumar');
  assert.deepEqual([seen.access_role, seen.user_id, seen.open_link, seen.email], [undefined, undefined, undefined, undefined]);
  assert.equal((await v('/api/positions', { name: 'X' })).status, 403); // a viewer is a viewer
});

test('activity log: invites, acceptances, resets, password changes and access changes, with who did them', async () => {
  const log = (await admin('/api/activity?type=users')).body.activity;
  const has = (action, who) => log.some((a) => a.action === action && (!who || a.user_name === who));
  for (const a of ['invite.create', 'invite.reset_link', 'invite.cancel', 'access.remove', 'access.restore']) assert.ok(has(a, 'Asha'), a);
  assert.ok(has('invite.accept', 'Ravi K.')); assert.ok(has('password.reset', 'Ravi K.')); assert.ok(has('password.change', 'Ravi K.'));
  assert.ok(!JSON.stringify(log).match(/pass123|newpass|#invite=|#reset=/));
});
