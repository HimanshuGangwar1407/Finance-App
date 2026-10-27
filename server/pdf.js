// A bank statement PDF → the same table the Excel / CSV reader gives ({ rows: [{ n, cells }] }), rebuilt from where
// each piece of text sits on the page: the heading row gives the columns; each text piece goes to the column it is
// under; a row whose date and particulars wrap onto more lines is put back together.
// Only PDFs with real text work. A "printed" picture of a statement (e.g. Microsoft Print to PDF) has none, and is
// not guessed at with OCR: a misread digit would mark the wrong payment paid.

const fail = (message, code = 'invalid_argument') => { throw Object.assign(new Error(message), { status: 400, code }); };
export const NO_TEXT = 'This PDF has no text in it — it is a picture of the statement (for example saved with “Microsoft Print to PDF”), so its figures can’t be read exactly. Instead: paste the statement table from the bank’s email into the paste box; or print the email with Chrome’s “Save as PDF”; or download the statement from net banking as Excel / CSV.';

// a heading row: names a description column and a withdrawal / debit column
const isHeader = (text) => /particulars|narration|description|details|remarks/i.test(text) && /withdrawal|debit|\bdr\b|deposit|credit/i.test(text);
const DATE_HEAD = /date|\bdt\b/i;
const END = /^(note\b|disclaimer|statement\s+summary|end\s+of\s+statement|\*{3,}|total\b|grand\s+total|opening\s+balance\s*:|closing\s+balance\s*:|this\s+is\s+a\s+(system|computer))/i;
const DATE_START = /^\d{1,2}[-/. ](\d{1,2}|[a-z]{3,9})([-/. ]|$)/i;
const join = (a, b) => (!a ? b : !b ? a : /[-/]$/.test(a) ? a + b : `${a} ${b}`);

async function load() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // run the PDF worker in this process (no separate worker file to find at run time)
  globalThis.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return pdfjs;
}

/** every piece of text, page by page: { x, y, w, h, s } (PDF points, y up), without the page's top and bottom margins */
async function textItems(buf, password) {
  const pdfjs = await load();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), password: password || undefined, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') fail(password ? 'That password didn’t open the PDF. Bank PDFs are often locked with your customer ID or date of birth — check the bank’s email.' : 'This PDF is locked with a password. Enter it to open the statement.', 'pdf_password');
    fail('That PDF couldn’t be opened. It may be damaged; download the statement again.');
  }
  if (doc.numPages > 60) fail('That PDF has more than 60 pages. Upload a shorter period.');
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), [, , , top] = page.view, tc = await page.getTextContent();
    pages.push(tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height || 8, s: it.str.trim() }))
      .filter((it) => it.y > 30 && it.y < top - 30)); // the browser's print header and footer
  }
  await doc.destroy();
  return pages;
}

// pieces at (nearly) the same height make a line; top to bottom, left to right
function lines(items) {
  const out = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const l = out.at(-1);
    if (l && Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.25)) l.items.push(it); else out.push({ y: it.y, h: it.h, items: [it] });
  }
  for (const l of out) { l.items.sort((a, b) => a.x - b.x); l.text = l.items.map((i) => i.s).join(' '); }
  return out;
}

// the columns, from the heading line and the heading words just above / below it ("Post-" / "date", "Chq." / "No.")
function columns(ls, at) {
  const band = ls.filter((l) => Math.abs(l.y - ls[at].y) <= ls[at].h * 1.6 && l.items.every((i) => i.s.length <= 25 && !/\d[\d,]*\.\d\d/.test(i.s)));
  const heads = band.flatMap((l) => l.items.map((i) => ({ ...i, y: l.y }))).sort((a, b) => a.x - b.x);
  const cols = [];
  for (const it of heads) {
    // a heading split over lines ("Post-" / "date") is one column; two headings side by side on a line never are,
    // however close ("Chq. No." "Withdrawals")
    const c = cols.find((k) => it.x < k.r + 4 && it.x + it.w > k.l - 4 && !k.parts.some((p) => Math.abs(p.y - it.y) < 1));
    if (c) { c.parts.push(it); c.l = Math.min(c.l, it.x); c.r = Math.max(c.r, it.x + it.w); } else cols.push({ l: it.x, r: it.x + it.w, parts: [it] });
  }
  cols.sort((a, b) => a.l - b.l);
  for (const c of cols) { c.mid = (c.l + c.r) / 2; c.text = c.parts.sort((a, b) => b.y - a.y || a.x - b.x).reduce((t, p) => join(t, p.s), ''); }
  return { cols, band: new Set(band) };
}

