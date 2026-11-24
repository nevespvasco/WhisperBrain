'use strict';
// A platform's own transcript (a Teams / Zoom / Meet export) against our recording of the same meeting (pure maths, no I/O).
// Its clock is not ours (it started when the meeting did, we when the person pressed Record) and its words are not quite ours
// (another recogniser), so the two are matched by what was said: each line of the platform's finds the utterance of ours it
// resembles most, those matches vote for the offset between the clocks, and with the offset known the lines name the voices the
// same way live captions do (captions.js alignCaptions).
const { tokens, alignCaptions } = require('./captions');

const DEFAULTS = {
  minTokens: 3,     // "yeah" matches everything
  minScore: 0.6,    // share of the shorter text found in the other, for two lines to count as the same words
  minMargin: 0.1,   // ...and the best utterance must lead the second by this much, or the line says nothing about the offset
  binMs: 2000,      // offsets that agree to within this are the same offset
  minSupport: 3,    // matches that must agree on the offset
  minShare: 0.3,    // ...and be at least this share of the platform's lines that have enough words
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const counts = (tok) => { const m = new Map(); for (const t of tok) m.set(t, (m.get(t) || 0) + 1); return m; };

// how much of the shorter text is in the longer one, from the word counts of both (the same number captions.js containment gives)
function overlapShare(aCounts, aLen, bCounts, bLen) {
  let hit = 0;
  for (const [t, n] of aCounts) { const m = bCounts.get(t); if (m) hit += Math.min(n, m); }
  return hit / Math.min(aLen, bLen);
}

// platform: [{ label, startMs, endMs, text }] (the platform's clock); utterances: [{ id, speakerId, startMs, endMs, text }] (ours)
// -> { ok: true, offsetMs, support, matches: [{ startMs, endMs, name, score, id }] }  (offsetMs: add it to the platform's times
//    to get ours) | { ok: false, reason }
function reconcileTranscript({ platform, utterances, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  if (!platform.some((p) => p.label)) return { ok: false, reason: 'There are no speaker names in this file, so it cannot name anyone.' };
  const ours = utterances.map((u) => { const tok = tokens(u.text); return { u, tok, bag: counts(tok) }; }).filter((x) => x.tok.length >= o.minTokens);
  const lines = platform.map((p) => { const tok = tokens(p.text); return { p, tok, bag: counts(tok) }; }).filter((x) => x.tok.length >= o.minTokens);

  // which utterances share words with a line: an index from word to utterances, without the words that are in a fifth of them
  // (the, and, so...), so that a long meeting is not compared line by line against every utterance
  const index = new Map();
  ours.forEach((x, i) => { for (const t of x.bag.keys()) { if (!index.has(t)) index.set(t, []); index.get(t).push(i); } });
  const tooCommon = Math.max(50, ours.length * 0.2);
  const offsets = [];
  for (const { p, tok, bag } of lines) {
    const shared = new Map();
    for (const t of bag.keys()) { const post = index.get(t); if (post && post.length <= tooCommon) for (const i of post) shared.set(i, (shared.get(i) || 0) + 1); }
    let best = null, second = 0;
    for (const [i, n] of shared) {
      if (n < 2 && bag.size > 2) continue;
      const x = ours[i], s = overlapShare(bag, tok.length, x.bag, x.tok.length);
      if (!best || s > best.s) { second = best ? best.s : 0; best = { s, u: x.u }; } else if (s > second) second = s;
    }
    if (best && best.s >= o.minScore && best.s - second >= o.minMargin) offsets.push(best.u.startMs - p.startMs);
  }
  // the offset most matches agree on: the widest stretch of sorted offsets that fits in the bin
  offsets.sort((a, b) => a - b);
  let top = [], lo = 0;
  for (let hi = 0; hi < offsets.length; hi++) {
    while (offsets[hi] - offsets[lo] > 2 * o.binMs) lo++;
    if (hi - lo + 1 > top.length) top = offsets.slice(lo, hi + 1);
  }
  if (top.length < o.minSupport || top.length < o.minShare * lines.length) {
    return { ok: false, reason: 'This transcript does not look like this meeting: too few of its lines match what was recorded.' };
  }
  const offsetMs = median(top);
  const captions = platform.filter((p) => p.label).map((p) => ({ t: p.startMs + offsetMs, name: p.label, text: p.text }));
  const matches = alignCaptions({ captions, utterances });
  if (!matches.length) return { ok: false, reason: 'This transcript does not look like this meeting: none of its named lines match what was recorded.' };
  return { ok: true, offsetMs, support: top.length, matches };
}

module.exports = { reconcileTranscript, DEFAULTS };
