'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hungarian } = require('../src/speakers/hungarian');
const { toTimeline, assignWords, mapSpeakers, splitByWords, planChannel, soloStretches } = require('../src/speakers/diarize');
const { diarizeChannel } = require('../src/speakers/final');
const { score, wder, normalize } = require('../eval/metrics');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Speakers } = require('../src/speakers/store');

const turn = (speaker, startMs, endMs) => ({ speaker, startMs, endMs });
const word = (startMs, endMs) => ({ startMs, endMs });

test('hungarian: minimum-cost one-to-one assignment, rectangular either way', () => {
  assert.deepEqual([...hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])], [1, 0, 2]);
  assert.deepEqual([...hungarian([[5, 1], [1, 5], [0, 0]])].filter((j) => j >= 0).length, 2, 'more rows than columns: one row is left out');
  const r = hungarian([[9, 1, 9], [1, 9, 9]]);
  assert.deepEqual([...r], [1, 0]);
  assert.deepEqual([...hungarian([])], []);
});

test('assignWords: each word goes to the speaker whose turn overlaps it most; words in gaps to the nearest turn', () => {
  const turns = [turn('A', 0, 1000), turn('B', 1000, 2000)];
  const got = assignWords([word(100, 400), word(850, 1250), word(1100, 1500), word(2300, 2500)], turns);
  assert.deepEqual(got.map((g) => g.speaker), ['A', 'B', 'B', 'B'], 'a word straddling the boundary follows the larger share');
  assert.equal(assignWords([word(5, 5)], [turn('A', 0, 1000)])[0].speaker, 'A', 'a zero-length word still lands somewhere');
  assert.deepEqual(assignWords([word(0, 100)], []), [{ speaker: null, overlap: false }]);
});

test('assignWords: a stray word within ~200 ms of a turn boundary snaps back to the speaker around it', () => {
  // A talks until 1000, B starts at 1150. The word timed 1000-1150 is "inside" B's first 0-50 ms by overlap only
  // because of timing error, and the next word is A again.
  const turns = [turn('A', 0, 1000), turn('B', 960, 1200), turn('A', 1200, 3000)];
  const words = [word(600, 950), word(1000, 1150), word(1210, 1600)];
  assert.deepEqual(assignWords(words, turns).map((g) => g.speaker), ['A', 'A', 'A']);
  assert.deepEqual(assignWords(words, turns, { tolerance: 0 }).map((g) => g.speaker), ['A', 'B', 'A'], 'without tolerance it would flip');
});

test('assignWords: a real backchannel well clear of the other turns is kept, and overlap is flagged', () => {
  const turns = [turn('A', 0, 2000), turn('B', 2500, 2900), turn('A', 3400, 6000)];
  const got = assignWords([word(1500, 1900), word(2550, 2850), word(3500, 3900)], turns);
  assert.deepEqual(got.map((g) => g.speaker), ['A', 'B', 'A'], '"yeah" between two of A\'s sentences stays B\'s');
  const ov = assignWords([word(1000, 1400)], [turn('A', 0, 2000), turn('B', 1100, 3000)]);
  assert.equal(ov[0].overlap, true);
  assert.equal(ov[0].speaker, 'A');
});

test('toTimeline: spool positions map onto the note timeline across a pause, and a turn spanning it is cut', () => {
  // first stretch: spool 0 = 0 ms; after a pause, spool sample 160000 (10 s) resumes at 25 000 ms on the timeline
  const st = [{ at: 0, ms: 0 }, { at: 160000, ms: 25000 }];
  const out = toTimeline([{ start: 2, end: 4, speaker: 0 }, { start: 9, end: 11, speaker: 1 }], st);
  assert.deepEqual(out, [turn(0, 2000, 4000), turn(1, 9000, 10000), turn(1, 25000, 26000)]);
});

