'use strict';
// macOS / Windows: the system channel is captured by a small native helper when it is there (and the OS can), and by the
// renderer as before when it is not. Here a Node script stands in for the helper; the real Swift / C++ helpers are built
// and self-tested in CI and need a Mac / PC to be tried for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { captureHelperSpec, systemArgs } = require('../src/platform/native-capture');
const darwin = require('../src/platform/darwin');
const win32 = require('../src/platform/win32');

const FAKE = path.join(__dirname, 'support', 'fake-capture-helper.js');
const spec = { file: FAKE, command: process.execPath, prefixArgs: [FAKE] };

async function pcmOf(src, ms = 1500) {
  const chunks = [];
  src.on('pcm', (b) => chunks.push(b));
  await new Promise((resolve) => { src.on('end', resolve); src.start(); setTimeout(() => { src.stop(); resolve(); }, ms); });
  return Buffer.concat(chunks);
}
// which tone is in the samples: 440 (followed the app) or 1000 (the whole output)
function dominant(pcm) {
  const power = (hz) => { let re = 0, im = 0; const n = pcm.length >> 1; for (let i = 0; i < n; i++) { const x = pcm.readInt16LE(i * 2); re += x * Math.cos(2 * Math.PI * hz * i / 16000); im += x * Math.sin(2 * Math.PI * hz * i / 16000); } return re * re + im * im; };
  return power(440) > power(1000) ? 440 : 1000;
}

test('captureHelperSpec: found next to the build output or in the packaged app, per OS', () => {
  const has = (set) => (p) => set.includes(p);
  const mac = captureHelperSpec('darwin', { roots: ['/b', '/r'], exists: has(['/r/bin/whisperbrain-tap']) });
  assert.deepEqual([mac.command, mac.prefixArgs], ['/r/bin/whisperbrain-tap', []]);
  assert.equal(captureHelperSpec('darwin', { roots: ['/b'], exists: has(['/b/tap/whisperbrain-tap']) }).file, path.join('/b', 'tap/whisperbrain-tap'));
  const win = captureHelperSpec('win32', { roots: ['/b'], exists: has([path.join('/b', 'loopback/whisperbrain-loopback.exe')]) });
  assert.ok(win.command.endsWith('whisperbrain-loopback.exe'));
  assert.equal(captureHelperSpec('darwin', { roots: ['/b'], exists: () => false }), null);
  assert.equal(captureHelperSpec('linux', { roots: ['/b'], exists: () => true }), null);
});

test('systemArgs: follow a process by pid, or by program name where only that is known, else the whole output', () => {
  assert.deepEqual(systemArgs({ pid: 4242, name: 'Zoom' }), ['system', '--pid', '4242']);
  assert.deepEqual(systemArgs({ pid: null, exe: 'Zoom.exe' }), ['system', '--exe', 'Zoom.exe']);
  assert.deepEqual(systemArgs({ pid: 7, exe: 'Zoom.exe' }), ['system', '--pid', '7'], 'a pid is the surer way');
  assert.deepEqual(systemArgs(undefined), ['system']);
  assert.deepEqual(systemArgs({ name: 'Zoom' }), ['system']);
  assert.deepEqual(systemArgs({ pid: 'x; rm', exe: 'a b;c.exe' }), ['system'], 'anything that is not a number or a plain program name is not passed on');
});

test('macOS: native system capture needs the helper and macOS 14.2 (Darwin 23.2); otherwise the renderer, as before', async () => {
  const caps = (o) => darwin.create({ captureHelper: spec, osRelease: '23.4.0', ...o }).capture;
  assert.deepEqual(caps({}), { mic: 'renderer', system: 'native' });
  assert.deepEqual(caps({ osRelease: '23.2.0' }), { mic: 'renderer', system: 'native' });
  assert.deepEqual(caps({ osRelease: '23.1.0' }), { mic: 'renderer', system: 'renderer' }, 'macOS 14.1');
  assert.deepEqual(caps({ captureHelper: null }), { mic: 'renderer', system: 'renderer' });
  assert.equal(await darwin.create({ captureHelper: null }).createSystemSource({ app: { pid: 1 } }), null, 'the renderer captures it');
});

test('windows: native system capture whenever the helper is there', () => {
  assert.deepEqual(win32.create({ captureHelper: spec }).capture, { mic: 'renderer', system: 'native' });
  assert.deepEqual(win32.create({}).capture, { mic: 'renderer', system: 'renderer' });
});

test('a helper that follows the application: its audio arrives, and the source says what it captures', async () => {
  const src = await darwin.create({ captureHelper: spec, osRelease: '23.4.0' }).createSystemSource({ app: { pid: 4242, name: 'Zoom' } });
  assert.deepEqual([src.capture.mode, src.capture.app], ['app', 'Zoom']);
  const pcm = await pcmOf(src);
  assert.ok(pcm.length >= 16000, `a second of audio arrived (${pcm.length} bytes)`);
  assert.equal(dominant(pcm), 440, 'the route that follows the application answered');
});

test('without an application the helper captures the whole output', async () => {
  const src = await win32.create({ captureHelper: spec }).createSystemSource({});
  assert.equal(src.capture.mode, 'output');
  assert.equal(dominant(await pcmOf(src)), 1000);
});

test('if the helper cannot follow the application (or it quits) the capture carries on with the whole output', async () => {
  for (const [platform, app] of [[darwin.create({ captureHelper: spec, osRelease: '23.4.0' }), { pid: 666, name: 'Zoom' }], [win32.create({ captureHelper: spec }), { exe: 'broken.exe', name: 'Zoom' }]]) {
    const src = await platform.createSystemSource({ app });
    const modes = [];
    src.on('capture', (c) => modes.push(c.mode));
    const pcm = await pcmOf(src);
    assert.deepEqual(modes, ['output']);
    assert.equal(dominant(pcm), 1000, 'the audio came from the whole-output route');
  }
});
