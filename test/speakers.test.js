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
  return { notes, speakers, engine, mgr, settings };
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
