'use strict';
// Runs a native helper that prints one JSON object per line, and keeps it running: if it dies it is started again, with
// a growing pause, so a helper that cannot work never turns into a busy loop. A helper that is not there stops it.
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
const readline = require('node:readline');

const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

class HelperProcess extends EventEmitter {
  // spawn(command, args, opts): child_process.spawn or a stand-in
  constructor({ command, args = [], spawn = cp.spawn, backoff = BACKOFF_MS, healthyMs = 60000, label = 'helper' }) {
    super();
    Object.assign(this, { command, args, spawn, backoff, healthyMs, label });
    this.child = null;
    this.running = false;
    this.failures = 0;
    this.timer = null;
    this.stderr = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.launch();
  }

  launch() {
    if (!this.running) return;
    let child;
    try { child = this.spawn(this.command, this.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return this.failed(e); }
    this.child = child;
    const startedAt = Date.now();
    this.stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.startsWith('{')) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      this.emit('message', msg);
    });
    child.stderr?.on('data', (d) => { this.stderr = (this.stderr + d).slice(-1500); });
    child.on('error', (e) => { if (this.child === child) this.failed(e, e.code === 'ENOENT' || e.code === 'EACCES'); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.running) return;
      if (Date.now() - startedAt >= this.healthyMs) this.failures = 0;
      this.failed(new Error(`${this.label} exited (${signal || code})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`), false, code);
    });
  }

  failed(err, permanent = false, code = null) {
    if (!this.running) return;
    if (permanent) { this.running = false; this.emit('unavailable', err); return; }
    // exit code 3 is the helper saying "there is no accessibility bus": starting it again will not make one
    if (code === 3 && this.failures >= 2) { this.running = false; this.emit('unavailable', err); return; }
    const wait = this.backoff[Math.min(this.failures, this.backoff.length - 1)];
    this.failures++;
    this.emit('restart', { error: err, inMs: wait, failures: this.failures });
    this.timer = setTimeout(() => { this.timer = null; this.launch(); }, wait);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

module.exports = { HelperProcess, BACKOFF_MS };
