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
    const c = cols.find((k) => it.x < k.r + 4 && it.x + it.w > k.l - 4);
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
      .map((w) => ({ x: num(w.x), y: num(w.y), w: num(w.w), h: num(w.h) || 8, s: w.s.trim().slice(0, 200) }))
      .filter((it) => it.y > 30 && it.y < top - 30);
  });
}

/** text pieces with positions, page by page → table rows */
export function tableFromPages(pages) {
  pages = pages.map(splitAmounts);
  let cols = null, dateCol = -1, ended = false;
  const rows = [], records = [];
  // amounts, dates, cheque numbers sit under their heading (often right-aligned): placed by their middle.
  // Words are left-aligned: placed by where they start (a short "AT ,BROUGHT FORWARD" is still Particulars).
  const NUMBERISH = /^(-?[\d,]+\.\d{1,2}(\s*(dr|cr))?|\d{1,2}[-/.].*|\d{1,8})$/i;
  const colOf = (it) => {
    if (NUMBERISH.test(it.s)) {
      const m = it.x + it.w / 2, i = cols.findIndex((c, k) => m < (k + 1 < cols.length ? (c.mid + cols[k + 1].mid) / 2 : Infinity));
      return i < 0 ? cols.length - 1 : i;
    }
    let i = 0;
    for (let k = 1; k < cols.length; k++) if (it.x + 2 >= cols[k - 1].r) i = k;
    return i;
  };
  for (const items of pages) {
    // words close together on a line are one phrase ("GEETA" "HHAH"); OCR gives single words, a PDF gives runs
    const ls = lines(items).map((l) => {
      const out = [];
      for (const it of l.items) {
        const prev = out.at(-1);
        if (prev && it.x - (prev.x + prev.w) <= Math.max(2.5, 0.6 * it.h) && !(NUMBERISH.test(prev.s) && NUMBERISH.test(it.s))) {
          prev.w = it.x + it.w - prev.x; prev.s = join(prev.s, it.s);
        } else out.push({ ...it });
      }
      return { ...l, items: out };
    });
    let skip = new Set();
    for (let i = 0; i < ls.length && !ended; i++) {
      const l = ls[i];
      if (skip.has(l)) continue;
      if (isHeader(l.text)) { // the headings (again, on a later page)
        const c = columns(ls, i);
        skip = c.band;
        if (!cols) { cols = c.cols; dateCol = cols.findIndex((k) => DATE_HEAD.test(k.text)); rows.push({ n: 1, cells: cols.map((k) => k.text) }); }
        continue;
      }
      if (!cols) continue; // above the table
      const cells = cols.map(() => '');
      for (const it of l.items) { const k = colOf(it); cells[k] = join(cells[k], it.s); }
      const first = cells.find(Boolean) ?? '';
      if (END.test(first) || END.test(l.text)) { if (records.length) ended = true; continue; }
      const d = dateCol >= 0 ? cells[dateCol] : '';
      if (d && DATE_START.test(d)) { records.push(cells); continue; } // a new transaction
      if (!records.length) continue;
      if (d && !/^\d{2,4}$/.test(d)) { ended = true; continue; } // not part of the table any more
      const last = records.at(-1); // the same transaction, carried onto another line
      cells.forEach((v, k) => {
        if (!v) return;
        // a date broken over two lines whose separator was lost: "21-10" + "2026"
        const sep = k === dateCol && /^\d{1,2}([-/.])\d{1,2}$/.exec(last[k]);
        last[k] = sep && /^\d{2,4}$/.test(v) ? `${last[k]}${sep[1]}${v}` : join(last[k], v);
      });
    }
  }
  if (!cols) fail('No statement table found in this PDF: no heading row with Particulars / Narration and Withdrawals / Debit.');
  records.forEach((cells, i) => rows.push({ n: i + 2, cells }));
  return { sheet: '', rows };
}
