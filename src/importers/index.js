'use strict';
const path = require('node:path');
const P = require('./parsers');

const MAX_TEXT_BYTES = 50 * 1024 * 1024;
const MS_PER_WORD = 60000 / 150; // ~150 wpm when a source has no timestamps
const MERGE_GAP_MS = 1500, MERGE_MAX_CHARS = 600;

const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'aifc', 'amr', 'weba', 'mka', 'caf', 'm4b']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpeg', 'mpg', '3gp', 'ts', 'mts', 'ogv', 'flv']);
const FORMAT_BY_EXT = { vtt: 'vtt', srt: 'srt', txt: 'txt', text: 'txt', log: 'txt', md: 'md', markdown: 'md', mdown: 'md', json: 'json',
  docx: 'docx', html: 'html', htm: 'html', xhtml: 'html', csv: 'csv', tsv: 'csv' };
const SUPPORTED = '.vtt, .srt, .txt, .md, .json, .docx, .html or .csv';

const extOf = (name) => path.extname(String(name || '')).slice(1).toLowerCase();
const fail = P.userError;

// ---------- detection ----------
function looksText(b) {
  const head = b.subarray(0, 4096);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return true;
  let ctrl = 0;
  for (const c of head) { if (c === 0) return false; if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++; }
  return ctrl <= Math.max(2, head.length * 0.01);
}
// Is there an ISO-BMFF `hdlr` box of this handler type ('vide' / 'soun') anywhere in the file?
function hasHandler(b, type) {
  for (let i = b.indexOf('hdlr'), n = 0; i >= 0 && n < 64; i = b.indexOf('hdlr', i + 4), n++) if (b.toString('latin1', i + 12, i + 16) === type) return true;
  return false;
}
function sniff(b, ext) {
  const s = (a, z) => b.toString('latin1', a, z);
  if (s(0, 5) === '%PDF-') return 'unsupported';
  if (b.length > 4 && b.readUInt32LE(0) === 0x04034b50) return ext === 'docx' ? 'text' : 'unsupported';
  if (s(0, 4) === 'RIFF') return s(8, 12) === 'WAVE' ? 'audio' : s(8, 12) === 'AVI ' ? 'video' : 'unsupported';
  if (s(0, 4) === 'FORM' && /^AIF[FC]$/.test(s(8, 12))) return 'audio';
  if (s(0, 3) === 'ID3' || s(0, 4) === 'fLaC' || s(0, 5) === '#!AMR' || s(0, 4) === 'caff') return 'audio';
  if (s(0, 4) === 'OggS') return /theora|\x80theora|OVP80/.test(s(0, 256)) ? 'video' : 'audio';
  if (s(4, 8) === 'ftyp') {
    if (hasHandler(b, 'vide')) return 'video';
    if (hasHandler(b, 'soun')) return 'audio';
    return /^(M4A |M4B |M4P |F4A |F4B )$/.test(s(8, 12)) || AUDIO_EXT.has(ext) ? 'audio' : 'video';
  }
  if (b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3) { // EBML: Matroska / WebM — look for codec ids
    const head = s(0, Math.min(b.length, 1 << 20));
    if (/V_(VP8|VP9|AV1|MPEG4|MPEGH|MS|THEORA)/.test(head)) return 'video';
    if (/A_(OPUS|VORBIS|AAC|MPEG|FLAC|PCM|AC3)/.test(head)) return 'audio';
    return AUDIO_EXT.has(ext) ? 'audio' : 'video';
  }
  if (b.length > 8 && b.readUInt32BE(0) === 0x3026b275 && b.readUInt32BE(4) === 0x8e66cf11) return ext === 'wma' ? 'audio' : 'video'; // ASF
  if (s(0, 3) === 'FLV' || (b.length > 4 && b.readUInt32BE(0) === 0x000001ba) || (b[0] === 0x47 && b.length > 188 && b[188] === 0x47)) return 'video';
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return 'unsupported';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'unsupported'; // JPEG
  if (s(0, 4) === 'GIF8') return 'unsupported';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && b[1] !== 0xfe && b[1] !== 0xff) return 'audio'; // MPEG audio / ADTS frame sync
  return null;
}

// 'audio' | 'video' | 'text' | 'unsupported' — magic bytes win over the extension (renamed files).
function detectKind(filename = '', buffer) {
  const ext = extOf(filename);
  const b = buffer && buffer.length ? (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)) : null;
  const magic = b && sniff(b, ext);
  if (magic) return magic;
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ext === 'docx') return b ? 'unsupported' : 'text'; // a .docx that is not a ZIP
  if (FORMAT_BY_EXT[ext]) return 'text';
  if (!ext || !b) return b && looksText(b) ? 'text' : 'unsupported';
  return looksText(b) && !['pdf', 'doc', 'rtf', 'pages', 'odt', 'xlsx', 'pptx', 'zip', 'exe'].includes(ext) ? 'text' : 'unsupported';
}

