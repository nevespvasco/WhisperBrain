'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { detectKind, parseFile, MAX_TEXT_BYTES } = require('../src/importers');
const { readZip } = require('../src/importers/zip');

const one = (...a) => { const r = parseFile(...a); assert.equal(r.length, 1); return r[0]; };
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = Date.UTC(2026, 0, 1);

// Tiny ZIP writer (stored or deflate). `lie` overrides the declared uncompressed size of an entry (zip-bomb tests).
function makeZip(files, { method = 8, lie = {} } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const usize = lie[name] ?? data.length, crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` : ''}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = (paras, { core = '', styles = '' } = {}) => makeZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${paras.join('')}<w:sectPr/></w:body></w:document>`,
  ...(styles && { 'word/styles.xml': `<w:styles ${W}>${styles}</w:styles>` }),
  ...(core && { 'docProps/core.xml': `<cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">${core}</cp:coreProperties>` }),
});

// ---------- detection ----------
test('detectKind by magic bytes and extension', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
  assert.equal(detectKind('a.wav', wav), 'audio');
  assert.equal(detectKind('renamed.txt', wav), 'audio');
  assert.equal(detectKind('a.mp3', Buffer.from('ID3\x04\x00\x00\x00\x00', 'latin1')), 'audio');
  assert.equal(detectKind('a.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio');
  assert.equal(detectKind('a.ogg', Buffer.from('OggS\x00\x02', 'latin1')), 'audio');
  assert.equal(detectKind('a.flac', Buffer.from('fLaC\x00\x00')), 'audio');
  const ftyp = (brand, extra = '') => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}\x00\x00\x00\x00${extra}`, 'latin1')]);
  assert.equal(detectKind('a.m4a', ftyp('M4A ')), 'audio');
  assert.equal(detectKind('a.mov', ftyp('qt  ')), 'video');
  assert.equal(detectKind('a.mp4', ftyp('isom')), 'video');
  assert.equal(detectKind('voice.mp4', ftyp('isom', 'moov....hdlr\x00\x00\x00\x00\x00\x00\x00\x00soun')), 'audio');
  const ebml = (codec) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`webm....${codec}`)]);
  assert.equal(detectKind('call.webm', ebml('V_VP8')), 'video');
  assert.equal(detectKind('call.webm', ebml('A_OPUS')), 'audio');
  assert.equal(detectKind('notes.txt', Buffer.from('hello')), 'text');
  assert.equal(detectKind('notes.txt', Buffer.from([0xff, 0xfe, 0x68, 0x00])), 'text'); // UTF-16 BOM is not MPEG sync
  assert.equal(detectKind('', Buffer.from('Ana: hi\nBob: hello')), 'text');
  assert.equal(detectKind('doc.pdf', Buffer.from('%PDF-1.7')), 'unsupported');
  assert.equal(detectKind('x.docx', makeZip({ 'a.txt': 'x' })), 'text');
  assert.equal(detectKind('x.zip', makeZip({ 'a.txt': 'x' })), 'unsupported');
  assert.equal(detectKind('blob.bin', Buffer.from([0, 1, 2, 3, 250, 0, 7])), 'unsupported');
  assert.equal(detectKind('clip.mkv'), 'video');
  assert.equal(detectKind('memo.opus'), 'audio');
  assert.equal(detectKind('t.srt'), 'text');
});

// ---------- captions ----------
test('Zoom-style WebVTT with <v> voice tags, cue ids, NOTE/STYLE blocks and inline tags', () => {
  const vtt = `WEBVTT - Zoom export

NOTE This file was exported from a call

STYLE
::cue { color: yellow }

1
00:00:01.200 --> 00:00:04.000 align:start position:0%
<v Ana Silva>Good morning everyone, <i>let's</i> start.</v>

2
00:00:04.500 --> 00:00:06.000
<v Ana Silva>First item is the budget.</v>

3
00:00:07.000 --> 00:00:10.250
<v.loud Bruno Costa>Thanks Ana &amp; welcome.</v>

4
01:00.000 --> 01:02.500
<v Speaker 3>Short-form timings work too.</v>
`;
  const m = one(vtt, 'GMT20240312-140000_Recording.transcript.vtt', { now: NOW });
  assert.equal(m.format, 'vtt');
  assert.equal(m.title, 'Recording');
  assert.equal(m.date, local(2024, 3, 12, 14, 0));
  assert.deepEqual(m.segments.map((s) => [s.label, s.startMs, s.endMs]), [['Ana Silva', 1200, 6000], ['Bruno Costa', 7000, 10250], ['Speaker 3', 60000, 62500]]);
  assert.equal(m.segments[0].text, "Good morning everyone, let's start. First item is the budget.");
  assert.equal(m.segments[1].text, 'Thanks Ana & welcome.');
  assert.ok(m.segments.every((s) => s.speaker === 'them'));
  assert.deepEqual(m.attendees, [{ name: 'Ana Silva', email: '' }, { name: 'Bruno Costa', email: '' }]); // 'Speaker 3' is generic
});

test("Teams-style WebVTT with 'Name: ' prefixes and the me option", () => {
  const vtt = 'WEBVTT\r\n\r\n6d1c3a2e-1/12-0\r\n00:00:00.000 --> 00:00:02.000\r\nMaria Lopes: Can everyone hear me?\r\n\r\n6d1c3a2e-1/13-0\r\n00:00:02.400 --> 00:00:03.900\r\nJoão Costa: Yes, loud and clear.\r\n\r\n6d1c3a2e-1/14-0\r\n00:00:04.000 --> 00:00:06.000\r\nMaria Lopes: Great, let us begin.\r\n';
  const m = one(vtt, 'Team sync.vtt', { me: 'joão costa' });
  assert.deepEqual(m.segments.map((s) => [s.speaker, s.label]), [['them', 'Maria Lopes'], ['me', 'João Costa'], ['them', 'Maria Lopes']]);
  assert.equal(m.segments[1].text, 'Yes, loud and clear.');
  assert.equal(m.title, 'Team sync');
});

test('SRT: numbered cues, comma milliseconds, speaker prefixes, multi-line payloads', () => {
  const srt = `1
00:00:01,000 --> 00:00:03,500
Ana: We shipped the beta
yesterday afternoon.

2
00:00:03,900 --> 00:00:05,000
Ana: Feedback so far is good.

3
00:00:09,000 --> 00:00:11,000
Rui: Any crash reports?
4
00:00:11,500 --> 00:00:12,000
Rui: On Windows?
`;
  const m = one(srt, 'beta-review.srt');
  assert.equal(m.format, 'srt');
  assert.equal(m.title, 'Beta review');
  assert.deepEqual(m.segments.map((s) => [s.label, s.startMs, s.endMs, s.text]), [
    ['Ana', 1000, 5000, 'We shipped the beta yesterday afternoon. Feedback so far is good.'],
    ['Rui', 9000, 12000, 'Any crash reports? On Windows?'],
  ]);
});

// ---------- plain text ----------
test('Otter-style txt: name + timestamp header lines followed by text', () => {
  const txt = `Quarterly planning
March 12, 2024, 10:00AM
45m 12s

Speaker 1  0:03
Okay, let's get going. Thanks everyone for coming.

Lucia Ferreira  0:12
Happy to be here. I have the numbers ready.
Revenue is up eleven percent.

Speaker 1  1:05
Great, walk us through it.
`;
  const m = one(txt, 'otter_export.txt');
  assert.equal(m.title, 'Quarterly planning');
  assert.equal(m.date, local(2024, 3, 12, 10, 0));
  assert.equal(m.body, '');
  assert.deepEqual(m.segments.map((s) => [s.label, s.startMs]), [['Speaker 1', 3000], ['Lucia Ferreira', 12000], ['Speaker 1', 65000]]);
  assert.equal(m.segments[1].text, 'Happy to be here. I have the numbers ready. Revenue is up eleven percent.');
  assert.ok(m.segments[0].endMs <= 12000 && m.segments[1].endMs <= 65000);
  assert.deepEqual(m.attendees.map((a) => a.name), ['Lucia Ferreira']);
});

test('txt layouts: [hh:mm:ss] Name:, hh:mm:ss Name:, and our own **Name** [m:ss] export', () => {
  const a = one('[00:00:05] Ana: Hi Bob.\n[00:00:09] Bob: Hi Ana, ready?\n[00:01:02] Ana: Yes, sharing my screen now.\n', 'a.txt');
  assert.deepEqual(a.segments.map((s) => [s.label, s.startMs]), [['Ana', 5000], ['Bob', 9000], ['Ana', 62000]]);
  const b = one('00:00:05 Ana: Hi Bob.\n00:00:09 Bob: Hi Ana.\n', 'b.txt');
  assert.deepEqual(b.segments.map((s) => [s.label, s.startMs]), [['Ana', 5000], ['Bob', 9000]]);
  const c = one('**Me** [0:00] Hello there\n\n**Carla** [0:04] Hi! Long time.\n\n**Carla** [1:02:03] Much later.\n', 'c.txt');
  assert.deepEqual(c.segments.map((s) => [s.speaker, s.label, s.startMs]), [['me', '', 0], ['them', 'Carla', 4000], ['them', 'Carla', 3723000]]);
});

test('plain notes txt (key: value lines, bullets) stays as body, with date from content', () => {
  const txt = `Product sync
Date: 2024-05-02
Attendees: Ana Silva, Rui Costa

- Launch moved to June
- Need new pricing page
Decision: keep the free tier.
Owner: Rui

Long paragraph about the roadmap that goes on and on without any speaker labels at all.
`;
  const m = one(txt, 'sync.txt');
  assert.equal(m.segments.length, 0);
  assert.ok(m.body.startsWith('Product sync'));
  assert.ok(m.body.includes('- Need new pricing page'));
  assert.equal(m.date, local(2024, 5, 2));
  assert.deepEqual(m.attendees.map((a) => a.name), ['Ana Silva', 'Rui Costa']);
  assert.equal(m.title, 'Sync');
});

test('untimed transcript: synthesized monotonically increasing timings (~150 wpm) and merging', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const m = one(`Ana: ${words(15)}\nAna: ${words(5)}\nBob: ${words(30)}\nAna: ok\n`, 'call.txt');
  assert.deepEqual(m.segments.map((s) => s.label), ['Ana', 'Bob', 'Ana']); // consecutive Ana lines merged
  assert.deepEqual(m.segments.map((s) => [s.startMs, s.endMs]), [[0, 8000], [8000, 20000], [20000, 21000]]);
});

test('merge stops at 1.5 s gaps, speaker changes and 600 chars', () => {
  const long = 'x'.repeat(350);
  const vtt = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Ana>one</v>\n\n00:00:02.400 --> 00:00:03.000\n<v Ana>two</v>\n\n00:00:05.000 --> 00:00:06.000\n<v Ana>three</v>\n\n00:00:06.100 --> 00:00:07.000\n<v Ana>${long}</v>\n\n00:00:07.100 --> 00:00:08.000\n<v Ana>${long}</v>\n`;
  const m = one(vtt, 'm.vtt');
  assert.deepEqual(m.segments.map((s) => [s.text.split(' ')[0], s.text.length, s.startMs, s.endMs]), [['one', 7, 0, 3000], ['three', 356, 5000, 7000], [long, 350, 7100, 8000]]);
});

