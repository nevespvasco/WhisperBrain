'use strict';
// Durable background work. Every unit of work the app does on its own (the steps after a recording, later imports, syncs,
// indexing) is a row in `jobs`, so quitting midway loses nothing: a job that was running when the app quit is queued again
// at the next start and runs from its beginning. Jobs therefore must be safe to run twice (docs/adr/0001-brain-data-model.md).
//
// States: queued → running → done | failed | cancelled. A failure with attempts left goes back to queued with a back-off.
// `key` deduplicates: while a job of the same kind and key is queued or running, enqueueing it again returns that one.

const STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];   // after the 1st, 2nd, 3rd... failure (the last value repeats)
const LEASE_MS = 10 * 60_000;                            // a running job not finished by then is considered abandoned
const KEEP_FINISHED_MS = 14 * 86_400_000;                // done/cancelled rows are kept two weeks for the Activity page

class JobQueue {
  constructor(db, { now = () => Date.now(), bus = null, backoff = BACKOFF_MS } = {}) {
    this.backoff = backoff;
    this.db = db;
    this.now = now;
    this.bus = bus;
  }

  enqueue(kind, payload = {}, { key = null, runAfter = 0, maxAttempts = 3 } = {}) {
    if (!kind || typeof kind !== 'string') throw new Error('a job needs a kind');
    if (key != null) {
      const live = this.db.prepare("SELECT * FROM jobs WHERE kind = ? AND key = ? AND state IN ('queued', 'running')").get(kind, String(key));
      if (live) return toJob(live);
    }
    const t = this.now();
    const r = this.db.prepare(`INSERT INTO jobs (kind, key, payload, state, attempts, max_attempts, run_after, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`).run(kind, key == null ? null : String(key), JSON.stringify(payload ?? {}), Math.max(1, maxAttempts | 0), t + Math.max(0, runAfter | 0), t, t);
    const job = this.get(Number(r.lastInsertRowid));
    this.emit(job);
    return job;
  }

  get(id) { const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); return row ? toJob(row) : null; }

  // The next job that may run now, marked running with a lease (or null). kinds: only these (the handlers that exist).
  claim(kinds = null) {
    const t = this.now();
    const filter = kinds?.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    const row = this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? ${filter} ORDER BY run_after, id LIMIT 1`).get(t, ...(kinds || []));
    if (!row) return null;
    const ok = this.db.prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_until = ?, started_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
      .run(t + LEASE_MS, t, t, row.id).changes;
    if (!ok) return null;
    const job = this.get(row.id);
    this.emit(job);
    return job;
  }

  complete(id, result = null) {
    const t = this.now();
    this.db.prepare("UPDATE jobs SET state = 'done', result = ?, last_error = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(result == null ? null : JSON.stringify(result), t, t, id);
    this.emit(this.get(id));
  }

  // A failed attempt: back to queued with a back-off while attempts are left, otherwise failed for good.
  fail(id, error, { retry = true } = {}) {
    const job = this.get(id);
    if (!job) return null;
    const t = this.now();
    const message = String(error?.message || error || 'failed').slice(0, 2000);
    const again = retry && job.attempts < job.maxAttempts;
    const wait = this.backoff[Math.min(job.attempts - 1, this.backoff.length - 1)] || this.backoff[0];
    this.db.prepare(`UPDATE jobs SET state = ?, last_error = ?, lease_until = NULL, run_after = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(again ? 'queued' : 'failed', message, again ? t + wait : job.runAfter, again ? null : t, t, id);
    const out = this.get(id);
    this.emit(out);
    return out;
  }

  // At start (nothing can be running yet) or when a lease ran out: those jobs are queued again, keeping their attempt count.
  recover({ all = false } = {}) {
    const t = this.now();
    const cond = all ? "state = 'running'" : "state = 'running' AND lease_until < ?";
    const ids = this.db.prepare(`SELECT id FROM jobs WHERE ${cond}`).all(...(all ? [] : [t])).map((r) => r.id);
    for (const id of ids) this.db.prepare("UPDATE jobs SET state = 'queued', lease_until = NULL, updated_at = ? WHERE id = ?").run(t, id);
    return ids.length;
  }

  // A failed or cancelled job, run again now (with a fresh set of attempts).
  retry(id) {
    const job = this.get(id);
    if (!job) return null;
    if (!['failed', 'cancelled'].includes(job.state)) throw new Error(`a ${job.state} job cannot be retried`);
    const t = this.now();
    this.db.prepare("UPDATE jobs SET state = 'queued', attempts = 0, run_after = ?, last_error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?").run(t, t, id);
    const out = this.get(id);
    this.emit(out);
    return out;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job || job.state !== 'queued') return job;   // a running job finishes; only waiting ones are cancelled
    const t = this.now();
    this.db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
    const out = this.get(id);
    this.emit(out);
    return out;
  }

  // When the next queued job may run (ms since epoch), or null when nothing waits.
  nextRunAt(kinds = null) {
    const filter = kinds?.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT MIN(run_after) AS t FROM jobs WHERE state = 'queued' ${filter}`).get(...(kinds || [])).t ?? null;
  }

  list({ state = null, limit = 100 } = {}) {
    const rows = state && STATES.includes(state)
      ? this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(state, limit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit);
    return rows.map(toJob);
  }

  counts() {
    const out = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all()) out[r.state] = r.n;
    return out;
  }

  // Old finished rows go; failed ones stay until retried or the person clears them.
  prune() {
    return this.db.prepare("DELETE FROM jobs WHERE state IN ('done', 'cancelled') AND finished_at < ?").run(this.now() - KEEP_FINISHED_MS).changes;
  }

  emit(job) { if (job) this.bus?.publish('job.changed', { id: job.id, kind: job.kind, state: job.state, attempts: job.attempts, error: job.error }); }
}

function toJob(r) {
  const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
  return {
    id: r.id, kind: r.kind, key: r.key, payload: parse(r.payload) || {}, state: r.state, attempts: r.attempts, maxAttempts: r.max_attempts,
    runAfter: r.run_after, leaseUntil: r.lease_until, error: r.last_error, result: parse(r.result),
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at,
  };
}

module.exports = { JobQueue, STATES, BACKOFF_MS, LEASE_MS };
