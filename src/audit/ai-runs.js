'use strict';
// The AI-run ledger (the egress log): every call to an AI server, which lane asked, which server, whether that server is on this
// computer, how much text went in and came out, how long it took. Never the text itself. "What left this computer?" is answered
// from here: a call to a server that is not local counts as having left it.
const { isLocalUrl } = require('../core/policy');

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || '').slice(0, 80); } };
const charsOf = (messages) => (messages || []).reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);

class AiRuns {
  constructor(db, { now = () => Date.now(), keepDays = 90 } = {}) { this.db = db; this.now = now; this.keepMs = keepDays * 86_400_000; }

  // sources: the ids of the sources whose material the call carried (which mail, chat or folder left for which server)
  record({ lane, config, messages, charsOut = 0, ms = 0, ok = true, error = null, sources = null }) {
    const url = config?.baseUrl || '';
    const ids = Array.isArray(sources) ? [...new Set(sources.filter(Boolean).map(String))].slice(0, 30).join(',') : '';
    try {
      this.db.prepare('INSERT INTO ai_runs (at, lane, model, host, local, chars_in, chars_out, ms, ok, error, source_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.now(), String(lane), String(config?.model || ''), hostOf(url), isLocalUrl(url) ? 1 : 0, charsOf(messages), charsOut, Math.round(ms), ok ? 1 : 0, error ? String(error).slice(0, 300) : null, ids);
    } catch { /* the ledger must never break an AI call (a closed database, for one) */ }
  }

  list(limit = 100) {
    return this.db.prepare('SELECT * FROM ai_runs ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ id: r.id, at: r.at, lane: r.lane, model: r.model, host: r.host, local: !!r.local, charsIn: r.chars_in, charsOut: r.chars_out, ms: r.ms, ok: !!r.ok, error: r.error, sources: r.source_ids ? r.source_ids.split(',') : [] }));
  }

  // { total, remote, remoteChars, since } for the last `days` days
  summary(days = 30) {
    const since = this.now() - days * 86_400_000;
    const r = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(local = 0), 0) AS remote, COALESCE(SUM(CASE WHEN local = 0 THEN chars_in ELSE 0 END), 0) AS remoteChars, COALESCE(SUM(ok = 0), 0) AS failed FROM ai_runs WHERE at >= ?').get(since);
    return { ...r, since };
  }

  prune() { return this.db.prepare('DELETE FROM ai_runs WHERE at < ?').run(this.now() - this.keepMs).changes; }
}

module.exports = { AiRuns, charsOf, hostOf };
