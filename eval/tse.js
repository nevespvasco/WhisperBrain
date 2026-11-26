#!/usr/bin/env node
'use strict';
// Go/no-go experiment: target-speaker extraction (TSE) with VoxLock to recover the second talker's words in overlapped
// speech, after Stop. Results and the pre-registered criteria are in eval/tse-results.md.
//
//   node eval/tse.js                         every recording in .eval/data (system channel), int8 and fp32 VoxLock
//   node eval/tse.js --only ami-IS1009a --prec int8
//   node eval/tse.js --synthetic [--pairs 30] [--prec int8,fp32]
//   node eval/tse.js ... --context 4         exploratory: 4 s of context around each region instead of 1 s
//   node eval/tse.js --absent --only ami-IS1009a --prec int8   control: condition on a speaker absent from the region
//   node eval/tse.js ... --fresh             recompute the extractions instead of reusing .eval/tse/runs/*.json
//
// Per recording (system channel; the mic channel of libri-call has one speaker and is left as it is):
//   1. words  = the real pipeline's recognized words (cached by eval/offline.js, same key), speakers from the full
//               diarization (threshold 0.6, window shift 0.1, same call and cache key as eval/offline.js) via
//               toTimeline + assignWords, exactly as `offline.js --strategy full` does. This is "before".
//   2. R      = spans where >= 2 diarized speakers are active (gaps <= 0.2 s merged), kept when >= 0.5 s.
//   3. per region r, the two speakers most active in r, A and B; window = r +- 1 s (clipped).
//      for S in {A, B}: voice sample = S's longest solo stretches in this meeting (soloStretches, 3-10 s, written to
//      .eval/tse/voices), y_S = VoxLock(window, voice sample), words_S = Parakeet v3 (greedy, like the app) on y_S.
//      Control: Parakeet on the unprocessed window ("passthrough"), reconciled the same way.
//   4. reconcile (primary, fixed before any result was seen): the speaker who already owns most "before" words in r is
//      dominant; its words stay. The other speaker's words_S whose midpoint lies inside r are inserted, attributed to
//      that speaker, except a word whose normalized text equals a "before" word within 0.5 s (a duplicate: either
//      leakage of the dominant voice or a word the pipeline already had). When r has no "before" words, both speakers'
//      words are inserted (the one with more diarized time in r wins a duplicate).
//      Exploratory variant "replace": inside r, drop the "before" words and use words_A + words_B (deduplicated).
//   5. score with eval/metrics.js score() and scoreTime(), before vs after; non-overlap change = share of "before"
//      words outside the reference overlap regions that are added, removed or relabelled.
// Timing: VoxLock load + enrollment (one denoiser per speaker), the VoxLock runs and the Parakeet decodes of y_S, all
// on 4 threads; the Parakeet model load is not counted (the app has it loaded already). The machine is shared, so
// times are upper bounds.
//
// Synthetic set (--synthetic): pairs of LibriSpeech dev-clean utterances from different readers (not the libri-call
// readers), mixed with 20-50 % overlap (of the shorter one) at 0, +5 and -5 dB (second talker relative to the first);
// each reader's voice sample is a different utterance of the same reader. Oracle turns and overlap span (the friendly
// case); same reconcile and scoring, all mixtures laid end to end on one time line.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseWav, floatToPcm16, pcm16ToFloat, pcm16ToWav } = require('../src/audio/pcm');
const { Models, recognizerConfig } = require('../src/asr/models');
const { wordsOf } = require('../src/asr/segment-info');
const { assignWords, toTimeline, soloStretches } = require('../src/speakers/diarize');
const { score, scoreTime, normalize, align, turnsFromWords, overlapRegions } = require('./metrics');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.eval', 'data');
const CACHE = path.join(ROOT, '.eval', 'cache');
const OUT = path.join(ROOT, '.eval', 'tse');
const VOX = path.join(ROOT, '.models', 'voxlock');
const PREC = {
  int8: { enroll: path.join(VOX, 'sherpa-onnx-voxlock-int8', 'enroll.onnx'), chunk: path.join(VOX, 'sherpa-onnx-voxlock-int8', 'chunk_int8.onnx') },
  fp32: { enroll: path.join(VOX, 'sherpa-onnx-voxlock', 'enroll.onnx'), chunk: path.join(VOX, 'sherpa-onnx-voxlock', 'chunk.onnx') },
};
const THREADS = 4;
const RATE = 16000;
const MIN_REGION = 0.5, MERGE_GAP = 0.2, DUP_SEC = 0.5;
const VOICE_MIN = 3.2, VOICE_MAX = 10;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const CONTEXT = Number(opt('--context', 1)); // seconds of audio on each side of a region (exploratory: --context 4)
const TAG = CONTEXT === 1 ? '' : `.ctx${CONTEXT}`;
const models = new Models(process.env.WB_MODELS_DIR || path.join(ROOT, '.models'));
for (const d of [OUT, path.join(OUT, 'voices'), path.join(OUT, 'runs')]) fs.mkdirSync(d, { recursive: true });

