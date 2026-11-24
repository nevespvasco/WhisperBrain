'use strict';
// Builds the briefing import fixtures from scratch (nothing downloaded): `node test/fixtures/briefings/make-fixtures.js`
// writes resume.pdf and job.docx next to this file. makePdf / makeDocx are also used by the tests directly.
const fs = require('node:fs');
const path = require('node:path');
const { zip } = require('../../../src/core/zip-writer');

// A minimal valid PDF: one Helvetica (WinAnsi) text object per line, one page per entry of `pages` (each a list of lines).
function makePdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const esc = (s) => Buffer.from(String(s), 'latin1').toString('latin1').replace(/[\\()]/g, (c) => `\\${c}`);
  const kids = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 12 Tf', '72 720 Td', '14 TL'];
    lines.forEach((l, i) => ops.push(`${i ? 'T* ' : ''}(${esc(l)}) Tj`));
    ops.push('ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A minimal Word document: one paragraph per entry; entries starting with "# " use the Heading1 style.
function makeDocx(paras, { title = '' } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const p = (t) => (t.startsWith('# ') ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(t.slice(2))}</w:t></w:r></w:p>` : `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`);
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paras.map(p).join('')}</w:body></w:document>` },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>` },
  ], { now: new Date(2026, 0, 1) });
}

const RESUME_PAGES = [
  ['Vasco Neves - Curriculum Vitae', 'Backend engineer in Lisboa, caf\xe9 regular.', 'Experience', 'Kubernetes operators written in Go. Kubernetes upgrades.'],
  ['Built the payments gateway with PostgreSQL and Kafka.', 'Kafka streams for the payments gateway.', 'Education', 'IST Lisbon, MSc Computer Science'],
];
const JOB_PARAS = ['# Senior Backend Engineer', 'Acme Robotics builds warehouse automation.', 'You will own the fleet scheduler and the telemetry pipeline.',
  'The fleet scheduler talks to every robot. The telemetry pipeline ingests sensor data.', 'Requirements: Kubernetes, PostgreSQL, Terraform.'];

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, 'resume.pdf'), makePdf(RESUME_PAGES));
  fs.writeFileSync(path.join(__dirname, 'job.docx'), makeDocx(JOB_PARAS, { title: 'Senior Backend Engineer' }));
}

module.exports = { makePdf, makeDocx, RESUME_PAGES, JOB_PARAS };
