#!/usr/bin/env node
'use strict';
// Turns a speaker test recording (Settings → Integrations → Discord → Start a speaker test; folders under
// <data>/speaker-tests, see src/recording/speaker-test.js) into an eval recording: the computer's mixed sound of the call
// becomes system.wav, and the reference words come from transcribing each person's own Discord stream, so every word
// already carries the right speaker. No hand labelling.
//
//   node eval/discord-test.js <folder> [--name discord-friday] [--threads 4] [--keep-self]
//   node eval/run.js --only <name> --configs online,owned            then, to tune: --same 0.45 / 0.5 / 0.55
//
// The bot receives each person a little earlier than the computer plays them (Discord's jitter buffer, the capture), so the
// two are aligned first: speech activity of all people together against the mixed sound's, best lag within ±3 s.
// Models come from $WB_MODELS_DIR or ./.models (the speech model and VAD).
const fs = require('node:fs');
const path = require('node:path');
const { pcm16ToWav } = require('../src/audio/pcm');

const ROOT = path.join(__dirname, '..');
const RATE = 16000;
const FRAME = 160;          // 10 ms
const MAX_LAG = 300;        // frames: ±3 s

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// log energy per 10 ms frame
function envelope(pcm) {
  const n = Math.floor(pcm.length / 2 / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) { const v = pcm.readInt16LE((f * FRAME + i) * 2) / 32768; e += v * v; }
    out[f] = Math.log10(e / FRAME + 1e-9);
  }
  return out;
}

// speech activity: frames clearly above the stream's own quiet floor
function activity(env) {
  const sorted = Float32Array.from(env).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? -9;
  return env.map((x) => (x > Math.max(floor + 1.5, -5) ? 1 : 0));
}

// Best lag (frames, >0 = the mixed sound is later) of `ref` against `sys`, by correlation of the centred activities.
// -> { lag, score, runnerUp }  score: correlation at the best lag; runnerUp: best score more than 0.5 s away
function align(sys, ref, maxLag = MAX_LAG) {
  const n = Math.min(sys.length, ref.length);
  const mean = (a) => { let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s / n; };
  const ms = mean(sys), mr = mean(ref);
  let ss = 0, rr = 0;
  for (let i = 0; i < n; i++) { ss += (sys[i] - ms) ** 2; rr += (ref[i] - mr) ** 2; }
  const norm = Math.sqrt(ss * rr) || 1;
  const scores = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = Math.max(0, -lag); i < n && i + lag < n; i++) c += (sys[i + lag] - ms) * (ref[i] - mr);
    scores.push({ lag, score: c / norm });
  }
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  const runnerUp = scores.filter((s) => Math.abs(s.lag - best.lag) > 50).reduce((a, b) => (b.score > a.score ? b : a), { score: -1 }).score;
  return { lag: best.lag, score: best.score, runnerUp };
}

// seconds where 2+ people talk at once, and each person's speaking time
function talkStats(acts) {
  const n = Math.max(0, ...acts.map((a) => a.length));
  let overlap = 0;
  for (let f = 0; f < n; f++) { let k = 0; for (const a of acts) k += a[f] || 0; if (k >= 2) overlap++; }
  return { overlapSec: overlap / 100, talkSec: acts.map((a) => a.reduce((s, x) => s + x, 0) / 100) };
}

async function transcribeAll(people, threads) {
  const { Models } = require('../src/asr/models');
  const { AsrEngine } = require('../src/asr/engine');
  const { transcribePcm } = require('../src/recording/import');
  const models = new Models(process.env.WB_MODELS_DIR || path.join(ROOT, '.models'));
  const model = models.resolve(opt('--asr', 'parakeet-tdt-0.6b-v3'));
  if (!model) throw new Error('no speech model: set WB_MODELS_DIR to a folder with parakeet-tdt-0.6b-v3 (the app keeps one under <data>/models)');
  const engine = new AsrEngine({ speakerModel: null });
  try {
    await engine.start(model, { role: 'batch', vadPath: models.vadPath(), threads, speakerModel: null });
    const out = [];
    for (const p of people) {
      process.stdout.write(`  transcribing ${p.label}… `);
      const segs = await transcribePcm(engine, p.pcm, { channel: `p${out.length}` });
      const words = [];
      for (const s of segs) {
        if (s.words?.length) for (const [w, a, b] of s.words) words.push({ speaker: p.label, start: (s.startMs + a) / 1000, end: (s.startMs + b) / 1000, word: w });
      }
      console.log(`${words.length} words`);
      out.push(words);
    }
    return out;
  } finally { engine.stop(); }
}

