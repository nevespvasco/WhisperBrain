#!/usr/bin/env node
'use strict';
// Measures live draft captions on real audio, in real time, through the same AsrEngine the recording uses.
//   node scripts/bench-live-draft.js [--draft on|off|both] [--channels 1|2] [--dir MODELS_DIR] [--clips DIR] [--json]
// Streams utterances (the speech-model test clips, a few seconds each, with 1.3 s pauses, plus one long run of speech
// with no pause) into the live channels at the pace of the clock and reports, per utterance:
//   first word   how long after speech started the first draft word appeared
//   final        how long after speech ended the final text appeared (what captions cost without drafts)
//   draft WER    word error rate of the last draft against the final text (how far the draft is from what is saved)
// and for the whole run the live worker's CPU (cores busy on average) and resident memory.
const fs = require('node:fs');
const path = require('node:path');
const { AsrEngine } = require('../src/asr/engine');
const { Models } = require('../src/asr/models');
const { decodeAudio } = require('../src/recording/import');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dir = path.resolve(opt('dir', path.join(__dirname, '..', '.models')));
const mode = opt('draft', 'both');
const channelCount = Number(opt('channels', 1));
const CHUNK_MS = 100;
const GAP = Buffer.alloc(16000 * 2 * 1.3);

const words = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}
const cpuTicks = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); }; // utime + stime
const rssMB = (pid) => Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clips(engine, clipDir) {
  const out = [];
  for (const l of ['en', 'de', 'es', 'fr']) out.push(await decodeAudio(fs.readFileSync(path.join(clipDir, `${l}.wav`)), `${l}.wav`, { engine }));
  return out;
}

// One run: stream `pcms` (per channel) in real time and collect what the engine says.
async function run(models, { draft, plans, clipDir }) {
  const engine = new AsrEngine();
  const model = models.resolve('auto');
  await engine.start(model, { vadPath: models.vadPath(), threads: 4, language: 'auto' });
  const pid = engine.pools().live.pid;
  let draftInfo = { enabled: false };
  if (draft) draftInfo = await engine.setDraft(models.draftModel());
  const events = [];
  const t0 = () => performance.now();
  let start = 0;
  engine.on('segment', (s) => events.push({ k: 'segment', at: t0() - start, ...s }));
  engine.on('partial', (p) => events.push({ k: 'partial', at: t0() - start, ...p }));
  const idleRss = rssMB(pid);
  const cpu0 = cpuTicks(pid);
  start = t0();
  await Promise.all(Object.entries(plans).map(async ([ch, pcm]) => {
    const size = 16 * 2 * CHUNK_MS;
    for (let i = 0, n = 0; i < pcm.length; i += size, n++) {
      const due = start + n * CHUNK_MS;
      const wait = due - t0();
      if (wait > 0) await sleep(wait);
      engine.feed(ch, pcm.subarray(i, i + size));
    }
    engine.feed(ch, Buffer.alloc(16000 * 2));
    await sleep(1500);
    await engine.flush(ch);
  }));
  const wallS = (t0() - start) / 1000;
  const cores = (cpuTicks(pid) - cpu0) / 100 / wallS; // USER_HZ is 100
  const peak = rssMB(pid);
  engine.stop();
  return { events, draftInfo, cores, idleRss, peak, wallS };
}

function summarize(res, ch) {
  const segs = res.events.filter((e) => e.k === 'segment' && e.ch === ch);
  const parts = res.events.filter((e) => e.k === 'partial' && e.ch === ch);
  const rows = [];
  for (const s of segs) {
    // partials belonging to this utterance: shown after it started, cleared by its final (text '')
    const mine = parts.filter((p) => p.at >= 0 && p.startMs <= s.endMs && p.startMs >= s.startMs - 1500 && p.at <= segAt(res, ch, s) + 5);
    const shown = mine.filter((p) => p.text);
    const first = shown[0];
    const last = shown[shown.length - 1];
    rows.push({
      startS: s.startMs / 1000, lenS: (s.endMs - s.startMs) / 1000, words: words(s.text).length,
      firstWordS: first ? first.at / 1000 - s.startMs / 1000 : null,
      finalAfterEndS: segAt(res, ch, s) / 1000 - s.endMs / 1000,
      draftWer: last ? wer(s.text, last.text) : null, drafts: shown.length,
      final: s.text, draft: last?.text || '',
    });
  }
  return rows;
}
const segAt = (res, ch, s) => res.events.find((e) => e.k === 'segment' && e.ch === ch && e.startMs === s.startMs).at;

