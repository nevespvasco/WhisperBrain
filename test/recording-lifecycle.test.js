'use strict';
// The recording's life when things happen at the wrong moment: Stop while it is still starting, Resume while a pause is still
// flushing, a speech engine that dies mid-meeting, a capture process that exits, a quit or a crash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');

const later = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const pcm = (ms) => Buffer.alloc(ms * 32);

// An engine whose steps a test can hold: `gate.start` / `gate.flush` are promises the call waits on when set.
class FakeEngine extends EventEmitter {
  constructor() { super(); this.log = []; this.gate = {}; }
  async start() { this.log.push('start'); if (this.gate.start) await this.gate.start; }
  feed(ch, buf) { this.log.push(`feed:${ch}:${buf.length}`); }
  async flush(ch) { this.log.push(`flush:${ch}`); if (this.gate.flush) await this.gate.flush; }
  reset(ch) { this.log.push(`reset:${ch}`); }
}

// A native source that remembers whether it was stopped.
class Native extends EventEmitter { constructor() { super(); this.stopped = false; this.started = false; } start() { this.started = true; } stop() { this.stopped = true; } }

function rig({ capture = { mic: 'renderer', system: 'renderer' }, platform: extra = {}, discord = null, settings: s = {} } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ echoDedupe: false, ...s });
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx' };
  const platform = { capture, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource(), ...extra };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, discord });
  return { db, bus, events, notes, settings, engine, mgr };
}

// ---- Stop while Start is still waiting ----
test('stop while the engine is still loading: the start is cancelled, nothing is left running, the note is not "recording"', async () => {
  const r = rig({ capture: { mic: 'native', system: 'renderer' } });
  const mics = [];
  r.mgr.platform.createMicSource = () => { const m = new Native(); mics.push(m); return m; };
  const n = r.notes.create({});
  const gate = later();
  r.engine.gate.start = gate.p;
  const starting = r.mgr.start(n.id);
  const stopping = r.mgr.stop();
  gate.resolve();
  await assert.rejects(starting, (e) => e.code === 'cancelled');
  const out = await stopping;
  assert.equal(out.cancelled, true);
  assert.equal(r.mgr.status().active, false);
  assert.notEqual(r.notes.get(n.id).status, 'recording');
  assert.ok(mics.every((m) => m.stopped), 'a source opened meanwhile is closed');
  assert.ok(!r.events.some((e) => e.type === 'recording.started'));
  // and the slot is free again
  await r.mgr.start(n.id);
  await r.mgr.stop();
  assert.equal(r.notes.get(n.id).status, 'done');
});

test('stop while the microphone (echo cancellation) is still opening: the microphone is closed once it arrives', async () => {
  const gate = later();
  const mic = new Native();
  const r = rig({ capture: { mic: 'native', system: 'renderer' }, platform: { openMicSource: async () => { await gate.p; return mic; } } });
  const n = r.notes.create({});
  const starting = r.mgr.start(n.id);
  await tick(5);
  const stopping = r.mgr.stop();
  gate.resolve();
  await assert.rejects(starting, (e) => e.code === 'cancelled');
  await stopping;
  assert.equal(mic.stopped, true);
  assert.equal(mic.started, false, 'it never started capturing');
  assert.notEqual(r.notes.get(n.id).status, 'recording');
});

test('stop while the Discord bot is joining: the bot leaves again', async () => {
  const gate = later();
  const discord = new EventEmitter();
  let left = 0;
  discord.join = async () => { await gate.p; return { channel: 'General' }; };
  discord.leave = () => { left++; };
  const r = rig({ discord, settings: { discord: { enabled: true, token: 't', userId: 'u1' } } });
  const n = r.notes.create({});
  const starting = r.mgr.start(n.id);
  await tick(5);
  const stopping = r.mgr.stop();
  gate.resolve();
  await assert.rejects(starting, (e) => e.code === 'cancelled');
  await stopping;
  assert.equal(left, 1);
  assert.equal(discord.listenerCount('audio'), 0);
});

test('the microphone opens while the Discord bot joins, not after it', async () => {
  const gate = later();
  const order = [];
  const discord = new EventEmitter();
  discord.join = async () => { order.push('join'); await gate.p; order.push('joined'); return null; };
  discord.leave = () => {};
  const r = rig({ discord, capture: { mic: 'native', system: 'renderer' }, settings: { discord: { enabled: true, token: 't' } }, platform: { openMicSource: async () => { order.push('mic'); return new Native(); } } });
  const n = r.notes.create({});
  const starting = r.mgr.start(n.id);
  await tick(5);
  assert.ok(order.includes('mic'), `the microphone did not wait for the bot: ${order}`);
  gate.resolve();
  await starting;
  await r.mgr.stop();
});

test('a failing Discord join or a speaker test that cannot run still closes a microphone opened in parallel', async () => {
  const mic = new Native();
  const discord = new EventEmitter();
  discord.join = async () => null; // not in a voice channel
  discord.leave = () => {};
  const r = rig({ discord, capture: { mic: 'native', system: 'renderer' }, settings: { discord: { enabled: true, token: 't' } }, platform: { openMicSource: async () => mic } });
  const n = r.notes.create({});
  await assert.rejects(r.mgr.start(n.id, { speakerTest: true }), (e) => e.code === 'no-discord');
  await tick(5);
  assert.equal(mic.stopped, true);
});

// ---- Resume while the pause is still flushing ----
test('resume during a pause that is still flushing waits for it: audio is never fed into a channel about to be reset', async () => {
  const r = rig();
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.mgr.pushPcm(n.id, 'mic', pcm(100));
  const gate = later();
  r.engine.gate.flush = gate.p;
  const pausing = r.mgr.pause();
  const resuming = r.mgr.resume();
  r.mgr.pushPcm(n.id, 'mic', pcm(50)); // still settling: this must not reach the engine
  assert.equal(r.engine.log.filter((x) => x.startsWith('feed')).length, 1);
  gate.resolve();
  r.engine.gate.flush = null;
  await pausing;
  await resuming;
  assert.equal(r.mgr.status().paused, false);
  r.mgr.pushPcm(n.id, 'mic', pcm(50));
  const log = r.engine.log;
  assert.ok(log.indexOf('reset:mic') < log.lastIndexOf('feed:mic:1600'), `the reset comes before new audio: ${log}`);
  await r.mgr.stop();
});

test('stop during a pause that is still flushing waits for it and finishes the note', async () => {
  const r = rig();
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  const gate = later();
  r.engine.gate.flush = gate.p;
  const pausing = r.mgr.pause();
  const stopping = r.mgr.stop();
  await tick(5);
  gate.resolve();
  await pausing;
  const out = await stopping;
  assert.equal(out.note.status, 'done');
});

