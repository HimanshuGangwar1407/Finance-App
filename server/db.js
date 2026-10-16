// Postgres (Neon on Vercel, or any Postgres 13+). The schema is created and upgraded by numbered migrations, each
// applied once inside a transaction. Money columns are BIGINT paise with CHECK constraints.
import pg from 'pg';

// dates stay 'YYYY-MM-DD' strings (no time-zone shifts); paise fit safely in a JS number (up to ₹90 lakh crore)
export const PARSERS = { 1082: (v) => v, 20: (v) => Number(v) };
for (const [oid, fn] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), fn);

let pool;
export function setPool(p) { pool = p; ready = null; } // tests
export function getPool() {
  if (pool) return pool;
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!raw) throw Object.assign(new Error('DATABASE_URL is not set. Add a Postgres database in Vercel → Storage, or set DATABASE_URL.'), { status: 500, code: 'config' });
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) || process.env.DATABASE_SSL === 'false';
  url.searchParams.delete('sslmode'); url.searchParams.delete('channel_binding');
  pool = new pg.Pool({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: true }, max: 4, idleTimeoutMillis: 10000 });
  return pool;
}
export const q = (text, params) => getPool().query(text, params);

const MIGRATIONS = [
  `CREATE TABLE users (
     id          serial PRIMARY KEY,
     email       text NOT NULL UNIQUE,
     name        text NOT NULL,
     pw          text NOT NULL,
     role        text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
     active      boolean NOT NULL DEFAULT true,
     ver         integer NOT NULL DEFAULT 1,
     fails       integer NOT NULL DEFAULT 0,
     lock_until  bigint NOT NULL DEFAULT 0,
     created_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE banks (
     id          serial PRIMARY KEY,
     name        text NOT NULL,
     bank        text NOT NULL,
     last4       char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
     active      boolean NOT NULL DEFAULT true,
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE balances (
     id          serial PRIMARY KEY,
     bank_id     integer NOT NULL REFERENCES banks(id),
     amount      bigint NOT NULL,
     as_of       date NOT NULL,
     note        text NOT NULL DEFAULT '',
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX balances_bank ON balances (bank_id, as_of DESC, id DESC);
   CREATE TABLE receipts (
     id            serial PRIMARY KEY,
     party         text NOT NULL,
     ref           text NOT NULL DEFAULT '',
     amount        bigint NOT NULL CHECK (amount > 0),
     expected_date date NOT NULL,
     certainty     text NOT NULL DEFAULT 'LIKELY' CHECK (certainty IN ('FIRM', 'LIKELY', 'UNCERTAIN')),
     bank_id       integer REFERENCES banks(id),
     note          text NOT NULL DEFAULT '',
     status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CANCELLED')),
     created_by    integer REFERENCES users(id),
     created_at    timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE payments (
     id          serial PRIMARY KEY,
     payee       text NOT NULL,
     ref         text NOT NULL DEFAULT '',
     ref_norm    text NOT NULL DEFAULT '',
     category    text NOT NULL,
     amount      bigint NOT NULL CHECK (amount > 0),
     due_date    date NOT NULL,
     bank_id     integer REFERENCES banks(id),
     approved    boolean NOT NULL DEFAULT false,
     note        text NOT NULL DEFAULT '',
     status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CANCELLED')),
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX payments_dup ON payments (ref_norm) WHERE ref_norm <> '';
   -- money actually received / paid; the bank reference can't be used twice on the same account
   CREATE TABLE entries (
     id          serial PRIMARY KEY,
     kind        text NOT NULL CHECK (kind IN ('IN', 'OUT')),
     receipt_id  integer REFERENCES receipts(id),
     payment_id  integer REFERENCES payments(id),
     bank_id     integer NOT NULL REFERENCES banks(id),
     amount      bigint NOT NULL CHECK (amount > 0),
     date        date NOT NULL,
     ref         text NOT NULL,
     ref_norm    text NOT NULL,
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now(),
     CHECK ((kind = 'IN' AND receipt_id IS NOT NULL AND payment_id IS NULL) OR (kind = 'OUT' AND payment_id IS NOT NULL AND receipt_id IS NULL)),
     UNIQUE (bank_id, kind, ref_norm)
   );
   CREATE TABLE audit (
     id      serial PRIMARY KEY,
     at      timestamptz NOT NULL DEFAULT now(),
     user_id integer REFERENCES users(id),
     action  text NOT NULL,
     detail  jsonb NOT NULL DEFAULT '{}'
   );`,
  // EMIs: a monthly loan instalment. Each month's instalment becomes a payment (emi_id set), and its money is held in
  // the account from hold_days before the due date until it is paid.
  `CREATE TABLE emis (
     id          serial PRIMARY KEY,
     lender      text NOT NULL,
     ref         text NOT NULL DEFAULT '',
     amount      bigint NOT NULL CHECK (amount > 0),
     day         smallint NOT NULL CHECK (day BETWEEN 1 AND 31),
     bank_id     integer NOT NULL REFERENCES banks(id),
     start_date  date NOT NULL,
     end_date    date,
     hold_days   smallint NOT NULL DEFAULT 0 CHECK (hold_days BETWEEN 0 AND 31),
     active      boolean NOT NULL DEFAULT true,
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now()
   );
   ALTER TABLE payments ADD COLUMN emi_id integer REFERENCES emis(id);
   CREATE UNIQUE INDEX payments_emi_date ON payments (emi_id, due_date) WHERE emi_id IS NOT NULL;`,
  // people (staff, contacts) and the positions an admin defines for them; nothing is deleted, only deactivated
  `CREATE TABLE positions (
     id          serial PRIMARY KEY,
     name        text NOT NULL,
     description text NOT NULL DEFAULT '',
     active      boolean NOT NULL DEFAULT true,
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now(),
     updated_by  integer REFERENCES users(id),
     updated_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX positions_name ON positions (lower(name));
   CREATE TABLE people (
     id          serial PRIMARY KEY,
     name        text NOT NULL,
     email       text NOT NULL DEFAULT '',
     phone       text NOT NULL DEFAULT '',
     position_id integer REFERENCES positions(id),
     notes       text NOT NULL DEFAULT '',
     active      boolean NOT NULL DEFAULT true,
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now(),
     updated_by  integer REFERENCES users(id),
     updated_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX people_email ON people (lower(email)) WHERE email <> '';
   CREATE INDEX people_position ON people (position_id);
   CREATE INDEX audit_user ON audit (user_id, id DESC);
   CREATE INDEX audit_action ON audit (action, id DESC);`,
  // EMI reminders: per-EMI settings, in-app notifications per user, and an email outbox. The unique keys make each
  // reminder happen once, however often reminders are checked.
  `ALTER TABLE emis
     ADD COLUMN remind_days   smallint NOT NULL DEFAULT 3 CHECK (remind_days BETWEEN 0 AND 30),
     ADD COLUMN remind_in_app boolean NOT NULL DEFAULT true,
     ADD COLUMN remind_email  boolean NOT NULL DEFAULT false,
     ADD COLUMN remind_to     text NOT NULL DEFAULT '';
   CREATE TABLE notifications (
     id          serial PRIMARY KEY,
     user_id     integer NOT NULL REFERENCES users(id),
     kind        text NOT NULL,
     title       text NOT NULL,
     body        text NOT NULL DEFAULT '',
     link        text NOT NULL DEFAULT '',
     dedupe_key  text NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now(),
     read_at     timestamptz,
     UNIQUE (user_id, dedupe_key)
   );
   CREATE INDEX notifications_user ON notifications (user_id, id DESC);
   CREATE TABLE email_outbox (
     id          serial PRIMARY KEY,
     to_addr     text NOT NULL,
     subject     text NOT NULL,
     body        text NOT NULL,
     dedupe_key  text NOT NULL UNIQUE,
     status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
     error       text NOT NULL DEFAULT '',
     attempts    integer NOT NULL DEFAULT 0,
     created_at  timestamptz NOT NULL DEFAULT now(),
     sent_at     timestamptz
   );`,
  // several reminder points before the due date (7, 3 and 1 days by default), and switches for the due-date and
  // overdue reminders. remind_days (one point) is no longer used: an EMI that still has its default of 3 gets the new
  // 7, 3 and 1; one set to another number keeps that single point; 0 (no advance reminder) stays off.
  `ALTER TABLE emis
     ADD COLUMN remind_before  smallint[] NOT NULL DEFAULT '{7,3,1}',
     ADD COLUMN remind_due     boolean NOT NULL DEFAULT true,
     ADD COLUMN remind_overdue boolean NOT NULL DEFAULT true;
   UPDATE emis SET remind_before = CASE WHEN remind_days = 3 THEN '{7,3,1}'::smallint[]
                                        WHEN remind_days > 0 THEN ARRAY[remind_days]::smallint[] ELSE '{}'::smallint[] END;`,
  // app access for people: a person can have a sign-in account, which they create from a one-time link (an invite)
  // with their own password; the same kind of link resets a forgotten password. Only a hash of each link is kept.
  // People whose email already matches a user are linked to that user.
  `ALTER TABLE people ADD COLUMN user_id integer UNIQUE REFERENCES users(id);
   UPDATE people p SET user_id = u.id FROM users u WHERE p.email <> '' AND lower(p.email) = u.email;
   CREATE TABLE invites (
     id          serial PRIMARY KEY,
     kind        text NOT NULL CHECK (kind IN ('invite', 'reset')),
     person_id   integer REFERENCES people(id),
     user_id     integer REFERENCES users(id),
     email       text NOT NULL,
     role        text CHECK (role IN ('viewer', 'editor', 'admin')),
     token_hash  text NOT NULL UNIQUE,
     expires_at  timestamptz NOT NULL,
     created_by  integer REFERENCES users(id),
     created_at  timestamptz NOT NULL DEFAULT now(),
     used_at     timestamptz,
     revoked_at  timestamptz
   );
   CREATE INDEX invites_person ON invites (person_id, id DESC);`,
  // logins are made by admins on the Users page now (no invite links or sign-up): any invite links still open stop
  // working. The people and positions tables stay as they are, unused; nothing is deleted.
  `UPDATE invites SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL;`,
  // launch: the data entered while testing was dummy data. Every table except users (logins and passwords) is copied
  // into the "prelaunch_backup" schema and then emptied, so the app starts clean. Runs once, like every migration;
  // on a new, empty database it changes nothing. The backup can be dropped later: DROP SCHEMA prelaunch_backup CASCADE;
  `CREATE SCHEMA prelaunch_backup;
   CREATE TABLE prelaunch_backup.entries AS TABLE entries;
   CREATE TABLE prelaunch_backup.payments AS TABLE payments;
   CREATE TABLE prelaunch_backup.receipts AS TABLE receipts;
   CREATE TABLE prelaunch_backup.balances AS TABLE balances;
   CREATE TABLE prelaunch_backup.emis AS TABLE emis;
   CREATE TABLE prelaunch_backup.banks AS TABLE banks;
   CREATE TABLE prelaunch_backup.notifications AS TABLE notifications;
   CREATE TABLE prelaunch_backup.email_outbox AS TABLE email_outbox;
   CREATE TABLE prelaunch_backup.invites AS TABLE invites;
   CREATE TABLE prelaunch_backup.people AS TABLE people;
   CREATE TABLE prelaunch_backup.positions AS TABLE positions;
   CREATE TABLE prelaunch_backup.audit AS TABLE audit;
   TRUNCATE TABLE entries, payments, receipts, balances, emis, banks, notifications, email_outbox, invites, people, positions, audit RESTART IDENTITY;`,
  // deleted users: they can't sign in and don't appear on the Users page, but their name stays on what they recorded
  // and in the activity log (their email is released so it can be used again)
  `ALTER TABLE users ADD COLUMN deleted_at timestamptz;`,
];

let ready;
export function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await q('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await q('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
      for (const [i, sql] of MIGRATIONS.entries()) {
        if (done.has(i + 1)) continue;
        await withTx(async (c) => {
          await c.query('SELECT pg_advisory_xact_lock(7101)'); // two cold starts don't migrate at once
          if ((await c.query('SELECT 1 FROM schema_migrations WHERE version = $1', [i + 1])).rowCount) return;
          await c.query(sql);
          await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i + 1]);
        });
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** run fn(client) in one transaction: everything it writes is kept, or nothing is */
export async function withTx(fn) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505') throw Object.assign(new Error('That is already recorded.'), { status: 409, code: 'conflict', constraint: e.constraint });
    throw e;
  } finally {
    c.release();
  }
}
