// Test helper: writes small PDFs — text placed at given positions, optionally locked with a password (the PDF
// standard security handler, revision 2: RC4 with a 40-bit key), or with no text at all (only shapes).
import crypto from 'node:crypto';

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padded = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const esc = (t) => String(t).replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * texts: [[x, y, 'text', size?, degrees?]] in points from the bottom left of an A4-landscape page — or { pages: [texts, …] }.
 * degrees turns the text (a watermark).
 * { password } locks it; { shapesOnly } draws boxes instead of text (like a "printed" picture of a page).
 */
export function makePdf(texts, { password, shapesOnly = false } = {}) {
  const pages = Array.isArray(texts) ? [texts] : texts.pages;
  const contents = pages.map((list) => (shapesOnly
    ? list.map(([x, y, t]) => `${x} ${y} ${String(t).length * 4} 6 re f`).join('\n')
    : list.map(([x, y, t, size = 9, deg = 0]) => {
      const c = Math.cos((deg * Math.PI) / 180).toFixed(4), s = Math.sin((deg * Math.PI) / 180).toFixed(4);
      return `BT /F1 ${size} Tf ${deg ? `${c} ${s} ${-s} ${c}` : '1 0 0 1'} ${x} ${y} Tm (${esc(t)}) Tj ET`;
    }).join('\n')));
  const id = crypto.createHash('md5').update(contents.join('\f')).digest();
  let key = null, encrypt = '';
  if (password) {
    const P = -44, p4 = Buffer.alloc(4); p4.writeInt32LE(P);
    const O = rc4(md5(padded(`${password}-owner`)).subarray(0, 5), padded(password));
    key = md5(padded(password), O, p4, id).subarray(0, 5);
    const U = rc4(key, PAD);
    encrypt = `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`;
  }
  const objKey = (n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  // objects: 1 catalog, 2 page tree, 3 font, then each page (4, 6, …) and its contents (5, 7, …), then the lock
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...contents.flatMap((content, i) => {
      let stream = Buffer.from(content, 'latin1');
      if (key) stream = rc4(objKey(5 + 2 * i), stream);
      return [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
        Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')])];
    }),
    ...(encrypt ? [encrypt] : []),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [];
  let size = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(size); parts.push(b); size += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${encrypt ? ` /Encrypt ${objs.length} 0 R` : ''} /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${size}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref + trailer, 'latin1')]);
}
