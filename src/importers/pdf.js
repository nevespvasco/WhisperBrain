'use strict';
// Text of a PDF, for briefings (a resume, a job description). Text only: no images, no OCR, at most MAX_PAGES pages.
// unpdf (MIT) ships a dependency-free build of Mozilla's pdf.js; it is an ES module, so it is loaded on first use.
const { userError } = require('./parsers');

const MAX_PAGES = 50;

async function pdfToText(buf, { maxPages = MAX_PAGES } = {}) {
  const { getDocumentProxy } = await import('unpdf');
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, stopAtErrors: false });
  } catch (e) {
    throw userError(e?.name === 'PasswordException' ? 'This PDF is password-protected.' : `This PDF can't be opened: ${e?.message || e}.`);
  }
  try {
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const it of items) {
        if (typeof it.str !== 'string') continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(lines.map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }
    return { text: pages.filter(Boolean).join('\n\n'), pages: doc.numPages };
  } finally {
    await Promise.resolve(doc.loadingTask?.destroy?.()).catch(() => {});
  }
}

module.exports = { pdfToText, MAX_PAGES };
