#!/usr/bin/env node
'use strict';
// Saved-voice recognition evaluation: how well does Speakers.autoMatch link a meeting's unnamed speakers to saved
// voice profiles ("Ana", "Bruno"), and refuse to link people it has never been told about?
//
//   node eval/voices.js extract          # once: voice prints of real speakers, cached in .eval/voices (a few minutes)
//   node eval/voices.js [run] [--trials 300] [--seed 7] [--json]
//   node eval/voices.js calibrate         # threshold and margin picked on one half of the people, scored on the other
//   node eval/voices.js mean              # prints VOICE_MEAN (base64) of src/speakers/cluster.js
//   node eval/voices.js prob              # P(same person | centred score[, margin]) per channel type, ECE, match/ask/no-match bands
//   node eval/voices.js eer               # equal error rates of centred (and raw) scores per channel type
//   node eval/voices.js speed             # ms per 10 s voice print, 1 thread
//
// Every command takes --model <file.onnx> (default: the shipped model). Each model has its own cache: the shipped one in
// .eval/voices, any other in .eval/voices/<model name>/, and its average voice is always rebuilt from its own prints
// (never the shipped VOICE_MEAN). extract takes several models at once (--model a.onnx,b.onnx: the audio is decoded and
// degraded once), --threads N (default 8) and --pools-only (only the after-recording prints: no live scenarios).
// The analyses take --exclude person/chapter[,...] to leave chapters out (see loadFor).
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
// The cache of a voice model: the shipped model keeps .eval/voices, any other gets .eval/voices/<name>/.
const cacheFor = (model) => (!model || path.basename(model) === path.basename(MODEL) ? CACHE : path.join(CACHE, path.basename(model).replace(/\.onnx$/, '')));
const argOf = (argv, k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const modelsOf = (argv) => (argOf(argv, '--model', null) || MODEL).split(',').map((m) => path.resolve(m));
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

// models: [{ model, dest }]. The audio is decoded and degraded once and embedded by every model. poolsOnly: only the pooled
// after-recording prints (for models too slow to run live); the live scenarios are then skipped for that cache.
function extract(models = [{ model: MODEL, dest: CACHE }], { threads = Math.min(8, os.cpus().length), poolsOnly = false } = {}) {
  const sherpa = require('sherpa-onnx-node');
  const { voiceFeatures } = require('../src/audio/features');
  const ms = models.map(({ model, dest }) => {
    if (!fs.existsSync(model)) throw new Error(`voice model missing: ${model}`);
    const ex = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: threads, provider: 'cpu', debug: 0 });
    const embed = (x) => { const st = ex.createStream(); st.acceptWaveform({ samples: x, sampleRate: RATE }); st.inputFinished(); return Float32Array.from(ex.compute(st, false)); };
    return { model, dest, embed, out: [], embedMs: 0, audioS: 0 };
  });
  const timed = (m, x) => { const t = process.hrtime.bigint(); const e = m.embed(x); m.embedMs += Number(process.hrtime.bigint() - t) / 1e6; m.audioS += x.length / RATE; return e; };
  const people = listLibri();
  const t0 = Date.now();
  for (const p of people) {
    const entries = ms.map(() => ({ id: p.id, sex: p.sex, chapters: [] }));
    for (const ch of p.chapters) {
      const rand = rng(Number(p.id) * 1009 + Number(ch.id));
      const files = shuffle(ch.files, rand).slice(0, UTTS);
      const clean = files.map((f) => decode(f).subarray(0, UTT_MAX_S * RATE));
      const audio = { mic: clean, ...Object.fromEntries(Object.keys(DEGRADE).map((k) => [k, clean.map((x, i) => degrade(x, Number(ch.id) * 131 + i, k))])) };
      const recs = ms.map(() => ({ id: ch.id, utts: files.length, seconds: clean.map((x) => x.length / RATE), emb: {}, pools: [] }));
      for (const c of CHANNELS) ms.forEach((m, j) => { recs[j].emb[c] = poolsOnly ? [] : audio[c].map((x) => timed(m, x)); });
      for (let k = 0; k < POOLS; k++) {
        const order = shuffle(clean.map((_, i) => i), rand);
        const pool = { members: [], pitch: {}, seconds: 0 };
        for (const i of order) { if (pool.seconds >= POOL_S) break; pool.members.push(i); pool.seconds += clean[i].length / RATE; }
        pool.seconds = Math.min(POOL_S, pool.seconds);
        const pools = ms.map(() => ({ ...pool, emb: {}, pitch: pool.pitch }));
        for (const c of CHANNELS) {
          const parts = pool.members.map((i) => audio[c][i]);
          const all = new Float32Array(parts.reduce((a, q) => a + q.length, 0));
          let at = 0;
          for (const q of parts) { all.set(q, at); at += q.length; }
          const x = all.subarray(0, POOL_S * RATE);
          ms.forEach((m, j) => { pools[j].emb[c] = timed(m, x); });
          const f0 = parts.slice(0, 8).map((q) => voiceFeatures(q.subarray(0, 8 * RATE))?.f0).filter(Boolean).sort((a, b) => a - b); // as diarize-worker.js
          pool.pitch[c] = f0.length ? f0[(f0.length - 1) >> 1] : null;
        }
        pools.forEach((q, j) => recs[j].pools.push(q));
      }
      recs.forEach((r, j) => entries[j].chapters.push(r));
    }
    entries.forEach((e, j) => ms[j].out.push(e));
    console.log(`${p.id} (${p.sex}): ${p.chapters.length} chapters  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
  }
  for (const m of ms) {
    const { dest, out } = m;
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
    const speed = { threads, msPer10s: Math.round((m.embedMs / m.audioS) * 10), note: 'wall time inside compute(), while other models of the same run were idle' };
    fs.writeFileSync(path.join(dest, 'index.json'), JSON.stringify({ model: path.basename(m.model), dim, channels: CHANNELS, ...(poolsOnly ? { poolsOnly: true } : {}), speed, people: index }));
    console.log(`${path.basename(m.model)}: wrote ${flat.length} voice prints (${dim} dims) to ${path.relative(ROOT, dest)}; ${speed.msPer10s} ms per 10 s at ${threads} threads`);
  }
}

// --exclude person/chapter[,person/chapter]: drop chapters from an analysis (e.g. 1988/148538, whose voice every model
// scores as somebody else than the reader's other two chapters: probably a mislabelled chapter in LibriSpeech).
function loadFor(argv) {
  const idx = loadCache(cacheFor(modelsOf(argv)[0]));
  const ex = (argOf(argv, '--exclude', '') || '').split(',').filter(Boolean);
  if (ex.length) {
    for (const p of idx.people) p.chapters = p.chapters.filter((c) => !ex.includes(`${p.id}/${c.id}`));
    idx.excluded = ex;
  }
  return idx;
}

function loadCache(dir = CACHE) {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const b = fs.readFileSync(path.join(dir, 'emb.bin'));
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
// The per-channel average voices of a trial: opts.mu (the average voice of the model) pulled towards the voices heard there.
function trialMeans(trial, opts = {}) {
  const { populationMean, MATCH } = require('../src/speakers/cluster');
  const heard = (side) => [...trial.roster.flatMap((r) => r.prints.filter((p) => sideOf(p.chan) === side).map((p) => p.c)), ...trial.speakers.filter((x) => sideOf(x.chan) === side).map((x) => x.c), ...(trial.hist || []).filter((h) => h.side === side).map((h) => h.c)];
  const means = { mic: populationMean(heard('mic'), opts.mu, MATCH.prior.mic), system: populationMean(heard('system'), opts.mu, MATCH.prior.system) };
  return opts.adapt === false ? opts.mu : (side) => means[side] || opts.mu;
}
function trialVoices(trial) {
  const { addPrint } = require('../src/speakers/cluster');
  return trial.roster.map((r) => {
    let prints = [];
    r.prints.forEach((p, k) => { prints = addPrint(prints, { embedding: p.c, weight: Math.min(30, p.secs), channel: sideOf(p.chan), pitch: p.pitch, source: `n${k}` }); });
    const pw = prints.filter((x) => x.pitch);
    return { id: r.id, embedding: prints[0].embedding, samples: 1, exemplars: prints, pitch: pw.length ? pw.reduce((a, x) => a + x.pitch * x.weight, 0) / pw.reduce((a, x) => a + x.weight, 0) : null };
  });
}
const pitchOk = (s, v) => !(s.pitch && v.pitch && semitonesOf(s.pitch, v.pitch) > PITCH_VETO);
function decideNew(trial, opts = {}) {
  const { matchVoices, MATCH } = require('../src/speakers/cluster');
  const mu = trialMeans(trial, opts);
  const voices = trialVoices(trial);
  const cands = trial.speakers.map((s, i) => ({ id: i, centroid: s.c, channel: sideOf(s.chan), pitch: s.pitch }));
  const m = matchVoices(cands, voices, opts.threshold ?? MATCH.threshold, pitchOk, { mu, margin: opts.margin ?? MATCH.margin, cross: opts.cross ?? MATCH.cross });
  return new Map([...m].map(([i, x]) => [i, x.voiceId]));
}

// Every speaker of a trial with its best saved voice, the centred score and the margin to the second-best voice (as
// matchVoices computes them, before any threshold). -> [{ truth, best, score, gap }]
const GAP_CAP = 0.5;      // the margin feature is capped (a single eligible voice has an infinite margin)
function scoredSpeakers(trial, opts = {}) {
  const { voiceScore, MATCH } = require('../src/speakers/cluster');
  const mu = trialMeans(trial, opts);
  const voices = trialVoices(trial);
  return trial.speakers.map((s) => {
    const channel = sideOf(s.chan);
    const scored = voices.filter((v) => pitchOk(s, v)).map((v) => ({ v: v.id, c: voiceScore(s.c, v, { channel, mu, cross: opts.cross ?? MATCH.cross }) })).sort((a, b) => b.c - a.c);
    if (!scored.length) return { truth: s.truth, best: null, score: -1, gap: 0 };
    return { truth: s.truth, best: scored[0].v, score: scored[0].c, gap: Math.min(GAP_CAP, scored.length > 1 ? scored[0].c - scored[1].c : GAP_CAP) };
  });
}

// The real thing: Speakers on an in-memory database, voices saved with rename(remember), then autoMatch on the new meeting.
function decideStore(trial, { mu, threshold, margin } = {}) {
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
      speakers.rename(n.id, 's1', `p${r.id}`, { remember: true, consentSource: 'user' });   // a voice is saved only with consent (store.js)
    }
  }
  for (const h of trial.hist || []) { const hn = notes.create({}); speakers.save(hn.id, { speakerId: 's1', channel: h.side, centroid: h.c, count: 5 }); }
  const n = notes.create({});
  trial.speakers.forEach((s, i) => { speakers.save(n.id, { speakerId: `s${i + 1}`, channel: sideOf(s.chan), centroid: s.c, count: s.count, pitch: s.pitch }); seg(n.id, `s${i + 1}`, s.secs); });
  if (threshold === undefined && margin === undefined) speakers.autoMatch(n.id); else speakers.autoMatch(n.id, threshold, margin === undefined ? {} : { margin });
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
  const opt = (k, d) => argOf(argv, k, d);
  const N = Number(opt('--trials', 300)), seed = Number(opt('--seed', 7));
  const only = opt('--only', null);
  const idx = loadFor(argv);
  const folds = makeFolds(idx.people, 5);
  const { MATCH } = require('../src/speakers/cluster');
  // settings of the new matching: the shipped ones, fixed ones (--threshold/--margin), or --calibrated: for each half of the
  // people, the threshold and margin that `calibrate` picks on the OTHER half (a model's own operating point)
  const fixed = { threshold: Number(opt('--threshold', MATCH.threshold)), margin: Number(opt('--margin', MATCH.margin)) };
  const calibrated = argv.includes('--calibrated');
  const settings = calibrated ? [pickSettings(idx, folds, 1), pickSettings(idx, folds, 0)] : [fixed, fixed];   // settings[f] scores fold f
  console.log(`${idx.people.length} readers (${idx.people.filter((p) => p.chapters.length > 1).length} with 2+ chapters), voice model ${idx.model} (${idx.dim} dims${idx.poolsOnly ? ', after-recording prints only: live scenarios skipped' : ''})${idx.excluded ? `, excluding ${idx.excluded.join(', ')}` : ''}; 2 folds of ${folds.map((f) => f.length).join(' + ')} people; ${N} random histories per fold and scenario, seed ${seed}`);
  console.log(`new settings: ${calibrated ? `calibrated per fold on the other fold: fold 0 scored at threshold ${settings[0].threshold} margin ${settings[0].margin}, fold 1 at ${settings[1].threshold} margin ${settings[1].margin}` : `centred similarity >= ${fixed.threshold}, margin ${fixed.margin}`}; old: raw cosine 0.65, one mean per voice\n`);
  const results = {};
  for (const scn of scenariosOf(idx).filter((s) => !only || s.name.includes(only))) {
    const acc = { old: null, oldHigh: null, new: null, store: null };
    for (let f = 0; f < 2; f++) {
      const rand = rng(seed * 1000 + f);
      const trials = Array.from({ length: N }, () => makeTrial(folds[f], scn, rand));
      const mu = meanPrint(folds[1 - f]);            // the average voice comes from the OTHER fold's people
      const o = settings[f];
      const shipped = !calibrated && o.threshold === MATCH.threshold && o.margin === MATCH.margin;
      const parts = { old: tally(trials, (t) => decideOld(t)), oldHigh: tally(trials, (t) => decideOld(t, { threshold: 0.8 })), new: tally(trials, (t) => decideNew(t, { mu, ...o })), store: tally(trials, (t) => decideStore(t, shipped ? { mu } : { mu, ...o })) };
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
    results.eer = eerTable(idx, folds);
    console.log('');
    printEer(results.eer);
  }
  if (argv.includes('--json')) {
    const dir = path.join(ROOT, '.eval', 'results');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `voices-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify({ model: idx.model, trials: N, seed, settings, calibrated, scenarios: results }, null, 1));
    console.log(`\nresults written to ${path.relative(ROOT, f)}`);
  }
}

