'use strict';
// Worker pools: live, batch (imports) and dictation each get their own worker and recognizer; cores are divided
// without oversubscription; memory decides whether extra workers exist; imports are decoded in parallel with the
// same result as serially and never delay live captions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AsrEngine, planPools, workerMB, MEMORY_RESERVE_MB } = require('../src/asr/engine');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');
const { decodeAudio, transcribePcm } = require('../src/recording/import');
const { wavToPcm16 } = require('../src/audio/pcm');
const { testModels, fixture, tmpDir } = require('./helpers');

test('plan: live <= 4 threads, batch gets the rest of the cores (max 8), concurrency follows; never more than the cores', () => {
  assert.deepEqual(planPools({ cpus: 32, threads: 8 }), {
    mode: 'split', cores: 16, live: { threads: 4 }, batch: { threads: 8, concurrency: 4 }, dictation: { threads: 4 },
  });
  assert.deepEqual(planPools({ cpus: 16, threads: 8 }).batch, { threads: 4, concurrency: 2 });
  assert.deepEqual(planPools({ cpus: 8, threads: 4 }).live, { threads: 2 });
  assert.deepEqual(planPools({ cpus: 8, threads: 4 }).batch, { threads: 2, concurrency: 1 });
  assert.equal(planPools({ cpus: 32, threads: 2 }).live.threads, 2, 'the thread setting still caps the live worker');
  for (const cpus of [1, 2, 4, 6, 8, 12, 16, 24, 32, 64, 128]) {
    for (const threads of [1, 2, 4, 8, 16]) {
      const p = planPools({ cpus, threads });
      if (p.mode === 'shared') { assert.equal(p.live.threads, threads); assert.equal(p.batch, null); continue; }
      assert.ok(p.live.threads >= 1 && p.batch.threads >= 1 && p.batch.concurrency >= 1);
      assert.ok(p.live.threads + p.batch.threads <= p.cores, `cpus=${cpus} threads=${threads}: ${p.live.threads}+${p.batch.threads} > ${p.cores} cores`);
      assert.ok(p.batch.concurrency * 2 <= p.batch.threads || p.batch.concurrency === 1);
    }
  }
});

test('plan: machines with fewer than four cores, or pools switched off, keep one shared worker', () => {
  for (const cpus of [1, 2, 4, 6]) assert.equal(planPools({ cpus, threads: 2 }).mode, 'shared');
  const off = planPools({ cpus: 32, threads: 8, enabled: false });
  assert.deepEqual(off, { mode: 'shared', cores: 16, live: { threads: 8 }, batch: null, dictation: null });
});

test('memory: a second recognizer is started only when it fits beside what the machine needs', (t) => {
  const dir = tmpDir('wb-pool-', t);
  const file = path.join(dir, 'model.onnx');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 100 * 1048576); // a 100 MB "model": only its size is read, so a sparse file that takes no disk space
  const model = { id: 'tiny-test', kind: 'transducer', files: { encoder: file } };
  const need = workerMB(model);
  assert.ok(need >= 100 + 200, `worker estimate counts the files plus overhead (${need} MB)`);
  let free = 0;
  const engine = new AsrEngine({ pools: 'auto', cpus: 32, freeMemMB: () => free });
  free = 2 * need + MEMORY_RESERVE_MB - 1;
  assert.equal(engine.planFor(model, 8).mode, 'shared', 'room for one copy only: share the live worker');
  assert.equal(engine.workerFor('batch', model, null, 8), engine.live);
  assert.equal(engine.workerFor('dictation', model, null, 8), engine.live);
  free = 2 * need + MEMORY_RESERVE_MB;
  assert.equal(engine.planFor(model, 8).mode, 'split');
  assert.equal(engine.workerFor('batch', model, null, 8), engine.batch);
  assert.equal(engine.workerFor('dictation', model, null, 8), engine.dictation);
  assert.equal(new AsrEngine({ pools: 'shared', cpus: 32, freeMemMB: () => 1e9 }).planFor(model, 8).mode, 'shared');
  assert.equal(new AsrEngine({ pools: 'split', cpus: 32, freeMemMB: () => 0 }).planFor(model, 8).mode, 'split');
  assert.equal(new AsrEngine({ pools: 'auto', cpus: 4, freeMemMB: () => 1e9 }).planFor(model, 2).mode, 'shared', 'too few cores');
  // memory can drop after the live worker started: a new batch worker still has to fit
  engine.live.child = {}; engine.plan = engine.planFor(model, 8);
  free = need + MEMORY_RESERVE_MB - 1;
  assert.equal(engine.workerFor('batch', model, null, 8), engine.live);
  free = need + MEMORY_RESERVE_MB + 500;
  assert.equal(engine.workerFor('batch', model, null, 8), engine.batch);
  engine.live.child = null;
});

