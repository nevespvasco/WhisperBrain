'use strict';
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { recognizerConfig, onlineRecognizerConfig } = require('./models');
const { loadVocab, hotwordsString, normalizeTerms, DEFAULT_SCORE } = require('./hotwords');
const { defaultAsrThreads } = require('../core/settings');

const VAD_DEFAULTS = { threshold: 0.5, minSilenceDuration: 0.6, minSpeechDuration: 0.25 };
const MAX_SEGMENT_SEC = 30; // Parakeet takes far longer clips; cutting less often means fewer words split by the VAD

// ---- worker pools -------------------------------------------------------------------------------------------------
// Three kinds of work, each with its own worker process and recognizer, so none of them waits behind another:
//   live       the microphone and system-audio channels of a recording (steady, must keep up with the clock)
//   batch      imported files: a big, one-off job where only throughput matters
//   dictation  a short utterance that must come back at once
// A recognizer takes ~0.7 GB (Parakeet v3 int8), so the extra workers start only when they are needed and memory
// allows, and are stopped after a while idle. Otherwise everything shares the live worker, as before.
const LIVE_MAX_THREADS = 4;     // a meeting needs a few times real time, not more; the rest of the cores go to imports
const BATCH_MAX_THREADS = 8;    // decoding stops scaling around here (report, 2.1)
const BATCH_MAX_CONCURRENCY = 4;
const MEMORY_RESERVE_MB = 1536; // always leave this much for the OS, the UI and the user's other apps
const IDLE_MS = { batch: 3 * 60 * 1000, dictation: 20 * 60 * 1000 };

// Live drafts: a second, streaming recognizer in the live worker (see worker.js). It decodes only while someone is
// talking, on the worker's one JS thread (so it never competes with the final decode for cores), 1-2 threads at most.
const DRAFT_MAX_THREADS = 2;
const DRAFT_MIN_CORES = 4;       // physical-core estimate, like the pools: smaller machines keep single-pass captions
const DRAFT_CHANNELS = ['mic', 'system']; // imports and dictation never get drafts

// A flush waits for the worker to decode what it was sent. A worker that is stuck (or swapping itself to death) must not
// hang Stop forever: past this deadline it is killed, and the recording restarts it and transcribes the lost stretch from its
// spool (recording/manager.js). The deadline allows for the backlog: a slow machine may be a minute behind and still healthy.
const FLUSH_BASE_MS = 30000;
const FLUSH_MS_PER_BACKLOG_SEC = 2000; // even a slow decode runs at real time or better
const FLUSH_MAX_MS = 20 * 60 * 1000;
// Audio sent to the live worker and not yet decoded (seconds). Above the first the live drafts, which share the worker's one
// JS thread with the final decode, are switched off for the recording; above the second the person is told once.
const BACKLOG_DRAFT_OFF_SEC = 15;
const BACKLOG_WARN_SEC = 60;

// How the cores are divided. `cores` is the physical-core estimate (logical CPUs are usually SMT pairs), the unit
// ONNX Runtime's threading guidance sizes pools in: separate pools that never oversubscribe, so live + batch <= cores
// (dictation is short and almost never overlaps a big import, so it gets threads of its own on top). Machines with
// fewer than 4 cores keep one shared worker. Pure; the engine adds the memory check.
function planPools({ cpus = os.availableParallelism(), threads = defaultAsrThreads(cpus), enabled = true } = {}) {
  const cores = Math.max(1, Math.floor(cpus / 2));
  if (!enabled || cores < 4) return { mode: 'shared', cores, live: { threads }, batch: null, dictation: null };
  const live = Math.max(1, Math.min(threads, LIVE_MAX_THREADS, Math.floor(cores / 2)));
  const batch = Math.max(1, Math.min(cores - live, BATCH_MAX_THREADS));
  return {
    mode: 'split', cores, live: { threads: live },
    batch: { threads: batch, concurrency: Math.max(1, Math.min(Math.floor(batch / 2), BATCH_MAX_CONCURRENCY)) },
    dictation: { threads: Math.max(1, Math.min(threads, LIVE_MAX_THREADS)) },
  };
}

