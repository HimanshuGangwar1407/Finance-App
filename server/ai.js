// Reading a bank statement with Claude (Anthropic's AI): a PDF of any kind (text or a picture) or a photo of a page.
// Claude copies each line as printed; the figures are then checked against the running balance like any other
// statement, and nothing changes until someone reviews them and presses Apply.
// Needs ANTHROPIC_API_KEY in the environment (Vercel → Settings → Environment Variables).
import { str } from './money.js';

// the SDK is loaded the first time a statement is read, so nothing else in the app waits for it
let Anthropic = null;
const sdk = async () => (Anthropic ??= (await import('@anthropic-ai/sdk')).default);

const fail = (message, code = 'invalid_argument', status = 400) => { throw Object.assign(new Error(message), { status, code }); };
export const MODEL = 'claude-opus-5-5';
export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
/** tests put a stand-in here */
export function setAiClient(c) { client = c; }
const getClient = async () => client ?? (client = new (await sdk())());

// every line, as printed: amounts as text so nothing is rounded or reformatted
const LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'narration', 'ref', 'withdrawal', 'deposit', 'balance'],
  properties: {
    date: { type: 'string', description: 'The transaction (posting) date exactly as printed, e.g. "21-10-2026" or "21 Oct 2026".' },
    narration: { type: 'string', description: 'The full description / particulars / narration, joined into one line if it wraps.' },
    ref: { type: 'string', description: 'Cheque no. / reference no. / UTR column, as printed; "" if none.' },
    withdrawal: { type: 'string', description: 'Withdrawal (debit) amount exactly as printed, e.g. "25,422.00"; "" if none.' },
    deposit: { type: 'string', description: 'Deposit (credit) amount exactly as printed; "" if none.' },
    balance: { type: 'string', description: 'The balance after this line exactly as printed, with "Dr" if the statement shows it overdrawn; "" if none.' },
  },
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_statement', 'lines', 'note'],
  properties: {
    is_statement: { type: 'boolean', description: 'false if this is not a bank account statement.' },
    lines: { type: 'array', items: LINE },
    note: { type: 'string', description: 'Anything unclear (unreadable figures, cut-off pages); "" if nothing.' },
  },
};
const PROMPT = `This is a bank account statement from an Indian bank. Copy every transaction line of its table into "lines", in the order printed, across all pages.

- Copy each figure exactly as printed, digit for digit — never calculate, round, correct or fill in a value. Leave a field "" when the statement leaves it empty.
- Include an opening line such as "BROUGHT FORWARD" or "Opening Balance" if the table has one (it has only a balance).
- Leave out column headings, page headers and footers, totals, summaries and disclaimers.
- If a figure can't be read with certainty, copy what you can see and say which line in "note".`;

/**
 * file: Buffer of a PDF, PNG or JPEG. Returns table rows ({ rows: [{ n, cells }] }, headings first) for readStatement,
 * and the note Claude left.
 */
export async function readWithAi(buf, fileName = '') {
  if (!aiConfigured() && !client) fail('Reading with AI isn’t set up: add an ANTHROPIC_API_KEY in the app’s settings (on Vercel: Settings → Environment Variables), then redeploy.', 'ai_not_configured');
  const head = buf.subarray(0, 8);
  const media = head.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf'
    : head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
      : head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg' : null;
  if (!media) fail('AI reading takes a PDF, or a photo / screenshot of the statement (PNG or JPEG).');
  if (media === 'application/pdf' && /\/Encrypt\b/.test(buf.subarray(0, Math.min(buf.length, 4_000_000)).toString('latin1'))) {
    fail('This PDF is locked with a password, which the AI can’t open. Open it, print it with Chrome’s “Save as PDF” (that saves it unlocked), and upload that.');
  }
  const data = buf.toString('base64');
  const source = { type: 'base64', media_type: media, data };
  let message;
  try {
    message = await (await getClient()).beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if this model declines, Anthropic's recommended model reads it instead
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [media === 'application/pdf' ? { type: 'document', source } : { type: 'image', source }, { type: 'text', text: PROMPT }] }],
    }).finalMessage();
  } catch (e) {
    await sdk();
    if (e instanceof Anthropic.AuthenticationError) fail('The ANTHROPIC_API_KEY was refused. Check it in the app’s settings.', 'ai_not_configured');
    if (e instanceof Anthropic.RateLimitError) fail('The AI is busy right now. Try again in a minute.', 'ai_busy', 429);
    if (e instanceof Anthropic.BadRequestError) fail(`The AI couldn’t take this file: ${e.message}`.slice(0, 300));
    if (e instanceof Anthropic.APIError) fail('The AI service didn’t answer. Try again.', 'ai_unavailable', 502);
    throw e;
  }
  if (message.stop_reason === 'refusal') fail('The AI declined to read this file.', 'ai_refused');
  if (message.stop_reason === 'max_tokens') fail('This statement is too long to read in one go. Upload a shorter period.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { fail('The AI’s answer couldn’t be read. Try again.', 'ai_unavailable', 502); }
  if (!out || !Array.isArray(out.lines)) fail('The AI’s answer couldn’t be read. Try again.', 'ai_unavailable', 502);
  if (out.is_statement === false) fail('The AI says this isn’t a bank statement.');
  const s = (v) => str(v, 300);
  const rows = [{ n: 1, cells: ['Date', 'Narration', 'Ref No.', 'Withdrawal', 'Deposit', 'Balance'] },
    ...out.lines.slice(0, 5000).map((l, i) => ({ n: i + 2, cells: [s(l.date), s(l.narration), s(l.ref), s(l.withdrawal), s(l.deposit), s(l.balance)] }))];
  return { table: { sheet: '', rows }, note: s(out.note), model: message.model, usage: { input: message.usage?.input_tokens ?? 0, output: message.usage?.output_tokens ?? 0 }, file: fileName };
}

/** a table sent back by the browser (what the AI read), checked before use */
export function tableFromLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 5001) fail('The statement lines couldn’t be read. Read the statement again.');
  return { sheet: '', rows: lines.map((cells, i) => {
    if (!Array.isArray(cells) || cells.length !== 6 || !cells.every((c) => typeof c === 'string' && c.length <= 300)) fail('The statement lines couldn’t be read. Read the statement again.');
    return { n: i + 1, cells };
  }) };
}
