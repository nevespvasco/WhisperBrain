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

// Naming accuracy: of all the speech, the share of time that carries the right person's name. Where WDER asks "was the right
// voice given the words", this asks "did the voice get the right name": speech = Map(voice -> [[startMs, endMs]]),
// truth = voice -> the person's name, assigned = Map(voice -> name) (a voice left out is unnamed). Unnamed speech is not right,
// but it is told apart from wrongly named speech: precision = right / (right + wrong), for what was named at all.
const { nameKey } = require('../src/meet/protocol');

function namingAccuracy({ speech, truth, assigned }) {
  let rightMs = 0, wrongMs = 0, unnamedMs = 0;
  for (const [voice, spans] of speech) {
    const ms = spans.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
    const name = assigned.get(voice);
    if (!name) unnamedMs += ms;
    else if (nameKey(name) === nameKey(truth[voice])) rightMs += ms;
    else wrongMs += ms;
  }
  const total = rightMs + wrongMs + unnamedMs;
  return { accuracy: total ? rightMs / total : 0, precision: rightMs + wrongMs ? rightMs / (rightMs + wrongMs) : 0, rightMs, wrongMs, unnamedMs };
}

// ---- Time-based diarization metrics (seconds) ----
// Speaker turns from timed words: words of one speaker closer than `mergeGap` join into one turn. The AMI references
// here are word alignments, not hand-drawn segments, so this is how reference turns are made (as in the "only words"
// AMI setup used by pyannote/BUT); a hypothesis is turned into turns the same way when only its words are known.
function turnsFromWords(words, { mergeGap = 0.5 } = {}) {
  const out = [];
  for (const [speaker, ws] of bySpeaker([...words].sort((a, b) => a.start - b.start))) {
    let cur = null;
    for (const w of ws) {
      if (cur && w.start - cur.end <= mergeGap) cur.end = Math.max(cur.end, w.end);
      else { if (cur) out.push(cur); cur = { speaker, start: w.start, end: w.end }; }
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => a.start - b.start);
}

// Frame grid: frame f covers [f*step, (f+1)*step). -> { ids: [speaker], act: Uint8Array per speaker }
function rasterize(turns, step, frames) {
  const ids = [...new Set(turns.map((t) => t.speaker))];
  const act = ids.map(() => new Uint8Array(frames));
  for (const t of turns) {
    const a = act[ids.indexOf(t.speaker)];
    for (let f = Math.max(0, Math.round(t.start / step)); f < Math.min(frames, Math.round(t.end / step)); f++) a[f] = 1;
  }
  return { ids, act };
}

// DER as in NIST md-eval / pyannote.metrics: (missed + false alarm + confusion) / reference speaker time, overlap
// scored, after the best one-to-one speaker mapping (Hungarian on co-activity). collar: seconds around each reference
// boundary that are not scored (0 = the strict setting most recent papers report). Also returns JER (Jaccard error
// rate, DIHARD/dscore: mean over reference speakers of 1 - |r∩h| / |r∪h| under the best mapping) and frame-level
// overlap detection precision/recall (frames with >= 2 speakers in the reference vs the hypothesis).
function diarization(refTurns, hypTurns, { collar = 0, step = 0.01 } = {}) {
  const end = Math.max(0, ...refTurns.map((t) => t.end), ...hypTurns.map((t) => t.end));
  const frames = Math.ceil(end / step) + 1;
  const R = rasterize(refTurns, step, frames), H = rasterize(hypTurns, step, frames);
  const scored = new Uint8Array(frames).fill(1);
  if (collar > 0) {
    const c = Math.round(collar / step);
    for (const t of refTurns) for (const b of [t.start, t.end]) {
      const f = Math.round(b / step);
      for (let k = Math.max(0, f - c); k < Math.min(frames, f + c); k++) scored[k] = 0;
    }
  }
  const co = H.act.map((h) => R.act.map((r) => { let n = 0; for (let f = 0; f < frames; f++) if (scored[f] && h[f] && r[f]) n++; return n; }));
  const pick = H.ids.length && R.ids.length ? hungarian(co.map((row) => row.map((x) => -x))) : [];
  const mapped = H.ids.map((_, k) => (pick[k] >= 0 && pick[k] < R.ids.length ? pick[k] : -1));
  let total = 0, miss = 0, fa = 0, conf = 0;
  let ovRef = 0, ovHyp = 0, ovBoth = 0;
  for (let f = 0; f < frames; f++) {
    let nr = 0, nh = 0, ok = 0;
    for (const r of R.act) nr += r[f];
    for (let k = 0; k < H.act.length; k++) if (H.act[k][f]) { nh++; if (mapped[k] >= 0 && R.act[mapped[k]][f]) ok++; }
    if (nr >= 2) ovRef++;
    if (nh >= 2) ovHyp++;
    if (nr >= 2 && nh >= 2) ovBoth++;
    if (!scored[f]) continue;
    total += nr;
    miss += Math.max(0, nr - nh); fa += Math.max(0, nh - nr); conf += Math.min(nr, nh) - ok;
  }
  const jac = R.act.map((r) => H.act.map((h) => { let i = 0, u = 0; for (let f = 0; f < frames; f++) { if (!scored[f]) continue; i += r[f] & h[f]; u += r[f] | h[f]; } return u ? i / u : 0; }));
  const jp = R.ids.length && H.ids.length ? hungarian(jac.map((row) => row.map((x) => -x))) : [];
  const jer = R.ids.length ? R.ids.reduce((a, _, i) => a + 1 - (jp[i] >= 0 && jp[i] < H.ids.length ? jac[i][jp[i]] : 0), 0) / R.ids.length : null;
  const p = ovHyp ? ovBoth / ovHyp : null, rc = ovRef ? ovBoth / ovRef : null;
  return {
    der: total ? (miss + fa + conf) / total : null, miss: total ? miss / total : null, falseAlarm: total ? fa / total : null, confusion: total ? conf / total : null,
    jer, overlap: { precision: p, recall: rc, f1: p && rc ? (2 * p * rc) / (p + rc) : 0, refSeconds: ovRef * step, hypSeconds: ovHyp * step },
  };
}

// Reference overlap regions: [[start, end]] (seconds) where >= 2 speakers are active.
function overlapRegions(turns, { step = 0.01 } = {}) {
  const end = Math.max(0, ...turns.map((t) => t.end));
  const frames = Math.ceil(end / step) + 1;
  const { act } = rasterize(turns, step, frames);
  const out = [];
  let from = -1;
  for (let f = 0; f <= frames; f++) {
    let n = 0;
    if (f < frames) for (const a of act) n += a[f];
    if (n >= 2 && from < 0) from = f;
    if (n < 2 && from >= 0) { out.push([from * step, f * step]); from = -1; }
  }
  return out;
}

// Speaker-agnostic WER split by whether a reference word lies in an overlap region (by its midpoint). Substitutions and
// deletions count where the reference word is; an insertion counts where the inserted word's midpoint is. Inputs
// normalized. -> { in: { wer, words, errors }, out: { ... } }
function werByOverlap(ref, hyp, regions) {
  const inside = (w) => { const m = (w.start + w.end) / 2; return regions.some(([a, b]) => m >= a && m < b); };
  const { pairs } = align(ref, hyp);
  const pr = new Set(pairs.map(([i]) => i)), ph = new Set(pairs.map(([, j]) => j));
  const acc = { in: { words: 0, errors: 0 }, out: { words: 0, errors: 0 } };
  ref.forEach((w, i) => { const k = inside(w) ? 'in' : 'out'; acc[k].words++; if (!pr.has(i)) acc[k].errors++; });
  for (const [i, j] of pairs) if (ref[i].word !== hyp[j].word) acc[inside(ref[i]) ? 'in' : 'out'].errors++;
  hyp.forEach((w, j) => { if (!ph.has(j)) acc[inside(w) ? 'in' : 'out'].errors++; });
  for (const k of ['in', 'out']) acc[k].wer = acc[k].words ? acc[k].errors / acc[k].words : null;
  return acc;
}

// Everything time-based for one recording. hypTurns: the diarization's own turns when known (seconds, same clock as the
// reference); otherwise they are made from the hypothesis words like the reference turns.
function scoreTime(refWords, hypWords, { hypTurns = null, mergeGap = 0.5 } = {}) {
  const refT = turnsFromWords(refWords, { mergeGap });
  const hypT = hypTurns || turnsFromWords(hypWords, { mergeGap });
  const strict = diarization(refT, hypT, { collar: 0 });
  const lenient = diarization(refT, hypT, { collar: 0.25 });
  const split = werByOverlap(normalize(refWords), normalize(hypWords), overlapRegions(refT));
  return { der: strict.der, derCollar: lenient.der, miss: strict.miss, falseAlarm: strict.falseAlarm, confusion: strict.confusion, jer: strict.jer, overlap: strict.overlap, werInOverlap: split.in.wer, werOutOverlap: split.out.wer, overlapWords: split.in.words };
}

module.exports = { normalize, align, wder, cpwer, tcpwer, wer, score, toSegLst, namingAccuracy, turnsFromWords, diarization, overlapRegions, werByOverlap, scoreTime };
