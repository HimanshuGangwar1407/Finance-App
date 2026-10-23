import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { readWithAi, setAiClient, tableFromLines, aiConfigured, MODEL } from '../server/ai.js';
import { readStatement } from '../server/reconcile.js';
import { setPool } from '../server/db.js';
import { pglitePool } from '../server/local-db.js';
import { todayIST, addDays } from '../server/money.js';
import { makePdf } from './pdf-maker.js';

// a stand-in for Claude: answers with what Claude would, and keeps what it was sent
const sent = [];
const fakeClaude = (answer) => ({
  beta: { messages: { stream: (params) => { sent.push(params); return { finalMessage: async () => (typeof answer === 'function' ? answer(params) : answer) }; } } },
});
const reply = (out, extra = {}) => ({ model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 3000, output_tokens: 900 }, ...extra });
const L = (date, narration, ref, withdrawal, deposit, balance) => ({ date, narration, ref, withdrawal, deposit, balance });
// what Claude reads from the (made-up) IDBI e-statement: as printed, figures as text
const IDBI = [
  L('21-10-2026', 'AT ,BROUGHT FORWARD', '', '', '', '21,44,089.85'),
  L('21-10-2026', 'AT 191-DELHI - LAJPAT NAGAR ,UPI/870008483904/PRINCE VERMA', '', '', '40,000.00', '21,84,089.85'),
  L('21-10-2026', 'AT 191-DELHI - LAJPAT NAGAR ,SUNITA', '967712', '25,422.00', '', '21,58,667.85'),
  L('21-10-2026', 'AT 191-DELHI - LAJPAT NAGAR ,NEFT-PUNB0486700-GEETA HHAH', '967708', '18,000.00', '', '21,40,667.85'),
  L('21-10-2026', 'AT 191-DELHI - LAJPAT NAGAR ,NEFT-CHARGE-DR-IBKL26102199181', '', '5.90', '', '21,40,661.95'),
];
const pdf = makePdf([[40, 500, 'any statement']]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

test('not set up: no ANTHROPIC_API_KEY → says how to turn it on', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  setAiClient(null);
  assert.equal(aiConfigured(), false);
  await assert.rejects(readWithAi(pdf), (e) => e.code === 'ai_not_configured' && /ANTHROPIC_API_KEY/.test(e.message));
});

test('a PDF goes to Claude Opus 5.5 as a document, asking for each line as printed (JSON), with fallbacks on', async () => {
  setAiClient(fakeClaude(reply({ is_statement: true, lines: IDBI, note: '' })));
  const r = await readWithAi(pdf, 'AMINORICH IDBI.pdf');
  const p = sent.at(-1);
  assert.equal(p.model, 'claude-opus-5-5');
  assert.deepEqual([p.betas, p.fallbacks, p.output_config.effort, p.output_config.format.type], [['server-side-fallback-2026-07-01'], 'default', 'low', 'json_schema']);
  assert.equal(p.thinking, undefined); // Opus 5.5: thinking can't be turned off; effort sets the depth
  const [doc, ask] = p.messages[0].content;
  assert.deepEqual([doc.type, doc.source.type, doc.source.media_type, Buffer.from(doc.source.data, 'base64').equals(pdf)], ['document', 'base64', 'application/pdf', true]);
  assert.match(ask.text, /exactly as printed, digit for digit — never calculate, round, correct/);
  assert.deepEqual(p.output_config.format.schema.properties.lines.items.required, ['date', 'narration', 'ref', 'withdrawal', 'deposit', 'balance']);
  // the lines become a statement like any other, checked against the running balance
  const st = readStatement(r.table);
  assert.deepEqual([st.rows.length, st.checked, st.opening, st.closing], [4, { ok: 4, of: 4 }, 214_408_985, { date: '2026-10-21', amount: 214_066_195 }]);
  assert.deepEqual(st.rows.map((x) => [x.ref, x.debit, x.credit]), [['', 0, 4_000_000], ['967712', 2_542_200, 0], ['967708', 1_800_000, 0], ['', 590, 0]]);
  assert.deepEqual([r.model, r.usage, r.file], [MODEL, { input: 3000, output: 900 }, 'AMINORICH IDBI.pdf']);
});

test('a photo (PNG / JPEG) goes as an image; other files, locked PDFs and non-statements are refused clearly', async () => {
  setAiClient(fakeClaude(reply({ is_statement: true, lines: IDBI, note: 'Line 3 is faint' })));
  const r = await readWithAi(png, 'photo.png');
  assert.deepEqual([sent.at(-1).messages[0].content[0].type, sent.at(-1).messages[0].content[0].source.media_type, r.note], ['image', 'image/png', 'Line 3 is faint']);
  await readWithAi(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]));
  assert.equal(sent.at(-1).messages[0].content[0].source.media_type, 'image/jpeg');
  await assert.rejects(readWithAi(Buffer.from('Date,Narration\n')), /takes a PDF, or a photo/);
  await assert.rejects(readWithAi(makePdf([[40, 500, 'x']], { password: 'pw' })), /locked with a password, which the AI can’t open/);
  setAiClient(fakeClaude(reply({ is_statement: false, lines: [], note: 'This is an invoice' })));
  await assert.rejects(readWithAi(pdf), /isn’t a bank statement/);
});

