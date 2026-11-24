'use strict';
// The call's names fix the voices: one person heard as two voices is joined, two people heard as one are split.
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
const { nameSpeakers, activeIntervals, speechOf } = require('../src/meet/names');
const { planCorrections } = require('../src/meet/correct');

// a stretch of speech: a word every half second
const speak = (ms) => Array.from({ length: Math.floor(ms / 500) }, (_, k) => ['w', k * 500, k * 500 + 400]);
const vec = (...xs) => { const v = new Float32Array(8); xs.forEach((x, i) => { v[i] = x; }); return v; };
const E = { ana: vec(1), anaB: vec(0.5, 0.866), bruno: vec(0, 0, 1), carla: vec(0, 0, 0, 1), zed: vec(0, 0, 0, 0, 1) };

// ---- pure ----
const utt = (id, speakerId, startMs, endMs) => ({ id, speakerId, startMs, endMs });
function plan(utterances, active) {
  const speech = speechOf(utterances);
  const vote = nameSpeakers({ speech, active });
  return { vote, ...planCorrections({ speech, utterances, active, vote }) };
}

test('correct: one person heard as two voices that never talk together are joined', () => {
  const us = [utt(1, 's1', 0, 6000), utt(2, 's2', 7000, 13000), utt(3, 's1', 14000, 20000), utt(4, 's2', 21000, 27000)];
  const active = [{ startMs: 0, endMs: 27000, name: 'Ana' }];
  const p = plan(us, active);
  assert.deepEqual(p.merges.map((m) => [m.from, m.into, m.name]), [['s2', 's1', 'Ana']].map(([f, i, n]) => (p.merges[0].from === 's1' ? ['s1', 's2', n] : [f, i, n])));
  assert.equal(p.merges.length, 1);
});

test('correct: two voices that talk at the same time are two people, even under one highlighted name', () => {
  const us = [utt(1, 's1', 0, 10000), utt(2, 's2', 2000, 12000)];
  const p = plan(us, [{ startMs: 0, endMs: 12000, name: 'Ana' }]);
  assert.equal(p.merges.length, 0);
});

test('correct: two people heard as one voice are split where each was clearly highlighted', () => {
  const us = [utt(1, 's1', 0, 6000), utt(2, 's1', 7000, 13000), utt(3, 's1', 14000, 20000), utt(4, 's1', 21000, 27000)];
  const active = [{ startMs: 0, endMs: 6500, name: 'Bruno' }, { startMs: 6800, endMs: 13500, name: 'Carla' }, { startMs: 13800, endMs: 20500, name: 'Bruno' }, { startMs: 20800, endMs: 27500, name: 'Carla' }];
  const p = plan(us, active);
  assert.deepEqual(p.moves.map((m) => [m.id, m.name, m.to]).sort(), [[2, 'Carla', null], [4, 'Carla', null]], 'the second name\'s utterances leave; the voice keeps the first');
});

test('correct: an odd highlight over a voice moves nothing', () => {
  const us = [utt(1, 's1', 0, 20000)];
  const p = plan(us, [{ startMs: 0, endMs: 17000, name: 'Bruno' }, { startMs: 17000, endMs: 18200, name: 'Carla' }]);
  assert.equal(p.moves.length, 0);
  assert.equal(p.merges.length, 0);
});

test('correct: an utterance only half highlighted as the other name stays', () => {
  const us = [utt(1, 's1', 0, 8000), utt(2, 's1', 9000, 15000), utt(3, 's1', 16000, 22000)];
  const active = [{ startMs: 0, endMs: 8000, name: 'Bruno' }, { startMs: 9000, endMs: 12000, name: 'Carla' }, { startMs: 12000, endMs: 15000, name: 'Bruno' }, { startMs: 16000, endMs: 22000, name: 'Carla' }];
  const p = plan(us, active);
  assert.deepEqual(p.moves.map((m) => m.id), [3]);
});

