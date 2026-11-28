'use strict';
// Runs the jobs in the queue (src/jobs/queue.js) one at a time, in the order they may run. A handler is
// `async (payload, { job, enqueue }) => result`; it may enqueue the next step of a chain. Throwing fails the attempt (the queue
// retries with a back-off); an error with `permanent: true` fails the job at once.
// Every attempt has a deadline (DEADLINE_MS, or the kind's own `deadlineMs`): then ctx.signal aborts, so an AI call that was handed
// the signal stops, and the attempt fails with code 'deadline' even if the handler ignores the signal, so one stuck call (a hung AI
// server) never stops the lane for good.
// The runner lives in the main process for now; nothing here depends on that, so it can move to a utilityProcess later.

const DEADLINE_MS = 15 * 60_000;   // generous: a long meeting's summary on a slow local model takes minutes, never a quarter of an hour

class JobRunner {
  constructor({ queue, onError = null, setTimer = setTimeout, clearTimer = clearTimeout, deadlineMs = DEADLINE_MS } = {}) {
    this.queue = queue;
    this.deadlineMs = deadlineMs;
    this.deadlineOf = {};
    this.handlers = {};
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.running = false;
    this.lanes = { main: { busy: false, current: null } };
    this.laneOf = {};
    this.timer = null;
  }

  // lane: handlers in different lanes run at the same time (one job at a time within a lane). The default lane is 'main'.
  // deadlineMs: this kind's own deadline per attempt (see the top of this file).
  register(kind, fn, { lane = 'main', deadlineMs } = {}) {
    this.handlers[kind] = fn;
    if (deadlineMs) this.deadlineOf[kind] = deadlineMs;
    this.laneOf[kind] = lane;
    this.lanes[lane] ||= { busy: false, current: null };
    return this;
  }

  kinds(lane = null) { return Object.keys(this.handlers).filter((k) => !lane || this.laneOf[k] === lane); }

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
    return Promise.all(Object.values(this.lanes).map((l) => l.current).filter(Boolean));
  }

  kick() {
    if (!this.running) return;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    for (const [name, lane] of Object.entries(this.lanes)) {
      if (lane.busy) continue;
      lane.busy = true;
      setImmediate(() => this.loop(name));
    }
  }

  // Resolves once nothing queued may run now (for tests and for a clean shutdown).
  async idle() {
    while (Object.values(this.lanes).some((l) => l.busy || l.current)) await new Promise((r) => setImmediate(r));
  }

  async loop(name) {
    const lane = this.lanes[name];
    try {
      while (this.running) {
        let job;
        try { job = this.queue.claim(this.kinds(name)); } catch (e) { this.onError?.(null, e); break; }
        if (!job) break;
        lane.current = this.runOne(job);
        await lane.current;
        lane.current = null;
      }
    } finally {
      lane.busy = false;
      this.schedule();
    }
  }

  async runOne(job) {
    const ac = new AbortController();
    const ctx = { job, signal: ac.signal, enqueue: (kind, payload, opts) => this.queue.enqueue(kind, payload, opts) };
    const ms = this.deadlineOf[job.kind] || this.deadlineMs;
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = this.setTimer(() => {
        const err = Object.assign(new Error(`${job.kind} took longer than ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`} and was stopped.`), { code: 'deadline' });
        ac.abort(err);
        reject(err);
      }, ms);
      timer?.unref?.();
    });
    try {
      const result = await Promise.race([this.handlers[job.kind](job.payload, ctx), deadline]);
      try { this.queue.complete(job.id, result ?? null); } catch { /* the database closed under us: the job runs again at next start */ }
    } catch (err) {
      try { this.queue.fail(job.id, err, { retry: !err?.permanent }); } catch { /* as above */ }
      this.onError?.(job, err);
    } finally {
      this.clearTimer(timer);
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

module.exports = { JobRunner, DEADLINE_MS };
