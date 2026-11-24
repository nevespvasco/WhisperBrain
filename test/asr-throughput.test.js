'use strict';
// Transcription throughput and robustness: thread defaults, the worker staying put during a recording, segment
// metadata (word timings, confidence) and WAV resampling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsrEngine } = require('../src/asr/engine');
const { CATALOG, AUTO_ORDER } = require('../src/asr/models');
const { wordsOf, confidenceOf, loudestWindow } = require('../src/asr/segment-info');
const { Settings, DEFAULTS, defaultAsrThreads } = require('../src/core/settings');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Speakers } = require('../src/speakers/store');
const { RecordingManager } = require('../src/recording/manager');
const { Dictation } = require('../src/dictation/dictation');
const { decodeAudio } = require('../src/recording/import');
const { wavToPcm16 } = require('../src/audio/pcm');
const { testModels, fixture } = require('./helpers');

test('asrThreads defaults to half the logical CPUs, clamped to 2..8, and stays user-overridable', () => {
  assert.deepEqual([1, 2, 4, 8, 12, 16, 32, 64].map((n) => defaultAsrThreads(n)), [2, 2, 2, 4, 6, 8, 8, 8]);
  assert.equal(DEFAULTS.asrThreads, defaultAsrThreads(os.availableParallelism()));
  const settings = new Settings(open(':memory:'));
  assert.equal(settings.update({ asrThreads: 12 }).asrThreads, 12);
  assert.equal(settings.update({ asrThreads: 0 }).asrThreads, 1);
  assert.equal(settings.update({ asrThreads: 99 }).asrThreads, 16);
});

test('catalog: Parakeet segments may run 30 s; Whisper stays inside its 30 s window; Parakeet 110M outranks Whisper in auto order', () => {
  for (const m of CATALOG.filter((x) => x.kind === 'transducer')) assert.equal(m.maxSegmentSec, 30, m.id);
  for (const m of CATALOG.filter((x) => x.kind === 'whisper')) assert.ok(m.maxSegmentSec <= 30, m.id);
  assert.ok(AUTO_ORDER.indexOf('parakeet-tdt-110m-en') < AUTO_ORDER.indexOf('whisper-small'));
  assert.ok(AUTO_ORDER.indexOf('parakeet-tdt-0.6b-v3') < AUTO_ORDER.indexOf('parakeet-tdt-110m-en'));
});

test('segment info: words are rebuilt from tokens, confidence summarised, embedding crop picks the loudest window', () => {
  const r = {
    tokens: [' A', 'sk', ' not', ' co', 'un', 'try', '.'],
    timestamps: [0, 0.24, 0.4, 0.64, 0.8, 0.96, 1.04],
    durations: [0.24, 0.16, 0.24, 0.16, 0.16, 0.08, 0.08],
    ys_log_probs: [-0.1, 0, -0.5, -0.2, 0, 0, -0.2],
  };
  assert.deepEqual(wordsOf(r), [['Ask', 0, 400], ['not', 400, 640], ['country.', 640, 1120]]);
  assert.equal(wordsOf({ tokens: [], timestamps: [] }), null);
  assert.equal(wordsOf({ tokens: ['a'], timestamps: [] }), null);
  const c = confidenceOf(r);
  assert.ok(Math.abs(c.logProbMean - -1 / 7) < 1e-9);
  assert.equal(c.logProbMin, -0.5);
  assert.deepEqual(confidenceOf({ ys_log_probs: [] }), { logProbMean: null, logProbMin: null });

  const rate = 16000, size = 6 * rate;
  const short = new Float32Array(5 * rate).fill(0.1);
  assert.equal(loudestWindow(short, size), short, 'short segments are untouched');
  const long = new Float32Array(20 * rate).fill(0.01);
  long.fill(0.5, 9 * rate, 13 * rate); // the loud part
  const w = loudestWindow(long, size);
  assert.equal(w.length, size);
  const at = w.byteOffset / 4;
  assert.ok(at <= 9 * rate && at + size >= 13 * rate, `window [${at / rate}s, ${(at + size) / rate}s] must cover the loud part`);
});

