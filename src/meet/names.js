'use strict';
// Names for the voices of a call, from what the meeting window said while each voice was speaking (pure maths, no I/O).
//
// The meeting UI highlights one active speaker at a time, with a small delay; the diarization says which voice spoke
// when. A voice takes the name that was highlighted for most of its speech. Two voices never get one name, a voice with
// no clear winner stays unnamed (the app then keeps "Speaker 2"), and overlapped or noisy highlights are outvoted.
const { nameKey } = require('./protocol');

const DEFAULTS = {
  lagMs: 500,        // the highlight appears this long after the voice starts (UI latency): events are moved back by it
  minMs: 200,        // a highlight shorter than this is a flicker
  maxMs: 5 * 60000,  // a highlight is never believed for longer than this without a new event
  minOverlapMs: 1500, // the winning name must have been highlighted at least this long over the voice's speech
  minShare: 0.6,     // ...and hold this share of all the highlighted time over the voice's speech
  minMargin: 1.5,    // ...and beat the runner-up by this factor
  soleMinMs: 4000,   // a call with one other person: their voice needs this much speech to be named without any highlight
};

// events: [{ t, name }] in arrival order, t = timeline ms when it arrived; name null = nobody highlighted.
// -> [{ startMs, endMs, name }] with the lag taken off and flickers dropped
function activeIntervals(events, { lagMs = DEFAULTS.lagMs, minMs = DEFAULTS.minMs, maxMs = DEFAULTS.maxMs, endMs = Infinity } = {}) {
  const ev = events.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    if (!ev[i].name) continue;
    const start = Math.max(0, ev[i].t - lagMs);
    const stop = Math.min(i + 1 < ev.length ? ev[i + 1].t - lagMs : endMs, start + maxMs);
    if (stop - start < minMs) continue;
    const last = out[out.length - 1];
    if (last && last.name === ev[i].name && start - last.endMs < minMs) last.endMs = stop; // the same highlight, flickered off and on
    else out.push({ startMs: start, endMs: stop, name: ev[i].name });
  }
  return out;
}

// The highlights as they arrived, with no lag taken off and nothing dropped: [{ startMs, endMs, name }], one per highlight,
// each running to the arrival of the next event. What is kept as evidence (the lag is a property of the source, applied later).
function rawIntervals(events, { endMs = Infinity, maxMs = DEFAULTS.maxMs } = {}) {
  const ev = events.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    if (!ev[i].name) continue;
    const stop = Math.min(i + 1 < ev.length ? ev[i + 1].t : endMs, ev[i].t + maxMs);
    if (stop > ev[i].t) out.push({ startMs: ev[i].t, endMs: stop, name: ev[i].name });
  }
  return out;
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// Segments of one utterance split where the speaker pauses, so a pause does not count as speech.
// utterances: [{ speakerId, startMs, endMs, words: [[word, startMs, endMs]] | null }] (word times relative to startMs)
function speechOf(utterances, { gapMs = 500 } = {}) {
  const map = new Map();
  const push = (id, a, b) => { if (b > a) { if (!map.has(id)) map.set(id, []); map.get(id).push([a, b]); } };
  for (const u of utterances) {
    if (!u.speakerId) continue;
    if (!Array.isArray(u.words) || !u.words.length) { push(u.speakerId, u.startMs, u.endMs); continue; }
    let from = null, to = null;
    for (const [, s, e] of u.words) {
      const a = u.startMs + s, b = u.startMs + Math.max(e, s);
      if (from === null) { from = a; to = b; } else if (a - to <= gapMs) to = Math.max(to, b); else { push(u.speakerId, from, to); from = a; to = b; }
    }
    if (from !== null) push(u.speakerId, from, to);
  }
  return map;
}

