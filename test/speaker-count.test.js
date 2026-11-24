'use strict';
// "Others on the call": the user says how many people talk on the call, and the speaker passes keep to that number.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { SpeakerTracker } = require('../src/speakers/cluster');
const { refineChannel } = require('../src/speakers/refine');
const { RecordingManager } = require('../src/recording/manager');

const unit = (i, n = 8) => { const v = new Float32Array(n); v[i] = 1; return v; };

test('notes: speakerCount is stored, cleared with null or "", and must be 1-12', () => {
  const notes = new Notes(open(':memory:'), new Bus());
  const n = notes.create({});
  assert.equal(n.speakerCount, null, 'not set: work it out');
  assert.equal(notes.update(n.id, { speakerCount: 4 }).speakerCount, 4);
  assert.equal(notes.update(n.id, { speakerCount: '3' }).speakerCount, 3, 'a number from a form field');
  assert.equal(notes.update(n.id, { speakerCount: '' }).speakerCount, null);
  notes.update(n.id, { speakerCount: 2 });
  assert.equal(notes.update(n.id, { speakerCount: null }).speakerCount, null);
  for (const bad of [0, 13, 2.5, 'four', -1]) assert.throws(() => notes.update(n.id, { speakerCount: bad }), /speakerCount/, String(bad));
});

test('SpeakerTracker: with max set, no new speaker past the limit; the limit can change while recording', () => {
  const tr = new SpeakerTracker({ threshold: 0.6, prefix: 's', max: 2 });
  assert.equal(tr.assign(unit(0)).id, 's1');
  assert.equal(tr.assign(unit(1)).id, 's2');
  const third = tr.assign(unit(2));
  assert.equal(third.isNew, false, 'a third voice joins an existing speaker');
  assert.ok(['s1', 's2'].includes(third.id));
  tr.max = 0;
  assert.equal(tr.assign(unit(3)).isNew, true, 'no limit: a far voice starts a new speaker again');
});

test('refineChannel: structure:false never splits or merges, it only re-assigns', () => {
  // two speakers whose utterances sound identical: the normal pass is allowed to merge them
  const segments = [];
  for (let i = 0; i < 6; i++) segments.push({ id: i + 1, speakerId: i < 3 ? 's1' : 's2', embedding: unit(0), acoustic: { vec: new Float32Array(16).fill(1 + (i % 2) * 0.01), f0: 150 } });
  const speakers = [{ id: 's1', centroid: unit(0), count: 3 }, { id: 's2', centroid: unit(0), count: 3 }];
  assert.equal(refineChannel({ segments, speakers, prefix: 's', threshold: 0.6 }).stats.merged, 1, 'the normal pass merges them');
  const settled = refineChannel({ segments, speakers, prefix: 's', threshold: 0.6, structure: false });
  assert.equal(settled.stats.split, 0);
  assert.equal(settled.stats.merged, 0);
  assert.equal(settled.removed.size, 0, 'both speakers survive');
});

function rig({ speakerCount, attendees = [] }) {
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false, echoDedupe: false });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-count-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    return { turns: [{ start: 0, end: 1, speaker: 0 }, { start: 1, end: 2, speaker: 1 }], voices: [{ speaker: 0, centroid: null }, { speaker: 1, centroid: null }] };
  };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization: { run } });
  const n = notes.create({ attendees });
  if (speakerCount) notes.update(n.id, { speakerCount });
  const record = async () => {
    await mgr.start(n.id, { mic: true, system: true });
    for (const ch of ['mic', 'system']) {
      mgr.pushPcm(n.id, ch, Buffer.alloc(64000));
      engine.emit('segment', { ch, startMs: 0, endMs: 2000, text: 'one two', words: [['one', 100, 500], ['two', 1100, 1500]], embedding: null });
    }
    await mgr.stop();
    fs.rmSync(spoolDir, { recursive: true, force: true });
  };
  return { record, calls };
}

test('recording: the user count is forced on the system audio only, and wins over the calendar', async () => {
  const people = Array.from({ length: 3 }, (_, i) => ({ name: `P${i}`, email: `p${i}@x.org`, status: 'ACCEPTED' }));
  const told = rig({ speakerCount: 4, attendees: people });
  await told.record();
  const sys = told.calls.find((c) => c.numSpeakers === 4);
  assert.ok(sys, 'the system channel is clustered into exactly 4 voices');
  assert.equal(told.calls.length, 2, 'both channels diarized');
  assert.ok(told.calls.some((c) => !c.numSpeakers), 'the microphone is not forced');

  const auto = rig({ speakerCount: null });
  await auto.record();
  assert.ok(auto.calls.every((c) => !c.numSpeakers), 'Auto: nothing forced');
});
