'use strict';
// Names from the meeting's live captions, matched with our own transcript by their words.
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
const { alignCaptions, mergeIntervals, containment, tokens } = require('../src/meet/captions');

const U = (id, startMs, endMs, text) => ({ id, startMs, endMs, text });

test('captions: words are compared as bags, accents and punctuation aside, and short talk matches nothing', () => {
  assert.equal(containment(tokens('Hello, there!'), tokens('hello there everyone today')), 1);
  assert.equal(containment(tokens('let us start the meeting'), tokens('shall we begin the meeting')), 0.4);
  assert.equal(containment(tokens('Olá, boa tarde'), tokens('ola boa tarde a todos')), 1, 'accents');
  assert.equal(containment([], tokens('anything')), 0);
});

test('captions: a reading names the utterance it resembles, even when the two recognisers word it a little differently', () => {
  const us = [U(1, 0, 6000, 'good morning everyone shall we begin the meeting today'), U(2, 7000, 12000, 'yes I have the numbers for the last quarter ready')];
  const caps = [
    { t: 3000, name: 'Ana Silva', text: 'Good morning everyone, shall we begin' },
    { t: 9500, name: 'Bruno Costa', text: 'Yes, I have the numbers for the last quarter' },
  ];
  const r = alignCaptions({ captions: caps, utterances: us });
  assert.deepEqual(r.map((x) => [x.id, x.name]), [[1, 'Ana Silva'], [2, 'Bruno Costa']]);
});

test('captions: a line that scrolls (the oldest words drop off) still matches', () => {
  const us = [U(1, 0, 9000, 'we looked at the numbers for the third quarter and they are better than expected')];
  const caps = [{ t: 3000, name: 'Ana', text: 'we looked at the numbers for the third' }, { t: 8000, name: 'Ana', text: 'quarter and they are better than expected' }];
  assert.equal(alignCaptions({ captions: caps, utterances: us })[0].name, 'Ana');
});

test('captions: words that nobody said near that time, short talk and ties name nobody', () => {
  const us = [U(1, 0, 5000, 'we should talk about the budget before the end of the month'), U(2, 20000, 22000, 'okay yes')];
  assert.equal(alignCaptions({ captions: [{ t: 40000, name: 'Ana', text: 'we should talk about the budget before the end' }], utterances: us }).length, 0, 'too late to be this speech');
  assert.equal(alignCaptions({ captions: [{ t: 21000, name: 'Ana', text: 'okay yes' }], utterances: us }).length, 0, 'two words: matches everything');
  const tie = [{ t: 3000, name: 'Ana', text: 'we should talk about the budget' }, { t: 3100, name: 'Bruno', text: 'we should talk about the budget' }];
  assert.equal(alignCaptions({ captions: tie, utterances: us }).length, 0, 'two names for the same words');
  assert.equal(alignCaptions({ captions: [{ t: 3000, name: '', text: 'we should talk about the budget' }], utterances: us }).length, 0, 'no name');
});

test('captions: where they name a stretch, the highlight is cut away', () => {
  const fromCaptions = [{ startMs: 4000, endMs: 8000, name: 'Bruno' }];
  const fromHighlight = [{ startMs: 0, endMs: 12000, name: 'Ana' }, { startMs: 20000, endMs: 24000, name: 'Carla' }];
  const m = mergeIntervals(fromCaptions, fromHighlight);
  assert.deepEqual(m.map((x) => [x.startMs, x.endMs, x.name]), [[0, 4000, 'Ana'], [4000, 8000, 'Bruno'], [8000, 12000, 'Ana'], [20000, 24000, 'Carla']]);
  assert.deepEqual(mergeIntervals([], fromHighlight), fromHighlight);
});

