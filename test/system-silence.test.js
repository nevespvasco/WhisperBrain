'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RecordingManager } = require('../src/recording/manager');

// watchSystemSilence only needs the platform id and the bus, so it is exercised without a whole manager
function watcher(platformId) {
  const sent = [];
  const self = { platform: { id: platformId }, bus: { publish: (type, d) => sent.push([type, d]) } };
  return { sent, feed: (a, level) => RecordingManager.prototype.watchSystemSilence.call(self, a, level) };
}
const withClock = (t, fn) => { const real = Date.now; let now = 1_000_000; Date.now = () => now; t.after(() => { Date.now = real; }); return fn((ms) => { now += ms; }); };

test('macOS: 30 s of nothing on the system channel warns once, with the permission to check', (t) => withClock(t, (tick) => {
  const w = watcher('darwin'), a = { warnings: [] };
  w.feed(a, 0); tick(29000); w.feed(a, 0);
  assert.equal(w.sent.length, 0);
  tick(2000); w.feed(a, 0); w.feed(a, 0); tick(60000); w.feed(a, 0);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0][0], 'recording.warning');
  assert.match(w.sent[0][1].message, /System Audio Recording Only/);
  assert.equal(a.warnings.length, 1);
}));

test('macOS: any sound on the system channel means it works, so there is never a warning', (t) => withClock(t, (tick) => {
  const w = watcher('darwin'), a = { warnings: [] };
  w.feed(a, 0); tick(5000); w.feed(a, 0.02); tick(120000); w.feed(a, 0);
  assert.equal(w.sent.length, 0);
}));

test('other systems are not told about macOS permissions', (t) => withClock(t, (tick) => {
  for (const id of ['linux', 'win32']) {
    const w = watcher(id), a = { warnings: [] };
    w.feed(a, 0); tick(120000); w.feed(a, 0);
    assert.equal(w.sent.length, 0, id);
  }
}));
