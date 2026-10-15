// Creates the one admin account, for a database where nobody has used the first-run setup screen yet.
//   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run create-admin
// The details come only from environment variables — never put them in code or commit them. The password is stored as a
// scrypt hash and is never printed or logged. It refuses when an active admin already exists: that admin adds people
// (including more admins) from Users in the app.
import { localSetup } from '../server/index.js';
import { ensureSchema, withTx, getPool } from '../server/db.js';
import { hashPassword, passwordProblem } from '../server/auth.js';
import { str } from '../server/money.js';

const fail = (message) => { console.error(message); process.exitCode = 1; };

async function main() {
  const email = str(process.env.ADMIN_EMAIL, 200).toLowerCase(), name = str(process.env.ADMIN_NAME, 100), password = process.env.ADMIN_PASSWORD ?? '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Set ADMIN_EMAIL to a valid email address.');
  if (!name) return fail('Set ADMIN_NAME.');
  const problem = passwordProblem(password);
  if (problem) return fail(`ADMIN_PASSWORD: ${problem}`);

  await localSetup();
  await ensureSchema();
  const created = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7102)'); // the same lock as the setup screen
    const { rows: [admin] } = await c.query("SELECT email FROM users WHERE role = 'admin' AND active LIMIT 1");
    if (admin) return null;
    const { rows: [u] } = await c.query("INSERT INTO users (email, name, pw, role) VALUES ($1, $2, $3, 'admin') RETURNING id", [email, name, hashPassword(password)]);
    await c.query('INSERT INTO audit (user_id, action, detail) VALUES ($1, $2, $3)', [u.id, 'admin.create', JSON.stringify({ email, via: 'create-admin script' })]);
    return u;
  }).catch((e) => { if (e.code === 'conflict') { fail('Someone already has an account with that email.'); return undefined; } throw e; });
  if (created === null) fail('An active admin already exists. Sign in as them and add people from Users instead.');
  else if (created) console.log(`Admin account created for ${email}. Sign in with that email and the password you set.`);
}

try { await main(); } finally { await getPool().end?.(); }
