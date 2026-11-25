'use strict';
// Briefings: the user's own material (resume, job description, company, project, agenda, notes) that the meeting
// assistant grounds its suggestions on. Each keeps a short list of terms, extracted offline, that also bias recognition.
const { newId } = require('../core/ids');
const { tx } = require('../core/db');
const path = require('node:path');
const P = require('../importers/parsers');
const { pdfToText } = require('../importers/pdf');
const { detectKind } = require('../importers/index');
const kp = require('./keyphrases');

const MAX_TERMS = 40;
const MAX_TERM_CHARS = 40;
const MAX_TEXT = 200000; // characters; longer material is cut
const KINDS = ['resume', 'job', 'company', 'project', 'agenda', 'notes'];

const invalid = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = (msg) => Object.assign(new Error(msg), { status: 404 });
function checkKind(kind) {
  if (!KINDS.includes(kind)) throw invalid(`kind must be one of ${KINDS.join(', ')}`);
  return kind;
}
function checkText(v, field) {
  if (v != null && typeof v === 'object') throw invalid(`${field} must be text`);
  return String(v ?? '');
}

// Keyphrases of the text (repeated or capitalised multi-word phrases), then names that are spelled like names even when
// said once ("PostgreSQL", "AWS", "GraphQL"): what a speech model is likely to get wrong.
function termsOf(text) {
  const out = [];
  const keys = new Set();
  const add = (name, key) => {
    if (out.length >= MAX_TERMS || name.length > MAX_TERM_CHARS || keys.has(key)) return;
    keys.add(key);
    out.push(name);
  };
  for (const p of kp.extract(text, undefined, { max: MAX_TERMS * 2 })) add(p.name, p.key);
  const named = [...kp.candidates(text)].filter(([, e]) => e.n === 1)
    .map(([key, e]) => [key, [...e.forms.keys()].find((f) => /^\p{Lu}.*\p{Lu}/u.test(f)), e.count])
    .filter(([, form]) => form).sort((a, b) => b[2] - a[2]);
  for (const [key, form] of named) add(form, key);
  return out;
}

// A CV by its name ("Vasco_CV_2026", "my-resume", "curriculum") or its text: "curriculum vitae" near the top, a line that
// is just "CV" / "Résumé" / "Currículo", or both an experience and an education section. English and Portuguese.
// (A job ad saying "send your CV" is not one.)
const RESUME_WORD = /(?:^|[^\p{L}])(?:cv|r[eé]sum[eé]|curr[ií]cul(?:um|o)(?:\s+vitae)?)(?=$|[^\p{L}])/iu;
const RESUME_LINE = /^(?:#{1,6}\s*)?(?:cv|r[eé]sum[eé]|curr[ií]cul(?:um|o)(?:\s+vitae)?)\s*:?\s*$/imu;
const heading = (text, words) => new RegExp(`^(?:#{1,6}\\s*)?(?:${words})\\s*:?\\s*$`, 'imu').test(text);
function looksLikeResume(title, text) {
  if (RESUME_WORD.test(title.replace(/[_.-]+/g, ' '))) return true;
  const head = text.slice(0, 600);
  if (/curr[ií]cul(?:um|o) vitae/i.test(head) || RESUME_LINE.test(head)) return true;
  return heading(text, '(?:work |professional )?experience|experiência(?: profissional)?')
    && heading(text, 'education|educação|formação(?: académica| acadêmica)?');
}

const HTML_EXT = new Set(['html', 'htm', 'xhtml']);
const SUPPORTED = '.pdf, .docx, .md, .txt or .html';

// The text of an imported file. Throws a user-facing error (status 400) for what cannot be read.
async function textOf(name, buf) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const label = name || 'The file';
  if (!buf.length) throw invalid(`${label} is empty.`);
  if (ext === 'pdf' || buf.toString('latin1', 0, 5) === '%PDF-') return (await pdfToText(buf)).text.trim();
  const zipped = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (ext === 'docx' || zipped) return P.docxToText(buf).text.trim();
  const kind = detectKind(name, buf);
  if (kind !== 'text') throw invalid(`${ext ? `.${ext} files are` : 'This file type is'} not supported${kind === 'audio' || kind === 'video' ? ` (${kind})` : ''}. Import a briefing as ${SUPPORTED}.`);
  const text = P.decodeText(buf);
  if (HTML_EXT.has(ext) || (!ext && /^\s*<(!doctype html|html)\b/i.test(text))) return P.htmlToText(text).text.trim();
  return text.trim();
}