// speech: Map(speakerId -> [[startMs, endMs]]); active: from activeIntervals; remotes: names of the other people on the
// call from the roster (null when no roster); selfKeys: name keys that are the user.
// -> { named: [{ speakerId, name, ms, share, via }], unresolved: [{ speakerId, best, share }] }
function nameSpeakers({ speech, active, remotes = null, selfKeys = [], options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const self = new Set(selfKeys);
  const display = new Map(); // key -> the name as first seen
  const keyOf = (name) => { const k = nameKey(name); if (k && !display.has(k)) display.set(k, name); return k; };
  const iv = active.map((a) => ({ ...a, key: keyOf(a.name) })).filter((a) => a.key && !self.has(a.key));

  // overlap of each voice's speech with each highlighted name
  const rows = [];
  for (const [speakerId, spans] of speech) {
    const per = new Map();
    let total = 0;
    for (const [s, e] of spans) {
      for (const a of iv) {
        const ms = overlap(s, e, a.startMs, a.endMs);
        if (ms > 0) { per.set(a.key, (per.get(a.key) || 0) + ms); total += ms; }
      }
    }
    const ranked = [...per].sort((x, y) => y[1] - x[1]);
    rows.push({ speakerId, speechMs: spans.reduce((n, [s, e]) => n + e - s, 0), ranked, total, per });
  }

  // each voice proposes its winner when the vote is clear...
  const picks = [];
  const unresolved = [];
  for (const r of rows) {
    const [top, second] = r.ranked;
    const share = top ? top[1] / r.total : 0;
    const ok = top && top[1] >= o.minOverlapMs && share >= o.minShare && (!second || top[1] >= o.minMargin * second[1]);
    if (ok) picks.push({ speakerId: r.speakerId, key: top[0], ms: top[1], share, speechMs: r.speechMs });
    else unresolved.push({ speakerId: r.speakerId, best: top ? display.get(top[0]) : null, share, ms: top ? top[1] : 0 });
  }

  // ...and a name goes to one voice only: the one that was highlighted over it for longest
  picks.sort((a, b) => b.ms - a.ms);
  const taken = new Set();
  const named = [];
  for (const p of picks) {
    if (taken.has(p.key)) { unresolved.push({ speakerId: p.speakerId, best: display.get(p.key), share: p.share, ms: p.ms, duplicate: true }); continue; }
    taken.add(p.key);
    named.push({ speakerId: p.speakerId, name: display.get(p.key), ms: p.ms, share: p.share, via: 'vote' });
  }

  // a call with exactly one other person needs no vote: the only remote voice is theirs
  if (remotes) {
    const others = [...new Map(remotes.map((n) => [nameKey(n), n]).filter(([k]) => k && !self.has(k))).values()];
    const left = rows.filter((r) => !named.some((n) => n.speakerId === r.speakerId));
    if (others.length === 1 && !named.length && rows.length === 1 && left.length === 1 && left[0].speechMs >= o.soleMinMs) {
      named.push({ speakerId: left[0].speakerId, name: others[0], ms: left[0].speechMs, share: 1, via: 'sole' });
      const i = unresolved.findIndex((u) => u.speakerId === left[0].speakerId);
      if (i >= 0) unresolved.splice(i, 1);
    }
  }
  // who was highlighted over each voice, for the corrections (correct.js): speakerId -> Map(name key -> ms)
  const matrix = new Map(rows.map((r) => [r.speakerId, r.per]));
  return { named, unresolved, matrix, display };
}

// How many remote voices to expect: the people on the call other than the user, from the roster.
// -> a count of 1..max, or null when the roster says nothing useful (see hint.js for why large calls give none)
function remoteHeadCount(participants, { max = 6, selfKeys = [] } = {}) {
  if (!participants?.length) return null;
  const self = new Set(selfKeys);
  const seen = new Set();
  for (const p of participants) {
    const k = nameKey(p.name);
    if (p.self || (k && self.has(k))) continue;
    const key = p.id || k;
    if (key) seen.add(key);
  }
  return seen.size >= 1 && seen.size <= max ? seen.size : null;
}

module.exports = { nameSpeakers, activeIntervals, rawIntervals, speechOf, remoteHeadCount, DEFAULTS };
