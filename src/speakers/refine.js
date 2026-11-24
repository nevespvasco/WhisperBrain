'use strict';
// Second look at who said what, run once a recording has stopped (so live capture never competes for CPU).
//
// While recording, speakers are clustered online from neural voice embeddings, the best that can be done when
// only the past is known. Afterwards the whole meeting is known, and each utterance can be re-examined with
//   - the final voice centroids (early utterances were judged before the centroids settled),
//   - acoustic evidence: pitch and timbre (MFCC), brightness (see ../audio/features.js),
//   - short utterances that had no usable embedding.
// Three passes per channel: re-assign (k-means style, with hysteresis), split (two people merged into one cluster
// that the acoustics clearly show as two), merge (one person split in two that sound identical).
const { WEIGHTS, semitones, voiceFeatures } = require('../audio/features');
const { pcm16ToFloat } = require('../audio/pcm');
const { cosine, norm, blend } = require('./cluster');

const EMB_SCALE = 8;        // 1.0 of cosine similarity is worth this many score points…
const AC_SCALE = 1.5;       // …and one unit of normalised acoustic distance costs this many
const MOVE_MARGIN = 2.0;    // an utterance only changes speaker when the new one scores this much better
const MIN_ACOUSTIC = 6;     // fewer described utterances than this and the acoustics are ignored
const SPLIT_MIN = 12;       // a cluster needs this many described utterances before it may be split
const SPLIT_DPRIME = 4.2;   // separation (in standard deviations) the two halves must show
const MERGE_AC = 1.2;       // two clusters this close acoustically…
const MERGE_SEMITONES = 1.5; // …and this close in pitch…
const SIGMA_FLOOR = 0.6;    // never trust a within-speaker spread tighter than this (z-units): k-means loves to over-tidy noise
const SUM_W = WEIGHTS.reduce((a, b) => a + b, 0);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// Channel-normalised acoustic space: z-scored per dimension, so a microphone's colouration cancels out.
function zSpace(segs) {
  const D = WEIGHTS.length;
  const A = segs.filter((s) => s.acoustic);
  if (A.length < MIN_ACOUSTIC) { for (const s of segs) s.z = null; return false; }
  const mu = new Float64Array(D), sd = new Float64Array(D);
  for (const s of A) for (let d = 0; d < D; d++) mu[d] += s.acoustic.vec[d] / A.length;
  for (const s of A) for (let d = 0; d < D; d++) sd[d] += (s.acoustic.vec[d] - mu[d]) ** 2 / A.length;
  for (let d = 0; d < D; d++) sd[d] = Math.max(Math.sqrt(sd[d]), 1e-3 * (1 + Math.abs(mu[d])));
  for (const s of segs) {
    if (!s.acoustic) { s.z = null; continue; }
    s.z = new Float64Array(D);
    for (let d = 0; d < D; d++) s.z[d] = (s.acoustic.vec[d] - mu[d]) / sd[d];
  }
  return true;
}

// Per-speaker statistics for the current assignment: embedding centroid, acoustic mean, pitch, and the pooled
// within-speaker spread of every acoustic dimension.
function groupStats(segs, assign, prior) {
  const D = WEIGHTS.length;
  const groups = new Map();
  for (const s of segs) {
    const id = assign.get(s.id);
    if (!id) continue;
    let g = groups.get(id);
    if (!g) { g = { id, segs: [], emb: null, embN: 0, zMean: null, zN: 0, f0s: [] }; groups.set(id, g); }
    g.segs.push(s);
    if (s.embedding) { const e = norm(s.embedding); g.emb = g.emb ? blend(g.emb, g.embN, e, 1) : e; g.embN++; }
    if (s.acoustic) g.f0s.push(s.acoustic.f0); // pitch is worth keeping even when there are too few utterances to compare timbre
    if (s.z) {
      g.zMean ||= new Float64Array(D);
      for (let d = 0; d < D; d++) g.zMean[d] += s.z[d];
      g.zN++;
    }
  }
  const within = new Float64Array(D);
  let dof = 0;
  for (const g of groups.values()) {
    if (!g.emb && prior?.has(g.id)) g.emb = prior.get(g.id);
    if (g.zN) for (let d = 0; d < D; d++) g.zMean[d] /= g.zN;
    g.pitch = median(g.f0s);
    if (g.zN >= 2) {
      for (const s of g.segs) if (s.z) for (let d = 0; d < D; d++) within[d] += (s.z[d] - g.zMean[d]) ** 2;
      dof += g.zN - 1;
    }
  }
  const sigma = new Float64Array(D);
  for (let d = 0; d < D; d++) sigma[d] = dof >= 4 ? Math.min(1.5, Math.max(SIGMA_FLOOR, Math.sqrt(within[d] / dof))) : 1;
  return { groups, sigma };
}

