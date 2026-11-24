#!/usr/bin/env node
'use strict';
// Saved-voice recognition evaluation: how well does Speakers.autoMatch link a meeting's unnamed speakers to saved
// voice profiles ("Ana", "Bruno"), and refuse to link people it has never been told about?
//
//   node eval/voices.js extract          # once: voice prints of real speakers, cached in .eval/voices (a few minutes)
//   node eval/voices.js [run] [--trials 300] [--seed 7] [--json]
//   node eval/voices.js calibrate         # threshold and margin picked on one half of the people, scored on the other
//   node eval/voices.js mean              # prints VOICE_MEAN (base64) of src/speakers/cluster.js
//
// Data: LibriSpeech dev-clean (CC BY 4.0, openslr.org/12), already fetched by `node eval/prepare.js`: 40 readers, 31 of
// them with 2-4 recordings sessions (chapters of different books, recorded on different days). A chapter plays the role of a
// "meeting": enrol people from one chapter, recognise them in another one. The 9 readers with a single chapter, and the
// readers left out of the roster, are the unknown people who must NOT be linked (open set).
// Voice model: WeSpeaker ResNet34-LM through sherpa-onnx, as in the app. See "Saved voices" in eval/README.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIBRI = path.join(ROOT, '.eval', 'dl', 'LibriSpeech');
const CACHE = path.join(ROOT, '.eval', 'voices');
const MODEL = path.join(process.env.WB_MODELS_DIR || path.join(ROOT, '.models'), 'speaker', 'wespeaker_en_voxceleb_resnet34_LM.onnx');
const RATE = 16000;
const UTTS = 16;          // utterances kept per speaker and chapter
const UTT_MAX_S = 10;     // a live utterance is a VAD segment: cut the long reading passages
const POOLS = 3;          // pooled "after-recording" voice prints per speaker and chapter
const POOL_S = 30;        // diarization pools up to 30 s of solo speech per speaker (src/speakers/final.js)
// mic = the recording as it is. call = a video call (wide band Opus 24 kbit/s, a little hiss and room echo) and phone = a poor
// line (narrow band, hiss, echo, Opus 12 kbit/s): both are SIMULATED from the mic recordings with ffmpeg, not real call audio.
const DEGRADE = {
  call: { snr: 30, filter: 'highpass=f=100,lowpass=f=7000,aecho=0.8:0.8:30|55:0.2|0.1', bitrate: '24k' },
  phone: { snr: 22, filter: 'highpass=f=250,lowpass=f=3600,aecho=0.8:0.8:30|55:0.3|0.15', bitrate: '12k' },
};
const CHANNELS = ['mic', ...Object.keys(DEGRADE)];

