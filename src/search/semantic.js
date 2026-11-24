'use strict';
// Search by meaning beside the word search (a spike). A meeting's transcript is cut into chunks, each chunk becomes a vector
// through an Embedder, the vectors sit in a sqlite-vec table, and a question finds the nearest chunks. Word search (FTS5) and
// vector search are fused by reciprocal rank (RRF): a meeting both agree on leads.
//
// Honest about what ships: the Embedder here is HashEmbedder, a hashing of words into a fixed vector. It finds texts that share
// words, not texts that mean the same; a real multilingual model (e.g. e5-small through onnxruntime) goes behind the same
// interface ({ id, dim, embed(texts) -> Float32Array[] }) and nothing else changes. sqlite-vec is optional: where it cannot be
// loaded, search is the word search and `reason` says why.
const { speakerLabel } = require('../core/notes');

// Reciprocal rank fusion: lists = [[id, ...], ...] best first -> [{ id, score }] best first
function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i + 1)));
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}

// segments: notes.segments(...) -> [{ startMs, endMs, text }] consecutive lines up to maxChars, each as "Name: text"
function chunkTranscript(segments, { maxChars = 500 } = {}) {
  const chunks = [];
  let cur = null;
  for (const s of segments) {
    const line = `${s.label || speakerLabel(s.speaker)}: ${s.text}`;
    if (cur && cur.text.length + 1 + line.length > maxChars) { chunks.push(cur); cur = null; }
    if (!cur) cur = { startMs: s.startMs, endMs: s.endMs, text: line };
    else { cur.text += `\n${line}`; cur.endMs = s.endMs; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// words hashed into a fixed vector, unit length. Deterministic, needs nothing downloaded.
class HashEmbedder {
  constructor({ dim = 256 } = {}) { this.dim = dim; this.id = `hash-${dim}`; }
  async embed(texts) { return texts.map((t) => this.one(t)); }
  one(text) {
    const v = new Float32Array(this.dim);
    for (const w of String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{2,}/gu) || []) {
      let h = 2166136261;
      for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      v[h % this.dim] += (h >>> 16) & 1 ? 1 : -1;
    }
    let n = 0; for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  }
}

const blob = (v) => new Uint8Array(Float32Array.from(v).buffer);

class SemanticIndex {
  // load(db): puts the extension into the database; replaceable for tests
  constructor({ db, notes, embedder, load = null, maxDistance = 0.75 }) {
    Object.assign(this, { db, notes, embedder, maxDistance });
    this.load = load || (() => {
      db.enableLoadExtension(true);                       // only for this call: SQL cannot load extensions afterwards
      try { require('sqlite-vec').load(db); } finally { db.enableLoadExtension(false); }
    });
    this.available = false;
    this.reason = 'not started';
  }

  // -> true when vector search works. Never throws: it is an extra.
  async init() {
    try {
      this.load();
      const want = `float[${this.embedder.dim}]`;
      const have = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'semantic_vec'").get()?.sql;
      if (have && !have.includes(want)) { this.db.exec('DROP TABLE semantic_vec'); this.db.exec('DELETE FROM semantic_chunks'); }   // another embedder: start again
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vec USING vec0(embedding ${want} distance_metric=cosine)`);
      this.prune();
      this.available = true; this.reason = '';
    } catch (e) { this.available = false; this.reason = e.message; }
    return this.available;
  }

  prune() { if (this.available) this.db.exec('DELETE FROM semantic_vec WHERE rowid NOT IN (SELECT id FROM semantic_chunks)'); }

  async indexNote(noteId) {
    if (!this.available) return 0;
    const chunks = chunkTranscript(this.notes.segments(noteId));
    const vectors = chunks.length ? await this.embedder.embed(chunks.map((c) => c.text)) : [];
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM semantic_vec WHERE rowid IN (SELECT id FROM semantic_chunks WHERE note_id = ?)').run(noteId);
      this.db.prepare('DELETE FROM semantic_chunks WHERE note_id = ?').run(noteId);
      const add = this.db.prepare('INSERT INTO semantic_chunks(note_id, start_ms, end_ms, text) VALUES(?, ?, ?, ?) RETURNING id');
      const vec = this.db.prepare('INSERT INTO semantic_vec(rowid, embedding) VALUES(?, ?)');
      chunks.forEach((c, i) => vec.run(BigInt(add.get(noteId, c.startMs, c.endMs, c.text).id), blob(vectors[i])));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return chunks.length;
  }

  // -> [{ noteId, text, startMs, endMs, distance }] nearest first, cosine distance 0..2
  async search(query, { k = 10 } = {}) {
    if (!this.available || !String(query || '').trim()) return [];
    const [q] = await this.embedder.embed([query]);
    const rows = this.db.prepare('SELECT rowid AS id, distance FROM semantic_vec WHERE embedding MATCH ? AND k = ?').all(blob(q), k);
    const info = this.db.prepare('SELECT note_id AS noteId, text, start_ms AS startMs, end_ms AS endMs FROM semantic_chunks WHERE id = ?');
    return rows.map((r) => { const c = info.get(r.id); return c && { ...c, distance: r.distance }; }).filter(Boolean);
  }

  // Word search and meaning search fused. -> [{ note, snippet, via: ['words'|'meaning'], score }]
  async hybrid(query, { limit = 10 } = {}) {
    const words = this.notes.advancedSearch({ q: query, limit: 30 });
    const byNote = new Map(words.map((w) => [w.note.id, { note: w.note, snippet: w.snippet, via: ['words'] }]));
    const near = (await this.search(query, { k: 30 })).filter((h) => h.distance <= this.maxDistance);
    const meaningIds = [];
    for (const h of near) {
      if (meaningIds.includes(h.noteId)) continue;
      meaningIds.push(h.noteId);
      if (byNote.has(h.noteId)) byNote.get(h.noteId).via.push('meaning');
      else { const note = this.notes.get(h.noteId); if (note) byNote.set(h.noteId, { note, snippet: h.text.slice(0, 200), via: ['meaning'] }); }
    }
    return rrf([words.map((w) => w.note.id), meaningIds.filter((id) => byNote.has(id))]).slice(0, limit).map((r) => ({ ...byNote.get(r.id), score: r.score }));
  }
}

module.exports = { SemanticIndex, HashEmbedder, rrf, chunkTranscript };