// Rough resident size of a worker for this model: the model files plus the VAD, voice model and buffers.
const sizeCache = new Map();
function workerMB(model, withSpeaker = true) {
  const key = `${model.id}|${withSpeaker}`;
  if (!sizeCache.has(key)) {
    let bytes = 0;
    for (const f of Object.values(model.files || {})) { try { bytes += fs.statSync(f).size; } catch { /* missing: counts as 0 */ } }
    sizeCache.set(key, Math.round((bytes * 1.1) / 1048576) + 200 + (withSpeaker ? 60 : 0));
  }
  return sizeCache.get(key);
}

// Resident size of the streaming model once loaded: measured at 1.43x its files (ONNX Runtime buffers and caches).
function draftMB(model) {
  let bytes = 0;
  for (const f of Object.values(model.files || {})) { try { bytes += fs.statSync(f).size; } catch { /* missing: counts as 0 */ } }
  return Math.round((bytes * 1.45) / 1048576) + 40;
}

// ---- one worker process ---------------------------------------------------------------------------------------------
// Parent-side handle for one ASR worker. Emits 'segment' {ch, ...}, 'error' (unsolicited worker errors) and
// 'exit' when the process dies; every request settles with an error if it does.
class AsrWorker extends EventEmitter {
  constructor(role) {
    super();
    this.role = role;
    this.child = null;
    this.model = null;
    this.opts = null;
    this.ready = null;
    this.waiters = new Map(); // key -> {resolve, reject, onProgress?}
    this.nextId = 1;
    this.lastUsed = Date.now();
    this.hotwordsOn = false; // phrases are set
    this.beamOn = false;     // the recognizer was rebuilt for beam search (needed for phrases; a little slower)
    this.draftOn = false;    // the streaming recognizer for live drafts is loaded
    this.concurrency = 1;
    this.queued = 0;         // samples sent with feed() and not yet acknowledged as processed by the worker (its backlog)
  }

  get running() { return !!this.child; }

