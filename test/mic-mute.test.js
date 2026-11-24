'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

// An engine that remembers the audio it was given, per channel
class FakeEngine extends EventEmitter {
  constructor() { super(); this.fed = { mic: [], system: [] }; }
  async start() {}
  feed(ch, buf) { (this.fed[ch] ||= []).push(Buffer.from(buf)); }
  async flush() {}
  reset() {}
}
function rig() {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/v', speakerInstalled: () => false };
  const platform = { capture: { mic: 'renderer', system: 'renderer' } };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus });
  const events = [];
  bus.subscribe((e) => events.push(e));
  return { notes, engine, mgr, bus, events };
}
const voice = () => Buffer.alloc(3200, 0x21);      // 100 ms of something that is not silence
const silent = (b) => b.every((x) => x === 0);

test('mute: while muted the microphone reaches nobody (the recognizer gets silence of the same length); the other side is untouched', async () => {
  const { notes, engine, mgr, events } = rig();
  const n = notes.create({});
  await mgr.start(n.id);
  mgr.pushPcm(n.id, 'mic', voice()); mgr.pushPcm(n.id, 'system', voice());
  assert.equal(engine.fed.mic.at(-1).equals(voice()), true, 'unmuted: as it was');
  assert.equal(mgr.status().micMuted, false);

  const st = mgr.setMicMuted(true);
  assert.equal(st.micMuted, true);
  assert.deepEqual(events.filter((e) => e.type === 'recording.mic-muted').map((e) => e.data), [{ noteId: n.id, muted: true }]);
  mgr.pushPcm(n.id, 'mic', voice()); mgr.pushPcm(n.id, 'system', voice());
  assert.equal(engine.fed.mic.at(-1).length, 3200, 'the timeline goes on: same length');
  assert.equal(silent(engine.fed.mic.at(-1)), true, 'but there is nothing in it of what you said');
  assert.equal(engine.fed.system.at(-1).equals(voice()), true, 'the others are heard as ever');

  mgr.setMicMuted(false);
  mgr.pushPcm(n.id, 'mic', voice());
  assert.equal(engine.fed.mic.at(-1).equals(voice()), true, 'unmuted again');
  assert.equal(mgr.status().micMuted, false);
  mgr.setMicMuted(false);
  assert.equal(events.filter((e) => e.type === 'recording.mic-muted').length, 2, 'asking for what already is says nothing new');
  await mgr.stop();
});

test('mute: it stays through a pause and a resume, and a new recording starts unmuted', async () => {
  const { notes, engine, mgr } = rig();
  const a = notes.create({});
  await mgr.start(a.id);
  mgr.setMicMuted(true);
  await mgr.pause(); mgr.resume();
  assert.equal(mgr.status().micMuted, true);
  mgr.pushPcm(a.id, 'mic', voice());
  assert.equal(silent(engine.fed.mic.at(-1)), true);
  await mgr.stop();
  const b = notes.create({});
  await mgr.start(b.id);
  assert.equal(mgr.status().micMuted, false, 'a new recording is not muted');
  mgr.pushPcm(b.id, 'mic', voice());
  assert.equal(engine.fed.mic.at(-1).equals(voice()), true);
  await mgr.stop();
});

test('mute: nothing to mute without a recording, or in one that does not use the microphone', async () => {
  const { notes, mgr } = rig();
  assert.throws(() => mgr.setMicMuted(true), (e) => e.code === 'idle');
  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  assert.equal(mgr.status().micAvailable, false);
  assert.throws(() => mgr.setMicMuted(true), (e) => e.code === 'no-mic');
  await mgr.stop();
  await mgr.start(n.id);
  assert.equal(mgr.status().micAvailable, true);
  await mgr.stop();
});

test('API: muting says no when nothing is recording; the page hears the event', async (t) => {
  const dataDir = tmpDir('wb-mute-');
  const platform = { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null };
  const app = createApp({ dataDir, platform, version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const r = await call('POST', '/api/recording/mic-mute', { muted: true });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /No recording/);
  const bad = await call('POST', '/api/recording/mic-mute', { muted: 'yes' });
  assert.equal(bad.status, 400);

  // the client only hears the events it lists: the page must hear that the microphone was (un)muted, in this window and in the widget
  const client = fs.readFileSync(path.join(ROOT, 'ui/api.js'), 'utf8');
  assert.ok(client.includes("'recording.mic-muted'"), 'recording.mic-muted is not in ui/api.js: the page would never see it');
});
