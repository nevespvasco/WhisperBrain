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

module.exports = { AudioSource, PushSource, ProcessSource };