  // threads: what the caller asked for (the setting); effective: what this worker runs with.
  start(model, { vadPath, threads, effective = threads, language, speakerModel, embeddings = true, concurrency = 1, hotwordsScore = DEFAULT_SCORE }) {
    this.stop();
    this.model = model;
    this.opts = { threads, effective, language, speakerModel };
    this.hotwordsOn = false;
    this.beamOn = false;
    this.draftOn = false;
    this.concurrency = concurrency;
    const env = { ...process.env, UV_THREADPOOL_SIZE: String(Math.max(4, concurrency + 2)) }; // decodeAsync jobs run on libuv's pool
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = fork(path.join(__dirname, 'worker.js'), [], { env, execPath: process.execPath, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.adopt(child);
    this.ready = new Promise((resolve, reject) => { this.waiters.set('ready', { resolve, reject }); });
    this.ready.catch(() => {});
    child.send({
      t: 'init', recognizer: recognizerConfig(model, { threads: effective, language }),
      beamRecognizer: model.kind === 'transducer' ? recognizerConfig(model, { threads: effective, language, beam: true, hotwordsScore }) : null,
      vadPath, speakerModel, embed: embeddings,
      embedThreads: Math.max(2, Math.min(4, Math.round(effective / 2))), // the voice model is small; 2-4 threads keep it off the critical path
      vad: { ...VAD_DEFAULTS, maxSpeechDuration: model.maxSegmentSec || MAX_SEGMENT_SEC },
    });
    return this.ready;
  }

  // Takes a freshly forked worker process (tests hand in a stand-in). Its death is reported once, as 'exit', whether it shows
  // as an exit or as an IPC error on a channel that is already closed (a send to a dying child: without an 'error' listener
  // that is an uncaught exception in Electron's main process).
  adopt(child) {
    this.child = child;
    this.queued = 0;
    this.lastUsed = Date.now();
    const gone = (why) => {
      if (this.child !== child) return;
      this.child = null;
      this.queued = 0;
      const err = new Error(`ASR worker exited (${why})`);
      for (const w of this.waiters.values()) w.reject(err);
      this.waiters.clear();
      this.emit('exit', err);
    };
    child.on('message', (m) => this.onMessage(m));
    child.on('exit', (code, sig) => gone(sig || code));
    child.on('error', (e) => { if (!child.connected) { try { child.kill('SIGKILL'); } catch { /* gone */ } gone(e.message); } });
  }

  onMessage(m) {
    const done = (key, value) => { const w = this.waiters.get(key); if (w) { this.waiters.delete(key); w.resolve(value); } };
    switch (m.t) {
      case 'ready': done('ready'); break;
      case 'segment': this.emit('segment', { ch: m.ch, startMs: m.startMs, endMs: m.endMs, text: m.text, embedding: m.embedding || null, words: m.words || null, logProbMean: m.logProbMean ?? null, logProbMin: m.logProbMin ?? null }); break;
      case 'flushed': done(`flush:${m.ch}:${m.id}`); break;
      case 'ack': this.queued = Math.max(0, this.queued - (m.n || 0)); break;
      case 'result': done(`tx:${m.id}`, m.text); break;
      case 'resampled': done(`rs:${m.id}`, m.pcm); break;
      case 'imported': done(`imp:${m.id}`, m.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, embedding: s.embedding || null, words: s.words || null, logProbMean: s.logProbMean ?? null, logProbMin: s.logProbMin ?? null }))); break;
      case 'progress': this.waiters.get(`imp:${m.id}`)?.onProgress?.(m.p); break;
      case 'hotwords-set': done('hotwords', m.phrases); break;
      case 'partial': this.emit('partial', { ch: m.ch, text: m.text, startMs: m.startMs }); break;
      case 'draft-set': done(`draft:${m.id}`, { enabled: !!m.enabled, ms: m.ms ?? null, error: m.error || null }); break;
      case 'draft-off': this.draftOn = false; this.emit('draft-off', { reason: m.reason }); break;
      case 'error': {
        const err = new Error(m.message);
        const key = m.id ? [`tx:${m.id}`, `rs:${m.id}`, `imp:${m.id}`, `draft:${m.id}`, ...[...this.waiters.keys()].filter((k) => k.startsWith('flush:') && k.endsWith(`:${m.id}`))].find((k) => this.waiters.has(k)) : this.waiters.has('ready') ? 'ready' : this.waiters.has('hotwords') ? 'hotwords' : null;
        if (key && this.waiters.has(key)) { this.waiters.get(key).reject(err); this.waiters.delete(key); }
        else this.emit('error', err);
        break;
      }
    }
  }

  request(key, msg, extra = {}) {
    if (!this.child) return Promise.reject(new Error('ASR engine is not running'));
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => { this.waiters.set(key, { resolve, reject, ...extra }); this.child.send(msg); });
  }

  feed(ch, pcm) { if (this.child) { this.lastUsed = Date.now(); this.queued += pcm.length >> 1; this.child.send({ t: 'audio', ch, pcm }); } }

  // How long a flush may take now: a base for the utterance still open in the VAD, plus time for the backlog.
  flushTimeout() { return Math.min(FLUSH_MAX_MS, FLUSH_BASE_MS + Math.round((this.queued / 16000) * FLUSH_MS_PER_BACKLOG_SEC)); }

  // Decode what the channel still holds. Each flush has its own id (a pause and a Stop may both flush one channel). A worker that
  // does not answer in time is killed: its exit is reported like any other death, so the recording restarts it.
  flush(ch, { timeoutMs = this.flushTimeout() } = {}) {
    const child = this.child;
    if (!child) return Promise.resolve();
    const id = this.nextId++;
    const key = `flush:${ch}:${id}`;
    const p = this.request(key, { t: 'flush', ch, id });
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (!this.waiters.has(key)) return;
        this.waiters.delete(key);
        reject(new Error(`the speech engine did not finish the ${ch} audio within ${Math.round(timeoutMs / 1000)} s, so it was restarted`));
        if (this.child === child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }
  reset(ch) { this.child?.send({ t: 'reset', ch }); }
  configure(embed) { this.child?.send({ t: 'config', embed }); }
  setHotwords(phrases, keep = false) { return this.request('hotwords', { t: 'hotwords', phrases, keep }); }
  setDraft(config) { const id = this.nextId++; return this.request(`draft:${id}`, { t: 'draft', id, config }); }
  resample(samples, rate) { const id = this.nextId++; return this.request(`rs:${id}`, { t: 'resample', id, pcm: samples, rate }); }
  transcribe(pcm) { const id = this.nextId++; return this.request(`tx:${id}`, { t: 'transcribe', id, pcm }); }
  importAudio(pcm, { concurrency = 1, onProgress } = {}) { const id = this.nextId++; return this.request(`imp:${id}`, { t: 'import', id, pcm, concurrency }, { onProgress }); }

  // Requests still waiting for an answer (everything but the start-up handshake).
  pending() { return [...this.waiters.keys()].filter((k) => k !== 'ready'); }

  // Kills the process. Returns a warning when requests (or audio buffered in the worker's VAD) were lost.
  stop() {
    const c = this.child;
    const pending = this.pending();
    this.child = null;
    this.model = null;
    let warning = null;
    if (c && pending.length) warning = new Error(`ASR worker stopped with ${pending.length} pending request(s) (${pending.join(', ')}); buffered audio was lost`);
    if (c) { try { c.kill(); } catch { /* gone */ } }
    for (const w of this.waiters.values()) w.reject(new Error('ASR engine stopped'));
    this.waiters.clear();
    return warning;
  }
}

