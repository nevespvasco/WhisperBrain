'use strict';
// The search index over everything (docs/adr/0001-brain-data-model.md, Phase 2). Meetings and items (notes, files) are cut into
// chunks. Every chunk is in a word index (FTS5, BM25); when an embedding model is set, it also has a vector, and a question finds the
// nearest ones. The two ranked lists are fused by reciprocal rank (RRF): a chunk both agree on leads. The word index is always there;
// the vectors are an extra that needs sqlite-vec and an embedding model, and where either is missing search is the word search.
//
// Only what changed is re-indexed: each owner (a meeting, an item) remembers the hash it was indexed at.
const crypto = require('node:crypto');
const { rrf } = require('./semantic');
const { speakerLabel } = require('../core/notes');
const { ftsRun } = require('../core/fts');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(('a an and are as at be but by do does did for from had has have how i in is it its of on or that the their them they this to was were what when where which who why will with you your ' +
  'we our us me my he she him her his about can could would should been being into than then there these those over under again also any all some more most about ' +
  'a o os as um uma uns umas de do da dos das em no na nos nas por para com sem que e é foi ser são como qual quais quem quando onde ao aos se mas já não sim').split(' '));
const blob = (v) => new Uint8Array(Float32Array.from(v).buffer);

// text → pieces of about `max` characters, cut at paragraph ends, else sentence ends, else anywhere
function chunkText(text, { max = 900 } = {}) {
  const paras = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > max) {
      push();
      let buf = '';
      for (const sentence of p.split(/(?<=[.!?…])\s+/)) {
        if (sentence.length > max) { for (let i = 0; i < sentence.length; i += max) { if (buf) { out.push(buf); buf = ''; } out.push(sentence.slice(i, i + max)); } continue; }
        if (buf && buf.length + 1 + sentence.length > max) { out.push(buf); buf = ''; }
        buf = buf ? `${buf} ${sentence}` : sentence;
      }
      if (buf) out.push(buf);
    } else if (cur && cur.length + 2 + p.length > max) { push(); cur = p; } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return out;
}

// transcript lines → chunks of consecutive lines, each remembering where it starts (time and first line)
function chunkTranscript(segments, { max = 700 } = {}) {
  const out = [];
  let cur = null;
  for (const s of segments) {
    const line = `${s.label || speakerLabel(s.speaker)}: ${s.text}`;
    if (cur && cur.text.length + 1 + line.length > max) { out.push(cur); cur = null; }
    if (!cur) cur = { text: line, startMs: s.startMs, endMs: s.endMs, segmentId: s.id ?? null };
    else { cur.text += `\n${line}`; cur.endMs = s.endMs; }
  }
  if (cur) out.push(cur);
  return out;
}

// the question's own words: no filler, so "what did we decide about the budget" looks for decide and budget, not "what" and "the"
function queryWords(q) {
  const all = fold(q).match(/[\p{L}\p{N}]{2,}/gu) || [];
  const kept = all.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : all)].slice(0, 10);
}

class ChunkIndex {
  // embedder: { configured(), model(), embed(texts) -> Float32Array[] } (src/search/embedder.js) or null
  constructor({ db, notes, items, embedder = null, load = null, now = () => Date.now() }) {
    Object.assign(this, { db, notes, items, embedder, now });
    this.load = load || (() => {
      db.enableLoadExtension(true);                      // only for this call: SQL cannot load extensions afterwards
      try { require('sqlite-vec').load(db); } finally { db.enableLoadExtension(false); }
    });
    this.vec = { ready: false, dim: 0, reason: 'no embedding model set' };
  }