function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(a, rand) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------------------------------------------------------------- extraction (needs ffmpeg + the voice model)
function ff(args, input) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr).slice(0, 300)}`);
  return r.stdout;
}
const toF32 = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const decode = (file) => toF32(ff(['-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1']));

// What a far-end voice goes through: hiss, band limiting, a little echo, then a low-bitrate voice codec.
function degrade(x, seed, kind) {
  const d = DEGRADE[kind];
  const rand = rng(seed);
  let p = 0;
  for (let i = 0; i < x.length; i++) p += x[i] * x[i];
  const sigma = Math.sqrt(p / x.length) * 10 ** (-d.snr / 20) / 0.58; // uniform noise of amplitude a has sd 0.58 a
  const noisy = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) noisy[i] = x[i] + (rand() * 2 - 1) * sigma;
  const ogg = ff(['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-af', d.filter,
    '-c:a', 'libopus', '-b:a', d.bitrate, '-application', 'voip', '-f', 'ogg', 'pipe:1'], Buffer.from(noisy.buffer));
  return toF32(ff(['-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], ogg));
}

function listLibri() {
  const dir = path.join(LIBRI, 'dev-clean');
  if (!fs.existsSync(dir)) throw new Error(`${dir} is missing: run node eval/prepare.js first`);
  const sex = new Map();
  for (const l of fs.readFileSync(path.join(LIBRI, 'SPEAKERS.TXT'), 'utf8').split('\n')) { const m = /^(\d+)\s*\|\s*([FM])\s*\|\s*dev-clean/.exec(l); if (m) sex.set(m[1], m[2]); }
  const people = [];
  for (const spk of fs.readdirSync(dir).sort((a, b) => Number(a) - Number(b))) {
    const chapters = fs.readdirSync(path.join(dir, spk)).sort().map((ch) => ({ id: ch, files: fs.readdirSync(path.join(dir, spk, ch)).filter((f) => f.endsWith('.flac')).sort().map((f) => path.join(dir, spk, ch, f)) }));
    people.push({ id: spk, sex: sex.get(spk) || '?', chapters });
  }
  return people;
}

function extract(dest = CACHE) {
  const sherpa = require('sherpa-onnx-node');
  const { voiceFeatures } = require('../src/audio/features');
  if (!fs.existsSync(MODEL)) throw new Error(`voice model missing: ${MODEL}`);
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: Math.min(8, os.cpus().length), provider: 'cpu', debug: 0 });
  const embed = (x) => { const st = ex.createStream(); st.acceptWaveform({ samples: x, sampleRate: RATE }); st.inputFinished(); return Float32Array.from(ex.compute(st, false)); };
  const people = listLibri();
  const out = [];
  const t0 = Date.now();
  for (const p of people) {
    const entry = { id: p.id, sex: p.sex, chapters: [] };
    for (const ch of p.chapters) {
      const rand = rng(Number(p.id) * 1009 + Number(ch.id));
      const files = shuffle(ch.files, rand).slice(0, UTTS);
      const clean = files.map((f) => decode(f).subarray(0, UTT_MAX_S * RATE));
      const audio = { mic: clean, ...Object.fromEntries(Object.keys(DEGRADE).map((k) => [k, clean.map((x, i) => degrade(x, Number(ch.id) * 131 + i, k))])) };
      const rec = { id: ch.id, utts: files.length, seconds: clean.map((x) => x.length / RATE), emb: {}, pools: [] };
      for (const c of CHANNELS) rec.emb[c] = audio[c].map(embed);
      for (let k = 0; k < POOLS; k++) {
        const order = shuffle(clean.map((_, i) => i), rand);
        const pool = { members: [], emb: {}, pitch: {}, seconds: 0 };
        for (const i of order) { if (pool.seconds >= POOL_S) break; pool.members.push(i); pool.seconds += clean[i].length / RATE; }
        pool.seconds = Math.min(POOL_S, pool.seconds);
        for (const c of CHANNELS) {
          const parts = pool.members.map((i) => audio[c][i]);
          const all = new Float32Array(parts.reduce((a, q) => a + q.length, 0));
          let at = 0;
          for (const q of parts) { all.set(q, at); at += q.length; }
          const x = all.subarray(0, POOL_S * RATE);
          pool.emb[c] = embed(x);
          const f0 = parts.slice(0, 8).map((q) => voiceFeatures(q.subarray(0, 8 * RATE))?.f0).filter(Boolean).sort((a, b) => a - b); // as diarize-worker.js
          pool.pitch[c] = f0.length ? f0[(f0.length - 1) >> 1] : null;
        }
        rec.pools.push(pool);
      }
      entry.chapters.push(rec);
    }
    out.push(entry);
    console.log(`${p.id} (${p.sex}): ${entry.chapters.length} chapters  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
  }
  fs.mkdirSync(dest, { recursive: true });
  // embeddings go to one binary file, everything else to JSON
  const flat = [];
  const put = (v) => { flat.push(Array.from(v)); return flat.length - 1; };
  const index = out.map((p) => ({ ...p, chapters: p.chapters.map((c) => ({ ...c, emb: Object.fromEntries(CHANNELS.map((k) => [k, c.emb[k].map(put)])),
    pools: c.pools.map((q) => ({ ...q, emb: Object.fromEntries(CHANNELS.map((k) => [k, put(q.emb[k])])) })) })) }));
  const dim = flat[0].length;
  const bin = new Float32Array(flat.length * dim);
  flat.forEach((v, i) => bin.set(v, i * dim));
  fs.writeFileSync(path.join(dest, 'emb.bin'), Buffer.from(bin.buffer));
  fs.writeFileSync(path.join(dest, 'index.json'), JSON.stringify({ model: path.basename(MODEL), dim, channels: CHANNELS, people: index }));
  console.log(`wrote ${flat.length} voice prints (${dim} dims) to ${path.relative(ROOT, dest)}`);
}