// Mean squared standardised distance between an utterance and a speaker's acoustic mean (≈ 1 for the right speaker).
function acousticDist2(z, g, sigma) {
  if (!z || !g.zMean) return null;
  let s = 0;
  for (let d = 0; d < z.length; d++) s += WEIGHTS[d] * ((z[d] - g.zMean[d]) / sigma[d]) ** 2;
  return s / SUM_W;
}

function score(seg, g, sigma) {
  let s = 0, n = 0;
  if (seg.embedding && g.emb) { s += EMB_SCALE * cosine(norm(seg.embedding), g.emb); n++; }
  const d2 = acousticDist2(seg.z, g, sigma);
  if (d2 !== null) { s -= AC_SCALE * d2; n++; }
  return n ? s : null;
}

function reassign(segs, assign, prior, threshold) {
  let movedTotal = 0;
  for (let it = 0; it < 6; it++) {
    const { groups, sigma } = groupStats(segs, assign, prior);
    const ids = [...groups.keys()];
    let moved = 0;
    for (const s of segs) {
      if (!s.embedding && !s.z) continue;
      const cur = assign.get(s.id) || null;
      const scores = new Map();
      for (const id of ids) { const v = score(s, groups.get(id), sigma); if (v !== null) scores.set(id, v); }
      if (!scores.size) continue;
      let best = null;
      for (const [id, v] of scores) if (best === null || v > scores.get(best)) best = id;
      if (cur) {
        if (best !== cur && scores.has(cur) && scores.get(best) - scores.get(cur) >= MOVE_MARGIN) { assign.set(s.id, best); moved++; }
      } else if (s.embedding) {
        if (cosine(norm(s.embedding), groups.get(best).emb || s.embedding) >= threshold) { assign.set(s.id, best); moved++; }
      } else { // an utterance with no speaker and no embedding: adopt the acoustically obvious one
        const d2 = ids.map((id) => acousticDist2(s.z, groups.get(id), sigma)).filter((x) => x !== null).sort((a, b) => a - b);
        if (d2.length && d2[0] <= 1.5 && (d2.length === 1 || d2[1] - d2[0] >= 1.0)) { assign.set(s.id, best); moved++; }
      }
    }
    movedTotal += moved;
    if (!moved) break;
  }
  return movedTotal;
}

const sqDist = (a, b) => { let s = 0; for (let d = 0; d < a.length; d++) s += (a[d] - b[d]) ** 2; return s; };

// Lloyd iterations for two clusters from the labels in `lab` (0/1, modified in place).
// -> { lab, sse } | null when a half ends up smaller than minSize.
function lloyd(points, lab, minSize) {
  const n = points.length, D = points[0].length;
  let c = null;
  for (let it = 0; it < 20; it++) {
    const sum = [new Float64Array(D), new Float64Array(D)], cnt = [0, 0];
    for (let i = 0; i < n; i++) { cnt[lab[i]]++; for (let d = 0; d < D; d++) sum[lab[i]][d] += points[i][d]; }
    if (!cnt[0] || !cnt[1]) return null;
    c = sum.map((v, k) => v.map((x) => x / cnt[k]));
    let changed = false;
    for (let i = 0; i < n; i++) { const l = sqDist(points[i], c[0]) <= sqDist(points[i], c[1]) ? 0 : 1; if (l !== lab[i]) { lab[i] = l; changed = true; } }
    if (!changed) break;
  }
  let sse = 0;
  const sizes = [0, 0];
  for (let i = 0; i < n; i++) { sse += sqDist(points[i], c[lab[i]]); sizes[lab[i]]++; }
  return sizes[0] >= minSize && sizes[1] >= minSize ? { lab, sse } : null;
}

