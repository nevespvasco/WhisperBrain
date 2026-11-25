'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSetup } = require('../src/platform/setup');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

const everything = { speech: true, vad: true, speaker: true };
const hasOnly = (...cmds) => async (c) => cmds.includes(c);
const byId = (r, id) => r.items.find((i) => i.id === id);

test('linux without PipeWire: blocked, and the install commands are listed', async () => {
  const r = await buildSetup({ platform: 'linux', caps: { session: 'x11' }, has: hasOnly(), models: everything, llmConfigured: true });
  assert.equal(r.ready, false);
  assert.equal(byId(r, 'pipewire').status, 'missing');
  assert.equal(byId(r, 'pipewire').level, 'required');
  assert.ok(byId(r, 'pipewire').fix.commands.some(([, c]) => /apt install pipewire/.test(c)));
  assert.equal(byId(r, 'ffmpeg').level, 'optional');
});

test('linux with everything: ready, nothing needs attention', async () => {
  const r = await buildSetup({ platform: 'linux', caps: { session: 'x11', paste: true, echoCancel: { available: true } }, has: hasOnly('pw-record', 'pw-dump', 'ffmpeg', 'xclip', 'xprop', 'wmctrl'), models: everything, llmConfigured: true });
  assert.equal(r.ready, true);
  assert.equal(r.attention, 0);
  assert.ok(r.items.every((i) => i.status === 'ok'));
});

test('linux on Wayland asks for wl-clipboard and wtype, not xclip', async () => {
  const r = await buildSetup({ platform: 'linux', caps: { session: 'wayland' }, has: hasOnly('pw-record', 'pw-dump'), models: everything, llmConfigured: true });
  assert.equal(byId(r, 'paste').status, 'missing');
  assert.ok(byId(r, 'paste').fix.commands.every(([, c]) => /wl-clipboard/.test(c)));
  assert.equal(byId(r, 'windows'), undefined);
});

test('missing speech model blocks every system', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const r = await buildSetup({ platform, caps: { session: 'x11' }, has: hasOnly('pw-record', 'pw-dump'), perms: { microphone: 'granted', screen: 'granted' }, models: { speech: false, vad: true, speaker: true }, llmConfigured: true });
    assert.equal(r.ready, false, platform);
    assert.equal(byId(r, 'speech-model').fix.settings, 'audio');
  }
});

test('macOS lists the permissions with what the system reported, and checks the version', async () => {
  const r = await buildSetup({ platform: 'darwin', caps: {}, perms: { microphone: 'denied', screen: 'not-determined', accessibility: false }, models: everything, llmConfigured: true, osRelease: '21.6.0' });
  assert.equal(byId(r, 'macos-version').status, 'missing');
  assert.equal(byId(r, 'permission-mic').status, 'missing');
  assert.match(byId(r, 'permission-mic').fix.text, /Privacy & Security → Microphone/);
  assert.equal(byId(r, 'permission-system').status, 'unknown');
  assert.equal(byId(r, 'permission-accessibility').status, 'missing');
  assert.equal(byId(r, 'pipewire'), undefined);
  assert.ok(byId(r, 'ffmpeg').fix.commands[0][1].startsWith('brew '));
  const ok = await buildSetup({ platform: 'darwin', caps: {}, perms: { microphone: 'granted', screen: 'granted', accessibility: true }, models: everything, llmConfigured: true, osRelease: '24.1.0' });
  assert.equal(ok.ready, true);
});

test('a permission macOS has not asked about yet does not block', async () => {
  const r = await buildSetup({ platform: 'darwin', caps: {}, perms: { microphone: 'not-determined' }, models: everything, llmConfigured: true, osRelease: '24.1.0' });
  assert.equal(byId(r, 'permission-mic').status, 'unknown');
  assert.equal(r.ready, true);
});

test('Windows needs the microphone switch and offers winget for ffmpeg', async () => {
  const r = await buildSetup({ platform: 'win32', caps: {}, perms: { microphone: 'denied' }, models: everything, llmConfigured: true });
  assert.equal(r.ready, false);
  assert.match(byId(r, 'permission-mic').fix.text, /Privacy & security/);
  assert.ok(byId(r, 'ffmpeg').fix.commands[0][1].startsWith('winget '));
});

test('items come ordered: required first, optional last', async () => {
  const r = await buildSetup({ platform: 'linux', caps: { session: 'x11' }, has: hasOnly(), models: { speech: false, vad: false, speaker: false }, llmConfigured: false });
  const rank = { required: 0, recommended: 1, optional: 2 };
  const ranks = r.items.map((i) => rank[i.level]);
  assert.deepEqual(ranks, [...ranks].sort());
});

test('GET /api/setup answers, with the host permissions passed through', async (t) => {
  const dataDir = tmpDir('wb-setup-');
  const platform = { id: 'darwin', session: 'aqua', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'darwin', session: 'aqua', notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null };
  const app = createApp({ dataDir, platform, version: 'test', permissions: () => ({ microphone: 'denied' }) });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const res = await fetch(`http://127.0.0.1:${port}/api/setup`, { headers: { Cookie: `wb_token=${token}` } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.platform, 'darwin');
  assert.equal(j.items.find((i) => i.id === 'permission-mic').status, 'missing');
  assert.equal(j.ready, false);
});
