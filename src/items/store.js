'use strict';
// Sources and items (docs/adr/0001-brain-data-model.md). A source is where material comes from; an item is one thing from it.
// Syncing the same thing again updates its item instead of making a second one: (source_id, external_id) is unique and a content
// hash says whether anything changed. What disappeared from the source is tombstoned (deleted_at), never silently kept as live.
// A meeting is an item of kind 'meeting' pointing at its notes row; it holds no text of its own.
const crypto = require('node:crypto');

const NATIVE = 'native';                                   // the recorder and the app's own meetings
const MAX_TEXT = 400_000;                                  // derived text kept per item (pointer mode keeps the text for search, not the file)
const KINDS = ['native', 'folder', 'obsidian', 'notion', 'linear'];

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const srcRow = (r) => !r ? null : ({
  id: r.id, kind: r.kind, name: r.name, mode: r.mode, sensitivity: r.sensitivity, config: parse(r.config, {}), enabled: !!r.enabled,
  cursor: r.cursor, lastSyncAt: r.last_sync_at, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
});
const itemRow = (r) => !r ? null : ({
  id: r.id, sourceId: r.source_id, externalId: r.external_id, kind: r.kind, title: r.title, text: r.text, hash: r.hash, uri: r.uri, path: r.path,
  meta: parse(r.meta, {}), noteId: r.note_id, occurredAt: r.occurred_at, ingestedAt: r.ingested_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
});

class ItemStore {
  constructor(db, { bus = null, now = () => Date.now() } = {}) { this.db = db; this.bus = bus; this.now = now; }

  // ---------- sources ----------
  addSource({ kind, name = '', mode = 'pointer', sensitivity = 'normal', config = {}, id } = {}) {
    if (!KINDS.includes(kind)) throw Object.assign(new Error(`unknown source kind "${kind}"`), { status: 400 });
    const t = this.now();
    const sid = id || newId('src');
    this.db.prepare('INSERT INTO sources (id, kind, name, mode, sensitivity, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, kind, String(name).slice(0, 120), mode, sensitivity, JSON.stringify(config), t, t);
    this.bus?.publish('sources.changed', { id: sid });
    return this.source(sid);
  }

  source(id) { return srcRow(this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id)); }

  sources() {
    const counts = new Map(this.db.prepare('SELECT source_id, COUNT(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY source_id').all().map((r) => [r.source_id, r.n]));
    return this.db.prepare('SELECT * FROM sources ORDER BY (kind = ?) DESC, created_at').all(NATIVE).map(srcRow).map((s) => ({ ...s, items: counts.get(s.id) || 0 }));
  }

  // the one source of a kind (the recorder's 'native'), made when first needed
  ensureSource(kind, defaults = {}) {
    const row = this.db.prepare('SELECT id FROM sources WHERE kind = ? ORDER BY created_at LIMIT 1').get(kind);
    return row ? this.source(row.id) : this.addSource({ kind, name: defaults.name || kind, ...defaults });
  }

