'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Models, recognizerConfig, resolveFiles, CATALOG } = require('../src/asr/models');
const { Bus } = require('../src/core/events');
const { tmpDir } = require('./helpers');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A throwaway "model server": one tar.bz2 with a fake transducer layout and a fake VAD file.
async function modelServer(t, { corrupt = false } = {}) {
  const work = tmpDir('wb-modelsrv-');
  const pkg = path.join(work, 'fake-model-int8');
  fs.mkdirSync(pkg);
  for (const f of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'encoder.onnx']) fs.writeFileSync(path.join(pkg, f), f.repeat(1000));
  const archive = path.join(work, 'm.tar.bz2');
  assert.equal(spawnSync('tar', ['-cjf', archive, '-C', work, 'fake-model-int8']).status, 0);
  const tarball = fs.readFileSync(archive);
  const vad = Buffer.from('fake vad model');
  const srv = http.createServer((req, res) => {
    if (req.url === '/m.tar.bz2') { res.writeHead(200, { 'Content-Length': tarball.length }); res.end(corrupt ? Buffer.concat([tarball.subarray(0, 100), Buffer.from('xx'), tarball.subarray(102)]) : tarball); }
    else if (req.url === '/vad.onnx') { res.writeHead(200); res.end(vad); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/m.tar.bz2' }); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); fs.rmSync(work, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { tarSha: sha(tarball), vadSha: sha(vad), base };
}

function make(srv, dir, { sha256 } = {}) {
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const models = new Models(dir, {
    bus,
    catalog: [{ id: 'fake', name: 'Fake', kind: 'transducer', languages: ['en'], note: '', url: `${srv.base}/redirect`, sizeMB: 1, sha256: sha256 ?? srv.tarSha, maxSegmentSec: 20 }],
    vad: { id: 'vad', url: `${srv.base}/vad.onnx`, sha256: srv.vadSha },
    speaker: { id: 'spk', url: `${srv.base}/vad.onnx`, sha256: srv.vadSha },
  });
  return { models, events };
}

test('install: downloads (following redirects), verifies, extracts, picks int8 files, reports progress', async (t) => {
  const srv = await modelServer(t);
  const dir = tmpDir();
  const { models, events } = make(srv, dir);
  assert.equal(models.resolve('auto'), null);
  const desc = await models.install('fake');
  assert.equal(desc.kind, 'transducer');
  assert.match(desc.files.encoder, /encoder\.int8\.onnx$/, 'prefers the int8 variant over encoder.onnx');
  assert.equal(models.isInstalled('fake'), true);
  assert.equal(models.vadInstalled(), true, 'the VAD model is installed alongside');
  assert.equal(models.speakerInstalled(), true, 'and the speaker-recognition model');
  assert.equal(models.resolve('auto').id, 'fake');
  assert.equal(models.list()[0].installed, true);
  assert.ok(events.some((e) => e.type === 'model.progress'));
  assert.ok(events.some((e) => e.type === 'model.installed'));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-')), [], 'no temp files left behind');
  models.remove('fake');
  assert.equal(models.isInstalled('fake'), false);
});

test('install refuses an archive whose checksum does not match, and leaves nothing installed', async (t) => {
  const srv = await modelServer(t);
  const dir = tmpDir();
  const { models } = make(srv, dir, { sha256: '0'.repeat(64) });
  await assert.rejects(models.install('fake'), /checksum mismatch/);
  assert.equal(models.isInstalled('fake'), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-')), []);
  const corrupt = await modelServer(t, { corrupt: true });
  const b = make(corrupt, tmpDir());
  await assert.rejects(b.models.install('fake'), /checksum mismatch|tar failed|bzip2|Unexpected/i);
});

test('install: unknown model, concurrent duplicate download, and an archive without model files', async (t) => {
  const srv = await modelServer(t);
  const { models } = make(srv, tmpDir());
  await assert.rejects(models.install('nope'), /unknown model/);
  const first = models.install('fake');
  await assert.rejects(models.install('fake'), /already downloading/);
  await first;
  const notAnArchive = new Models(tmpDir(), { catalog: [{ id: 'w', name: 'W', kind: 'whisper', languages: [], url: `${srv.base}/vad.onnx`, sha256: srv.vadSha }], vad: { url: `${srv.base}/vad.onnx`, sha256: srv.vadSha }, speaker: { url: `${srv.base}/vad.onnx`, sha256: srv.vadSha } });
  await assert.rejects(notAnArchive.install('w'), /tar failed/);
  assert.equal(notAnArchive.isInstalled('w'), false);
});

test('recognizer configs per model kind, and file resolution requires every file', () => {
  const tr = recognizerConfig({ kind: 'transducer', files: { encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't' } }, { threads: 3 });
  assert.equal(tr.modelConfig.modelType, 'nemo_transducer');
  assert.equal(tr.modelConfig.numThreads, 3);
  const wh = recognizerConfig({ kind: 'whisper', files: { encoder: 'e', decoder: 'd', tokens: 't' } }, { language: 'pt' });
  assert.equal(wh.modelConfig.whisper.language, 'pt');
  assert.equal(recognizerConfig({ kind: 'whisper', files: { encoder: 'e', decoder: 'd', tokens: 't' } }).modelConfig.whisper.language, '', 'auto-detect language');
  assert.throws(() => recognizerConfig({ kind: 'nope', files: {} }), /unsupported/);
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'tokens.txt'), 'x');
  fs.writeFileSync(path.join(d, 'tiny-encoder.int8.onnx'), 'x');
  assert.equal(resolveFiles('whisper', d), null, 'decoder missing');
  fs.writeFileSync(path.join(d, 'tiny-decoder.int8.onnx'), 'x');
  assert.match(resolveFiles('whisper', d).decoder, /tiny-decoder/);
});

test('catalog: every entry has what the installer needs; the multilingual default is pinned', () => {
  for (const m of CATALOG) { assert.match(m.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\//); assert.ok(['transducer', 'whisper'].includes(m.kind)); }
  assert.match(CATALOG.find((m) => m.id === 'parakeet-tdt-0.6b-v3').sha256, /^[0-9a-f]{64}$/);
});
