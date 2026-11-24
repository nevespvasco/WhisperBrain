#!/usr/bin/env node
'use strict';
// Fast experiments on speaker grouping. The slow parts of eval/run.js (speech recognition, the diarization model) are
// cached under .eval/cache, so a different way of grouping speakers is scored in seconds. Only the clustering and the
// word-to-speaker assignment are exercised; the stored-transcript machinery and the acoustic refine pass are not
// (use eval/run.js for the final numbers).
//
//   node eval/offline.js --only ami-IS1009a --strategy full --threshold 0.6
//   node eval/offline.js --strategy pieces --piece 240 --merge 0.5 --speakers 3
//
// Strategies: full (one diarization over the whole channel, what runs after Stop today) and pieces (diarize finished
// pieces on their own, then merge their voices: src/speakers/chunked.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings, DEFAULTS } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { Models } = require('../src/asr/models');
const { AsrEngine } = require('../src/asr/engine');
const { RecordingManager } = require('../src/recording/manager');
const { parseWav, floatToPcm16 } = require('../src/audio/pcm');
const { diarize } = require('../src/speakers/diarizer');
const { assignWords, toTimeline } = require('../src/speakers/diarize');
const { planPieces, mergeVoices } = require('./pieces');
const { foldStarved } = require('../src/speakers/final');
const regroup = require('./regroup');
const { score } = require('./metrics');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.eval', 'data');
const CACHE = path.join(ROOT, '.eval', 'cache');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const num = (k, d) => Number(opt(k, d));
const models = new Models(process.env.WB_MODELS_DIR || path.join(ROOT, '.models'));
fs.mkdirSync(CACHE, { recursive: true });
const cached = async (key, make) => {
  const f = path.join(CACHE, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = await make();
  fs.writeFileSync(f, JSON.stringify(v));
  return v;
};

// The recognized words and utterances of a recording, from the real recording pipeline (live labels off).
async function transcript(name, rec) {
  return cached(`asr:${name}`, async () => {
    const engine = new AsrEngine({ speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
    try {
      const db = open(':memory:');
      const bus = new Bus();
      const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
      settings.update(Object.fromEntries(Object.entries({ asrModel: 'parakeet-tdt-0.6b-v3', echoDedupe: false, speakerRefine: false, speakerDiarize: false }).filter(([k]) => k in DEFAULTS)));
      const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir: null });
      const note = notes.create({});
      const pcm = Object.fromEntries(Object.entries(rec.channels).map(([ch, f]) => [ch, floatToPcm16(parseWav(fs.readFileSync(path.join(rec.dir, f))).samples)]));
      await mgr.start(note.id, { mic: !!pcm.mic, system: !!pcm.system });
      const len = Math.max(...Object.values(pcm).map((p) => p.length));
      for (let i = 0; i < len; i += 3200) {
        for (const [ch, p] of Object.entries(pcm)) if (i < p.length) mgr.pushPcm(note.id, ch, p.subarray(i, i + 3200));
        if ((i / 3200) % 50 === 49) await new Promise((r) => setImmediate(r));
      }
      for (const ch of Object.keys(pcm)) mgr.pushPcm(note.id, ch, Buffer.alloc(32000));
      await mgr.stop();
      const words = [], utterances = [];
      for (const s of notes.segmentWords(note.id)) {
        const ch = s.speaker === 'me' ? 'mic' : 'system';
        utterances.push({ ch, from: Math.round(s.startMs * 16), to: Math.round(s.endMs * 16) });
        if (s.words?.length) for (const [w, a, b] of s.words) words.push({ ch, start: (s.startMs + a) / 1000, end: (s.startMs + b) / 1000, word: w });
        else words.push({ ch, start: s.startMs / 1000, end: s.endMs / 1000, word: s.text });
      }
      return { words, utterances };
    } finally { engine.stop(); }
  });
}

const channelPcm = (rec, ch) => floatToPcm16(parseWav(fs.readFileSync(path.join(rec.dir, rec.channels[ch]))).samples);

async function runWorker(name, ch, pcm, from, to, o) {
  const key = `dz:${name}:${ch}:${from}:${to}:${o.threshold}:${o.numSpeakers || 0}:${o.windowShift}`;
  return cached(key, async () => {
    const t0 = Date.now();
    const res = await diarize({ pcm: Buffer.from(pcm.subarray(from * 2, to * 2)), segmentation: models.segmentationPath(), embedding: models.speakerPath(), threads: o.threads, threshold: o.threshold, windowShift: o.windowShift, numSpeakers: o.numSpeakers });
    return { ...res, seconds: (Date.now() - t0) / 1000, samples: to - from };
  });
}

// A voice print for each turn of at least `minSec`, from the model that runs inside the app.
async function turnPrints(name, ch, pcm, turns, tag, minSec) {
  return cached(`tp:${name}:${ch}:${tag}:${minSec}`, async () => {
    const sherpa = require('sherpa-onnx-node');
    const ex = new sherpa.SpeakerEmbeddingExtractor({ model: models.speakerPath(), numThreads: 4, provider: 'cpu', debug: 0 });
    const out = [];
    turns.forEach((t, i) => {
      if (t.end - t.start < minSec) return;
      const a = Math.round(t.start * 16000), b = Math.min(pcm.length, Math.round(t.end * 16000));
      const f = new Float32Array(b - a);
      for (let k = 0; k < f.length; k++) f[k] = pcm[a + k] / 32768;
      const st = ex.createStream();
      st.acceptWaveform({ samples: f, sampleRate: 16000 });
      st.inputFinished();
      if (ex.isReady(st)) out.push({ i, v: Array.from(ex.compute(st, false)) });
    });
    return out;
  });
}

(async () => {
  const strategy = opt('--strategy', 'full');
  const o = { threshold: num('--threshold', 0.6), windowShift: num('--window-shift', 0.1), threads: num('--threads', 8), numSpeakers: num('--speakers', 0) };
  const only = opt('--only', '').split(',').filter(Boolean);
  const names = fs.readdirSync(DATA).filter((n) => !only.length || only.includes(n)).sort();
  for (const name of names) {
    const rec = { ...JSON.parse(fs.readFileSync(path.join(DATA, name, 'ref.json'), 'utf8')), dir: path.join(DATA, name) };
    const tr = await transcript(name, rec);
    const hyp = [];
    let stopSeconds = 0, totalSeconds = 0, found = 0;
    for (const ch of Object.keys(rec.channels)) {
      const words = tr.words.filter((w) => w.ch === ch);
      if (ch === 'mic') { for (const w of words) hyp.push({ ...w, speaker: 'mic' }); continue; }
      const pcm = channelPcm(rec, ch);
      const total = pcm.length;
      let turns = [], speakers = new Set();
      if (strategy === 'full') {
        const r = await runWorker(name, ch, pcm, 0, total, o);
        stopSeconds += r.seconds; totalSeconds += r.seconds;
        turns = r.turns;
      } else if (strategy === 'regroup') {
        const base = num('--base-threshold', 0.4);
        const r = await runWorker(name, ch, pcm, 0, total, { ...o, threshold: base, numSpeakers: 0 });
        const minSec = num('--min-turn', 1);
        const tp = await turnPrints(name, ch, pcm, r.turns, base, minSec);
        let pts = tp.map((x) => Float64Array.from(x.v));
        if (opt('--center', '1') === '1') { // the meeting's average print is the channel's colour, shared by every voice on it
          const mean = new Float64Array(pts[0].length);
          for (const p of pts) { const n = Math.hypot(...p); p.forEach((v, d) => { mean[d] += v / n / pts.length; }); }
          pts = pts.map((p) => { const n = Math.hypot(...p); return Float64Array.from(p, (v, d) => v / n - mean[d]); });
        }
        const wts = tp.map((x) => r.turns[x.i].end - r.turns[x.i].start);
        const initIds = [...new Set(tp.map((x) => r.turns[x.i].speaker))];
        const init = Int32Array.from(tp, (x) => initIds.indexOf(r.turns[x.i].speaker));
        const method = opt('--method', 'ahc');
        let lab;
        if (method === 'init') lab = init; // sanity check: sherpa's own labels through the same code path
        else if (method === 'ahc') lab = regroup.ahc(pts, wts, { threshold: num('--merge', 0.5) });
        else if (method === 'spectral') lab = regroup.spectral(pts, wts, { keep: num('--keep', 0.2), k: o.numSpeakers });
        else lab = regroup.vb(pts, wts, init, { dim: num('--dim', 24), Fa: num('--fa', 0.4), Fb: num('--fb', 1), prune: num('--prune', 0.03) });
        // every sherpa speaker takes the group most of its long turns went to; the short turns follow their speaker
        const votes = new Map();
        tp.forEach((x, k) => { const sp = r.turns[x.i].speaker; const m = votes.get(sp) || new Map(); m.set(lab[k], (m.get(lab[k]) || 0) + wts[k]); votes.set(sp, m); });
        const group = new Map([...votes].map(([sp, m]) => [sp, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
        const direct = new Map(tp.map((x, k) => [x.i, lab[k]]));
        turns = r.turns.map((t, i) => ({ ...t, speaker: direct.has(i) ? direct.get(i) : (group.get(t.speaker) ?? 0) }));
        totalSeconds += r.seconds; stopSeconds += r.seconds;
      } else {
        const pieces = planPieces(tr.utterances.filter((u) => u.ch === ch), total, { targetSec: num('--piece', 240) });
        const voices = [], all = [];
        for (const [k, [from, to]] of pieces.entries()) {
          let r = await runWorker(name, ch, pcm, from, to, { ...o, numSpeakers: 0 });
          if (opt('--fold')) r = foldStarved(r, { minShare: 0.03, minSeconds: num('--fold', 3) });
          totalSeconds += r.seconds; if (k === pieces.length - 1) stopSeconds += r.seconds;
          for (const v of r.voices) voices.push({ key: `${k}:${v.speaker}`, piece: k, centroid: v.centroid, ms: v.ms, pitch: v.pitch, first: from / 16 + 0 });
          for (const t of r.turns) all.push({ start: t.start + from / 16000, end: t.end + from / 16000, key: `${k}:${t.speaker}` });
        }
        const map = mergeVoices(voices, { threshold: num('--merge', 0.5), target: o.numSpeakers });
        turns = all.map((t) => ({ start: t.start, end: t.end, speaker: map.get(t.key) ?? 0 }));
      }
      const tl = toTimeline(turns, [{ at: 0, ms: 0 }]);
      speakers = new Set(tl.map((t) => t.speaker));
      found += speakers.size;
      const got = assignWords(words.map((w) => ({ startMs: w.start * 1000, endMs: w.end * 1000 })), tl, { tolerance: 200 });
      words.forEach((w, i) => hyp.push({ ...w, speaker: `${ch}:${got[i].speaker}` }));
    }
    const s = score(rec.words, hyp);
    console.log(`${name.padEnd(14)} ${strategy.padEnd(6)} WDER ${(100 * s.wder).toFixed(1).padStart(5)}  cpWER ${(100 * s.cpwer).toFixed(1).padStart(5)}  speakers ${s.hypSpeakers}/${s.refSpeakers}  diarization ${totalSeconds.toFixed(0)} s total, ${stopSeconds.toFixed(0)} s left for Stop`);
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
