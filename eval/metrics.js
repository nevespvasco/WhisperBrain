'use strict';
// Who-said-what metrics for the speaker evaluation harness (pure JS, no dependencies):
//   WDER   word diarization error rate (DiarizationLM, arXiv 2401.03506): of the words the recognizer got right or
//          substituted, the share given to the wrong speaker, after the best one-to-one speaker mapping. It measures
//          attribution with ASR errors held fixed.
//   cpWER  concatenated minimum-permutation WER: each speaker's words in order, speakers paired optimally.
//   tcpWER cpWER where a reference and a hypothesis word may only be paired when their times overlap (± collar), as
//          in meeteval (github.com/fgnt/meeteval), so text put in the wrong place in time counts as an error.
// Words are { speaker, start, end, word } with times in seconds. A word list goes through normalize() first.
const { hungarian } = require('../src/speakers/hungarian');

// Hesitations are dropped on both sides: AMI transcribes them, recognizers mostly do not, and they say nothing about
// who spoke.
const FILLERS = new Set(['uh', 'um', 'uhm', 'umm', 'er', 'erm', 'hmm', 'mm', 'mhm', 'mmhmm', 'ah', 'eh', 'huh', 'hm']);

function normalize(words) {
  const out = [];
  for (const w of words) {
    const toks = String(w.word).toLowerCase().replace(/[‘’]/g, "'").replace(/-/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ')
      .split(/\s+/).map((t) => t.replace(/^'+|'+$/g, '')).filter((t) => t && !FILLERS.has(t));
    if (!toks.length) continue;
    const step = (w.end - w.start) / toks.length; // a token that split into several shares its time
    toks.forEach((t, i) => out.push({ speaker: w.speaker, start: w.start + i * step, end: w.start + (i + 1) * step, word: t }));
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Levenshtein alignment of two word lists. canPair(r, h): may these two be matched or substituted (tcpWER's time
// constraint)? -> { errors, pairs: [[ri, hi], ...] (matches and substitutions) }
function align(ref, hyp, canPair = null) {
  const n = ref.length, m = hyp.length;
  const W = m + 1;
  const cost = new Uint32Array((n + 1) * W);
  const back = new Uint8Array((n + 1) * W); // 0 diag, 1 deletion (ref only), 2 insertion (hyp only)
  for (let j = 1; j <= m; j++) { cost[j] = j; back[j] = 2; }
  for (let i = 1; i <= n; i++) {
    cost[i * W] = i; back[i * W] = 1;
    for (let j = 1; j <= m; j++) {
      const del = cost[(i - 1) * W + j] + 1, ins = cost[i * W + j - 1] + 1;
      let best = del, b = 1;
      if (ins < best) { best = ins; b = 2; }
      if (!canPair || canPair(ref[i - 1], hyp[j - 1])) {
        const d = cost[(i - 1) * W + j - 1] + (ref[i - 1].word === hyp[j - 1].word ? 0 : 1);
        if (d <= best) { best = d; b = 0; }
      }
      cost[i * W + j] = best; back[i * W + j] = b;
    }
  }
  const pairs = [];
  for (let i = n, j = m; i || j;) {
    const b = back[i * W + j];
    if (b === 0) { pairs.push([i - 1, j - 1]); i--; j--; } else if (b === 1) i--; else j--;
  }
  return { errors: cost[n * W + m], pairs: pairs.reverse() };
}

const bySpeaker = (words) => {
  const g = new Map();
  for (const w of words) { if (!g.has(w.speaker)) g.set(w.speaker, []); g.get(w.speaker).push(w); }
  return g;
};

// Both inputs already normalized.
function wder(ref, hyp) {
  const { pairs } = align(ref, hyp);
  if (!pairs.length) return { wder: null, aligned: 0, wrong: 0 };
  const rs = [...new Set(ref.map((w) => w.speaker))], hs = [...new Set(hyp.map((w) => w.speaker))];
  const co = hs.map(() => new Float64Array(rs.length));
  for (const [i, j] of pairs) co[hs.indexOf(hyp[j].speaker)][rs.indexOf(ref[i].speaker)]++;
  const pick = hungarian(co.map((row) => Array.from(row, (x) => -x)));
  const map = new Map(hs.map((h, k) => [h, pick[k] >= 0 ? rs[pick[k]] : null]));
  const wrong = pairs.filter(([i, j]) => map.get(hyp[j].speaker) !== ref[i].speaker).length;
  return { wder: wrong / pairs.length, aligned: pairs.length, wrong };
}

// cpWER / tcpWER: errors are additive over speaker pairs, so the optimal pairing is a Hungarian assignment on the
// pairwise distances (an unpaired speaker costs all of its words).
function permutationWer(ref, hyp, canPair = null) {
  const R = [...bySpeaker(ref).values()], H = [...bySpeaker(hyp).values()];
  const n = Math.max(R.length, H.length);
  const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    if (i < R.length && j < H.length) return align(R[i], H[j], canPair).errors;
    return i < R.length ? R[i].length : j < H.length ? H[j].length : 0;
  }));
  const pick = hungarian(cost);
  let errors = 0;
  for (let i = 0; i < n; i++) errors += cost[i][pick[i]];
  return { wer: ref.length ? errors / ref.length : null, errors, length: ref.length, refSpeakers: R.length, hypSpeakers: H.length };
}

const cpwer = (ref, hyp) => permutationWer(ref, hyp);
const tcpwer = (ref, hyp, collar = 5) => permutationWer(ref, hyp, (r, h) => h.start - collar < r.end && r.start < h.end + collar);

// Speaker-agnostic WER (all words in time order), for context.
const wer = (ref, hyp) => (ref.length ? align(ref, hyp).errors / ref.length : null);

function score(refWords, hypWords, { collar = 5 } = {}) {
  const ref = normalize(refWords), hyp = normalize(hypWords);
  return { wer: wer(ref, hyp), ...wder(ref, hyp), cpwer: cpwer(ref, hyp).wer, tcpwer: tcpwer(ref, hyp, collar).wer, refSpeakers: new Set(ref.map((w) => w.speaker)).size, hypSpeakers: new Set(hyp.map((w) => w.speaker)).size, refWords: ref.length };
}

// meeteval's SegLST (one entry per word), to cross-check with `meeteval-wer tcpwer -r ref.json -h hyp.json`.
const toSegLst = (words, session) => words.map((w) => ({ session_id: session, speaker: String(w.speaker), start_time: w.start, end_time: w.end, words: w.word }));

module.exports = { normalize, align, wder, cpwer, tcpwer, wer, score, toSegLst };
