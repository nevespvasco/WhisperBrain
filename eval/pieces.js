'use strict';
// EXPERIMENT, not used by the app (see eval/README.md, "Diarization in pieces"). Diarization in pieces. The diarization model costs about 3.5 s of compute per minute of audio, all of it paid after
// Stop when run over the whole meeting. Run on finished pieces of the recording while it is still going, only the
// last piece is left for Stop. Each piece is diarized on its own (speaker ids are local to the piece, with a voice
// print each); merging the pieces' voices into one set of speakers afterwards is the job of mergeVoices(). Pure
// maths, no I/O.
const { cosine, norm, blend } = require('../src/speakers/cluster');
const { semitones } = require('../src/audio/features');

const RATE = 16000;
const PITCH_VETO = 4;   // semitones: two voices this far apart are never the same person

// Where to cut a recording into pieces: after about `targetSec` seconds, at the first pause of at least `minGapSec`
// between utterances (an utterance is never cut in two). utterances: [{ from, to }] in samples, any order.
// -> [[fromSample, toSample]] covering [0, total) in order; the last piece may be short.
function planPieces(utterances, total, { targetSec = 240, minGapSec = 0.6 } = {}) {
  const us = [...utterances].sort((a, b) => a.from - b.from);
  const out = [];
  let start = 0;
  let reach = us.length ? us[0].from : 0;
  for (let i = 0; i + 1 < us.length; i++) {
    reach = Math.max(reach, us[i].to);
    const gap = us[i + 1].from - reach;
    if (reach - start >= targetSec * RATE && gap >= minGapSec * RATE) {
      const cut = reach + Math.floor(gap / 2);
      out.push([start, cut]);
      start = cut;
    }
  }
  if (total > start) out.push([start, total]);
  return out;
}

// Merge the voices of all pieces into global speakers: average-link agglomerative clustering on cosine similarity of
// the voice prints, weighted by speech time.
//   voices: [{ key, piece, centroid, ms, pitch }]  (key is any unique id; the same piece never repeats a person, so
//           two voices of one piece are merged only when `target` forces it)
//   threshold: cosine similarity needed to merge; target: how many speakers to end with, when known
// -> Map(key -> speaker index 0..n-1), in order of first appearance
function mergeVoices(voices, { threshold = 0.5, target = 0, pitchVeto = PITCH_VETO } = {}) {
  let list = voices.filter((v) => v.centroid).map((v) => ({ keys: [v.key], pieces: new Set([v.piece]), centroid: norm(v.centroid), ms: Math.max(1, v.ms || 1), pitch: v.pitch || null, first: v.first ?? 0 }));
  const lonely = voices.filter((v) => !v.centroid);
  const sim = (x, y) => (x.pitch && y.pitch && semitones(x.pitch, y.pitch) > pitchVeto ? -1 : cosine(x.centroid, y.centroid));
  const sharesPiece = (x, y) => [...x.pieces].some((p) => y.pieces.has(p));
  for (const forced of [false, true]) {
    for (;;) {
      if (forced && (!target || list.length <= target)) break;
      let bi = -1, bj = -1, best = forced ? -Infinity : threshold;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (!forced && sharesPiece(list[i], list[j])) continue;
        const c = sim(list[i], list[j]);
        if (c >= best && (c > -1 || forced)) { best = c; bi = i; bj = j; }
      }
      if (bi < 0) break;
      const a = list[bi], b = list[bj];
      const pitch = a.pitch && b.pitch ? (a.pitch * a.ms + b.pitch * b.ms) / (a.ms + b.ms) : (a.pitch || b.pitch);
      list[bi] = { keys: [...a.keys, ...b.keys], pieces: new Set([...a.pieces, ...b.pieces]), centroid: blend(a.centroid, a.ms, b.centroid, b.ms), ms: a.ms + b.ms, pitch, first: Math.min(a.first, b.first) };
      list.splice(bj, 1);
      if (!forced && target && list.length <= target) break;
    }
  }
  list.sort((a, b) => a.first - b.first);
  const out = new Map();
  list.forEach((g, i) => g.keys.forEach((k) => out.set(k, i)));
  for (const v of lonely) out.set(v.key, 0); // no voice print at all (nothing but overlapped speech): the first speaker
  return out;
}

module.exports = { planPieces, mergeVoices };