// ---------- markdown ----------
test('markdown with frontmatter and Summary / Notes / Action items / Transcript sections', () => {
  const md = `---
title: "Design review: onboarding"
date: 2024-04-18T09:30:00Z
attendees:
  - name: Ana Silva
    email: ana@example.com
  - Rui Costa <rui@example.com>
tags: [design, onboarding]
---

# Ignored H1 because frontmatter has a title

## Summary

We agreed to simplify the signup form.

### Key points
- Two steps instead of four

## Notes

Remember to check analytics.

## Action items

- [ ] Draft new form — Ana Silva
- [x] Share metrics @rui
- Book usability test

## Open questions

What about SSO?

## Transcript

**Ana Silva** [0:00] Let's look at the funnel.

**Rui Costa** [0:06] Drop-off is at step three.
`;
  const m = one(md, 'review.md', { me: 'Ana Silva' });
  assert.equal(m.format, 'md');
  assert.equal(m.title, 'Design review: onboarding');
  assert.equal(m.date, Date.UTC(2024, 3, 18, 9, 30));
  assert.deepEqual(m.tags, ['design', 'onboarding']);
  assert.deepEqual(m.attendees, [{ name: 'Ana Silva', email: 'ana@example.com' }, { name: 'Rui Costa', email: 'rui@example.com' }]);
  assert.equal(m.summary, 'We agreed to simplify the signup form.\n\n### Key points\n- Two steps instead of four');
  assert.ok(m.body.includes('Remember to check analytics.'));
  assert.match(m.body, /## Open questions\s+What about SSO\?/);
  assert.ok(!m.body.includes('Ignored H1'));
  assert.deepEqual(m.actionItems, [
    { text: 'Draft new form', owner: 'Ana Silva', done: false },
    { text: 'Share metrics', owner: 'rui', done: true },
    { text: 'Book usability test', owner: '', done: false },
  ]);
  assert.deepEqual(m.segments.map((s) => [s.speaker, s.label, s.startMs]), [['me', 'Ana Silva', 0], ['them', 'Rui Costa', 6000]]);
});

test('re-imports our own Markdown export; a plain markdown document becomes body', () => {
  const ours = '# Kickoff\n\n_2024-02-01T15:00:00.000Z_\n\n**Attendees:** Ana, bob@example.com\n\n## Summary\n\nAll good.\n\n## Notes\n\nmy notes\n\n## Transcript\n\n**Me** [0:00] hi\n\n**Ana** [0:03] hello\n';
  const m = one(ours, 'kickoff.md');
  assert.equal(m.title, 'Kickoff');
  assert.equal(m.date, Date.UTC(2024, 1, 1, 15));
  assert.equal(m.summary, 'All good.');
  assert.equal(m.body, 'my notes');
  assert.deepEqual(m.attendees, [{ name: 'Ana', email: '' }, { name: '', email: 'bob@example.com' }]);
  assert.deepEqual(m.segments.map((s) => s.speaker), ['me', 'them']);
  const plain = one('# Reading list\n\nSome *thoughts* on books.\n\n## Fiction\n\n- Dune\n- [ ] Buy Hyperion\n', '2023-11-05 reading.md');
  assert.equal(plain.title, 'Reading list');
  assert.equal(plain.body, 'Some *thoughts* on books.\n\n## Fiction\n\n- Dune\n- [ ] Buy Hyperion');
  assert.equal(plain.date, local(2023, 11, 5));
  assert.deepEqual(plain.actionItems, [{ text: 'Buy Hyperion', owner: '', done: false }]);
});

// ---------- JSON ----------
test('WhisperBrain backup JSON with 2 notes', () => {
  const backup = {
    app: 'whisperbrain', format: 1, exportedAt: '2024-06-01T00:00:00.000Z',
    spaces: [{ id: 'f1', name: 'Clients' }],
    notes: [
      { id: 'n1', title: 'Client call', body: 'Notes **here**', summary: '## Summary\nGood call', folderId: 'f1', createdAt: 1717000000000,
        attendees: [{ name: 'Ana', email: 'ana@acme.com' }],
        transcript: [
          { speaker: 'me', speakerId: 'm1', startMs: 0, endMs: 1500, text: 'Hi Ana', speakerName: '', label: 'Me' },
          { speaker: 'them', speakerId: 's1', startMs: 1600, endMs: 3000, text: 'Hello!', speakerName: 'Ana', label: 'Ana' },
          { speaker: 'them', speakerId: 's1', startMs: 3100, endMs: 4000, text: 'Shall we?', speakerName: 'Ana', label: 'Ana' },
          { speaker: 'them', speakerId: 's2', startMs: 4200, endMs: 5000, text: 'Yes.', speakerName: '', label: 'Speaker 2' },
        ], speakers: [], chat: [] },
      { id: 'n2', title: 'Idea dump', body: 'just text', summary: '', createdAt: 1716000000000, attendees: [], transcript: [] },
    ],
    templates: [], voices: [], settings: {},
  };
  const r = parseFile(Buffer.from(JSON.stringify(backup)), 'whisperbrain-backup.json');
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Client call');
  assert.equal(r[0].date, 1717000000000);
  assert.equal(r[0].format, 'json');
  assert.deepEqual(r[0].tags, ['Clients']);
  assert.deepEqual(r[0].attendees, [{ name: 'Ana', email: 'ana@acme.com' }]);
  assert.deepEqual(r[0].segments.map((s) => [s.speaker, s.label, s.text]), [['me', '', 'Hi Ana'], ['them', 'Ana', 'Hello!'], ['them', 'Ana', 'Shall we?'], ['them', 'Speaker 2', 'Yes.']]);
  assert.equal(r[1].body, 'just text');
  // a single exported note object works too
  assert.equal(one(JSON.stringify(backup.notes[1]), 'note.json').title, 'Idea dump');
});

test('Whisper JSON (seconds) and AssemblyAI-style utterances (ms)', () => {
  const whisper = { text: ' Hello there. General Kenobi.', language: 'en', segments: [
    { id: 0, seek: 0, start: 0.0, end: 2.48, text: ' Hello there.' },
    { id: 1, seek: 0, start: 5.2, end: 7.0, text: ' General Kenobi.' },
  ] };
  const w = one(JSON.stringify(whisper), 'standup.json');
  assert.deepEqual(w.segments.map((s) => [s.label, s.startMs, s.endMs, s.text]), [['', 0, 2480, 'Hello there.'], ['', 5200, 7000, 'General Kenobi.']]);
  assert.deepEqual(w.attendees, []);
  const aai = { id: 'abc', status: 'completed', text: 'Hi. Hello. How are you?', utterances: [
    { speaker: 'A', start: 250, end: 1200, confidence: 0.9, text: 'Hi.', words: [] },
    { speaker: 'B', start: 1500, end: 2100, text: 'Hello.' },
    { speaker: 'B', start: 2300, end: 3900, text: 'How are you?' },
  ] };
  const a = one(JSON.stringify(aai), 'call.json', { me: 'Speaker A' });
  assert.deepEqual(a.segments.map((s) => [s.speaker, s.label, s.startMs, s.endMs, s.text]), [
    ['me', 'Speaker A', 250, 1200, 'Hi.'], ['them', 'Speaker B', 1500, 3900, 'Hello. How are you?'],
  ]);
  assert.deepEqual(a.attendees, []); // generic labels only
});

test('Deepgram-style results.utterances and word-level output', () => {
  const dg = { metadata: { created: '2024-07-09T08:00:00Z' }, results: { channels: [{ alternatives: [{ transcript: 'x' }] }], utterances: [
    { start: 0.08, end: 1.5, speaker: 0, transcript: 'Morning.' }, { start: 2.0, end: 3.2, speaker: 1, transcript: 'Hey there.' },
  ] } };
  const d = one(JSON.stringify(dg), 'dg.json');
  assert.equal(d.date, Date.UTC(2024, 6, 9, 8));
  assert.deepEqual(d.segments.map((s) => [s.label, s.startMs, s.text]), [['Speaker 1', 80, 'Morning.'], ['Speaker 2', 2000, 'Hey there.']]);
  const words = { results: { channels: [{ alternatives: [{ words: [
    { word: 'hello', punctuated_word: 'Hello', start: 0.1, end: 0.4, speaker: 0 }, { word: 'all', punctuated_word: 'all.', start: 0.5, end: 0.8, speaker: 0 },
    { word: 'hi', punctuated_word: 'Hi!', start: 1.2, end: 1.4, speaker: 1 },
  ] }] }] } };
  assert.deepEqual(one(JSON.stringify(words), 'w.json').segments.map((s) => [s.label, s.text]), [['Speaker 1', 'Hello all.'], ['Speaker 2', 'Hi!']]);
});

// ---------- docx ----------
test('docx built in-test: headings, tabs, breaks, core properties, transcript heuristics', () => {
  const notes = docx([
    para('Roadmap review', 'Title'),
    para('Agreed items', 'Kop2'),
    '<w:p><w:r><w:t>Ship</w:t></w:r><w:r><w:tab/><w:t>v2</w:t></w:r><w:r><w:br/><w:t xml:space="preserve">in Q3 &amp; hire</w:t></w:r></w:p>',
    '<w:p/>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>',
  ], {
    styles: '<w:style w:type="paragraph" w:styleId="Kop2"><w:name w:val="heading 2"/></w:style>',
    core: '<dc:title>Stale title</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">2024-09-03T13:00:00Z</dcterms:created>',
  });
  const m = one(notes, 'roadmap.docx');
  assert.equal(m.format, 'docx');
  assert.equal(m.title, 'Roadmap review');
  assert.equal(m.date, Date.UTC(2024, 8, 3, 13));
  assert.equal(m.body, '## Agreed items\n\nShip\tv2\nin Q3 & hire\n\n- First bullet');
  // Teams-style transcript document: preamble + "Name   0:03" headers
  const teams = docx([para('Weekly standup'), para('Transcript'), para('September 4, 2024, 9:00AM'), para('Ana Silva\t0:03'), para('Morning all.'), para('Rui Costa\t0:09'), para('Morning!')],
    { core: '<dc:title></dc:title>' });
  const t = one(teams, 'Weekly standup transcript.docx');
  assert.equal(t.title, 'Weekly standup');
  assert.equal(t.date, local(2024, 9, 4, 9, 0));
  assert.deepEqual(t.segments.map((s) => [s.label, s.startMs, s.text]), [['Ana Silva', 3000, 'Morning all.'], ['Rui Costa', 9000, 'Morning!']]);
  assert.equal(one(docx([para('Just one line of text')], {}), 'x.docx').body, 'Just one line of text');
});

test('docx errors: not a zip, missing document.xml, zip bomb caps', () => {
  assert.throws(() => parseFile(Buffer.from('this is not a zip at all'), 'fake.docx'), /not supported|can't be opened/);
  assert.throws(() => parseFile(makeZip({ 'hello.txt': 'hi' }), 'odd.docx'), /word\/document\.xml is missing/);
  // declared size over the 100 MB cap: refused before inflating anything
  assert.throws(() => parseFile(makeZip({ 'word/document.xml': '<w:p/>' }, { lie: { 'word/document.xml': 150 * 1048576 } }), 'big.docx'), /too large when uncompressed/);
  // header lies (claims tiny, inflates to 5 MB): inflation stops at the declared size
  const bomb = makeZip({ 'word/document.xml': Buffer.alloc(5 * 1048576, 0x20) }, { lie: { 'word/document.xml': 1000 } });
  assert.ok(bomb.length < 20000);
  assert.throws(() => parseFile(bomb, 'bomb.docx'), /zip bomb/);
  // honest but over the budget
  const big = makeZip({ 'a.bin': Buffer.alloc(3 * 1048576) });
  assert.throws(() => readZip(big, { maxTotal: 1048576 }), /too large/);
  assert.equal(readZip(big).read('a.bin').length, 3 * 1048576);
  assert.equal(readZip(makeZip({ 's.txt': 'stored' }, { method: 0 })).read('s.txt').toString(), 'stored');
  const enc = makeZip({ 'word/document.xml': '<w:p/>' });
  enc.writeUInt16LE(0x801, enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8); // set the encrypted flag in the central directory
  assert.throws(() => parseFile(enc, 'locked.docx'), /encrypted/);
});

// ---------- html / csv ----------
test('html: scripts/styles stripped, entities decoded, headings and breaks kept', () => {
  const html = `<!DOCTYPE html><html><head><title>Ignored &amp; head</title><style>p{color:red}</style></head><body>
  <script>alert("x")</script>
  <h1>Partner&nbsp;meeting</h1>
  <p>Met with <b>Acme</b> on 14 March 2024.
     Discussed pricing &ndash; they want &euro;10.</p>
  <ul><li>Follow up</li><li>Send contract</li></ul>
  <p>Line one<br>Line two</p></body></html>`;
  const m = one(html, 'page.html');
  assert.equal(m.format, 'html');
  assert.equal(m.title, 'Partner meeting');
  assert.equal(m.date, local(2024, 3, 14));
  assert.equal(m.body, 'Met with Acme on 14 March 2024. Discussed pricing – they want €10.\n\n- Follow up\n- Send contract\n\nLine one\nLine two');
  const tr = one('<html><head><title>Chat log</title></head><body><p><b>Ana:</b> Hi there</p><p><b>Bob:</b> Hello &amp; welcome</p></body></html>', 'log.htm');
  assert.equal(tr.title, 'Chat log');
  assert.deepEqual(tr.segments.map((s) => [s.label, s.text]), [['Ana', 'Hi there'], ['Bob', 'Hello & welcome']]);
});

test('csv: header mapping, RFC 4180 quoting, timestamps', () => {
  const csv = 'Speaker,Start Time,End Time,Transcript\r\n"Costa, Rui",00:00:01.000,00:00:03.000,"He said ""ship it"", then left"\r\nAna,00:00:05,00:00:07,"Multi\r\nline answer"\r\n';
  const m = one(csv, 'export.csv');
  assert.equal(m.format, 'csv');
  assert.deepEqual(m.segments.map((s) => [s.label, s.startMs, s.endMs, s.text]), [
    ['Costa, Rui', 1000, 3000, 'He said "ship it", then left'], ['Ana', 5000, 7000, 'Multi line answer'],
  ]);
  const secs = one('name;start;end;text\nAna;1.5;3;hello\nBob;4;6.25;hi\n', 's.csv');
  assert.deepEqual(secs.segments.map((s) => [s.startMs, s.endMs]), [[1500, 3000], [4000, 6250]]);
  assert.throws(() => parseFile('a,b\n1,2\n', 'bad.csv'), /no text column/);
});

// ---------- edge cases ----------
test('BOM, CRLF and UTF-16 input', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n<v Ana>Olá\r\n')]);
  const m = one(bom, 'bom.vtt');
  assert.deepEqual(m.segments.map((s) => [s.label, s.text]), [['Ana', 'Olá']]);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ana: olá\r\nBob: tudo bem?\r\n', 'utf16le')]);
  assert.deepEqual(one(u16, 'u16.txt').segments.map((s) => s.label), ['Ana', 'Bob']);
  const md = one('---\r\ntitle: CRLF doc\r\ntags: a, b\r\n---\r\n\r\nBody line\r\n', 'crlf.md');
  assert.equal(md.title, 'CRLF doc');
  assert.deepEqual(md.tags, ['a', 'b']);
  assert.equal(md.body, 'Body line');
});

test('pasted text without a filename is sniffed', () => {
  const vtt = parseFile('WEBVTT\n\n00:00.000 --> 00:01.000\nhi', '');
  assert.equal(vtt[0].format, 'vtt');
  assert.equal(vtt[0].title, 'Imported note');
  assert.equal(parseFile('{"segments":[{"start":0,"end":1.5,"text":"yo"}]}', '')[0].format, 'json');
  assert.equal(parseFile('Ana: hi\nBob: hey\n', '')[0].segments.length, 2);
});

test('user-friendly errors: empty, whitespace, garbage binary, unsupported, pdf, audio, too large, bad json', () => {
  assert.throws(() => parseFile(Buffer.alloc(0), 'empty.txt'), /empty/);
  assert.throws(() => parseFile('  \n\n ', 'blank.md'), /empty/);
  const garbage = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256));
  assert.throws(() => parseFile(garbage, 'garbage.bin'), /not supported/);
  assert.throws(() => parseFile(garbage, 'garbage.txt'), /doesn't look like text/);
  assert.throws(() => parseFile(garbage, 'garbage.json'), /doesn't look like text/);
  assert.throws(() => parseFile(Buffer.from('%PDF-1.4 ...'), 'paper.pdf'), { message: 'PDF import is not supported yet — export the document as .docx, .txt or .md' });
  assert.throws(() => parseFile(Buffer.from('ID3\x03\x00\x00\x00', 'latin1'), 'song.mp3'), /audio file/);
  assert.throws(() => parseFile(Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61), 'huge.txt'), /too large/);
  assert.throws(() => parseFile('{"segments": [', 'cut.json'), /not valid JSON/);
  assert.throws(() => parseFile('{"foo": 1}', 'other.json'), /Unrecognised JSON/);
  assert.throws(() => parseFile('WEBVTT\n\nNOTE nothing here\n', 'nocues.vtt'), /No captions/);
  try { parseFile(Buffer.alloc(0), 'x.txt'); } catch (e) { assert.equal(e.code, 'EIMPORT'); }
});

test('dates: filename fallback, future dates rejected, title prettified', () => {
  const m = one('Ana: hello\nBob: hi\n', '2024_01_15-client_kickoff.txt', { now: NOW });
  assert.equal(m.title, 'Client kickoff');
  assert.equal(m.date, local(2024, 1, 15));
  const n = one('Ana: hello\nBob: hi\n', 'client kickoff 2024-01-15.txt', { now: NOW });
  assert.equal(n.title, 'Client kickoff');
  assert.equal(n.date, local(2024, 1, 15));
  assert.equal(one('---\ndate: 2099-01-01\n---\nhello', 'future.md', { now: NOW }).date, null);
  assert.equal(one('notes from 03/04/2024 meeting', 'd.txt').date, local(2024, 4, 3)); // day-first
});