test('mapSpeakers: final speakers take over the live ids they overlap most, one to one; extra ones get fresh ids', () => {
  const live = [{ speakerId: 's1', startMs: 0, endMs: 10000 }, { speakerId: 's2', startMs: 10000, endMs: 14000 }];
  // the live pass lumped two people into s1 (0-10 s); the final pass finds 3 speakers
  const turns = [turn(7, 0, 6000), turn(3, 6000, 10000), turn(5, 10000, 14000)];
  const { map, born } = mapSpeakers(live, turns, { prefix: 's', usedIds: ['s1', 's2', 's4'] });
  assert.equal(map.get(7), 's1', 'the speaker with the most overlap keeps s1 (and its name)');
  assert.equal(map.get(5), 's2');
  assert.equal(map.get(3), 's5', 'a newly found voice gets a number no other speaker of the note has used');
  assert.deepEqual(born, ['s5']);
  const none = mapSpeakers([], [turn(0, 0, 100)], { prefix: 'm' });
  assert.equal(none.map.get(0), 'm1');
});

test('splitByWords: an utterance is cut where its words change speaker, with times and words re-based', () => {
  const seg = { startMs: 10000, endMs: 13000, text: 'Hi there. Hello, how are you?', words: [['Hi', 0, 200], ['there.', 200, 500], ['Hello,', 800, 1100], ['how', 1150, 1300], ['are', 1300, 1400], ['you?', 1400, 1800]] };
  const parts = splitByWords(seg, ['s1', 's1', 's2', 's2', 's2', 's2']);
  assert.deepEqual(parts.map((p) => [p.speakerId, p.startMs, p.endMs, p.text]), [['s1', 10000, 10800, 'Hi there.'], ['s2', 10800, 13000, 'Hello, how are you?']]);
  assert.deepEqual(parts[1].words[0], ['Hello,', 0, 300]);
  assert.equal(splitByWords(seg, Array(6).fill('s1')).length, 1);
  assert.equal(splitByWords({ ...seg, text: 'something else entirely' }, Array(6).fill('s1')), null, 'words that do not spell the text: no cut');
});

test('planChannel: only utterances whose speaker changes are listed; names follow the live ids', () => {
  const segments = [
    { id: 1, startMs: 0, endMs: 3000, text: 'one two three four', speakerId: 's1', words: [['one', 0, 500], ['two', 600, 1000], ['three', 1800, 2300], ['four', 2400, 2900]] },
    { id: 2, startMs: 4000, endMs: 5000, text: 'five six', speakerId: 's1', words: [['five', 0, 400], ['six', 500, 900]] },
  ];
  const turns = [turn('A', 0, 1500), turn('B', 1500, 3000), turn('A', 4000, 5000)];
  const plan = planChannel({ segments, turns, prefix: 's', usedIds: ['s1'] });
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes[0].parts.map((p) => [p.speakerId, p.text]), [['s1', 'one two'], ['s2', 'three four']]);
  assert.equal(plan.words, 6);
});

test('soloStretches: the longest stretches where a speaker talks alone, capped in total', () => {
  const turns = [{ start: 0, end: 10, speaker: 0 }, { start: 4, end: 5, speaker: 1 }, { start: 20, end: 21, speaker: 0 }];
  assert.deepEqual(soloStretches(turns, 0), [[5, 10], [0, 4], [20, 21]]);
  assert.deepEqual(soloStretches(turns, 0, { maxSec: 6 }), [[5, 10], [0, 1]]);
  assert.deepEqual(soloStretches(turns, 1), [], 'never alone: nothing');
});

