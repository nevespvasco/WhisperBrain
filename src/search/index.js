'use strict';
// The search index over everything (docs/adr/0001-brain-data-model.md, Phase 2). Meetings and items (notes, files) are cut into
// chunks. Every chunk is in a word index (FTS5, BM25); when an embedding model is set, it also has a vector, and a question finds the
// nearest ones. The two ranked lists are fused by reciprocal rank (RRF): a chunk both agree on leads. The word index is always there;
// the vectors are an extra that needs sqlite-vec and an embedding model, and where either is missing search is the word search.
//
// Only what changed is re-indexed: triggers queue each owner (a meeting, an item) whose pieces may have changed in dirty_owners, and an
// index pass takes from that queue; index_owner remembers the hash each owner was indexed at.
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

  // One round of work: up to `batch` meetings or items from the change queue (dirty_owners, filled by triggers: see migration 30), so
  // a pass costs what changed, not the size of the brain. -> { done: how many were looked at, left: how many still wait }
  syncBatch(batch = 40) {
    let done = 0;
    this.db.exec('BEGIN');
    try {
      const pop = this.db.prepare('DELETE FROM dirty_owners WHERE owner_kind = ? AND owner_id = ?');
      for (const r of this.db.prepare('SELECT owner_kind AS k, owner_id AS id FROM dirty_owners ORDER BY rowid LIMIT ?').all(batch)) {
        pop.run(r.k, r.id);
        if (r.k === 'note') this.syncNote(r.id); else if (r.k === 'item') this.syncItem(r.id);
        done++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { done, left: this.pendingOwners() };
  }

  forget(kind, id) { this.removeChunks(kind, id); this.db.prepare('DELETE FROM index_owner WHERE owner_kind = ? AND owner_id = ?').run(kind, id); }

  // A meeting whose pieces come out the same (it was queued by an edit that changed nothing searchable) keeps its chunks, so their
  // vectors are not made again.
  syncNote(id) {
    const hash = this.noteHash(id);
    if (!hash) return this.forget('note', id);
    const chunks = this.noteChunks(id);
    const have = this.db.prepare('SELECT text, start_ms AS startMs, end_ms AS endMs, segment_id AS segmentId FROM chunks WHERE owner_kind = ? AND owner_id = ? ORDER BY seq').all('note', id);
    const same = have.length === chunks.length && have.every((c, i) => c.text === chunks[i].text && c.startMs === chunks[i].startMs && c.endMs === chunks[i].endMs && c.segmentId === chunks[i].segmentId);
    if (!same) return this.replaceChunks('note', id, hash, chunks);
    this.db.prepare('INSERT INTO index_owner (owner_kind, owner_id, hash, chunks, indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_kind, owner_id) DO UPDATE SET hash = excluded.hash')
      .run('note', id, hash, chunks.length, this.now());
  }

  syncItem(id) {
    const it = this.db.prepare("SELECT id, title, text, hash FROM items WHERE id = ? AND deleted_at IS NULL AND kind <> 'meeting'").get(id);
    if (!it) return this.forget('item', id);
    if (this.db.prepare("SELECT hash FROM index_owner WHERE owner_kind = 'item' AND owner_id = ?").get(id)?.hash === it.hash) return;
    this.replaceChunks('item', it.id, it.hash, this.itemChunks(it));
  }

  pendingOwners() { return this.db.prepare('SELECT COUNT(*) AS n FROM dirty_owners').get().n; }

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
  // source and a server that is not on this computer); it is asked once per owner per call. Never throws: it is an extra; the reason is
  // kept for the Activity page. Pages by chunk id: `after` is where the previous call stopped and `next` where the next one starts
  // (null when the scan reached the end), so chunks that may not be embedded (old mail, a private source) never hide the ones behind them.
  async embedPending({ batch = 16, mayEmbed = () => true, after = 0 } = {}) {
    const model = this.checkModel();
    if (!model || !this.embedder?.configured?.()) return { embedded: 0, left: 0, reason: this.vec.reason, next: null };
    const asked = new Map();
    const may = (k, o) => { const key = `${k}:${o}`; if (!asked.has(key)) asked.set(key, !!mayEmbed(k, o)); return asked.get(key); };
    const scanned = this.db.prepare('SELECT id, owner_kind AS k, owner_id AS o, text FROM chunks WHERE embedded = 0 AND id > ? ORDER BY id LIMIT ?').all(after, batch * 4);
    const rows = [];
    let next = null;
    for (const r of scanned) { if (rows.length >= batch) break; next = r.id; if (may(r.k, r.o)) rows.push(r); }
    if (scanned.length < batch * 4 && next === scanned[scanned.length - 1]?.id) next = null;   // the end of the table was reached
    if (!rows.length) return { embedded: 0, left: 0, reason: this.vec.reason, next };
    let vectors;
    try { vectors = await this.embedder.embed(rows.map((r) => r.text)); } catch (e) { this.vec = { ...this.vec, ready: this.vec.ready, reason: e.message }; return { embedded: 0, left: -1, reason: e.message, next: null }; }
    if (!vectors.length || !this.ensureVec(vectors[0].length)) return { embedded: 0, left: -1, reason: this.vec.reason, next: null };
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)');
      rows.forEach((r, i) => { if (this.db.prepare('SELECT 1 FROM chunks WHERE id = ?').get(r.id)) { this.db.prepare('DELETE FROM chunk_vec WHERE rowid = ?').run(BigInt(r.id)); ins.run(BigInt(r.id), blob(vectors[i])); this.db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?').run(r.id); } });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); return { embedded: 0, left: -1, reason: e.message, next: null }; }
    return { embedded: rows.length, left: this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0').get().n, reason: '', next };
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
    if (!fused.length) return [];
    // the chunks and their owners in three queries, not two per hit
    const inList = (n) => Array(n).fill('?').join(',');
    const ids = fused.map((f) => f.id);
    const chunks = new Map(this.db.prepare(`SELECT * FROM chunks WHERE id IN (${inList(ids.length)})`).all(...ids).map((c) => [c.id, c]));
    const of = (kind) => [...new Set([...chunks.values()].filter((c) => c.owner_kind === kind).map((c) => c.owner_id))];
    const noteIds = of('note'), itemIds = of('item');
    const notes = new Map(noteIds.length ? this.db.prepare(`SELECT id, title, started_at AS startedAt, created_at AS createdAt FROM notes WHERE id IN (${inList(noteIds.length)})`).all(...noteIds).map((n) => [n.id, n]) : []);
    // an item waiting in the change queue is left out until it is indexed again: its body may just have been dropped (a narrowed grant)
    const items = new Map(itemIds.length ? this.db.prepare(`SELECT i.id, i.title, i.occurred_at AS occurredAt, i.source_id AS sourceId, i.uri FROM items i WHERE i.id IN (${inList(itemIds.length)}) AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM dirty_owners d WHERE d.owner_kind = 'item' AND d.owner_id = i.id)`).all(...itemIds).map((i) => [i.id, i]) : []);
    const out = [];
    for (const f of fused) {
      const c = chunks.get(f.id);
      if (!c || !allow(c.owner_kind, c.owner_id)) continue;
      const owner = c.owner_kind === 'note' ? notes.get(c.owner_id) : items.get(c.owner_id);
      if (!owner) continue;
      out.push({ chunkId: c.id, kind: c.owner_kind, id: c.owner_id, title: owner.title || '', text: c.text, startMs: c.start_ms, segmentId: c.segment_id, at: c.owner_kind === 'note' ? (owner.startedAt || owner.createdAt) : owner.occurredAt,
        sourceId: c.owner_kind === 'item' ? owner.sourceId : null, uri: c.owner_kind === 'item' ? owner.uri : '', via: [lexical.includes(f.id) && 'words', semantic.includes(f.id) && 'meaning'].filter(Boolean), score: f.score });
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { ChunkIndex, chunkText, chunkTranscript, queryWords };
