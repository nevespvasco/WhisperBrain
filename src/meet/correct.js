'use strict';
// Fixing the voices of a call with the names the meeting window gave (pure maths, no I/O). The clustering of voices
// over-splits one person (two voices, one name) and merges two (one voice, two names); what was highlighted while each
// voice spoke tells which. Only strong evidence acts: a highlight is a guess, the sound of a voice is not, so the
// caller still refuses merges of voices that clearly sound different.
const { nameKey } = require('./protocol');

const DEFAULTS = {
  splitMs: 3000,        // a second name must have been highlighted at least this long over a voice to suspect two people in it
  splitShare: 0.25,     // ...and hold this share of the highlighted time over that voice
  moveShare: 0.7,       // an utterance moves only when this share of it was highlighted as the other name
  moveStray: 0.1,       // ...and at most this share as the voice's own name
  moveMinMs: 1000,      // ...and it lasts at least this long
  overlapShare: 0.1,    // two voices that speak together more than this share of the shorter one's speech are two people
};

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const total = (spans) => spans.reduce((n, [s, e]) => n + e - s, 0);
function sharedMs(x, y) { let n = 0; for (const [a, b] of x) for (const [c, d] of y) n += overlap(a, b, c, d); return n; }

// speech: Map(speakerId -> [[startMs, endMs]]); utterances: [{ id, speakerId, startMs, endMs }]; active: [{ startMs, endMs, name }];
// vote: the result of nameSpeakers (named, unresolved, matrix, display).
// -> { merges: [{ from, into, name }], moves: [{ id, from, name, to }] }  (to: the voice that already has that name, or null: a new voice)
function planCorrections({ speech, utterances, active, vote, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const merges = [], moves = [];
  const byKey = new Map(vote.named.map((n) => [nameKey(n.name), n]));

  // one person heard as two voices: a voice that lost the vote for a name to another voice, and never speaks with it
  const absorbed = new Set();
  for (const u of vote.unresolved) {
    if (!u.duplicate || !u.best) continue;
    const winner = byKey.get(nameKey(u.best));
    const a = winner && speech.get(winner.speakerId), b = speech.get(u.speakerId);
    if (!a || !b || absorbed.has(winner.speakerId)) continue;
    if (sharedMs(a, b) > o.overlapShare * Math.min(total(a), total(b))) continue; // they talk over each other: two people
    merges.push({ from: u.speakerId, into: winner.speakerId, name: u.best });
    absorbed.add(u.speakerId);
  }

  // two people heard as one voice: a voice with a strong second name over it. The name highlighted longest stays with the
  // voice; the utterances that were clearly the other name's go to that name's voice (or a new one).
  for (const [speakerId, per] of vote.matrix) {
    if (absorbed.has(speakerId) || vote.unresolved.some((u) => u.speakerId === speakerId && u.duplicate)) continue;
    const ranked = [...per].sort((x, y) => y[1] - x[1]);
    if (ranked.length < 2) continue;
    const own = ranked[0][0];
    const sum = ranked.reduce((n, [, ms]) => n + ms, 0);
    for (const [other, ms] of ranked.slice(1)) {
      if (ms < o.splitMs || ms / sum < o.splitShare) continue;
      const name = vote.display.get(other);
      const target = byKey.get(other);
      for (const u of utterances) {
        if (u.speakerId !== speakerId) continue;
        const dur = u.endMs - u.startMs;
        if (dur < o.moveMinMs) continue;
        let asOther = 0, asOwn = 0;
        for (const a of active) {
          const k = nameKey(a.name), ov = overlap(u.startMs, u.endMs, a.startMs, a.endMs);
          if (k === other) asOther += ov; else if (k === own) asOwn += ov;
        }
        if (asOther / dur >= o.moveShare && asOwn / dur <= o.moveStray) moves.push({ id: u.id, from: speakerId, name, to: target && target.speakerId !== speakerId ? target.speakerId : null });
      }
    }
  }
  return { merges, moves };
}

module.exports = { planCorrections, DEFAULTS };