test('Claude declining, an answer cut short, an unreadable answer, a busy service and a bad key each get a plain message', async () => {
  setAiClient(fakeClaude(reply({}, { stop_reason: 'refusal', content: [] })));
  await assert.rejects(readWithAi(pdf), (e) => e.code === 'ai_refused');
  setAiClient(fakeClaude(reply({ is_statement: true, lines: IDBI, note: '' }, { stop_reason: 'max_tokens' })));
  await assert.rejects(readWithAi(pdf), /too long to read in one go/);
  setAiClient(fakeClaude({ model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"lines": [' }], usage: {} }));
  await assert.rejects(readWithAi(pdf), (e) => e.code === 'ai_unavailable');
  const throwing = (err) => ({ beta: { messages: { stream: () => ({ finalMessage: async () => { throw err; } }) } } });
  setAiClient(throwing(Anthropic.APIError.generate(429, { error: { message: 'slow down' } }, 'slow down', new Headers())));
  await assert.rejects(readWithAi(pdf), (e) => e.code === 'ai_busy' && e.status === 429);
  setAiClient(throwing(Anthropic.APIError.generate(401, { error: { message: 'bad key' } }, 'bad key', new Headers())));
  await assert.rejects(readWithAi(pdf), (e) => e.code === 'ai_not_configured' && /was refused/.test(e.message));
  setAiClient(throwing(Anthropic.APIError.generate(529, { error: { message: 'overloaded' } }, 'overloaded', new Headers())));
  await assert.rejects(readWithAi(pdf), (e) => e.code === 'ai_unavailable');
});

test('lines sent back by the browser are checked before use', () => {
  assert.equal(tableFromLines([['Date', 'Narration', 'Ref No.', 'Withdrawal', 'Deposit', 'Balance']]).rows.length, 1);
  for (const bad of [null, [], [['a']], [[1, 2, 3, 4, 5, 6]], [['x'.repeat(301), '', '', '', '', '']]]) assert.throws(() => tableFromLines(bad), /couldn’t be read/);
});

// ── the API ──
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
const admin = session(), editor = session(), viewer = session();
const today = todayIST(), yday = addDays(today, -1), dmy = (d) => d.split('-').reverse().join('-');

test('API: read with AI, then check and apply the lines it read', async () => {
  await admin('/api/setup', { name: 'Asha', email: 'a@x.in', password: 'adminpass123' });
  await admin('/api/users', { name: 'Eli', email: 'e@x.in', role: 'editor', password: 'editorpass12' });
  await admin('/api/users', { name: 'Vik', email: 'v@x.in', role: 'viewer', password: 'viewerpass12' });
  await editor('/api/login', { email: 'e@x.in', password: 'editorpass12' });
  await viewer('/api/login', { email: 'v@x.in', password: 'viewerpass12' });
  const bank = (await admin('/api/banks', { name: 'IDBI Current', bank: 'IDBI Bank', last4: '1198' })).body.id;
  const geeta = (await editor('/api/transactions', { kind: 'OUT', status: 'pending', payee: 'Geeta Shah', amount: '18,000', date: yday, category: 'Vendor', bank_id: bank })).body.id;

  delete process.env.ANTHROPIC_API_KEY; setAiClient(null);
  assert.equal((await editor('/api/state')).body.ai, false);
  const body = { file: pdf.toString('base64'), name: 'AMINORICH IDBI.pdf' };
  assert.equal((await editor('/api/reconcile/ai-read', body)).body.error.code, 'ai_not_configured');

  process.env.ANTHROPIC_API_KEY = 'test-key'; // only switches the feature on: the stand-in answers
  setAiClient(fakeClaude(reply({ is_statement: true, lines: IDBI.map((l) => ({ ...l, date: dmy(yday) })), note: '' })));
  assert.equal((await editor('/api/state')).body.ai, true);
  assert.equal((await viewer('/api/reconcile/ai-read', body)).status, 403);
  const r = await editor('/api/reconcile/ai-read', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.lines.length, r.body.lines[0], r.body.note], [6, ['Date', 'Narration', 'Ref No.', 'Withdrawal', 'Deposit', 'Balance'], '']);

  const check = await editor('/api/reconcile/check', { ...body, bank_id: bank, lines: r.body.lines });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual([check.body.ai, check.body.ocr, check.body.checked, check.body.debits.length], [true, false, { ok: 4, of: 4 }, 3]);
  const line = check.body.debits.find((d) => d.match?.id === geeta);
  assert.equal(line.match.how, 'name'); // GEETA HHAH → Geeta Shah
  const apply = await editor('/api/reconcile/apply', { ...body, bank_id: bank, lines: r.body.lines, matches: [{ row: line.row, id: geeta }] });
  assert.deepEqual([apply.status, apply.body.paid, apply.body.paidAmount], [200, 1, 1_800_000]);
  assert.equal((await editor('/api/reconcile/check', { ...body, bank_id: bank, lines: [['nope']] })).status, 400);

  const log = (await admin('/api/activity?type=reports')).body.activity.find((a) => a.action === 'reconcile.ai_read');
  assert.deepEqual([log.user_name, log.detail.file, log.detail.model, log.detail.lines, log.detail.tokens], ['Eli', 'AMINORICH IDBI.pdf', MODEL, 5, { input: 3000, output: 900 }]);
  delete process.env.ANTHROPIC_API_KEY;
});

test('the page offers AI reading only when it is set up', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /S\.ai = Boolean\(st\.ai\)/);
  assert.match(app, /The statement is sent to Anthropic to be read/);
});
