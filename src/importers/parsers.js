'use strict';
const { readZip } = require('./zip');

// Every parser returns partial meetings: { title, date, attendees, body, summary, cues, actionItems, tags, format? }.
// Cues are raw ({ label, startMs|null, endMs|null, text, speaker? }); index.js normalises, merges and times them.
const blank = () => ({ title: '', date: null, attendees: [], body: '', summary: '', cues: [], actionItems: [], tags: [] });

// ---------- text helpers ----------
const clean = (s) => String(s ?? '').replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const tidy = (s) => String(s ?? '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
const mdInline = (s) => clean(String(s).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`)/g, ''));
const userError = (msg) => Object.assign(new Error(msg), { code: 'EIMPORT' });

// UTF-8 (with or without BOM), UTF-16 with BOM, or Latin-1 when the bytes are not UTF-8 at all. Refuses binary.
function decodeText(buf) {
  let s;
  if (buf[0] === 0xff && buf[1] === 0xfe) s = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) s = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le');
  else {
    s = buf.toString('utf8');
    if (s.includes('\ufffd') && !buf.includes(0) && !/[\u0080-\ufffc]/.test(s)) s = buf.toString('latin1'); // e.g. Windows-1252 export
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const head = s.slice(0, 16384);
  const ctrl = (head.match(/[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/g) || []).length;
  if (ctrl > Math.max(2, head.length * 0.01)) throw userError("This file doesn't look like text — it may be binary or corrupt.");
  return s.replace(/\r\n?/g, '\n');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', lrm: '', rlm: '', zwj: '', zwnj: '', shy: '',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', deg: '°', times: '×', szlig: 'ß', aelig: 'æ', oslash: 'ø', Oslash: 'Ø' };
for (const [acc, mark] of Object.entries({ acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327', ring: '\u030a' })) {
  for (const l of 'aeiouyncAEIOUYNC') { const ch = (l + mark).normalize('NFC'); if (ch.length === 1) ENT[l + acc] = ch; }
}
const fromCp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
const decodeEntities = (s) => String(s).replace(/&(#x[\da-f]+|#\d+|[a-z]+\d*);/gi, (m, e) =>
  e[0] === '#' ? fromCp(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? ENT[e.toLowerCase()] ?? m);
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ''));

// ---------- timestamps & dates ----------
const TS = String.raw`(?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?`;
function parseTs(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return null;
  return ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + (m[4] ? Math.round(+`0.${m[4]}` * 1000) : 0);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function monthOf(word) {
  const w = word.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.findIndex((m) => m === w || (w.length === 3 && m.startsWith(w)) || (w === 'sept' && m === 'september'));
  return i < 0 ? 0 : (i % 12) + 1;
}
function mkDate(y, mo, d, h = 0, mi = 0, s = 0, zone) {
  [y, mo, d, h, mi, s] = [y, mo, d, h, mi, s].map(Number);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const local = new Date(y, mo - 1, d, h, mi, s);
  if (local.getMonth() !== mo - 1 || local.getDate() !== d) return null; // 31 Feb etc.
  if (!zone) return local.getTime();
  const off = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (+zone.slice(1, 3) * 60 + +zone.slice(-2));
  return Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000;
}
const hour12 = (h, ap) => (!ap ? +h : (+h % 12) + (/p/i.test(ap) ? 12 : 0));

// First date in a string → { ms, index, length } or null. `compact` also accepts 20240312 (filenames, e.g. Zoom's GMT20240312-140000).
function findDate(str, { compact = false } = {}) {
  const s = String(str ?? '');
  const found = [];
  const add = (m, ms) => { if (m && ms != null) found.push({ ms, index: m.index, length: m[0].length }); };
  let m;
  const MW = '([A-Za-zçÇ]{3,9}\\.?)';
  const TIME = String.raw`(?:,?\s*(?:at|às|as|@)?\s*(\d{1,2})[:h](\d{2})\s*([AaPp]\.?[Mm]\.?)?)?`;
  m = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?(?!\d)/.exec(s);
  if (m) add(m, mkDate(m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0, m[7] && m[7].replace(':', '')));
  m = new RegExp(String.raw`(?<!\d)(\d{1,2})(?:st|nd|rd|th|º)?\s+(?:de\s+)?${MW},?\s+(?:de\s+)?(\d{4})${TIME}`, 'i').exec(s);
  if (m && monthOf(m[2])) add(m, mkDate(m[3], monthOf(m[2]), m[1], hour12(m[4] || 0, m[6]), m[5] || 0));
  m = new RegExp(String.raw`\b${MW}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})${TIME}`, 'i').exec(s);
  if (m && monthOf(m[1])) add(m, mkDate(m[3], monthOf(m[1]), m[2], hour12(m[4] || 0, m[6]), m[5] || 0));
  m = /(?<![\d/.])(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?!\d)/.exec(s); // day-first unless that is impossible
  if (m) add(m, +m[2] > 12 ? mkDate(m[3], m[1], m[2]) : mkDate(m[3], m[2], m[1]));
  if (compact) {
    m = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?:[-_T ]?(\d{2})(\d{2})(\d{2})?)?(?!\d)/.exec(s);
    if (m) add(m, mkDate(m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0));
    m = /(?<!\d)((?:19|20)\d{2})[_.](\d{1,2})[_.](\d{1,2})(?!\d)/.exec(s);
    if (m) add(m, mkDate(m[1], m[2], m[3]));
  }
  return found.sort((a, b) => a.index - b.index)[0] || null;
}

// Any date-ish value (epoch s/ms number, ISO string, prose) → ms or null.
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? Math.round(v) : v > 1e8 ? Math.round(v * 1000) : null;
  if (/^\d{9,13}$/.test(String(v).trim())) return toMs(+v);
  return findDate(String(v))?.ms ?? null;
}

// ---------- people ----------
// Labels that look like "Name:" but are really note keys.
const NOT_NAMES = new Set(['agenda', 'note', 'notes', 'date', 'time', 'when', 'where', 'location', 'subject', 'title', 'topic', 're', 'fw', 'fwd',
  'to', 'from', 'cc', 'bcc', 'summary', 'decision', 'decisions', 'next steps', 'action', 'actions', 'action items', 'action item', 'todo', 'to do',
  'to-do', 'status', 'owner', 'link', 'links', 'url', 'email', 'phone', 'tel', 'duration', 'meeting', 'goal', 'goals', 'outcome', 'outcomes',
  'background', 'context', 'question', 'answer', 'q', 'a', 'tip', 'warning', 'important', 'update', 'updates', 'deadline', 'ps', 'nb', 'example',
  'error', 'info', 'source', 'tags', 'attendees', 'participants', 'present', 'absent', 'minutes', 'objective', 'objectives', 'purpose', 'result',
  'results', 'reminder', 'follow-up', 'follow up', 'project', 'budget', 'cost', 'price', 'total', 'risks', 'risk', 'issue', 'issues', 'blockers',
  'pros', 'cons', 'step', 'idea', 'ideas', 'key points', 'takeaways', 'description', 'name', 'role', 'company', 'address', 'website', 'type',
  'data', 'hora', 'local', 'assunto', 'notas', 'resumo', 'participantes', 'tarefas', 'decisões', 'próximos passos', 'objetivo', 'nota', 'tema']);
const NAME = String.raw`[\p{Lu}\p{Lt}][\p{L}\p{M}'’.\-]*(?:[ \t]+[\p{L}\p{M}\p{N}'’.\-]+){0,4}(?:[ \t]+\([^()\n]{1,30}\))?`;
const isName = (s) => { const t = clean(s); return t.length > 0 && t.length <= 50 && !NOT_NAMES.has(t.toLowerCase()) && !/^\d/.test(t); };

// "Ana Silva <ana@x.com>", "ana@x.com", { name, email }, { displayName, emailAddress } → { name, email }
function person(v) {
  if (!v) return null;
  if (typeof v === 'object') {
    const name = clean(v.name ?? v.displayName ?? v.display_name ?? v.fullName ?? '');
    const email = clean(typeof v.email === 'string' ? v.email : v.emailAddress?.address ?? v.emailAddress ?? v.mail ?? '');
    return name || email ? { name, email } : null;
  }
  const s = clean(String(v).replace(/^@/, ''));
  const m = /^(.*?)\s*[<(\[]\s*([^\s<>()@]+@[^\s<>()]+)\s*[>)\]]$/.exec(s);
  if (m) return { name: clean(m[1].replace(/^["']|["']$/g, '')), email: m[2] };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { name: '', email: s };
  return s ? { name: s.replace(/^["']|["']$/g, ''), email: '' } : null;
}
const splitPeople = (s) => String(s).split(/\s*[,;]\s*|\s+(?:and|e|&)\s+/).map(person).filter(Boolean);
const peopleList = (v) => (Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? splitPeople(x) : [person(x)])) : typeof v === 'string' ? splitPeople(v) : []).filter(Boolean);
const tagList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map((t) => clean(String(t)).replace(/^#/, '')).filter(Boolean);

// ---------- captions: WebVTT / SRT ----------
const ARROW = new RegExp(String.raw`(${TS})\s*-->\s*(${TS})`);
function parseCues(text) {
  const lines = text.split('\n');
  const raw = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = ARROW.exec(line);
    if (m) { cur = { startMs: parseTs(m[1]), endMs: parseTs(m[2]), lines: [] }; raw.push(cur); continue; }
    if (!line) { cur = null; continue; } // blank line ends a cue; ids, NOTE/STYLE/REGION blocks and the header are skipped
    if (cur && /^\d+$/.test(line) && ARROW.test(lines[i + 1] || '')) { cur = null; continue; } // SRT without blank separators
    if (cur) cur.lines.push(line);
  }
  const cues = [];
  for (const c of raw) {
    const payload = c.lines.join('\n');
    const voices = [...payload.matchAll(/<v(?:\.[\w.-]+)?\s+([^>]+)>([\s\S]*?)(?=<v[\s.]|$)/g)];
    if (voices.length) { for (const v of voices) cues.push({ label: clean(stripTags(v[1])), startMs: c.startMs, endMs: c.endMs, text: stripTags(v[2]) }); continue; }
    let text = clean(stripTags(payload)).replace(/^(?:>>|-)\s*/, '');
    let label = '';
    const nm = new RegExp(String.raw`^(${NAME})\s*:\s+(.+)$`, 'u').exec(text);
    if (nm && isName(nm[1])) { label = nm[1]; text = nm[2]; }
    cues.push({ label, startMs: c.startMs, endMs: c.endMs, text });
  }
  return cues;
}
const cueLike = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  const arrows = lines.filter((l) => ARROW.test(l)).length;
  return arrows > 0 && arrows >= lines.length * 0.2;
};

// ---------- plain-text transcripts ----------
const RX = {
  ours: new RegExp(String.raw`^\*\*([^*]{1,60})\*\*\s*\[(${TS})\]\s*(.*)$`, 'u'), // **Ana** [1:02] text (our Markdown export)
  bold: /^\*\*([^*]{1,60}?)(?::\*\*|\*\*:)\s+(.+)$/u, // **Ana:** text
  tsName: new RegExp(String.raw`^[\[(]?(${TS})[\])]?\s*(?:[-–—|]\s*)?(${NAME})\s*:\s+(.*)$`, 'u'), // [00:01:02] Ana: text
  header: new RegExp(String.raw`^(${NAME})\s*(?:\(\s*(${TS})\s*\)|[|–—-]?\s+(${TS}))\s*:?$`, 'u'), // Ana (00:12):  /  Ana  0:12
  tsOnly: new RegExp(String.raw`^(?:[\[(](${TS})[\])]|(\d{1,3}:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?))\s*(?:[-–—|]\s*)?(.+)$`, 'u'), // [00:01:02] text
  name: new RegExp(String.raw`^(${NAME})\s*:\s+(.+)$`, 'u'), // Ana: text
};
function matchLine(line) {
  let m;
  if ((m = RX.ours.exec(line))) return { label: m[1], ts: parseTs(m[2]), text: m[3] };
  if ((m = RX.tsName.exec(line)) && isName(m[2])) return { label: m[2], ts: parseTs(m[1]), text: m[3] };
  if ((m = RX.header.exec(line)) && isName(m[1])) return { label: m[1], ts: parseTs(m[2] || m[3]), text: '', header: true };
  if ((m = RX.tsOnly.exec(line))) return { label: '', ts: parseTs(m[1] || m[2]), text: m[3] };
  if ((m = RX.bold.exec(line)) && isName(m[1])) return { label: m[1], ts: null, text: m[2] };
  if ((m = RX.name.exec(line)) && isName(m[1])) return { label: m[1], ts: null, text: m[2] };
  return null;
}
// Lines before the first speaker line come back as `pre`; unmatched lines after one continue that cue.
function scanTranscript(text) {
  const cues = [], pre = [];
  let nonEmpty = 0, hits = 0, cur = null, inHeader = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { if (!cur) pre.push(''); continue; }
    nonEmpty++;
    const m = matchLine(line);
    if (m) { hits++; cur = { label: m.label, startMs: m.ts, endMs: null, text: m.text }; cues.push(cur); inHeader = !!m.header; continue; }
    if (cur) { if (inHeader) hits++; cur.text += ' ' + line; } else pre.push(raw);
  }
  return { cues, pre, hits, ratio: nonEmpty ? hits / nonEmpty : 0 };
}
// Transcript cues if the text looks like one (≥ 30% transcript lines), else null. `force` for a '## Transcript' section.
function transcriptOf(text, force = false) {
  if (cueLike(text)) return { cues: parseCues(text), pre: [] };
  const t = scanTranscript(text);
  if (force) return t.cues.length ? t : { cues: text.split('\n').filter((l) => l.trim()).map((l) => ({ label: '', startMs: null, endMs: null, text: l })), pre: [] };
  // untimed "Key: value" notes look like speaker lines, but real conversations repeat speakers
  const named = t.cues.filter((c) => c.label && c.startMs == null);
  if (named.length >= 3 && new Set(named.map((c) => c.label.toLowerCase())).size === named.length) return null;
  return t.hits >= 2 && t.ratio >= 0.3 ? t : null;
}

// ---------- Markdown-ish documents (also used for .txt / .docx / .html after conversion) ----------
function splitFrontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  return m ? { data: parseYaml(m[1]), rest: text.slice(m[0].length) } : { data: {}, rest: text };
}
// Small YAML subset: `key: value`, `key: [a, b]`, block lists, and lists of flat maps (`- name: Ana` / `  email: …`).
function parseYaml(src) {
  const data = {};
  let key = null, item = null;
  for (const raw of src.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const top = !/^\s/.test(raw), line = raw.trim();
    let m;
    if (top && (m = /^([^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(line))) { key = m[1].toLowerCase(); item = null; data[key] = m[2] == null || m[2] === '' ? [] : scalar(m[2]); continue; }
    if (!key) continue;
    if ((m = /^-\s*(.*)$/.exec(line))) {
      if (!Array.isArray(data[key])) data[key] = [];
      const kv = /^([\w-]+)\s*:\s+(.*)$/.exec(m[1]);
      if (kv) { item = { [kv[1].toLowerCase()]: scalar(kv[2]) }; data[key].push(item); } else { item = null; data[key].push(scalar(m[1])); }
    } else if (item && (m = /^([\w-]+)\s*:\s*(.*)$/.exec(line))) item[m[1].toLowerCase()] = scalar(m[2]);
  }
  return data;
}
function scalar(v) {
  v = String(v).trim();
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(scalar);
  if (/^"(.*)"$/.test(v)) return v.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
  if (/^'(.*)'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^(~|null)$/i.test(v)) return null;
  return v;
}
function applyMeta(out, d) {
  const first = (...ks) => { for (const k of ks) if (d[k] != null && d[k] !== '' && !(Array.isArray(d[k]) && !d[k].length)) return d[k]; };
  const title = first('title', 'name', 'subject', 'meeting');
  if (title != null && typeof title !== 'object') out.title = clean(title);
  const date = first('date', 'created', 'created_at', 'createdat', 'start', 'started', 'when', 'datetime');
  if (date != null) out.date = toMs(date);
  out.attendees.push(...peopleList(first('attendees', 'participants', 'people', 'invitees', 'guests') ?? []));
  out.tags.push(...tagList(first('tags', 'tag', 'keywords', 'labels') ?? []));
}

const SECTIONS = [
  ['summary', /^(summary|tl;?dr|meeting summary|executive summary|overview|resumo|sumário)$/i],
  ['notes', /^(notes|my notes|meeting notes|notas|apontamentos)$/i],
  ['transcript', /^(transcript|transcription|full transcript|transcrição|transcricao)$/i],
  ['actions', /^(action items?|actions?|next steps|to-?dos?|tasks|follow-?ups?|tarefas|ações|acoes|próximos passos)$/i],
  ['attendees', /^(attendees|participants|participantes|people)$/i],
];
const sectionKind = (h) => { const t = mdInline(h).replace(/^[^\p{L}\p{N}]+|[\s:]+$/gu, ''); return SECTIONS.find(([, rx]) => rx.test(t))?.[0] || null; };

// "- [x] Send deck — Ana", "- [ ] Book room @bob", "- Ana: review budget"
function parseAction(line, { requireBox = false } = {}) {
  const m = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.+)$/.exec(line);
  if (!m || (requireBox && m[1] == null)) return null;
  let text = m[2].trim(), owner = '', o;
  if ((o = /\s+(?:[—–]|--)\s+([^—–]+?)\s*$/.exec(text))) { owner = o[1]; text = text.slice(0, o.index); }
  else if ((o = /(?:^|\s)\(?@([\p{L}\p{N}._-]+)\)?/u.exec(text))) { owner = o[1]; text = `${text.slice(0, o.index)} ${text.slice(o.index + o[0].length)}`; }
  else if ((o = /^\*\*([^*]{1,40}?):?\*\*:?\s+/.exec(text)) || ((o = new RegExp(String.raw`^(${NAME}):\s+`, 'u').exec(text)) && isName(o[1]))) { owner = o[1]; text = text.slice(o[0].length); }
  text = mdInline(text);
  return text ? { text, owner: mdInline(owner).replace(/^@/, ''), done: /x/i.test(m[1] || '') } : null;
}

// Transcript preamble (Teams/Otter exports): first short line → title, date lines → date, "Transcript" / "52m 3s" dropped.
function digestPreamble(out, pre) {
  const keep = [];
  for (const raw of pre) {
    const l = raw.trim();
    if (!l) { keep.push(''); continue; }
    if (/^(transcript|transcription|captions?|subtitles?)$/i.test(l) || /^(\d+\s*[hms]\s*)+$/i.test(l)) continue;
    const d = findDate(l);
    if (d && l.length - d.length < 20) { if (out.date == null) out.date = d.ms; continue; }
    if (!out.title && !keep.some(Boolean) && l.length <= 80 && !/[.!?]$/.test(l)) { out.title = mdInline(l.replace(/^#+\s*/, '')); continue; }
    keep.push(raw);
  }
  return tidy(keep.join('\n'));
}

function parseDoc(text, { frontmatter = false } = {}) {
  const out = blank();
  if (frontmatter) { const fm = splitFrontmatter(text); text = fm.rest; applyMeta(out, fm.data); }
  let lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^#\s+\S/.test(lines[first].trim())) { const t = mdInline(lines[first].trim().slice(1)); if (!out.title) out.title = t; lines.splice(first, 1); }
  // header lines of our own Markdown export are metadata, not notes; generic "Date:" / "Attendees:" lines are read but kept
  lines = lines.filter((l, i) => {
    if (i > 15) return true;
    const t = l.trim();
    let m;
    if ((m = /^_(\d{4}-\d{2}-\d{2}T[^_]+)_$/.exec(t))) { if (out.date == null) out.date = toMs(m[1]); return false; }
    if ((m = /^\*\*(?:attendees|participants):\*\*\s*(.+)$/i.exec(t))) { out.attendees.push(...splitPeople(m[1])); return false; }
    if ((m = /^_space:\s*(.+)_$/i.exec(t))) { out.tags.push(clean(m[1])); return false; }
    if ((m = /^(?:\*\*)?(?:date|when|data)(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/i.exec(t)) && out.date == null) out.date = toMs(m[1]);
    if ((m = /^(?:\*\*)?(?:attendees|participants|participantes|present)(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/i.exec(t))) out.attendees.push(...splitPeople(m[1]));
    if ((m = /^(?:\*\*)?tags(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/i.exec(t))) out.tags.push(...tagList(m[1]));
    return true;
  });
  // sections: '##'/'###' headings; deeper headings stay inside a recognised section
  const parts = [{ kind: null, head: null, level: 0, lines: [] }];
  for (const l of lines) {
    const h = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(l.trim());
    const cur = parts[parts.length - 1];
    if (h && !(cur.kind && h[1].length > cur.level)) { const kind = h[1].length <= 3 ? sectionKind(h[2]) : null; parts.push({ kind, head: l, level: h[1].length, lines: [] }); }
    else cur.lines.push(l);
  }
  const body = [], summary = [];
  if (parts.some((p) => p.kind)) {
    for (const p of parts) {
      const txt = p.lines.join('\n');
      if (p.kind === 'summary') summary.push(txt);
      else if (p.kind === 'notes') body.push(txt);
      else if (p.kind === 'transcript') out.cues.push(...transcriptOf(txt, true).cues);
      else if (p.kind === 'actions') for (const l of p.lines) { const a = parseAction(l); if (a) out.actionItems.push(a); }
      else if (p.kind === 'attendees') for (const l of p.lines) out.attendees.push(...splitPeople(l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').trim()));
      else body.push(p.head ? `${p.head}\n${txt}` : txt);
    }
  } else {
    const all = lines.join('\n');
    const tr = transcriptOf(all);
    if (tr) { out.cues = tr.cues; body.push(digestPreamble(out, tr.pre)); } else body.push(all);
  }
  out.body = tidy(body.join('\n\n'));
  out.summary = tidy(summary.join('\n\n'));
  if (!parts.some((p) => p.kind === 'actions')) for (const l of out.body.split('\n')) { const a = parseAction(l, { requireBox: true }); if (a) out.actionItems.push(a); }
  return out;
}

// .txt / pasted text / converted .docx and .html
function parseText(text, { frontmatter = false } = {}) {
  if (/^WEBVTT/.test(text.trimStart()) || cueLike(text)) return [{ ...blank(), cues: parseCues(text) }];
  return [parseDoc(text, { frontmatter })];
}

// ---------- JSON ----------
const isWbNote = (o) => o && typeof o === 'object' && !Array.isArray(o) && typeof o.title === 'string' && ('body' in o || 'summary' in o) && ('createdAt' in o || Array.isArray(o.transcript));
function fromWbNote(n, spaces = {}) {
  const segs = Array.isArray(n.transcript) ? n.transcript : Array.isArray(n.segments) ? n.segments : [];
  const tags = tagList(n.tags || []);
  if (n.folderId && spaces[n.folderId]) tags.push(spaces[n.folderId]);
  return {
    ...blank(), title: clean(n.title), date: toMs(n.createdAt ?? n.startedAt ?? n.eventStart), attendees: peopleList(n.attendees || []),
    body: String(n.body || ''), summary: String(n.summary || ''), tags, format: 'json', keep: !!clean(n.title), noMerge: true,
    actionItems: (Array.isArray(n.actionItems) ? n.actionItems : []).map((a) => ({ text: clean(a.text ?? a), owner: clean(a.owner || ''), done: !!a.done })).filter((a) => a.text),
    cues: segs.map((s) => ({ speaker: s.speaker, label: s.speakerName || s.label || s.name || '', startMs: num(s.startMs ?? s.start_ms), endMs: num(s.endMs ?? s.end_ms), text: s.text })),
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? +v : null);
const firstKey = (items, keys) => keys.find((k) => items.some((o) => o && o[k] != null && o[k] !== ''));
const SPK_KEYS = ['speaker_name', 'speakerName', 'speaker_label', 'speakerLabel', 'speaker', 'name', 'participant', 'user', 'author', 'label'];
const START_KEYS = ['startMs', 'start_ms', 'startTime', 'start_time', 'start', 'offsetInTicks', 'offset', 'ts', 'begin', 'start_offset', 'startOffset', 'from'];
const END_KEYS = ['endMs', 'end_ms', 'endTime', 'end_time', 'end', 'end_ts', 'stop', 'end_offset', 'endOffset', 'to'];
const DUR_KEYS = ['durationInTicks', 'durationMs', 'duration_ms', 'duration'];

function itemText(o) {
  if (o == null) return '';
  if (typeof o !== 'object') return String(o);
  for (const k of ['text', 'transcript', 'content', 'display', 'value', 'sentence', 'caption', 'punctuated_word', 'word']) if (typeof o[k] === 'string') return o[k];
  if (Array.isArray(o.alternatives)) return itemText(o.alternatives[0]);
  if (Array.isArray(o.nBest)) return itemText(o.nBest[0]);
  if (Array.isArray(o.elements)) return o.elements.map((e) => e?.value ?? '').join('');
  if (Array.isArray(o.sentences)) return o.sentences.map(itemText).join(' ');
  if (Array.isArray(o.words)) return o.words.map(itemText).join(' ').replace(/\s+([,.!?;:])/g, '$1');
  return '';
}
// ms per unit for a timing field: explicit (…Ms, …Ticks), else seconds when values are fractional or cues would be absurdly short in ms.
function unitOf(items, sKey, eKey) {
  if (/ticks/i.test(sKey)) return 1e-4;
  if (/ms$/i.test(sKey)) return 1;
  const st = items.map((o) => num(o[sKey])).filter((v) => v != null);
  const en = eKey ? items.map((o) => num(o[eKey])).filter((v) => v != null) : [];
  if (!st.length) return 1;
  if ([...st, ...en].some((v) => v % 1 !== 0)) return 1000;
  const spans = (eKey ? items.map((o) => num(o[eKey]) - num(o[sKey])) : st.slice(1).map((v, i) => v - st[i])).filter((v) => v > 0).sort((a, b) => a - b);
  if (spans.length) return spans[spans.length >> 1] < 50 ? 1000 : 1;
  return Math.max(...st) < 100000 ? 1000 : 1;
}
const timeOf = (v, unit) => (typeof v === 'string' && v.includes(':') ? parseTs(v) : num(v) == null ? null : Math.round(num(v) * unit));

function cuesFromItems(items) {
  items = items.filter((o) => o && typeof o === 'object');
  const sKey = firstKey(items, START_KEYS), eKey = firstKey(items, END_KEYS), dKey = firstKey(items, DUR_KEYS);
  const spKey = firstKey(items, SPK_KEYS);
  const su = sKey ? unitOf(items, sKey, eKey) : 1;
  const du = dKey ? (/ticks/i.test(dKey) ? 1e-4 : /ms$/i.test(dKey) ? 1 : su) : 1;
  const spRaw = items.map((o) => { const v = spKey ? o[spKey] : null; return v && typeof v === 'object' ? v.name ?? v.id : v; });
  const zeroBased = spRaw.some((v) => v === 0 || /^(?:spk|speaker)?[_\s-]*0+$/i.test(String(v ?? 'x')));
  const labelOf = (v) => {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    const n = /^(?:spk|speaker)?[_\s-]*(\d+)$/i.exec(s);
    if (n) return `Speaker ${+n[1] + (zeroBased ? 1 : 0)}`;
    return /^[A-Z]$/i.test(s) ? `Speaker ${s.toUpperCase()}` : clean(s);
  };
  const isWord = items.length > 1 && items.filter((o) => 'word' in o || o.type === 'pronunciation' || o.type === 'punctuation').length > items.length * 0.6;
  const cues = items.map((o, i) => {
    const startMs = sKey ? timeOf(o[sKey], su) : null;
    let endMs = eKey ? timeOf(o[eKey], su) : null;
    if (endMs == null && dKey && startMs != null && num(o[dKey]) != null) endMs = startMs + Math.round(num(o[dKey]) * du);
    return { label: labelOf(spRaw[i]), startMs, endMs, text: itemText(o), punct: o.type === 'punctuation' || /^[,.!?;:]$/.test(itemText(o).trim()) };
  });
  if (!isWord) return cues;
  // word-level output (AWS items, Deepgram words): group by speaker and pauses
  const out = [];
  for (const w of cues) {
    const p = out[out.length - 1];
    if (p && (w.punct || (w.label === p.label && (w.startMs == null || p.endMs == null || w.startMs - p.endMs < 1000) && !(p.text.length > 300 && /[.!?]$/.test(p.text))))) {
      p.text += w.punct ? w.text.trim() : ` ${w.text.trim()}`;
      if (w.endMs != null) p.endMs = w.endMs;
    } else if (!w.punct) out.push({ ...w, text: w.text.trim() });
  }
  return out;
}

function findItems(d, depth = 0) {
  if (depth > 3 || d == null || typeof d !== 'object') return null;
  if (Array.isArray(d)) return d.some((o) => o && typeof o === 'object') ? d : null;
  for (const k of ['utterances', 'segments', 'monologues', 'recognizedPhrases', 'transcript', 'cues', 'captions', 'entries', 'results', 'items']) {
    if (Array.isArray(d[k]) && d[k].some((o) => o && typeof o === 'object' && (itemText(o) || o.alternatives))) return d[k];
  }
  const r = d.results;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if (Array.isArray(r.utterances)) return r.utterances;
    const alt = r.channels?.[0]?.alternatives?.[0];
    if (alt?.paragraphs?.paragraphs?.length) return alt.paragraphs.paragraphs;
    if (alt?.words?.length) return alt.words;
    if (Array.isArray(r.items)) return r.items;
  }
  for (const k of ['transcript', 'transcription', 'data', 'result', 'response']) { const f = findItems(d[k], depth + 1); if (f) return f; }
  return null;
}

function parseJson(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw userError('This JSON file could not be read — it is not valid JSON (it may be truncated or corrupt).'); }
  if (d && d.app === 'whisperbrain' && Array.isArray(d.notes)) {
    const spaces = Object.fromEntries((Array.isArray(d.spaces) ? d.spaces : []).map((s) => [s.id, s.name]));
    return d.notes.filter((n) => n && typeof n === 'object').map((n) => fromWbNote(n, spaces));
  }
  if (isWbNote(d)) return [fromWbNote(d)];
  if (Array.isArray(d) && d.length && d.every(isWbNote)) return d.map((n) => fromWbNote(n));
  const meta = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const out = { ...blank(), format: 'json' };
  const title = meta.title ?? meta.name ?? meta.meeting_title ?? meta.topic ?? meta.metadata?.title;
  if (typeof title === 'string') out.title = clean(title);
  out.date = toMs(meta.date ?? meta.created_at ?? meta.createdAt ?? meta.created ?? meta.recorded_at ?? meta.metadata?.created ?? (typeof meta.start_time === 'string' ? meta.start_time : null));
  out.attendees = peopleList(meta.attendees ?? meta.participants ?? []);
  const items = findItems(d);
  if (items) { out.cues = cuesFromItems(items).filter((c) => clean(c.text)); if (out.cues.length) return [out]; }
  const plain = [meta.transcript, meta.text, meta.results?.channels?.[0]?.alternatives?.[0]?.transcript].find((v) => typeof v === 'string' && v.trim());
  if (plain) return parseText(decodeEntities(plain)).map((m) => ({ ...m, title: m.title || out.title, date: m.date ?? out.date, attendees: [...out.attendees, ...m.attendees], format: 'json' }));
  throw userError('Unrecognised JSON: expected a WhisperBrain backup or a transcript with segments, utterances or results.');
}

// ---------- CSV ----------
function csvRows(text) {
  const head = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const delim = [',', ';', '\t'].map((c) => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"' && !field.trim()) { q = true; field = ''; }
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}
function parseCsv(text) {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => clean(h).toLowerCase().replace(/[\s_-]+/g, ' '));
  const col = (rx) => head.findIndex((h) => rx.test(h));
  const ti = col(/^(text|transcript|transcription|content|utterance|message|caption|sentence|speech)$/);
  if (ti < 0) throw userError('This CSV has no text column — add a header row such as: speaker,start,end,text');
  const si = col(/^(speaker|speaker name|speaker label|name|participant|who|person)$/);
  const bi = col(/^(start|start time|start ms|startms|begin|time|timestamp|from|offset|start seconds)$/);
  const ei = col(/^(end|end time|end ms|endms|stop|to|end seconds)$/);
  const items = rows.slice(1).map((r) => ({ speaker: si >= 0 ? r[si] : '', text: r[ti] ?? '',
    ...(bi >= 0 && { [/ms$/.test(head[bi]) ? 'startMs' : 'start']: r[bi]?.trim() }), ...(ei >= 0 && { [/ms$/.test(head[ei]) ? 'endMs' : 'end']: r[ei]?.trim() }) }));
  return [{ ...blank(), cues: cuesFromItems(items) }];
}

// ---------- HTML ----------
function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(+n)} `).replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<\/?(p|div|tr|ul|ol|table|section|article|blockquote|pre|header|footer|main|nav|aside|dl|dt|dd|figure|hr)\b[^>]*>/gi, '\n');
  s = decodeEntities(s.replace(/<[^>]*>/g, ''));
  const text = tidy(s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n'));
  return { text, title: title ? clean(stripTags(title)) : '' };
}
function parseHtml(text) {
  const { text: t, title } = htmlToText(text);
  return parseText(t).map((m) => ({ ...m, title: m.title || title }));
}

