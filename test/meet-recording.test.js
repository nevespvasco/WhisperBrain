'use strict';
// A recording uses what the meeting window shows: names for the voices and the number of voices to expect.
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
const { RecordingManager } = require('../src/recording/manager');
const { SignalHub } = require('../src/meet/hub');

// a stretch of speech: a word every half second
const speak = (ms) => Array.from({ length: Math.floor(ms / 500) }, (_, k) => ['w', k * 500, k * 500 + 400]);
const unit = (i, n = 8) => { const v = new Float32Array(n); v[i] = 1; return v; };
// who speaks when on the system audio (voice index, ms)
const SCRIPT = [[0, 0, 6000], [1, 6500, 12000], [2, 12500, 20000], [0, 20500, 26000], [1, 26500, 31000], [2, 31500, 36000]];
const WHO = ['Ana Silva', 'Bruno Costa', 'Carla Dias'];

function rig(t, { diarize = false, settings: extra = {}, attendees = [], speakerCount = null } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false, echoDedupe: false, speakerDiarize: diarize, ...extra });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-meet-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const calls = [];
  const run = async (opts) => { calls.push(opts); return { turns: [{ start: 0, end: 1, speaker: 0 }, { start: 1, end: 2, speaker: 1 }], voices: [{ speaker: 0, centroid: null }, { speaker: 1, centroid: null }] }; };
  const hub = new SignalHub();
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization: { run }, meet: hub });
  const n = notes.create({ attendees });
  if (speakerCount) notes.update(n.id, { speakerCount });
  const events = [];
  bus.subscribe((e) => events.push(e));
  const tick = (ms) => t.mock.timers.tick(ms);
  // the call: the system audio carries SCRIPT; the meeting window highlights each speaker `lag` ms after they start
  async function call({ lag = 400, wrong = () => null, roster = null, signals = true } = {}) {
    await mgr.start(n.id, { mic: true, system: true });
    mgr.pushPcm(n.id, 'mic', Buffer.alloc(64000));
    mgr.pushPcm(n.id, 'system', Buffer.alloc(64000));
    SCRIPT.forEach(([v, a, b]) => engine.emit('segment', { ch: 'system', startMs: a, endMs: b, text: `voice ${v}`, words: speak(b - a), embedding: unit(v) }));
    if (roster) hub.ingest({ type: 'roster', participants: roster }, { source: 'ext', kind: 'extension' });
    if (signals) {
      let now = 0;
      const at = (ms) => { tick(ms - now); now = ms; };
      SCRIPT.forEach(([v, a, b], i) => {
        at(a + lag); hub.ingest({ type: 'speaker', name: wrong(i) || WHO[v] }, { source: 'ext', kind: 'extension', lagMs: lag });
        at(b + lag); hub.ingest({ type: 'speaker', name: null }, { source: 'ext', kind: 'extension', lagMs: lag });
      });
    } else tick(40000);
    const out = await mgr.stop();
    fs.rmSync(spoolDir, { recursive: true, force: true });
    return out;
  }
  const labels = () => Object.fromEntries(speakers.forNote(n.id).filter((s) => s.channel === 'system').map((s) => [s.speakerId, s.name]));
  return { mgr, hub, notes, speakers, n, call, calls, labels, events, bus };
}

test('meeting names: each voice of the call takes the name that was highlighted while it spoke', async (t) => {
  const r = rig(t);
  await r.call();
  assert.deepEqual(Object.values(r.labels()).sort(), [...WHO].sort());
  const seg = r.notes.segments(r.n.id).filter((s) => s.speaker === 'them');
  assert.ok(seg.every((s) => WHO.includes(s.label)), 'the transcript shows the names');
  assert.deepEqual([...new Set(seg.filter((s) => s.text === 'voice 1').map((s) => s.label))], ['Bruno Costa']);
  const ev = r.events.find((e) => e.type === 'recording.meet-names');
  assert.equal(ev.data.named.length, 3);
});

