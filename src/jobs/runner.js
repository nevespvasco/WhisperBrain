'use strict';
// Runs the jobs in the queue (src/jobs/queue.js) one at a time, in the order they may run. A handler is
// `async (payload, { job, enqueue }) => result`; it may enqueue the next step of a chain. Throwing fails the attempt (the queue
// retries with a back-off); an error with `permanent: true` fails the job at once.
// Every attempt has a deadline (DEADLINE_MS, or the kind's own `deadlineMs`): then ctx.signal aborts, so an AI call that was handed
// the signal stops, and the attempt fails with code 'deadline' even if the handler ignores the signal, so one stuck call (a hung AI
// server) never stops the lane for good.
// paused(lane): while true that lane claims nothing new (the app pauses the AI jobs while the live assistant holds the AI queue), and a
// deadline that falls in a pause waits for it to end: time spent waiting behind the hold is not the job's fault.
// The runner lives in the main process for now; nothing here depends on that, so it can move to a utilityProcess later.

const DEADLINE_MS = 15 * 60_000;   // generous: a long meeting's summary on a slow local model takes minutes, never a quarter of an hour

class JobRunner {
  constructor({ queue, onError = null, setTimer = setTimeout, clearTimer = clearTimeout, deadlineMs = DEADLINE_MS, paused = () => false, pausePollMs = 5000 } = {}) {
    this.queue = queue;
    this.paused = paused;
    this.pausePollMs = pausePollMs;
    this.pauseTimer = null;
    this.deadlineMs = deadlineMs;
    this.deadlineOf = {};
    this.overrun = new Map();   // kind -> handlers still running after their deadline (see runOne): that kind claims nothing until they end
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
  // the kinds that may start now: one whose earlier attempt passed its deadline but is still running is not started a second time
  ready(lane = null) { return this.kinds(lane).filter((k) => !this.overrun.get(k)); }

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
    if (this.pauseTimer) this.clearTimer(this.pauseTimer);
    this.timer = this.pauseTimer = null;
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
        if (this.paused(name)) { this.wakeAfterPause(); break; }
        let job;
        try { const kinds = this.ready(name); if (!kinds.length) break; job = this.queue.claim(kinds); } catch (e) { this.onError?.(null, e); break; }
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

  // Nothing says when a pause ends: look again shortly
  wakeAfterPause() {
    if (this.pauseTimer || !this.running) return;
    this.pauseTimer = this.setTimer(() => { this.pauseTimer = null; this.kick(); }, this.pausePollMs);
    this.pauseTimer?.unref?.();
  }

  async runOne(job) {
    const ac = new AbortController();
    const ctx = { job, signal: ac.signal, enqueue: (kind, payload, opts) => this.queue.enqueue(kind, payload, opts) };
    const ms = this.deadlineOf[job.kind] || this.deadlineMs;
    let timer = null;
    const lane = this.laneOf[job.kind] || 'main';
    const deadline = new Promise((_, reject) => {
      const fire = () => {
        if (this.paused(lane)) { timer = this.setTimer(fire, this.pausePollMs); timer?.unref?.(); return; }
        const err = Object.assign(new Error(`${job.kind} took longer than ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`} and was stopped.`), { code: 'deadline' });
        ac.abort(err);
        reject(err);
      };
      timer = this.setTimer(fire, ms);
      timer?.unref?.();
    });
    // a handler that ignores ctx.signal goes on after its deadline: the attempt fails and the lane moves on, but the same kind is not
    // started again until that handler has really ended (two copies of one job at once would do its work twice)
    let handled = null, timedOut = false;
    try {
      handled = (async () => this.handlers[job.kind](job.payload, ctx))();
      const result = await Promise.race([handled, deadline.catch((e) => { timedOut = true; throw e; })]);
      try { this.queue.complete(job.id, result ?? null); } catch { /* the database closed under us: the job runs again at next start */ }
    } catch (err) {
      try { this.queue.fail(job.id, err, { retry: !err?.permanent }); } catch { /* as above */ }
      this.onError?.(job, err);
      if (timedOut && handled) {
        this.overrun.set(job.kind, (this.overrun.get(job.kind) || 0) + 1);
        const ended = () => { const n = (this.overrun.get(job.kind) || 1) - 1; if (n) this.overrun.set(job.kind, n); else this.overrun.delete(job.kind); this.kick(); };
        handled.then(ended, ended);
      }
    } finally {
      this.clearTimer(timer);
    }
  }

  // Wake up when the next delayed job (a retry after a back-off) may run.
  schedule() {
    if (!this.running) return;
    let at = null;
    try { const kinds = this.ready(); if (!kinds.length) return; at = this.queue.nextRunAt(kinds); } catch { return; }
    if (at == null) return;
    const wait = Math.max(0, at - Date.now());
    if (wait === 0) { this.kick(); return; }
    this.timer = this.setTimer(() => { this.timer = null; this.kick(); }, wait);
    this.timer?.unref?.();
  }
}

module.exports = { JobRunner, DEADLINE_MS };
