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
