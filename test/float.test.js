'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SIZE, shouldShow, placeWithin, defaultBounds } = require('../electron/float');
const { open } = require('../src/core/db');
const { Settings } = require('../src/core/settings');
const { Bus } = require('../src/core/events');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

const front = { minimized: false, visible: true, focused: true };

test('floating recorder shows only while recording, and (by default) only when the app is not in front', () => {
  assert.equal(shouldShow({ recording: false, mode: 'always', main: null }), false, 'nothing to show when not recording');
  assert.equal(shouldShow({ recording: true, mode: 'off', main: null }), false);
  assert.equal(shouldShow({ recording: true, mode: 'background', main: front }), false, 'the in-app bar covers this case');
  assert.equal(shouldShow({ recording: true, mode: 'background', main: { ...front, focused: false } }), true, 'another app is in front');
  assert.equal(shouldShow({ recording: true, mode: 'background', main: { ...front, minimized: true } }), true, 'minimised');
  assert.equal(shouldShow({ recording: true, mode: 'background', main: { ...front, visible: false } }), true, 'hidden to the tray');
  assert.equal(shouldShow({ recording: true, mode: 'background', main: null }), true, 'window closed');
  assert.equal(shouldShow({ recording: true, mode: 'always', main: front }), true);
});

test('floating recorder is kept on a screen, including after a monitor goes away', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 1024 }];
  const d = defaultBounds(screens[0]);
  assert.deepEqual([d.x, d.y, d.width], [1920 - SIZE.collapsed.width - 16, 16, SIZE.collapsed.width]);
  assert.deepEqual(placeWithin({ x: 5000, y: 4000, ...SIZE.expanded }, screens), { x: 3200 - SIZE.expanded.width, y: 1024 - SIZE.expanded.height, ...SIZE.expanded }, 'dragged off the edge is pulled back to the nearest screen');
  assert.deepEqual(placeWithin({ x: 2000, y: 10, ...SIZE.collapsed }, screens).x, 2000, 'a spot on the second monitor is respected');
  assert.deepEqual(placeWithin({ x: 2000, y: 10, ...SIZE.collapsed }, [screens[0]]).x, 1920 - SIZE.collapsed.width, 'second monitor unplugged: back onto the first');
  assert.equal(placeWithin({ x: -300, y: -50, ...SIZE.collapsed }, screens).x, 0);
});

test('setting floatingRecorder is validated and defaults to "background"', () => {
  const s = new Settings(open(':memory:'), new Bus());
  assert.equal(s.get('floatingRecorder'), 'background');
  assert.equal(s.update({ floatingRecorder: 'always' }).floatingRecorder, 'always');
  assert.throws(() => s.update({ floatingRecorder: 'sometimes' }), /off, background or always/);
  assert.equal(s.get('speakerRefine'), true);
  assert.equal(s.get('speakerDiarize'), true);
});

test('the recorder page is served by the app and wired to what the main process offers', async () => {
  const dataDir = tmpDir('wb-float-');
  const core = createApp({ dataDir });
  const server = createServer(core, { uiDir: path.join(ROOT, 'ui') });
  const { url, token } = await server.listen(0);
  try {
    for (const f of ['widget.html', 'widget.js', 'widget.css']) {
      const res = await fetch(`${url}/${f}`, { headers: { 'x-wb-token': token } });
      assert.equal(res.status, 200, f);
    }
    const html = await (await fetch(`${url}/widget.html`, { headers: { 'x-wb-token': token } })).text();
    assert.match(html, /widget\.js/);
    // the page only uses what the preload exposes
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'widget-preload.js'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'ui', 'widget.js'), 'utf8');
    for (const fn of new Set([...page.matchAll(/bridge\??\.(\w+)\(/g)].map((m) => m[1]))) assert.match(preload, new RegExp(`\\b${fn}:`), `preload exposes ${fn}`);
    // and the main process answers each message the preload can send
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    for (const ch of [...preload.matchAll(/send\('([\w:]+)'/g)].map((m) => m[1])) assert.ok(main.includes(`ipcMain.on('${ch}'`), `main handles ${ch}`);
  } finally { await server.close(); core.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