// ---- the recording manager hands the meeting's words to the engine ----
class FakeEngine extends EventEmitter {
  constructor() { super(); this.hot = []; }
  async start() {}
  async setHotwords(terms) { this.hot.push(['set', terms]); }
  async releaseHotwords() { this.hot.push(['release']); }
  feed() {}
  async flush() {}
  reset() {}
}
function managerWith({ vocabulary, hotwords }) {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ asrHotwords: hotwords });
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx' };
  const platform = { capture: { mic: 'renderer', system: 'renderer' }, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource() };
  return { notes, engine, mgr: new RecordingManager({ notes, engine, models, settings, platform, bus, vocabulary }) };
}

test('recording: the meeting vocabulary goes to the engine before audio flows, and is released at the end', async () => {
  const { notes, engine, mgr } = managerWith({ vocabulary: (id) => ['Vasco Neves', id.length ? 'Acme' : ''], hotwords: true });
  const n = notes.create({});
  await mgr.start(n.id);
  assert.deepEqual(engine.hot, [['set', ['Vasco Neves', 'Acme']]]);
  await mgr.stop();
  assert.deepEqual(engine.hot[1], ['release']);
});

test('recording: with the setting off, or no vocabulary source, or a failing one, the recording still starts and biasing is off', async () => {
  for (const cfg of [{ vocabulary: () => ['Acme'], hotwords: false }, { vocabulary: null, hotwords: true }]) {
    const { notes, engine, mgr } = managerWith(cfg);
    await mgr.start(notes.create({}).id);
    assert.deepEqual(engine.hot, [['set', []]]);
    await mgr.stop();
  }
  const { notes, mgr } = managerWith({ vocabulary: () => { throw new Error('db locked'); }, hotwords: true });
  await mgr.start(notes.create({}).id);
  assert.equal(mgr.status().active, true, 'a vocabulary failure never stops a recording');
  await mgr.stop();
});

// ---- real models ----
const models = testModels();
const hasAll = models && models.speakerInstalled() && models.isInstalled('parakeet-tdt-0.6b-v3');
const skip = hasAll ? false : 'needs the speaker model and parakeet-tdt-0.6b-v3 (npm run models)';
const parakeet = () => models.describe('parakeet-tdt-0.6b-v3');
const opts = (extra = {}) => ({ vadPath: models.vadPath(), threads: 8, ...extra });
const speakerEngine = (o = {}) => new AsrEngine({ cpus: 32, speakerModel: () => models.speakerPath(), ...o });

// ~45 s of speech in several languages with gaps, resampled properly by the engine
async function sample(engine) {
  const wav = (l) => fs.readFileSync(path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', `${l}.wav`));
  const gap = Buffer.alloc(16000 * 2 * 1.3);
  const parts = [wavToPcm16(fs.readFileSync(fixture('speech-0.wav'))), wavToPcm16(fs.readFileSync(fixture('hello.wav')))];
  for (const l of ['en', 'de', 'es', 'fr']) parts.push(await decodeAudio(wav(l), `${l}.wav`, { engine }));
  return Buffer.concat(parts.flatMap((p) => [p, gap]));
}

test('import: decoding in parallel gives exactly the serial result, in time order, with exact offsets', { skip, timeout: 240000 }, async (t) => {
  const serial = speakerEngine({ pools: 'shared' });
  const parallel = speakerEngine({ pools: 'split' });
  t.after(() => { serial.stop(); parallel.stop(); });
  await serial.start(parakeet(), opts({ role: 'batch' }));
  await parallel.start(parakeet(), opts({ role: 'batch' }));
  assert.equal(serial.pools().batch, null, 'shared mode has no batch worker');
  assert.ok(parallel.pools().batch.concurrency > 1, 'the batch worker decodes several utterances at once');
  assert.equal(parallel.pools().live, null, 'an import alone does not load the live recognizer');

  const one = await sample(serial);
  const pcm = Buffer.concat([one, one, one]); // ~2.5 minutes, 3x the same utterances
  const a = await transcribePcm(serial, pcm);
  const progress = [];
  const b = await transcribePcm(parallel, pcm, { onProgress: (p) => progress.push(p) });
  assert.ok(a.length >= 3 * 6, `enough utterances to split up (${a.length})`);
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].startMs, a[i].startMs, `start of #${i}`);
    assert.equal(b[i].endMs, a[i].endMs, `end of #${i}`);
    assert.equal(b[i].text, a[i].text, `text of #${i}`);
    assert.deepEqual(b[i].words, a[i].words, `word timings of #${i}`);
    assert.equal(!!b[i].embedding, !!a[i].embedding);
    if (a[i].embedding) for (let k = 0; k < a[i].embedding.length; k++) assert.ok(Math.abs(a[i].embedding[k] - b[i].embedding[k]) < 1e-4, `embedding of #${i}`);
  }
  for (let i = 1; i < b.length; i++) assert.ok(b[i].startMs >= b[i - 1].endMs - 1, 'time order, no overlap');
  assert.ok(b[b.length - 1].endMs <= Math.round(pcm.length / 32) + 1000);
  assert.equal(progress[progress.length - 1], 1);
  assert.ok(b.some((s) => /ask not what your country/i.test(s.text)));
});