// ---- the engine --------------------------------------------------------------------------------------------------------
// What the rest of the app talks to. `feed`/`flush`/`reset` are the live channels; `transcribe` is dictation;
// `transcribeParallel` is the import path. Emits 'segment' {ch, startMs, endMs, text, embedding, words, logProbMean,
// logProbMin} from live audio, 'partial' {ch, text, startMs} (draft words of the utterance in progress, replaced by
// the 'segment' that follows; text '' clears it; only while setDraft() has drafts on), 'draft-off' {reason} when the
// worker gave drafts up, 'exit' when the live worker dies, 'warning' when work is lost on purpose, and
// 'pool-exit' / 'pool-error' for the batch and dictation workers (they never concern a recording).
class AsrEngine extends EventEmitter {
  // speakerModel: path of the voice-embedding model, or () => path|null evaluated at each start(). It is loaded
  //   whenever it is installed, whoever starts the worker, so a caller that does not care about speakers (dictation)
  //   never swaps the worker for one without it.
  // holdRestart: () => true while the running live worker must not be replaced (a recording is in progress).
  // pools: 'auto' (separate workers when cores and memory allow), 'shared' (one worker for everything) or 'split'
  //   (separate workers whatever the memory). cpus, freeMemMB and idleMs exist for tests.
  constructor({ speakerModel = null, holdRestart = null, pools = 'auto', cpus = os.availableParallelism(), freeMemMB = () => os.freemem() / 1048576, idleMs = IDLE_MS } = {}) {
    super();
    this.speakerProvider = typeof speakerModel === 'function' ? speakerModel : () => speakerModel;
    this.holdRestart = holdRestart;
    this.poolsMode = pools;
    this.cpus = cpus;
    this.freeMemMB = freeMemMB;
    this.idleMs = idleMs;
    this.embeddings = true; // whether segments get voice embeddings (the recording decides)
    this.deferred = null;   // options that arrived while a restart was held; applied by the next start() once released
    this.hotwordTerms = []; // this meeting's vocabulary, applied to the live worker
    this.hotwordScore = DEFAULT_SCORE;
    this.draftModel = null; // the streaming model drafts should use for the recording in progress (null = no drafts)
    this.draftLanguage = 'auto';
    this.plan = null;       // how the cores were divided when the live worker last started
    this.vocabs = new Map(); // tokens.txt path -> Set of pieces
    this.timers = {};
    this.live = this.makeWorker('live');
    this.batch = this.makeWorker('batch');
    this.dictation = this.makeWorker('dictation');
    this.shedding = false;     // live drafts are being switched off because the worker fell behind
    this.backlogWarned = false;
  }

  // Samples sent to the live worker and not yet decoded (its backlog).
  get queued() { return this.live.queued; }

  makeWorker(role) {
    const w = new AsrWorker(role);
    if (role === 'live') {
      w.on('segment', (s) => this.emit('segment', s));
      w.on('partial', (p) => this.emit('partial', p));
      w.on('draft-off', (e) => this.emit('draft-off', e));
      w.on('error', (e) => this.emit('error', e));
      w.on('exit', (e) => this.emit('exit', e));
    } else {
      w.on('error', (e) => this.emit('pool-error', { role, error: e }));
      w.on('exit', (e) => this.emit('pool-exit', { role, error: e }));
    }
    return w;
  }