// ---- through a recording ----
const speak = (ms) => Array.from({ length: Math.floor(ms / 500) }, (_, k) => ['w', k * 500, k * 500 + 400]);
const vec = (...xs) => { const v = new Float32Array(8); xs.forEach((x, i) => { v[i] = x; }); return v; };
const E = { ana: vec(1), bruno: vec(0, 0, 1), carla: vec(0, 0, 0, 1) };

function rig(t, extra = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const db = open(':memory:'), bus = new Bus();
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false, echoDedupe: false, speakerDiarize: false, ...extra });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cap-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const hub = new SignalHub();
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, meet: hub });
  const n = notes.create({});
  const events = [];
  bus.subscribe((e) => events.push(e));
  return { mgr, engine, hub, notes, n, events, spoolDir, t, settings };
}
const TEXT = ['good morning everyone shall we begin the meeting today', 'yes I have the numbers for the last quarter ready to share', 'great please go ahead and share your screen with us now'];
const WHO = ['Ana Silva', 'Bruno Costa', 'Carla Dias'];

async function callWith(r, { highlight, captions = true, captionName = (i) => WHO[i % 3] }) {
  const { mgr, engine, hub, n, t } = r;
  await mgr.start(n.id, { mic: true, system: true });
  mgr.pushPcm(n.id, 'system', Buffer.alloc(64000));
  const turns = [0, 1, 2, 0, 1, 2].map((v, i) => [v, i * 7000, i * 7000 + 6000]);
  turns.forEach(([v, a, b], i) => engine.emit('segment', { ch: 'system', startMs: a, endMs: b, text: TEXT[v], words: speak(b - a), embedding: [E.ana, E.bruno, E.carla][v] }));
  let now = 0;
  const at = (ms) => { t.mock.timers.tick(ms - now); now = ms; };
  turns.forEach(([v, a, b], i) => {
    at(a + 400);
    hub.ingest({ type: 'speaker', name: highlight(i, WHO[v]) }, { source: 'x', kind: 'extension', lagMs: 400 });
    if (captions) { at(a + 2500); hub.ingest({ type: 'caption', name: captionName(i), text: TEXT[v].split(' ').slice(0, 6).join(' '), final: false }, { source: 'x', kind: 'extension' }); }
    at(b + 400);
    hub.ingest({ type: 'speaker', name: null }, { source: 'x', kind: 'extension', lagMs: 400 });
  });
  await mgr.stop();
  fs.rmSync(r.spoolDir, { recursive: true, force: true });
  return r.notes.segments(n.id).filter((s) => s.speaker === 'them').map((s) => [s.text.split(' ')[0], s.label]);
}

test('recording: the captions name the voices even when the highlight is wrong or missing', async (t) => {
  const r = rig(t);
  // the highlight is on the wrong person for the whole call; the captions know better
  const got = await callWith(r, { highlight: (i) => WHO[(i + 1) % 3] });
  assert.deepEqual([...new Set(got.map((g) => g.join(':')))].sort(), ['good:Ana Silva', 'great:Carla Dias', 'yes:Bruno Costa']);
  assert.ok(r.events.find((e) => e.type === 'recording.meet-names').data.captionNamed >= 6);
});

test('recording: with the captions switched off the wrong highlight is all there is', async (t) => {
  const base = new Settings(open(':memory:'), new Bus()).get('meet');
  const r = rig(t, { meet: { ...base, captions: false } });
  const got = await callWith(r, { highlight: (i) => WHO[(i + 1) % 3] });
  assert.deepEqual([...new Set(got.map((g) => g[1]))].sort(), WHO, 'named, by the highlight alone: all of them wrongly');
  assert.equal(got.find((g) => g[0] === 'good')[1], 'Bruno Costa');
});

test('recording: with no captions the highlight works as before', async (t) => {
  const r = rig(t);
  const got = await callWith(r, { highlight: (i, who) => who, captions: false });
  assert.equal(got.find((g) => g[0] === 'good')[1], 'Ana Silva');
  assert.equal(r.events.find((e) => e.type === 'recording.meet-names').data.captionNamed, 0);
});