const cacheFile = (key) => path.join(CACHE, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
const cached = async (key, make) => { // same helper and key format as eval/offline.js
  const f = cacheFile(key);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = await make();
  fs.writeFileSync(f, JSON.stringify(v));
  return v;
};

// ---- models ----
let sherpa = null;
const lib = () => (sherpa ||= require('sherpa-onnx-node'));
let recognizer = null;
function asr() {
  if (!recognizer) recognizer = new (lib().OfflineRecognizer)(recognizerConfig(models.describe('parakeet-tdt-0.6b-v3'), { threads: THREADS }));
  return recognizer;
}
// Parakeet on a clip -> [{ start, end, word }] in seconds, shifted by `offset`.
function recognize(samples, offset = 0) {
  if (samples.length < RATE * 0.3) return [];
  const st = asr().createStream();
  st.acceptWaveform({ samples, sampleRate: RATE });
  asr().decode(st);
  const ws = wordsOf(asr().getResult(st)) || [];
  return ws.map(([w, a, b]) => ({ start: offset + a / 1000, end: offset + Math.max(b, a + 40) / 1000, word: w }));
}
function denoiser(prec, voicePath) {
  const t0 = process.hrtime.bigint();
  const d = new (lib().OfflineSpeechDenoiser)({ model: { voxlock: { enrollModel: PREC[prec].enroll, chunkModel: PREC[prec].chunk, voiceSample: voicePath }, numThreads: THREADS, provider: 'cpu', debug: 0 } });
  return { d, loadSec: Number(process.hrtime.bigint() - t0) / 1e9 };
}
const timed = (fn) => { const t0 = process.hrtime.bigint(); const v = fn(); return [v, Number(process.hrtime.bigint() - t0) / 1e9]; };

const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); };
function corr(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}
const key = (w) => String(w).toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}']+/gu, '');
const mid = (w) => (w.start + w.end) / 2;
const writeVoice = (file, f32) => fs.writeFileSync(file, pcm16ToWav(floatToPcm16(f32)));

// ---- overlap regions from (hypothesis) turns ----
function regionsOf(turns) {
  const step = 0.01;
  const end = Math.max(0, ...turns.map((t) => t.end));
  const frames = Math.ceil(end / step) + 1;
  const ids = [...new Set(turns.map((t) => t.speaker))];
  const act = ids.map(() => new Uint8Array(frames));
  for (const t of turns) { const a = act[ids.indexOf(t.speaker)]; for (let f = Math.round(t.start / step); f < Math.min(frames, Math.round(t.end / step)); f++) a[f] = 1; }
  let spans = [], from = -1;
  for (let f = 0; f <= frames; f++) {
    let n = 0;
    if (f < frames) for (const a of act) n += a[f];
    if (n >= 2 && from < 0) from = f;
    if (n < 2 && from >= 0) { spans.push([from, f]); from = -1; }
  }
  const merged = [];
  for (const s of spans) { const l = merged[merged.length - 1]; if (l && (s[0] - l[1]) * step <= MERGE_GAP) l[1] = s[1]; else merged.push([...s]); }
  return merged.filter(([a, b]) => (b - a) * step >= MIN_REGION).map(([a, b]) => {
    const busy = ids.map((id, k) => { let n = 0; for (let f = a; f < b; f++) n += act[k][f]; return [id, n * step]; }).filter((x) => x[1] > 0).sort((x, y) => y[1] - x[1]);
    return { start: a * step, end: b * step, speakers: busy.slice(0, 2).map((x) => x[0]), busy };
  });
}

