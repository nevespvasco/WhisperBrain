'use strict';
// Runs the jobs in the queue (src/jobs/queue.js) one at a time, in the order they may run. A handler is
// `async (payload, { job, enqueue }) => result`; it may enqueue the next step of a chain. Throwing fails the attempt (the queue
// retries with a back-off); an error with `permanent: true` fails the job at once.
// The runner lives in the main process for now; nothing here depends on that, so it can move to a utilityProcess later.

class JobRunner {
  constructor({ queue, onError = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.queue = queue;
    this.handlers = {};
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.current = null;
  }

  register(kind, fn) { this.handlers[kind] = fn; return this; }

  kinds() { return Object.keys(this.handlers); }

  // Queue a job and make sure it runs soon (see JobQueue.enqueue for the options).
  enqueue(kind, payload, opts) {
    const job = this.queue.enqueue(kind, payload, opts);
    this.kick();
    return job;
  }

  // Jobs left running by a previous run of the app are queued again first: nothing else can be running at start.
  start() {
    if (this.running) return;
    this.running = true;
    try { this.queue.recover({ all: true }); this.queue.prune(); } catch (e) { this.onError?.(null, e); }
    this.kick();
  }

  // Stop taking new jobs. The one in progress is left to finish (or, if the app closes first, to be run again at next start).
  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    return this.current || Promise.resolve();
  }

  kick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    setImmediate(() => this.loop());
  }

  // Resolves once nothing queued may run now (for tests and for a clean shutdown).
  async idle() {
    while (this.busy || this.current) await new Promise((r) => setImmediate(r));
  }

  async loop() {
    try {
      while (this.running) {
        let job;
        try { job = this.queue.claim(this.kinds()); } catch (e) { this.onError?.(null, e); break; }
        if (!job) break;
        this.current = this.runOne(job);
        await this.current;
        this.current = null;
      }
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  async runOne(job) {
    const ctx = { job, enqueue: (kind, payload, opts) => this.queue.enqueue(kind, payload, opts) };
    try {
      const result = await this.handlers[job.kind](job.payload, ctx);
      try { this.queue.complete(job.id, result ?? null); } catch { /* the database closed under us: the job runs again at next start */ }
    } catch (err) {
      try { this.queue.fail(job.id, err, { retry: !err?.permanent }); } catch { /* as above */ }
      this.onError?.(job, err);
    }
  }

  // Wake up when the next delayed job (a retry after a back-off) may run.
  schedule() {
    if (!this.running) return;
    let at = null;
    try { at = this.queue.nextRunAt(this.kinds()); } catch { return; }
    if (at == null) return;
    const wait = Math.max(0, at - Date.now());
    if (wait === 0) { this.kick(); return; }
    this.timer = this.setTimer(() => { this.timer = null; this.kick(); }, wait);
    this.timer?.unref?.();
  }
}

module.exports = { JobRunner };
