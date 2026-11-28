'use strict';
// The speaker-analysis worker processes as processes that can die: a dead live follower makes Stop fail fast instead of
// waiting an hour, and how long anyone waits follows the length of the audio. No models needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { LiveDiarizer, diarizeOwned, diarizeTimeout } = require('../src/speakers/owned');
const { diarize } = require('../src/speakers/diarizer');
const { tmpDir } = require('./helpers');

test('the wait for a diarization follows the audio: twice its length plus a minute, within bounds', () => {
  assert.equal(diarizeTimeout(0), 60 * 1000);
  assert.equal(diarizeTimeout(600), 2 * 600 * 1000 + 60 * 1000);
  assert.equal(diarizeTimeout(10 * 3600), 60 * 60 * 1000, 'never more than an hour');
});

test('live follower: when its process dies, finish() fails at once instead of waiting for a timeout', { timeout: 20000 }, async (t) => {
  const dir = tmpDir('wb-lv-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spool.pcm');
  fs.writeFileSync(file, Buffer.alloc(32000));
  const warnings = [];
  const lv = new LiveDiarizer({ file, segmentation: '/nope.onnx', embedding: '/nope.onnx', onWarning: (m) => warnings.push(m) });
  t.after(() => lv.stop());
  lv.child.kill('SIGKILL');
  await once(lv.child, 'exit');
  assert.ok(lv.exited, 'the death is noticed');
  assert.ok(lv.failed, 'and counts as a failure, so Stop uses the one-shot instead');
  const t0 = Date.now();
  await assert.rejects(lv.finish({ samples: 16000 }), /exited/);
  assert.ok(Date.now() - t0 < 2000);
});

test('one-shot workers: a process that cannot start or dies rejects instead of throwing', { timeout: 20000 }, async (t) => {
  const dir = tmpDir('wb-dz1-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spool.pcm');
  fs.writeFileSync(file, Buffer.alloc(32000));
  // a bad model: the worker reports the error, the promise rejects (no uncaught exception, no hour-long wait)
  await assert.rejects(diarizeOwned({ file, segmentation: '/nope.onnx', embedding: '/nope.onnx' }), /./);
  await assert.rejects(diarize({ file, segmentation: '/nope.onnx', embedding: '/nope.onnx' }), /./);
});