// The scenarios a cache supports: without the per-utterance prints (--pools-only) there are no live ones.
const scenariosOf = (idx) => SCENARIOS.filter((s) => !idx.poolsOnly || s.test.kind === 'final');

// ---------------------------------------------------------------- equal error rates
// EER of same-person vs different-person scores: the threshold where a stranger is accepted as often as the right person
// is refused. -> { eer, threshold, targets, nontargets }
function eer(targets, nontargets) {
  const all = [...targets.map((s) => [s, 1]), ...nontargets.map((s) => [s, 0])].sort((a, b) => b[0] - a[0]);
  const T = targets.length, N = nontargets.length;
  if (!T || !N) return { eer: null, threshold: null, targets: T, nontargets: N };
  let fa = 0, fr = T, best = { d: Infinity, eer: null, threshold: null };
  for (let i = 0; i < all.length; i++) {
    if (all[i][1]) fr--; else fa++;
    if (i + 1 < all.length && all[i + 1][0] === all[i][0]) continue;     // accept every score >= this one
    const far = fa / N, frr = fr / T, d = Math.abs(far - frr);
    if (d < best.d) best = { d, eer: (far + frr) / 2, threshold: all[i][0] };
  }
  return { eer: best.eer, threshold: best.threshold, targets: T, nontargets: N };
}