async function main() {
  const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!dir) throw new Error('usage: node eval/discord-test.js <speaker-test folder> [--name NAME]');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const system = fs.readFileSync(path.join(dir, meta.system.file));
  if (system.length < RATE * 2 * 30) throw new Error(`only ${(system.length / RATE / 2).toFixed(0)} s of mixed sound: record a few minutes`);
  let people = meta.people.map((p) => ({ ...p, pcm: fs.readFileSync(path.join(dir, p.file)) }));
  if (meta.selfUserId && !args.includes('--keep-self')) {
    const self = people.filter((p) => p.userId === String(meta.selfUserId));
    if (self.length) console.log(`leaving out ${self[0].name}: your own voice is not in the mixed sound (Discord does not play it back to you); --keep-self keeps it`);
    people = people.filter((p) => p.userId !== String(meta.selfUserId));
  }
  if (people.length < 2) throw new Error(`the bot heard ${people.length} other person(s): a speaker test needs 2 or more people besides you`);
  const names = new Map();
  for (const p of people) { const k = p.name; names.set(k, (names.get(k) || 0) + 1); }
  for (const p of people) p.label = names.get(p.name) > 1 ? `${p.name}#${p.userId.slice(-4)}` : p.name;

  // align the people's streams on the mixed sound
  const sysAct = activity(envelope(system));
  const acts = people.map((p) => activity(envelope(p.pcm)));
  const n = Math.max(sysAct.length, ...acts.map((a) => a.length));
  const sum = new Float32Array(n);
  for (const a of acts) for (let f = 0; f < a.length; f++) sum[f] = Math.max(sum[f], a[f]);
  const al = align(sysAct, sum);
  const lagSec = al.lag / 100;
  console.log(`alignment: the mixed sound is ${lagSec >= 0 ? 'later' : 'earlier'} by ${Math.abs(lagSec).toFixed(2)} s (correlation ${al.score.toFixed(2)}, next best ${al.runnerUp.toFixed(2)})`);
  if (al.score < 0.3 || al.score - al.runnerUp < 0.05) console.warn('WARNING: weak alignment. Was the mixed sound really the Discord call (Settings → Audio: system audio on, the right output)? Scores from this recording may be meaningless.');
  const stats = talkStats(acts);
  people.forEach((p, i) => console.log(`  ${p.label}: ${stats.talkSec[i].toFixed(0)} s of speech`));
  console.log(`  2+ people at once: ${stats.overlapSec.toFixed(0)} s`);

  const perPerson = await transcribeAll(people, Number(opt('--threads', 4)));
  const words = perPerson.flat().map((w) => ({ ...w, start: w.start + lagSec, end: w.end + lagSec })).filter((w) => w.end > 0).sort((a, b) => a.start - b.start);
  const name = opt('--name', `discord-${path.basename(path.resolve(dir)).slice(0, 19)}`);
  const out = path.join(ROOT, '.eval', 'data', name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'system.wav'), pcm16ToWav(system));
  fs.writeFileSync(path.join(out, 'ref.json'), JSON.stringify({ name, channels: { system: 'system.wav' }, words, source: { kind: 'discord-speaker-test', folder: path.resolve(dir), lagSec, alignment: al, people: people.map((p) => p.label) } }, null, 1));
  console.log(`${name}: ${(system.length / RATE / 2 / 60).toFixed(1)} min, ${words.length} words, ${people.length} people -> ${path.relative(ROOT, out)}`);
  console.log(`next: node eval/run.js --only ${name} --configs online,owned   (and --same 0.45 / 0.55 to tune the live labels)`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { envelope, activity, align, talkStats };