// Format for text input: by extension, else sniffed (pasted text / unknown extension).
function formatOf(name, text) {
  const ext = extOf(name);
  const t = text.trimStart();
  if (FORMAT_BY_EXT[ext] && ext !== 'txt' && ext !== 'text' && ext !== 'log') return FORMAT_BY_EXT[ext];
  if (/^WEBVTT/.test(t)) return 'vtt';
  if (/^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(t)) return 'srt';
  if (FORMAT_BY_EXT[ext]) return 'txt';
  if (/^[{[]/.test(t)) { try { JSON.parse(t); return 'json'; } catch { /* plain text that starts with a bracket */ } }
  if (/^<(!doctype html|html|body|div|p|h[1-6]|meta)\b/i.test(t)) return 'html';
  if (/^---[ \t]*\n[\s\S]*?\n---/.test(t) || /^#{1,3} \S/m.test(t)) return 'md';
  return 'txt';
}

// ---------- normalisation ----------
const GENERIC = /^(?:(?:speaker|spk|participant|guest|unknown|user|person|voice|caller|room speaker|interviewer|interviewee|orador|falante|participante)(?:[\s_#-]*\w{1,3})?|[a-z]|\d+|me|them|you|eu|unknown speaker)$/i;
const isGeneric = (label) => !label || GENERIC.test(label.trim());

// Clean, time, sort, assign me/them and merge cues into transcript segments.
function normalizeSegments(cues, { me, merge = true } = {}) {
  const mine = [].concat(me || []).map((s) => P.clean(s).toLowerCase()).filter(Boolean);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const est = (text) => Math.max(1000, Math.round(text.split(' ').length * MS_PER_WORD));
  const list = cues.map((c) => {
    let label = P.clean(c.label).replace(/^\*\*|\*\*$/g, '').replace(/:$/, '').trim();
    const isMe = c.speaker === 'me' || /^me$/i.test(label) || (label && mine.includes(label.toLowerCase()));
    if (/^(me|them|unknown|unknown speaker)$/i.test(label)) label = '';
    return { speaker: isMe ? 'me' : 'them', label, startMs: num(c.startMs), endMs: num(c.endMs), text: P.clean(c.text) };
  }).filter((c) => c.text);
  // missing start → previous end; missing end → next known start or a words-based estimate
  const nextStart = new Array(list.length);
  for (let i = list.length - 1, n = null; i >= 0; i--) { nextStart[i] = n; if (list[i].startMs != null) n = list[i].startMs; }
  let t = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.startMs == null) c.startMs = t;
    if (c.endMs == null || c.endMs < c.startMs) {
      const next = nextStart[i];
      c.endMs = next != null && next > c.startMs ? Math.min(next, c.startMs + est(c.text)) : c.startMs + est(c.text);
    }
    t = Math.max(t, c.endMs);
  }
  list.sort((a, b) => a.startMs - b.startMs); // stable: equal starts keep source order
  const out = [];
  for (const c of list) {
    const p = out[out.length - 1];
    if (merge && p && p.speaker === c.speaker && p.label === c.label && c.startMs - p.endMs < MERGE_GAP_MS && p.text.length + 1 + c.text.length < MERGE_MAX_CHARS) {
      p.text += ' ' + c.text;
      p.endMs = Math.max(p.endMs, c.endMs);
    } else out.push({ ...c });
  }
  return out.map((s) => ({ ...s, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) }));
}

function mergeAttendees(listed, segments) {
  const out = [], seen = new Map(); // key (name/email) → attendee
  const add = (a) => {
    if (!a) return;
    const name = P.clean(a.name), email = P.clean(a.email).toLowerCase();
    if (!email && isGeneric(name)) return;
    const keys = [name && `n:${name.toLowerCase()}`, email && `e:${email}`].filter(Boolean);
    const hit = keys.map((k) => seen.get(k)).find(Boolean);
    if (hit) { if (!hit.email && email) hit.email = email; if (!hit.name && name) hit.name = name; keys.forEach((k) => seen.set(k, hit)); return; }
    const entry = { name, email };
    keys.forEach((k) => seen.set(k, entry));
    out.push(entry);
  };
  for (const a of listed || []) add(typeof a === 'string' ? P.person(a) : a);
  for (const s of segments) if (s.label) add({ name: s.label, email: '' });
  return out;
}

// "2024-03-12_weekly-sync.transcript" → { title: 'Weekly sync', date }
function fromFilename(name) {
  let base = path.basename(String(name || '')).replace(/\.[^.]+$/, '').replace(/\.(transcript|captions?|subtitles?|notes)$/i, '');
  const d = P.findDate(base, { compact: true });
  if (d) base = (base.slice(0, d.index).replace(/GMT$/i, '') + ' ' + base.slice(d.index + d.length)).trim();
  base = P.clean(base.replace(/[_.]+/g, ' ').replace(/\s-+\s|^-+|-+$/g, ' ').replace(/(\p{L})-(?=\p{L})/gu, '$1 ').replace(/^[\s\-–]+|[\s\-–]+$/g, ''));
  return { title: base ? base[0].toUpperCase() + base.slice(1) : '', date: d ? d.ms : null };
}

function finalize(m, { format, sourceName, me, now }) {
  const ok = (ms) => (Number.isFinite(ms) && ms <= now + 366 * 86400000 ? ms : null);
  const segments = normalizeSegments(m.cues || [], { me, merge: !m.noMerge });
  const body = P.tidy(m.body), summary = P.tidy(m.summary);
  const named = fromFilename(sourceName);
  let date = ok(m.date);
  if (date == null) date = ok(P.findDate(body.split('\n').slice(0, 20).join('\n'))?.ms);
  if (date == null) date = ok(named.date);
  const tags = [...new Set((m.tags || []).map((t) => P.clean(t)).filter(Boolean))];
  return {
    title: P.clean(m.title) || named.title || 'Imported note', date,
    attendees: mergeAttendees(m.attendees, segments), body, summary, segments,
    actionItems: (m.actionItems || []).filter((a) => a && a.text), tags,
    format: m.format || format, sourceName,
  };
}

// ---------- entry point ----------
// parseFile(buffer, filename, { now, me }) → ParsedMeeting[]; throws a user-facing Error (code 'EIMPORT').
function parseFile(input, filename = '', { now = Date.now(), me } = {}) {
  const buf = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input, 'utf8')
    : input instanceof Uint8Array || input instanceof ArrayBuffer ? Buffer.from(input) : null;
  const sourceName = path.basename(String(filename || ''));
  const label = sourceName || 'The text';
  if (!buf) throw fail('Nothing to import.');
  if (!buf.length) throw fail(`${label} is empty.`);
  const ext = extOf(sourceName);
  if (ext === 'pdf' || buf.toString('latin1', 0, 5) === '%PDF-') throw fail('PDF import is not supported yet — export the document as .docx, .txt or .md');
  const kind = detectKind(sourceName, buf);
  if (kind === 'audio' || kind === 'video') throw fail(`${label} is ${kind === 'audio' ? 'an audio' : 'a video'} file — import it as a recording to transcribe it.`);
  if (kind !== 'text') throw fail(`${ext ? `.${ext} files are` : 'This file type is'} not supported. Import a transcript or notes as ${SUPPORTED}, or an audio/video recording.`);
  if (buf.length > MAX_TEXT_BYTES) throw fail(`${label} is too large to import (limit ${MAX_TEXT_BYTES / 1048576} MB).`);

  let format, parsed;
  if (ext === 'docx') { format = 'docx'; parsed = P.parseDocx(buf); }
  else {
    const text = P.decodeText(buf);
    if (!text.trim()) throw fail(`${label} is empty.`);
    format = formatOf(sourceName, text);
    if (format === 'vtt' || format === 'srt') {
      parsed = [{ title: '', date: null, attendees: [], body: '', summary: '', cues: P.parseCues(text), actionItems: [], tags: [] }];
      if (!parsed[0].cues.length) throw fail(`No captions found in ${label} — is it a valid .${format} file?`);
    } else if (format === 'json') parsed = P.parseJson(text);
    else if (format === 'csv') parsed = P.parseCsv(text);
    else if (format === 'html') parsed = P.parseHtml(text);
    else parsed = P.parseText(text, { frontmatter: format === 'md' });
  }
  const meetings = parsed.map((m) => [m, finalize(m, { format, sourceName, me, now })])
    .filter(([m, x]) => m.keep || x.body || x.summary || x.segments.length || x.actionItems.length).map(([, x]) => x);
  if (!meetings.length) throw fail(`Nothing to import: ${label === 'The text' ? 'the text' : label} has no notes or transcript in it.`);
  return meetings;
}

module.exports = { detectKind, parseFile, normalizeSegments, MAX_TEXT_BYTES };
