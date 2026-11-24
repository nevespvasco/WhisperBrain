'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

// An AudioSource emits 'pcm' (Buffer: s16le mono 16 kHz), 'error' and 'end'.
class AudioSource extends EventEmitter {
  start() { throw new Error('not implemented'); }
  stop() {}
}

// Audio pushed in from elsewhere (the renderer capture bridge on macOS/Windows, or tests).
class PushSource extends AudioSource {
  constructor() { super(); this.active = false; }
  start() { this.active = true; }
  push(buf) { if (this.active) this.emit('pcm', buf); }
  stop() { if (this.active) { this.active = false; this.emit('end'); } }
}

// Raw PCM read from a child process' stdout (pw-record on Linux). Chunks are re-aligned to whole samples.
class ProcessSource extends AudioSource {
  constructor(cmd, args, { label = cmd } = {}) {
    super();
    this.cmd = cmd;
    this.args = args;
    this.label = label;
    this.child = null;
    this.stopping = false;
  }

  start() {
    const child = spawn(this.cmd, this.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let carry = null;
    let stderr = '';
    child.stdout.on('data', (d) => {
      let buf = carry ? Buffer.concat([carry, d]) : d;
      carry = null;
      if (buf.length & 1) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
      if (buf.length) this.emit('pcm', buf);
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => { this.emit('error', new Error(`${this.label}: ${e.message}`)); });
    child.on('close', (code) => {
      this.child = null;
      if (!this.stopping && code !== 0) this.emit('error', new Error(`${this.label} exited with ${code}: ${stderr.trim()}`));
      this.emit('end');
    });
  }

  stop() {
    this.stopping = true;
    const c = this.child;
    if (c) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

// Audio from a preferred source that carries on with another one when the first ends by itself (an application's own
// stream that goes away mid-call): the channel must not fall silent. `capture` says what is being captured now
// ({ mode, ... }); 'capture' is emitted when it changes. Stopping on purpose never starts the fallback.
class FallbackSource extends AudioSource {
  constructor({ primary, makeFallback, capture, fallbackCapture }) {
    super();
    Object.assign(this, { primary, makeFallback, capture, fallbackCapture });
    this.current = null;
    this.stopping = false;
  }

  start() {
    this.current = this.primary;
    this.primary.on('pcm', (b) => this.emit('pcm', b));
    this.primary.on('error', () => {});                       // an ending stream is not an error: 'end' follows and decides
    this.primary.once('end', () => {
      if (this.stopping) { this.emit('end'); return; }
      let next;
      try { next = this.makeFallback(); } catch (e) { this.emit('error', e); this.emit('end'); return; }   // nothing to fall back to
      this.current = next;
      this.capture = this.fallbackCapture;
      next.on('pcm', (b) => this.emit('pcm', b));
      next.on('error', (e) => this.emit('error', e));
      next.once('end', () => this.emit('end'));
      this.emit('capture', this.capture);
      try { next.start(); } catch (e) { this.emit('error', e); this.emit('end'); }
    });
    this.primary.start();
  }

  stop() { this.stopping = true; this.current?.stop(); }

  // Another call joined (a second meeting app): stop following the one stream and capture the fallback, the whole output, from
  // now on. Returns whether anything changed; false once widened, or when the preferred source is not the one running.
  widen(reason) {
    if (this.stopping || !this.current || this.current !== this.primary) return false;
    this.fallbackCapture = { ...this.fallbackCapture, reason };
    this.primary.stop();   // its 'end' starts the fallback, as when the stream goes away by itself
    return true;
  }
}

module.exports = { AudioSource, PushSource, ProcessSource, FallbackSource };