  // The live worker, under the names the rest of the app (and the tests) have always used.
  get child() { return this.live.child; }
  set child(v) { this.live.child = v; }
  get model() { return this.live.model; }
  set model(v) { this.live.model = v; }
  get opts() { return this.live.opts; }
  set opts(v) { this.live.opts = v; }
  get ready() { return this.live.ready; }
  set ready(v) { this.live.ready = v; }
  get waiters() { return this.live.waiters; }

  get running() { return this.live.running || this.batch.running || this.dictation.running; }

  // Which workers exist right now, for diagnostics and tests.
  pools() {
    const info = (w) => (w.running ? { pid: w.child.pid, threads: w.opts.effective ?? w.opts.threads, concurrency: w.concurrency } : null);
    return { mode: this.plan?.mode || null, live: info(this.live), batch: info(this.batch), dictation: info(this.dictation), draft: this.live.draftOn };
  }

  // Starts a worker, or reuses the running one when model, threads, language and voice model all match.
  // role 'live' (default) is the recording; 'batch' is a file import; 'dictation' is push-to-dictate. A role whose
  // own worker cannot be had (too few cores, too little memory) is served by the live one. While holdRestart() is
  // true a differing live request is deferred (the running worker keeps serving) unless allowRestart is set; the
  // recording itself sets it before any audio flows.
  async start(model, { role = 'live', vadPath, threads = defaultAsrThreads(this.cpus), language = 'auto', speakerModel, allowRestart = false } = {}) {
    if (speakerModel === undefined) speakerModel = this.speakerProvider() ?? this.live.opts?.speakerModel ?? null;
    if (role !== 'live') {
      const w = this.workerFor(role, model, speakerModel, threads);
      if (w !== this.live) return this.startPool(w, model, { vadPath, threads, language, speakerModel });
    }
    return this.startLive(model, { vadPath, threads, language, speakerModel, allowRestart });
  }

  async startLive(model, { vadPath, threads, language, speakerModel, allowRestart }) {
    const live = this.live;
    if (live.child) {
      const same = live.model?.id === model.id && live.opts.threads === threads && live.opts.language === language && live.opts.speakerModel === speakerModel;
      if (same) { this.deferred = null; return live.ready; }
      if (!allowRestart && this.holdRestart?.()) {
        this.deferred = { model: model.id, threads, language, speakerModel };
        this.emit('deferred', this.deferred);
        return live.ready;
      }
    }
    this.stopWorker(live);
    this.deferred = null;
    this.plan = this.planFor(model, threads);
    const ready = live.start(model, { vadPath, threads, effective: this.plan.live.threads, language, speakerModel, embeddings: this.embeddings, hotwordsScore: this.hotwordScore });
    await ready;
    await this.applyHotwords();
    if (this.draftModel) await this.applyDraft().catch(() => {}); // a restart between recordings (e.g. another model) keeps drafts as asked
    return ready;
  }

  // The division of cores for a new set of workers: split only when the cores allow it and memory is there for a second copy.
  planFor(model, threads) {
    const enough = () => this.freeMemMB() >= 2 * workerMB(model) + MEMORY_RESERVE_MB;
    const enabled = this.poolsMode === 'split' || (this.poolsMode === 'auto' && enough());
    return planPools({ cpus: this.cpus, threads, enabled });
  }

  // The worker that serves a role: its own when it is running or can be started now, else the live one.
  workerFor(role, model, speakerModel, threads) {
    const w = this[role];
    if (w.running) return w;
    if (this.poolsMode === 'shared') return this.live;
    const plan = this.live.running ? this.plan : this.planFor(model, threads); // a running live worker already settled the split
    if (!plan || plan.mode !== 'split') return this.live;
    if (this.poolsMode !== 'split' && this.freeMemMB() < workerMB(model, role !== 'dictation') + MEMORY_RESERVE_MB) return this.live;
    return w;
  }

