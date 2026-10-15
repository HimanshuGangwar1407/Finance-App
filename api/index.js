// Vercel function: every /api/... request is rewritten here (vercel.json) and handed to the same handler `npm start` uses.
// The screen itself is served from public/. Needs DATABASE_URL (or POSTGRES_URL) and SESSION_SECRET in the project settings.
import { handler } from '../server/index.js';

export default function (req, res) {
  // the rewrite passes the original path as ?path=...; put it back so the routes match
  const url = new URL(req.url, 'http://x');
  const p = url.searchParams.get('path');
  if (p != null) {
    url.searchParams.delete('path');
    req.url = `/api/${p}${url.search}`;
  }
  return handler(req, res);
}
