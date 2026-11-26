'use strict';
// One queue in front of the AI server for every feature. Lower index in PRIORITIES runs first; FIFO within
// a priority. Running jobs are never pre-empted: priority only decides who gets the next free slot.

const { isLocalUrl } = require('../core/policy');

const PRIORITIES = ['assistant', 'chat', 'summary', 'translation', 'background'];

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
    this.queues = Object.fromEntries(PRIORITIES.map((p) => [p, []]));
  }

  // Resolves with fn(signal)'s result once a slot is free.
  // signal: cancels the job while it waits (rejects with AbortError); once it runs, the abort is forwarded to
  //   the signal given to fn, so the fetch is aborted.
  // key: a queued job with the same key is dropped (rejected with AbortError, code 'replaced') and this job
  //   joins the back of its priority. A running job with that key is left alone.
  async run(priority, fn, { signal, key } = {}) {
    const slot = await this.acquire(priority, { signal, key });
    try {
      return await fn(slot.signal);
    } finally {
      slot.release();
    }
  }

  // The LlmClient surface with every request at one priority, so existing services take it unchanged.
  client(priority) {
    checkPriority(priority);
    const scheduler = this;
    const llm = this.llm;
    return {
      priority,
      // Holds one slot from the first next() until the generator finishes, throws, or the consumer stops early.
      async *stream(messages, { signal, key, ...opts } = {}) {
        const slot = await scheduler.acquire(priority, { signal, key });
        const t0 = Date.now();
        let charsOut = 0, ok = true, error = null;
        try {
          for await (const d of llm.stream(messages, { ...opts, signal: slot.signal })) { charsOut += d.length; yield d; }
        } catch (e) { ok = false; error = e?.message || String(e); throw e; } finally {
          slot.release();
          if (scheduler.onRun) { try { scheduler.onRun({ lane: priority, config: llm.getConfig(), messages, charsOut, ms: Date.now() - t0, ok, error }); } catch { /* a ledger problem never breaks an AI call */ } }
        }
      },
      async complete(messages, opts) {
        let out = '';
        for await (const d of this.stream(messages, opts)) out += d;
        return out.trim();
      },
      listModels: () => llm.listModels(),
      test: () => llm.test(),
      getConfig: () => llm.getConfig(),
      resolveModel: (cfg) => llm.resolveModel(cfg),
    };
  }

  stats() {
    return { running: this.running, queued: Object.fromEntries(PRIORITIES.map((p) => [p, this.queues[p].length])) };
  }

  // Waits for a slot. Resolves with { signal, release }: signal aborts when the caller's signal does; release()
  // frees the slot (idempotent) and hands it to the next job straight away.
  acquire(priority, { signal, key } = {}) {
    return new Promise((resolve, reject) => {
      checkPriority(priority);
      if (signal?.aborted) return reject(abortError());
      if (key != null) this.replace(key);
      const job = { priority, key, signal, resolve, reject, controller: new AbortController(), started: false };
      if (signal) {
        job.onAbort = () => {
          if (job.started) job.controller.abort(signal.reason);
          else { this.remove(job); reject(abortError()); }
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queues[priority].push(job);
      this.pump();
    });
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
    for (const p of PRIORITIES) if (this.queues[p].length) return this.queues[p].shift();
    return null;
  }

  start(job) {
    job.started = true;
    this.running++;
    let released = false;
    job.resolve({
      signal: job.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.detach(job);
        this.running--;
        this.pump();
      },
    });
  }
}

module.exports = { LlmScheduler, PRIORITIES };