// ---------- DOCX ----------
function docxToText(buf) {
  let zip;
  try { zip = readZip(buf); } catch (e) { throw userError(`This .docx file can't be opened: ${e.message}.`); }
  if (!zip.has('word/document.xml')) throw userError('This file is not a Word document (word/document.xml is missing).');
  const get = (n) => { try { return zip.has(n) ? zip.read(n).toString('utf8') : ''; } catch (e) { throw userError(`This .docx file can't be opened: ${e.message}.`); } };
  const xml = get('word/document.xml');
  // styleId → built-in style name (names are English even in localised Word: "heading 1", "Title")
  const styles = {};
  for (const m of get('word/styles.xml').matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const n = /<w:name\s+w:val="([^"]+)"/.exec(m[2]); if (n) styles[m[1]] = n[1];
  }
  const level = (id) => {
    const n = (styles[id] || id).toLowerCase().replace(/\s+/g, '');
    if (n === 'title') return 1;
    const h = /^(?:heading|ttulo|titre|berschrift|kop|encabezado)(\d)$/.exec(n);
    return h ? Math.min(6, +h[1]) : 0;
  };
  const out = [];
  for (const m of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = m[1] || '';
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(inner)?.[1] || '';
    const list = /<w:numPr>/.test(inner);
    const runs = inner.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, '').replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
    let line = '';
    for (const t of runs.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr|noBreakHyphen)\b[^>]*\/>/g)) {
      line += t[2] ? { tab: '\t', br: '\n', cr: '\n', noBreakHyphen: '-' }[t[2]] : decodeEntities(t[1]);
    }
    if (!line.trim()) { out.push(''); continue; }
    const lv = level(style);
    out.push(lv ? `${'#'.repeat(lv)} ${clean(line)}` : list ? `- ${line.trim()}` : line.replace(/[ \t]+$/gm, ''));
  }
  // paragraphs become blank-line separated (Markdown paragraphs), list items stay together
  const text = out.filter(Boolean).reduce((acc, l, i, a) => acc + (i ? (l.startsWith('- ') && a[i - 1].startsWith('- ') ? '\n' : '\n\n') : '') + l, '');
  const core = get('docProps/core.xml');
  const title = clean(decodeEntities(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] || ''));
  const created = /<dcterms:created\b[^>]*>([^<]+)<\/dcterms:created>/.exec(core)?.[1];
  return { text, title, date: created ? toMs(created) : null };
}
function parseDocx(buf) {
  const { text, title, date } = docxToText(buf);
  return parseText(text).map((m) => ({ ...m, title: m.title || title, date: date ?? m.date }));
}

module.exports = {
  clean, tidy, decodeText, decodeEntities, parseTs, findDate, toMs, person, isName, userError,
  parseCues, scanTranscript, transcriptOf, parseDoc, parseText, parseJson, parseCsv, parseHtml, parseDocx, htmlToText, docxToText, splitFrontmatter,
};
