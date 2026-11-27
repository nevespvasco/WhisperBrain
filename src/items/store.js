'use strict';
// Sources and items (docs/adr/0001-brain-data-model.md). A source is where material comes from; an item is one thing from it.
// Syncing the same thing again updates its item instead of making a second one: (source_id, external_id) is unique and a content
// hash says whether anything changed. What disappeared from the source is tombstoned (deleted_at), never silently kept as live.
// A meeting is an item of kind 'meeting' pointing at its notes row; it holds no text of its own.
const crypto = require('node:crypto');
const { ftsRun } = require('../core/fts');
const { grantColumns, grantOf } = require('../access/grants');

const NATIVE = 'native';                                   // the recorder and the app's own meetings
const MAX_TEXT = 400_000;                                  // derived text kept per item (pointer mode keeps the text for search, not the file)
const KINDS = ['native', 'folder', 'obsidian', 'notion', 'linear', 'github', 'slack', 'discord', 'gmail', 'mbox', 'outlook', 'imap'];

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const srcRow = (r) => !r ? null : ({
  id: r.id, kind: r.kind, name: r.name, mode: r.mode, sensitivity: r.sensitivity, config: parse(r.config, {}), enabled: !!r.enabled,
  cursor: r.cursor, lastSyncAt: r.last_sync_at, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
  // the access grant (src/access/grants.js)
  readLevel: r.read_level || 'all', filter: parse(r.filter, {}), actions: parse(r.actions, []), autoActions: parse(r.auto_actions, []),
  aiReach: r.ai_reach || (r.sensitivity === 'private' ? 'local' : 'any'), liveSearch: !!r.live_search, mcp: !!r.mcp, retentionDays: r.retention_days ?? 7, expiresAt: r.expires_at ?? null,
});
const itemRow = (r) => !r ? null : ({
  id: r.id, sourceId: r.source_id, externalId: r.external_id, kind: r.kind, title: r.title, text: r.text, hash: r.hash, uri: r.uri, path: r.path,
  meta: parse(r.meta, {}), noteId: r.note_id, occurredAt: r.occurred_at, ingestedAt: r.ingested_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  aiReach: r.ai_reach || null, origin: r.origin || 'sync', expiresAt: r.expires_at ?? null, pinned: !!r.pinned,
});

class ItemStore {
  constructor(db, { bus = null, now = () => Date.now() } = {}) { this.db = db; this.bus = bus; this.now = now; }

  // ---------- sources ----------
  // grant: { readLevel, filter, actions, autoActions, aiReach, liveSearch, mcp, retentionDays, expiresAt } (src/access/grants.js).
  // Without one: everything may be read, private stays local, and MCP serves only what is not private (what the app did before grants).
  addSource({ kind, name = '', mode = 'pointer', sensitivity = 'normal', config = {}, id, grant = {} } = {}) {
    if (!KINDS.includes(kind)) throw Object.assign(new Error(`unknown source kind "${kind}"`), { status: 400 });
    const t = this.now();
    const sid = id || newId('src');
    const cols = grantColumns({ sensitivity, mcp: sensitivity !== 'private', ...grant });
    const names = Object.keys(cols).filter((c) => c !== 'sensitivity');
    this.db.prepare(`INSERT INTO sources (id, kind, name, mode, sensitivity, config, created_at, updated_at${names.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${names.map(() => ', ?').join('')})`)
      .run(sid, kind, String(name).slice(0, 120), mode, cols.sensitivity || sensitivity, JSON.stringify(config), t, t, ...names.map((c) => cols[c]));
    this.touchReview(sid);
    this.bus?.publish('sources.changed', { id: sid });
    return this.source(sid);
  }

