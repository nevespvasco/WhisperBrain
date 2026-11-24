'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { recognizerConfig } = require('./models');
const { defaultAsrThreads } = require('../core/settings');

const VAD_DEFAULTS = { threshold: 0.5, minSilenceDuration: 0.6, minSpeechDuration: 0.25 };
const MAX_SEGMENT_SEC = 30; // Parakeet takes far longer clips; cutting less often means fewer words split by the VAD

// Parent-side handle for the ASR worker process. Emits 'segment' {ch, startMs, endMs, text, embedding, words,
// logProbMean, logProbMin}, 'exit' when the worker dies, and 'warning' when work is lost on purpose.
class AsrEngine extends EventEmitter {
  // speakerModel: path of the voice-embedding model, or () => path|null evaluated at each start(). It is loaded
  //   whenever it is installed, whoever starts the worker, so a caller that does not care about speakers (dictation)
  //   never swaps the worker for one without it.
  // holdRestart: () => true while the running worker must not be replaced (a recording is in progress).
  constructor({ speakerModel = null, holdRestart = null } = {}) {
    super();
    this.speakerProvider = typeof speakerModel === 'function' ? speakerModel : () => speakerModel;
    this.holdRestart = holdRestart;
    this.embeddings = true; // whether segments get voice embeddings (the recording decides)
    this.deferred = null;   // options that arrived while a restart was held; applied by the next start() once released
    this.child = null;
    this.model = null;
    this.ready = null;
    this.waiters = new Map(); // key -> {resolve, reject}
    this.nextId = 1;
    this.queued = 0; // bytes sent but not yet reported as decoded (approximate backlog, in samples)
  }

  get running() { return !!this.child; }

  // Starts the worker, or reuses the running one when model, threads, language and voice model all match.
  // While holdRestart() is true a differing request is deferred (the running worker keeps serving) unless
  // allowRestart is set; the recording itself sets it before any audio flows.
  async start(model, { vadPath, threads = defaultAsrThreads(), language = 'auto', speakerModel, allowRestart = false } = {}) {
    if (speakerModel === undefined) speakerModel = this.speakerProvider() ?? this.opts?.speakerModel ?? null;
    if (this.child) {
      const same = this.model?.id === model.id && this.opts.threads === threads && this.opts.language === language && this.opts.speakerModel === speakerModel;
      if (same) { this.deferred = null; return this.ready; }
      if (!allowRestart && this.holdRestart?.()) {
        this.deferred = { model: model.id, threads, language, speakerModel };
        this.emit('deferred', this.deferred);
        return this.ready;
      }
    }
    this.stop();
    this.deferred = null;
    this.model = model;
    this.opts = { threads, language, speakerModel };
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = fork(path.join(__dirname, 'worker.js'), [], { env, execPath: process.execPath, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child = child;
    this.ready = new Promise((resolve, reject) => { this.waiters.set('ready', { resolve, reject }); });
    this.ready.catch(() => {});
    child.on('message', (m) => this.onMessage(m));
    child.on('exit', (code, sig) => {
      if (this.child === child) {
        this.child = null;
        const err = new Error(`ASR worker exited (${sig || code})`);
        for (const w of this.waiters.values()) w.reject(err);
        this.waiters.clear();
        this.emit('exit', err);
      }
    });
    child.send({
      t: 'init', recognizer: recognizerConfig(model, { threads, language }), vadPath, speakerModel, embed: this.embeddings,
      embedThreads: Math.max(2, Math.min(4, Math.round(threads / 2))), // the voice model is small; 2-4 threads keep it off the critical path
      vad: { ...VAD_DEFAULTS, maxSpeechDuration: model.maxSegmentSec || MAX_SEGMENT_SEC },
    });
    return this.ready;
  }

  onMessage(m) {
    switch (m.t) {
      case 'ready': this.waiters.get('ready')?.resolve(); this.waiters.delete('ready'); break;
      case 'segment': this.emit('segment', { ch: m.ch, startMs: m.startMs, endMs: m.endMs, text: m.text, embedding: m.embedding || null, words: m.words || null, logProbMean: m.logProbMean ?? null, logProbMin: m.logProbMin ?? null }); break;
      case 'flushed': this.waiters.get(`flush:${m.ch}`)?.resolve(); this.waiters.delete(`flush:${m.ch}`); break;
      case 'result': this.waiters.get(`tx:${m.id}`)?.resolve(m.text); this.waiters.delete(`tx:${m.id}`); break;
      case 'resampled': this.waiters.get(`rs:${m.id}`)?.resolve(m.pcm); this.waiters.delete(`rs:${m.id}`); break;
      case 'error': {
        const err = new Error(m.message);
        const key = m.id ? [`tx:${m.id}`, `rs:${m.id}`].find((k) => this.waiters.has(k)) : this.waiters.has('ready') ? 'ready' : null;
        if (key && this.waiters.has(key)) { this.waiters.get(key).reject(err); this.waiters.delete(key); }
        else this.emit('error', err);
        break;
      }
    }
  }

  feed(ch, pcm) {
    if (!this.child) return;
    this.child.send({ t: 'audio', ch, pcm });
  }

  flush(ch) {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve, reject) => { this.waiters.set(`flush:${ch}`, { resolve, reject }); this.child.send({ t: 'flush', ch }); });
  }

  reset(ch) { this.child?.send({ t: 'reset', ch }); }

  // Whether closed segments get a voice embedding. Takes effect on the running worker straight away and survives restarts.
  configure({ embeddings } = {}) {
    if (embeddings === undefined) return;
    this.embeddings = !!embeddings;
    this.child?.send({ t: 'config', embed: this.embeddings });
  }

  // Resample mono Float32 audio at `rate` Hz to 16 kHz with sherpa's resampler.
  resample(samples, rate) {
    if (!this.child) return Promise.reject(new Error('ASR engine is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.waiters.set(`rs:${id}`, { resolve, reject }); this.child.send({ t: 'resample', id, pcm: samples, rate }); });
  }

  transcribe(pcm) {
    if (!this.child) return Promise.reject(new Error('ASR engine is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.waiters.set(`tx:${id}`, { resolve, reject }); this.child.send({ t: 'transcribe', id, pcm }); });
  }

  stop() {
    const c = this.child;
    const pending = [...this.waiters.keys()].filter((k) => k !== 'ready');
    this.child = null;
    this.model = null;
    if (c && pending.length) { // killing the worker loses these requests and any audio still buffered in its VAD
      const w = new Error(`ASR worker stopped with ${pending.length} pending request(s) (${pending.join(', ')}); buffered audio was lost`);
      if (this.listenerCount('warning')) this.emit('warning', w); else console.warn(w.message);
    }
    if (c) { try { c.kill(); } catch { /* gone */ } }
    for (const w of this.waiters.values()) w.reject(new Error('ASR engine stopped'));
    this.waiters.clear();
  }
}

module.exports = { AsrEngine, VAD_DEFAULTS, MAX_SEGMENT_SEC };
