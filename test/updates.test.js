'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { supported, createUpdates } = require('../electron/updates');
const { Settings } = require('../src/core/settings');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { ROOT } = require('./helpers');

test('updates apply to the Windows installer and the Linux AppImage only', () => {
  assert.equal(supported({ platform: 'win32', packaged: true, env: {} }), true);
  assert.equal(supported({ platform: 'win32', packaged: true, env: { PORTABLE_EXECUTABLE_FILE: 'C:/x.exe' } }), false, 'portable build has nothing to replace');
  assert.equal(supported({ platform: 'linux', packaged: true, env: { APPIMAGE: '/home/a/WhisperBrain.AppImage' } }), true);
  assert.equal(supported({ platform: 'linux', packaged: true, env: {} }), false, '.deb belongs to the package manager');
  assert.equal(supported({ platform: 'darwin', packaged: true, env: {} }), false, 'unsigned macOS builds cannot self-update');
  assert.equal(supported({ platform: 'win32', packaged: false, env: {} }), false, 'a development run never updates');
});

function rig(over = {}) {
  const updater = Object.assign(new EventEmitter(), { checks: 0, async checkForUpdates() { this.checks++; if (over.checkFails) { const e = new Error('offline\n    at stack'); this.emit('error', e); throw e; } } });
  const calls = { notify: [], ask: [], restart: 0, timers: [] };
  const state = { enabled: true, busy: false, answer: true };
  const u = createUpdates({
    updater, enabled: () => state.enabled, busy: () => state.busy,
    notify: (t, b) => calls.notify.push([t, b]),
    ask: async (v) => { calls.ask.push(v); return state.answer; },
    restart: async () => { calls.restart++; },
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; calls.timers.push(t); return t; },
    clearTimer: () => {},
    ...over.opts,
  });
  return { u, updater, calls, state };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the updater is set up so that WhisperBrain, not electron-updater, decides when to install', () => {
  const { updater } = rig();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test('first check after 30 s, then every 6 hours; with the setting off nothing is contacted', async () => {
  const { u, updater, calls, state } = rig();
  u.start();
  assert.equal(calls.timers[0].ms, 30000);
  await calls.timers[0].fn();
  assert.equal(updater.checks, 1);
  assert.equal(calls.timers[1].ms, 6 * 3600 * 1000);
  state.enabled = false;
  await calls.timers[1].fn();
  assert.equal(updater.checks, 1, 'switched off: no request');
  assert.equal(calls.timers.length, 3, 'but the schedule goes on, in case it is switched on again');
});

test('a downloaded update asks to restart; yes restarts, later does not', async () => {
  const a = rig();
  a.u.start();
  a.updater.emit('update-downloaded', { version: '0.5.0' });
  await tick();
  assert.deepEqual(a.calls.ask, ['0.5.0']);
  assert.equal(a.calls.restart, 1);

  const b = rig();
  b.state.answer = false;
  b.updater.emit('update-downloaded', { version: '0.5.0' });
  await tick();
  assert.equal(b.calls.restart, 0);
  await b.u.check(); // next check: already downloaded, asks again without contacting GitHub
  await tick();
  assert.equal(b.updater.checks, 0);
  assert.equal(b.calls.ask.length, 2);
});

test('never restarts during a recording: says so, then offers again when it ends', async () => {
  const { u, updater, calls, state } = rig();
  state.busy = true;
  updater.emit('update-downloaded', { version: '0.5.0' });
  await tick();
  assert.equal(calls.ask.length, 0);
  assert.equal(calls.restart, 0);
  assert.match(calls.notify[0][1], /0\.5\.0.*recording ends/);
  state.busy = false;
  await u.offer();
  assert.equal(calls.ask.length, 1);
  assert.equal(calls.restart, 1);
});

test('only one question at a time', async () => {
  let release; const asked = [];
  const { updater } = rig({ opts: { ask: (v) => new Promise((r) => { asked.push(v); release = r; }) } });
  updater.emit('update-downloaded', { version: '0.5.0' });
  updater.emit('update-downloaded', { version: '0.5.0' });
  await tick();
  assert.equal(asked.length, 1);
  release(false);
});

test('manual check says the result; automatic checks stay quiet', async () => {
  const { u, updater, calls } = rig();
  await u.check({ byHand: true });
  updater.emit('update-not-available');
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0][0], /up to date/);
  await u.check();
  updater.emit('update-not-available');
  assert.equal(calls.notify.length, 1, 'the automatic one did not notify');
});

test('a failed check is logged, never thrown; a manual one tells the person', async () => {
  const logs = [];
  const { u, calls } = rig({ checkFails: true, opts: { log: (l, m) => logs.push([l, m]) } });
  await u.check();
  assert.equal(calls.notify.length, 0);
  await u.check({ byHand: true });
  assert.equal(calls.notify.length, 1);
  assert.deepEqual(logs, [['error', 'update check failed: offline'], ['error', 'update check failed: offline']], 'one line each, no stack, no duplicate');
});

test('the setting defaults to on, is a boolean and the UI toggle is wired', () => {
  const s = new Settings(open(':memory:'), new Bus());
  assert.equal(s.get('checkUpdates'), true);
  assert.equal(s.update({ checkUpdates: false }).checkUpdates, false);
  const ui = fs.readFileSync(path.join(ROOT, 'ui/views/settings.js'), 'utf8');
  assert.match(ui, /'set-updates': \(v\) => \(\{ checkUpdates: v \}\)/);
});

test('release plumbing: the config names the repo, and the workflow uploads the files the updater reads', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(cfg, /publish:\n  provider: github\n  owner: nevespvasco\n  repo: WhisperBrain/);
  assert.match(cfg, /nsis:[\s\S]*artifactName: WhisperBrain-Setup-\$\{version\}\.\$\{ext\}/, 'no spaces: GitHub renames them and latest.yml would point at a missing file');
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  for (const f of ['dist/latest.yml', 'dist/latest-linux.yml', 'dist/*.exe.blockmap']) assert.ok(wf.includes(f), f);
  assert.ok(!wf.includes('latest-mac'), 'both mac builds write latest-mac.yml: not uploaded while macOS cannot self-update');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const k of ['dist', 'dist:linux', 'dist:mac', 'dist:win']) assert.match(pkg.scripts[k], /--publish never/, `${k} must not try to publish by itself`);
  assert.ok(pkg.dependencies['electron-updater']);
});