function loadCache() {
  const idx = JSON.parse(fs.readFileSync(path.join(CACHE, 'index.json'), 'utf8'));
  const b = fs.readFileSync(path.join(CACHE, 'emb.bin'));
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const get = (i) => all.slice(i * idx.dim, (i + 1) * idx.dim);
  for (const p of idx.people) for (const c of p.chapters) {
    for (const k of idx.channels) c.emb[k] = c.emb[k].map(get);
    for (const q of c.pools) for (const k of idx.channels) q.emb[k] = get(q.emb[k]);
  }
  return idx;
}

// ---------------------------------------------------------------- the experiment
// A trial is one user's history: a roster of saved voices, each enrolled from its owner's voice print(s) in earlier
// "meetings" (chapters), and then a new meeting whose speakers (some on the roster, some strangers) must be linked.
const semitonesOf = (a, b) => 12 * Math.abs(Math.log2(a / b));
const PITCH_VETO = 4;
const sideOf = (chan) => (chan === 'mic' ? 'mic' : 'system');     // the app knows mic and system, not which codec

// 2 folds of people, stratified by sex and by whether they have several chapters: calibrate on one, report on the other.
function makeFolds(people, seed) {
  const rand = rng(seed);
  const folds = [[], []];
  for (const g of [people.filter((p) => p.sex === 'F' && p.chapters.length >= 2), people.filter((p) => p.sex !== 'F' && p.chapters.length >= 2), people.filter((p) => p.chapters.length < 2)]) {
    shuffle(g, rand).forEach((p, i) => folds[i % 2].push(p));
  }
  return folds;
}

// The mean unit-length mic voice print of some people (what cluster.js ships as VOICE_MEAN).
function meanPrint(people) {
  const { norm } = require('../src/speakers/cluster');
  let mu = null, n = 0;
  for (const p of people) for (const c of p.chapters) for (const q of c.pools) {
    const v = norm(q.emb.mic);
    if (!mu) mu = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) mu[i] += v[i];
    n++;
  }
  for (let i = 0; i < mu.length; i++) mu[i] /= n;
  return mu;
}

// How a meeting speaker's voice print is made. final = the after-recording print pooled over up to 30 s of solo speech
// (src/speakers/final.js); live3 = the running mean of the first three utterances (what the live autoMatch sees); utt1 = one.
function printOf(chapter, chan, kind, rand) {
  if (kind === 'final') { const q = chapter.pools[Math.floor(rand() * chapter.pools.length)]; return { c: q.emb[chan], pitch: q.pitch[chan], secs: q.seconds, count: q.members.length, chan }; }
  const { norm, blend } = require('../src/speakers/cluster');
  const n = kind === 'utt1' ? 1 : 3;
  const ids = shuffle(chapter.emb[chan].map((_, i) => i), rand).slice(0, n);
  let c = null, k = 0;
  for (const i of ids) { const e = norm(chapter.emb[chan][i]); c = c ? blend(c, k, e, 1) : e; k++; }
  return { c, pitch: null, secs: ids.reduce((a, i) => a + chapter.seconds[i], 0), count: ids.length, chan };
}

// scn: { enrol: [{ chan }] (one entry per meeting the voice was saved from), test: { chan, kind }, roster, known, unknown }
function makeTrial(pool, scn, rand) {
  const eligible = pool.filter((p) => p.chapters.length > scn.enrol.length);
  if (eligible.length < scn.roster) throw new Error(`only ${eligible.length} people with ${scn.enrol.length + 1}+ chapters in this fold, need ${scn.roster}`);
  const roster = shuffle(eligible, rand).slice(0, scn.roster).map((p) => {
    const order = shuffle(p.chapters.map((_, i) => i), rand);
    return { id: p.id, person: p, prints: scn.enrol.map((e, k) => printOf(p.chapters[order[k]], e.chan, 'final', rand)), testChapter: order[scn.enrol.length] };
  });
  const speakers = shuffle(roster, rand).slice(0, scn.known).map((r) => ({ truth: r.id, ...printOf(r.person.chapters[r.testChapter], scn.test.chan, scn.test.kind, rand) }));
  const names = new Set(roster.map((r) => r.id));
  for (const p of shuffle(pool.filter((q) => !names.has(q.id)), rand).slice(0, scn.unknown)) speakers.push({ truth: null, ...printOf(p.chapters[Math.floor(rand() * p.chapters.length)], scn.test.chan, scn.test.kind, rand) });
  // what the app has heard before on each channel (every meeting leaves its speakers behind): strangers, from any chapter
  const hist = [];
  const chans = new Map([...scn.enrol.map((e) => e.chan), scn.test.chan].map((c) => [sideOf(c), c]));
  for (const [side, chan] of chans) for (let k = 0; k < (scn.hist ?? 8); k++) { const p = pool[Math.floor(rand() * pool.length)]; hist.push({ side, c: printOf(p.chapters[Math.floor(rand() * p.chapters.length)], chan, 'final', rand).c }); }
  return { roster, speakers, hist };
}

