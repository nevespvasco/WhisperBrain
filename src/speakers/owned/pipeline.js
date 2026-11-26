'use strict';
// The owned diarization pipeline (pyannote speaker-diarization-3.1 recipe, reimplemented): 10 s windows every 1 s,
// segmentation-3.0 per window (who is active, overlap included), one voice embedding per active local speaker from
// the frames where it speaks alone, global clustering of those embeddings, then the frame-level activity of every
// global speaker rebuilt by averaging the overlapping windows. Unlike sherpa's OfflineSpeakerDiarization:
//   - windows can be processed while the recording runs (DiarizationState.add), so Stop only clusters and rebuilds;
//   - the output has overlap-aware turns, exclusive turns (one speaker per moment, for word assignment) and the
//     overlap regions themselves.
// Pure apart from the injected `segment` (segmentation.js) and `embed` (voice model) functions.
const { WINDOW, FRAMES, FRAME_STEP, FRAME_SPAN, LOCAL, RATE, frameSamples } = require('./segmentation');
const { ahc, dot } = require('./ahc');
const { pldaFeatures, vbx } = require('./vbx');
const { hungarian } = require('../hungarian');

const DEFAULTS = {
  step: RATE,                 // 1 s between windows (pyannote: 10 % of the window)
  minActiveRatio: 0.2,        // a local speaker trains the clustering only with >= 2 s of solo speech in its window
  minEmbedSamples: 0.25 * RATE, // shorter masked audio gives no embedding
  threshold: 0.65,            // AHC distance (pyannote 3.1 uses 0.7046; 0.65 was better on the tuning meetings, eval/README.md)
  minClusterSize: 12,
  constrained: true,          // two local speakers of one window never go to the same global speaker
  minDurationOn: 0.2, minDurationOff: 0.5, // as the sherpa pipeline used here (seconds)
  maxTrain: 4000,             // longer meetings train the clustering on an even subsample
  // VBx (used when a PLDA is given): over-split AHC start, then the VB mixture keeps the speakers the data supports
  plda: null, vbxThreshold: 0.4, Fa: 0.07, Fb: 0.8, minPrior: 1e-7,
};

// Window starts for `total` samples: every `step` while a whole window fits, then one zero-padded window for the rest.
function windowStarts(total, step = DEFAULTS.step) {
  const out = [];
  for (let s = 0; s + WINDOW <= total; s += step) out.push(s);
  const end = out.length ? out[out.length - 1] + WINDOW : 0;
  if (total > 0 && end < total) out.push(out.length ? out[out.length - 1] + step : 0);
  return out;
}