(async () => {
  const models = new Models(dir);
  if (!models.resolve('auto') || !models.vadInstalled()) throw new Error(`no speech model in ${dir}`);
  if (mode !== 'off' && !models.draftModel()) throw new Error(`no draft model in ${dir} (node scripts/fetch-models.js nemotron-3.5-streaming-320ms)`);
  const clipDir = path.resolve(opt('clips', path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs')));
  const helper = new AsrEngine();
  await helper.start(models.resolve('auto'), { vadPath: models.vadPath(), threads: 2 });
  const [en, de, es, fr] = await clips(helper, clipDir);
  helper.stop();
  // channel A: four short utterances with pauses, then the same four back to back (~21 s without a pause)
  const a = Buffer.concat([en, GAP, de, GAP, es, GAP, fr, GAP, Buffer.alloc(16000 * 2), en, es, fr, de, GAP]);
  const b = Buffer.concat([Buffer.alloc(16000 * 2 * 3), fr, GAP, es, GAP, de, GAP, en, GAP, Buffer.alloc(16000 * 2), de, fr, es, en, GAP]);
  const plans = channelCount === 2 ? { mic: a, system: b } : { mic: a };
  const results = {};
  for (const draft of mode === 'both' ? [false, true] : [mode === 'on']) results[draft ? 'on' : 'off'] = await run(models, { draft, plans, clipDir });
  const report = {};
  for (const [name, res] of Object.entries(results)) {
    report[name] = { cores: +res.cores.toFixed(2), rssMB: res.peak, idleRssMB: res.idleRss, draft: res.draftInfo, wallS: +res.wallS.toFixed(1), channels: Object.fromEntries(Object.keys(plans).map((ch) => [ch, summarize(res, ch)])) };
  }
  if (args.includes('--json')) { console.log(JSON.stringify(report, null, 1)); return; }
  for (const [name, r] of Object.entries(report)) {
    console.log(`\n=== drafts ${name}: ${r.wallS}s of audio, live worker ${r.cores} cores busy on average, RSS ${r.idleRssMB} -> ${r.rssMB} MB ${r.draft.enabled ? `(streaming model loaded in ${r.draft.ms} ms, ${r.draft.threads} threads)` : r.draft.reason ? `(drafts off: ${r.draft.reason})` : ''}`);
    for (const [ch, rows] of Object.entries(r.channels)) {
      console.log(`  ${ch}:  start  len  words  first word  final after end  draft WER`);
      for (const x of rows) console.log(`      ${x.startS.toFixed(1).padStart(6)} ${x.lenS.toFixed(1).padStart(4)} ${String(x.words).padStart(5)}  ${x.firstWordS == null ? '    -     ' : `${x.firstWordS.toFixed(2).padStart(6)} s  `}   ${x.finalAfterEndS.toFixed(2).padStart(6)} s       ${x.draftWer == null ? '-' : `${(x.draftWer * 100).toFixed(0)}%`}`);
    }
  }
  if (report.on) {
    const rows = Object.values(report.on.channels).flat();
    const fw = rows.map((x) => x.firstWordS).filter((v) => v != null).sort((p, q) => p - q);
    const wers = rows.map((x) => x.draftWer).filter((v) => v != null);
    const med = (v) => v[Math.floor(v.length / 2)];
    console.log(`\nfirst word after speech start: median ${med(fw)?.toFixed(2)} s, worst ${fw[fw.length - 1]?.toFixed(2)} s over ${fw.length} utterances; final-vs-last-draft WER mean ${((wers.reduce((s, v) => s + v, 0) / wers.length) * 100).toFixed(1)}%`);
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