test('import: a file with nothing in it, or a single short utterance, comes back as is', { skip, timeout: 120000 }, async (t) => {
  const e = speakerEngine({ pools: 'split' });
  t.after(() => e.stop());
  await e.start(parakeet(), opts({ role: 'batch' }));
  assert.deepEqual(await transcribePcm(e, Buffer.alloc(16000 * 2 * 3)), []);
  assert.deepEqual(await transcribePcm(e, Buffer.alloc(0)), []);
  const hello = await transcribePcm(e, Buffer.concat([wavToPcm16(fs.readFileSync(fixture('hello.wav')))]));
  assert.equal(hello.length, 1);
  assert.match(hello[0].text.toLowerCase(), /love/);
});

// A latency comparison between two worker processes that share the cores: on a shared CI runner (a few vCPUs, other jobs beside it) the
// live worker waits for a core and the ratio says nothing about the code (3.9 s against 0.8 s idle there, 0.4 s on a free machine).
const crowded = process.env.CI ? 'timing of two busy workers: meaningless on a shared CI runner' : false;
test('imports do not delay live captions: a long import runs while live segments keep arriving at their usual pace', { skip: skip || crowded, timeout: 240000 }, async (t) => {
  const engine = speakerEngine({ pools: 'split' });
  t.after(() => engine.stop());
  await engine.start(parakeet(), opts());
  await engine.start(parakeet(), opts({ role: 'batch' }));
  assert.notEqual(engine.pools().live.pid, engine.pools().batch.pid);
  const speech = wavToPcm16(fs.readFileSync(fixture('speech-0.wav')));
  const arrivals = [];
  engine.on('segment', (s) => { if (s.ch === 'mic') arrivals.push(Date.now()); });
  // one utterance followed by silence, fed at once: how long until its text comes back
  const caption = async () => {
    arrivals.length = 0;
    const audio = Buffer.concat([speech, Buffer.alloc(16000 * 2 * 1.5)]);
    const t0 = Date.now();
    for (let i = 0; i < audio.length; i += 3200) engine.feed('mic', audio.subarray(i, i + 3200));
    await engine.flush('mic');
    engine.reset('mic');
    return Date.now() - t0;
  };
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  await caption(); // warm up
  const idle = median([await caption(), await caption(), await caption()]);

  const one = await sample(engine);
  const long = Buffer.concat(Array(14).fill(one)); // ~10 minutes: seconds of decoding on the batch worker
  let importDone = false;
  const imp = transcribePcm(engine, long).then((r) => { importDone = true; return r; });
  await new Promise((r) => setTimeout(r, 400));
  const busy = [];
  for (let i = 0; i < 3; i++) busy.push(await caption());
  const stillRunning = !importDone;
  const segments = await imp;
  assert.ok(stillRunning, 'the import was still busy while the live captions were measured');
  assert.ok(segments.length > 50);
  const during = median(busy);
  assert.ok(during <= Math.max(idle * 3, idle + 1000), `live latency while importing ${during} ms vs ${idle} ms idle (all: ${busy})`);
});

test('dictation has a worker of its own; without memory for one it falls back to the live worker', { skip, timeout: 240000 }, async (t) => {
  const pcm = wavToPcm16(fs.readFileSync(fixture('hello.wav')));
  const engine = speakerEngine({ pools: 'auto', freeMemMB: () => 64000 });
  t.after(() => engine.stop());
  await engine.start(parakeet(), opts());
  await engine.start(parakeet(), opts({ role: 'dictation' }));
  const p = engine.pools();
  assert.ok(p.live && p.dictation && p.live.pid !== p.dictation.pid);
  assert.equal(p.dictation.threads, 4);
  assert.match((await engine.transcribe(pcm)).toLowerCase(), /love/);

  const small = speakerEngine({ pools: 'auto', freeMemMB: () => 1200 });
  t.after(() => small.stop());
  await small.start(parakeet(), opts());
  const live = small.pools().live;
  assert.equal(live.threads, 8, 'sharing: the single worker keeps the full thread setting');
  await small.start(parakeet(), opts({ role: 'dictation' }));
  await small.start(parakeet(), opts({ role: 'batch' }));
  assert.equal(small.pools().dictation, null);
  assert.equal(small.pools().batch, null);
  assert.equal(small.pools().live.pid, live.pid, 'no extra processes on a small machine');
  assert.match((await small.transcribe(pcm)).toLowerCase(), /love/, 'dictation still works on the shared worker');
});

test('a worker that sat idle gives its memory back; the live worker is never stopped for being idle', { skip, timeout: 120000 }, async (t) => {
  const engine = speakerEngine({ pools: 'split', idleMs: { batch: 1200, dictation: 1200 } });
  t.after(() => engine.stop());
  await engine.start(parakeet(), opts());
  await engine.start(parakeet(), opts({ role: 'batch' }));
  const pid = engine.pools().live.pid;
  assert.ok(engine.pools().batch);
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(engine.pools().batch, null, 'idle batch worker stopped');
  assert.equal(engine.pools().live.pid, pid);
  assert.equal(await transcribePcm(engine, Buffer.alloc(32000)).then((r) => r.length), 0, 'imports fall back to the live channel when the batch worker is gone');
  await engine.start(parakeet(), opts({ role: 'batch' })); // and it comes back on demand
  assert.ok(engine.pools().batch);
});