test('meeting names: a name the user typed is kept, and the others are still named', async (t) => {
  const r = rig(t);
  // type a name while recording: wait for the live speakers to exist, then rename the second voice
  const first = r.call();
  await new Promise((res) => setImmediate(res));
  const live = r.speakers.forNote(r.n.id).filter((s) => s.channel === 'system');
  assert.equal(live.length, 3);
  const second = live.find((s) => s.speakerId === 's2').speakerId;
  r.speakers.rename(r.n.id, second, 'Bruno B.');
  await first;
  const labels = r.labels();
  assert.equal(labels[second], 'Bruno B.');
  assert.deepEqual(Object.values(labels).filter((x) => x !== 'Bruno B.').sort(), ['Ana Silva', 'Carla Dias']);
});

test('meeting names: the user is never given to a remote voice', async (t) => {
  const r = rig(t, { settings: { userName: 'Ana Silva' } });
  await r.call();
  const named = Object.values(r.labels()).filter(Boolean);
  assert.ok(!named.includes('Ana Silva'), 'Ana is the user: the highlight on her is her own voice, not a remote one');
  assert.ok(named.includes('Bruno Costa') && named.includes('Carla Dias'));
});

test('meeting names: switched off in settings, nothing is collected and nothing named', async (t) => {
  const r = rig(t, { settings: { meet: { ...new Settings(open(':memory:'), new Bus()).get('meet'), enabled: false } } });
  await r.call();
  assert.deepEqual(Object.values(r.labels()).filter(Boolean), []);
  assert.equal(r.events.some((e) => e.type === 'recording.meet-names'), false);
});

test('meeting names: nothing shown after Stop, or while paused, counts', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: true });
  r.mgr.pushPcm(r.n.id, 'system', Buffer.alloc(64000));
  r.mgr.pause?.();
  r.hub.ingest({ type: 'speaker', name: 'Ghost' }, { source: 'ext', kind: 'extension' });
  const collector = r.mgr.active.meet;
  assert.equal([...collector.events.values()].flat().length, 0, 'paused: ignored');
  r.mgr.resume?.();
  await r.mgr.stop();
  r.hub.ingest({ type: 'speaker', name: 'Late' }, { source: 'ext', kind: 'extension' });
  assert.equal([...collector.events.values()].flat().length, 0, 'stopped: the recording no longer listens');
  assert.equal(r.hub.listenerCount('signal'), 0, 'no listener left behind');
});

test('head count: the people on the call set the number of voices to expect, the user left out', async (t) => {
  const r = rig(t, { diarize: true });
  await r.call({ roster: [{ name: 'Vasco', self: true }, { name: 'Ana Silva' }, { name: 'Bruno Costa' }, { name: 'Carla Dias' }] });
  const sys = r.calls.filter((c) => c.numSpeakers);
  assert.equal(sys.length, 1, 'only the system audio is forced');
  assert.equal(sys[0].numSpeakers, 3);
});

test('head count: what the user said wins over the call\'s own list', async (t) => {
  const told = rig(t, { diarize: true, speakerCount: 2 });
  await told.call({ roster: [{ name: 'Vasco', self: true }, { name: 'A' }, { name: 'B' }, { name: 'C' }] });
  assert.deepEqual(told.calls.map((c) => c.numSpeakers).filter(Boolean), [2], 'the user said 2');
});

test('head count: a big call forces nothing, since nobody can say how many of the twelve speak', async (t) => {
  const big = rig(t, { diarize: true });
  await big.call({ roster: Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, self: i === 0 })) });
  assert.ok(big.calls.every((c) => !c.numSpeakers));
});

test('head count: it can be switched off without losing the names', async (t) => {
  const base = new Settings(open(':memory:'), new Bus()).get('meet');
  const r = rig(t, { diarize: false, settings: { meet: { ...base, headcount: false } } });
  await r.call({ roster: [{ name: 'Vasco', self: true }, { name: 'Ana Silva' }, { name: 'Bruno Costa' }, { name: 'Carla Dias' }] });
  assert.equal(r.calls.length, 0);
  assert.equal(Object.values(r.labels()).filter(Boolean).length, 3);
});
