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

test('positions: admins create and edit them; names are unique ignoring case', async () => {
  const acc = await admin('/api/positions', { name: 'Accountant', description: 'Books and GST' });
  assert.equal(acc.status, 200);
  assert.equal((await admin('/api/positions', { name: 'Manager' })).status, 200);
  assert.equal((await admin('/api/positions', { name: 'accountant' })).body.error.message, 'A position with that name already exists.');
  assert.equal((await admin('/api/positions', { name: '  ' })).status, 400);
  assert.equal((await editor('/api/positions', { name: 'Clerk' })).status, 403);
  assert.equal((await viewer('/api/positions', { name: 'Clerk' })).status, 403);
  assert.equal((await admin(`/api/positions/${acc.body.id}`, { name: 'Senior Accountant' })).status, 200);
  const { body } = await viewer('/api/positions');
  assert.deepEqual(body.positions.map((p) => p.name), ['Manager', 'Senior Accountant']);
});

test('people: add, view, edit, search, filter, deactivate and activate', async () => {
  const pos = new Map((await admin('/api/positions')).body.positions.map((p) => [p.name, p.id]));
  const ravi = await editor('/api/people', { name: 'Ravi Kumar', email: 'Ravi@Firm.in', phone: '+91 98765 43210', position_id: pos.get('Senior Accountant'), notes: 'Handles GST' });
  assert.equal(ravi.status, 200);
  const meena = await editor('/api/people', { name: 'Meena Shah', position_id: pos.get('Manager') });
  await editor('/api/people', { name: 'Arjun Rao' });
  assert.equal((await editor('/api/people', { name: 'Dup', email: 'ravi@firm.in' })).body.error.message, 'Someone in People already has that email.');
  assert.equal((await editor('/api/people', { name: 'X', email: 'not-an-email' })).status, 400);
  assert.equal((await editor('/api/people', { name: 'X', phone: 'call me' })).status, 400);
  assert.equal((await editor('/api/people', { name: '' })).status, 400);
  assert.equal((await viewer('/api/people', { name: 'Nope' })).status, 403);

  let list = (await editor('/api/people')).body.people;
  assert.deepEqual(list.map((p) => p.name), ['Arjun Rao', 'Meena Shah', 'Ravi Kumar']); // sorted by name
  const r = list.find((p) => p.name === 'Ravi Kumar');
  assert.equal(r.email, 'ravi@firm.in');
  assert.equal(r.position, 'Senior Accountant');
  assert.equal(r.created_by, 'Eli Editor');

  const names = async (qs, who = editor) => (await who(`/api/people?${qs}`)).body.people.map((p) => p.name);
  assert.deepEqual(await names('q=ravi'), ['Ravi Kumar']);
  assert.deepEqual(await names('q=FIRM.IN'), ['Ravi Kumar']); // email
  assert.deepEqual(await names('q=98765'), ['Ravi Kumar']); // phone
  assert.deepEqual(await names('q=manag'), ['Meena Shah']); // position name
  assert.deepEqual(await names('q=%25'), []); // % is searched literally, not as a wildcard
  assert.deepEqual(await names(`position=${pos.get('Manager')}`), ['Meena Shah']);
  assert.deepEqual(await names('position=none'), ['Arjun Rao']);

  // edit: change position and phone
  assert.equal((await editor(`/api/people/${meena.body.id}`, { name: 'Meena Shah', position_id: pos.get('Senior Accountant'), phone: '022 1234 5678' })).status, 200);
  list = (await editor('/api/people')).body.people;
  assert.equal(list.find((p) => p.name === 'Meena Shah').position, 'Senior Accountant');
  assert.equal(list.find((p) => p.name === 'Meena Shah').updated_by, 'Eli Editor');

  // deactivate: hidden from the default list, shown under inactive / everyone; then back
  assert.equal((await editor(`/api/people/${ravi.body.id}/active`, { active: false })).status, 200);
  assert.equal((await editor(`/api/people/${ravi.body.id}/active`, { active: false })).status, 404);
  assert.deepEqual(await names(''), ['Arjun Rao', 'Meena Shah']);
  assert.deepEqual(await names('status=inactive'), ['Ravi Kumar']);
  assert.deepEqual(await names('status=all'), ['Arjun Rao', 'Meena Shah', 'Ravi Kumar']);
  assert.equal((await editor(`/api/people/${ravi.body.id}/active`, { active: true })).status, 200);
  assert.deepEqual(await names(''), ['Arjun Rao', 'Meena Shah', 'Ravi Kumar']);
});

test('viewers see names and positions, but not contact details or notes', async () => {
  const { body } = await viewer('/api/people');
  assert.equal(body.contactsHidden, true);
  const r = body.people.find((p) => p.name === 'Ravi Kumar');
  assert.equal(r.position, 'Senior Accountant');
  assert.equal(r.email, undefined); assert.equal(r.phone, undefined); assert.equal(r.notes, undefined);
  assert.deepEqual((await viewer('/api/people?q=98765')).body.people, []); // can't search by phone either
  assert.equal((await editor('/api/people')).body.contactsHidden, false);
});

