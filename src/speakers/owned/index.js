'use strict';
// Parent-side handles for the owned diarization worker (worker.js): a one-shot call with the same contract as
// ../diarizer.js (so the after-Stop pass can use either), and a live follower that computes the windows of a channel
// while it is being recorded, so Stop only clusters.
const { fork } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function spawnWorker() {
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = fork(path.join(__dirname, 'worker.js'), [], { env, execPath: process.execPath, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  // never in the way of capture and live transcription: it runs at a lower priority and catches up when the machine is idle
  try { os.setPriority(child.pid, 10); } catch { /* not allowed here */ }
  return child;
}

// Wait for the worker's answer to one request. -> Promise<{ turns, voices, exclusive, overlaps, stats }>
function answer(child, timeoutMs, onOther) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('speaker diarization timed out')), timeoutMs);
    child.on('message', (m) => {
      if (m.t === 'diarized') finish(resolve, { turns: m.turns, voices: m.voices, exclusive: m.exclusive, overlaps: m.overlaps, stats: m.stats });
      else if (m.t === 'error') finish(reject, new Error(m.message));
      else onOther?.(m);
    });
    child.on('exit', (code, sig) => finish(reject, new Error(`speaker diarization worker exited (${sig || code})`)));
  });
}

// One shot over a file or a buffer: { file } | { pcm }, plus { segmentation, embedding, threads, numSpeakers }.
// (`threshold`/`windowShift` meant for sherpa's clustering are ignored; `ownedThreshold` sets this pipeline's.)
function diarizeOwned(opts, { timeoutMs = 60 * 60 * 1000 } = {}) {
  const child = spawnWorker();
  const p = answer(child, timeoutMs);
  child.send({ t: 'diarize', file: opts.file, pcm: opts.pcm, segmentation: opts.segmentation, embedding: opts.embedding, threads: opts.threads, numSpeakers: opts.numSpeakers || 0, threshold: opts.ownedThreshold, altEmbedding: opts.altEmbedding });
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
    this.child.on('message', (m) => {
      if (m.t === 'overlap') this.onOverlap?.({ start: m.start, end: m.end });
      else if (m.t === 'progress') this.progress = { windows: m.windows, seconds: m.seconds };
      else if (m.t === 'warning') onWarning?.(m.message);
      // the worker could not start following (a model or onnxruntime-node that does not load): say so now, not as a
      // puzzling "not following a recording" at Stop; the after-Stop pass then runs the one-shot instead (manager.diarize)
      else if (m.t === 'error' && !this.result) { this.failed = String(m.message || 'error').split('\n')[0]; onWarning?.(`speaker analysis while recording stopped: ${this.failed}`); }
    });
    this.child.on('error', () => {});
    this.child.send({ t: 'live', file, segmentation, embedding, threads, finishThreads, threshold: ownedThreshold, pollMs });
  }

  // samples: how much of the spool belongs to the recording. numSpeakers: forced count (0 = free).
  finish({ samples, numSpeakers = 0, altEmbedding = null, timeoutMs = 60 * 60 * 1000 } = {}) {
    if (this.result) return this.result;
    this.result = answer(this.child, timeoutMs);
    this.child.send({ t: 'finish', samples, numSpeakers, altEmbedding });
    return this.result;
  }

  stop() { try { this.child.kill(); } catch { /* gone */ } }
}

module.exports = { diarizeOwned, LiveDiarizer };
