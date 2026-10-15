// Postgres in-process (PGlite) for running on a laptop without a database server. It mimics the small part of a
// pg.Pool that db.js uses. One connection, so queries and transactions take turns.
import { PGlite } from '@electric-sql/pglite';
import { PARSERS } from './db.js';

export function pglitePool(dir) {
  const db = new PGlite({ dataDir: dir, parsers: PARSERS }); // no dir = in memory
  let chain = Promise.resolve();
  const lock = () => {
    let release;
    const mine = new Promise((r) => { release = r; });
    const turn = chain.then(() => release);
    chain = chain.then(() => mine);
    return turn;
  };
  // several statements in one text (migrations) only run through exec(), which skips the type parsers
  const many = (text) => /;\s*\S/.test(text.trim().replace(/;$/, ''));
  const run = async (text, params) => {
    const r = params?.length || !many(text) ? await db.query(text, params) : (await db.exec(text)).at(-1) ?? { rows: [] };
    return { rows: r.rows ?? [], rowCount: r.rows?.length || r.affectedRows || 0 };
  };
  return {
    async query(text, params) { const release = await lock(); try { return await run(text, params); } finally { release(); } },
    async connect() { const release = await lock(); return { query: run, release }; },
    end: () => db.close(),
  };
}
