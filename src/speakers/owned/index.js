'use strict';
// Parent-side handles for the owned diarization worker (worker.js): a one-shot call with the same contract as
// ../diarizer.js (so the after-Stop pass can use either), and a live follower that computes the windows of a channel
// while it is being recorded, so Stop only clusters.
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function spawnWorker() {
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = fork(path.join(__dirname, 'worker.js'), [], { env, execPath: process.execPath, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  // never in the way of capture and live transcription: it runs at a lower priority and catches up when the machine is idle
  try { os.setPriority(child.pid, 10); } catch { /* not allowed here */ }
  // a send to a child that already died is an 'error' event: without a listener, an uncaught exception in Electron's main process.
  // Its exit (or the answer's own checks below) is what settles any request.
  child.on('error', () => {});
  return child;
}

// How long to wait for a diarization of `seconds` of audio: twice its length plus a minute, at most an hour. The worker runs at
// a low priority, so it gets room; but a worker that is gone or stuck must not hold Stop (and every new recording) for an hour.
function diarizeTimeout(seconds) {
  return Math.min(60 * 60 * 1000, Math.round(Math.max(0, seconds || 0) * 2000) + 60 * 1000);
}

// Seconds of 16 kHz s16le audio in a request ({ file } or { pcm }); 0 when unknown.
function secondsOf({ file, pcm } = {}) {
  try { return (pcm ? pcm.length : fs.statSync(file).size) / 32000; } catch { return 0; }
}

const dead = (child) => child.exitCode !== null || child.signalCode !== null;

// Wait for the worker's answer to one request. -> Promise<{ turns, voices, exclusive, overlaps, stats }>
function answer(child, timeoutMs, onOther) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('speaker diarization timed out')), timeoutMs);
    if (dead(child)) { finish(reject, new Error(`speaker diarization worker exited (${child.signalCode || child.exitCode})`)); return; }
    child.on('message', (m) => {
      if (m.t === 'diarized') finish(resolve, { turns: m.turns, voices: m.voices, exclusive: m.exclusive, overlaps: m.overlaps, stats: m.stats });
      else if (m.t === 'error') finish(reject, new Error(m.message));
      else onOther?.(m);
    });
    child.on('exit', (code, sig) => finish(reject, new Error(`speaker diarization worker exited (${sig || code})`)));
  });
}

// Sends one message; a child that cannot take it (gone) fails the request now rather than at the timeout.
function post(child, msg) {
  try { child.send(msg, (err) => { if (err) try { child.kill(); } catch { /* gone */ } }); } catch { try { child.kill(); } catch { /* gone */ } }
}

// One shot over a file or a buffer: { file } | { pcm }, plus { segmentation, embedding, threads, numSpeakers }.
// (`threshold`/`windowShift` meant for sherpa's clustering are ignored; `ownedThreshold` sets this pipeline's.)
function diarizeOwned(opts, { timeoutMs = diarizeTimeout(secondsOf(opts)) } = {}) {
  const child = spawnWorker();
  const p = answer(child, timeoutMs);
  post(child, { t: 'diarize', file: opts.file, pcm: opts.pcm, segmentation: opts.segmentation, embedding: opts.embedding, threads: opts.threads, numSpeakers: opts.numSpeakers || 0, fallbackSpeakers: opts.fallbackSpeakers || 0, threshold: opts.ownedThreshold, altEmbedding: opts.altEmbedding });
  return p;
}

// Follows one channel's spool while recording. onOverlap({ start, end }) in seconds of spool, as soon as a window
// shows two people at once. finish() after the spool is closed for writing gives the diarization.
class LiveDiarizer {
  constructor({ file, segmentation, embedding, threads = 1, finishThreads = 4, ownedThreshold, onOverlap, onWarning, pollMs = 1000 }) {
    this.child = spawnWorker();
    this.onOverlap = onOverlap;
    this.progress = { windows: 0, seconds: 0 };
    this.result = null;
    this.failed = null; // why following the recording failed, if it did
    this.exited = null; // how its process ended, if it did: finish() then fails at once and Stop runs the one-shot instead
    this.child.on('exit', (code, sig) => {
      this.exited = String(sig || code);
      if (!this.result && !this.failed && !this.stopped) { this.failed = `the worker exited (${this.exited})`; onWarning?.(`speaker analysis while recording stopped: ${this.failed}`); }
    });
    this.child.on('message', (m) => {
      if (m.t === 'overlap') this.onOverlap?.({ start: m.start, end: m.end });
      else if (m.t === 'progress') this.progress = { windows: m.windows, seconds: m.seconds };
      else if (m.t === 'warning') onWarning?.(m.message);
      // the worker could not start following (a model or onnxruntime-node that does not load): say so now, not as a
      // puzzling "not following a recording" at Stop; the after-Stop pass then runs the one-shot instead (manager.diarize)
      else if (m.t === 'error' && !this.result) { this.failed = String(m.message || 'error').split('\n')[0]; onWarning?.(`speaker analysis while recording stopped: ${this.failed}`); }
    });
    post(this.child, { t: 'live', file, segmentation, embedding, threads, finishThreads, threshold: ownedThreshold, pollMs });
  }

  // samples: how much of the spool belongs to the recording. numSpeakers: forced count (0 = free). fallbackSpeakers: how many
  // voices to cut for if the free clustering collapses to one (pipeline.js).
  finish({ samples, numSpeakers = 0, fallbackSpeakers = 0, altEmbedding = null, timeoutMs = diarizeTimeout((samples || 0) / 16000) } = {}) {
    if (this.result) return this.result;
    this.result = answer(this.child, timeoutMs);
    if (!dead(this.child)) post(this.child, { t: 'finish', samples, numSpeakers, fallbackSpeakers, altEmbedding });
    return this.result;
  }

  stop() { this.stopped = true; try { this.child.kill(); } catch { /* gone */ } }
}

module.exports = { diarizeOwned, LiveDiarizer, diarizeTimeout, secondsOf };