test('assigning positions: editors assign active positions to active people', async () => {
  const pos = new Map((await admin('/api/positions')).body.positions.map((p) => [p.name, p.id]));
  const people = new Map((await editor('/api/people?status=all')).body.people.map((p) => [p.name, p.id]));
  assert.equal((await editor(`/api/positions/${pos.get('Manager')}/assign`, { person_id: people.get('Arjun Rao') })).status, 200);
  assert.equal((await viewer(`/api/positions/${pos.get('Manager')}/assign`, { person_id: people.get('Arjun Rao') })).status, 403);
  let list = (await editor('/api/people')).body.people;
  assert.equal(list.find((p) => p.name === 'Arjun Rao').position, 'Manager');
  assert.equal((await admin('/api/positions')).body.positions.find((p) => p.name === 'Manager').people, 1);

  // a deactivated position can't be given to anyone new, but people who hold it keep it
  assert.equal((await admin(`/api/positions/${pos.get('Manager')}`, { active: false })).status, 200);
  assert.equal((await editor(`/api/positions/${pos.get('Manager')}/assign`, { person_id: people.get('Ravi Kumar') })).status, 400);
  assert.match((await editor('/api/people', { name: 'New', position_id: pos.get('Manager') })).body.error.message, /inactive/);
  list = (await editor('/api/people')).body.people;
  assert.equal(list.find((p) => p.name === 'Arjun Rao').position, 'Manager');
  assert.equal((await editor(`/api/people/${people.get('Arjun Rao')}`, { name: 'Arjun Rao', notes: 'still here' })).status, 200); // editing other fields is fine
  assert.equal((await admin(`/api/positions/${pos.get('Manager')}`, { active: true })).status, 200);

  // inactive people can't be assigned
  await editor(`/api/people/${people.get('Ravi Kumar')}/active`, { active: false });
  assert.equal((await editor(`/api/positions/${pos.get('Manager')}/assign`, { person_id: people.get('Ravi Kumar') })).status, 400);
  await editor(`/api/people/${people.get('Ravi Kumar')}/active`, { active: true });
});

test('admin has full access; editors and viewers are kept out of admin-only areas', async () => {
  for (const p of ['/api/position', '/api/emis', '/api/people?status=all', '/api/positions', '/api/users', '/api/activity']) {
    assert.equal((await admin(p)).status, 200, `admin GET ${p}`);
  }
  for (const who of [editor, viewer]) {
    assert.equal((await who('/api/activity')).status, 403);
    assert.equal((await who('/api/users')).status, 403);
    assert.equal((await who('/api/users', { name: 'Z', email: 'z@x.in', role: 'admin', password: 'zzzzzzzzz1' })).status, 403);
    assert.equal((await who('/api/banks', { name: 'B', bank: 'B', last4: '1234' })).status, 403);
  }
  for (const p of ['/api/people', '/api/positions', '/api/activity']) assert.equal((await anon(p)).status, 401);
  // admin can do everything an editor can, across modules
  const b = await admin('/api/banks', { name: 'Main', bank: 'HDFC', last4: '1234' });
  assert.equal((await admin('/api/balances', { bank_id: b.body.id, amount: '1,00,000' })).status, 200);
  const pay = await admin('/api/payments', { payee: 'Rent', category: 'Rent', amount: '10,000', due_date: todayIST(), bank_id: b.body.id });
  assert.equal((await admin(`/api/payments/${pay.body.id}/approve`, {})).status, 200);
  assert.equal((await admin('/api/emis', { lender: 'Loan', amount: '5,000', bank_id: b.body.id, start_date: todayIST() })).status, 200);
  assert.equal((await admin('/api/people', { name: 'By Admin' })).status, 200);
});

test('activity log: sign-ins, failures, lockouts and changes, with who and when — never passwords', async () => {
  const other = session();
  assert.equal((await other('/api/login', { email: 'nobody@x.in', password: 'whatever123' })).status, 401);
  for (let i = 0; i < 5; i++) await other('/api/login', { email: 'vik@x.in', password: 'wrongpass99' });
  assert.equal((await other('/api/login', { email: 'vik@x.in', password: PW.viewer })).status, 429); // locked
  assert.equal((await editor('/api/logout', {})).status, 200);

  const all = (await admin('/api/activity')).body.activity;
  const actions = all.map((a) => a.action);
  for (const a of ['setup', 'user.add', 'login', 'login.failed', 'login.locked', 'logout', 'person.add', 'person.edit', 'person.deactivate', 'person.activate', 'person.assign',
    'position.add', 'position.edit', 'position.deactivate', 'position.activate', 'payment.approve', 'emi.add', 'bank.add']) assert.ok(actions.includes(a), `logged: ${a}`);
  const unknown = all.find((a) => a.action === 'login.failed' && a.detail.email === 'nobody@x.in');
  assert.equal(unknown.user_id, null);
  const add = all.find((a) => a.action === 'person.add' && a.detail.name === 'Ravi Kumar');
  assert.equal(add.user_name, 'Eli Editor');
  assert.ok(Math.abs(Date.parse(add.at) - Date.now()) < 120000);
  const edit = all.find((a) => a.action === 'person.edit' && a.detail.name === 'Meena Shah');
  assert.ok(edit.detail.changes.position_id);
  assert.deepEqual(edit.detail.changes.phone, ['…', 'changed']); // contact values aren't copied into the log

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
  assert.ok((await ids('type=people')).every((a) => a.action.startsWith('person.')));
  assert.ok((await ids('q=Meena')).length > 0);
  assert.equal((await ids('from=2000-01-01&to=2000-01-02')).length, 0);
  assert.ok((await ids(`from=${todayIST()}&to=${todayIST()}`)).length > 0);
  assert.equal((await admin('/api/activity?type=bogus')).status, 400);

  // pages of 50, newest first, no overlap
  for (let i = 0; i < 45; i++) await admin('/api/people', { name: `Bulk ${i}` });
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
