'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');
const { isEcho } = require('../src/audio/echo');

// A scripted engine: tests decide which segments come back and when.
class FakeEngine extends EventEmitter {
  constructor() { super(); this.fed = []; this.flushed = []; this.resets = []; this.started = null; }
  async start(model, opts) { this.started = { model, opts }; }
  feed(ch, pcm) { this.fed.push([ch, pcm.length]); }
  async flush(ch) { this.flushed.push(ch); }
  reset(ch) { this.resets.push(ch); }
}

function setup({ capture = { mic: 'renderer', system: 'renderer' }, model = { id: 'm' }, vad = true, platform: extra = {} } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const engine = new FakeEngine();
  const models = { resolve: () => model, vadInstalled: () => vad, vadPath: () => '/vad.onnx' };
  const platform = { capture, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource(), ...extra };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus });
  return { db, bus, events, notes, settings, engine, mgr };
}
const pcm = (ms) => Buffer.alloc((ms * 16 * 2));

test('start requires an installed model', async () => {
  const { mgr, notes } = setup({ model: null });
  const n = notes.create({});
  await assert.rejects(mgr.start(n.id), (e) => e.code === 'no-model');
  assert.equal(mgr.status().active, false, 'a failed start must release the slot');
});

test('only one recording at a time; unknown note rejected', async () => {
  const { mgr, notes } = setup();
  await assert.rejects(mgr.start('nope'), (e) => e.code === 'not-found');
  const a = notes.create({}), b = notes.create({});
  await mgr.start(a.id);
  await assert.rejects(mgr.start(b.id), (e) => e.code === 'busy');
  await mgr.stop();
});

test('renderer channels ask the UI to capture; pushed PCM reaches the engine', async () => {
  const { mgr, notes, engine, events } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  assert.deepEqual(events.find((e) => e.type === 'capture.request').data.channels, ['mic', 'system']);
  assert.equal(mgr.pushPcm(n.id, 'mic', pcm(100)), true);
  assert.equal(mgr.pushPcm('other', 'mic', pcm(100)), false);
  assert.deepEqual(engine.fed, [['mic', 3200]]);
  await mgr.stop();
});

test('segments are stored with speaker labels and offset by the channel start', async () => {
  const { mgr, notes, engine } = setup();
  const n = notes.create({});
  await mgr.start(n.id, { system: false });
  await new Promise((r) => setTimeout(r, 30));
  mgr.pushPcm(n.id, 'mic', pcm(100));
  engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 900, text: 'hello there' });
  const [seg] = notes.segments(n.id);
  assert.equal(seg.speaker, 'me');
  assert.equal(seg.channel, 'mic');
  assert.equal(seg.text, 'hello there');
  assert.ok(seg.startMs >= 0 && seg.endMs - seg.startMs === 900);
  const done = await mgr.stop();
  assert.equal(done.note.status, 'done');
  assert.ok(done.note.endedAt >= done.note.startedAt);
});

test('pause flushes + resets channels and the timeline skips the paused time', async () => {
  const { mgr, notes, engine } = setup();
  const n = notes.create({});
  await mgr.start(n.id, { system: false });
  mgr.pushPcm(n.id, 'mic', pcm(100));
  await mgr.pause();
  assert.deepEqual(engine.flushed, ['mic']);
  assert.deepEqual(engine.resets, ['mic']);
  mgr.pushPcm(n.id, 'mic', pcm(100)); // dropped while paused
  assert.equal(engine.fed.length, 1);
  await new Promise((r) => setTimeout(r, 120)); // paused wall time must not count
  mgr.resume();
  mgr.pushPcm(n.id, 'mic', pcm(100));
  assert.equal(engine.fed.length, 2);
  assert.ok(mgr.elapsed() < 100, `elapsed ${mgr.elapsed()} should exclude the paused 120ms`);
  await mgr.stop();
});

test('echo: a mic segment repeating the system channel is dropped, and a late system segment removes the mic one', async () => {
  const { mgr, notes, engine, events } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  mgr.pushPcm(n.id, 'mic', pcm(100));
  mgr.pushPcm(n.id, 'system', pcm(100));
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 3000, text: 'we should ship the release on friday afternoon' });
  engine.emit('segment', { ch: 'mic', startMs: 100, endMs: 3100, text: 'we should ship the release on friday' });
  assert.equal(notes.segments(n.id).length, 1, 'echo dropped');
  engine.emit('segment', { ch: 'mic', startMs: 10000, endMs: 12000, text: 'sounds good to me honestly' });
  engine.emit('segment', { ch: 'system', startMs: 10200, endMs: 12100, text: 'sounds good to me honestly' });
  const rows = notes.segments(n.id);
  assert.deepEqual(rows.map((r) => r.speaker), ['them', 'them']);
  assert.ok(events.some((e) => e.type === 'transcript.removed'));
  await mgr.stop();
});

