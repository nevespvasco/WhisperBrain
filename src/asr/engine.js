'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { recognizerConfig } = require('./models');

const VAD_DEFAULTS = { threshold: 0.5, minSilenceDuration: 0.6, minSpeechDuration: 0.25 };

// Parent-side handle for the ASR worker process. Emits 'segment' {ch, startMs, endMs, text}.
class AsrEngine extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.model = null;
    this.ready = null;
    this.waiters = new Map(); // key -> {resolve, reject}
    this.nextId = 1;
    this.queued = 0; // bytes sent but not yet reported as decoded (approximate backlog, in samples)
  }

  get running() { return !!this.child; }

  async start(model, { vadPath, threads = 2, language = 'auto', speakerModel = null } = {}) {
    if (this.child && this.model?.id === model.id && this.opts?.threads === threads && this.opts?.language === language && this.opts?.speakerModel === speakerModel) return this.ready;
    this.stop();
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
      t: 'init', recognizer: recognizerConfig(model, { threads, language }), vadPath, speakerModel,
      vad: { ...VAD_DEFAULTS, maxSpeechDuration: model.maxSegmentSec || 20 },
    });
    return this.ready;
  }

  onMessage(m) {
    switch (m.t) {
      case 'ready': this.waiters.get('ready')?.resolve(); this.waiters.delete('ready'); break;
      case 'segment': this.emit('segment', { ch: m.ch, startMs: m.startMs, endMs: m.endMs, text: m.text, embedding: m.embedding || null }); break;
      case 'flushed': this.waiters.get(`flush:${m.ch}`)?.resolve(); this.waiters.delete(`flush:${m.ch}`); break;
      case 'result': this.waiters.get(`tx:${m.id}`)?.resolve(m.text); this.waiters.delete(`tx:${m.id}`); break;
      case 'error': {
        const err = new Error(m.message);
        const key = m.id ? `tx:${m.id}` : this.waiters.has('ready') ? 'ready' : null;
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

  transcribe(pcm) {
    if (!this.child) return Promise.reject(new Error('ASR engine is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.waiters.set(`tx:${id}`, { resolve, reject }); this.child.send({ t: 'transcribe', id, pcm }); });
  }

  stop() {
    const c = this.child;
    this.child = null;
    this.model = null;
    if (c) { try { c.kill(); } catch { /* gone */ } }
    for (const w of this.waiters.values()) w.reject(new Error('ASR engine stopped'));
    this.waiters.clear();
  }
}

module.exports = { AsrEngine, VAD_DEFAULTS };
