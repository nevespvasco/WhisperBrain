'use strict';
// Names for the voices of a call, from what the meeting window said while each voice was speaking (pure maths, no I/O).
//
// The meeting UI highlights one active speaker at a time, with a small delay; the diarization says which voice spoke
// when. A voice takes the name that was highlighted for most of its speech. Two voices never get one name, a voice with
// no clear winner stays unnamed (the app then keeps "Speaker 2"), and overlapped or noisy highlights are outvoted.
const { nameKey } = require('./protocol');
const { hungarian } = require('../speakers/hungarian');

const DEFAULTS = {
  lagMs: 500,        // the highlight appears this long after the voice starts (UI latency): events are moved back by it
  minMs: 200,        // a highlight shorter than this is a flicker
  maxMs: 5 * 60000,  // a highlight is never believed for longer than this without a new event
  minOverlapMs: 1500, // the winning name must have been highlighted at least this long over the voice's speech
  minMargin: 1.5,    // ...and beat the runner-up by this factor
  floorShare: 0.4,   // a voice only considers a name that was highlighted over at least this share of its highlighted time
  minScore: 0.45,    // sqrt(precision x recall) a name needs to be given at all: below it the voice stays "unknown"
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

// How late this source shows a voice: the shift of its highlights that makes them fall over the speech best. Only the timing is
// asked (any name over any voice), so who is named, right or wrong, does not matter. Searched around the usual delay (`prior`);
// when several shifts are about equally good (one name lit for the whole call, no speech to compare with) the usual one is kept.
// raw: rawIntervals(...); speech: Map(voice -> [[startMs, endMs]]). -> ms
function estimateLag({ raw, speech, prior = DEFAULTS.lagMs, range = 1500, step = 100 }) {
  const spans = [...speech.values()].flat().sort((a, b) => a[0] - b[0]);
  const union = [];
  for (const [a, b] of spans) { const last = union[union.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else union.push([a, b]); }
  if (!raw.length || !union.length) return prior;
  const sorted = [...raw].sort((a, b) => a.startMs - b.startMs);
  const covered = (lag) => {
    let total = 0, j = 0;
    for (const r of sorted) {
      const a = r.startMs - lag, b = r.endMs - lag;
      while (j < union.length && union[j][1] <= a) j++;
      for (let k = j; k < union.length && union[k][0] < b; k++) total += Math.max(0, Math.min(b, union[k][1]) - Math.max(a, union[k][0]));
    }
    return total;
  };
  const scored = [];
  for (let lag = Math.max(0, prior - range); lag <= prior + range; lag += step) scored.push([lag, covered(lag)]);
  const best = Math.max(...scored.map((x) => x[1]));
  if (best <= 0) return prior;
  return scored.filter((x) => x[1] >= best * 0.99).sort((x, y) => Math.abs(x[0] - prior) - Math.abs(y[0] - prior))[0][0];
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

// The people invited (the calendar's attendees) as a prior for what the window shows: a name that is a short form of exactly one
// invited person ("Ana", "Ana S.") is that person, so "Ana" and "Ana Silva" are one name and the full one is what is kept. Never
// forced: a name that fits nobody, or several invited people ("Bruno" with two Brunos), stays exactly as shown, and an invitation
// does not name any voice by itself. -> (name) => { key, name } | null
function canonicalizer(candidates) {
  const list = (candidates || []).map((n) => ({ name: n, key: nameKey(n) })).filter((c) => c.key).map((c) => ({ ...c, tok: c.key.split(' ') }));
  return (shown) => {
    const key = nameKey(shown);
    if (!key || !list.length) return null;
    const exact = list.find((c) => c.key === key);
    if (exact) return exact;
    const tok = key.split(' ');
    // the first name must be the same ('Jo' is not 'John'); later words may be initials or short forms ('Ana S.' for 'Ana Silva')
    const fits = list.filter((c) => tok.length <= c.tok.length && tok[0] === c.tok[0] && tok.every((w, i) => c.tok[i].startsWith(w)));
    return fits.length === 1 ? fits[0] : null;
  };
}

// The invited people's names: the calendar's name where it has one, else a careful guess from "first.last@..." (a prior only, see
// canonicalizer: it never names a voice by itself). Generic mailboxes and single-word addresses give nothing.
const GENERIC = new Set(['info', 'team', 'admin', 'support', 'hello', 'sales', 'contact', 'office', 'noreply', 'reply', 'mail', 'meeting', 'calendar', 'events']);
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split('+')[0];
  const words = local.split(/[._-]+/).filter((w) => /^\p{L}{2,}$/u.test(w) && !GENERIC.has(w.toLowerCase()));
  return words.length >= 2 ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : '';
}
const invitedNames = (attendees) => (attendees || []).map((p) => (p?.name ? p.name : nameFromEmail(p?.email))).filter(Boolean);

// speech: Map(speakerId -> [[startMs, endMs]]); active: from activeIntervals; remotes: names of the other people on the
// call from the roster (null when no roster); selfKeys: name keys that are the user.
// -> { named: [{ speakerId, name, ms, share, via }], unresolved: [{ speakerId, best, share }] }
function nameSpeakers({ speech, active, remotes = null, selfKeys = [], candidates = null, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const self = new Set(selfKeys);
  const display = new Map(); // key -> the name as first seen
  const canon = canonicalizer((candidates || []).filter((c) => !self.has(nameKey(c))));   // the user is never somebody else's name
  const isSelf = canonicalizer([...self]);                                                  // ...and a short form of the user's name is the user
  const keyOf = (name) => {
    const c = canon(name);
    if (c) { display.set(c.key, c.name); return c.key; }
    const k = nameKey(name);
    if (k && !display.has(k)) display.set(k, name);
    return k;
  };
  const iv = active.map((a) => ({ ...a, key: keyOf(a.name) })).filter((a) => a.key && !self.has(a.key) && !self.has(nameKey(a.name)) && !isSelf(a.name));

  // overlap of each voice's speech with each highlighted name
  const rows = [];
  for (const [speakerId, spans] of speech) {
    const per = new Map(), perFrom = new Map();   // name key -> ms; name key -> Map(kind of evidence -> ms)
    let total = 0;
    for (const [s, e] of spans) {
      for (const a of iv) {
        const ms = overlap(s, e, a.startMs, a.endMs);
        if (ms > 0) {
          per.set(a.key, (per.get(a.key) || 0) + ms); total += ms;
          const f = perFrom.get(a.key) || new Map(); f.set(a.from || 'highlight', (f.get(a.from || 'highlight') || 0) + ms); perFrom.set(a.key, f);
        }
      }
    }
    const ranked = [...per].sort((x, y) => y[1] - x[1]);
    rows.push({ speakerId, speechMs: spans.reduce((n, [s, e]) => n + e - s, 0), ranked, total, per, perFrom });
  }

  // How well each name fits each voice, from both sides: precision = of the time a name was lit over this voice's speech and
  // anybody's, how much was over this voice; recall = of everything lit for the name while anybody spoke, how much was over this
  // voice. Light in silence counts for nobody. score = sqrt(precision x recall): high only when the voice and the name are
  // mostly each other (a person split into two voices gives the name to the bigger part).
  const nameTotal = new Map();
  for (const r of rows) for (const [k, ms] of r.per) nameTotal.set(k, (nameTotal.get(k) || 0) + ms);
  const fits = rows.map((r) => {
    const cands = [...r.per].map(([key, ms]) => ({ key, ms, share: ms / r.total, score: Math.sqrt((ms / r.total) * (ms / nameTotal.get(key))) }))
      .filter((c) => c.ms >= o.minOverlapMs && c.share >= o.floorShare).sort((x, y) => y.score - x.score);
    return { r, cands };
  });

  // A voice whose best name does not clearly beat the next one is not guessed (a person lit as two names about equally).
  const unresolved = [];
  const eligible = fits.map(({ r, cands }) => {
    const [top, second] = cands;
    return top && top.score >= o.minScore && (!second || top.score >= o.minMargin * second.score) ? { r, cands: [top] } : { r, cands: [] };
  });

  // One name to one voice, the best total: Hungarian over the voices and names, each voice with a column of its own for "unknown".
  const keys = [...new Set(eligible.flatMap((e) => e.cands.map((c) => c.key)))];
  const BIG = 1e6;
  const n = eligible.length;
  const cost = eligible.map((e, i) => [
    ...keys.map((k) => { const c = e.cands.find((x) => x.key === k); return c ? -c.score : BIG; }),
    ...eligible.map((_, j) => (j === i ? -o.minScore : BIG)),
  ]);
  const pick = n && keys.length ? hungarian(cost) : new Int32Array(n).fill(-1);
  const named = [];
  const takenBy = new Map();
  eligible.forEach((e, i) => {
    const col = pick[i];
    if (col >= 0 && col < keys.length) {
      const c = e.cands.find((x) => x.key === keys[col]);
      takenBy.set(c.key, e.r.speakerId);
      const from = [...e.r.perFrom.get(c.key)].sort((x, y) => y[1] - x[1])[0][0];   // the kind of evidence that carried most of it
      named.push({ speakerId: e.r.speakerId, name: display.get(c.key), ms: c.ms, share: c.share, score: c.score, from, via: 'vote' });
    }
  });
  for (const e of eligible) {
    if (named.some((x) => x.speakerId === e.r.speakerId)) continue;
    const top = e.r.ranked[0];
    const best = e.cands[0];
    const duplicate = !!best && takenBy.has(best.key) && takenBy.get(best.key) !== e.r.speakerId;
    unresolved.push({ speakerId: e.r.speakerId, best: top ? display.get(top[0]) : null, share: top ? top[1] / e.r.total : 0, ms: top ? top[1] : 0, ...(duplicate ? { duplicate: true } : {}) });
  }
  named.sort((x, y) => y.ms - x.ms);

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

// Names for the voices from one source's raw events and the voices' speech. This is the whole of what a recording does at Stop
// for the highlights: the lag taken off (priorLagMs, the source's usual delay), then the vote. -> nameSpeakers' result + active
function nameFromEvents({ events, speech, priorLagMs = DEFAULTS.lagMs, endMs = Infinity, remotes = null, selfKeys = [], options = {} }) {
  const lagMs = estimateLag({ raw: rawIntervals(events, { endMs }), speech, prior: priorLagMs });
  const active = activeIntervals(events, { lagMs, endMs });
  return { ...nameSpeakers({ speech, active, remotes, selfKeys, options }), active, lagMs };
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

module.exports = { nameSpeakers, nameFromEvents, invitedNames, estimateLag, activeIntervals, rawIntervals, speechOf, remoteHeadCount, DEFAULTS };
