#!/usr/bin/env node
'use strict';
// Speaker-attribution harness: plays each recording in .eval/data (see prepare.js) through the real recording
// pipeline (RecordingManager -> ASR worker -> transcript store -> the after-Stop speaker passes), then scores the
// stored words and speakers against the reference with WDER, cpWER and tcpWER (metrics.js).
//
//   node eval/run.js [--only ami-IS1009a] [--configs online,refine,diarize] [--meeteval path/to/meeteval-wer]
//                    [--threshold 0.5] [--window-shift 0.1]   (diarization clustering threshold, segmentation hop)
//                    [--dump DIR]   (also write each run's final words to DIR/<recording>.<config>.json, for eval/overlap.js)
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
const { byFile: byVoiceModelFile } = require('../src/speakers/voice-models');
const { Models } = require('../src/asr/models');
const { AsrEngine } = require('../src/asr/engine');
const { RecordingManager } = require('../src/recording/manager');
const { parseWav, floatToPcm16 } = require('../src/audio/pcm');
const { score, scoreTime, normalize, toSegLst } = require('./metrics');

// CPU seconds used so far by this process and by its finished child processes (the diarization workers), from
// /proc/self/stat (Linux; elsewhere null).
function cpuSeconds() {
  try {
    const f = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
    const [ut, st, cut, cst] = [11, 12, 13, 14].map((i) => Number(f[i]) / 100);
    return { self: ut + st, children: cut + cst };
  } catch { return null; }
}

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.eval', 'data');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// Settings per configuration. "online" is the live pass alone; the others add the after-Stop passes.
const CONFIGS = {
  online: { speakerRefine: false, speakerDiarize: false },
  refine: { speakerRefine: true, speakerDiarize: false },             // MFCC/F0 split, merge, reassign
  diarize: { speakerRefine: false, speakerDiarize: true, speakerPipeline: 'sherpa' },            // pyannote segmentation + global clustering, per word
  'diarize+refine': { speakerRefine: true, speakerDiarize: true, speakerPipeline: 'sherpa' },
  owned: { speakerRefine: false, speakerDiarize: true, speakerPipeline: 'owned' },          // WhisperBrain's own pipeline, windows computed while recording
  'owned+refine': { speakerRefine: true, speakerDiarize: true, speakerPipeline: 'owned' },
};

async function play(rec, config, engine, models) {
  const db = open(':memory:');
  const bus = new Bus();
  const warnings = [];
  bus.subscribe((e) => { if (e.type === 'recording.warning') warnings.push(e.data.message); });
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  const voiceModel = byVoiceModelFile(models.speakerPath()); // the voice model in use tags and judges the prints (same as the app)
  if (voiceModel) speakers.useModel(voiceModel);
  settings.update(Object.fromEntries(Object.entries({ asrModel: 'parakeet-tdt-0.6b-v3', echoDedupe: false, speakerCountHint: opt('--attendees', 0) > 0, ...(opt('--same') ? { speakerThreshold: Number(opt('--same')) } : {}), ...config }).filter(([k]) => k in DEFAULTS)));
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
  // The audio arrives here much faster than in a real meeting. The owned pipeline's live worker computes windows while a
  // meeting runs, so let it catch up first (what a real-time recording would have given it); the time it takes is reported
  // as live work, not as Stop time.
  let liveSeconds = 0;
  const live = Object.values(mgr.active?.live || {}).filter(Boolean);
  if (live.length) {
    const t1 = Date.now();
    const target = Math.max(...Object.values(pcm).map((p) => p.length)) / 16000 - 10;
    let last = -1, still = 0;
    while (live.some((l) => l.progress.seconds < target) && still < 60) {
      await new Promise((r) => setTimeout(r, 500));
      const now = live.reduce((a, l) => a + l.progress.windows, 0);
      still = now === last ? still + 1 : 0; last = now;
    }
    liveSeconds = (Date.now() - t1) / 1000;
  }
  let tStop = 0;
  const stages = [];
  bus.subscribe((e) => { if (e.type === 'recording.finalizing') { stages.push([e.data.stage, Date.now()]); } });
  const tPlayed = Date.now(), cpuPlayed = cpuSeconds();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);
  const done = mgr.stop().then((r) => { tStop = Date.now(); return r; });
  await done;
  clearInterval(sampler);
  const cpuEnd = cpuSeconds();
  const speakerStage = stages.find(([s]) => s === 'speakers');
  // how long each after-Stop stage took (a stage lasts until the next one starts, the last one until stop() returns)
  const stageSeconds = {};
  stages.forEach(([name, at], k) => { stageSeconds[name] = ((k + 1 < stages.length ? stages[k + 1][1] : tStop) - at) / 1000; });
  const words = [];
  for (const s of notes.segmentWords(note.id)) {
    const who = s.speakerId || s.speaker;
    if (s.words?.length) for (const [w, a, b] of s.words) words.push({ speaker: who, start: (s.startMs + a) / 1000, end: (s.startMs + b) / 1000, word: w });
    else words.push({ speaker: who, start: s.startMs / 1000, end: s.endMs / 1000, word: s.text });
  }
  fs.rmSync(spoolDir, { recursive: true, force: true });
  const resources = cpuEnd && cpuPlayed ? { stopCpuSeconds: (cpuEnd.self + cpuEnd.children) - (cpuPlayed.self + cpuPlayed.children), peakRssMB: Math.round(peakRss / 1048576) } : { peakRssMB: Math.round(peakRss / 1048576) };
  return { words, warnings, seconds: { live: liveSeconds, total: (tStop - t0) / 1000, stop: (tStop - tPlayed) / 1000, speakers: speakerStage ? (tStop - speakerStage[1]) / 1000 : 0, stages: stageSeconds }, resources };
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
  if (opt('--embedding')) { const f = path.resolve(opt('--embedding')); models.speakerPath = () => f; } // embedding bake-off: another voice model, live and after Stop
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
        const t = scoreTime(rec.words, r.words);
        const me = bin ? meeteval(bin, rec.words, r.words, name) : null;
        results.push({ recording: name, config: c, ...s, time: t, meeteval: me, seconds: r.seconds, resources: r.resources, warnings: r.warnings });
        if (opt('--dump')) { fs.mkdirSync(opt('--dump'), { recursive: true }); fs.writeFileSync(path.join(opt('--dump'), `${name}.${c}.json`), JSON.stringify(r.words)); }
        console.log(`${name.padEnd(14)} ${c.padEnd(15)} WER ${pct(s.wer)} (in overlap ${pct(t.werInOverlap)}, outside ${pct(t.werOutOverlap)})  WDER ${pct(s.wder)}  cpWER ${pct(s.cpwer)}  tcpWER ${pct(s.tcpwer)}  DER ${pct(t.der)}  JER ${pct(t.jer)}  overlap P/R ${pct(t.overlap.precision)}/${pct(t.overlap.recall)}  speakers ${s.hypSpeakers}/${s.refSpeakers}`
          + (me ? `  [meeteval cpWER ${pct(me.cpwer)} tcpWER ${pct(me.tcpwer)}]` : '') + `  (${r.seconds.total.toFixed(0)} s,${r.seconds.live ? ` live catch-up ${r.seconds.live.toFixed(0)} s,` : ''} after Stop ${r.seconds.stop.toFixed(1)} s, speaker pass ${r.seconds.speakers.toFixed(1)} s, ${r.resources.stopCpuSeconds != null ? `${r.resources.stopCpuSeconds.toFixed(0)} CPU-s after Stop, ` : ''}peak RSS ${r.resources.peakRssMB} MB)`
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
