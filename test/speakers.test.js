'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SpeakerTracker, mergeClusters, matchVoices, cosine, toBlob, fromBlob } = require('../src/speakers/cluster');
const { Speakers, defaultLabel } = require('../src/speakers/store');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { AsrEngine } = require('../src/asr/engine');
const { PushSource } = require('../src/audio/source');
const { wavToPcm16 } = require('../src/audio/pcm');
const { testModels, fixture } = require('./helpers');

// Synthetic voices: a base direction per person plus a little noise per utterance.
function voice(seed, dim = 32) { const v = new Float32Array(dim); let x = seed * 9301 + 49297; for (let i = 0; i < dim; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; } return v; }
function utter(base, noise = 0.08, seed = 1) { const v = Float32Array.from(base); let x = seed; for (let i = 0; i < v.length; i++) { x = (x * 16807) % 2147483647; v[i] += (x / 2147483647 - 0.5) * noise; } return v; }
const ANA = voice(1), BRUNO = voice(2), CARLA = voice(3);

test('tracker: utterances of the same voice share an id; a new voice gets a new id', () => {
  assert.ok(cosine(ANA, BRUNO) < 0.5, 'test voices are distinct');
  const tr = new SpeakerTracker({ threshold: 0.8, prefix: 's' });
  const ids = [utter(ANA, 0.08, 1), utter(BRUNO, 0.08, 2), utter(ANA, 0.08, 3), utter(CARLA, 0.08, 4), utter(BRUNO, 0.08, 5)].map((e) => tr.assign(e).id);
  assert.deepEqual(ids, ['s1', 's2', 's1', 's3', 's2']);
  assert.equal(tr.speakers.find((s) => s.id === 's1').count, 2);
  const seeded = new SpeakerTracker({ threshold: 0.8, prefix: 's', speakers: [{ id: 's4', centroid: ANA, count: 3 }] });
  assert.equal(seeded.assign(utter(ANA, 0.08, 9)).id, 's4', 'resuming a note keeps its speakers');
  assert.equal(seeded.assign(utter(BRUNO, 0.08, 9)).id, 's5');
});

test('tracker: only a line of 2 s or more can start a speaker; a short stranger stays unlabelled', () => {
  const tr = new SpeakerTracker({ threshold: 0.8, prefix: 's' });
  assert.equal(tr.assign(utter(ANA, 0.08, 1), { seconds: 3 }).id, 's1');
  const cough = tr.assign(utter(BRUNO, 0.08, 2), { seconds: 0.9 });
  assert.equal(cough.id, null, 'a short unknown voice is not a new person');
  assert.equal(cough.isNew, false);
  assert.equal(tr.speakers.length, 1, 'and it did not make a speaker');
  assert.equal(tr.speakers[0].count, 1, 'nor did it change the centroid of the closest one');
  assert.equal(tr.assign(utter(ANA, 0.08, 3), { seconds: 0.9 }).id, 's1', 'a short line that sounds like somebody still joins them');
  assert.equal(tr.assign(utter(BRUNO, 0.08, 4), { seconds: 2 }).id, 's2', 'the same voice, long enough, is a new speaker');
  assert.equal(tr.assign(utter(CARLA, 0.08, 5)).id, 's3', 'without a length the old rule holds (imports, eval)');
  const capped = new SpeakerTracker({ threshold: 0.8, prefix: 's', max: 1 });
  capped.assign(utter(ANA, 0.08, 1), { seconds: 3 });
  assert.equal(capped.assign(utter(BRUNO, 0.08, 2), { seconds: 0.5 }).id, 's1', 'at the head count a short line joins the closest, as a long one does');
});

test('mergeClusters folds near-duplicates; matchVoices is one-to-one, best pairs first', () => {
  const { merged, speakers } = mergeClusters([{ id: 's1', centroid: utter(ANA, 0.05, 1), count: 5 }, { id: 's2', centroid: utter(ANA, 0.05, 2), count: 1 }, { id: 's3', centroid: BRUNO, count: 2 }], 0.9);
  assert.deepEqual([...merged], [['s2', 's1']]);
  assert.equal(speakers.find((s) => s.id === 's1').count, 6);
  const m = matchVoices([{ id: 's1', centroid: utter(ANA, 0.05, 7) }, { id: 's2', centroid: utter(ANA, 0.3, 8) }, { id: 's3', centroid: CARLA }], [{ id: 'v-ana', embedding: ANA }, { id: 'v-bruno', embedding: BRUNO }], 0.7);
  assert.deepEqual(m.get('s1').voiceId, 'v-ana');
  assert.equal(m.has('s2'), false, 'Ana is already taken by the closer match');
  assert.equal(m.has('s3'), false, 'Carla has no saved voice');
  assert.deepEqual(Array.from(fromBlob(toBlob(ANA))), Array.from(ANA));
});