/** the statement PDF as table rows: [{ n, cells }], the first being the headings */
export async function readPdf(buf, password) {
  const pages = await textItems(buf, password);
  if (!pages.some((p) => p.length)) fail(NO_TEXT, 'pdf_no_text');
  return tableFromPages(pages);
}

// two amounts read as one word where the columns touch: "40,000.0021,84,089.85" → "40,000.00" and "21,84,089.85"
const TWO_AMOUNTS = /^((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})$/;
function splitAmounts(items) {
  return items.flatMap((it) => {
    const m = TWO_AMOUNTS.exec(it.s);
    if (!m) return [it];
    const w1 = (it.w * m[1].length) / it.s.length;
    return [{ ...it, s: m[1], w: w1 }, { ...it, s: m[2], x: it.x + w1, w: it.w - w1 }];
  });
}

/**
 * Words read from pictures of the pages (OCR in the browser): [{ top, words: [{ x, y, w, h, s }] }] in PDF points,
 * y up from the bottom of the page. Checked, then read like a PDF's own text.
 */
export function ocrPages(ocr) {
  if (!Array.isArray(ocr) || !ocr.length || ocr.length > 60) fail('The picture of the statement couldn’t be read. Try again.');
  const num = (v) => (Number.isFinite(v) ? v : fail('The picture of the statement couldn’t be read. Try again.'));
  return ocr.map((p) => {
    const top = num(p?.top), words = Array.isArray(p?.words) ? p.words.slice(0, 6000) : [];
    return words.filter((w) => typeof w?.s === 'string' && w.s.trim())
      .map((w) => ({ x: num(w.x), y: num(w.y), w: num(w.w), h: num(w.h) || 8, s: w.s.trim().slice(0, 200), word: true }))
      .filter((it) => it.y > 30 && it.y < top - 30);
  });
}