test('segments keep word timings and confidence; schema v5 adds the columns', () => {
  const db = open(':memory:');
  const notes = new Notes(db, new Bus());
  const n = notes.create({});
  const [a, b] = notes.addSegments(n.id, [
    { speaker: 'me', startMs: 0, endMs: 1500, text: 'hello world', words: [['hello', 0, 500], ['world', 600, 1100]], logProbMean: -0.05, logProbMin: -0.2 },
    { speaker: 'them', startMs: 2000, endMs: 3000, text: 'plain' }, // e.g. a Whisper segment: no timings
  ]);
  const row = (id) => db.prepare('SELECT words, logprob_mean AS mean, logprob_min AS min FROM segments WHERE id = ?').get(id);
  assert.deepEqual(JSON.parse(row(a.id).words), [['hello', 0, 500], ['world', 600, 1100]]);
  assert.equal(row(a.id).mean, -0.05);
  assert.equal(row(a.id).min, -0.2);
  assert.deepEqual({ ...row(b.id) }, { words: null, mean: null, min: null });
  assert.deepEqual(notes.segments(n.id).map((s) => s.text), ['hello world', 'plain'], 'reading segments is unchanged');
});

// ---- the engine, without models ----
function fakeChild() { const sent = []; return { sent, killed: false, send: (m) => sent.push(m), kill() { this.killed = true; }, on() {} }; }
function running(engine, { id = 'm', threads = 4, language = 'auto', speakerModel = '/spk.onnx' } = {}) {
  engine.child = fakeChild(); engine.model = { id }; engine.opts = { threads, language, speakerModel }; engine.ready = Promise.resolve();
  return engine.child;
}

test('engine: options that arrive during a recording are deferred; the same options never restart', async () => {
  let recording = true;
  const engine = new AsrEngine({ speakerModel: () => '/spk.onnx', holdRestart: () => recording });
  const child = running(engine);
  const warnings = [];
  engine.on('warning', (w) => warnings.push(w));
  // dictation: no speaker model given (the engine supplies it), same everything else -> reused
  await engine.start({ id: 'm' }, { vadPath: '/v', threads: 4 });
  assert.equal(engine.child, child);
  assert.equal(engine.deferred, null);
  // different threads while recording -> kept as they are, remembered for later
  await engine.start({ id: 'm' }, { vadPath: '/v', threads: 2 });
  assert.equal(engine.child, child);
  assert.equal(child.killed, false);
  assert.deepEqual(engine.deferred, { model: 'm', threads: 2, language: 'auto', speakerModel: '/spk.onnx' });
  assert.equal(warnings.length, 0);
  engine.child = null; // nothing real to stop
  recording = false;
});

test('engine: stopping a worker that has pending requests warns', () => {
  const engine = new AsrEngine();
  const child = running(engine);
  const warnings = [];
  engine.on('warning', (w) => warnings.push(w.message));
  engine.flush('mic').catch(() => {});
  engine.transcribe(Buffer.alloc(10)).catch(() => {});
  engine.stop();
  assert.equal(child.killed, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 pending request\(s\) \(flush:mic, tx:\d+\)/);
  const idle = new AsrEngine();
  running(idle);
  idle.on('warning', (w) => warnings.push(w.message));
  idle.stop();
  assert.equal(warnings.length, 1, 'an idle worker stops silently');
});

test('engine: embeddings can be switched without a restart and survive one', () => {
  const engine = new AsrEngine();
  const child = running(engine);
  engine.configure({ embeddings: false });
  assert.deepEqual(child.sent, [{ t: 'config', embed: false }]);
  assert.equal(engine.embeddings, false);
  engine.configure({});
  assert.equal(child.sent.length, 1);
});

// ---- the real models ----
const models = testModels();
const hasAll = models && models.speakerInstalled() && models.isInstalled('parakeet-tdt-0.6b-v3');
const skip = hasAll ? false : 'needs the speaker model and parakeet-tdt-0.6b-v3 (npm run models)';
const chunk = (pcm, ms = 100) => { const size = 16 * 2 * ms, out = []; for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, i + size)); return out; };

