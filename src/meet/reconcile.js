'use strict';
// A platform's own transcript (a Teams / Zoom / Meet export) against our recording of the same meeting (pure maths, no I/O).
// Its clock is not ours (it started when the meeting did, we when the person pressed Record) and its words are not quite ours
// (another recogniser), so the two are matched by what was said: each line of the platform's finds the utterance of ours it
// resembles most, those matches vote for the offset between the clocks, and with the offset known the lines name the voices the
// same way live captions do (captions.js alignCaptions).
const { tokens, containment, alignCaptions } = require('./captions');

const DEFAULTS = {
  minTokens: 3,     // "yeah" matches everything
  minScore: 0.6,    // share of the shorter text found in the other, for two lines to count as the same words
  minMargin: 0.1,   // ...and the best utterance must lead the second by this much, or the line says nothing about the offset
  binMs: 2000,      // offsets that agree to within this are the same offset
  minSupport: 3,    // matches that must agree on the offset
  minShare: 0.3,    // ...and be at least this share of the platform's lines that have enough words
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// platform: [{ label, startMs, endMs, text }] (the platform's clock); utterances: [{ id, speakerId, startMs, endMs, text }] (ours)
// -> { ok: true, offsetMs, support, matches: [{ startMs, endMs, name, score, id }] }  (offsetMs: add it to the platform's times
//    to get ours) | { ok: false, reason }
function reconcileTranscript({ platform, utterances, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  if (!platform.some((p) => p.label)) return { ok: false, reason: 'There are no speaker names in this file, so it cannot name anyone.' };
  const ours = utterances.map((u) => ({ u, tok: tokens(u.text) })).filter((x) => x.tok.length >= o.minTokens);
  const lines = platform.map((p) => ({ p, tok: tokens(p.text) })).filter((x) => x.tok.length >= o.minTokens);
  const offsets = [];
  for (const { p, tok } of lines) {
    let best = null, second = 0;
    for (const x of ours) {
      const s = containment(tok, x.tok);
      if (!best || s > best.s) { second = best ? best.s : 0; best = { s, u: x.u }; } else if (s > second) second = s;
    }
    if (best && best.s >= o.minScore && best.s - second >= o.minMargin) offsets.push(best.u.startMs - p.startMs);
  }
  // the offset most matches agree on
  let top = null;
  for (const a of offsets) {
    const group = offsets.filter((b) => Math.abs(b - a) <= o.binMs);
    if (!top || group.length > top.length) top = group;
  }
  if (!top || top.length < o.minSupport || top.length < o.minShare * lines.length) {
    return { ok: false, reason: 'This transcript does not look like this meeting: too few of its lines match what was recorded.' };
  }
  const offsetMs = median(top);
  const captions = platform.filter((p) => p.label).map((p) => ({ t: p.startMs + offsetMs, name: p.label, text: p.text }));
  const matches = alignCaptions({ captions, utterances });
  if (!matches.length) return { ok: false, reason: 'This transcript does not look like this meeting: none of its named lines match what was recorded.' };
  return { ok: true, offsetMs, support: top.length, matches };
}

module.exports = { reconcileTranscript, DEFAULTS };
