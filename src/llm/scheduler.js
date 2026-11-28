'use strict';
// One queue in front of the AI server for every feature. Lower index in PRIORITIES runs first; FIFO within
// a priority. Priority decides who gets the next free slot, with one exception: the live assistant answers within seconds or not
// at all, so an assistant request that finds every slot taken stops a running PRE-EMPTIBLE request (summary, translation and
// background lanes) and that request is asked again, first in its lane, once a slot is free. Chat is never pre-empted: the user is
// reading that answer as it streams. A stream is pre-emptible only until its first words reach its consumer (after that it could
// not start over unseen); complete() shows nothing until the end, so it can always start over.
// hold(): while the live assistant is on during a recording, the summary and background lanes start nothing new except requests
// marked `live` (the meeting in progress: its live summary, term cards, names read off the meeting window).

const { isLocalUrl } = require('../core/policy');

const PRIORITIES = ['assistant', 'chat', 'summary', 'translation', 'background'];
const PREEMPTIBLE = new Set(['summary', 'translation', 'background']);   // the default for client(lane) requests
const HOLDABLE = new Set(['summary', 'background']);

function abortError(message = 'The AI request was cancelled.', code = 'aborted') {
  const e = new Error(message);
  e.name = 'AbortError';
  e.code = code;
  return e;
}

function checkPriority(priority) {
  if (!PRIORITIES.includes(priority)) throw new TypeError(`Unknown AI priority: ${priority}`);
}

class LlmScheduler {
  // llm: an LlmClient. concurrency: a number, or a function returning one, read whenever a slot is handed out.
  // Default: 1 for a server on this computer (Ollama has one slot; a second request only queues inside it,
  // out of our control), 2 for a remote one.
  // onRun: called after every AI request with { lane, config, messages, charsOut, ms, ok, error } (the ledger, src/audit/ai-runs.js)
  constructor(llm, { concurrency, onRun = null } = {}) {
    this.llm = llm;
    this.onRun = onRun;
    this.concurrency = concurrency ?? (() => (isLocalUrl(llm.getConfig()?.baseUrl) ? 1 : 2));
    this.running = 0;
    this.active = new Set();   // the jobs holding a slot
    this.starts = 0;
    this.holds = new Set();
    this.queues = Object.fromEntries(PRIORITIES.map((p) => [p, []]));
  }

  // Background lanes start nothing new until the returned release() is called (idempotent). Several holds may overlap.
  hold() {
    const token = {};
    this.holds.add(token);
    return () => { if (this.holds.delete(token)) this.pump(); };
  }
  isHeld() { return this.holds.size > 0; }

  // Resolves with fn(signal)'s result once a slot is free.
  // signal: cancels the job while it waits (rejects with AbortError); once it runs, the abort is forwarded to
  //   the signal given to fn, so the fetch is aborted.
  // key: a queued job with the same key is dropped (rejected with AbortError, code 'replaced') and this job
  //   joins the back of its priority. A running job with that key is left alone.
  // preemptible: fn may be stopped for the live assistant (its signal aborts with code 'preempted') and is then run again from the
  //   start; only for an fn that can safely run twice. live: runs even while the lane is held.
  async run(priority, fn, { signal, key, preemptible = false, live = false } = {}) {
    for (let requeue = false; ; requeue = true) {
      const slot = await this.acquire(priority, { signal, key, preemptible, live, requeue });
      try {
        return await fn(slot.signal);
      } catch (e) {
        if (!slot.preempted || signal?.aborted) throw e;
      } finally {
        slot.release();
      }
    }
  }

  // The LlmClient surface with every request at one priority, so existing services take it unchanged.
  client(priority) {
    checkPriority(priority);
    const scheduler = this;
    const llm = this.llm;
    // whole: the consumer collects the whole reply (complete()), so being pre-empted after some text throws code 'preempted' for
    // complete() to start over; a plain stream instead stops being pre-emptible once it has handed text on.
    async function* attempt(messages, { signal, key, sources = null, preemptible = PREEMPTIBLE.has(priority), live = false, onStart, ...opts }, whole) {
      for (let requeue = false; ; requeue = true) {
        const slot = await scheduler.acquire(priority, { signal, key, preemptible, live, requeue });
        try { onStart?.(); } catch { /* a caller's hook never breaks the request */ }
        // the ledger: where the request goes, read now (the settings may change before it ends), and the model the client resolved
        const config = llm.getConfig() || {};
        let model = config.model || '';
        const t0 = Date.now();
        let charsOut = 0, ok = true, error = null, again = false;
        try {
          for await (const d of llm.stream(messages, { ...opts, signal: slot.signal, onModel: (m) => { model = m; } })) {
            if (!charsOut && !whole) {
              if (slot.preempted) throw abortError('Paused for the live assistant.', 'preempted');   // a chunk already on its way: not shown, asked again
              slot.pin();
            }
            charsOut += d.length;
            yield d;
          }
        } catch (e) {
          ok = false; error = e?.message || String(e);
          if (!slot.preempted || signal?.aborted) throw e;
          error = 'Paused for the live assistant; asked again.';
          if (charsOut) throw abortError(error, 'preempted');   // only reached by complete(): it starts over
          again = true;
        } finally {
          slot.release();
          if (scheduler.onRun) { try { scheduler.onRun({ lane: priority, config: { baseUrl: config.baseUrl, model }, messages, charsOut, ms: Date.now() - t0, ok, error, sources }); } catch { /* a ledger problem never breaks an AI call */ } }
        }
        if (!again) return;
      }
    }
    return {
      priority,
      // Holds one slot from the first next() until the generator finishes, throws, or the consumer stops early.
      // sources: the source ids whose material is in the messages (Ask, briefs): written to the ledger, never sent to the server
      // preemptible (default: the lane's), live: see the top of this file. onStart(): the slot was granted and the request goes out
      // now (the assistant starts its "has it started answering?" timer then, not while it waited behind other work).
      stream(messages, opts = {}) { return attempt(messages, opts, false); },
      // Nothing reaches the caller before the end, so a pre-empted request starts over unseen, even after some text came back.
      async complete(messages, opts = {}) {
        for (;;) {
          let out = '';
          try {
            for await (const d of attempt(messages, opts, true)) out += d;
            return out.trim();
          } catch (e) { if (e?.code !== 'preempted' || opts.signal?.aborted) throw e; }
        }
      },
      listModels: () => llm.listModels(),
      test: () => llm.test(),
      getConfig: () => llm.getConfig(),
      resolveModel: (cfg) => llm.resolveModel(cfg),
      contextLength: async (o) => (typeof llm.contextLength === 'function' ? llm.contextLength(o) : null),   // metadata only: not queued
    };
  }