test('diarizeChannel: words are relabelled and cut in the store, names survive, mic and system stay apart', async () => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), speakers = new Speakers(db, bus);
  const n = notes.create({});
  const v = (k) => Float32Array.from({ length: 8 }, (_, i) => (i === k ? 1 : 0.1));
  const [a, b, m] = notes.addSegments(n.id, [
    { speaker: 'them', speakerId: 's1', startMs: 0, endMs: 4000, text: 'so I think we should ship yes agreed', words: [['so', 0, 200], ['I', 250, 350], ['think', 350, 600], ['we', 600, 700], ['should', 700, 1000], ['ship', 1000, 1400], ['yes', 2600, 2900], ['agreed', 3000, 3600]] },
    { speaker: 'them', speakerId: 's1', startMs: 5000, endMs: 6000, text: 'great', words: [['great', 100, 600]] },
    { speaker: 'me', speakerId: 'm1', startMs: 0, endMs: 2000, text: 'hello', words: [['hello', 100, 600]] },
  ]);
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: v(0), count: 2 });
  speakers.save(n.id, { speakerId: 'm1', channel: 'mic', centroid: v(5), count: 1 });
  speakers.rename(n.id, 's1', 'Ana');
  const calls = [];
  const fake = async (opts) => { calls.push(opts); return { turns: [{ start: 0, end: 1.5, speaker: 0 }, { start: 2.5, end: 3.8, speaker: 1 }, { start: 5, end: 6, speaker: 0 }], voices: [{ speaker: 0, centroid: v(1), pitch: 210, ms: 2500 }, { speaker: 1, centroid: v(2), pitch: 110, ms: 1300 }] }; };
  const out = await diarizeChannel({ diarize: fake, notes, speakers, noteId: n.id, channel: 'system', source: { file: '/spool/system.pcm' }, stretches: [{ at: 0, ms: 0 }], segIds: [a.id, b.id], segmentation: '/seg.onnx', embedding: '/spk.onnx' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/spool/system.pcm');
  assert.equal(out.changes, 1);
  const segs = notes.segments(n.id);
  assert.deepEqual(segs.filter((s) => s.speaker === 'them').map((s) => [s.speakerId, s.text, s.label]), [
    ['s1', 'so I think we should ship', 'Ana'], ['s2', 'yes agreed', 'Speaker 2'], ['s1', 'great', 'Ana'],
  ]);
  assert.equal(segs.find((s) => s.id === a.id).text, 'so I think we should ship', 'the first part keeps the row');
  assert.deepEqual(segs.filter((s) => s.speaker === 'me').map((s) => s.speakerId), ['m1'], 'the mic channel is untouched');
  const sp = speakers.forNote(n.id);
  assert.equal(Math.round(sp.find((s) => s.speakerId === 's2').pitch), 110);
  assert.equal(sp.find((s) => s.speakerId === 's1').name, 'Ana');
  assert.ok(sp.find((s) => s.speakerId === 's1').centroid[1] > 0.5, 'the pooled voice print replaces the live centroid');
});

test('metrics: WDER counts words given to the wrong speaker after the best mapping; cpWER/tcpWER as meeteval', () => {
  const w = (speaker, start, word) => ({ speaker, start, end: start + 0.3, word });
  const ref = [w('A', 0, 'hello'), w('A', 0.5, 'there'), w('B', 1, 'how'), w('B', 1.5, 'are'), w('B', 2, 'you')];
  const perfect = ref.map((x) => ({ ...x, speaker: x.speaker === 'A' ? 'x' : 'y' }));
  const s = score(ref, perfect);
  assert.equal(s.wder, 0);
  assert.equal(s.cpwer, 0);
  assert.equal(s.tcpwer, 0);
  const oneWrong = perfect.map((x, i) => (i === 2 ? { ...x, speaker: 'x' } : x));
  assert.equal(wder(normalize(ref), normalize(oneWrong)).wrong, 1);
  assert.equal(score(ref, oneWrong).cpwer, 2 / 5, 'a misattributed word is a deletion for one speaker and an insertion for another');
  const late = perfect.map((x) => ({ ...x, start: x.start + 30, end: x.end + 30 }));
  assert.equal(score(ref, late).cpwer, 0);
  assert.equal(score(ref, late).tcpwer, 2, 'tcpWER refuses to pair words 30 s apart');
  assert.deepEqual(normalize([{ speaker: 'A', start: 0, end: 1, word: 'Uh, Mm-hmm, OK.' }]).map((x) => x.word), ['ok']);
});