// The samples of one local speaker in a window: its solo frames when there are enough, else all its frames.
// seg: Uint8Array(FRAMES*3). valid: samples of real audio in the window (the rest is padding). -> [[from, to)] or []
function speakerRanges(seg, k, valid, { minEmbedSamples = DEFAULTS.minEmbedSamples } = {}) {
  const pick = (solo) => {
    const ranges = [];
    let n = 0;
    for (let f = 0; f < FRAMES; f++) {
      if (!seg[f * LOCAL + k]) continue;
      if (solo && seg[f * LOCAL] + seg[f * LOCAL + 1] + seg[f * LOCAL + 2] !== 1) continue;
      let [a, b] = frameSamples(f);
      a = Math.max(0, a); b = Math.min(valid, b);
      if (b <= a) continue;
      const last = ranges[ranges.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else ranges.push([a, b]);
      n += b - a;
    }
    return { ranges, n };
  };
  const solo = pick(true);
  if (solo.n >= minEmbedSamples) return solo.ranges;
  const all = pick(false);
  return all.n >= minEmbedSamples ? all.ranges : [];
}

function gather(audio, ranges) {
  const out = new Float32Array(ranges.reduce((a, [x, y]) => a + y - x, 0));
  let at = 0;
  for (const [a, b] of ranges) { out.set(audio.subarray(a, b), at); at += b - a; }
  return out;
}

// Frames where local speaker k is active / active alone.
function activity(seg, k) {
  let active = 0, solo = 0;
  for (let f = 0; f < FRAMES; f++) {
    if (!seg[f * LOCAL + k]) continue;
    active++;
    if (seg[f * LOCAL] + seg[f * LOCAL + 1] + seg[f * LOCAL + 2] === 1) solo++;
  }
  return { active, solo };
}

// What is kept per window: where it starts, the binary activity of its local speakers, and their embeddings.
// Everything clustering and rebuilding need, without the audio (~2 KB per window).
class DiarizationState {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.windows = [];        // [{ start, seg, emb: [Float32Array|null], active: [n], solo: [n] }] in order of start
    this.total = 0;
  }

  // Next windows to compute when `available` samples exist (final: also the padded last window).
  pending(available, final = false) {
    const starts = final ? windowStarts(available, this.o.step) : windowStarts(available, this.o.step).filter((s) => s + WINDOW <= available);
    const done = new Set(this.windows.map((w) => w.start));
    return starts.filter((s) => !done.has(s));
  }

  // Compute windows. read(from, to) -> Float32Array of samples [from, to) (shorter at the end).
  // segment([Float32Array(WINDOW)]) -> Promise<[Uint8Array]>; embed(Float32Array) -> Float32Array|null.
  async add(starts, { read, segment, embed, batch = 16 }) {
    for (let i = 0; i < starts.length; i += batch) {
      const group = starts.slice(i, i + batch);
      const audio = group.map((s) => { const a = read(s, s + WINDOW); const w = new Float32Array(WINDOW); w.set(a.subarray(0, WINDOW)); return { w, valid: Math.min(WINDOW, a.length) }; });
      const segs = await segment(audio.map((x) => x.w));
      group.forEach((start, j) => {
        const seg = segs[j];
        const emb = [], active = [], solo = [];
        for (let k = 0; k < LOCAL; k++) {
          const act = activity(seg, k);
          active.push(act.active); solo.push(act.solo);
          const ranges = act.active ? speakerRanges(seg, k, audio[j].valid, this.o) : [];
          emb.push(ranges.length ? embed(gather(audio[j].w, ranges)) : null);
        }
        this.windows.push({ start, seg, emb, active, solo });
      });
    }
    this.windows.sort((a, b) => a.start - b.start);
  }

  // Global speaker per window and local speaker: [Int16Array(3)] (-2 = not active or no embedding).
  cluster({ numSpeakers = 0 } = {}) {
    const o = this.o;
    const entries = [];
    this.windows.forEach((w, wi) => w.emb.forEach((e, k) => { if (e) entries.push({ wi, k, x: unit(e), raw: e, train: w.solo[k] >= o.minActiveRatio * FRAMES }); }));
    const labels = this.windows.map(() => new Int16Array(LOCAL).fill(-2));
    if (!entries.length) return { labels, centroids: [] };
    let train = entries.filter((e) => e.train);
    if (!train.length) train = entries;
    if (train.length > o.maxTrain) { const stride = train.length / o.maxTrain; train = Array.from({ length: o.maxTrain }, (_, i) => train[Math.floor(i * stride)]); }
    let { centroids } = ahc(train.map((e) => e.x), { threshold: o.threshold, minClusterSize: o.minClusterSize, numSpeakers });
    if (o.plda && !numSpeakers && train.length > 2) centroids = vbxCentroids(train, o) || centroids;
    // every embedding goes to its closest centroid; within a window, two local speakers never share one (Hungarian)
    const byWindow = new Map();
    for (const e of entries) { if (!byWindow.has(e.wi)) byWindow.set(e.wi, []); byWindow.get(e.wi).push(e); }
    for (const [wi, es] of byWindow) {
      const sim = es.map((e) => centroids.map((c) => dot(e.x, c)));
      if (o.constrained && es.length > 1 && centroids.length > 1) {
        const pick = hungarian(sim.map((row) => row.map((v) => -v)));
        es.forEach((e, i) => { labels[wi][e.k] = pick[i] >= 0 ? pick[i] : argmax(sim[i]); });
      } else es.forEach((e, i) => { labels[wi][e.k] = argmax(sim[i]); });
    }
    return { labels, centroids };
  }

  // Frame-level activity of the global speakers over `total` samples. -> { turns, exclusive, overlaps } in seconds
  // turns: [{ start, end, speaker }] (overlapping), exclusive: the same with one speaker per moment, overlaps: [[s, e]]
  reconstruct(labels, total) {
    const o = this.o;
    const G = Math.ceil(total / FRAME_STEP);
    const K = Math.max(0, ...labels.flatMap((l) => [...l])) + 1;
    const countSum = new Float32Array(G), countN = new Float32Array(G);
    const actSum = Array.from({ length: K }, () => new Float32Array(G)), actN = Array.from({ length: K }, () => new Float32Array(G));
    this.windows.forEach((w, wi) => {
      const g0 = Math.round(w.start / FRAME_STEP);
      const lab = labels[wi];
      for (let f = 0; f < FRAMES; f++) {
        const g = g0 + f;
        if (g >= G) break;
        countSum[g] += w.seg[f * LOCAL] + w.seg[f * LOCAL + 1] + w.seg[f * LOCAL + 2];
        countN[g]++;
        for (let c = 0; c < K; c++) {
          let v = -1;
          for (let k = 0; k < LOCAL; k++) if (lab[k] === c) v = Math.max(v, w.seg[f * LOCAL + k]);
          if (v >= 0) { actSum[c][g] += v; actN[c][g]++; }
        }
      }
    });
    const bin = Array.from({ length: K }, () => new Uint8Array(G));
    const excl = Array.from({ length: K }, () => new Uint8Array(G));
    const ov = new Uint8Array(G);
    const order = Array.from({ length: K }, (_, c) => c);
    for (let g = 0; g < G; g++) {
      const count = countN[g] ? Math.round(countSum[g] / countN[g]) : 0;
      if (!count) continue;
      const act = (c) => (actN[c][g] ? actSum[c][g] / actN[c][g] : 0);
      order.sort((a, b) => act(b) - act(a) || a - b);
      let on = 0;
      for (const c of order) { if (on >= count || act(c) <= 0) break; bin[c][g] = 1; if (!on) excl[c][g] = 1; on++; }
      if (on >= 2) ov[g] = 1;
    }
    const toTurns = (b) => b.flatMap((frames, c) => runs(frames).map(([a, z]) => ({ start: frameTime(a, 'start'), end: Math.min(total / RATE, frameTime(z, 'end')), speaker: c })));
    const tidy = (turns) => smooth(turns, o).sort((a, b) => a.start - b.start || a.end - b.end);
    return { turns: tidy(toTurns(bin)), exclusive: tidy(toTurns(excl)), overlaps: runs(ov).map(([a, z]) => [frameTime(a, 'start'), Math.min(total / RATE, frameTime(z, 'end'))]) };
  }

  // Cluster and rebuild over everything added so far.
  diarize(total, { numSpeakers = 0 } = {}) {
    const { labels, centroids } = this.cluster({ numSpeakers });
    return { ...this.reconstruct(labels, total), labels, centroids };
  }
}