// Separation of two groups of points: distance between their means along the line joining them, in units of the
// groups' pooled standard deviation along that line ("d prime"; ~2.7 for one Gaussian blob cut in half).
function dPrime(points, a, b) {
  const D = points[0].length;
  const centre = (idx) => { const m = new Float64Array(D); for (const i of idx) for (let d = 0; d < D; d++) m[d] += points[i][d] / idx.length; return m; };
  const ma = centre(a), mb = centre(b);
  const dir = Float64Array.from(mb, (v, d) => v - ma[d]);
  const len = Math.hypot(...dir) || 1;
  const proj = (i) => points[i].reduce((s, v, d) => s + v * dir[d], 0) / len;
  const stat = (idx) => { const p = idx.map(proj); const m = p.reduce((s, v) => s + v, 0) / p.length; return { m, v: p.reduce((s, v) => s + (v - m) ** 2, 0) / p.length }; };
  const sa = stat(a), sb = stat(b);
  const pooled = Math.sqrt((sa.v * a.length + sb.v * b.length) / (a.length + b.length)) || 1e-6;
  return Math.abs(sb.m - sa.m) / pooled;
}

// Two-way split of the points (weighted acoustic vectors). Candidates come from three starting guesses (principal
// axis, the two farthest points, and the best cut of the pitch values in `pitch`), each settled with Lloyd iterations;
// the candidate that is most cleanly bimodal wins. -> [indices of cluster 0, indices of cluster 1] | null
function twoMeans(points, minSize = 2, pitch = null) {
  const n = points.length, D = points[0].length;
  const mean = new Float64Array(D);
  for (const p of points) for (let d = 0; d < D; d++) mean[d] += p[d] / n;

  // principal axis by power iteration on the (implicit) covariance
  let v = Float64Array.from({ length: D }, (_, d) => ((d * 7919) % 13) - 6 || 1);
  for (let it = 0; it < 30; it++) {
    const w = new Float64Array(D);
    for (const p of points) { let dot = 0; for (let d = 0; d < D; d++) dot += (p[d] - mean[d]) * v[d]; for (let d = 0; d < D; d++) w[d] += (p[d] - mean[d]) * dot; }
    const len = Math.hypot(...w) || 1;
    v = w.map((x) => x / len);
  }
  const axis = points.map((p) => p.reduce((s, x, d) => s + (x - mean[d]) * v[d], 0));
  let i1 = 0;
  for (let i = 1; i < n; i++) if (sqDist(points[i], mean) > sqDist(points[i1], mean)) i1 = i;
  let i2 = i1 === 0 ? 1 : 0;
  for (let i = 0; i < n; i++) if (sqDist(points[i], points[i1]) > sqDist(points[i2], points[i1])) i2 = i;
  const starts = [Int8Array.from(axis, (x) => (x > 0 ? 1 : 0)), Int8Array.from(points, (p) => (sqDist(p, points[i1]) <= sqDist(p, points[i2]) ? 0 : 1))];
  if (pitch) { // Otsu's cut of the pitch values: the split that maximises the variance between the two sides
    const order = [...pitch.keys()].sort((x, y) => pitch[x] - pitch[y]);
    let bestCut = -1, bestVar = 0;
    for (let k = minSize; k <= n - minSize; k++) {
      const lo = order.slice(0, k).map((i) => pitch[i]), hi = order.slice(k).map((i) => pitch[i]);
      const ml = lo.reduce((s, x) => s + x, 0) / lo.length, mh = hi.reduce((s, x) => s + x, 0) / hi.length;
      const between = lo.length * hi.length * (ml - mh) ** 2;
      if (between > bestVar) { bestVar = between; bestCut = k; }
    }
    if (bestCut > 0) { const lab = new Int8Array(n); for (const i of order.slice(bestCut)) lab[i] = 1; starts.push(lab); }
  }

  let best = null;
  for (const s0 of starts) {
    const r = lloyd(points, s0, minSize);
    if (!r) continue;
    const idx = [[], []];
    r.lab.forEach((l, i) => idx[l].push(i));
    const dp = dPrime(points, idx[0], idx[1]);
    if (!best || dp > best.dp) best = { idx, dp };
  }
  return best ? best.idx : null;
}