// ---- through a recording ----
function rig(t, { db = open(':memory:'), timers = true, settings: extra = {} } = {}) {
  if (timers) t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const bus = new Bus();
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false, echoDedupe: false, speakerDiarize: false, ...extra });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fix-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const hub = new SignalHub();
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, meet: hub });
  const n = notes.create({});
  const events = [];
  bus.subscribe((e) => events.push(e));
  // turns: [name, embedding, startMs, endMs]; the highlight follows `name` unless `shown` says otherwise
  async function call(turns, { lag = 400, shown = null } = {}) {
    await mgr.start(n.id, { mic: true, system: true });
    mgr.pushPcm(n.id, 'system', Buffer.alloc(64000));
    turns.forEach(([, emb, a, b], i) => engine.emit('segment', { ch: 'system', startMs: a, endMs: b, text: `turn ${i}`, words: speak(b - a), embedding: emb }));
    if (shown !== false) {
      let now = 0;
      const at = (ms) => { t.mock.timers.tick(ms - now); now = ms; };
      turns.forEach(([name, , a, b], i) => {
        at(a + lag); hub.ingest({ type: 'speaker', name: shown ? shown(i, name) : name }, { source: 'x', kind: 'extension', lagMs: lag });
        at(b + lag); hub.ingest({ type: 'speaker', name: null }, { source: 'x', kind: 'extension', lagMs: lag });
      });
    } else t.mock.timers.tick(turns.at(-1)[3] + 500);
    await mgr.stop();
    fs.rmSync(spoolDir, { recursive: true, force: true });
  }
  const labels = () => notes.segments(n.id).filter((s) => s.speaker === 'them').map((s) => s.label);
  const voices = () => speakers.forNote(n.id).filter((s) => s.channel === 'system' && s.segments > 0);
  return { db, mgr, notes, speakers, n, call, labels, voices, events, hub, settings, newNote: () => notes.create({}) };
}
const T = (name, emb, i) => [name, emb, i * 7000, i * 7000 + 6000];

test('recording: one person the clustering heard as two voices comes out as one named voice', async (t) => {
  const r = rig(t);
  await r.call([T('Ana', E.ana, 0), T('Bruno', E.bruno, 1), T('Carla', E.carla, 2), T('Ana', E.anaB, 3), T('Bruno', E.bruno, 4), T('Carla', E.carla, 5)]);
  assert.equal(r.voices().length, 3, 'four voices were heard, three people remain');
  assert.deepEqual([...new Set(r.labels())].sort(), ['Ana', 'Bruno', 'Carla']);
  assert.equal(r.events.find((e) => e.type === 'recording.meet-names').data.merged, 1);
});

test('recording: voices that sound clearly different are not joined just because the call gave them one name', async (t) => {
  const r = rig(t);
  // the highlight shows "Ana" over two very different voices (a person on the call whose tile was wrong, say)
  await r.call([T('Ana', E.ana, 0), T('Bruno', E.bruno, 1), T('Ana', E.carla, 2), T('Bruno', E.bruno, 3)], { shown: (i) => (i % 2 === 0 ? 'Ana' : 'Bruno') });
  assert.equal(r.voices().length, 3, 'nothing was merged: the sound says they differ');
  assert.equal(r.events.find((e) => e.type === 'recording.meet-names').data.merged, 0);
});

test('recording: two people the clustering heard as one voice are split and both named', async (t) => {
  const r = rig(t);
  await r.call([T('Bruno', E.bruno, 0), T('Carla', E.bruno, 1), T('Bruno', E.bruno, 2), T('Carla', E.bruno, 3), T('Ana', E.ana, 4)]);
  assert.equal(r.voices().length, 3);
  const byText = Object.fromEntries(r.notes.segments(r.n.id).filter((s) => s.speaker === 'them').map((s) => [s.text, s.label]));
  assert.deepEqual([byText['turn 0'], byText['turn 1'], byText['turn 2'], byText['turn 3'], byText['turn 4']], ['Bruno', 'Carla', 'Bruno', 'Carla', 'Ana']);
});

