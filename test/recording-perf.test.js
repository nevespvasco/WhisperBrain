'use strict';
// What one more line of a long meeting costs: the echo check and the speaker labels must not read the whole transcript again
// for every line (O(n²) over a meeting), and work the speaker pass will not use is not done while recording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { RecordingManager } = require('../src/recording/manager');
const { tmpDir } = require('./helpers');

class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
const unit = (k, n = 8) => { const v = new Float32Array(n); v[k % n] = 1; return v; };

function rig(t, { settings: s = {}, models: extra = {} } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerDiarize: false, speakerRefine: false, ...s });
  const spoolDir = tmpDir('wb-perf-');
  t.after(() => fs.rmSync(spoolDir, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => false, segmentationInstalled: () => false, ...extra };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization: {} });
  const count = { segments: 0, display: 0 };
  const seg0 = notes.segments.bind(notes), disp0 = speakers.display.bind(speakers);
  notes.segments = (...x) => { count.segments++; return seg0(...x); };
  speakers.display = (...x) => { count.display++; return disp0(...x); };
  return { db, bus, events, notes, settings, speakers, engine, mgr, count };
}

test('a line of a long meeting: the echo check reads no transcript, and the labels are worked out again only when they can change', async (t) => {
  const r = rig(t, { settings: { echoDedupe: true } });
  const n = r.notes.create({});
  await r.mgr.start(n.id);
  r.mgr.pushPcm(n.id, 'mic', Buffer.alloc(3200));
  r.mgr.pushPcm(n.id, 'system', Buffer.alloc(3200));
  r.count.segments = 0; r.count.display = 0;
  for (let i = 0; i < 60; i++) {
    const ch = i % 2 ? 'system' : 'mic';
    r.engine.emit('segment', { ch, startMs: i * 4000, endMs: i * 4000 + 3000, text: ch === 'mic' ? `alpha${i} beta${i} gamma${i} delta${i}` : `omega${i} sigma${i} kappa${i} theta${i}`, embedding: unit(ch === 'mic' ? 0 : 1) });
  }
  assert.equal(r.notes.segments(n.id).length - 0, 60);
  assert.equal(r.count.segments, 1, 'only the one read just above: none per line');
  assert.ok(r.count.display < 15, `labels recomputed ${r.count.display} times for 60 lines`);
  const shown = r.events.filter((e) => e.type === 'transcript.segment').map((e) => e.data.segment.label);
  assert.equal(shown.at(-1), 'Them');
  assert.equal(shown.at(-2), 'Me');
  // a rename elsewhere is seen at the next line
  const sid = r.notes.segments(n.id).find((x) => x.speaker === 'them').speakerId;
  r.speakers.rename(n.id, sid, 'Ana');
  r.engine.emit('segment', { ch: 'system', startMs: 300000, endMs: 303000, text: 'and one more line from her', embedding: unit(1) });
  assert.equal(r.events.filter((e) => e.type === 'transcript.segment').at(-1).data.segment.label, 'Ana');
  await r.mgr.stop();
});

test('echo: the in-memory window still catches an echo both ways, and a removed line is not removed twice', async (t) => {
  const r = rig(t, { settings: { echoDedupe: true } });
  const n = r.notes.create({});
  await r.mgr.start(n.id);
  r.mgr.pushPcm(n.id, 'mic', Buffer.alloc(3200));
  r.mgr.pushPcm(n.id, 'system', Buffer.alloc(3200));
  r.engine.emit('segment', { ch: 'system', startMs: 0, endMs: 3000, text: 'we should ship the release on friday afternoon' });
  r.engine.emit('segment', { ch: 'mic', startMs: 100, endMs: 3100, text: 'we should ship the release on friday' });
  assert.equal(r.notes.segments(n.id).length, 1, 'a mic echo of what was just heard is dropped');
  r.engine.emit('segment', { ch: 'mic', startMs: 10000, endMs: 12000, text: 'sounds good to me honestly' });
  r.engine.emit('segment', { ch: 'system', startMs: 10200, endMs: 12100, text: 'sounds good to me honestly' });
  r.engine.emit('segment', { ch: 'system', startMs: 10300, endMs: 12200, text: 'sounds good to me honestly yes' });
  assert.deepEqual(r.notes.segments(n.id).map((x) => x.speaker), ['them', 'them', 'them']);
  assert.equal(r.events.filter((e) => e.type === 'transcript.removed').length, 1, 'removed once');
  await r.mgr.stop();
});

test('with the owned speaker pipeline ready, utterances are not described one by one while recording (it skips that pass); otherwise they are', async (t) => {
  const owned = rig(t, { settings: { speakerDiarize: true, speakerRefine: true, speakerPipeline: 'owned' }, models: { speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' } });
  let described = 0;
  owned.mgr.describeSoon = () => { described++; };
  owned.mgr.followSpool = () => {}; // no live worker in this test
  const n = owned.notes.create({});
  await owned.mgr.start(n.id, { system: false });
  owned.mgr.pushPcm(n.id, 'mic', Buffer.alloc(32000));
  owned.engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 900, text: 'hello there friend' });
  assert.equal(described, 0);
  owned.mgr.active.live = null;
  await owned.mgr.stop().catch(() => {});
  const sherpa = rig(t, { settings: { speakerDiarize: true, speakerRefine: true, speakerPipeline: 'sherpa' } });
  let d2 = 0;
  sherpa.mgr.describeSoon = () => { d2++; };
  const m = sherpa.notes.create({});
  await sherpa.mgr.start(m.id, { system: false });
  sherpa.mgr.pushPcm(m.id, 'mic', Buffer.alloc(32000));
  sherpa.engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 900, text: 'hello there friend' });
  assert.equal(d2, 1);
  await sherpa.mgr.stop();
});
