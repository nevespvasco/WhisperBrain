'use strict';
// The app's own API for the meeting window readers: status, pairing and signals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

async function boot(t) {
  const dataDir = tmpDir('wb-meetapi-');
  const app = createApp({ dataDir, platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return {}; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null }, version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { app, call };
}

test('api: signals sent to the app reach the hub and show in the status', async (t) => {
  const { app, call } = await boot(t);
  const seen = [];
  app.meet.hub.on('signal', (s) => seen.push(s));
  const r = await call('POST', '/api/meet/signals', { source: 'script', kind: 'a11y', messages: [{ type: 'speaker', name: 'Ana' }, { type: 'roster', participants: ['Ana', 'Bruno'] }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).accepted, 2);
  assert.deepEqual(seen.map((s) => [s.msg.type, s.source, s.kind, s.lagMs]), [['speaker', 'script', 'a11y', 500], ['roster', 'script', 'a11y', 500]]);
  const st = await (await call('GET', '/api/meet/status')).json();
  assert.equal(st.sources.find((s) => s.id === 'script').state, 'connected');
  assert.equal(st.extension.listening, false);
});

test('api: nonsense is a 400, and the pairing code waits for the extension to be switched on', async (t) => {
  const { app, call } = await boot(t);
  assert.equal((await call('POST', '/api/meet/signals', { type: 'bogus' })).status, 400);
  assert.equal((await call('GET', '/api/meet/pairing')).status, 409);
  const m = app.settings.get('meet');
  app.settings.update({ meet: { ...m, extension: true, port: 53000 + Math.floor(Math.random() * 2000) } });
  await app.meet.sync();
  const p = await (await call('GET', '/api/meet/pairing')).json();
  assert.match(p.code, /^wb1\./);
  const again = await (await call('POST', '/api/meet/pairing/reset')).json();
  assert.notEqual(again.code, p.code);
});

test('api: the pairing secret never travels in the settings', async (t) => {
  const { app, call } = await boot(t);
  await app.meet.sync();
  const s = await (await call('GET', '/api/settings')).json();
  assert.equal(s.meet.token, '********');
});

test('api: the browser launchers can be switched on and off (the module is a stand-in: the real home folder is not touched)', async (t) => {
  const { app, call } = await boot(t);
  const state = { 'google-chrome.desktop': 'off' };
  app.meet.platformId = 'linux';
  app.meet.launcher = {
    browsers: () => Object.entries(state).map(([file, s]) => ({ file, name: 'Google Chrome', state: s })),
    enable: (f) => { if (!(f in state)) throw new Error('that browser was not found'); state[f] = 'on'; return { file: f, state: 'on' }; },
    disable: (f) => { if (state[f] !== 'on') throw new Error('that launcher is not one WhisperBrain made'); state[f] = 'off'; return true; },
  };
  assert.deepEqual((await (await call('GET', '/api/meet/browsers')).json()).map((b) => b.state), ['off']);
  assert.equal((await call('POST', '/api/meet/browsers/google-chrome.desktop/enable')).status, 200);
  assert.equal(state['google-chrome.desktop'], 'on');
  assert.equal((await (await call('POST', '/api/meet/browsers/google-chrome.desktop/disable')).json()).removed, true);
  assert.equal((await call('POST', '/api/meet/browsers/nope.desktop/enable')).status, 409);
  assert.equal((await call('POST', '/api/meet/browsers/..%2F..%2Fetc%2Fpasswd/enable')).status, 400, 'a path is not a launcher name');
  app.meet.platformId = 'darwin';
  assert.deepEqual(await (await call('GET', '/api/meet/browsers')).json(), [], 'only Linux needs this');
});

test('a11y source: it runs while a recording does, and only if the settings allow it', async (t) => {
  const { app } = await boot(t);
  const started = [];
  app.meet.a11y.start = () => { started.push('start'); return true; };
  app.meet.a11y.stop = () => { started.push('stop'); };
  const off = app.meet.watch(app.bus);
  t.after(off);
  app.bus.publish('recording.started', { noteId: 'n' });
  app.bus.publish('recording.finalizing', { noteId: 'n' });
  app.bus.publish('recording.stopped', { noteId: 'n' });
  assert.deepEqual(started, ['start', 'stop', 'stop']);
  started.length = 0;
  app.settings.update({ meet: { ...app.settings.get('meet'), a11y: false } });
  app.bus.publish('recording.started', { noteId: 'n' });
  assert.deepEqual(started, [], 'switched off: the other program\'s window is not read');
  app.settings.update({ meet: { ...app.settings.get('meet'), a11y: true, enabled: false } });
  app.bus.publish('recording.started', { noteId: 'n' });
  assert.deepEqual(started, []);
});

test('api: the status says whether a helper exists and whether the selectors were checked', async (t) => {
  const { call } = await boot(t);
  const st = await (await call('GET', '/api/meet/status')).json();
  assert.equal(typeof st.a11y.available, 'boolean');
  assert.equal(st.a11y.selectorsVerified, false, 'the shipped selectors are a guess until someone checks them against a real call');
  assert.ok(st.platform);
});

test('api: the extension folder is found and can be shown in the file manager', async (t) => {
  const dataDir = tmpDir('wb-meetreveal-');
  const opened = [];
  const app = createApp({ dataDir, openExternal: async (u) => { opened.push(u); }, platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return {}; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null }, version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = (m, p) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { Cookie: `wb_token=${token}` } });
  const dir = app.meet.extensionDir();
  assert.ok(dir && fs.existsSync(path.join(dir, 'manifest.json')), 'the shipped extension is there');
  const r = await call('POST', '/api/meet/extension/reveal');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).path, dir);
  assert.match(opened[0], /^file:\/\/.*extension\/meet$/);
  assert.equal((await (await call('GET', '/api/meet/status')).json()).extension.dir, dir);
  // headless (no way to open a folder): the answer says where it is
  app.openExternal = null;
  const none = await call('POST', '/api/meet/extension/reveal');
  assert.equal(none.status, 409);
  assert.match((await none.json()).error, /extension\/meet/);
});
