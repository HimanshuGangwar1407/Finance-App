// Money is whole paise (integers) everywhere. Amounts arrive as rupee strings ("12,500.50") and are parsed exactly —
// never through floating-point arithmetic.

const fail = (status, code) => (message) => { throw Object.assign(new Error(message), { status, code }); };
export const bad = fail(400, 'invalid_argument');
export const deny = fail(403, 'permission_denied');
export const conflict = fail(409, 'conflict');
export const notFound = fail(404, 'not_found');

/** "12,500.50" / "₹ 12500.5" / "-300" → paise. Throws on anything that isn't an exact amount. */
export function toPaise(v, label = 'Amount', { allowNegative = false, allowZero = true } = {}) {
  const raw = String(v ?? '').replace(/[,\s₹]/g, '').replace(/^Rs\.?/i, '');
  const m = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) bad(`${label}: enter an amount like 12500 or 12500.50.`);
  const p = (Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'))) * (m[1] ? -1 : 1);
  if (p < 0 && !allowNegative) bad(`${label} can’t be negative.`);
  if (p === 0 && !allowZero) bad(`${label} must be more than zero.`);
  return p === 0 ? 0 : p;
}
/** paise → "₹1,23,456.78" */
export function inr(p) {
  const n = Math.abs(p), r = Math.floor(n / 100), c = n % 100;
  return `${p < 0 ? '−' : ''}₹${r.toLocaleString('en-IN')}${c ? '.' + String(c).padStart(2, '0') : ''}`;
}
/** references compared without spaces, punctuation, case or zero-padding: "INV/24-25/0118" = "inv 24 25 118" */
export const normRef = (v) => String(v ?? '').toUpperCase().split(/[^A-Z0-9]+/).map((p) => p.replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''))).join('');

export const str = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
export function need(v, label) { if (!v) bad(`${label} is required.`); return v; }
export function ymd(v, label = 'Date', { optional = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s && optional) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) bad(`${label}: pick a valid date.`);
  return s;
}
export const oneOf = (v, list, label) => { if (!list.includes(v)) bad(`${label}: choose one of the options.`); return v; };
export const intId = (v, label = 'Record') => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) bad(`${label} is missing.`); return n; };
// business dates are Indian Standard Time, whatever the server's clock zone is
export const todayIST = (ms = Date.now()) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const monthEnd = (d) => { const x = new Date(Date.parse(d.slice(0, 7) + '-01T00:00:00Z')); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