  // When a grant was last made or changed: the 90-day review counts from here (a sync that merely updates the row does not count)
  touchReview(id) { try { this.db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`access:review:${id}`, String(this.now())); } catch { /* closing */ } }

  // Change what a source is granted. Narrowing what may be read drops what is no longer allowed at once (the bodies at 'metadata',
  // everything at 'none'): a downgrade that left the text behind would only look like one.
  setGrant(id, patch = {}) {
    const cur = this.source(id);
    if (!cur) return null;
    const cols = grantColumns(patch);
    const names = Object.keys(cols);
    if (names.length) this.db.prepare(`UPDATE sources SET ${names.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...names.map((c) => cols[c]), this.now(), id);
    const next = this.source(id);
    this.touchReview(id);
    let purged = 0;
    if (next.readLevel === 'none') purged = this.purgeSource(id, { keepSource: true });
    else if (next.readLevel === 'metadata' && cur.readLevel !== 'metadata') purged = this.dropBodies(id);
    this.bus?.publish('sources.changed', { id });
    return { ...next, purged };
  }

  // Keep who/when/subject, forget the text: the item stays (people, last contact) but nothing of its body is searchable any more.
  dropBodies(sourceId) {
    const rows = this.db.prepare("SELECT rowid, id, title FROM items WHERE source_id = ? AND kind <> 'meeting' AND text <> ''").all(sourceId);
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.db.prepare("UPDATE items SET text = '', hash = '', updated_at = ? WHERE id = ?").run(this.now(), r.id);
        this.index(r.rowid, r.title, '');
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.bus?.publish('items.purged', { sourceId, bodies: rows.length });
    return rows.length;
  }

  // Forget everything read from a source (items, their search entries; the chunk index follows through items.purged). The source
  // row itself goes too unless keepSource. Unlike a tombstone nothing is kept: this is for revoking access.
  purgeSource(sourceId, { keepSource = false } = {}) {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(sourceId).n;
    this.db.exec('BEGIN');
    try {
      ftsRun(this.db, 'DELETE FROM items_fts WHERE rowid IN (SELECT rowid FROM items WHERE source_id = ?)', sourceId);
      this.db.prepare('DELETE FROM items WHERE source_id = ?').run(sourceId);
      if (keepSource) this.db.prepare('UPDATE sources SET cursor = NULL, updated_at = ? WHERE id = ?').run(this.now(), sourceId);
      else this.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.bus?.publish('items.purged', { sourceId, all: true });
    return n;
  }

  // Keep a body that was opened from a live search: it no longer expires.
  pin(id) { this.db.prepare("UPDATE items SET pinned = 1, expires_at = NULL WHERE id = ? AND origin = 'live'").run(id); return this.item(id); }

  // Live copies past their time (and not kept) go for good. -> how many
  purgeExpired(now = this.now()) {
    const ids = this.db.prepare("SELECT id FROM items WHERE origin = 'live' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?").all(now).map((r) => r.id);
    for (const id of ids) this.purgeItem(id);
    return ids.length;
  }

  // Forget one item for good (no tombstone): its search entries and links go with it.
  purgeItem(id) {
    const row = this.db.prepare('SELECT rowid FROM items WHERE id = ?').get(id);
    if (!row) return false;
    ftsRun(this.db, 'DELETE FROM items_fts WHERE rowid = ?', row.rowid);
    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
    this.bus?.publish('items.purged', { itemId: id });
    return true;
  }

  // Addresses forgotten on purpose (Forget a person): connectors never read them again.
  blocked() { return this.db.prepare('SELECT address FROM blocked_addresses').all().map((r) => r.address); }
  unblock(address) { return this.db.prepare('DELETE FROM blocked_addresses WHERE address = ?').run(String(address).toLowerCase()).changes > 0; }

  // One item kept stricter than its source ('local' / 'ask'), or back to its source's rule (null).
  setItemReach(id, aiReach) {
    if (aiReach !== null && !['local', 'ask', 'any'].includes(aiReach)) throw Object.assign(new Error('aiReach must be local, ask, any or null'), { status: 400 });
    this.db.prepare('UPDATE items SET ai_reach = ? WHERE id = ?').run(aiReach, id);
    return this.item(id);
  }

  // The source a note (meeting) belongs to: the recorder's, or the Notion / Linear / Obsidian import source.
  sourceOfNote(noteId) {
    const r = this.db.prepare('SELECT s.* FROM items i JOIN sources s ON s.id = i.source_id WHERE i.note_id = ?').get(noteId);
    return r ? srcRow(r) : null;
  }

  grant(id) { return grantOf(this.source(id)); }

  source(id) { return srcRow(this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id)); }

  sources() {
    const counts = new Map(this.db.prepare('SELECT source_id, COUNT(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY source_id').all().map((r) => [r.source_id, r.n]));
    return this.db.prepare('SELECT * FROM sources ORDER BY (kind = ?) DESC, created_at').all(NATIVE).map(srcRow).map((s) => ({ ...s, items: counts.get(s.id) || 0 }));
  }

  // Where meetings come from (the recorder, or a Notion/Obsidian/Linear import): one fixed source each, made when first needed.
  // These hold meeting items only and have no folder: a vault someone adds as a source is a different source of the same kind.
  ensureSource(kind, defaults = {}) {
    const id = kind === NATIVE ? 'src_native' : `src_imports_${kind}`;
    return this.source(id) || this.addSource({ id, kind, name: defaults.name || kind, config: { imported: true } });
  }

  updateSource(id, patch) {
    const cur = this.source(id);
    if (!cur) return null;
    const sets = [], vals = [];
    const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if ('name' in patch) set('name', String(patch.name).slice(0, 120));
    if ('mode' in patch) { if (!['pointer', 'excerpt', 'copy'].includes(patch.mode)) throw Object.assign(new Error('mode must be pointer, excerpt or copy'), { status: 400 }); set('mode', patch.mode); }
    if ('sensitivity' in patch) { const g = grantColumns({ sensitivity: patch.sensitivity }); set('sensitivity', g.sensitivity); set('ai_reach', g.ai_reach); }
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
      ftsRun(this.db, 'DELETE FROM items_fts WHERE rowid IN (SELECT rowid FROM items WHERE source_id = ?)', id);
      this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.bus?.publish('sources.changed', { id });
    this.bus?.publish('items.purged', { sourceId: id, all: true });   // the search index forgets them now
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
  // metaInHash: what is in `meta` counts as content (a label, a state, who wrote last): a change to it updates the item even when the text is the same
  // origin 'live' + expiresAt: a body opened from a live search; it goes away on its own unless pinned (Keep). A synced copy is never made 'live'.
  upsert(sourceId, { externalId, kind = 'document', title = '', text = '', hash, uri = '', path = '', meta = {}, noteId = null, occurredAt, metaInHash = false, origin = 'sync', expiresAt = null } = {}) {
    if (externalId == null || externalId === '') throw new Error('an item needs an externalId');
    const clipped = String(text).slice(0, MAX_TEXT);
    const h = hash || sha(`${title}\n${clipped}${metaInHash ? `\n${JSON.stringify(meta)}` : ''}`);
    const t = this.now();
    const cur = this.db.prepare('SELECT * FROM items WHERE source_id = ? AND external_id = ?').get(sourceId, String(externalId));
    if (!cur) {
      const id = newId('it');
      const info = this.db.prepare(`INSERT INTO items (id, source_id, external_id, kind, title, text, hash, uri, path, meta, note_id, occurred_at, ingested_at, updated_at, origin, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sourceId, String(externalId), kind, String(title).slice(0, 300), clipped, h, uri, path, JSON.stringify(meta), noteId, occurredAt || t, t, t, origin === 'live' ? 'live' : 'sync', origin === 'live' ? expiresAt : null);
      if (kind !== 'meeting') this.index(Number(info.lastInsertRowid), title, clipped);   // a meeting has no text here: its own notes are searched
      return { action: 'created', item: this.item(id) };
    }
    if (cur.hash === h && !cur.deleted_at && cur.title === String(title).slice(0, 300) && cur.uri === uri && cur.path === path && cur.note_id === noteId) {
      if (origin === 'sync' && cur.origin === 'live') this.db.prepare("UPDATE items SET origin = 'sync', expires_at = NULL, pinned = 0 WHERE id = ?").run(cur.id);
      else if (origin === 'live' && cur.origin === 'live' && !cur.pinned && expiresAt) this.db.prepare('UPDATE items SET expires_at = ? WHERE id = ?').run(expiresAt, cur.id);
      return { action: 'unchanged', item: itemRow(cur) };
    }
    const revived = !!cur.deleted_at;
    if (origin === 'sync' && cur.origin === 'live') this.db.prepare("UPDATE items SET origin = 'sync', expires_at = NULL, pinned = 0 WHERE id = ?").run(cur.id);   // the sync now reads it too: it is a normal copy
    this.db.prepare(`UPDATE items SET kind = ?, title = ?, text = ?, hash = ?, uri = ?, path = ?, meta = ?, note_id = ?, occurred_at = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`)
      .run(kind, String(title).slice(0, 300), clipped, h, uri, path, JSON.stringify(meta), noteId, occurredAt || cur.occurred_at, t, cur.id);
    const rowid = this.db.prepare('SELECT rowid FROM items WHERE id = ?').get(cur.id).rowid;
    if (kind !== 'meeting') this.index(rowid, title, clipped);
    return { action: revived ? 'revived' : 'updated', item: this.item(cur.id) };
  }

  // the file's modified time and size, remembered so the next scan can skip it when they have not changed
  setMeta(id, meta) { this.db.prepare('UPDATE items SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id); }

  index(rowid, title, text) {
    ftsRun(this.db, 'DELETE FROM items_fts WHERE rowid = ?', rowid);
    ftsRun(this.db, 'INSERT INTO items_fts (rowid, title, text) VALUES (?, ?, ?)', rowid, title, text);
  }

  // The thing is gone from its source: keep a tombstone (so a restore is "revived", and nothing else is lost), drop it from search.
  tombstone(sourceId, externalId) {
    const cur = this.db.prepare('SELECT rowid, * FROM items WHERE source_id = ? AND external_id = ? AND deleted_at IS NULL').get(sourceId, String(externalId));
    if (!cur) return false;
    this.db.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(this.now(), this.now(), cur.id);
    ftsRun(this.db, 'DELETE FROM items_fts WHERE rowid = ?', cur.rowid);
    return true;
  }

  // After a full scan: every live item of this source that was not seen is tombstoned. Returns how many.
  tombstoneMissing(sourceId, seen) {
    let n = 0;
    for (const r of this.db.prepare("SELECT external_id FROM items WHERE source_id = ? AND deleted_at IS NULL AND origin = 'sync'").all(sourceId)) {   // a body opened live is not part of the listing
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