// shared: dictation uses the live worker, so its changed options must wait; split: dictation has a worker of its own
for (const pools of ['shared', 'split']) test(`dictation during a recording leaves the live worker alone (${pools} pools): same process, later segments still carry voice embeddings`, { skip, timeout: 240000 }, async (t) => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const speakers = new Speakers(db, bus);
  const engine = new AsrEngine({ pools, cpus: 16, speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
  t.after(() => engine.stop());
  const warnings = [];
  engine.on('warning', (w) => warnings.push(w.message));
  settings.update({ asrModel: 'parakeet-tdt-0.6b-v3' });
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers });
  const platform = { capture: { mic: 'renderer' }, paste: async () => ({ ok: true }), clipboard: { write: async () => {} } };
  const dictation = new Dictation({ platform, engine, models, settings, bus });

  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  const pid = engine.child.pid;
  const speech = wavToPcm16(fs.readFileSync(fixture('speech-0.wav')));
  const hello = wavToPcm16(fs.readFileSync(fixture('hello.wav')));
  const silence = Buffer.alloc(32000);
  for (const c of chunk(Buffer.concat([speech, silence]))) mgr.pushPcm(n.id, 'system', c);

  // the user changes the thread count and then hits the dictation shortcut mid-meeting
  settings.update({ asrThreads: settings.get('asrThreads') === 3 ? 4 : 3 });
  await dictation.toggle();
  assert.equal(dictation.state, 'listening');
  assert.equal(engine.child.pid, pid, 'dictation must not replace the worker during a recording');
  if (pools === 'shared') assert.ok(engine.deferred, 'the new options wait for the recording to end');
  else assert.ok(engine.dictation.running && engine.dictation.child.pid !== pid, 'dictation runs in a worker of its own');
  dictation.pushPcm(hello);
  const spoken = await new Promise((resolve) => { setTimeout(() => dictation.toggle().then(resolve), 400); });
  assert.match(spoken.text.toLowerCase(), /love/, 'dictation still works on the same worker');
  assert.equal(engine.child.pid, pid);

  for (const c of chunk(Buffer.concat([hello, silence]))) mgr.pushPcm(n.id, 'system', c); // the meeting carries on
  await mgr.stop();
  assert.equal(engine.child.pid, pid, 'the worker survived the whole recording');
  assert.deepEqual(warnings, []);

  const rows = db.prepare('SELECT text, embedding, words, logprob_mean AS mean, logprob_min AS min FROM segments WHERE note_id = ? ORDER BY start_ms').all(n.id);
  assert.ok(rows.length >= 2, `expected segments from before and after the dictation, got ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.embedding, `segment "${r.text.slice(0, 30)}" lost its voice embedding`);
    assert.ok(JSON.parse(r.words).length >= 1, 'word timings stored');
    assert.ok(r.mean <= 0 && r.min <= r.mean, 'confidence stored');
  }
  assert.match(rows[rows.length - 1].text.toLowerCase(), /love/, 'segments after the dictation are still transcribed');

  // once the recording is over, the deferred options apply on the next start
  await mgr.start(n.id, { mic: false });
  assert.notEqual(engine.child.pid, pid);
  assert.equal(engine.opts.threads, settings.get('asrThreads'), 'the live worker follows the setting once the recording is over');
  assert.equal(engine.deferred, null);
  await mgr.stop();
});

test('a 24 kHz WAV is resampled by the engine and transcribed correctly', { skip, timeout: 120000 }, async (t) => {
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  await engine.start(models.describe('parakeet-tdt-0.6b-v3'), { vadPath: models.vadPath(), threads: 4 });
  const wav = fs.readFileSync(path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', 'en.wav'));
  assert.equal(wav.readUInt32LE(24), 24000, 'the sample is not 16 kHz');
  const pcm = await decodeAudio(wav, 'en.wav', { engine });
  const frames = (wav.length - 44) / 2;
  assert.ok(Math.abs(pcm.length / 2 - frames * 16000 / 24000) < 20, 'length follows the rate ratio');
  assert.match((await engine.transcribe(pcm)).toLowerCase(), /ask not what your country/);
});
