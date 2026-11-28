'use strict';
// The OS sandbox around the page stays on wherever it can run (docs/packaging.md §3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { relaunchOptions } = require('../electron/updates');
const { ROOT } = require('./helpers');

const cfg = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
// the block of a top-level key, up to the next top-level key
const block = (key) => (new RegExp(`^${key}:\\n((?:[ #].*\\n|\\n)*)`, 'm').exec(cfg) || [])[1] || '';

test('packaging: --no-sandbox is not written into the .deb launcher', () => {
  assert.ok(block('linux'), 'electron-builder.yml has a linux section');
  assert.doesNotMatch(block('linux'), /^\s*executableArgs:.*no-sandbox/m, 'linux.executableArgs reaches every Linux target, the .deb included');
  assert.doesNotMatch(block('deb'), /no-sandbox/);
});

test('packaging: the AppImage launcher decides by itself (its AppRun adds --no-sandbox only when user namespaces do not work)', () => {
  assert.match(block('appImage'), /^\s*executableArgs: \[\]/m, 'without it, electron-builder writes --no-sandbox into the AppImage desktop entry');
});

test('update relaunch on Linux starts the AppImage again without forcing --no-sandbox', () => {
  assert.deepEqual(relaunchOptions({ platform: 'linux', env: { APPIMAGE: '/home/a/WhisperBrain.AppImage' } }), { execPath: '/home/a/WhisperBrain.AppImage', args: [] });
  assert.equal(relaunchOptions({ platform: 'linux', env: {} }), null, 'not an AppImage: nothing to relaunch');
  assert.equal(relaunchOptions({ platform: 'win32', env: { APPIMAGE: 'x' } }), null, 'Windows: the installer starts the new version');
  assert.equal(relaunchOptions({ platform: 'darwin', env: {} }), null);
});

test('npm start keeps working on Linux: the dev copy of Electron has no setuid sandbox helper', () => {
  const start = fs.readFileSync(path.join(ROOT, 'scripts/start.js'), 'utf8');
  assert.match(start, /process\.platform === 'linux' \? \['--no-sandbox'\]/);
});
