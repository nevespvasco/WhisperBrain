'use strict';
// Parent-side handle for diarize-worker.js: one short-lived process per call, so its memory (the whole channel as
// float samples, the segmentation and voice models) is given back as soon as the answer arrives.
const { fork } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// opts: { file } or { pcm }, plus { segmentation, embedding, threads, threshold, windowShift, numSpeakers }.
// -> Promise<{ turns: [{ start, end, speaker }], voices: [{ speaker, centroid, pitch, ms }]}>
function diarize(opts, { timeoutMs = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = fork(path.join(__dirname, 'diarize-worker.js'), [], { env, execPath: process.execPath, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    // It runs after Stop on every thread it is given (~8 cores for a minute on a 20-minute call): at a lower priority the app and
    // the rest of the desktop stay responsive while it works, and it still has the whole machine when nothing else wants it.
    try { os.setPriority(child.pid, 10); } catch { /* not allowed here: it runs at the normal priority */ }
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('speaker diarization timed out')), timeoutMs);
    child.on('message', (m) => {
      if (m.t === 'diarized') finish(resolve, { turns: m.turns, voices: m.voices });
      else if (m.t === 'error') finish(reject, new Error(m.message));
    });
    child.on('exit', (code, sig) => finish(reject, new Error(`speaker diarization worker exited (${sig || code})`)));
    child.send({ t: 'diarize', ...opts });
  });
}

module.exports = { diarize };