// What the app did before: one running mean per voice (weighted by utterance count), raw cosine >= 0.65, a 4-semitone
// pitch veto, one voice per speaker and one speaker per voice, best pair first (Speakers.rename / cluster.matchVoices at
// the commit before the multi-print change).
function decideOld(trial, { threshold = 0.65 } = {}) {
  const { cosine, norm, blend } = require('../src/speakers/cluster');
  const voices = trial.roster.map((r) => {
    let emb = null, n = 0, pitch = null;
    for (const p of r.prints) {
      const w = Math.max(1, p.count);
      pitch = pitch && p.pitch ? (pitch * n + p.pitch * w) / (n + w) : (p.pitch || pitch);
      emb = emb ? blend(emb, n, p.c, w) : norm(p.c);
      n += w;
    }
    return { id: r.id, emb, pitch };
  });
  const pairs = [];
  trial.speakers.forEach((s, si) => {
    for (const v of voices) {
      if (s.pitch && v.pitch && semitonesOf(s.pitch, v.pitch) > PITCH_VETO) continue;
      const c = cosine(s.c, v.emb);
      if (c >= threshold) pairs.push({ si, v: v.id, c });
    }
  });
  pairs.sort((a, b) => b.c - a.c);
  const out = new Map(), usedV = new Set();
  for (const p of pairs) { if (out.has(p.si) || usedV.has(p.v)) continue; out.set(p.si, p.v); usedV.add(p.v); }
  return out;
}

// The new matching on voices built the way Speakers.rename builds them, without the database (for sweeping settings).
function decideNew(trial, opts = {}) {
  const { matchVoices, addPrint, populationMean, MATCH } = require('../src/speakers/cluster');
  const heard = (side) => [...trial.roster.flatMap((r) => r.prints.filter((p) => sideOf(p.chan) === side).map((p) => p.c)), ...trial.speakers.filter((x) => sideOf(x.chan) === side).map((x) => x.c), ...(trial.hist || []).filter((h) => h.side === side).map((h) => h.c)];
  const means = { mic: populationMean(heard('mic'), opts.mu, MATCH.prior.mic), system: populationMean(heard('system'), opts.mu, MATCH.prior.system) };
  const mu = opts.adapt === false ? opts.mu : (side) => means[side] || opts.mu;
  const voices = trial.roster.map((r) => {
    let prints = [];
    r.prints.forEach((p, k) => { prints = addPrint(prints, { embedding: p.c, weight: Math.min(30, p.secs), channel: sideOf(p.chan), pitch: p.pitch, source: `n${k}` }); });
    const pw = prints.filter((x) => x.pitch);
    return { id: r.id, embedding: prints[0].embedding, samples: 1, exemplars: prints, pitch: pw.length ? pw.reduce((a, x) => a + x.pitch * x.weight, 0) / pw.reduce((a, x) => a + x.weight, 0) : null };
  });
  const cands = trial.speakers.map((s, i) => ({ id: i, centroid: s.c, channel: sideOf(s.chan), pitch: s.pitch }));
  const m = matchVoices(cands, voices, opts.threshold ?? MATCH.threshold, (s, v) => !(s.pitch && v.pitch && semitonesOf(s.pitch, v.pitch) > PITCH_VETO), { mu, margin: opts.margin ?? MATCH.margin, cross: opts.cross ?? MATCH.cross });
  return new Map([...m].map(([i, x]) => [i, x.voiceId]));
}