  stats() {
    return { running: this.running, held: this.isHeld(), queued: Object.fromEntries(PRIORITIES.map((p) => [p, this.queues[p].length])) };
  }

  // Waits for a slot. Resolves with { signal, release, preempted, pin }: signal aborts when the caller's signal does (or when the job
  // is pre-empted: then `preempted` is true); release() frees the slot (idempotent) and hands it to the next job straight away;
  // pin() makes the job no longer pre-emptible. requeue: a pre-empted job coming back, first in its lane; if a newer job with its
  // key is already waiting, that one wins and this one is rejected as replaced.
  acquire(priority, { signal, key, preemptible = false, live = false, requeue = false } = {}) {
    return new Promise((resolve, reject) => {
      checkPriority(priority);
      if (signal?.aborted) return reject(abortError());
      if (key != null) {
        if (!requeue) this.replace(key);
        else if (PRIORITIES.some((p) => this.queues[p].some((j) => j.key === key))) return reject(abortError('Replaced by a newer AI request.', 'replaced'));
      }
      const job = { priority, key, signal, resolve, reject, controller: new AbortController(), started: false, preemptible, live, preempted: false };
      if (signal) {
        job.onAbort = () => {
          if (job.started) job.controller.abort(signal.reason);
          else { this.remove(job); reject(abortError()); }
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      if (requeue) this.queues[priority].unshift(job); else this.queues[priority].push(job);
      this.pump();
      if (priority === 'assistant' && !job.started) this.preempt();
    });
  }

  // Frees slots for the waiting assistant requests: stops the lowest-priority, most recently started pre-emptible jobs, as many as
  // there are assistant requests waiting beyond the slots already being freed.
  preempt() {
    const freeing = [...this.active].filter((j) => j.preempted).length;
    let need = this.queues.assistant.length - freeing;
    while (need-- > 0) {
      const victim = [...this.active].filter((j) => j.preemptible && !j.preempted && j.priority !== 'assistant')
        .sort((a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || b.startedAt - a.startedAt)[0];
      if (!victim) return;
      victim.preempted = true;
      victim.controller.abort(abortError('Paused for the live assistant.', 'preempted'));
    }
  }

  replace(key) {
    for (const p of PRIORITIES) {
      for (const job of this.queues[p].filter((j) => j.key === key)) {
        this.remove(job);
        this.detach(job);
        job.reject(abortError('Replaced by a newer AI request.', 'replaced'));
      }
    }
  }

  remove(job) {
    const q = this.queues[job.priority];
    const i = q.indexOf(job);
    if (i >= 0) q.splice(i, 1);
  }

  detach(job) {
    if (job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
  }

  pump() {
    while (this.running < this.limit()) {
      const job = this.next();
      if (!job) return;
      this.start(job);
    }
  }

  limit() {
    const n = typeof this.concurrency === 'function' ? this.concurrency() : this.concurrency;
    return Math.max(1, Math.floor(Number(n)) || 1);
  }

  next() {
    for (const p of PRIORITIES) {
      const q = this.queues[p];
      if (!q.length) continue;
      if (!this.holds.size || !HOLDABLE.has(p)) return q.shift();
      const i = q.findIndex((j) => j.live);   // held: only work for the meeting in progress
      if (i >= 0) return q.splice(i, 1)[0];
    }
    return null;
  }

  start(job) {
    job.started = true;
    job.startedAt = ++this.starts;
    this.running++;
    this.active.add(job);
    let released = false;
    job.resolve({
      signal: job.controller.signal,
      get preempted() { return job.preempted; },
      pin: () => { job.preemptible = false; },
      release: () => {
        if (released) return;
        released = true;
        this.detach(job);
        this.active.delete(job);
        this.running--;
        this.pump();
      },
    });
  }
}

module.exports = { LlmScheduler, PRIORITIES, PREEMPTIBLE, HOLDABLE };