test('default labels', () => {
  assert.equal(defaultLabel('m1', 'me'), 'Me');
  assert.equal(defaultLabel('m1', 'me', 'Alex'), 'Alex');
  assert.equal(defaultLabel('m2', 'me'), 'Room speaker 2');
  assert.equal(defaultLabel('s3', 'them'), 'Speaker 3');
  assert.equal(defaultLabel(null, 'them'), 'Them');
});

class FakeEngine extends EventEmitter { async start(m, o) { this.opts = o; } feed() {} async flush() {} reset() {} }
function rig() {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ speakerThreshold: 0.8 });
  const speakers = new Speakers(db, bus);
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/v', speakerInstalled: () => true, speakerPath: () => '/spk.onnx' };
  const platform = { capture: { mic: 'renderer', system: 'renderer' } };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, speakers });
  return { notes, speakers, engine, mgr, settings, bus };
}
const say = (engine, ch, startMs, text, emb) => engine.emit('segment', { ch, startMs, endMs: startMs + 2000, text, embedding: emb });

test('recording: who-said-what across several remote voices, naming, and recognising a saved voice next time', async () => {
  const { notes, speakers, engine, mgr } = rig();
  const n1 = notes.create({ title: 'Meeting 1' });
  await mgr.start(n1.id);
  assert.equal(engine.opts.speakerModel, '/spk.onnx', 'the voice model is loaded when speaker detection is on');
  mgr.pushPcm(n1.id, 'mic', Buffer.alloc(3200)); mgr.pushPcm(n1.id, 'system', Buffer.alloc(3200));
  say(engine, 'system', 0, 'hello everyone thanks for joining', utter(ANA, 0.08, 1));
  say(engine, 'system', 3000, 'happy to be here today', utter(BRUNO, 0.08, 2));
  say(engine, 'system', 5100, 'ok', null); // too short for a voice print -> inherits Bruno (gap < 3 s)
  say(engine, 'mic', 8000, 'let us start with the roadmap', utter(CARLA, 0.08, 3));
  say(engine, 'system', 12000, 'sure I can present that part', utter(ANA, 0.08, 4));
  await mgr.stop();
  const segs = notes.segments(n1.id);
  assert.deepEqual(segs.map((s) => s.label), ['Speaker 1', 'Speaker 2', 'Speaker 2', 'Me', 'Speaker 1']);
  const list = speakers.publicForNote(n1.id);
  assert.deepEqual(list.map((s) => s.speakerId), ['m1', 's1', 's2']);
  assert.ok(list.find((s) => s.speakerId === 's1').talkMs >= 4000, 'talk time per speaker');

  speakers.rename(n1.id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  speakers.rename(n1.id, 's2', 'Bruno', { remember: false });
  assert.deepEqual(notes.segments(n1.id).map((s) => s.label), ['Ana', 'Bruno', 'Bruno', 'Me', 'Ana']);
  assert.match(notes.transcriptText(n1.id), /^Ana: hello everyone/);
  assert.deepEqual(speakers.publicVoices().map((v) => v.name), ['Ana'], 'only remembered voices become profiles');

  const n2 = notes.create({ title: 'Meeting 2' });
  await mgr.start(n2.id, { mic: false });
  mgr.pushPcm(n2.id, 'system', Buffer.alloc(3200));
  say(engine, 'system', 0, 'quick update from my side', utter(BRUNO, 0.08, 11));
  say(engine, 'system', 3000, 'and here is mine as well', utter(ANA, 0.08, 12));
  await mgr.stop();
  assert.deepEqual(notes.segments(n2.id).map((s) => s.label), ['Speaker 1', 'Ana'], 'Ana is recognised by voice in a new meeting');
});

test('recording: a short line nobody sounds like is left unlabelled (its voice print kept), and does not lend its guess to the next', async () => {
  const { notes, speakers, engine, mgr } = rig();
  const n = notes.create({ title: 'Short strangers' });
  await mgr.start(n.id, { mic: false });
  mgr.pushPcm(n.id, 'system', Buffer.alloc(3200));
  const line = (startMs, ms, text, emb) => engine.emit('segment', { ch: 'system', startMs, endMs: startMs + ms, text, embedding: emb });
  line(0, 3000, 'hello everyone thanks for joining', utter(ANA, 0.08, 1));
  line(3500, 800, 'sneeze or cough', utter(BRUNO, 0.08, 2));      // short, and not Ana: nobody yet
  line(4400, 800, 'ok', null);                                       // no print, 0.1 s after the unlabelled line: must not inherit Ana
  line(5500, 3000, 'this is Bruno speaking at length', utter(BRUNO, 0.08, 3));
  line(9000, 700, 'yes', utter(ANA, 0.08, 4));                      // short but sounds like Ana: joins her
  assert.deepEqual(notes.segments(n.id).map((s) => s.speakerId), ['s1', null, null, 's2', 's1'], 'live');
  assert.deepEqual(notes.segments(n.id).map((s) => s.label), Array(5).fill('Them'), 'five lines in all: nobody has the five real lines to be shown yet');
  await mgr.stop();
  // after Stop the sneeze, which sounds like the Bruno who has since spoken at length, goes to him; the line with no print stays open
  assert.deepEqual(notes.segments(n.id).map((s) => s.speakerId), ['s1', 's2', null, 's2', 's1'], 'after Stop');
  assert.deepEqual(notes.segments(n.id).map((s) => s.label), ['Speaker 1', 'Speaker 2', 'Them', 'Speaker 2', 'Speaker 1']);
  const kept = speakers.segmentVoices(n.id);
  assert.ok(kept[1].embedding && kept[1].embedding.length === 32, 'the short line keeps its voice print, so the passes after Stop can place it');
});

test('recording: while it runs a voice is "Them" until it has five real lines and there are two; the same everywhere; after Stop all are shown', async () => {
  const { notes, speakers, engine, mgr, bus } = rig();
  const n = notes.create({ title: 'Live display' });
  const events = [];
  bus.subscribe((e) => events.push(e));
  await mgr.start(n.id, { mic: false });
  mgr.pushPcm(n.id, 'system', Buffer.alloc(3200));
  const sent = () => events.filter((e) => e.type === 'transcript.segment').map((e) => e.data.segment);
  const talk = (who, k, at) => { for (let i = 0; i < k; i++) say(engine, 'system', at + i * 2500, `this is real line ${i} said aloud`, utter(who, 0.08, at + i + 1)); };
  talk(ANA, 5, 0);
  assert.deepEqual(sent().map((s) => s.label), Array(5).fill('Them'), 'Ana alone, even with five lines, is not numbered');
  assert.deepEqual(sent().map((s) => s.labelKind), Array(5).fill('them'));
  talk(BRUNO, 4, 20000);
  assert.equal(sent().at(-1).label, 'Them', 'Bruno has four lines: still hidden');
  assert.equal(notes.segments(n.id).at(-1).label, 'Them');
  events.length = 0;
  talk(BRUNO, 1, 40000);
  assert.equal(sent().at(-1).label, 'Speaker 2', 'his fifth line shows him, and makes two voices');
  assert.equal(sent().at(-1).displayNo, 2);
  assert.ok(events.some((e) => e.type === 'speakers.updated'), 'the screens are told to redraw the lines they already show');
  const live = notes.segments(n.id);
  assert.deepEqual([...new Set(live.filter((s) => s.speakerId === 's1').map((s) => s.label))], ['Speaker 1'], 'Ana\'s earlier lines now say Speaker 1');
  assert.deepEqual([...new Set(live.filter((s) => s.speakerId === 's2').map((s) => s.label))], ['Speaker 2']);
  assert.deepEqual(speakers.publicForNote(n.id).map((s) => [s.speakerId, s.label, s.labelKind, s.displayNo]), [['s1', 'Speaker 1', 'speaker', 1], ['s2', 'Speaker 2', 'speaker', 2]]);
  await mgr.stop();
  assert.deepEqual([...new Set(notes.segments(n.id).map((s) => s.label))].sort(), ['Speaker 1', 'Speaker 2']);
  assert.equal(notes.transcriptText(n.id).split('\n')[0].startsWith('Speaker 1:'), true, 'the export and the prompts read the same labels');
});

test('consolidate merges a speaker split in two, but never two people the user named differently', async () => {
  const { notes, speakers } = rig();
  const n = notes.create({});
  const a1 = utter(ANA, 0.05, 1), a2 = utter(ANA, 0.05, 2);
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: a1, count: 4 });
  speakers.save(n.id, { speakerId: 's2', channel: 'system', centroid: a2, count: 1 });
  notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 1000, text: 'a' }, { speaker: 'them', speakerId: 's2', startMs: 2000, endMs: 3000, text: 'b' }]);
  assert.equal(speakers.consolidate(n.id, 0.9), 1);
  assert.deepEqual(notes.segments(n.id).map((s) => s.speakerId), ['s1', 's1']);
  const m = notes.create({});
  speakers.save(m.id, { speakerId: 's1', channel: 'system', centroid: a1, count: 4 });
  speakers.save(m.id, { speakerId: 's2', channel: 'system', centroid: a2, count: 1 });
  notes.addSegments(m.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 1000, text: 'a' }, { speaker: 'them', speakerId: 's2', startMs: 2000, endMs: 3000, text: 'b' }]);
  speakers.rename(m.id, 's1', 'Ana'); speakers.rename(m.id, 's2', 'Twin');
  assert.equal(speakers.consolidate(m.id, 0.9), 0);
  assert.equal(speakers.reassignSegment(m.id, notes.segments(m.id)[1].id, 's1'), true, 'manual correction');
  assert.deepEqual(notes.segments(m.id).map((s) => s.label), ['Ana', 'Ana']);
});

