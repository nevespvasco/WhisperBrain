'use strict';
// Names from the meeting's live captions (pure maths, no I/O). A caption is a name and the words that person just said,
// written by the meeting service's own recogniser. The app has its own transcript of the same speech, so the two can be
// matched by their words, and every utterance the match finds gets a name with no delay to guess and no highlight to trust.
//
// A caption line grows, then scrolls (the oldest words leave as new ones come), so lines are not followed one by one:
// each reading is matched on its own against the utterances near it in time, and an utterance takes the name of the
// readings that resemble it best.
const { nameKey } = require('./protocol');

const DEFAULTS = {
  before: 1500,      // a caption can only show words that were just said: it is read at most this long before an utterance starts...
  after: 7000,       // ...and the recogniser behind it is a few seconds behind the speaker
  minTokens: 3,      // "yeah" matches everything: both sides need at least this many words
  minScore: 0.5,     // share of the shorter text that the other one holds, to count as the same words
  minMargin: 0.2,    // the best name must lead the second by this much, or the utterance is left alone
};

const tokens = (s) => nameKey(s).split(' ').filter(Boolean);

// how much of the shorter text is in the longer one, counting each word as many times as it is there (0..1)
function containment(a, b) {
  if (!a.length || !b.length) return 0;
  const bag = new Map();
  for (const t of b) bag.set(t, (bag.get(t) || 0) + 1);
  let hit = 0;
  for (const t of a) { const n = bag.get(t); if (n > 0) { hit++; bag.set(t, n - 1); } }
  return hit / Math.min(a.length, b.length);
}

// captions: [{ t, name, text }] (t: the timeline ms when the reading was made); utterances: [{ id, startMs, endMs, text, speakerId }]
// -> [{ startMs, endMs, name, score, id }]: the stretches of the call whose speaker the captions name
function alignCaptions({ captions, utterances, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const reads = captions.filter((c) => c.name).map((c) => ({ ...c, tok: tokens(c.text), key: nameKey(c.name) })).filter((c) => c.tok.length >= o.minTokens);
  const out = [];
  for (const u of utterances) {
    const ut = tokens(u.text);
    if (ut.length < o.minTokens) continue;
    const best = new Map();   // name key -> best containment over the readings near this utterance
    const shown = new Map();
    for (const c of reads) {
      if (c.t < u.startMs - o.before || c.t > u.endMs + o.after) continue;
      const s = containment(c.tok, ut);
      if (s > (best.get(c.key) || 0)) { best.set(c.key, s); shown.set(c.key, c.name); }
    }
    const ranked = [...best].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < o.minScore) continue;
    if (ranked[1] && ranked[0][1] - ranked[1][1] < o.minMargin) continue;
    out.push({ startMs: u.startMs, endMs: u.endMs, name: shown.get(ranked[0][0]), score: ranked[0][1], id: u.id });
  }
  return out;
}

// Highlights say who was lit; captions say who spoke these words. Where both speak, the captions win: the highlight
// is cut away wherever a caption-named stretch is. -> intervals sorted by start
function mergeIntervals(fromCaptions, fromHighlight) {
  const kept = [];
  for (const h of fromHighlight) {
    let pieces = [[h.startMs, h.endMs]];
    for (const c of fromCaptions) {
      pieces = pieces.flatMap(([a, b]) => (c.endMs <= a || c.startMs >= b ? [[a, b]] : [[a, Math.max(a, c.startMs)], [Math.min(b, c.endMs), b]].filter(([x, y]) => y - x > 0)));
    }
    for (const [a, b] of pieces) kept.push({ ...h, startMs: a, endMs: b });
  }
  return [...kept, ...fromCaptions.map(({ startMs, endMs, name, from }) => ({ startMs, endMs, name, ...(from ? { from } : {}) }))].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
}

module.exports = { alignCaptions, mergeIntervals, containment, tokens, DEFAULTS };