  meta(key) { return this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

  // ---------- keeping the index current ----------
  noteHash(id) {
    const r = this.db.prepare('SELECT n.updated_at AS u, (SELECT COUNT(*) FROM segments s WHERE s.note_id = n.id) AS c, (SELECT COALESCE(MAX(s.id), 0) FROM segments s WHERE s.note_id = n.id) AS m FROM notes n WHERE n.id = ?').get(id);
    return r ? `${r.u}:${r.c}:${r.m}` : null;
  }

  // The meeting's pieces: its notes first, then its transcript.
  noteChunks(id) {
    const n = this.notes.get(id);
    if (!n) return [];
    const out = [];
    const head = [n.title && `# ${n.title}`, n.summary?.trim(), n.body?.trim() && `Notes:\n${n.body.trim()}`].filter(Boolean).join('\n\n');
    for (const text of chunkText(head, { max: 900 })) out.push({ text, startMs: null, endMs: null, segmentId: null });
    for (const c of chunkTranscript(this.notes.segments(id))) out.push(c);
    return out;
  }

  itemChunks(item) { return chunkText(`${item.title ? `# ${item.title}\n\n` : ''}${item.text || ''}`).map((text) => ({ text, startMs: null, endMs: null, segmentId: null })); }

  replaceChunks(kind, id, hash, chunks) {
    this.removeChunks(kind, id);
    const add = this.db.prepare('INSERT INTO chunks (owner_kind, owner_id, seq, text, start_ms, end_ms, segment_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => { const r = add.run(kind, id, i, c.text, c.startMs, c.endMs, c.segmentId); ftsRun(this.db, 'INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)', Number(r.lastInsertRowid), c.text); });
    this.db.prepare('INSERT INTO index_owner (owner_kind, owner_id, hash, chunks, indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_kind, owner_id) DO UPDATE SET hash = excluded.hash, chunks = excluded.chunks, indexed_at = excluded.indexed_at')
      .run(kind, id, hash, chunks.length, this.now());
  }

  // Is there a vector table whose rows must go with their chunks? Loads sqlite-vec when the table exists but was not touched yet in
  // this run, so a removed item never leaves its vectors behind (an embedding says something about the text it came from).
  vecTable() {
    if (this.vec.ready) return true;
    try {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vec'").get()) return false;
      if (!this.vec.loaded) { this.load(); this.vec.loaded = true; }
      return true;
    } catch { return false; }
  }

  removeChunks(kind, id) {
    const ids = this.db.prepare('SELECT id FROM chunks WHERE owner_kind = ? AND owner_id = ?').all(kind, id).map((r) => r.id);
    const vec = ids.length && this.vecTable();
    for (const cid of ids) { ftsRun(this.db, 'DELETE FROM chunks_fts WHERE rowid = ?', cid); if (vec) this.db.prepare('DELETE FROM chunk_vec WHERE rowid = ?').run(BigInt(cid)); }
    this.db.prepare('DELETE FROM chunks WHERE owner_kind = ? AND owner_id = ?').run(kind, id);
  }

  // One round of work: up to `batch` meetings or items that are out of date, and whatever was deleted. -> { done, left }
  syncBatch(batch = 40) {
    let done = 0;
    this.db.exec('BEGIN');
    try {
      // deleted meetings, deleted or tombstoned items
      for (const r of this.db.prepare(`SELECT owner_kind AS k, owner_id AS id FROM index_owner o WHERE (owner_kind = 'note' AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = o.owner_id))
        OR (owner_kind = 'item' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = o.owner_id AND i.deleted_at IS NULL))`).all()) { this.removeChunks(r.k, r.id); this.db.prepare('DELETE FROM index_owner WHERE owner_kind = ? AND owner_id = ?').run(r.k, r.id); done++; }
      const staleItems = this.db.prepare(`SELECT i.id, i.title, i.text, i.hash FROM items i LEFT JOIN index_owner o ON o.owner_kind = 'item' AND o.owner_id = i.id
        WHERE i.deleted_at IS NULL AND i.kind <> 'meeting' AND (o.hash IS NULL OR o.hash <> i.hash) LIMIT ?`).all(batch);
      for (const it of staleItems) { this.replaceChunks('item', it.id, it.hash, this.itemChunks(it)); done++; }
      const room = batch - staleItems.length;
      if (room > 0) {
        const stale = this.db.prepare(`SELECT n.id FROM notes n LEFT JOIN index_owner o ON o.owner_kind = 'note' AND o.owner_id = n.id
          WHERE o.hash IS NULL OR o.hash <> (n.updated_at || ':' || (SELECT COUNT(*) FROM segments s WHERE s.note_id = n.id) || ':' || (SELECT COALESCE(MAX(s.id), 0) FROM segments s WHERE s.note_id = n.id)) LIMIT ?`).all(room);
        for (const n of stale) { const h = this.noteHash(n.id); if (h) { this.replaceChunks('note', n.id, h, this.noteChunks(n.id)); done++; } }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { done, left: this.pendingOwners() };
  }

  pendingOwners() {
    const items = this.db.prepare(`SELECT COUNT(*) AS n FROM items i LEFT JOIN index_owner o ON o.owner_kind = 'item' AND o.owner_id = i.id WHERE i.deleted_at IS NULL AND i.kind <> 'meeting' AND (o.hash IS NULL OR o.hash <> i.hash)`).get().n;
    const notes = this.db.prepare(`SELECT COUNT(*) AS n FROM notes n LEFT JOIN index_owner o ON o.owner_kind = 'note' AND o.owner_id = n.id
      WHERE o.hash IS NULL OR o.hash <> (n.updated_at || ':' || (SELECT COUNT(*) FROM segments s WHERE s.note_id = n.id) || ':' || (SELECT COALESCE(MAX(s.id), 0) FROM segments s WHERE s.note_id = n.id))`).get().n;
    return items + notes;
  }

  // ---------- meaning (vectors) ----------
  // Is vector search possible right now? Makes the vector table for the model's dimension when it is first needed.
  ensureVec(dim) {
    if (this.vec.ready && this.vec.dim === dim) return true;
    try {
      if (!this.vec.loaded) { this.load(); this.vec.loaded = true; }
      const want = `float[${dim}]`;
      const have = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vec'").get()?.sql;
      if (have && !have.includes(want)) { this.db.exec('DROP TABLE chunk_vec'); this.db.exec('UPDATE chunks SET embedded = 0'); }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding ${want} distance_metric=cosine)`);
      this.vec = { ready: true, dim, loaded: true, reason: '' };
    } catch (e) { this.vec = { ready: false, dim: 0, loaded: this.vec.loaded, reason: e.message }; }
    return this.vec.ready;
  }

  // Forget every vector (everything was deleted, or access to what they came from was revoked): the table goes, chunks are re-embedded.
  forgetVectors() {
    try {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vec'").get()) {
        if (!this.vec.loaded) { this.load(); this.vec.loaded = true; }
        this.db.exec('DROP TABLE IF EXISTS chunk_vec');
      }
    } catch { /* sqlite-vec missing: there were no vectors it could have made */ }
    try { this.db.exec('UPDATE chunks SET embedded = 0'); } catch { /* closing */ }
    this.vec = { ready: false, dim: 0, loaded: this.vec.loaded, reason: this.vec.reason };
  }

  // Another embedding model means other vectors: all start again.
  checkModel() {
    const model = this.embedder?.model?.() || '';
    if (model !== (this.meta('embedding_model') || '')) {
      if (this.vec.loaded || this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vec'").get()) { try { this.db.exec('DROP TABLE IF EXISTS chunk_vec'); } catch { /* not loaded */ } }
      this.db.exec('UPDATE chunks SET embedded = 0');
      this.vec = { ready: false, dim: 0, loaded: this.vec.loaded, reason: model ? '' : 'no embedding model set' };
      this.setMeta('embedding_model', model);
    }
    return model;
  }

  // Embed chunks that have no vector yet. mayEmbed(ownerKind, ownerId) -> false for what must not reach the embedding server (a private
  // source and a server that is not on this computer). Never throws: it is an extra; the reason is kept for the Activity page.
  async embedPending({ batch = 16, mayEmbed = () => true } = {}) {
    const model = this.checkModel();
    if (!model || !this.embedder?.configured?.()) return { embedded: 0, left: 0, reason: this.vec.reason };
    const rows = this.db.prepare('SELECT id, owner_kind AS k, owner_id AS o, text FROM chunks WHERE embedded = 0 ORDER BY id LIMIT ?').all(batch * 4).filter((r) => mayEmbed(r.k, r.o)).slice(0, batch);
    if (!rows.length) return { embedded: 0, left: 0, reason: this.vec.reason };
    let vectors;
    try { vectors = await this.embedder.embed(rows.map((r) => r.text)); } catch (e) { this.vec = { ...this.vec, ready: this.vec.ready, reason: e.message }; return { embedded: 0, left: -1, reason: e.message }; }
    if (!vectors.length || !this.ensureVec(vectors[0].length)) return { embedded: 0, left: -1, reason: this.vec.reason };
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)');
      rows.forEach((r, i) => { if (this.db.prepare('SELECT 1 FROM chunks WHERE id = ?').get(r.id)) { this.db.prepare('DELETE FROM chunk_vec WHERE rowid = ?').run(BigInt(r.id)); ins.run(BigInt(r.id), blob(vectors[i])); this.db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?').run(r.id); } });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); return { embedded: 0, left: -1, reason: e.message }; }
    return { embedded: rows.length, left: this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0').get().n, reason: '' };
  }

  stats() {
    const c = this.db.prepare('SELECT COUNT(*) AS chunks, COALESCE(SUM(embedded), 0) AS embedded FROM chunks').get();
    return { chunks: c.chunks, embedded: c.embedded, pending: this.pendingOwners(), model: this.embedder?.model?.() || '', vectors: this.vec.ready, reason: this.vec.reason };
  }

  // ---------- searching ----------
  // -> [{ chunkId, kind: 'note'|'item', id, title, text, startMs, segmentId, via: ['words','meaning'], score }] best first.
  // allow(kind, id) -> false hides a chunk (a private source, for an AI that is not on this computer).
  async search(query, { limit = 8, allow = () => true, meaning = true } = {}) {
    const words = queryWords(query);
    if (!words.length) return [];
    const pool = Math.max(40, limit * 6);
    const match = words.map((w) => `"${w}"*`).join(' OR ');
    const lexical = this.db.prepare('SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?').all(match, pool).map((r) => r.id);
    let semantic = [];
    if (meaning && this.vec.ready && this.embedder?.configured?.()) {
      try {
        const [q] = await this.embedder.embed([query]);
        if (q?.length === this.vec.dim) semantic = this.db.prepare('SELECT rowid AS id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ?').all(blob(q), pool).filter((r) => r.distance <= 0.8).map((r) => Number(r.id));
      } catch { /* the words still find things */ }
    }
    const fused = rrf([lexical, semantic]);
    const info = this.db.prepare('SELECT * FROM chunks WHERE id = ?');
    const out = [];
    for (const f of fused) {
      const c = info.get(f.id);
      if (!c || !allow(c.owner_kind, c.owner_id)) continue;
      const owner = c.owner_kind === 'note' ? this.notes.get(c.owner_id) : this.items.item(c.owner_id);
      if (!owner || owner.deletedAt) continue;
      out.push({ chunkId: c.id, kind: c.owner_kind, id: c.owner_id, title: owner.title || '', text: c.text, startMs: c.start_ms, segmentId: c.segment_id, at: c.owner_kind === 'note' ? (owner.startedAt || owner.createdAt) : owner.occurredAt,
        sourceId: c.owner_kind === 'item' ? owner.sourceId : null, uri: c.owner_kind === 'item' ? owner.uri : '', via: [lexical.includes(f.id) && 'words', semantic.includes(f.id) && 'meaning'].filter(Boolean), score: f.score });
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { ChunkIndex, chunkText, chunkTranscript, queryWords };
