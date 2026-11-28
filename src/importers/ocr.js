'use strict';
// Text from a scanned PDF (pages that are pictures, no text layer). Needs two programs on this computer: pdftoppm (poppler) turns pages into
// images, tesseract reads them. Nothing leaves the computer. Without them the PDF is kept as "no text yet" and the Sources page says what to
// install. Limited to the first pages so one big scan cannot hold the app for long.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_PAGES = 20;
// Pages are rendered into this many pixels on the longest side, whatever size the PDF declares: with -r 150 a crafted 200-inch page
// became a 900-megapixel image (gigabytes of memory and disk). 2200 px is about 200 dpi for an A4/Letter page, plenty for OCR.
const MAX_SIDE_PX = 2200;
const run = (cmd, args, { timeout = 120_000 } = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve({ stdout }))));

// -> { available, reason } (the commands answer --version / -v)
async function available(exec = run) {
  for (const [cmd, args] of [['pdftoppm', ['-v']], ['tesseract', ['--version']]]) {
    try { await exec(cmd, args, { timeout: 5000 }); } catch (e) { if (e.code === 'ENOENT') return { available: false, reason: `${cmd} is not installed` }; }   // some print their version to stderr and exit non-zero: that still means installed
  }
  return { available: true, reason: '' };
}

// buf: the PDF. lang: tesseract languages ("por+eng"). -> the text, or '' when nothing could be read
async function ocrPdf(buf, { lang = 'por+eng', exec = run, pages = MAX_PAGES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ocr-'));
  try {
    const pdf = path.join(dir, 'in.pdf');
    fs.writeFileSync(pdf, buf);
    await exec('pdftoppm', ['-scale-to', String(MAX_SIDE_PX), '-png', '-f', '1', '-l', String(pages), pdf, path.join(dir, 'p')]);
    const pngs = fs.readdirSync(dir).filter((f) => /^p-.*\.png$/.test(f)).sort();
    const out = [];
    for (const f of pngs) {
      const r = await exec('tesseract', [path.join(dir, f), 'stdout', '-l', lang]);
      if (r.stdout.trim()) out.push(r.stdout.trim());
    }
    return out.join('\n\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { ocrPdf, available, run, MAX_PAGES };
