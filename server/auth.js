// Passwords (scrypt) and sessions (an HMAC-signed cookie). Signing out everywhere bumps users.ver.
import crypto from 'node:crypto';

const SECRET = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw Object.assign(new Error('SESSION_SECRET must be set (at least 32 characters).'), { status: 500, code: 'config' });
  return s;
};
export const COOKIE = 'fa_session';
const DAY = 864e5, TTL = 14 * DAY;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function checkPassword(pw, stored) {
  const [v, salt, h] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !h) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 }), b = Buffer.from(h, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (s.length > 200) return 'That password is too long.';
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'Use letters and numbers.';
  return null;
}
export const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sign = (body) => crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');

export function makeToken(user, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, ver: user.ver, exp: now + TTL })).toString('base64url');
  return `${body}.${sign(body)}`;
}
export function readToken(token, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEqual(sign(body), sig)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > now ? p : null; } catch { return null; }
}
export function cookieValue(headers) {
  const m = String(headers?.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : '';
}
export const cookieHeader = (token, secure, maxAgeMs = TTL) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