// VBx over the training embeddings -> unit centroids of the speakers it keeps (null if it collapses to nothing).
function vbxCentroids(train, o) {
  const init = ahc(train.map((e) => e.x), { threshold: o.vbxThreshold, minClusterSize: 1 }).labels;
  const fea = train.map((e) => pldaFeatures(e.raw, o.plda));
  const { gamma, pi } = vbx(fea, Float64Array.from(o.plda.phi), init, { Fa: o.Fa, Fb: o.Fb });
  const keep = [...pi.keys()].filter((s) => pi[s] > o.minPrior);
  if (!keep.length) return null;
  const dim = train[0].x.length;
  return keep.map((s) => {
    const c = new Float64Array(dim);
    train.forEach((e, i) => { const g = gamma[i][s]; for (let k = 0; k < dim; k++) c[k] += g * e.x[k]; });
    const n = Math.hypot(...c) || 1;
    return c.map((v) => v / n);
  });
}

// frame g stands for the middle of what it sees; a run of frames [a, z] covers half a step on either side
const frameTime = (g, side) => (g * FRAME_STEP + FRAME_SPAN / 2 + (side === 'start' ? -FRAME_STEP / 2 : FRAME_STEP / 2)) / RATE;

// [[first, last]] runs of 1s
function runs(frames) {
  const out = [];
  let a = -1;
  for (let g = 0; g <= frames.length; g++) {
    const on = g < frames.length && frames[g];
    if (on && a < 0) a = g;
    if (!on && a >= 0) { out.push([a, g - 1]); a = -1; }
  }
  return out;
}

// One speaker's gaps shorter than minDurationOff are closed, then turns shorter than minDurationOn are dropped.
function smooth(turns, { minDurationOn, minDurationOff }) {
  const by = new Map();
  for (const t of turns) { if (!by.has(t.speaker)) by.set(t.speaker, []); by.get(t.speaker).push({ ...t }); }
  const out = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const t of list) {
      const last = merged[merged.length - 1];
      if (last && t.start - last.end < minDurationOff) last.end = Math.max(last.end, t.end); else merged.push(t);
    }
    out.push(...merged.filter((t) => t.end - t.start >= minDurationOn));
  }
  return out;
}

function unit(e) {
  const x = Float64Array.from(e);
  const n = Math.hypot(...x) || 1;
  for (let d = 0; d < x.length; d++) x[d] /= n;
  return x;
}
const argmax = (a) => a.reduce((b, v, i) => (v > a[b] ? i : b), 0);

module.exports = { DiarizationState, windowStarts, speakerRanges, runs, smooth, DEFAULTS };