// Is this cluster really two people? Needs: both halves of a useful size, a clean bimodal separation, a real pitch
// gap (or a very large separation), and an embedding that does not insist they are one voice.
function trySplit(g, threshold) {
  const segs = g.segs.filter((s) => s.z);
  if (segs.length < SPLIT_MIN) return null;
  const pts = segs.map((s) => Float64Array.from(s.z, (v, d) => v * Math.sqrt(WEIGHTS[d])));
  const minSize = Math.max(4, Math.ceil(0.15 * segs.length));
  const parts = twoMeans(pts, minSize, segs.map((s) => Math.log(s.acoustic.f0)));
  if (!parts) return null;
  const [a, b] = parts;
  const dprime = dPrime(pts, a, b);
  if (dprime < SPLIT_DPRIME) return null;
  const pa = median(a.map((i) => segs[i].acoustic.f0)), pb = median(b.map((i) => segs[i].acoustic.f0));
  const pitchGap = pa && pb ? semitones(pa, pb) : 0;
  if (pitchGap < 1.5 && dprime < 5) return null;
  const centroid = (idx) => {
    let v = null, n = 0;
    for (const i of idx) if (segs[i].embedding) { const e = norm(segs[i].embedding); v = v ? blend(v, n, e, 1) : e; n++; }
    return v;
  };
  const ea = centroid(a), eb = centroid(b);
  // the embedding may veto a split, unless the acoustics are overwhelming (e.g. a deep voice against a high one)
  const overwhelming = dprime >= 6 && pitchGap >= 4;
  if (!overwhelming && ea && eb && cosine(ea, eb) >= Math.min(0.95, threshold + 0.25)) return null;
  return { a: a.map((i) => segs[i].id), b: b.map((i) => segs[i].id), dprime, pitchGap };
}

// Pairs of clusters that sound the same in every way measured (and whose embeddings are not far apart).
function findMerge(stats, threshold, ident = new Map()) {
  const { groups, sigma } = stats;
  const list = [...groups.values()].filter((g) => g.zMean && g.zN >= 2 && g.emb);
  let best = null;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const x = list[i], y = list[j];
    if (cosine(x.emb, y.emb) < threshold - 0.1) continue;
    const ix = ident.get(x.id), iy = ident.get(y.id);
    if (ix && iy && ix !== iy) continue; // two people the user (or a saved voice) has told apart stay apart
    let s = 0;
    for (let d = 0; d < sigma.length; d++) s += WEIGHTS[d] * ((x.zMean[d] - y.zMean[d]) / sigma[d]) ** 2;
    const dist = Math.sqrt(s / SUM_W);
    if (dist > MERGE_AC) continue;
    if (x.pitch && y.pitch && semitones(x.pitch, y.pitch) > MERGE_SEMITONES) continue;
    if (!best || dist < best.dist) best = { from: x.zN >= y.zN ? y.id : x.id, into: x.zN >= y.zN ? x.id : y.id, dist };
  }
  return best;
}

