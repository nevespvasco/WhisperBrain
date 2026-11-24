'use strict';
// The evidence a meeting's names are based on (table `evidence`, see migration v10). Rows are plain objects:
//   { kind, source, key, name, t0, t1, weight, meta }   key = the name folded for comparison; meta = anything JSON
const KINDS = ['highlight', 'roster', 'caption', 'stream', 'transcript', 'calendar'];

class Evidence {
  constructor(db) { this.db = db; }

  add(noteId, rows) {
    for (const r of rows) if (!KINDS.includes(r.kind)) throw new Error(`evidence kind must be one of ${KINDS.join(', ')}`);
    if (!rows.length) return 0;
    const stmt = this.db.prepare('INSERT INTO evidence(note_id, kind, source, participant_key, name, t0, t1, weight, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) stmt.run(noteId, r.kind, r.source || '', r.key || '', String(r.name || '').slice(0, 120), r.t0 ?? null, r.t1 ?? null, r.weight ?? 1, r.meta ? JSON.stringify(r.meta) : null);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }

  forNote(noteId, { kind } = {}) {
    const rows = this.db.prepare(`SELECT id, kind, source, participant_key AS key, name, t0, t1, weight, meta FROM evidence WHERE note_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY id`).all(...(kind ? [noteId, kind] : [noteId]));
    return rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
  }

  // Drop some kinds (all of them without `kinds`), e.g. before a source's evidence is written again.
  clear(noteId, { kinds } = {}) {
    if (!kinds) return this.db.prepare('DELETE FROM evidence WHERE note_id = ?').run(noteId).changes;
    const q = kinds.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM evidence WHERE note_id = ? AND kind IN (${q})`).run(noteId, ...kinds).changes;
  }
}

module.exports = { Evidence, KINDS };
