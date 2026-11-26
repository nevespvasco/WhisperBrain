'use strict';
// Worker process for the owned diarization pipeline (pipeline.js). Two ways to use it:
//   one shot (after Stop, or for a file):
//     parent -> worker  diarize {file | pcm, segmentation, embedding, threads, numSpeakers, threshold}
//     worker -> parent  diarized {turns, voices, exclusive, overlaps, stats} | error {message}
//   live (while recording): it follows the channel's spool file as it grows and computes each 10 s window as soon as
//   it is complete, so Stop only has to cluster and rebuild.
//     parent -> worker  live {file, segmentation, embedding, threads, finishThreads, pollMs}
//     worker -> parent  overlap {start, end} (seconds of spool; two or more people at once, from the newest window)
//                       progress {windows, seconds}
//     parent -> worker  finish {samples, numSpeakers, threshold}   (the spool is complete)
//     worker -> parent  diarized {...} | error {message}
// Times are seconds of spooled audio (toTimeline maps them to the note).
const fs = require('node:fs');
const { Segmenter, LOCAL, FRAMES, frameSamples, RATE, WINDOW } = require('./segmentation');
const { DiarizationState, runs } = require('./pipeline');
const { voicesOf } = require('../voices-of');
const { loadPlda } = require('./plda');

// options of the clustering: the PLDA of this voice model when there is one (VBx), else plain AHC; threshold overrides AHC's
const stateOptions = (m) => ({ ...(m.threshold ? { threshold: m.threshold } : {}), plda: m.plda === false ? null : loadPlda(m.embedding) });

const toFloat = (buf) => {
  const b = buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf);
  const i16 = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
};

function makeEmbed(sherpa, model, threads) {
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: threads, provider: 'cpu', debug: 0 });
  return {
    extractor: ex,
    embed: (samples) => {
      const st = ex.createStream();
      st.acceptWaveform({ samples, sampleRate: RATE });
      st.inputFinished();
      return ex.isReady(st) ? Float32Array.from(ex.compute(st, false)) : null;
    },
  };
}

function fileReader(file) {
  const fd = fs.openSync(file, 'r');
  return {
    size: () => fs.fstatSync(fd).size >> 1,
    read: (from, to) => {
      const n = Math.max(0, to - from) * 2;
      const buf = Buffer.alloc(n);
      let got = 0;
      while (got < n) { const r = fs.readSync(fd, buf, got, n - got, from * 2 + got); if (!r) break; got += r; }
      return toFloat(got === n ? buf : buf.subarray(0, got));
    },
    close: () => { try { fs.closeSync(fd); } catch { /* gone */ } },
  };
}

async function finishAndCluster(state, { samples, numSpeakers, read, segmenter, embed, extractor, readAll, t0, altEmbedding = null }) {
  const rest = state.pending(samples, true);
  const tRest = Date.now();
  await state.add(rest, { read, segment: (w) => segmenter.run(w), embed });
  const tCluster = Date.now();
  const out = state.diarize(samples, { numSpeakers });
  const tVoices = Date.now();
  const alt = altEmbedding ? new (require('sherpa-onnx-node').SpeakerEmbeddingExtractor)({ model: altEmbedding, numThreads: 2, provider: 'cpu', debug: 0 }) : null; // an older voice model, for saved voices made with it
  const voices = voicesOf(readAll(), out.turns, extractor, alt);
  return {
    turns: out.turns, exclusive: out.exclusive, overlaps: out.overlaps, voices,
    stats: { windows: state.windows.length, windowsAtFinish: rest.length, speakers: new Set(out.turns.map((t) => t.speaker)).size, msWindowsAtFinish: tCluster - tRest, msCluster: tVoices - tCluster, msVoices: Date.now() - tVoices, msTotal: t0 ? Date.now() - t0 : null },
  };
}

async function oneShot(m) {
  const sherpa = require('sherpa-onnx-node');
  const all = toFloat(m.pcm ? Buffer.from(m.pcm) : fs.readFileSync(m.file));
  const threads = m.threads || 2;
  const segmenter = await new Segmenter(m.segmentation, { threads }).open();
  const { embed, extractor } = makeEmbed(sherpa, m.embedding, threads);
  const state = new DiarizationState(stateOptions(m));
  return finishAndCluster(state, { samples: all.length, numSpeakers: m.numSpeakers || 0, read: (a, b) => all.subarray(a, Math.min(b, all.length)), segmenter, embed, extractor, readAll: () => all, t0: Date.now(), altEmbedding: m.altEmbedding });
}