test('recording: corrections can be switched off and the names still apply', async (t) => {
  const base = new Settings(open(':memory:'), new Bus()).get('meet');
  const r = rig(t, { settings: { meet: { ...base, refine: false } } });
  await r.call([T('Ana', E.ana, 0), T('Bruno', E.bruno, 1), T('Carla', E.carla, 2), T('Ana', E.anaB, 3), T('Bruno', E.bruno, 4), T('Carla', E.carla, 5)]);
  assert.equal(r.voices().length, 4, 'not joined');
  assert.equal(r.events.find((e) => e.type === 'recording.meet-names').data.merged, 0);
});

test('voices: a voice the call named beyond doubt is remembered, and the next meeting knows it with no help', async (t) => {
  const first = rig(t);
  await first.call([T('Ana', E.ana, 0), T('Bruno', E.bruno, 1), T('Ana', E.ana, 2), T('Bruno', E.bruno, 3)]);
  assert.deepEqual(first.speakers.voices().map((v) => v.name).sort(), ['Ana', 'Bruno']);
  assert.equal(first.events.find((e) => e.type === 'recording.meet-names').data.learned, 2);
  const second = rig(t, { db: first.db, timers: false });
  await second.call([T('x', E.bruno, 0), T('x', E.ana, 1), T('x', E.bruno, 2)], { shown: false });
  assert.deepEqual([...new Set(second.labels())].sort(), ['Ana', 'Bruno'], 'named by their voices alone');
});

test('voices: a name that is only briefly highlighted teaches nothing', async (t) => {
  const r = rig(t);
  // each person speaks one 6 s turn: the call named them, but under the 10 s a saved voice needs
  await r.call([T('Ana', E.ana, 0), T('Bruno', E.bruno, 1)]);
  assert.deepEqual(r.labels().sort(), ['Ana', 'Bruno']);
  assert.equal(r.speakers.voices().length, 0);
});

test('voices: the call cannot overrule a saved voice the speaker matched', async (t) => {
  const first = rig(t);
  await first.call([T('Zed', E.zed, 0), T('Ana', E.ana, 1), T('Zed', E.zed, 2), T('Ana', E.ana, 3)]);
  assert.deepEqual(first.speakers.voices().map((v) => v.name).sort(), ['Ana', 'Zed']);
  // next meeting: Zed's voice is shown as "Mallory" by the call
  const second = rig(t, { db: first.db, timers: false });
  await second.call([T('Mallory', E.zed, 0), T('Ana', E.ana, 1), T('Mallory', E.zed, 2), T('Ana', E.ana, 3)]);
  assert.deepEqual([...new Set(second.labels())].sort(), ['Ana', 'Zed'], 'the saved voice wins');
  assert.deepEqual(second.events.find((e) => e.type === 'recording.meet-names').data.conflicts.length, 1);
  assert.deepEqual(second.speakers.voices().map((v) => v.name).sort(), ['Ana', 'Zed'], 'no voice was made for Mallory');
});

test('voices: a name shared by two different-sounding people is not mixed into one saved voice', async (t) => {
  const first = rig(t);
  await first.call([T('Ana', E.ana, 0), T('Bruno', E.bruno, 1), T('Ana', E.ana, 2), T('Bruno', E.bruno, 3)]);
  const second = rig(t, { db: first.db, timers: false });
  // a different "Ana" (another voice) on another call
  await second.call([T('Ana', E.carla, 0), T('Bruno', E.bruno, 1), T('Ana', E.carla, 2), T('Bruno', E.bruno, 3)]);
  const ana = second.speakers.voices().filter((v) => v.name === 'Ana');
  assert.equal(ana.length, 1);
  assert.ok(ana[0].samples <= 4, 'the saved Ana was not taught the other voice');
});
