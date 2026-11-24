#!/usr/bin/env node
'use strict';
// Naming accuracy (the 4.1 measurement of the roadmap): given who really spoke when, and a meeting window that shows it badly,
// how much of the speech ends up with the right person's name? No audio and no models: the "voices" are the reference's own
// speakers (perfect diarization), so what is measured is only the naming. The reference turns come from the recordings
// `node eval/prepare.js` builds (AMI, libri-call); the window's behaviour is simulated:
//
//   lagged      the highlight follows the speaker, late by the source's real delay (350 / 940 / 1630 ms, while 500 is assumed), every event
//               a little early or late (about +-150 ms), as a screen reader or a web page really is
//   noisy       one highlight in five names somebody else, and now and then somebody lights up with nobody speaking
//   dominant    only the loudest voice is ever shown: a short interjection (< 1.2 s) and the quieter side of an overlap never are
//   hard        all three together (late by 900 ms)
//
//   node eval/naming.js [--only ami-IS1009a] [--seeds 20] [--json]
const fs = require('node:fs');
const path = require('node:path');
const { nameFromEvents } = require('../src/meet/names');
const { namingAccuracy } = require('./metrics');

const DATA = path.join(__dirname, '..', '.eval', 'data');
const PRIOR_LAG = 500;

function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// words -> speaking turns [{ speaker, startMs, endMs }]: a speaker's words closer than 0.7 s are one turn
function turnsOf(words) {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const last = new Map(), out = [];
  for (const w of sorted) {
    const t = last.get(w.speaker);
    if (t && w.start * 1000 - t.endMs <= 700) t.endMs = Math.max(t.endMs, w.end * 1000);
    else { const n = { speaker: w.speaker, startMs: w.start * 1000, endMs: w.end * 1000 }; out.push(n); last.set(w.speaker, n); }
  }
  return out;
}

const speechOf = (turns) => { const m = new Map(); for (const t of turns) { if (!m.has(t.speaker)) m.set(t.speaker, []); m.get(t.speaker).push([t.startMs, t.endMs]); } return m; };

// What the window shows: events [{ t, name }] (name null = nobody). `show(turn)` decides what is shown for a turn.
function simulate(turns, { lagMs = PRIOR_LAG, jitterMs = 150, wrongRate = 0, ghostRate = 0, dominantOnly = false, rand, names }) {
  const jit = () => (rand() * 2 - 1) * jitterMs;
  const people = [...new Set(turns.map((t) => t.speaker))];
  let shown = turns.map((t) => ({ ...t }));
  if (dominantOnly) {
    shown = shown.filter((t) => t.endMs - t.startMs >= 1200);                 // an interjection never lights up
    // the quieter side of an overlap: of two overlapping turns only the one that started first (the holder of the floor) is shown
    shown = shown.filter((t, i) => !shown.some((o, j) => j !== i && o.startMs < t.startMs && o.endMs > t.startMs + 500));
  }
  const events = [];
  for (const t of shown) {
    const name = rand() < wrongRate ? names[people[Math.floor(rand() * people.length)]] : names[t.speaker];
    events.push({ t: t.startMs + lagMs + jit(), name }, { t: t.endMs + lagMs + jit(), name: null });
  }
  if (ghostRate) {
    const end = Math.max(...turns.map((t) => t.endMs));
    for (let at = 5000; at < end; at += 5000) if (rand() < ghostRate) { const g = names[people[Math.floor(rand() * people.length)]]; events.push({ t: at, name: g }, { t: at + 300 + rand() * 1200, name: null }); }
  }
  return events.sort((a, b) => a.t - b.t);
}

const SCENARIOS = {
  lagged350: (r, n) => ({ lagMs: 350, rand: r, names: n }),
  lagged940: (r, n) => ({ lagMs: 940, rand: r, names: n }),
  lagged1630: (r, n) => ({ lagMs: 1630, rand: r, names: n }),
  noisy: (r, n) => ({ lagMs: 500, wrongRate: 0.2, ghostRate: 0.25, rand: r, names: n }),
  dominant: (r, n) => ({ lagMs: 500, dominantOnly: true, rand: r, names: n }),
  hard: (r, n) => ({ lagMs: 900, wrongRate: 0.15, ghostRate: 0.2, dominantOnly: true, rand: r, names: n }),
};

function run({ only = [], seeds = 20 } = {}) {
  const out = [];
  for (const rec of fs.readdirSync(DATA).filter((n) => !only.length || only.includes(n)).sort()) {
    const file = path.join(DATA, rec, 'ref.json');
    if (!fs.existsSync(file)) continue;
    const turns = turnsOf(JSON.parse(fs.readFileSync(file, 'utf8')).words);
    const people = [...new Set(turns.map((t) => t.speaker))];
    const names = Object.fromEntries(people.map((p, i) => [p, `Person ${String.fromCharCode(65 + i)} ${p.split(/[.-]/).pop()}`]));
    const speech = speechOf(turns);
    for (const [scenario, make] of Object.entries(SCENARIOS)) {
      let acc = 0, prec = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const events = simulate(turns, make(rng(seed * 7919), names));
        const res = nameFromEvents({ events, speech, priorLagMs: PRIOR_LAG });
        const assigned = new Map(res.named.map((n) => [n.speakerId, n.name]));
        const m = namingAccuracy({ speech, truth: names, assigned });
        acc += m.accuracy; prec += m.precision;
      }
      out.push({ recording: rec, scenario, speakers: people.length, accuracy: acc / seeds, precision: prec / seeds });
    }
  }
  return out;
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const rows = run({ only: arg('only', '') ? arg('only').split(',') : [], seeds: Number(arg('seeds', 20)) });
  if (!rows.length) { console.error('no recordings: run `node eval/prepare.js` first'); process.exit(1); }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else {
    console.log('recording'.padEnd(14), 'scenario'.padEnd(11), 'people', 'accuracy', 'precision');
    for (const r of rows) console.log(r.recording.padEnd(14), r.scenario.padEnd(11), String(r.speakers).padStart(6), (r.accuracy * 100).toFixed(1).padStart(8), (r.precision * 100).toFixed(1).padStart(9));
    const mean = (k) => rows.reduce((n, r) => n + r[k], 0) / rows.length;
    console.log('mean'.padEnd(14), ''.padEnd(11), ''.padStart(6), (mean('accuracy') * 100).toFixed(1).padStart(8), (mean('precision') * 100).toFixed(1).padStart(9));
  }
}

module.exports = { turnsOf, simulate, run };