/** text pieces with positions, page by page → table rows */
export function tableFromPages(pages) {
  pages = pages.map(splitAmounts);
  let cols = null, dateCol = -1, ended = false;
  const wraps = []; // each record's cells, line by line
  const rows = [], records = [], head = []; // head: the lines above the first headings (the account number is there)
  // amounts, dates, cheque numbers sit under their heading (often right-aligned): placed by their middle.
  // Words are left-aligned: placed by where they start (a short "AT ,BROUGHT FORWARD" is still Particulars).
  // A short run of digits ("4539", "2026") is usually the end of a wrapped description or date: placed by where it
  // starts. A long one (a cheque / reference no., "081400") sits under its heading.
  const NUMBERISH = /^(-?[\d,]+\.\d{1,2}(\s*(dr|cr))?|\d{1,2}[-/.].*|\d{1,8})$/i;
  const CENTRED = /^(-?[\d,]+\.\d{1,2}(\s*(dr|cr))?|\d{1,2}[-/.].*|\d{6,8})$/i;
  const colOf = (it) => {
    if (CENTRED.test(it.s)) {
      const m = it.x + it.w / 2, i = cols.findIndex((c, k) => m < (k + 1 < cols.length ? (c.mid + cols[k + 1].mid) / 2 : Infinity));
      return i < 0 ? cols.length - 1 : i;
    }
    let i = 0;
    for (let k = 1; k < cols.length; k++) if (it.x + 2 >= cols[k - 1].r) i = k;
    return i;
  };
  // OCR gives single words: those close together on a line are one phrase ("GEETA" "HHAH"). A PDF's text already
  // comes in phrases, and its columns can sit only a point or two apart ("23-10-2026"|"AT ,BROUGHT FORWARD"): never joined.
  const pageLines = pages.map((items) => lines(items).map((l) => {
    const out = [];
    for (const it of l.items) {
      const prev = out.at(-1);
      if (prev && prev.word && it.word && it.x - (prev.x + prev.w) <= Math.max(2.5, 0.6 * it.h) && !(NUMBERISH.test(prev.s) && NUMBERISH.test(it.s))) {
        prev.w = it.x + it.w - prev.x; prev.s = join(prev.s, it.s);
      } else out.push({ ...it });
    }
    return { ...l, items: out };
  }));
  // what every page repeats in the same place — the bank's name and address, "Statement of account", the footer — is
  // the page, not the table (statements often carry on page after page without repeating the column headings)
  // A line is the page's when every piece of it is on another page in the same place — a statement line never is
  // (its description and amounts differ). Never a line that starts with a date, or one without a letter in it.
  const where = (it) => `${Math.round(it.x / 2)}|${Math.round(it.y / 2)}|${it.s}`;
  const seen = new Map();
  for (const ls of pageLines) for (const k of new Set(ls.flatMap((l) => l.items.map(where)))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const boilerplate = (l) => pageLines.length > 1 && /[a-z]/i.test(l.text) && !DATE_START.test(l.text) && l.items.every((it) => seen.get(where(it)) > 1);
  for (const ls of pageLines) {
    let skip = new Set();
    // a page that repeats the headings: what is above them (bank name, address, "Page No") isn't the table.
    // A page without them carries straight on from the page before.
    let paused = ls.some((l) => isHeader(l.text));
    for (let i = 0; i < ls.length && !ended; i++) {
      const l = ls[i];
      if (skip.has(l)) continue;
      if (isHeader(l.text)) { // the headings (again, on a later page)
        const c = columns(ls, i);
        skip = c.band; paused = false;
        if (!cols) { cols = c.cols; dateCol = cols.findIndex((k) => DATE_HEAD.test(k.text)); rows.push({ n: 1, cells: cols.map((k) => k.text) }); }
        continue;
      }
      if (!cols) { if (head.length < 60) head.push(l.text); continue; } // above the table
      if (boilerplate(l)) continue; // what every page repeats
      const cells = cols.map(() => '');
      const xs = cols.map(() => null); // where each cell's text starts on this line
      for (const it of l.items) { const k = colOf(it); cells[k] = join(cells[k], it.s); xs[k] ??= it.x; }
      // a long plain number under the date is the end of a wrapped description ("5718991")
      if (dateCol >= 0 && dateCol + 1 < cols.length && /^\d{5,}$/.test(cells[dateCol])) { cells[dateCol + 1] = join(cells[dateCol], cells[dateCol + 1]); cells[dateCol] = ''; }
      // below the table (a page footer) until the next headings — or a line with a date and an amount
      if (paused && !(dateCol >= 0 && DATE_START.test(cells[dateCol]) && cells.some((c, k) => k !== dateCol && /\d[\d,]*\.\d\d\b/.test(c)))) continue;
      paused = false;
      const first = cells.find(Boolean) ?? '';
      if (END.test(first) || END.test(l.text)) { if (records.length) ended = true; continue; }
      const d = dateCol >= 0 ? cells[dateCol] : '';
      if (d && DATE_START.test(d)) { records.push(cells); wraps.push(cells.map((c, k) => (c ? [{ s: c, x: xs[k] }] : []))); continue; } // a new transaction
      if (!records.length) continue;
      if (d && !/^\d{2,4}$/.test(d)) { paused = true; continue; } // the table stops here (a page footer): until the next page's headings
      const last = records.at(-1); // the same transaction, carried onto another line
      cells.forEach((v, k) => {
        if (!v) return;
        wraps.at(-1)[k].push({ s: v, x: xs[k] });
        // a date broken over two lines whose separator was lost: "21-10" + "2026"
        const sep = k === dateCol && /^\d{1,2}([-/.])\d{1,2}$/.exec(last[k]);
        last[k] = sep && /^\d{2,4}$/.test(v) ? `${last[k]}${sep[1]}${v}` : join(last[k], v);
      });
    }
  }
  if (!cols) fail('No statement table found in this PDF: no heading row with Particulars / Narration and Withdrawals / Debit.');
  // Some banks (HDFC) cut a description into pieces of a fixed number of characters, often mid-word ("…ROAD LIN" /
  // "ES-ANSALS…"). When most wrapped cells of a column start with a piece of the same length, that is the width:
  // a piece that fills it is joined to the next without a space. Wrapping at spaces (IDBI) shows no such width.
  cols.forEach((_, k) => {
    const multi = wraps.filter((w) => w[k].length > 1);
    if (multi.length < 3) return;
    const lens = new Map();
    for (const w of multi) lens.set(w[k][0].s.length, (lens.get(w[k][0].s.length) ?? 0) + 1);
    const [width, count] = [...lens].sort((a, b) => b[1] - a[1])[0];
    if (width < 12 || count < 3 || count < multi.length * 0.4) return;
    multi.forEach((w) => {
      let text = '', piece = 0;
      // where the column's lines usually start: a piece starting further right began with a space
      const left = (() => { const m = new Map(); for (const v of multi) for (const p of v[k]) m.set(Math.round(p.x), (m.get(Math.round(p.x)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0][0]; })();
      for (const { s: part, x } of w[k]) {
        if (!text) { text = part; piece = part.length; continue; }
        if (x - left >= 1.2) { text = `${text} ${part}`; piece = 1 + part.length; continue; }
        // only a piece that fills the width exactly was cut mid-word (one short usually ended in a space)
        if (piece >= width) { text += part; piece = part.length; } else { text = join(text, part); piece += 1 + part.length; }
      }
      records[wraps.indexOf(w)][k] = text;
    });
  });
  records.forEach((cells, i) => rows.push({ n: i + 2, cells }));
  return { sheet: '', rows, head };
}