// Same-person pairs = one person's pooled prints from two DIFFERENT chapters (meetings); different-person pairs = any two
// people. Each fold is scored centred on the per-channel mean print of the OTHER fold (the stand-in for the per-channel
// average voice the app adapts), and the scores of both folds are pooled. Also: raw cosine on the mic, and single
// utterances on the mic (4 per chapter) when the cache has them.
const EER_TYPES = [
  { name: 'same mic', a: 'mic', b: 'mic' },
  { name: 'video call', a: 'call', b: 'call' },
  { name: 'phone line', a: 'phone', b: 'phone' },
  { name: 'cross-channel (mic vs call)', a: 'mic', b: 'call' },
  { name: 'cross-channel (mic vs phone line)', a: 'mic', b: 'phone' },
  { name: 'same mic, raw cosine (not centred)', a: 'mic', b: 'mic', raw: true },
  { name: 'same mic, single utterances', a: 'mic', b: 'mic', utt: true },
];
function eerTable(idx, folds) {
  const { centre, norm, cosine } = require('../src/speakers/cluster');
  const chanMean = (people, chan) => {
    let mu = null, n = 0;
    for (const p of people) for (const c of p.chapters) for (const q of c.pools) { const v = norm(q.emb[chan]); if (!mu) mu = new Float32Array(v.length); for (let i = 0; i < v.length; i++) mu[i] += v[i]; n++; }
    return mu.map((x) => x / n);
  };
  const out = {};
  for (const ty of EER_TYPES) {
    if (ty.utt && idx.poolsOnly) continue;
    const tar = [], non = [];
    folds.forEach((fold, f) => {
      const muA = chanMean(folds[1 - f], ty.a), muB = chanMean(folds[1 - f], ty.b);
      const prints = (chan, mu) => fold.flatMap((p) => p.chapters.flatMap((c) => (ty.utt ? c.emb[chan].slice(0, 4) : c.pools.map((q) => q.emb[chan])).map((v) => ({ p: p.id, ch: c.id, v: ty.raw ? norm(v) : centre(v, mu) }))));
      const A = prints(ty.a, muA), B = ty.a === ty.b ? A : prints(ty.b, muB);
      for (let i = 0; i < A.length; i++) for (let j = ty.a === ty.b ? i + 1 : 0; j < B.length; j++) {
        const x = A[i], y = B[j];
        if (x.p === y.p && x.ch === y.ch) continue;                 // two prints of one meeting say little
        (x.p === y.p ? tar : non).push(cosine(x.v, y.v));
      }
    });
    out[ty.name] = eer(tar, non);
  }
  return out;
}
function printEer(table) {
  console.log('equal error rate, same person (another meeting) vs different people, pooled 30 s prints unless stated');
  for (const [name, r] of Object.entries(table)) console.log(`  ${name.padEnd(38)} EER ${r.eer === null ? '  n/a' : (100 * r.eer).toFixed(2).padStart(5)} %  at score ${r.threshold === null ? 'n/a' : r.threshold.toFixed(3)}   (${r.targets} same-person, ${r.nontargets} different-person pairs)`);
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
const CAL_SAME = /^(same mic, 1|same mic, 2|live \(3|video call)/;
const CAL_CROSS = (n) => /heard on|saved on mic\+call/.test(n) && !/^live/.test(n);
const CAL_TS = Array.from({ length: 17 }, (_, i) => Math.round((0.35 + 0.025 * i) * 1000) / 1000), CAL_MS = [0, 0.02, 0.05, 0.08, 0.12], CAL_CS = [0, 0.05, 0.1, 0.15, 0.2];
const zero = () => ({ known: 0, correct: 0, missed: 0, wrong: 0, strangers: 0, falseAccept: 0 });
const calTrials = (idx, folds, f, list, N, seed) => { const rand = rng(seed * 100 + f); return list.map((scn) => Array.from({ length: N }, () => makeTrial(folds[f], scn, rand))); };
const calScore = (sets, mu, o) => sets.reduce((acc, trials) => merge(acc, tally(trials, (t) => decideNew(t, { mu, ...o }))), zero());
// The threshold and margin that maximise the utility on fold f's people (and then the cross-channel discount on its
// cross-channel scenarios), with the average voice from the other fold. -> { threshold, margin, cross }
function pickSettings(idx, folds, f, { N = 120, seed = 11 } = {}) {
  const same = scenariosOf(idx).filter((s) => CAL_SAME.test(s.name)), cross = scenariosOf(idx).filter((s) => CAL_CROSS(s.name));
  const mu = meanPrint(folds[1 - f]);
  const dev = calTrials(idx, folds, f, same, N, seed), devX = calTrials(idx, folds, f, cross, N, seed);
  let best = null;
  for (const threshold of CAL_TS) for (const margin of CAL_MS) { const u = utility(calScore(dev, mu, { threshold, margin })); if (!best || u > best.u) best = { u, threshold, margin }; }
  let bestC = null;
  for (const c of CAL_CS) { const u = utility(calScore(devX, mu, { threshold: best.threshold, margin: best.margin, cross: c })); if (!bestC || u > bestC.u) bestC = { u, cross: c }; }
  return { threshold: best.threshold, margin: best.margin, cross: bestC.cross };
}
function calibrate(argv) {
  const opt = (k, d) => argOf(argv, k, d);
  const N = Number(opt('--trials', 120)), seed = Number(opt('--seed', 11));
  COST = Number(opt('--cost', COST));
  const idx = loadFor(argv);
  const folds = makeFolds(idx.people, 5);
  const { MATCH } = require('../src/speakers/cluster');
  const same = scenariosOf(idx).filter((s) => CAL_SAME.test(s.name)), cross = scenariosOf(idx).filter((s) => CAL_CROSS(s.name));
  console.log(`voice model ${idx.model}${idx.excluded ? `, excluding ${idx.excluded.join(', ')}` : ''}; same-channel scenarios: ${same.map((s) => s.name).join(', ')}`);
  for (let f = 0; f < 2; f++) {
    const pick = pickSettings(idx, folds, f, { N, seed });
    const test = calTrials(idx, folds, 1 - f, same, N, seed), testX = calTrials(idx, folds, 1 - f, cross, N, seed);
    const muTest = meanPrint(folds[f]);
    const shipped = { threshold: MATCH.threshold, margin: MATCH.margin, cross: MATCH.cross };
    console.log(`calibrated on fold ${f} (${folds[f].length} people), scored on fold ${1 - f} (${folds[1 - f].length} people)`);
    console.log(`  picked threshold ${pick.threshold}, margin ${pick.margin}, cross-channel discount ${pick.cross}`);
    console.log('  ' + row('  picked, same-channel scenarios', calScore(test, muTest, { threshold: pick.threshold, margin: pick.margin })));
    console.log('  ' + row('  shipped, same-channel scenarios', calScore(test, muTest, shipped)));
    console.log('  ' + row('  picked, cross-channel scenarios', calScore(testX, muTest, pick)));
    console.log('  ' + row('  shipped, cross-channel scenarios', calScore(testX, muTest, shipped)));
  }
}

// ---------------------------------------------------------------- probability calibration (match / ask / no match)
// Logistic regression by Newton's method (IRLS) with a small ridge on the slopes. X: rows of features (no intercept column),
// y: 0/1. -> [b0, b1, ...] for P = 1 / (1 + exp(-(b0 + b1 x1 + ...)))
function fitLogistic(X, y, { l2 = 1e-4, iters = 50 } = {}) {
  const d = (X[0]?.length ?? 0) + 1;
  let b = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let n = 0; n < X.length; n++) {
      const x = [1, ...X[n]];
      const p = 1 / (1 + Math.exp(-x.reduce((a, v, i) => a + v * b[i], 0)));
      const w = Math.max(p * (1 - p), 1e-9);
      for (let i = 0; i < d; i++) { g[i] += (y[n] - p) * x[i]; for (let j = 0; j < d; j++) H[i][j] += w * x[i] * x[j]; }
    }
    for (let i = 1; i < d; i++) { g[i] -= l2 * X.length * b[i]; H[i][i] += l2 * X.length; }
    const step = solve(H, g);
    b = b.map((v, i) => v + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return b;
}
function solve(A, rhs) {                    // Gaussian elimination with partial pivoting (tiny systems)
  const n = rhs.length, M = A.map((r, i) => [...r, rhs[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) { if (r === c || !M[c][c]) continue; const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => (r[i] ? r[n] / r[i] : 0));
}
const logistic = (b, x) => 1 / (1 + Math.exp(-(b[0] + x.reduce((a, v, i) => a + v * b[i + 1], 0))));
// Expected calibration error: equal-width bins of predicted probability, |accuracy - mean prediction| weighted by bin size.
function ece(p, y, bins = 10) {
  const B = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  p.forEach((q, i) => { const k = Math.min(bins - 1, Math.floor(q * bins)); B[k].n++; B[k].p += q; B[k].y += y[i]; });
  return B.reduce((a, b) => a + (b.n ? (b.n / p.length) * Math.abs(b.y / b.n - b.p / b.n) : 0), 0);
}
// The centred score at which the one-feature model reaches probability P.
const scoreAt = (b, P) => (Math.log(P / (1 - P)) - b[0]) / b[1];

// Channel types: which scenarios feed each. The app knows "mic" and "system", not a video call from a phone line, so
// "system" (call + phone line together) is what it can actually select at runtime.
const PROB_TYPES = [
  { name: 'same mic', re: /^(same mic, 1|same mic, 2|many saved voices|first days: 2 voices, no history, mic)/ },
  { name: 'video call', re: /^(video call|first days: 2 voices, no history, call)/ },
  { name: 'phone line', re: /^poor phone line/ },
  { name: 'system (video call + phone line)', re: /^(video call|first days: 2 voices, no history, call|poor phone line)/ },
  { name: 'cross-channel', re: /^saved on (mic|call), heard on/ },
];
const BANDS = [[0.95, 0.6], [0.9, 0.5], [0.97, 0.7], [0.9, 0.6], [0.95, 0.5], [0.98, 0.8], [0.99, 0.9]];
const featuresOf = (d, two) => (two ? [d.score, d.gap] : [d.score]);

// The three-outcome rule on one trial: each speaker's best voice, kept when P >= lo (and, for the one-feature model, when it
// is `margin` ahead of the second best, as now), one speaker per voice (best score first, as matchVoices), then "match" when
// P >= hi, else "ask". -> tally with known speakers' { matchRight, matchWrong, askRight, askWrong, none } and strangers'
// { matchStranger, askStranger }
function bandTally(decs, b, two, hi, lo, margin, t) {
  const cands = decs.map((d, i) => ({ ...d, i, P: d.best ? logistic(b, featuresOf(d, two)) : 0 })).filter((d) => d.best && d.P >= lo && (two || d.gap >= margin)).sort((x, y) => y.score - x.score);
  const used = new Set(), got = new Map();
  for (const d of cands) { if (used.has(d.best)) continue; used.add(d.best); got.set(d.i, d); }
  decs.forEach((d, i) => {
    const g = got.get(i);
    const out = !g ? 'none' : g.P >= hi ? 'match' : 'ask';
    if (d.truth) { t.known++; if (out === 'none') t.none++; else t[`${out}${g.best === d.truth ? 'Right' : 'Wrong'}`]++; } else { t.strangers++; if (out !== 'none') t[`${out}Stranger`]++; }
  });
  return t;
}
const bandZero = () => ({ known: 0, strangers: 0, matchRight: 0, matchWrong: 0, askRight: 0, askWrong: 0, none: 0, matchStranger: 0, askStranger: 0 });

function prob(argv) {
  const opt = (k, d) => argOf(argv, k, d);
  const N = Number(opt('--trials', 300)), seed = Number(opt('--seed', 7));
  const idx = loadFor(argv);
  const folds = makeFolds(idx.people, 5);
  const { MATCH } = require('../src/speakers/cluster');
  // the same random histories as `run` (same seed, same order), every speaker scored against every saved voice
  const decsOf = (scn, f) => { const rand = rng(seed * 1000 + f); const mu = meanPrint(folds[1 - f]); return Array.from({ length: N }, () => scoredSpeakers(makeTrial(folds[f], scn, rand), { mu })); };
  const scns = scenariosOf(idx);
  const cache = new Map();
  const trialsOf = (scn, f) => { const k = `${scn.name}|${f}`; if (!cache.has(k)) cache.set(k, decsOf(scn, f)); return cache.get(k); };
  const out = { model: idx.model, excluded: idx.excluded || [], trials: N, seed, gapCap: GAP_CAP, label: 'best saved voice is the right person (strangers: never)', types: {} };
  console.log(`voice model ${idx.model}${idx.excluded ? `, excluding ${idx.excluded.join(', ')}` : ''}; P(best saved voice is the right person | centred score[, margin to the 2nd-best voice, capped at ${GAP_CAP}])`);
  console.log(`fitted on one half of the people, evaluated on the other (both directions pooled); coefficients to ship are fitted on both halves. ${N} histories per fold and scenario, seed ${seed}\n`);
  const typesToRun = [...PROB_TYPES, ...(idx.poolsOnly ? [] : [{ name: 'live (3 utterances), mic [same-mic model]', re: /^live \(3/, use: 'same mic' }])];
  for (const ty of typesToRun) {
    const list = scns.filter((s) => ty.re.test(s.name));
    if (!list.length) continue;
    const fold = (f) => list.flatMap((scn) => trialsOf(scn, f));            // trials (arrays of speaker decisions)
    const flat = (trials) => trials.flat().filter((d) => d.best);
    const lab = (d) => (d.truth && d.best === d.truth ? 1 : 0);
    const res = { scenarios: list.map((s) => s.name), models: {} };
    for (const two of [false, true]) {
      const key = two ? 'score+margin' : 'score';
      const fitOn = (trials) => { const D = flat(trials); return fitLogistic(D.map((d) => featuresOf(d, two)), D.map(lab)); };
      const own = ty.use ? out.types[ty.use].models[key] : null;
      const bF = own ? [own.coefFold[0], own.coefFold[1]] : [fitOn(fold(0)), fitOn(fold(1))];   // bF[f] was fitted on fold f
      const bAll = own ? own.coef : fitOn([...fold(0), ...fold(1)]);
      // held out: fold f's decisions with the model fitted on the other fold
      const P = [], Y = [];
      const bands = BANDS.map(([hi, lo]) => ({ hi, lo, t: bandZero() }));
      for (let f = 0; f < 2; f++) {
        const b = bF[1 - f];
        for (const d of flat(fold(f))) { P.push(logistic(b, featuresOf(d, two))); Y.push(lab(d)); }
        for (const trial of fold(f)) {
          for (const x of bands) bandTally(trial, b, two, x.hi, x.lo, MATCH.margin, x.t);
        }
      }
      // the current rule on the same decisions: centred score >= threshold and margin, one speaker per voice
      const cur = bandZero();
      if (!two) for (let f = 0; f < 2; f++) for (const trial of fold(f)) bandTally(trial, [-MATCH.threshold * 1e4, 1e4], false, 0.5, 0.5, MATCH.margin, cur);   // P >= 0.5 exactly when score >= threshold
      res.models[key] = { coef: bAll, coefFold: bF, ece: ece(P, Y), n: P.length, positives: Y.reduce((a, v) => a + v, 0),
        bands: bands.map((x) => ({ hi: x.hi, lo: x.lo, ...x.t })), ...(two ? {} : { current: cur, scoreAt: Object.fromEntries([0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97, 0.98, 0.99].map((q) => [q, scoreAt(bAll, q)])) }) };
    }
    out.types[ty.name] = res;
    printProb(ty.name, res);
  }
  const dir = path.join(ROOT, '.eval', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voices-prob-${idx.model.replace(/\.onnx$/, '')}${idx.excluded ? '-excl' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`results written to ${path.relative(ROOT, file)}`);
  return out;
}
function printProb(name, res) {
  const f2 = (x) => x.toFixed(3);
  console.log(`${name}  [${res.scenarios.join('; ')}]`);
  for (const [key, m] of Object.entries(res.models)) {
    console.log(`  ${key.padEnd(13)} logit P = ${m.coef.map(f2).join(' , ')}   (held-out ECE ${(100 * m.ece).toFixed(2)} %, ${m.n} decisions, ${m.positives} right person; per-fold fits ${m.coefFold.map((b) => b.map(f2).join('/')).join('  ')})`);
    if (m.scoreAt) console.log(`  ${''.padEnd(13)} centred score for P = ${Object.entries(m.scoreAt).map(([q, v]) => `${q}: ${v.toFixed(3)}`).join('  ')}`);
    const line = (label, t) => `    ${label.padEnd(22)} match right ${pct(t.matchRight, t.known)}  wrong person ${pct(t.matchWrong, t.known)}  strangers ${pct(t.matchStranger, t.strangers)} | ask ${pct(t.askRight + t.askWrong + t.askStranger, t.known + t.strangers)} of all (right person ${pct(t.askRight, t.known + t.strangers)}, not ${pct(t.askWrong + t.askStranger, t.known + t.strangers)}) | right after asking ${pct(t.matchRight + t.askRight, t.known)}`;
    if (m.current) console.log(line('current (0.6, 0.02)', m.current));
    for (const x of m.bands) console.log(line(`hi ${x.hi} lo ${x.lo}`, x));
  }
  console.log('');
}

// Milliseconds per 10 s voice print (the median of 8 after 2 warm-ups), --threads (default 1).
function speed(argv) {
  const sherpa = require('sherpa-onnx-node');
  const threads = Number(argOf(argv, '--threads', 1));
  const people = listLibri();
  const parts = [];
  let n = 0;
  for (const f of people[0].chapters[0].files) { const x = decode(f); parts.push(x); n += x.length; if (n >= 10 * RATE) break; }
  const all = new Float32Array(n);
  let at = 0;
  for (const q of parts) { all.set(q, at); at += q.length; }
  const x = all.subarray(0, 10 * RATE);
  for (const model of modelsOf(argv)) {
    const ex = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: threads, provider: 'cpu', debug: 0 });
    const embed = () => { const st = ex.createStream(); st.acceptWaveform({ samples: x, sampleRate: RATE }); st.inputFinished(); return ex.compute(st, false); };
    embed(); embed();
    const t = [];
    for (let i = 0; i < 8; i++) { const t0 = process.hrtime.bigint(); embed(); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    t.sort((a, b) => a - b);
    console.log(`${path.basename(model)}: ${ex.dim} dims, ${((t[3] + t[4]) / 2).toFixed(0)} ms per 10 s voice print at ${threads} thread(s) (median of 8), file ${(fs.statSync(model).size / 1e6).toFixed(1)} MB`);
  }
}

module.exports = { rng, shuffle, loadCache, loadFor, cacheFor, CACHE, CHANNELS, makeFolds, meanPrint, makeTrial, decideOld, decideNew, decideStore, scoredSpeakers, tally, merge, row, SCENARIOS, eer, fitLogistic, logistic, ece, scoreAt, bandTally };

if (require.main === module) {
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'run';
  const argv = process.argv.slice(2);
  if (cmd === 'extract') {
    const list = modelsOf(argv);
    const out = argOf(argv, '--out', null);
    if (out && list.length > 1) throw new Error('--out takes one model');
    extract(list.map((model) => ({ model, dest: out ? path.resolve(out) : cacheFor(model) })), { threads: Number(argOf(argv, '--threads', Math.min(8, os.cpus().length))), poolsOnly: argv.includes('--pools-only') });
  }
  else if (cmd === 'run') run(argv);
  else if (cmd === 'calibrate') calibrate(argv);
  else if (cmd === 'mean') { const mu = meanPrint(loadFor(argv).people); console.log(Buffer.from(mu.buffer).toString('base64')); }   // the VOICE_MEAN constant of src/speakers/cluster.js (for this model)
  else if (cmd === 'eer') { const idx = loadFor(argv); console.log(`voice model ${idx.model}${idx.excluded ? `, excluding ${idx.excluded.join(', ')}` : ''}`); printEer(eerTable(idx, makeFolds(idx.people, 5))); }
  else if (cmd === 'prob') prob(argv);
  else if (cmd === 'speed') speed(argv);
  else { console.error(`unknown command ${cmd}`); process.exit(1); }
}