// A speaker's voice sample: the longest solo stretches, 3.2-10 s in all. -> Float32Array or null
function voiceSample(samples, turns, speaker) {
  const st = soloStretches(turns, speaker, { maxSec: VOICE_MAX, minSec: 0.5 });
  const total = st.reduce((n, [a, b]) => n + b - a, 0);
  if (total < VOICE_MIN) return null;
  const parts = st.map(([a, b]) => samples.subarray(Math.round(a * RATE), Math.round(b * RATE)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- reconcile ----
// before: [{ speaker, start, end, word }]; regions: [{ start, end, speakers, busy, out: { [speaker]: words } }].
function reconcile(before, regions, { mode = 'insert', field = 'out' } = {}) {
  let after = before.map((w) => ({ ...w }));
  const inserted = [];
  for (const r of regions) {
    const got = r[field];
    if (!got) continue;
    const inR = (w) => mid(w) >= r.start && mid(w) < r.end;
    const base = after.filter(inR);
    const own = new Map();
    for (const w of base) own.set(w.speaker, (own.get(w.speaker) || 0) + 1);
    const order = [...r.speakers].sort((a, b) => (own.get(b) || 0) - (own.get(a) || 0) || r.busy.findIndex((x) => x[0] === a) - r.busy.findIndex((x) => x[0] === b));
    const dominant = base.length ? order[0] : null;
    let keep = base, add = [];
    if (mode === 'replace') { keep = []; add = order.flatMap((s) => (got[s] || []).filter(inR).map((w) => ({ ...w, speaker: s }))); }
    else add = order.filter((s) => s !== dominant).flatMap((s) => (got[s] || []).filter(inR).map((w) => ({ ...w, speaker: s })));
    const accepted = [];
    for (const w of add) {
      const k = key(w.word);
      if (!k) continue;
      if ([...keep, ...accepted].some((b) => key(b.word) === k && Math.abs(mid(b) - mid(w)) <= DUP_SEC)) continue;
      accepted.push(w);
    }
    if (mode === 'replace') after = after.filter((w) => !inR(w));
    after.push(...accepted);
    inserted.push(...accepted);
  }
  return { after: after.sort((a, b) => a.start - b.start), inserted };
}

// Share of "before" words outside the reference overlap that were added, removed or relabelled.
function nonOverlapChange(refWords, before, after) {
  const reg = overlapRegions(turnsFromWords(refWords));
  const outside = (w) => !reg.some(([a, b]) => mid(w) >= a && mid(w) < b);
  const id = (w) => `${w.start.toFixed(3)}|${w.word}|${w.speaker}`;
  const b = new Map(), a = new Map();
  for (const w of before.filter(outside)) b.set(id(w), (b.get(id(w)) || 0) + 1);
  for (const w of after.filter(outside)) a.set(id(w), (a.get(id(w)) || 0) + 1);
  let changed = 0;
  for (const k of new Set([...b.keys(), ...a.keys()])) changed += Math.abs((b.get(k) || 0) - (a.get(k) || 0));
  const n = [...b.values()].reduce((x, y) => x + y, 0);
  return { words: n, changed, share: n ? changed / n : 0 };
}

// Of the inserted words: the share matching a reference word (same text, midpoints within 1 s) of the reference
// speaker the hypothesis speaker maps to (by the "before" alignment), of another speaker, or of no one.
function attribution(refWords, before, inserted) {
  const ref = normalize(refWords), hyp = normalize(before);
  const { pairs } = align(ref, hyp);
  const co = new Map();
  for (const [i, j] of pairs) { const m = co.get(hyp[j].speaker) || new Map(); m.set(ref[i].speaker, (m.get(ref[i].speaker) || 0) + 1); co.set(hyp[j].speaker, m); }
  const map = new Map([...co].map(([h, m]) => [h, [...m].sort((x, y) => y[1] - x[1])[0][0]]));
  const ins = normalize(inserted);
  let right = 0, wrong = 0, none = 0;
  for (const w of ins) {
    const near = ref.filter((r) => r.word === w.word && Math.abs(mid(r) - mid(w)) <= 1);
    if (!near.length) none++;
    else if (near.some((r) => r.speaker === map.get(w.speaker))) right++;
    else wrong++;
  }
  return { inserted: ins.length, right, wrong, none };
}

const pct = (x) => (x == null ? '  n/a' : (100 * x).toFixed(1).padStart(5));
function summarize(refWords, before, after, extra = {}) {
  const s0 = score(refWords, before), s1 = score(refWords, after);
  const t0 = scoreTime(refWords, before), t1 = scoreTime(refWords, after);
  return {
    before: { wer: s0.wer, wder: s0.wder, cpwer: s0.cpwer, tcpwer: s0.tcpwer, werIn: t0.werInOverlap, werOut: t0.werOutOverlap },
    after: { wer: s1.wer, wder: s1.wder, cpwer: s1.cpwer, tcpwer: s1.tcpwer, werIn: t1.werInOverlap, werOut: t1.werOutOverlap },
    overlapWords: t0.overlapWords, refWords: s0.refWords, ...extra,
  };
}
const line = (label, x) => `${label.padEnd(28)} WER ${pct(x.before.wer)} -> ${pct(x.after.wer)}  inOv ${pct(x.before.werIn)} -> ${pct(x.after.werIn)}  outOv ${pct(x.before.werOut)} -> ${pct(x.after.werOut)}  WDER ${pct(x.before.wder)} -> ${pct(x.after.wder)}  cpWER ${pct(x.before.cpwer)} -> ${pct(x.after.cpwer)}  tcpWER ${pct(x.before.tcpwer)} -> ${pct(x.after.tcpwer)}`;

// ---- meetings ----
async function transcriptCached(name) {
  const f = cacheFile(`asr:${name}`);
  if (!fs.existsSync(f)) throw new Error(`${name}: no cached transcript; run node eval/offline.js --only ${name} first`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
async function diarization(name, ch, pcm) {
  const o = { threshold: 0.6, windowShift: 0.1, threads: THREADS, numSpeakers: 0 };
  const total = pcm.length; // bytes, as in eval/offline.js (the key must match its cache)
  return cached(`dz:${name}:${ch}:0:${total}:${o.threshold}:${o.numSpeakers || 0}:${o.windowShift}`, async () => {
    const { diarize } = require('../src/speakers/diarizer');
    const t0 = Date.now();
    const res = await diarize({ pcm: Buffer.from(pcm), segmentation: models.segmentationPath(), embedding: models.speakerPath(), threads: o.threads, threshold: o.threshold, windowShift: o.windowShift, numSpeakers: o.numSpeakers });
    return { ...res, seconds: (Date.now() - t0) / 1000, samples: total };
  });
}

// Run the extractions of one recording at one precision (cached in .eval/tse/runs).
function extract(name, prec, samples, turns, regions) {
  const file = path.join(OUT, 'runs', `${name}.${prec}${TAG}.json`);
  if (!has('--fresh') && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const speakers = [...new Set(regions.flatMap((r) => r.speakers))];
  const voices = {}, dens = {}, timing = { loadSec: 0, voxSec: 0, asrSec: 0, passSec: 0, windowSec: 0, coreSec: 0 };
  for (const s of speakers) {
    const v = voiceSample(samples, turns, s);
    if (!v) { voices[s] = null; continue; }
    const vf = path.join(OUT, 'voices', `${name}.${s}.wav`);
    writeVoice(vf, v);
    voices[s] = { file: path.relative(ROOT, vf), sec: v.length / RATE };
    const { d, loadSec } = denoiser(prec, vf);
    dens[s] = d; timing.loadSec += loadSec;
  }
  const out = regions.map((r, k) => {
    const a = Math.max(0, r.start - CONTEXT), b = Math.min(samples.length / RATE, r.end + CONTEXT);
    const x = samples.slice(Math.round(a * RATE), Math.round(b * RATE));
    timing.windowSec += b - a; timing.coreSec += r.end - r.start;
    const [pass, ps] = timed(() => recognize(x, a));
    timing.passSec += ps;
    const res = { ...r, window: [a, b], out: {}, pass: {}, stats: {} };
    for (const s of r.speakers) {
      res.pass[s] = pass;
      if (!dens[s]) continue;
      const [y, vs] = timed(() => dens[s].run({ samples: x, sampleRate: RATE }).samples);
      const [ws, as] = timed(() => recognize(y, a));
      timing.voxSec += vs; timing.asrSec += as;
      res.out[s] = ws;
      res.stats[s] = { rmsRatio: rms(y) / Math.max(1e-9, rms(x)), corr: corr(x, y), words: ws.length, passWords: pass.length };
    }
    if (k % 20 === 0) process.stderr.write(`  ${name} ${prec}: region ${k + 1}/${regions.length}\r`);
    return res;
  });
  const run = { name, prec, voices, timing, regions: out };
  fs.writeFileSync(file, JSON.stringify(run));
  return run;
}

// Control (--absent): VoxLock conditioned on a speaker who is NOT among the region's two speakers. A model that follows
// its voice sample should return near silence and few words; one that passes the loudest voice through will not.
async function absent(name, prec, n) {
  const run = JSON.parse(fs.readFileSync(path.join(OUT, 'runs', `${name}.${prec}${TAG}.json`), 'utf8'));
  const rec = JSON.parse(fs.readFileSync(path.join(DATA, name, 'ref.json'), 'utf8'));
  const samples = parseWav(fs.readFileSync(path.join(DATA, name, rec.channels.system))).samples;
  const voiced = Object.entries(run.voices).filter(([, v]) => v).map(([s]) => s);
  const dens = new Map();
  const rows = [];
  for (const r of run.regions.slice(0, n)) {
    const other = voiced.find((s) => !r.speakers.map(String).includes(s));
    if (other == null) continue;
    if (!dens.has(other)) dens.set(other, denoiser(prec, path.join(ROOT, run.voices[other].file)).d);
    const [a, b] = r.window;
    const x = samples.slice(Math.round(a * RATE), Math.round(b * RATE));
    const y = dens.get(other).run({ samples: x, sampleRate: RATE }).samples;
    const ws = recognize(y, a);
    const present = r.speakers.map((s) => r.stats[s]).filter(Boolean);
    rows.push({ rmsRatio: rms(y) / rms(x), corr: corr(x, y), words: ws.length, passWords: r.pass[r.speakers[0]].length, presentRms: present.reduce((m, p) => m + p.rmsRatio, 0) / present.length, presentWords: present.reduce((m, p) => m + p.words, 0) / present.length });
  }
  const avg = (f) => rows.reduce((m, x) => m + f(x), 0) / rows.length;
  const res = { name, prec, regions: rows.length, absent: { rmsRatio: avg((x) => x.rmsRatio), corr: avg((x) => x.corr), words: avg((x) => x.words), empty: avg((x) => (x.words ? 0 : 1)) }, present: { rmsRatio: avg((x) => x.presentRms), words: avg((x) => x.presentWords) }, passWords: avg((x) => x.passWords) };
  console.log(`${name} ${prec} absent-speaker control over ${rows.length} regions: output/input RMS ${res.absent.rmsRatio.toFixed(2)} (present speakers ${res.present.rmsRatio.toFixed(2)}), corr ${res.absent.corr.toFixed(2)}, words ${res.absent.words.toFixed(1)} (present ${res.present.words.toFixed(1)}, unprocessed ${res.passWords.toFixed(1)}), empty ${pct(res.absent.empty)}%`);
  return res;
}

async function meeting(name, precs) {
  const rec = { ...JSON.parse(fs.readFileSync(path.join(DATA, name, 'ref.json'), 'utf8')), dir: path.join(DATA, name) };
  const tr = await transcriptCached(name);
  const pcm = floatToPcm16(parseWav(fs.readFileSync(path.join(rec.dir, rec.channels.system))).samples);
  const samples = pcm16ToFloat(pcm);
  const dz = await diarization(name, 'system', pcm);
  const turns = dz.turns;
  const tl = toTimeline(turns, [{ at: 0, ms: 0 }]);
  const before = [];
  for (const w of tr.words.filter((x) => x.ch === 'mic')) before.push({ ...w, speaker: 'mic' });
  const sys = tr.words.filter((x) => x.ch === 'system');
  const got = assignWords(sys.map((w) => ({ startMs: w.start * 1000, endMs: w.end * 1000 })), tl, { tolerance: 200 });
  sys.forEach((w, i) => before.push({ ...w, speaker: got[i].speaker }));
  before.sort((a, b) => a.start - b.start);
  const regions = regionsOf(turns);
  const coreSec = regions.reduce((n, r) => n + r.end - r.start, 0);
  console.log(`\n${name}: ${(samples.length / RATE / 60).toFixed(1)} min, ${new Set(turns.map((t) => t.speaker)).size} diarized speakers, ${regions.length} overlap regions (${coreSec.toFixed(1)} s)`);
  const results = {};
  for (const prec of precs) {
    const run = extract(name, prec, samples, turns, regions);
    // speaker ids in the scoring: "system:<n>" like eval/offline.js (the mic keeps "mic")
    const lab = (s) => (s === 'mic' ? 'mic' : `system:${s}`);
    const relabel = (ws) => ws.map((w) => ({ ...w, speaker: lab(w.speaker) }));
    const B = relabel(before);
    const variants = {};
    for (const [v, opts] of Object.entries({ insert: { mode: 'insert', field: 'out' }, replace: { mode: 'replace', field: 'out' }, passthrough: { mode: 'insert', field: 'pass' } })) {
      const mic = before.filter((w) => w.speaker === 'mic');
      const { after: sysAfter, inserted } = reconcile(before.filter((w) => w.speaker !== 'mic'), run.regions, opts);
      const after = [...mic, ...sysAfter].sort((a, b) => a.start - b.start);
      const A = relabel(after), I = relabel(inserted);
      variants[v] = summarize(rec.words, B, A, { nonOverlap: nonOverlapChange(rec.words, B, A), attribution: attribution(rec.words, B, I) });
      console.log(line(`  ${prec} ${v}`, variants[v]) + `  +${inserted.length} words, non-overlap changed ${pct(variants[v].nonOverlap.share)}%, inserted right/wrong/none ${variants[v].attribution.right}/${variants[v].attribution.wrong}/${variants[v].attribution.none}`);
    }
    const st = run.regions.flatMap((r) => Object.values(r.stats));
    const avg = (f) => (st.length ? st.reduce((n, x) => n + f(x), 0) / st.length : null);
    const t = run.timing;
    const added = t.loadSec + t.voxSec + t.asrSec;
    const health = { extractions: st.length, meanRmsRatio: avg((x) => x.rmsRatio), meanCorr: avg((x) => x.corr), emptyShare: avg((x) => (x.words === 0 ? 1 : 0)), meanWords: avg((x) => x.words), meanPassWords: avg((x) => x.passWords) };
    console.log(`  ${prec} timing: load ${t.loadSec.toFixed(1)} s, VoxLock ${t.voxSec.toFixed(1)} s, Parakeet on y ${t.asrSec.toFixed(1)} s => added ${added.toFixed(1)} s for ${t.coreSec.toFixed(1)} s overlap (${t.windowSec.toFixed(1)} s windows): ${(added / t.coreSec).toFixed(2)} x overlap, ${(added / t.windowSec).toFixed(2)} x windows; VoxLock RTF ${(t.voxSec / (2 * t.windowSec)).toFixed(2)} per window-second per speaker`);
    console.log(`  ${prec} health: ${health.extractions} extractions, output/input RMS ${health.meanRmsRatio?.toFixed(2)}, corr ${health.meanCorr?.toFixed(2)}, empty ${pct(health.emptyShare)}%, words per extraction ${health.meanWords?.toFixed(1)} (unprocessed window ${health.meanPassWords?.toFixed(1)}); voices ${Object.entries(run.voices).map(([s, v]) => `${s}:${v ? v.sec.toFixed(1) + 's' : 'none'}`).join(' ')}`);
    results[prec] = { variants, timing: { ...t, addedSec: added }, health, voices: run.voices, regions: regions.length };
  }
  return { name, minutes: samples.length / RATE / 60, regions: regions.length, coreSec, results };
}

// ---- synthetic LibriSpeech set ----
function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function trim(x) { // as in eval/prepare.js
  const F = 320;
  let peak = 0;
  const e = [];
  for (let i = 0; i + F <= x.length; i += F) { let s = 0; for (let k = i; k < i + F; k++) s += x[k] * x[k]; e.push(Math.sqrt(s / F)); peak = Math.max(peak, e[e.length - 1]); }
  const on = e.map((v) => v > peak * 0.08);
  const a = Math.max(0, on.indexOf(true) * F - 800), b = Math.min(x.length, (on.lastIndexOf(true) + 1) * F + 800);
  return x.subarray(a, b);
}
const decodeFlac = (f) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1 << 28 }); if (r.status) throw new Error(`ffmpeg ${f}`); return pcm16ToFloat(r.stdout); };
const LIBRI_CALL_READERS = (() => { // eval/prepare.js picks these; keep them out
  try { return new Set(JSON.parse(fs.readFileSync(path.join(DATA, 'libri-call', 'ref.json'), 'utf8')).words.map((w) => w.speaker.replace('libri-', ''))); } catch { return new Set(); }
})();

function buildSynthetic(nPairs) {
  const base = path.join(ROOT, '.eval', 'dl', 'LibriSpeech', 'dev-clean');
  const readers = fs.readdirSync(base).filter((s) => !LIBRI_CALL_READERS.has(s)).sort((a, b) => Number(a) - Number(b));
  const clips = new Map(readers.map((spk) => {
    const list = [];
    for (const chap of fs.readdirSync(path.join(base, spk)).sort()) {
      const dir = path.join(base, spk, chap);
      for (const l of fs.readFileSync(path.join(dir, `${spk}-${chap}.trans.txt`), 'utf8').split('\n').filter(Boolean)) {
        const [id, ...w] = l.split(' ');
        list.push({ id, file: path.join(dir, `${id}.flac`), text: w.join(' ') });
      }
    }
    return [spk, list];
  }));
  const rand = rng(11);
  const take = (spk, min, max) => {
    const list = clips.get(spk);
    while (list.length) {
      const c = list.splice(Math.floor(rand() * list.length), 1)[0];
      const x = trim(decodeFlac(c.file));
      if (x.length >= min * RATE && x.length <= max * RATE) return { ...c, x };
    }
    throw new Error(`no clip for ${spk}`);
  };
  const pairs = [];
  for (let k = 0; k < nPairs; k++) {
    let a, b;
    do { a = readers[Math.floor(rand() * readers.length)]; b = readers[Math.floor(rand() * readers.length)]; } while (a === b);
    pairs.push({ a: take(a, 3, 9), b: take(b, 3, 9), va: take(a, 4, 20), vb: take(b, 4, 20), ov: 0.2 + 0.3 * rand(), spkA: a, spkB: b });
  }
  return pairs;
}

function refWordsOf(text, start, end, speaker) {
  const ws = text.split(' ');
  const chars = ws.reduce((n, w) => n + w.length + 1, 0);
  let pos = 0;
  return ws.map((w) => { const s = start + (pos / chars) * (end - start); pos += w.length + 1; return { speaker, start: s, end: start + (pos / chars) * (end - start), word: w }; });
}

async function synthetic(precs, nPairs) {
  const t0 = Date.now();
  const pairs = buildSynthetic(nPairs);
  console.log(`synthetic: ${pairs.length} pairs built in ${((Date.now() - t0) / 1000).toFixed(0)} s (readers ${[...new Set(pairs.flatMap((p) => [p.spkA, p.spkB]))].length})`);
  const SIRS = [0, 5, -5];
  const SLOT = 60; // seconds per mixture on the common time line
  const res = {};
  for (const prec of precs) {
    const file = path.join(OUT, 'runs', `synthetic.${nPairs}.${prec}${TAG}.json`);
    let mixes;
    if (!has('--fresh') && fs.existsSync(file)) mixes = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      mixes = [];
      const voiceFiles = new Map();
      for (const [k, p] of pairs.entries()) for (const [spk, v] of [[p.spkA, p.va], [p.spkB, p.vb]]) {
        const f = path.join(OUT, 'voices', `synthetic.${k}.${spk}.wav`);
        writeVoice(f, v.x.subarray(0, VOICE_MAX * RATE));
        voiceFiles.set(`${k}:${spk}`, f);
      }
      let slot = 0;
      for (const [k, p] of pairs.entries()) {
        const dA = denoiser(prec, voiceFiles.get(`${k}:${p.spkA}`)), dB = denoiser(prec, voiceFiles.get(`${k}:${p.spkB}`));
        const la = p.a.x.length, lb = p.b.x.length;
        const ovS = Math.round(p.ov * Math.min(la, lb));
        const bAt = la - ovS;
        const n = Math.max(la, bAt + lb);
        for (const sir of SIRS) {
          const g = (rms(p.a.x) / rms(p.b.x)) * Math.pow(10, sir / 20); // second talker at `sir` dB relative to the first
          const m = new Float32Array(n);
          for (let i = 0; i < la; i++) m[i] += p.a.x[i];
          for (let i = 0; i < lb; i++) m[bAt + i] += g * p.b.x[i];
          let peak = 0; for (const v of m) peak = Math.max(peak, Math.abs(v));
          if (peak > 0.99) for (let i = 0; i < n; i++) m[i] *= 0.99 / peak;
          const off = slot * SLOT; slot++;
          const turnA = { start: 0, end: la / RATE, speaker: p.spkA }, turnB = { start: bAt / RATE, end: (bAt + lb) / RATE, speaker: p.spkB };
          const region = { start: bAt / RATE, end: la / RATE, speakers: [p.spkA, p.spkB], busy: [[p.spkA, 1], [p.spkB, 1]] };
          const win = [Math.max(0, region.start - CONTEXT), Math.min(n / RATE, region.end + CONTEXT)];
          const x = m.slice(Math.round(win[0] * RATE), Math.round(win[1] * RATE));
          const mixWords = recognize(m, 0);
          const [yA, vsA] = timed(() => dA.d.run({ samples: x, sampleRate: RATE }).samples);
          const [yB, vsB] = timed(() => dB.d.run({ samples: x, sampleRate: RATE }).samples);
          const [wA, asA] = timed(() => recognize(yA, win[0]));
          const [wB, asB] = timed(() => recognize(yB, win[0]));
          // whole-mixture extraction: how well each talker is recovered at all, regardless of the reconcile
          const fullA = recognize(dA.d.run({ samples: m, sampleRate: RATE }).samples, 0);
          const fullB = recognize(dB.d.run({ samples: m, sampleRate: RATE }).samples, 0);
          const cleanA = sir === 0 ? recognize(p.a.x, 0) : null, cleanB = sir === 0 ? recognize(p.b.x, 0) : null;
          mixes.push({
            k, sir, off, ov: p.ov, overlapSec: (la - bAt) / RATE, windowSec: win[1] - win[0], spkA: p.spkA, spkB: p.spkB,
            ref: [...refWordsOf(p.a.text, turnA.start, turnA.end, p.spkA), ...refWordsOf(p.b.text, turnB.start, turnB.end, p.spkB)],
            turns: [turnA, turnB], region, mixWords, out: { [p.spkA]: wA, [p.spkB]: wB }, fullA, fullB, cleanA, cleanB,
            textA: p.a.text, textB: p.b.text,
            timing: { loadSec: (dA.loadSec + dB.loadSec) / SIRS.length, voxSec: vsA + vsB, asrSec: asA + asB },
          });
        }
        process.stderr.write(`  synthetic ${prec}: pair ${k + 1}/${pairs.length}\r`);
      }
      fs.writeFileSync(file, JSON.stringify(mixes));
    }
    res[prec] = scoreSynthetic(mixes, prec);
  }
  return res;
}

function scoreSynthetic(mixes, prec) {
  const out = {};
  const wer1 = (refText, hypWords) => { const r = normalize(refText.split(' ').map((w, i) => ({ speaker: 'x', start: i, end: i + 1, word: w }))), h = normalize(hypWords.map((w, i) => ({ ...w, speaker: 'x' }))); return { errors: align(r, h).errors, words: r.length }; };
  for (const sir of ['all', 0, 5, -5]) {
    const ms = mixes.filter((m) => sir === 'all' || m.sir === sir);
    const ref = [], before = [], regions = [];
    for (const m of ms) {
      const sh = (w) => ({ ...w, start: w.start + m.off, end: w.end + m.off });
      ref.push(...m.ref.map(sh));
      const tl = toTimeline(m.turns, [{ at: 0, ms: 0 }]);
      const got = assignWords(m.mixWords.map((w) => ({ startMs: w.start * 1000, endMs: w.end * 1000 })), tl, { tolerance: 200 });
      m.mixWords.forEach((w, i) => before.push(sh({ ...w, speaker: got[i].speaker })));
      regions.push({ ...m.region, start: m.region.start + m.off, end: m.region.end + m.off, out: Object.fromEntries(Object.entries(m.out).map(([s, ws]) => [s, ws.map(sh)])) });
    }
    before.sort((a, b) => a.start - b.start);
    const variants = {};
    for (const mode of ['insert', 'replace']) {
      const { after, inserted } = reconcile(before, regions, { mode });
      variants[mode] = summarize(ref, before, after, { nonOverlap: nonOverlapChange(ref, before, after), attribution: attribution(ref, before, inserted), inserted: inserted.length });
      console.log(line(`  synth ${prec} SIR ${String(sir).padStart(3)} ${mode}`, variants[mode]) + `  +${inserted.length} words, inserted right/wrong/none ${variants[mode].attribution.right}/${variants[mode].attribution.wrong}/${variants[mode].attribution.none}`);
    }
    // per-talker recovery over the whole mixture: first talker A, second talker B
    const acc = (f) => ms.reduce((o, m) => { const r = f(m); o.errors += r.errors; o.words += r.words; return o; }, { errors: 0, words: 0 });
    const tse = { A: acc((m) => wer1(m.textA, m.fullA)), B: acc((m) => wer1(m.textB, m.fullB)) };
    const clean = { A: acc((m) => (m.cleanA ? wer1(m.textA, m.cleanA) : { errors: 0, words: 0 })), B: acc((m) => (m.cleanB ? wer1(m.textB, m.cleanB) : { errors: 0, words: 0 })) };
    const t = ms.reduce((o, m) => { o.load += m.timing.loadSec; o.vox += m.timing.voxSec; o.asr += m.timing.asrSec; o.ov += m.overlapSec; o.win += m.windowSec; return o; }, { load: 0, vox: 0, asr: 0, ov: 0, win: 0 });
    const r = (x) => (x.words ? x.errors / x.words : null);
    console.log(`  synth ${prec} SIR ${String(sir).padStart(3)} whole-mixture TSE WER: first talker ${pct(r(tse.A))}, second talker ${pct(r(tse.B))} (clean utterance: ${pct(r(clean.A))} / ${pct(r(clean.B))}); added ${(t.load + t.vox + t.asr).toFixed(1)} s for ${t.ov.toFixed(1)} s overlap (${((t.load + t.vox + t.asr) / t.ov).toFixed(2)} x; ${((t.load + t.vox + t.asr) / t.win).toFixed(2)} x windows), VoxLock RTF ${(t.vox / (2 * t.win)).toFixed(2)}`);
    out[sir] = { mixtures: ms.length, variants, tseWer: { A: r(tse.A), B: r(tse.B) }, cleanWer: { A: r(clean.A), B: r(clean.B) }, timing: t };
  }
  return out;
}

(async () => {
  const precs = opt('--prec', 'int8,fp32').split(',').filter((p) => PREC[p]);
  const summary = { date: new Date().toISOString(), threads: THREADS, precs };
  if (has('--absent')) {
    const only = opt('--only', '').split(',').filter(Boolean);
    summary.absent = [];
    for (const name of only) for (const prec of precs) summary.absent.push(await absent(name, prec, Number(opt('--regions', 40))));
    fs.writeFileSync(path.join(OUT, `absent.${only.join('+')}${TAG}.json`), JSON.stringify(summary, null, 1));
  } else if (has('--synthetic')) {
    summary.synthetic = await synthetic(precs, Number(opt('--pairs', 30)));
    fs.writeFileSync(path.join(OUT, `synthetic${TAG}.json`), JSON.stringify(summary, null, 1));
  } else {
    const only = opt('--only', '').split(',').filter(Boolean);
    const names = fs.readdirSync(DATA).filter((n) => (!only.length || only.includes(n)) && fs.existsSync(path.join(DATA, n, 'ref.json'))).sort();
    summary.meetings = [];
    for (const name of names) {
      try { summary.meetings.push(await meeting(name, precs)); } catch (e) { console.warn(`${name}: ${e.message}`); }
      fs.writeFileSync(path.join(OUT, `meetings${only.length ? '.' + only.join('+') : ''}${TAG}.json`), JSON.stringify(summary, null, 1));
    }
  }
  if (recognizer) recognizer = null;
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