// The real thing: Speakers on an in-memory database, voices saved with rename(remember), then autoMatch on the new meeting.
function decideStore(trial, { mu } = {}) {
  const { open } = require('../src/core/db');
  const { Notes } = require('../src/core/notes');
  const { Speakers } = require('../src/speakers/store');
  const db = open(':memory:');
  const notes = new Notes(db, null);
  const speakers = new Speakers(db, null);
  if (mu !== undefined) speakers.mean = mu;
  const seg = (note, spk, secs) => notes.addSegments(note, [{ speaker: 'them', speakerId: spk, startMs: 0, endMs: Math.round(secs * 1000), text: 'x' }]);
  for (const r of trial.roster) {
    for (const p of r.prints) {
      const n = notes.create({});
      speakers.save(n.id, { speakerId: 's1', channel: sideOf(p.chan), centroid: p.c, count: p.count, pitch: p.pitch });
      seg(n.id, 's1', p.secs);
      speakers.rename(n.id, 's1', `p${r.id}`, { remember: true });
    }
  }
  for (const h of trial.hist || []) { const hn = notes.create({}); speakers.save(hn.id, { speakerId: 's1', channel: h.side, centroid: h.c, count: 5 }); }
  const n = notes.create({});
  trial.speakers.forEach((s, i) => { speakers.save(n.id, { speakerId: `s${i + 1}`, channel: sideOf(s.chan), centroid: s.c, count: s.count, pitch: s.pitch }); seg(n.id, `s${i + 1}`, s.secs); });
  speakers.autoMatch(n.id);
  const out = new Map();
  for (const s of speakers.forNote(n.id)) if (s.voiceName) out.set(Number(s.speakerId.slice(1)) - 1, s.voiceName.slice(1));
  db.close();
  return out;
}

function tally(trials, decide) {
  const t = { known: 0, correct: 0, missed: 0, wrong: 0, strangers: 0, falseAccept: 0 };
  for (const trial of trials) {
    const m = decide(trial);
    trial.speakers.forEach((s, i) => {
      const got = m.get(i) ?? null;
      if (s.truth) { t.known++; if (got === s.truth) t.correct++; else if (got) t.wrong++; else t.missed++; } else { t.strangers++; if (got) t.falseAccept++; }
    });
  }
  return t;
}
const merge = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));
const pct = (x, n) => (n ? `${((100 * x) / n).toFixed(1)}`.padStart(5) : '    -');
const row = (label, t) => `${label.padEnd(34)} correct ${pct(t.correct, t.known)}  missed ${pct(t.missed, t.known)}  wrong-person ${pct(t.wrong, t.known)}  false-accept ${pct(t.falseAccept, t.strangers)}   (${t.known} known, ${t.strangers} strangers)`;

const ENROL = { mic: [{ chan: 'mic' }], call: [{ chan: 'call' }], phone: [{ chan: 'phone' }] };
const BASE = { roster: 6, known: 3, unknown: 3 };
const SCENARIOS = [
  { name: 'same mic, 1 meeting saved', enrol: ENROL.mic, test: { chan: 'mic', kind: 'final' } },
  { name: 'same mic, 2 meetings saved', enrol: [...ENROL.mic, ...ENROL.mic], test: { chan: 'mic', kind: 'final' } },
  { name: 'live (3 utterances), mic', enrol: ENROL.mic, test: { chan: 'mic', kind: 'live3' } },
  { name: 'live (1 utterance), mic', enrol: ENROL.mic, test: { chan: 'mic', kind: 'utt1' } },
  { name: 'video call -> video call', enrol: ENROL.call, test: { chan: 'call', kind: 'final' } },
  { name: 'poor phone line -> phone line', enrol: ENROL.phone, test: { chan: 'phone', kind: 'final' } },
  { name: 'saved on mic, heard on call', enrol: ENROL.mic, test: { chan: 'call', kind: 'final' } },
  { name: 'saved on call, heard on mic', enrol: ENROL.call, test: { chan: 'mic', kind: 'final' } },
  { name: 'saved on mic+call, heard on call', enrol: [{ chan: 'mic' }, { chan: 'call' }], test: { chan: 'call', kind: 'final' } },
  { name: 'saved on mic+call, heard on mic', enrol: [{ chan: 'mic' }, { chan: 'call' }], test: { chan: 'mic', kind: 'final' } },
  { name: 'many saved voices (12), same mic', enrol: ENROL.mic, test: { chan: 'mic', kind: 'final' }, roster: 12 },
  { name: 'first days: 2 voices, no history, mic', enrol: ENROL.mic, test: { chan: 'mic', kind: 'final' }, roster: 2, known: 2, unknown: 1, hist: 0 },
  { name: 'first days: 2 voices, no history, call', enrol: ENROL.call, test: { chan: 'call', kind: 'final' }, roster: 2, known: 2, unknown: 1, hist: 0 },
].map((s) => ({ ...BASE, ...s }));

