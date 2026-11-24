'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { AsrEngine } = require('../src/asr/engine');
const { wavToPcm16 } = require('../src/audio/pcm');
const { testModels, fixture } = require('./helpers');

const models = testModels();
const skip = models ? false : 'no ASR model installed (run npm run models)';

function chunks(pcm, ms = 100) {
  const size = 16 * 2 * ms;
  const out = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, i + size));
  return out;
}

test('engine transcribes streamed audio into timed segments (real model)', { skip, timeout: 120000 }, async (t) => {
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  const model = models.resolve('auto');
  await engine.start(model, { vadPath: models.vadPath(), threads: 2 });
  const segs = [];
  engine.on('segment', (s) => segs.push(s));
  const pcm = wavToPcm16(fs.readFileSync(fixture('speech-0.wav')));
  for (const c of chunks(pcm)) engine.feed('mic', c);
  engine.feed('mic', Buffer.alloc(16000 * 2)); // trailing silence closes the last utterance
  await engine.flush('mic');
  assert.ok(segs.length >= 1, 'at least one segment');
  assert.ok(segs.every((s) => s.ch === 'mic' && s.endMs > s.startMs && s.text.length > 0));
  assert.ok(segs.map((s) => s.text).join(' ').length > 20);
});

test('engine keeps channels independent and supports one-shot transcribe', { skip, timeout: 120000 }, async (t) => {
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  await engine.start(models.resolve('auto'), { vadPath: models.vadPath() });
  const pcm = wavToPcm16(fs.readFileSync(fixture('hello.wav')));
  const text = await engine.transcribe(pcm);
  assert.match(text.toLowerCase(), /love/);
  const segs = [];
  engine.on('segment', (s) => segs.push(s));
  for (const c of chunks(pcm)) engine.feed('system', c);
  engine.feed('system', Buffer.alloc(16000 * 2));
  await engine.flush('system');
  assert.ok(segs.length >= 1 && segs.every((s) => s.ch === 'system'));
});

test('engine surfaces a crashed worker', { timeout: 20000 }, async () => {
  const engine = new AsrEngine();
  const bad = { id: 'x', kind: 'transducer', files: { encoder: '/nope', decoder: '/nope', joiner: '/nope', tokens: '/nope' } };
  await assert.rejects(engine.start(bad, { vadPath: '/nope' }), /./);
  engine.stop();
});

const multi = models && models.isInstalled('parakeet-tdt-0.6b-v3') ? models : null;
test('the multilingual model transcribes non-English speech (its bundled Spanish sample)', { skip: multi ? false : 'parakeet-tdt-0.6b-v3 not installed', timeout: 120000 }, async (t) => {
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  await engine.start(multi.describe('parakeet-tdt-0.6b-v3'), { vadPath: multi.vadPath(), threads: 4 });
  const wav = require('node:path').join(multi.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', 'es.wav');
  const text = await engine.transcribe(wavToPcm16(fs.readFileSync(wav)));
  assert.match(text.toLowerCase(), /país/);
});