// segments: [{ id, speakerId, embedding?: Float32Array, acoustic?: { vec, f0 } }]
// speakers: [{ id, centroid?: Float32Array, count, name?, voiceId? }]   (the channel's current speakers)
// -> { assignments: Map(segmentId -> speakerId) (changes only), speakers: [{ id, centroid, count, pitch, isNew }],
//      removed: Map(speakerId -> mergedIntoId), stats: { moved, split, merged, described } }
function refineChannel({ segments, speakers, prefix = 's', threshold = 0.6 }) {
  const segs = segments.map((s) => ({ ...s }));
  const hasAcoustics = zSpace(segs);
  const assign = new Map(segs.map((s) => [s.id, s.speakerId || null]));
  const prior = new Map(speakers.filter((s) => s.centroid).map((s) => [s.id, norm(s.centroid)]));
  const ident = new Map(speakers.map((s) => [s.id, s.name || s.voiceId || '']));
  const stats = { moved: 0, split: 0, merged: 0, described: hasAcoustics ? segs.filter((s) => s.z).length : 0 };
  let next = speakers.reduce((m, s) => Math.max(m, Number(String(s.id).slice(prefix.length)) || 0), 0) + 1;
  const born = new Set();
  const removed = new Map();

  // Structure first (on the online labels, which this pass has not yet bent), then re-assign utterances to the settled speakers.
  for (let round = 0; round < 3; round++) {
    let changed = false;
    if (hasAcoustics) {
      const st = groupStats(segs, assign, prior);
      for (const g of st.groups.values()) {
        const sp = trySplit(g, threshold);
        if (!sp) continue;
        // the larger half keeps the identity (and any name the user gave); the other becomes a new speaker
        const move = sp.a.length >= sp.b.length ? sp.b : sp.a;
        const id = `${prefix}${next++}`;
        for (const sid of move) assign.set(sid, id);
        born.add(id);
        stats.split++;
        changed = true;
      }
      const m = findMerge(groupStats(segs, assign, prior), threshold, ident);
      if (m) {
        for (const [sid, id] of assign) if (id === m.from) assign.set(sid, m.into);
        removed.set(m.from, m.into);
        stats.merged++;
        changed = true;
      }
    }
    stats.moved += reassign(segs, assign, prior, threshold);
    if (!changed) break;
  }

  const final = groupStats(segs, assign, prior);
  const out = [];
  for (const g of final.groups.values()) {
    const old = speakers.find((s) => s.id === g.id);
    out.push({ id: g.id, centroid: g.embN ? g.emb : (old?.centroid ? norm(old.centroid) : null), count: g.embN || old?.count || 0, pitch: g.pitch, isNew: born.has(g.id) });
  }
  const assignments = new Map();
  for (const s of segs) { const now = assign.get(s.id); if (now && now !== (s.speakerId || null)) assignments.set(s.id, now); }
  // a speaker that lost every utterance disappears; where it was merged away, its identity is carried over
  for (const sp of speakers) {
    if (final.groups.has(sp.id) || removed.has(sp.id)) continue;
    if (segs.some((s) => s.speakerId === sp.id)) removed.set(sp.id, null);
  }
  return { assignments, speakers: out, removed, stats };
}

const CHANNELS = [['mic', 'm'], ['system', 's']];
const MAX_UTTERANCE_SECONDS = 8;  // a few seconds of an utterance describe a voice as well as all of it
const MIN_UTTERANCE_BYTES = 16000; // < 0.5 s of audio is not worth describing

// Re-examine a finished note. refs say where each stored utterance's audio is: [{ segId, ch, from, to }] (sample
// offsets); read(ch, from, to) returns that audio as s16le mono 16 kHz. Heavy, so it is cooperative: it yields to
// the event loop between utterances and gives up describing more audio at `deadline` (labels are still refined).
async function refineNote({ speakers, noteId, refs, read, threshold = 0.6, deadline = Date.now() + 120000 }) {
  const rows = speakers.segmentVoices(noteId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let described = 0;
  for (const ref of refs) {
    const row = byId.get(ref.segId);
    if (!row) continue;
    if (Date.now() > deadline) break;
    let buf = null;
    try { buf = read(ref.ch, ref.from, Math.min(ref.to, ref.from + MAX_UTTERANCE_SECONDS * 16000)); } catch { /* audio unavailable: embedding only */ }
    if (buf && buf.length >= MIN_UTTERANCE_BYTES) {
      const f = voiceFeatures(pcm16ToFloat(buf));
      if (f) { row.acoustic = f; described++; }
    }
    await new Promise((r) => setImmediate(r)); // keep the app responsive
  }
  const current = speakers.forNote(noteId);
  const out = { described, moved: 0, split: 0, merged: 0 };
  for (const [channel, prefix] of CHANNELS) {
    const segments = rows.filter((r) => r.channel === channel);
    if (!segments.length) continue;
    const sp = current.filter((s) => s.channel === channel).map((s) => ({ id: s.speakerId, centroid: s.centroid, count: s.count, name: s.name, voiceId: s.voiceId }));
    const res = refineChannel({ segments, speakers: sp, prefix, threshold });
    speakers.applyRefinement(noteId, channel, res);
    out.moved += res.stats.moved; out.split += res.stats.split; out.merged += res.stats.merged;
  }
  return out;
}

module.exports = { refineChannel, refineNote, EMB_SCALE, AC_SCALE };
