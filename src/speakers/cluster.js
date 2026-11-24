'use strict';
// Speaker identification from voice embeddings (pure maths; no I/O).
//  - SpeakerTracker: online clustering while recording: each utterance joins the closest speaker or starts a new one.
//  - mergeClusters: after the meeting, merges speakers whose voices turned out to be the same person.
//  - matchVoices: maps this meeting's speakers to saved voice profiles ("Ana", "Bruno"), one-to-one.

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x * y) || 1);
}

// Running mean of normalised embeddings, weighted by how many utterances each side represents.
function blend(a, na, b, nb) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] * na + b[i] * nb) / (na + nb);
  return norm(out);
}

class SpeakerTracker {
  // prefix: speaker ids look like `${prefix}1`, `${prefix}2`…
  constructor({ threshold = 0.6, prefix = 's', speakers = [] } = {}) {
    this.threshold = threshold;
    this.prefix = prefix;
    this.speakers = speakers.map((s) => ({ ...s, centroid: norm(s.centroid) }));
    this.next = this.speakers.reduce((m, s) => Math.max(m, Number(String(s.id).slice(prefix.length)) || 0), 0) + 1;
  }

  // -> { id, score, isNew }
  assign(embedding) {
    const e = norm(embedding);
    let best = null, score = -1;
    for (const s of this.speakers) { const c = cosine(e, s.centroid); if (c > score) { score = c; best = s; } }
    if (best && score >= this.threshold) {
      best.centroid = blend(best.centroid, best.count, e, 1);
      best.count++;
      return { id: best.id, score, isNew: false };
    }
    const s = { id: `${this.prefix}${this.next++}`, centroid: e, count: 1 };
    this.speakers.push(s);
    return { id: s.id, score, isNew: true };
  }
}

// Greedy agglomerative merge of speaker clusters. Returns { merged: Map(fromId -> intoId), speakers }.
function mergeClusters(speakers, threshold = 0.6, canMerge = null) {
  let list = speakers.map((s) => ({ ...s, centroid: norm(s.centroid) }));
  const merged = new Map();
  for (;;) {
    let bi = -1, bj = -1, best = threshold;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const c = cosine(list[i].centroid, list[j].centroid);
      if (c >= best && (!canMerge || canMerge(list[i], list[j]))) { best = c; bi = i; bj = j; }
    }
    if (bi < 0) break;
    // keep the speaker heard more often (ties: the earlier id), fold the other into it
    const [keep, drop] = list[bi].count >= list[bj].count ? [list[bi], list[bj]] : [list[bj], list[bi]];
    keep.centroid = blend(keep.centroid, keep.count, drop.centroid, drop.count);
    keep.count += drop.count;
    merged.set(drop.id, keep.id);
    for (const [k, v] of merged) if (v === drop.id) merged.set(k, keep.id);
    list = list.filter((s) => s !== drop);
  }
  return { merged, speakers: list };
}

// One-to-one assignment of meeting speakers to saved voices, best pairs first. -> Map(speakerId -> {voiceId, score})
function matchVoices(speakers, voices, threshold = 0.65, allowed = null) {
  const pairs = [];
  for (const s of speakers) for (const v of voices) {
    if (allowed && !allowed(s, v)) continue;
    const c = cosine(s.centroid, v.embedding);
    if (c >= threshold) pairs.push({ s: s.id, v: v.id, c });
  }
  pairs.sort((a, b) => b.c - a.c);
  const out = new Map();
  const usedV = new Set();
  for (const p of pairs) {
    if (out.has(p.s) || usedV.has(p.v)) continue;
    out.set(p.s, { voiceId: p.v, score: p.c });
    usedV.add(p.v);
  }
  return out;
}

const toBlob = (f32) => (f32 ? Buffer.from(new Float32Array(f32).buffer) : null);
const fromBlob = (buf) => (buf ? new Float32Array(new Uint8Array(buf).slice().buffer) : null);

module.exports = { SpeakerTracker, mergeClusters, matchVoices, cosine, norm, blend, toBlob, fromBlob };