  async startPool(w, model, { vadPath, threads, language, speakerModel }) {
    if (w.child && w.model?.id === model.id && w.opts.threads === threads && w.opts.language === language) { w.lastUsed = Date.now(); return w.ready; }
    this.stopWorker(w);
    const plan = this.live.running && this.plan?.mode === 'split' ? this.plan : this.planFor(model, threads);
    const sizing = plan[w.role];
    const withSpeaker = w.role !== 'dictation'; // dictation never needs voices: skip the load and the memory
    const ready = w.start(model, { vadPath, threads, effective: sizing.threads, language, speakerModel: withSpeaker ? speakerModel : null, embeddings: this.embeddings, concurrency: sizing.concurrency || 1 });
    await ready;
    w.lastUsed = Date.now();
    this.armIdle(w);
    return ready;
  }

  // Idle batch and dictation workers give their memory back; the live worker stays for the app's lifetime.
  armIdle(w) {
    clearTimeout(this.timers[w.role]);
    const limit = this.idleMs[w.role];
    if (!limit) return;
    const check = () => {
      if (!w.running) return;
      const idle = Date.now() - w.lastUsed;
      if (w.waiters.size || idle < limit) { this.timers[w.role] = setTimeout(check, Math.max(1000, limit - idle)); this.timers[w.role].unref?.(); return; }
      this.stopWorker(w);
    };
    this.timers[w.role] = setTimeout(check, limit);
    this.timers[w.role].unref?.();
  }

  stopWorker(w) {
    clearTimeout(this.timers[w.role]);
    const warning = w.stop();
    if (warning) { if (this.listenerCount('warning')) this.emit('warning', warning); else console.warn(warning.message); }
  }

  feed(ch, pcm) { this.live.feed(ch, pcm); this.watchBacklog(); }
  flush(ch, opts) { return this.live.flush(ch, opts); }

  // Backpressure: the drafts go first (they share the worker's thread with the final text), then the person is told once.
  watchBacklog() {
    const behind = this.live.queued / 16000;
    if (behind > BACKLOG_DRAFT_OFF_SEC && this.live.draftOn && !this.shedding) {
      this.shedding = true;
      this.setDraft(null).catch(() => {}).finally(() => { this.shedding = false; });
      this.emit('draft-off', { reason: `the speech engine fell behind (${Math.round(behind)} s of audio waiting)` });
    }
    if (behind > BACKLOG_WARN_SEC && !this.backlogWarned) {
      this.backlogWarned = true;
      this.emit('warning', new Error(`Transcription is running about ${Math.round(behind)} s behind the audio; it catches up on its own, and nothing is lost.`));
    } else if (behind < BACKLOG_WARN_SEC / 2) this.backlogWarned = false;
  }
  reset(ch) { this.live.reset(ch); }

  // Whether closed segments get a voice embedding. Takes effect on the running workers straight away and survives restarts.
  configure({ embeddings } = {}) {
    if (embeddings === undefined) return;
    this.embeddings = !!embeddings;
    this.live.configure(this.embeddings);
    this.batch.configure(this.embeddings);
  }

  // The vocabulary of the meeting being recorded: biases the live recognizer towards these words (see hotwords.js).
  // An empty list switches biasing off. Call it before audio flows: turning biasing on or off rebuilds the live
  // recognizer inside the worker (about 2 s), which must not happen mid-recording.
  async setHotwords(terms = [], { score = DEFAULT_SCORE } = {}) {
    this.hotwordTerms = normalizeTerms(terms);
    this.hotwordScore = score;
    await this.applyHotwords();
  }

  // The meeting is over: forget its words, but keep the beam-search recognizer so that the next meeting, which
  // probably has words of its own, does not rebuild it again.
  async releaseHotwords() {
    this.hotwordTerms = [];
    await this.applyHotwords({ keepBeam: true });
  }

