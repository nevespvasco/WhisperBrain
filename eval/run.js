#!/usr/bin/env node
'use strict';
// Speaker-attribution harness: plays each recording in .eval/data (see prepare.js) through the real recording
// pipeline (RecordingManager -> ASR worker -> transcript store -> the after-Stop speaker passes), then scores the
// stored words and speakers against the reference with WDER, cpWER and tcpWER (metrics.js).
//
//   node eval/run.js [--only ami-IS1009a] [--configs online,refine,diarize] [--meeteval path/to/meeteval-wer]
//                    [--threshold 0.5] [--window-shift 0.1]   (diarization clustering threshold, segmentation hop)
//
// Models come from $WB_MODELS_DIR or ./.models (speech model, VAD, voice model, segmentation model). Results are
// printed and saved to .eval/results/<time>.json; with --meeteval, cpWER/tcpWER are also computed by meeteval itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings, DEFAULTS } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { Models } = require('../src/asr/models');
const { AsrEngine } = require('../src/asr/engine');
const { RecordingManager } = require('../src/recording/manager');
const { parseWav, floatToPcm16 } = require('../src/audio/pcm');
const { score, normalize, toSegLst } = require('./metrics');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.eval', 'data');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// Settings per configuration. "online" is the live pass alone; the others add the after-Stop passes.
const CONFIGS = {
  online: { speakerRefine: false, speakerDiarize: false },
  refine: { speakerRefine: true, speakerDiarize: false },             // MFCC/F0 split, merge, reassign
  diarize: { speakerRefine: false, speakerDiarize: true },            // pyannote segmentation + global clustering, per word
  'diarize+refine': { speakerRefine: true, speakerDiarize: true },
};

async function play(rec, config, engine, models) {
  const db = open(':memory:');
  const bus = new Bus();
  const warnings = [];
  bus.subscribe((e) => { if (e.type === 'recording.warning') warnings.push(e.data.message); });
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update(Object.fromEntries(Object.entries({ asrModel: 'parakeet-tdt-0.6b-v3', echoDedupe: false, speakerCountHint: opt('--attendees', 0) > 0, ...config }).filter(([k]) => k in DEFAULTS)));
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-eval-'));
  const diarization = {};
  if (opt('--threshold')) diarization.threshold = Number(opt('--threshold'));
  if (opt('--window-shift')) diarization.windowShift = Number(opt('--window-shift'));
  if (opt('--speakers')) diarization.numSpeakers = Number(opt('--speakers'));
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization });
  const note = notes.create({ attendees: Array.from({ length: Number(opt('--attendees', 0)) }, (_, i) => ({ name: `Person ${i + 1}`, email: `p${i + 1}@example.com`, status: 'ACCEPTED' })) });
  const pcm = Object.fromEntries(Object.entries(rec.channels).map(([ch, f]) => [ch, floatToPcm16(parseWav(fs.readFileSync(path.join(rec.dir, f))).samples)]));
  await mgr.start(note.id, { mic: !!pcm.mic, system: !!pcm.system });
  const t0 = Date.now();
  const CHUNK = 3200; // 100 ms, the channels interleaved as they would arrive live
  const len = Math.max(...Object.values(pcm).map((p) => p.length));
  for (let i = 0; i < len; i += CHUNK) {
    for (const [ch, p] of Object.entries(pcm)) if (i < p.length) mgr.pushPcm(note.id, ch, p.subarray(i, i + CHUNK));
    if ((i / CHUNK) % 50 === 49) await new Promise((r) => setImmediate(r));
  }
  for (const ch of Object.keys(pcm)) mgr.pushPcm(note.id, ch, Buffer.alloc(32000)); // let the VAD close the last utterance
  let tStop = 0;
  const stages = [];
  bus.subscribe((e) => { if (e.type === 'recording.finalizing') { stages.push([e.data.stage, Date.now()]); } });
  const done = mgr.stop().then((r) => { tStop = Date.now(); return r; });
  await done;
  const speakerStage = stages.find(([s]) => s === 'speakers');
  const words = [];
  for (const s of notes.segmentWords(note.id)) {
    const who = s.speakerId || s.speaker;
    if (s.words?.length) for (const [w, a, b] of s.words) words.push({ speaker: who, start: (s.startMs + a) / 1000, end: (s.startMs + b) / 1000, word: w });
    else words.push({ speaker: who, start: s.startMs / 1000, end: s.endMs / 1000, word: s.text });
  }
  fs.rmSync(spoolDir, { recursive: true, force: true });
  return { words, warnings, seconds: { total: (tStop - t0) / 1000, speakers: speakerStage ? (tStop - speakerStage[1]) / 1000 : 0 } };
}

function meeteval(bin, ref, hyp, session) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-meeteval-'));
  fs.writeFileSync(path.join(dir, 'ref.json'), JSON.stringify(toSegLst(normalize(ref), session)));
  fs.writeFileSync(path.join(dir, 'hyp.json'), JSON.stringify(toSegLst(normalize(hyp), session)));
  const out = {};
  for (const [name, extra] of [['cpwer', []], ['tcpwer', ['--collar', '5']]]) {
    const r = spawnSync(bin, [name, '-r', 'ref.json', '-h', 'hyp.json', ...extra], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) { out[name] = `error: ${(r.stderr || '').trim().split('\n').pop()}`; continue; }
    const avg = JSON.parse(fs.readFileSync(path.join(dir, `hyp_${name}.json`), 'utf8'));
    out[name] = avg.error_rate;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const pct = (x) => (x === null || x === undefined ? '  n/a' : typeof x === 'string' ? x : (100 * x).toFixed(1).padStart(5));

(async () => {
  const modelsDir = process.env.WB_MODELS_DIR || path.join(ROOT, '.models');
  const models = new Models(modelsDir);
  const only = opt('--only', '').split(',').filter(Boolean);
  const configs = opt('--configs', Object.keys(CONFIGS).join(',')).split(',');
  const bin = opt('--meeteval', null);
  const recs = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((n) => !only.length || only.includes(n)).sort() : [];
  if (!recs.length) throw new Error('no recordings: run node eval/prepare.js first');
  const engine = new AsrEngine({ speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
  const results = [];
  try {
    for (const name of recs) {
      const rec = { ...JSON.parse(fs.readFileSync(path.join(DATA, name, 'ref.json'), 'utf8')), dir: path.join(DATA, name) };
      for (const c of configs) {
        if (!CONFIGS[c]) throw new Error(`unknown config ${c}`);
        const r = await play(rec, CONFIGS[c], engine, models);
        const s = score(rec.words, r.words);
        const me = bin ? meeteval(bin, rec.words, r.words, name) : null;
        results.push({ recording: name, config: c, ...s, meeteval: me, seconds: r.seconds, warnings: r.warnings });
        console.log(`${name.padEnd(14)} ${c.padEnd(15)} WER ${pct(s.wer)}  WDER ${pct(s.wder)}  cpWER ${pct(s.cpwer)}  tcpWER ${pct(s.tcpwer)}  speakers ${s.hypSpeakers}/${s.refSpeakers}`
          + (me ? `  [meeteval cpWER ${pct(me.cpwer)} tcpWER ${pct(me.tcpwer)}]` : '') + `  (${r.seconds.total.toFixed(0)} s, speaker pass ${r.seconds.speakers.toFixed(1)} s)`
          + (r.warnings.length ? `  warnings: ${r.warnings.join('; ')}` : ''));
      }
    }
  } finally { engine.stop(); }
  const out = path.join(ROOT, '.eval', 'results');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 1));
  console.log(`saved ${path.relative(ROOT, file)}`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