// ---- live ----
let live = null;
let starting = null, startError = null; // startLive in progress, and why it failed

async function startLive(m) {
  const sherpa = require('sherpa-onnx-node');
  const src = fileReader(m.file);
  const segmenter = await new Segmenter(m.segmentation, { threads: m.threads || 1 }).open();
  const { embed, extractor } = makeEmbed(sherpa, m.embedding, m.threads || 1);
  live = { m, src, segmenter, embed, extractor, state: new DiarizationState(stateOptions(m)), busy: false, finishing: null, emitted: [] };
  const tick = async () => {
    if (!live || live.finishing) return;
    if (!live.busy) {
      live.busy = true;
      try {
        const next = live.state.pending(live.src.size()).slice(0, 8);
        if (next.length) {
          const before = live.state.windows.length;
          await live.state.add(next, { read: live.src.read, segment: (w) => live.segmenter.run(w), embed: live.embed });
          for (const w of live.state.windows.slice(before)) emitOverlaps(w);
          process.send({ t: 'progress', windows: live.state.windows.length, seconds: (live.state.windows.at(-1)?.start + WINDOW) / RATE });
        }
      } catch (e) { process.send({ t: 'warning', message: String(e && e.message || e) }); } finally { live.busy = false; }
    }
    if (live && !live.finishing) live.timer = setTimeout(tick, live.state.pending(live.src.size()).length ? 0 : (m.pollMs || 1000));
  };
  tick();
}

// Two or more local speakers at once in a new window, for at least 0.5 s: an overlap event, once per stretch.
function emitOverlaps(w) {
  const ov = new Uint8Array(FRAMES);
  for (let f = 0; f < FRAMES; f++) if (w.seg[f * LOCAL] + w.seg[f * LOCAL + 1] + w.seg[f * LOCAL + 2] >= 2) ov[f] = 1;
  for (const [a, z] of runs(ov)) {
    const start = (w.start + frameSamples(a)[0]) / RATE, end = (w.start + frameSamples(z)[1]) / RATE;
    if (end - start < 0.5) continue;
    if (live.emitted.some(([s, e]) => start < e && s < end)) { const r = live.emitted.find(([s, e]) => start < e && s < end); r[0] = Math.min(r[0], start); r[1] = Math.max(r[1], end); continue; }
    live.emitted.push([start, end]);
    process.send({ t: 'overlap', start, end });
  }
}

async function finishLive(m) {
  const t0 = Date.now();
  while (live.busy) await new Promise((r) => setTimeout(r, 20));
  live.finishing = true;
  clearTimeout(live.timer);
  const samples = m.samples ?? live.src.size();
  // a backlog at Stop gets more threads (the recording is over: the machine is free)
  let { segmenter, embed, extractor } = live;
  if (live.state.pending(samples, true).length > 20 && (live.m.finishThreads || 0) > (live.m.threads || 1)) {
    const sherpa = require('sherpa-onnx-node');
    segmenter = await new Segmenter(live.m.segmentation, { threads: live.m.finishThreads }).open();
    ({ embed, extractor } = makeEmbed(sherpa, live.m.embedding, live.m.finishThreads));
  }
  const out = await finishAndCluster(live.state, { samples, numSpeakers: m.numSpeakers || 0, read: live.src.read, segmenter, embed, extractor, readAll: () => live.src.read(0, samples), t0, altEmbedding: m.altEmbedding });
  live.src.close();
  return out;
}

process.on('message', async (m) => {
  try {
    if (m.t === 'diarize') process.send({ t: 'diarized', ...(await oneShot(m)) });
    else if (m.t === 'live') { starting = startLive(m).catch((e) => { startError = e; throw e; }); await starting; }
    else if (m.t === 'finish') {
      if (!live && starting) await starting.catch(() => {}); // Stop came while the models were still loading
      if (!live) throw startError || new Error('not following a recording');
      process.send({ t: 'diarized', ...(await finishLive(m)) });
    }
    else throw new Error(`unknown message ${m.t}`);
  } catch (e) { process.send({ t: 'error', message: String(e && e.stack || e) }); }
});
process.on('disconnect', () => process.exit(0));
