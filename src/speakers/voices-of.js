'use strict';
// A voice print and a pitch for every speaker of a diarization, pooled over up to 30 s of the stretches where that
// speaker talks alone (soloStretches). Shared by the sherpa diarization worker and the owned pipeline's worker.
// samples: Float32Array of the whole channel (16 kHz), or a reader { length, read(from, to) -> Float32Array } so a long channel is
// never held in memory whole (a 2-hour channel is ~0.5 GB as floats; the prints need about 30 s per speaker);
// turns: [{ start, end, speaker }] in seconds;
// extractor: a sherpa SpeakerEmbeddingExtractor. -> [{ speaker, centroid, pitch, ms, quality }]
// quality: how clean the audio behind the print is, checked before the print is remembered (store.js printProblem):
// { seconds of solo speech used, clipped (share of samples at full scale), snrDb (the speech level against the channel's
// noise floor) }.
const { soloStretches } = require('./diarize');
const { voiceFeatures } = require('../audio/features');

const RATE = 16000;

const FRAME = 320; // 20 ms
function frameRms(x) {
  const out = new Float32Array(Math.floor(x.length / FRAME));
  for (let f = 0; f < out.length; f++) { let s = 0; for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += x[i] * x[i]; out[f] = Math.sqrt(s / FRAME); }
  return out;
}
const quantile = (arr, q) => { if (!arr.length) return 0; const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };

const CHUNK = FRAME * 3000; // a reader is gone through a minute at a time (whole frames, so the frames are the same)

// The channel's noise floor: the quiet end of its 20 ms frames (digital silence left out).
function noiseFloor(samples) {
  if (samples instanceof Float32Array) return quantile(frameRms(samples).filter((v) => v > 1e-5), 0.1);
  const r = [];
  for (let at = 0; at + FRAME <= samples.length; at += CHUNK) for (const v of frameRms(samples.read(at, Math.min(samples.length, at + CHUNK)))) if (v > 1e-5) r.push(v);
  return quantile(r, 0.1);
}

const slice = (samples, from, to) => (samples instanceof Float32Array ? samples.subarray(from, to) : samples.read(from, Math.min(to, samples.length)));

function qualityOf(all, floor) {
  let clipped = 0;
  for (let i = 0; i < all.length; i++) if (Math.abs(all[i]) >= 0.999) clipped++;
  const level = quantile(frameRms(all), 0.5);
  return { seconds: Math.round((all.length / RATE) * 10) / 10, clipped: all.length ? clipped / all.length : 0, snrDb: floor > 0 && level > 0 ? Math.round(20 * Math.log10(level / floor) * 10) / 10 : null };
}

// alt: a second extractor (an older voice model): every speaker then also gets `altCentroid`, the print of the same speech by that model.
function voicesOf(samples, turns, extractor, alt = null) {
  const floor = noiseFloor(samples);
  return [...new Set(turns.map((t) => t.speaker))].map((id) => {
    const ms = Math.round(turns.filter((t) => t.speaker === id).reduce((a, t) => a + t.end - t.start, 0) * 1000);
    const parts = soloStretches(turns, id).map(([s, e]) => slice(samples, Math.round(s * RATE), Math.round(e * RATE)));
    if (!parts.length) return { speaker: id, centroid: null, pitch: null, ms, quality: null };
    const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const print = (ex) => {
      const st = ex.createStream();
      st.acceptWaveform({ samples: all, sampleRate: RATE });
      st.inputFinished();
      return ex.isReady(st) ? Float32Array.from(ex.compute(st, false)) : null; // no external buffers (Electron)
    };
    const centroid = print(extractor);
    const altCentroid = alt ? print(alt) : null;
    const f0 = parts.slice(0, 8).map((p) => voiceFeatures(p.subarray(0, 8 * RATE))?.f0).filter(Boolean).sort((a, b) => a - b);
    return { speaker: id, centroid, altCentroid, pitch: f0.length ? f0[(f0.length - 1) >> 1] : null, ms, quality: qualityOf(all, floor) };
  });
}

module.exports = { voicesOf, qualityOf, noiseFloor };