test('placeUnlabelled: a short line left without a speaker goes to the one it sounds like, and only that one', () => {
  const { notes, speakers } = rig();
  const n = notes.create({});
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: ANA, count: 4 });
  speakers.save(n.id, { speakerId: 's2', channel: 'system', centroid: BRUNO, count: 4 });
  notes.addSegments(n.id, [
    { speaker: 'them', speakerId: 's1', startMs: 0, endMs: 3000, text: 'long one', embedding: utter(ANA, 0.05, 1) },
    { speaker: 'them', speakerId: null, startMs: 3000, endMs: 3800, text: 'yes', embedding: utter(BRUNO, 0.05, 2) },
    { speaker: 'them', speakerId: null, startMs: 4000, endMs: 4800, text: 'cough', embedding: utter(CARLA, 0.05, 3) },
    { speaker: 'them', speakerId: null, startMs: 5000, endMs: 5400, text: 'ok', embedding: null },
  ]);
  assert.equal(speakers.placeUnlabelled(n.id, 0.8), 1);
  assert.deepEqual(notes.segments(n.id).map((s) => s.speakerId), ['s1', 's2', null, null], 'the stranger and the line with no print stay unlabelled');
  assert.equal(speakers.placeUnlabelled(n.id, 0.8), 0, 'nothing more to place');
  assert.equal(speakers.placeUnlabelled(n.id, 0.8, { channels: ['mic'] }), 0, 'a channel left out is left alone');
});