  updateSource(id, patch) {
    const cur = this.source(id);
    if (!cur) return null;
    const sets = [], vals = [];
    const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if ('name' in patch) set('name', String(patch.name).slice(0, 120));
    if ('mode' in patch) { if (!['pointer', 'excerpt', 'copy'].includes(patch.mode)) throw Object.assign(new Error('mode must be pointer, excerpt or copy'), { status: 400 }); set('mode', patch.mode); }
    if ('sensitivity' in patch) { if (!['normal', 'private'].includes(patch.sensitivity)) throw Object.assign(new Error('sensitivity must be normal or private'), { status: 400 }); set('sensitivity', patch.sensitivity); }
    if ('enabled' in patch) set('enabled', patch.enabled ? 1 : 0);
    if ('config' in patch) set('config', JSON.stringify({ ...cur.config, ...patch.config }));
    if ('cursor' in patch) set('cursor', patch.cursor);
    if ('lastSyncAt' in patch) set('last_sync_at', patch.lastSyncAt);
    if ('lastError' in patch) set('last_error', patch.lastError);
    if (sets.length) this.db.prepare(`UPDATE sources SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
    this.bus?.publish('sources.changed', { id });
    return this.source(id);
  }

  // Removing a source removes its items (cascade); the files themselves are never touched.
  removeSource(id) {
    const s = this.source(id);
    if (!s) return false;
    if (s.kind === NATIVE) throw Object.assign(new Error('The recorder source cannot be removed.'), { status: 409 });
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM items_fts WHERE rowid IN (SELECT rowid FROM items WHERE source_id = ?)').run(id);
      this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.bus?.publish('sources.changed', { id });
    return true;
  }

  markSync(id, { ok = true, error = null, cursor } = {}) {
    const patch = { lastSyncAt: this.now(), lastError: ok ? null : String(error || 'failed').slice(0, 500) };
    if (cursor !== undefined) patch.cursor = cursor;
    return this.updateSource(id, patch);
  }

  // ---------- items ----------
  item(id) { return itemRow(this.db.prepare('SELECT * FROM items WHERE id = ?').get(id)); }
  byExternal(sourceId, externalId) { return itemRow(this.db.prepare('SELECT * FROM items WHERE source_id = ? AND external_id = ?').get(sourceId, String(externalId))); }
  forNote(noteId) { return itemRow(this.db.prepare('SELECT * FROM items WHERE note_id = ?').get(noteId)); }

  // Create or update the item for (source, externalId). Returns { action: 'created' | 'updated' | 'unchanged' | 'revived', item }.
  // 'unchanged': the content hash is the same, so nothing is written (a tombstoned item that comes back is 'revived').
  // Derived text is capped: it is for finding the item, the original stays where it is (pointer mode).
  upsert(sourceId, { externalId, kind = 'document', title = '', text = '', hash, uri = '', path = '', meta = {}, noteId = null, occurredAt } = {}) {
    if (externalId == null || externalId === '') throw new Error('an item needs an externalId');
    const clipped = String(text).slice(0, MAX_TEXT);
    const h = hash || sha(`${title}\n${clipped}`);
    const t = this.now();
    const cur = this.db.prepare('SELECT * FROM items WHERE source_id = ? AND external_id = ?').get(sourceId, String(externalId));
    if (!cur) {
      const id = newId('it');
      const info = this.db.prepare(`INSERT INTO items (id, source_id, external_id, kind, title, text, hash, uri, path, meta, note_id, occurred_at, ingested_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sourceId, String(externalId), kind, String(title).slice(0, 300), clipped, h, uri, path, JSON.stringify(meta), noteId, occurredAt || t, t, t);
      if (kind !== 'meeting') this.index(Number(info.lastInsertRowid), title, clipped);   // a meeting has no text here: its own notes are searched
      return { action: 'created', item: this.item(id) };
    }
    if (cur.hash === h && !cur.deleted_at && cur.title === String(title).slice(0, 300) && cur.uri === uri && cur.path === path && cur.note_id === noteId) return { action: 'unchanged', item: itemRow(cur) };
    const revived = !!cur.deleted_at;
    this.db.prepare(`UPDATE items SET kind = ?, title = ?, text = ?, hash = ?, uri = ?, path = ?, meta = ?, note_id = ?, occurred_at = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`)
      .run(kind, String(title).slice(0, 300), clipped, h, uri, path, JSON.stringify(meta), noteId, occurredAt || cur.occurred_at, t, cur.id);
    const rowid = this.db.prepare('SELECT rowid FROM items WHERE id = ?').get(cur.id).rowid;
    if (kind !== 'meeting') this.index(rowid, title, clipped);
    return { action: revived ? 'revived' : 'updated', item: this.item(cur.id) };
  }