class Briefings {
  constructor({ db, bus }) {
    this.db = db;
    this.bus = bus;
  }

  changed(data) { this.bus?.publish('briefings.changed', data); }

  // Without the text (it can be long): its size instead.
  list() {
    return this.db.prepare('SELECT id, title, kind, terms, length(text) AS size, created_at, updated_at FROM briefings ORDER BY updated_at DESC, rowid DESC').all()
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind, terms: JSON.parse(r.terms || '[]'), size: r.size, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM briefings WHERE id = ?').get(String(id ?? ''));
    return r ? row(r) : null;
  }

  create({ title = '', kind = 'notes', text = '' } = {}) {
    checkKind(kind);
    title = checkText(title, 'title');
    text = checkText(text, 'text').slice(0, MAX_TEXT);
    const id = newId();
    const now = Date.now();
    this.db.prepare('INSERT INTO briefings (id, title, kind, text, terms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, kind, text, JSON.stringify(termsOf(text)), now, now);
    this.changed({ id });
    return this.get(id);
  }

  // patch: any of { title, kind, text }. null when there is no such briefing.
  update(id, patch = {}) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { title: cur.title, kind: cur.kind, text: cur.text, terms: cur.terms };
    if (patch.title !== undefined) next.title = checkText(patch.title, 'title');
    if (patch.kind !== undefined) next.kind = checkKind(patch.kind);
    if (patch.text !== undefined) {
      const text = checkText(patch.text, 'text').slice(0, MAX_TEXT);
      if (text !== cur.text) { next.text = text; next.terms = termsOf(text); }
    }
    this.db.prepare('UPDATE briefings SET title = ?, kind = ?, text = ?, terms = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.kind, next.text, JSON.stringify(next.terms), Date.now(), cur.id);
    this.changed({ id: cur.id });
    return this.get(cur.id);
  }

  // name: the file's name (title = name without extension); buffer: its bytes.
  async importFile(name, buffer) {
    const file = path.basename(String(name || ''));
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    let text;
    try { text = await textOf(file, buf); } catch (e) { throw e.code === 'EIMPORT' ? invalid(e.message) : e; }
    if (!text) throw invalid(`${file || 'The file'} has no text in it${/\.pdf$/i.test(file) ? ' (a scanned PDF needs OCR first)' : ''}.`);
    const title = file.replace(/\.[^.]+$/, '') || file;
    return this.create({ title, kind: looksLikeResume(title, text) ? 'resume' : 'notes', text });
  }

  // Its links to notes go with it (ON DELETE CASCADE).
  remove(id) {
    const gone = this.db.prepare('DELETE FROM briefings WHERE id = ?').run(String(id ?? '')).changes > 0;
    if (gone) this.changed({ id: String(id), removed: true });
    return gone;
  }

  // The briefings attached to a note, in full, oldest first.
  forNote(noteId) {
    return this.db.prepare(`SELECT b.* FROM note_briefings nb JOIN briefings b ON b.id = nb.briefing_id WHERE nb.note_id = ?
      ORDER BY b.created_at, b.rowid`).all(String(noteId ?? '')).map(row);
  }

  // Replaces what is attached to the note. Unknown ids refuse the whole change.
  setForNote(noteId, ids) {
    if (!Array.isArray(ids)) throw invalid('ids must be a list');
    const id = String(noteId ?? '');
    if (!this.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw notFound('note not found');
    const unique = [...new Set(ids.map((x) => String(x ?? '')))];
    const known = this.db.prepare('SELECT 1 FROM briefings WHERE id = ?');
    for (const b of unique) if (!known.get(b)) throw notFound(`briefing not found: ${b}`);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM note_briefings WHERE note_id = ?').run(id);
      const ins = this.db.prepare('INSERT INTO note_briefings (note_id, briefing_id) VALUES (?, ?)');
      for (const b of unique) ins.run(id, b);
    });
    this.changed({ noteId: id, ids: unique });
    return this.forNote(id);
  }

  // Terms of every briefing attached to the note, first spelling of each kept.
  termsForNote(noteId) {
    const seen = new Set();
    const out = [];
    for (const b of this.forNote(noteId)) {
      for (const t of b.terms) {
        const k = t.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      }
    }
    return out;
  }
}

const row = (r) => ({ id: r.id, title: r.title, kind: r.kind, text: r.text, terms: JSON.parse(r.terms || '[]'), createdAt: r.created_at, updatedAt: r.updated_at });

module.exports = { Briefings, KINDS, MAX_TEXT };
