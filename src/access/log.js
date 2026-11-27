'use strict';
// The access log (docs/access.md): grant changes, live searches sent to a service, and actions run on a service. It records what
// happened and to which source, never the content (no mail text, no message bodies). What an AI server was given is in the AI-run
// ledger (src/audit/ai-runs.js), with the sources each call carried.
class AccessLog {
  constructor(db, { now = () => Date.now(), keepDays = 365 } = {}) { this.db = db; this.now = now; this.keepMs = keepDays * 86_400_000; }

  add({ sourceId = null, op, detail = '' }) {
    try { this.db.prepare('INSERT INTO access_log (at, source_id, op, detail) VALUES (?, ?, ?, ?)').run(this.now(), sourceId, String(op).slice(0, 60), String(detail).slice(0, 300)); } catch { /* the log never breaks what it records */ }
  }

  list({ sourceId, limit = 100 } = {}) {
    const rows = sourceId ? this.db.prepare('SELECT * FROM access_log WHERE source_id = ? ORDER BY id DESC LIMIT ?').all(sourceId, limit) : this.db.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ id: r.id, at: r.at, sourceId: r.source_id, op: r.op, detail: r.detail }));
  }

  // Forget the entries of a source that was removed (its name is gone; what was done stays countable in the ledger of AI calls).
  forgetSource(sourceId) { return this.db.prepare('DELETE FROM access_log WHERE source_id = ?').run(sourceId).changes; }

  prune() { return this.db.prepare('DELETE FROM access_log WHERE at < ?').run(this.now() - this.keepMs).changes; }
}

module.exports = { AccessLog };