test('isEcho needs real overlap and enough words', () => {
  const t = (text, startMs, endMs) => ({ text, startMs, endMs });
  assert.equal(isEcho(t('yes', 0, 500), t('yes', 0, 500)), false, 'too short to judge');
  assert.equal(isEcho(t('totally different words here', 0, 2000), t('we should ship it friday', 0, 2000)), false);
  assert.equal(isEcho(t('we should ship it friday', 60000, 62000), t('we should ship it friday', 0, 2000)), false, 'far apart in time');
});

test('a native source failure on one channel degrades to the other with a warning', async () => {
  const { mgr, notes, events, db, bus, settings, engine } = setup({ capture: { mic: 'native', system: 'native' } });
  mgr.platform.createSystemSource = async () => { throw new Error('no sink'); };
  const n = notes.create({});
  const st = await mgr.start(n.id);
  assert.deepEqual(st.channels, ['mic']);
  assert.ok(events.some((e) => e.type === 'recording.warning' && /no sink/.test(e.data.message)));
  await mgr.stop();
});

test('recording again on a note continues its timeline instead of overlapping the old transcript', async () => {
  const { mgr, notes, engine } = setup();
  const n = notes.create({});
  notes.addSegments(n.id, [{ speaker: 'me', startMs: 0, endMs: 60000, text: 'earlier session' }]);
  await mgr.start(n.id, { system: false });
  mgr.pushPcm(n.id, 'mic', pcm(100));
  engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 1000, text: 'later session' });
  const later = notes.segments(n.id).find((s) => s.text === 'later session');
  assert.ok(later.startMs > 60000, `startMs ${later.startMs} should follow the 60 s already transcribed`);
  await mgr.stop();
});

// ---- which application the system channel follows (per-app capture) ----
function followRig({ apps, setting } = {}) {
  const calls = { system: [], activity: 0 };
  const platform = {
    async createSystemSource(opts) { calls.system.push(opts); const src = new PushSource(); src.capture = { mode: opts?.app ? 'app' : 'output', app: opts?.app?.name, reason: '' }; return src; },
    async micActivity() { calls.activity++; return { supported: true, active: !!apps?.length, apps: apps || [] }; },
  };
  const rig = setup({ capture: { mic: 'native', system: 'native' }, platform });
  if (setting !== undefined) rig.settings.update({ perAppCapture: setting });
  return { ...rig, calls };
}
const ZOOM = { name: 'Zoom', appId: 'zoom', weak: false, pid: 4242, binary: 'zoom' };
const start = async ({ mgr, notes }, opts) => { const n = notes.create({}); await mgr.start(n.id, { mic: false, ...opts }); return n; };

test('system capture follows the application the caller names (an automatic start knows it)', async () => {
  const r = followRig({ apps: [] });
  await start(r, { app: ZOOM });
  assert.deepEqual(r.calls.system, [{ app: ZOOM }]);
  await r.mgr.stop();
});

test('without one, it follows the single confident meeting app that holds the microphone', async () => {
  const r = followRig({ apps: [ZOOM] });
  await start(r);
  assert.deepEqual(r.calls.system, [{ app: ZOOM }]);
  await r.mgr.stop();
});

test('a weak guess, several candidates, or nothing: the whole output, never a guess', async () => {
  for (const apps of [[{ name: 'Some tab', appId: 'browser', weak: true, pid: 1 }], [ZOOM, { name: 'Discord', appId: 'discord', weak: false, pid: 2 }], []]) {
    const r = followRig({ apps });
    await start(r);
    assert.deepEqual(r.calls.system, [{ app: undefined }], JSON.stringify(apps.map((a) => a.name)));
    await r.mgr.stop();
  }
});

test('the setting can turn per-app capture off: the whole output, and nobody is asked who is on the call', async () => {
  const r = followRig({ apps: [ZOOM], setting: false });
  await start(r, { app: ZOOM });
  assert.deepEqual(r.calls.system, [{ app: undefined }]);
  assert.equal(r.calls.activity, 0);
  await r.mgr.stop();
});

test('what the system channel is capturing is reported, and so is a change (the app stopped playing)', async () => {
  const r = followRig({ apps: [ZOOM] });
  const n = await start(r);
  assert.deepEqual(r.events.find((e) => e.type === 'recording.started').data.systemCapture, { mode: 'app', app: 'Zoom', reason: '' });
  const src = r.mgr.active.channels.system;
  src.capture = { mode: 'output', reason: 'the application stopped playing: capturing the whole output' };
  src.emit('capture', src.capture);
  const ev = r.events.find((e) => e.type === 'recording.system-capture');
  assert.deepEqual([ev.data.noteId, ev.data.mode], [n.id, 'output']);
  assert.ok(r.events.some((e) => e.type === 'recording.warning' && /whole output/.test(e.data.message)), 'and the person is told');
  await r.mgr.stop();
});