  // the file's modified time and size, remembered so the next scan can skip it when they have not changed
  setMeta(id, meta) { this.db.prepare('UPDATE items SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id); }

  index(rowid, title, text) {
    this.db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(rowid);
    this.db.prepare('INSERT INTO items_fts (rowid, title, text) VALUES (?, ?, ?)').run(rowid, title, text);
  }

  // The thing is gone from its source: keep a tombstone (so a restore is "revived", and nothing else is lost), drop it from search.
  tombstone(sourceId, externalId) {
    const cur = this.db.prepare('SELECT rowid, * FROM items WHERE source_id = ? AND external_id = ? AND deleted_at IS NULL').get(sourceId, String(externalId));
    if (!cur) return false;
    this.db.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(this.now(), this.now(), cur.id);
    this.db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(cur.rowid);
    return true;
  }

  // After a full scan: every live item of this source that was not seen is tombstoned. Returns how many.
  tombstoneMissing(sourceId, seen) {
    let n = 0;
    for (const r of this.db.prepare('SELECT external_id FROM items WHERE source_id = ? AND deleted_at IS NULL').all(sourceId)) {
      if (!seen.has(r.external_id) && this.tombstone(sourceId, r.external_id)) n++;
    }
    return n;
  }

  // What the last scan saw of each live item, to skip reading files that did not change: { externalId: { mtime, size } }
  fingerprints(sourceId) {
    const out = new Map();
    for (const r of this.db.prepare('SELECT external_id, meta FROM items WHERE source_id = ? AND deleted_at IS NULL').all(sourceId)) {
      const m = parse(r.meta, {});
      out.set(r.external_id, { mtime: m.mtime, size: m.size });
    }
    return out;
  }

  // Items that are not meetings (the Library's "Notes & files"), newest first. Meetings have their own page.
  list({ sourceId, q, limit = 100, offset = 0, includeMeetings = false } = {}) {
    const where = ['i.deleted_at IS NULL'];
    const args = [];
    if (!includeMeetings) where.push("i.kind <> 'meeting'");
    if (sourceId) { where.push('i.source_id = ?'); args.push(sourceId); }
    const match = ftsQuery(q);
    const sql = match
      ? `SELECT i.*, s.name AS source_name, s.kind AS source_kind, '' AS snip FROM items_fts f JOIN items i ON i.rowid = f.rowid JOIN sources s ON s.id = i.source_id
         WHERE items_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ? OFFSET ?`
      : `SELECT i.*, s.name AS source_name, s.kind AS source_kind, '' AS snip FROM items i JOIN sources s ON s.id = i.source_id WHERE ${where.join(' AND ')} ORDER BY i.occurred_at DESC LIMIT ? OFFSET ?`;
    const words = wordsOf(q);
    return this.db.prepare(sql).all(...(match ? [match] : []), ...args, limit, offset).map((r) => ({ ...itemRow(r), text: undefined, preview: r.text.slice(0, 280), snippet: match ? makeSnippet(r.text, words) : '', sourceName: r.source_name, sourceKind: r.source_kind }));
  }

  count({ includeMeetings = false } = {}) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL ${includeMeetings ? '' : "AND kind <> 'meeting'"}`).get().n;
  }

  // ---------- meetings as items ----------
  // One item per note, so everything in the app can be reached the same way. The note keeps its own text.
  syncNote(noteId) {
    const n = this.db.prepare('SELECT id, title, source, source_ref, created_at FROM notes WHERE id = ?').get(noteId);
    if (!n) return null;
    const kind = ['notion', 'obsidian', 'linear'].includes(n.source) ? n.source : NATIVE;
    const src = this.ensureSource(kind, { name: { native: 'Recordings and imports', notion: 'Notion', obsidian: 'Obsidian', linear: 'Linear' }[kind] });
    return this.upsert(src.id, { externalId: `note:${n.id}`, kind: 'meeting', title: n.title, text: '', hash: sha(`${n.title}`), noteId: n.id, occurredAt: n.created_at, meta: { source: n.source, ref: n.source_ref } }).item;
  }

  // Meetings made before items existed: one item each. Returns how many notes were done (call again until it returns 0).
  backfillNotes(batch = 200) {
    const rows = this.db.prepare(`SELECT id FROM notes WHERE id NOT IN (SELECT note_id FROM items WHERE note_id IS NOT NULL) LIMIT ?`).all(batch);
    this.db.exec('BEGIN');
    try { for (const r of rows) this.syncNote(r.id); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }

}

const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const wordsOf = (q) => (fold(q).match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);

// A few words around the first match, the matches in <mark> (the contentless index cannot make snippets, so it is done here)
function makeSnippet(text, words, before = 60, after = 110) {
  if (!words.length) return '';
  const plain = fold(text);
  let at = -1;
  for (const w of words) { const i = plain.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return '';
  const from = Math.max(0, at - before), to = Math.min(text.length, at + after);
  const slice = text.slice(from, to).replace(/\s/g, ' ');
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const folded = fold(slice);
  let out = '';
  if (folded.length === slice.length) {            // one character each: matches in the folded text sit at the same places in the original
    const spans = [];
    for (const w of words) for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
    spans.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [a, b] of spans) { if (a < pos) continue; out += esc(slice.slice(pos, a)) + '<mark>' + esc(slice.slice(a, b)) + '</mark>'; pos = b; }
    out += esc(slice.slice(pos));
  } else out = esc(slice);
  return `${from > 0 ? '… ' : ''}${out}${to < text.length ? ' …' : ''}`;
}

// a person's words → a safe FTS5 query: every word a prefix match, nothing that could be read as syntax
function ftsQuery(q) {
  const words = String(q || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.length ? words.slice(0, 12).map((w) => `"${w}"*`).join(' ') : '';
}

module.exports = { ItemStore, NATIVE, KINDS, sha, ftsQuery };
