'use strict';
const { hungarian } = require('./hungarian');
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

// A line must run this long before its voice may start a new speaker. A cough or a "yeah" is too short for a voice print to
// mean "a new person": it stays unlabelled live and the after-recording passes place it (the same rule as Cicada's).
const NEW_SPEAKER_MIN_SEC = 2;

class SpeakerTracker {
  // prefix: speaker ids look like `${prefix}1`, `${prefix}2`…
  // max: the most speakers there can be (the user said how many people are on the call); 0 = no limit. Once reached,
  // an utterance joins the closest speaker however far it is. May be changed while recording.
  constructor({ threshold = 0.6, prefix = 's', speakers = [], max = 0 } = {}) {
    this.threshold = threshold;
    this.prefix = prefix;
    this.max = max;
    this.speakers = speakers.map((s) => ({ ...s, centroid: norm(s.centroid) }));
    this.next = this.speakers.reduce((m, s) => Math.max(m, Number(String(s.id).slice(prefix.length)) || 0), 0) + 1;
  }

  // seconds: how long the utterance was. A shorter one that matches nobody gets no speaker ({ id: null }) and changes
  // nothing. Left out, any utterance may start a speaker (imports, the eval harness). -> { id, score, isNew }
  assign(embedding, { seconds = Infinity } = {}) {
    const e = norm(embedding);
    let best = null, score = -1;
    for (const s of this.speakers) { const c = cosine(e, s.centroid); if (c > score) { score = c; best = s; } }
    if (best && (score >= this.threshold || (this.max > 0 && this.speakers.length >= this.max))) {
      best.centroid = blend(best.centroid, best.count, e, 1);
      best.count++;
      return { id: best.id, score, isNew: false };
    }
    if (seconds < NEW_SPEAKER_MIN_SEC) return { id: null, score, isNew: false };
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

// ---- saved voices ----
// Raw cosine between two WeSpeaker embeddings is a poor yardstick: all voices share a large common component, so two
// different people typically score 0.4-0.8 and a fixed threshold either misses people or links strangers (measured on 40
// real readers: at 0.65, 41 % of unknown speakers were linked to somebody when 6 voices were saved). Subtracting the
// average voice first (as x-vector systems do) separates people far better, so a voice print is compared centred on
// the average voice OF ITS CHANNEL: a call and a room microphone each add their own constant colour to every voice, and
// removing it per channel is also what lets a voice saved on one be recognised on the other.
// VOICE_MEAN is the starting point: the mean of the unit-length voice prints of 291 recordings of 40 English readers
// (LibriSpeech dev-clean, see eval/voices.js) on a clean microphone. It belongs to the shipped model (256 dimensions); with
// any other size nothing is centred and a stricter raw threshold applies. The store then pulls each channel's mean towards
// the voices it actually hears (populationMean).
const VOICE_MEAN = (() => {
  const b = Buffer.from('cmyLvWOQBrxjjg29A+6aPHAVWD1kUF89szmvPbDMYL1V6bg9PaCQvS31EzwEETi9eSlCO/y1pbx/jmW9QLpGOjrrBz118SI957lqPdjbD72DbSQ8qyD+vIMyFruJEJm9fQrDOwmPVr0+hig9iwJ5vXEXiT0+mBS6Tjl1vIA0mzzmp+888KqOvVQBAr7J9xk90oFXvPjq0rwwFJw9E9PVvYvq4ruJLHM9nYHSvI2UrTy71Hi9QFw8Pcs6WD0LbOS88pmHvQUobTz7Z8085b47vS8FFD3XZjS9GpV1vLnF3DxoXK69o/hcPdgfPz31QJe9wsYHO7OK5r3JvBs9yIjWul1h0rwD63m9pQKIvQ08DLsguAe7pyMIvhKF3jxzUKI9APQ8vYaa7buWce48iusqvUNpgztl2KM8alExO9NpOz1KcSm8hiVJPR6WqTz2CCm936ipPa9cxz2uVP+8FPkHPFyVdbwyCLC8Z/3UPKaxU70vX4k9z/qoPeJwnjyiogi9RdqsPYAtlj3Oiky9apRnPcVWizzY7Yq8egmPvVl9OL2zhZw7c9mMvfWdXzzNOLC7cKgDPY51azx00xk8IfBCvX18m71B9xK82HHEPJtyyrxi/AC8vqogve4aAb2dYZM94hhTO/Ue9b0WWpQ9f/iAvDGA9bsyi5m67eREPPIOX72TYWm88aAAPvUP/zvY48+8njb2vIg5yjxDWY28ARAjvYSaNT1P4D29iW4rvGx3FDwCm1S85QDXPCiMVTyjg4k9N2iKvXcQ0zwS3m+9JX+UvE7s0jx3sIA9HuK7PIdlPbygKu28f7WevGPvFL3gxXE8N+cvvYCzdDzTPHY8rj4AvZDgcr3hpTA9u9PFPFQyZD1j8rq824eFPJc/iT01Ebk8EEMYPJnUfTwGAJe8ti4bPKqVhDudzri7O3ievUo03TzXlhO8luwIvUWAEL1q6vU8T6q2OxFWr7wADpi9zSQovbl5Db3Hami9yLwKvZdm/LtMyUK8iUErvQvkJD3vytA8QwGQvc+CD70abL07ztpSPZ5Sfz0fKx692lSTvRtnE73Q2pO92PEmPdBKiT0beKC7XlWgPCX0wb15XdC6sJIJvk4t3LxUEI+8MduKvXkeSbxvS0E7Gg2kvT29+jyAY0A9TaAVvReBGLyGSC08iMuRvf6utT1n+ba95VjuO9DvMT2Xe5y97ovyvPlADz7v9m09e4R0Pfc1ZTwuePm8wcMcPcrE5rx8my69Du2QvVnn8jpd9KS9njE1PenAhr1hu8+7TYm9OcN/trtMuKQ8tQ7bOpx9Tj3JLIW8UaSEvP/mOzxTK+A8a5nePOs5Iz3usLa80MUlvU8zij2tj0Q9E0qZOw==', 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
})();

function centre(v, mu) {
  const e = norm(v);
  if (!mu || mu.length !== e.length) return e;
  const o = new Float32Array(e.length);
  for (let i = 0; i < e.length; i++) o[i] = e[i] - mu[i];
  return norm(o);
}

// The average voice of one channel: the mean of the distinct voices heard on it (voice prints within `sim` of each other
// count once, so the person who is in every meeting does not become the average), with `prior` counting as k0 voices.
function populationMean(vectors, prior = null, k0 = 0, { sim = 0.9 } = {}) {
  const protos = [];
  for (const v of vectors) {
    const e = norm(v);
    const near = protos.find((p) => cosine(p.v, e) >= sim);
    if (near) { near.v = blend(near.v, near.n, e, 1); near.n++; } else protos.push({ v: e, n: 1 });
  }
  const dim = prior ? prior.length : protos[0]?.v.length;
  if (!dim) return null;
  const mu = new Float32Array(dim);
  let n = 0;
  if (prior) { for (let i = 0; i < dim; i++) mu[i] = prior[i] * k0; n = k0; }
  for (const p of protos) { if (p.v.length !== dim) continue; for (let i = 0; i < dim; i++) mu[i] += p.v[i]; n++; }
  if (!n) return prior || null;
  for (let i = 0; i < dim; i++) mu[i] /= n;
  return mu;
}

// Tuned on real speakers (eval/voices.js, "Saved voices" in eval/README.md): threshold and margin on one half of the people,
// scored on the other half.
const MATCH = {
  threshold: 0.6,     // centred similarity needed to link a speaker to a saved voice
  raw: 0.8,           // ... the stricter plain cosine used when there is no mean to centre on
  margin: 0.02,       // ... and how far ahead of the second-best saved voice it has to be (it barely mattered once centred)
  cross: 0,           // what a print heard through another channel loses; centring per channel already accounts for it (0 was best)
  negative: 0.05,     // a speaker at least as close to a voice the user rejected as to the profile (within this) is not linked
  prior: { mic: 10, system: 3 },   // how many heard voices the shipped average counts for, per channel (any value from 3 to 20 did as well)
};
const MAX_PRINTS = 6;    // voice prints kept per saved voice
const MERGE_SIM = 0.9;   // two prints of one channel this alike (plain cosine) are one print
const MAX_REJECTS = 4;

// The positive prints of a voice as { embedding, weight, channel }. A voice without any (an object holding only its
// mean, or a profile from before the print table) is its mean.
function printsOf(v) {
  const pos = (v.exemplars || []).filter((x) => !x.negative);
  return pos.length ? pos : [{ embedding: v.embedding, weight: v.samples || 1, channel: '' }];
}

// How much does a speaker sound like a saved voice? c: the speaker's voice print, channel: where it was heard
// ('mic' | 'system' | ''). The best print counts; a print from the other channel is discounted by `cross`. -1 when the
// user has said this sound is not that person.
function voiceScore(c, v, { channel = '', mu = VOICE_MEAN, cross = MATCH.cross, negative = MATCH.negative } = {}) {
  const muOf = typeof mu === 'function' ? mu : () => mu;       // mu: one mean for every channel, or channel -> mean
  const cc = centre(c, muOf(channel));
  let best = -1;
  for (const x of printsOf(v)) {
    const away = channel && x.channel && x.channel !== channel;   // a print of unknown channel counts as heard the same way
    const s = cosine(cc, centre(x.embedding, muOf(away ? x.channel : channel))) - (away ? cross : 0);
    if (s > best) best = s;
  }
  let rejected = -1;
  for (const x of v.exemplars || []) if (x.negative) rejected = Math.max(rejected, cosine(cc, centre(x.embedding, muOf(channel))));
  return rejected >= 0 && rejected >= best - negative ? -1 : best;
}

// One-to-one assignment of meeting speakers to saved voices, best pairs first. -> Map(speakerId -> {voiceId, score, margin})
// A speaker is linked only to its best voice, if that scores at least `threshold` and is `margin` ahead of the second
// best: a voice that is nearly as close to two people is not guessed. A voice goes to at most one speaker, and a speaker
// whose best voice another speaker took stays unlinked. speakers: [{ id, centroid, channel? }], voices: [{ id, embedding,
// samples?, exemplars? }], allowed(speaker, voice) vetoes pairs (pitch).
function matchVoices(speakers, voices, threshold = MATCH.threshold, allowed = null, opts = {}) {
  const { margin = MATCH.margin, mu = VOICE_MEAN } = opts;
  const muOf = typeof mu === 'function' ? mu : () => mu;
  const pairs = [];
  for (const s of speakers) {
    const m = muOf(s.channel || '');
    const T = m && m.length === s.centroid.length ? threshold : Math.max(threshold, MATCH.raw);
    const scored = [];
    for (const v of voices) {
      if (allowed && !allowed(s, v)) continue;
      scored.push({ v: v.id, c: voiceScore(s.centroid, v, { channel: s.channel || '', ...opts, mu }) });
    }
    scored.sort((a, b) => b.c - a.c);
    if (!scored.length || scored[0].c < T) continue;
    const gap = scored.length > 1 ? scored[0].c - scored[1].c : Infinity;
    if (gap >= margin) pairs.push({ s: s.id, v: scored[0].v, c: scored[0].c, gap });
  }
  // A voice goes to one speaker, and the speakers that want the same voice are settled by the best total (Hungarian, with an
  // "unknown" column of its own for each speaker: a speaker whose voice another speaker took stays unlinked).
  const out = new Map();
  if (!pairs.length) return out;
  const rows = [...new Set(pairs.map((p) => p.s))], cols = [...new Set(pairs.map((p) => p.v))];
  const BIG = 1e6;
  const cost = rows.map((sid, i) => [
    ...cols.map((vid) => { const p = pairs.find((x) => x.s === sid && x.v === vid); return p ? -p.c : BIG; }),
    ...rows.map((_, j) => (j === i ? 0 : BIG)),
  ]);
  const pick = hungarian(cost);
  rows.forEach((sid, i) => {
    const col = pick[i];
    if (col < 0 || col >= cols.length) return;
    const p = pairs.find((x) => x.s === sid && x.v === cols[col]);
    out.set(sid, { voiceId: p.v, score: p.c, margin: p.gap });
  });
  return out;
}

// Add a voice print to a voice's positive prints (pure: returns the new list). prints: [{ embedding, weight, channel, pitch,
// source }]. The same source (a speaker of a note) replaces its earlier print; a print close to one of the same channel (or of
// an unknown one, as profiles from before the channel was kept) is folded into it (weighted by seconds of speech); beyond MAX_PRINTS the two closest prints merge, same channel first.
function addPrint(prints, add, { max = MAX_PRINTS, mergeSim = MERGE_SIM } = {}) {
  const e = norm(add.embedding);
  const np = { embedding: e, weight: Math.max(0.5, add.weight || 1), channel: add.channel || '', pitch: add.pitch || null, source: add.source || null };
  const list = prints.filter((p) => !(np.source && p.source === np.source));
  const fold = (a, b) => ({ embedding: blend(a.embedding, a.weight, b.embedding, b.weight), weight: a.weight + b.weight, channel: a.channel === b.channel || !b.channel ? a.channel : !a.channel ? b.channel : '',
    pitch: a.pitch && b.pitch ? (a.pitch * a.weight + b.pitch * b.weight) / (a.weight + b.weight) : a.pitch || b.pitch || null, source: null });
  let near = -1, nearSim = mergeSim;
  list.forEach((p, i) => { const c = p.channel === np.channel || !p.channel || !np.channel ? cosine(p.embedding, e) : -1; if (c >= nearSim) { nearSim = c; near = i; } });
  if (near >= 0) list[near] = fold(list[near], np); else list.push(np);
  while (list.length > max) {
    let bi = -1, bj = -1, best = -2;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const c = cosine(list[i].embedding, list[j].embedding) + (list[i].channel === list[j].channel ? 1 : 0);
      if (c > best) { best = c; bi = i; bj = j; }
    }
    list[bi] = fold(list[bi], list[bj]);
    list.splice(bj, 1);
  }
  return list;
}

const toBlob = (f32) => (f32 ? Buffer.from(new Float32Array(f32).buffer) : null);
const fromBlob = (buf) => (buf ? new Float32Array(new Uint8Array(buf).slice().buffer) : null);

module.exports = { SpeakerTracker, NEW_SPEAKER_MIN_SEC, mergeClusters, matchVoices, voiceScore, addPrint, centre, populationMean, VOICE_MEAN, MATCH, MAX_REJECTS, cosine, norm, blend, toBlob, fromBlob };