  async applyHotwords({ keepBeam = false } = {}) {
    const w = this.live;
    if (!w.child) return;
    let phrases = '';
    const tokens = w.model?.kind === 'transducer' ? w.model.files?.tokens : null;
    if (tokens && this.hotwordTerms.length) {
      if (!this.vocabs.has(tokens)) this.vocabs.set(tokens, loadVocab(tokens));
      phrases = hotwordsString(this.hotwordTerms, this.vocabs.get(tokens), { score: this.hotwordScore });
    }
    if (phrases) { w.hotwordsOn = true; w.beamOn = true; await w.setHotwords(phrases); return; }
    if (keepBeam ? !w.hotwordsOn : !w.beamOn) return; // already as asked
    w.hotwordsOn = false;
    if (!keepBeam) w.beamOn = false;
    await w.setHotwords('', keepBeam);
  }

  // Live draft captions for the recording about to start: the streaming `model` (Models.draftModel(), or null to switch
  // drafts off) loads into the live worker next to the final recognizer, without restarting it. Drafts are skipped,
  // with the reason returned, when the machine is too small (fewer than 4 physical cores or not enough free memory
  // for another ~1 GB model). Resolves { enabled, reason?, ms? }; never throws for a model that cannot load.
  async setDraft(model = null, { language = 'auto' } = {}) {
    this.draftModel = model;
    this.draftLanguage = language;
    return this.applyDraft();
  }

  // What the streaming model needs from this machine, or why it cannot run.
  draftGate(model) {
    const cores = Math.max(1, Math.floor(this.cpus / 2));
    if (cores < DRAFT_MIN_CORES) return { ok: false, reason: `live drafts need at least ${DRAFT_MIN_CORES} CPU cores (this computer has about ${cores})` };
    if (!this.live.draftOn && this.freeMemMB() < draftMB(model) + MEMORY_RESERVE_MB) return { ok: false, reason: 'not enough free memory for live drafts' };
    return { ok: true, threads: Math.max(1, Math.min(DRAFT_MAX_THREADS, this.live.opts?.effective ?? this.live.opts?.threads ?? DRAFT_MAX_THREADS)) };
  }

  async applyDraft() {
    const w = this.live;
    if (!w.child) return { enabled: false, reason: 'the speech engine is not running' };
    const model = this.draftModel;
    const gate = model ? this.draftGate(model) : { ok: false, reason: null };
    if (!gate.ok) {
      if (w.draftOn) { w.draftOn = false; await w.setDraft(null); }
      return { enabled: false, reason: gate.reason };
    }
    const language = /^[a-z]{2,3}$/.test(this.draftLanguage) ? this.draftLanguage : 'auto';
    const r = await w.setDraft({ recognizer: onlineRecognizerConfig(model, { threads: gate.threads }), language, channels: DRAFT_CHANNELS });
    w.draftOn = r.enabled;
    return r.enabled ? { enabled: true, ms: r.ms, threads: gate.threads } : { enabled: false, reason: r.error || 'the streaming model could not be loaded' };
  }

  // Resample mono Float32 audio at `rate` Hz to 16 kHz with sherpa's resampler.
  resample(samples, rate) {
    const w = [this.batch, this.live, this.dictation].find((x) => x.running);
    if (!w) return Promise.reject(new Error('ASR engine is not running'));
    return w.resample(samples, rate);
  }

  // Dictation: one short utterance, on the dictation worker when there is one.
  transcribe(pcm) {
    const w = this.dictation.running ? this.dictation : this.live;
    if (!w.running) return Promise.reject(new Error('ASR engine is not running'));
    return w.transcribe(pcm);
  }

  // A whole file (16 kHz s16le mono) on the batch worker: utterances are decoded in parallel and returned in time
  // order with exact offsets. Resolves null when there is no batch worker (shared mode); the caller then streams the
  // audio through the live channels instead, with the same result, only slower.
  async transcribeParallel(pcm, { onProgress } = {}) {
    const w = this.batch;
    if (!w.running) return null;
    await w.ready;
    try { return await w.importAudio(pcm, { concurrency: w.concurrency, onProgress }); } finally { w.lastUsed = Date.now(); }
  }

  stop() {
    for (const w of [this.dictation, this.batch, this.live]) this.stopWorker(w);
  }
}

module.exports = { AsrEngine, AsrWorker, planPools, workerMB, draftMB, VAD_DEFAULTS, MAX_SEGMENT_SEC, MEMORY_RESERVE_MB, DRAFT_MIN_CORES, DRAFT_MAX_THREADS, BACKLOG_DRAFT_OFF_SEC };