test('diarization worker: only the speaker models and the worker file are needed', () => {
  assert.ok(fs.existsSync(require.resolve('../src/speakers/diarize-worker.js')));
});

test('recording: after Stop each channel is diarized on its own spool, words are relabelled across a pause, names kept', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { Settings } = require('../src/core/settings');
  const { RecordingManager } = require('../src/recording/manager');
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false, echoDedupe: false });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dz-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk.onnx', segmentationInstalled: () => true, segmentationPath: () => '/seg.onnx' };
  const calls = [];
  const run = async (opts) => {
    calls.push({ ...opts, bytes: fs.statSync(opts.file).size });
    // spool seconds: 0-1.5 first person, 1.5-3 second person; after the pause (spool 3 s on) the first person again
    return { turns: [{ start: 0, end: 1.5, speaker: 0 }, { start: 1.5, end: 3, speaker: 1 }, { start: 3, end: 4, speaker: 0 }], voices: [{ speaker: 0, centroid: null, pitch: 200, ms: 2500 }, { speaker: 1, centroid: null, pitch: 120, ms: 1500 }] };
  };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization: { run } });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false, system: true });
  const sec = (s) => Buffer.alloc(32000 * s);
  mgr.pushPcm(n.id, 'system', sec(3));
  // one live utterance holding both people (no pause between them), all given to s1
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 3000, text: 'hello there hi', words: [['hello', 100, 600], ['there', 700, 1200], ['hi', 1700, 2400]], embedding: null });
  const [first] = notes.segments(n.id);
  speakers.reassignSegment(n.id, first.id, 's1');
  speakers.rename(n.id, 's1', 'Ana');
  await mgr.pause();
  await new Promise((r) => setTimeout(r, 30));
  mgr.resume();
  mgr.pushPcm(n.id, 'system', sec(1));
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 1000, text: 'bye', words: [['bye', 100, 500]], embedding: null });
  await mgr.stop();
  assert.equal(calls.length, 1, 'one call: the system channel (the mic was off)');
  assert.equal(calls[0].bytes, 4 * 32000, 'the whole spool, both stretches');
  assert.equal(calls[0].segmentation, '/seg.onnx');
  const segs = notes.segments(n.id);
  // (audio is pushed instantly here, so the resumed stretch starts near 0 ms on the timeline; toTimeline is tested above)
  assert.deepEqual(Object.fromEntries(segs.map((s) => [s.text, s.label])), { 'hello there': 'Ana', hi: 'Speaker 2', bye: 'Ana' });
  assert.deepEqual(events.filter((e) => e.type === 'recording.finalizing').map((e) => e.data.stage), ['transcribing', 'speakers']);
  assert.deepEqual(fs.readdirSync(spoolDir), [], 'the audio is deleted afterwards');
  fs.rmSync(spoolDir, { recursive: true, force: true });
});

test('recording: a failing diarization leaves the live labels and still stops cleanly', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { Settings } = require('../src/core/settings');
  const { RecordingManager } = require('../src/recording/manager');
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const db = open(':memory:');
  const bus = new Bus();
  const warnings = [];
  bus.subscribe((e) => { if (e.type === 'recording.warning') warnings.push(e.data.message); });
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dz-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization: { run: async () => { throw new Error('model missing'); } } });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false, system: true });
  mgr.pushPcm(n.id, 'system', Buffer.alloc(32000));
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 900, text: 'hello', embedding: null });
  const r = await mgr.stop();
  assert.equal(r.note.status, 'done');
  assert.equal(notes.segments(n.id)[0].text, 'hello');
  assert.match(warnings.join(), /speaker diarization \(system\): model missing/);
  assert.deepEqual(fs.readdirSync(spoolDir), []);
  fs.rmSync(spoolDir, { recursive: true, force: true });
});