function run(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const N = Number(opt('--trials', 300)), seed = Number(opt('--seed', 7));
  const only = opt('--only', null);
  const idx = loadCache();
  const folds = makeFolds(idx.people, 5);
  const { MATCH } = require('../src/speakers/cluster');
  console.log(`${idx.people.length} readers (${idx.people.filter((p) => p.chapters.length > 1).length} with 2+ chapters), voice model ${idx.model}; 2 folds of ${folds.map((f) => f.length).join(' + ')} people; ${N} random histories per fold and scenario, seed ${seed}`);
  console.log(`new settings: centred similarity >= ${MATCH.threshold}, margin ${MATCH.margin}; old: raw cosine 0.65, one mean per voice\n`);
  const results = {};
  for (const scn of SCENARIOS.filter((s) => !only || s.name.includes(only))) {
    const acc = { old: null, oldHigh: null, new: null, store: null };
    for (let f = 0; f < 2; f++) {
      const rand = rng(seed * 1000 + f);
      const trials = Array.from({ length: N }, () => makeTrial(folds[f], scn, rand));
      const mu = meanPrint(folds[1 - f]);            // the average voice comes from the OTHER fold's people
      const parts = { old: tally(trials, (t) => decideOld(t)), oldHigh: tally(trials, (t) => decideOld(t, { threshold: 0.8 })), new: tally(trials, (t) => decideNew(t, { mu })), store: tally(trials, (t) => decideStore(t, { mu })) };
      for (const k of Object.keys(parts)) acc[k] = acc[k] ? merge(acc[k], parts[k]) : parts[k];
    }
    results[scn.name] = acc;
    console.log(`${scn.name}`);
    console.log('  ' + row('old (raw cosine 0.65)', acc.old));
    console.log('  ' + row('old, threshold raised to 0.8', acc.oldHigh));
    console.log('  ' + row('new (Speakers class)', acc.store));
  }
  if (!only) {
    const c = corrections(folds);
    console.log(`\nafter a correction (threshold lowered to 0.45 so that lookalikes get linked: ${c.pairs} confusable pairs of people)`);
    console.log(`  the same lookalike is linked to the wrong voice again: ${pct(c.againWithout, c.pairs).trim()} % without the rejected print, ${pct(c.againWith, c.pairs).trim()} % with it`);
    console.log(`  the voice's real owner is still recognised: ${pct(c.ownerStillFound, c.ownerTried).trim()} % before, ${pct(c.ownerFoundWith, c.ownerTried).trim()} % after the correction`);
    results.corrections = c;
  }
  if (argv.includes('--json')) {
    const dir = path.join(ROOT, '.eval', 'results');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `voices-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify({ trials: N, seed, scenarios: results }, null, 1));
    console.log(`\nresults written to ${path.relative(ROOT, f)}`);
  }
}

// A correction: a lookalike was linked to somebody's saved voice, the user said "no, that is X", and the voice remembers
// the print as "not you". Is the same stranger linked again the next time? Pairs are every ordered pair of people of a fold
// (saved voice A from one chapter, stranger X heard in two later ones); a lenient threshold makes wrong links common enough
// to count.
function corrections(folds, lenient = 0.45) {
  const { voiceScore, addPrint, norm } = require('../src/speakers/cluster');
  const out = { pairs: 0, wrongFirst: 0, againWithout: 0, againWith: 0, ownerStillFound: 0, ownerTried: 0, ownerFoundWith: 0 };
  folds.forEach((fold, f) => {
    const mu = meanPrint(folds[1 - f]);
    for (const a of fold.filter((p) => p.chapters.length >= 2)) for (const x of fold) {
      if (x === a || x.chapters.length < 2) continue;
      const rand = rng(Number(a.id) * 31 + Number(x.id));
      const pa = printOf(a.chapters[0], 'mic', 'final', rand), x1 = printOf(x.chapters[0], 'mic', 'final', rand), x2 = printOf(x.chapters[1], 'mic', 'final', rand), a2 = printOf(a.chapters[1], 'mic', 'final', rand);
      const prints = addPrint([], { embedding: pa.c, weight: Math.min(30, pa.secs), channel: 'mic' });
      const plain = { id: 'a', embedding: prints[0].embedding, exemplars: prints };
      if (voiceScore(x1.c, plain, { mu }) < lenient) continue;           // not confusable: nothing to correct
      out.pairs++; out.wrongFirst++;
      const told = { ...plain, exemplars: [...prints, { embedding: norm(x1.c), negative: true }] };
      if (voiceScore(x2.c, plain, { mu }) >= lenient) out.againWithout++;
      if (voiceScore(x2.c, told, { mu }) >= lenient) out.againWith++;
      out.ownerTried++;
      if (voiceScore(a2.c, plain, { mu }) >= lenient) out.ownerStillFound++;
      if (voiceScore(a2.c, told, { mu }) >= lenient) out.ownerFoundWith++;
    }
  });
  return out;
}

// Picks the threshold and margin on one fold of people and the cross-channel discount on the same fold's cross-channel
// scenarios, and scores them on the other fold. utility = correct links - COST x (wrong-person links + strangers linked).
let COST = 3;   // a wrong link costs as much as this many missed ones
const utility = (t) => t.correct - COST * (t.wrong + t.falseAccept);
function calibrate(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const N = Number(opt('--trials', 120)), seed = Number(opt('--seed', 11));
  COST = Number(opt('--cost', COST));
  const idx = loadCache();
  const folds = makeFolds(idx.people, 5);
  const { MATCH } = require('../src/speakers/cluster');
  const same = SCENARIOS.filter((s) => /^(same mic, 1|same mic, 2|live \(3|video call)/.test(s.name));
  const cross = SCENARIOS.filter((s) => /heard on|saved on mic\+call/.test(s.name) && !/^live/.test(s.name));
  const Ts = [], Ms = [0, 0.02, 0.05, 0.08, 0.12], Cs = [0, 0.05, 0.1, 0.15, 0.2];
  for (let t = 0.35; t <= 0.751; t += 0.025) Ts.push(Math.round(t * 1000) / 1000);
  const mk = (f, list) => { const rand = rng(seed * 100 + f); return list.map((scn) => Array.from({ length: N }, () => makeTrial(folds[f], scn, rand))); };
  const score = (sets, mu, o) => sets.reduce((acc, trials) => merge(acc, tally(trials, (t) => decideNew(t, { mu, ...o }))), { known: 0, correct: 0, missed: 0, wrong: 0, strangers: 0, falseAccept: 0 });
  for (let f = 0; f < 2; f++) {
    const mu = meanPrint(folds[1 - f]);
    const dev = mk(f, same), devX = mk(f, cross), test = mk(1 - f, same), testX = mk(1 - f, cross);
    const muTest = meanPrint(folds[f]);
    let best = null;
    for (const threshold of Ts) for (const margin of Ms) { const u = utility(score(dev, mu, { threshold, margin })); if (!best || u > best.u) best = { u, threshold, margin }; }
    let bestC = null;
    for (const c of Cs) { const u = utility(score(devX, mu, { threshold: best.threshold, margin: best.margin, cross: c })); if (!bestC || u > bestC.u) bestC = { u, cross: c }; }
    const shipped = { threshold: MATCH.threshold, margin: MATCH.margin, cross: MATCH.cross };
    console.log(`calibrated on fold ${f} (${folds[f].length} people), scored on fold ${1 - f} (${folds[1 - f].length} people)`);
    console.log(`  picked threshold ${best.threshold}, margin ${best.margin}, cross-channel discount ${bestC.cross}`);
    console.log('  ' + row('  picked, same-channel scenarios', score(test, muTest, { threshold: best.threshold, margin: best.margin })));
    console.log('  ' + row('  shipped, same-channel scenarios', score(test, muTest, shipped)));
    console.log('  ' + row('  picked, cross-channel scenarios', score(testX, muTest, { threshold: best.threshold, margin: best.margin, cross: bestC.cross })));
    console.log('  ' + row('  shipped, cross-channel scenarios', score(testX, muTest, shipped)));
  }
}

module.exports = { rng, shuffle, loadCache, CACHE, CHANNELS, makeFolds, meanPrint, makeTrial, decideOld, decideNew, decideStore, tally, merge, row, SCENARIOS };

if (require.main === module) {
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'run';
  if (cmd === 'extract') extract(process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : CACHE);
  else if (cmd === 'run') run(process.argv.slice(2));
  else if (cmd === 'calibrate') calibrate(process.argv.slice(2));
  else if (cmd === 'mean') { const mu = meanPrint(loadCache().people); console.log(Buffer.from(mu.buffer).toString('base64')); }   // the VOICE_MEAN constant of src/speakers/cluster.js
  else { console.error(`unknown command ${cmd}`); process.exit(1); }
}
