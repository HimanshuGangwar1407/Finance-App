// Copies what the browser needs to read a picture-only statement PDF (pdf.js to draw the pages, Tesseract to read
// them) into public/vendor, so the app serves them itself. Run after updating those packages: node scripts/vendor-ocr.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = path.join(root, 'public', 'vendor');
const files = {
  'pdf.min.mjs': 'pdfjs-dist/build/pdf.min.mjs',
  'pdf.worker.min.mjs': 'pdfjs-dist/build/pdf.worker.min.mjs',
  'tesseract.min.js': 'tesseract.js/dist/tesseract.min.js',
  'tesseract-worker.min.js': 'tesseract.js/dist/worker.min.js',
  'tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};
fs.mkdirSync(out, { recursive: true });
for (const [name, from] of Object.entries(files)) {
  fs.copyFileSync(nm(from), path.join(out, name));
  console.log(`${name}  ${(fs.statSync(path.join(out, name)).size / 1024).toFixed(0)} KB`);
}