const models = testModels();
const realSkip = models && models.speakerInstalled() && models.isInstalled('parakeet-tdt-0.6b-v3') ? false : 'needs the speaker model and parakeet-tdt-0.6b-v3 (with its sample wavs)';
test('real voices: two different people on the call are told apart (on-device models)', { skip: realSkip, timeout: 180000 }, async (t) => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const speakers = new Speakers(db, bus);
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  const wav = (p) => wavToPcm16(fs.readFileSync(p));
  const sample = (f) => path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', f);
  const silence = Buffer.alloc(32000);
  // person A (en sample), person B (fixture speech), person A again
  for (const pcm of [wav(sample('en.wav')), silence, wav(fixture('speech-0.wav')), silence, wav(sample('en.wav')), silence]) {
    for (let i = 0; i < pcm.length; i += 3200) mgr.pushPcm(n.id, 'system', pcm.subarray(i, i + 3200));
  }
  await mgr.stop();
  const segs = notes.segments(n.id);
  const ids = segs.map((s) => s.speakerId);
  assert.ok(new Set(ids).size >= 2, `expected two voices, got ${JSON.stringify(segs.map((s) => [s.speakerId, s.text.slice(0, 20)]))}`);
  assert.equal(ids[0], ids[ids.length - 1], 'the first speaker is recognised when they speak again');
  assert.notEqual(ids[0], segs.find((s) => /phoebe|portrait/i.test(s.text))?.speakerId);
});
