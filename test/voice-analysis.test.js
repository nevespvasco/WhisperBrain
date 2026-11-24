'use strict';
// After-recording speaker analysis: acoustic features (pitch, timbre) and the refinement built on them.
// Voices are synthesised (test/voice-synth.js): each "person" has a pitch and a vocal-tract size, and every
// utterance says something different, so the tests also prove content does not fool the analysis.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { voiceFeatures, semitones, DIMS } = require('../src/audio/features');
const { refineChannel, refineNote } = require('../src/speakers/refine');
const { Spool } = require('../src/recording/spool');
const { Speakers } = require('../src/speakers/store');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');
const { utterance, toPcm16, rng, MAN, WOMAN, DEEP } = require('./voice-synth');
const path = require('node:path');
const { wavToPcm16 } = require('../src/audio/pcm');
const { AsrEngine } = require('../src/asr/engine');
const { tmpDir, testModels, fixture } = require('./helpers');

const VOICE = { man: MAN, woman: WOMAN, deep: DEEP };
const baseVec = (seed) => { const r = rng(seed * 7919); return Float32Array.from({ length: 32 }, () => r() - 0.5); };
const noisy = (base, noise, seed) => { const r = rng(seed); return Float32Array.from(base, (v) => v + (r() - 0.5) * noise); };
const EMB = { man: baseVec(1), woman: baseVec(2), deep: baseVec(3) };
const sayings = (who, n, seed0 = 0) => Array.from({ length: n }, (_, i) => voiceFeatures(utterance(VOICE[who], { seed: seed0 + 10 + i, seconds: 1.6 + (i % 5) * 0.4 })));
// fraction of utterance pairs on which the final grouping agrees with the truth (1 = perfect)
function agreement(segs, labelOf) {
  let ok = 0, total = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) { total++; if ((segs[i].truth === segs[j].truth) === (labelOf(segs[i]) === labelOf(segs[j]))) ok++; }
  return ok / total;
}
function build(spec) {
  return spec.map((s, i) => ({
    id: i + 1, truth: s.who, speakerId: s.guess, embedding: s.noEmb ? null : noisy(s.embBase || EMB[s.who], s.noise ?? 0.5, 100 + i),
    acoustic: voiceFeatures(utterance(VOICE[s.who], { seed: 10 + i, seconds: 1.6 + (i % 5) * 0.4 })),
  }));
}

test('features: pitch is measured within a few percent and describes the voice, not the words', () => {
  for (const [who, hz] of [['man', MAN.f0], ['woman', WOMAN.f0], ['deep', DEEP.f0]]) {
    for (const f of sayings(who, 4)) {
      assert.ok(f && f.vec.length === DIMS.length);
      assert.ok(Math.abs(f.f0 - hz) / hz < 0.12, `${who}: expected ~${hz} Hz, got ${Math.round(f.f0)}`);
    }
  }
  const [m1, m2] = sayings('man', 2), [w1] = sayings('woman', 1);
  assert.ok(semitones(m1.f0, w1.f0) > 6, 'a man and a woman are an octave-ish apart');
  assert.ok(semitones(m1.f0, m2.f0) < 2, 'the same man saying different things stays put');
});

test('features: silence, noise and clips that are too short describe nothing', () => {
  assert.equal(voiceFeatures(new Float32Array(16000)), null, 'silence');
  const r = rng(5);
  assert.equal(voiceFeatures(Float32Array.from({ length: 24000 }, () => (r() - 0.5) * 0.4)), null, 'white noise has no pitch');
  assert.equal(voiceFeatures(utterance(MAN, { seconds: 0.3 })), null, 'less than half a second');
});

test('refine: utterances the online pass put with the wrong person are corrected from the final voices', () => {
  const order = ['man', 'woman', 'deep'];
  const spec = Array.from({ length: 30 }, (_, i) => ({ who: order[i % 3], guess: `s${(i % 3) + 1}` }));
  for (const k of [2, 5, 8, 11, 14, 17, 20, 25]) spec[k].guess = `s${((spec[k].guess.slice(1) % 3) + 1)}`; // 8 of 30 misjudged
  const segs = build(spec);
  const before = agreement(segs, (s) => s.speakerId);
  const res = refineChannel({ segments: segs, speakers: [1, 2, 3].map((k) => ({ id: `s${k}`, count: 10 })), prefix: 's' });
  const after = agreement(segs, (s) => res.assignments.get(s.id) || s.speakerId);
  assert.ok(before < 0.85 && after === 1, `before ${before.toFixed(3)} after ${after.toFixed(3)}`);
  assert.ok(res.speakers.every((s) => s.pitch > 80 && s.pitch < 260), 'each speaker gets a pitch');
});

test('refine: two people the voice model could not tell apart are split by pitch and timbre', () => {
  const same = EMB.man; // identical embeddings: the online pass can only ever see one voice
  const spec = Array.from({ length: 24 }, (_, i) => ({ who: i % 2 ? 'woman' : 'man', guess: 's1', embBase: same, noise: 0.9 }));
  const segs = build(spec);
  const res = refineChannel({ segments: segs, speakers: [{ id: 's1', count: 24 }], prefix: 's' });
  assert.equal(res.stats.split, 1);
  assert.equal(agreement(segs, (s) => res.assignments.get(s.id) || s.speakerId), 1);
  assert.ok(res.speakers.find((s) => s.isNew && s.id === 's2'), 'the second person gets the next free id');
});

test('refine: two similar voices (3 semitones apart) are still separated when the embeddings only partly agree', () => {
  const near = Float32Array.from(EMB.man, (v, i) => v * 0.55 + EMB.deep[i] * 0.6);
  const spec = Array.from({ length: 24 }, (_, i) => ({ who: i % 2 ? 'deep' : 'man', guess: 's1', embBase: i % 2 ? near : EMB.man, noise: 0.5 }));
  const segs = build(spec);
  const res = refineChannel({ segments: segs, speakers: [{ id: 's1', count: 24 }], prefix: 's' });
  assert.equal(agreement(segs, (s) => res.assignments.get(s.id) || s.speakerId), 1);
});

test('refine: one person who was cut into two clusters is put back together', () => {
  const segs = build(Array.from({ length: 20 }, (_, i) => ({ who: 'man', guess: i % 2 ? 's1' : 's2', embBase: EMB.man })));
  const res = refineChannel({ segments: segs, speakers: [{ id: 's1', count: 10 }, { id: 's2', count: 10 }], prefix: 's' });
  assert.equal(res.stats.merged, 1);
  assert.equal(agreement(segs, (s) => res.assignments.get(s.id) || s.speakerId), 1);
  assert.equal(res.removed.size, 1);
});

test('refine: it never merges people the user has named differently, and never invents speakers for one voice', () => {
  const segs = build(Array.from({ length: 20 }, (_, i) => ({ who: 'man', guess: i % 2 ? 's1' : 's2', embBase: EMB.man })));
  const res = refineChannel({ segments: segs, speakers: [{ id: 's1', count: 10, name: 'Ana' }, { id: 's2', count: 10, name: 'Bruno' }], prefix: 's' });
  assert.equal(res.stats.merged, 0, 'Ana and Bruno stay two people even if they sound alike');
  for (let rep = 0; rep < 12; rep++) { // a single, expressive speaker (±10 % pitch swings), many sizes
    const n = 12 + (rep % 4) * 8;
    const one = Array.from({ length: n }, (_, i) => {
      const swing = { ...MAN, f0: MAN.f0 * (1 + (rng(rep * 31 + i)() - 0.5) * 0.2) };
      return { id: i + 1, speakerId: 's1', embedding: noisy(EMB.man, 0.9, 500 + rep * 50 + i), acoustic: voiceFeatures(utterance(swing, { seed: 900 + rep * 50 + i, seconds: 1 + (i % 6) * 0.5 })) };
    });
    const r = refineChannel({ segments: one, speakers: [{ id: 's1', count: n }], prefix: 's' });
    assert.equal(r.stats.split, 0, `false split in run ${rep}`);
  }
});

test('refine: correctly labelled speakers are left exactly as they were', () => {
  const order = ['man', 'woman', 'deep'];
  const segs = build(Array.from({ length: 36 }, (_, i) => ({ who: order[i % 3], guess: `s${(i % 3) + 1}` })));
  const res = refineChannel({ segments: segs, speakers: [1, 2, 3].map((k) => ({ id: `s${k}`, count: 12 })), prefix: 's' });
  assert.equal(res.assignments.size, 0);
  assert.deepEqual([res.stats.split, res.stats.merged], [0, 0]);
});

test('refine: without audio it still re-checks labels against the final voice centroids', () => {
  const segs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, truth: i % 2 ? 'woman' : 'man', speakerId: i < 2 ? 's2' : i % 2 ? 's2' : 's1', embedding: noisy(i % 2 ? EMB.woman : EMB.man, 0.3, 40 + i) }));
  segs[0].speakerId = 's2'; // the very first utterance was judged before the voices were known
  const res = refineChannel({ segments: segs, speakers: [{ id: 's1', count: 5 }, { id: 's2', count: 7 }], prefix: 's' });
  assert.equal(res.assignments.get(1), 's1');
  assert.equal(res.stats.described, 0);
});

test('spool: audio goes in, any stretch comes back out, and the file disappears on close', () => {
  const dir = tmpDir('wb-spool-');
  const sp = new Spool(dir, 'note-1', 'mic');
  const pcm = toPcm16(utterance(MAN, { seconds: 1 }));
  sp.write(pcm.subarray(0, 10000)); sp.write(pcm.subarray(10000));
  assert.equal(sp.samples, 16000);
  assert.deepEqual(sp.read(100, 200), pcm.subarray(200, 400));
  assert.equal(sp.read(15900, 20000).length, 200, 'reading past the end is clipped');
  assert.equal(fs.statSync(sp.file).mode & 0o077, 0, 'private to the user');
  sp.close();
  assert.equal(fs.existsSync(sp.file), false);
  fs.writeFileSync(`${dir}/stale.pcm`, 'x');
  assert.equal(Spool.sweep(dir), 1, 'leftovers of a crash are swept');
  fs.rmSync(dir, { recursive: true });
});

function world() {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const speakers = new Speakers(db, bus);
  const settings = new Settings(db, bus);
  return { db, bus, events, notes, speakers, settings };
}

test('store: a refinement is saved atomically, names follow merges, pitch is kept, and pitch vetoes bad merges', () => {
  const { notes, speakers, db } = world();
  const n = notes.create({});
  const e1 = EMB.man, e2 = noisy(EMB.man, 0.1, 3);
  notes.addSegments(n.id, [1, 2, 3].map((k) => ({ speaker: 'them', speakerId: k === 3 ? 's2' : 's1', startMs: k * 1000, endMs: k * 1000 + 800, text: `t${k}`, embedding: e1 })));
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: e1, count: 2 });
  speakers.save(n.id, { speakerId: 's2', channel: 'system', centroid: e2, count: 1 });
  speakers.rename(n.id, 's2', 'Ana');
  const ids = db.prepare('SELECT id FROM segments WHERE note_id = ? ORDER BY id').all(n.id).map((r) => r.id);
  speakers.applyRefinement(n.id, 'system', {
    assignments: new Map([[ids[2], 's1']]),
    speakers: [{ id: 's1', centroid: e1, count: 3, pitch: 118.5, isNew: false }],
    removed: new Map([['s2', 's1']]),
  });
  const after = speakers.forNote(n.id);
  assert.deepEqual(after.map((s) => s.speakerId), ['s1']);
  assert.equal(after[0].name, 'Ana', 'the merged-away speaker\'s name survives on the speaker that remains');
  assert.equal(Math.round(after[0].pitch), 119);
  assert.deepEqual(notes.segments(n.id).map((s) => s.speakerId), ['s1', 's1', 's1']);
  // pitch veto: two clusters with near-identical embeddings but a 7-semitone pitch gap are not folded together
  const m = notes.create({});
  speakers.save(m.id, { speakerId: 's1', channel: 'system', centroid: e1, count: 4, pitch: 110 });
  speakers.save(m.id, { speakerId: 's2', channel: 'system', centroid: e2, count: 4, pitch: 165 });
  assert.equal(speakers.consolidate(m.id, 0.6), 0, 'a clearly different pitch is a different person');
  db.prepare('UPDATE note_speakers SET pitch = 112 WHERE note_id = ? AND speaker_id = ?').run(m.id, 's2');
  assert.equal(speakers.consolidate(m.id, 0.6), 1, 'with similar pitch the usual embedding merge happens');
});

test('store: a saved voice is not matched to a speaker whose pitch is far off', () => {
  const { notes, speakers } = world();
  const a = notes.create({}), b = notes.create({});
  notes.addSegments(a.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 900, text: 'hi', embedding: EMB.man }]);
  speakers.save(a.id, { speakerId: 's1', channel: 'system', centroid: EMB.man, count: 5, pitch: 115 });
  speakers.rename(a.id, 's1', 'Carlos', { remember: true });
  speakers.save(b.id, { speakerId: 's1', channel: 'system', centroid: noisy(EMB.man, 0.1, 9), count: 3, pitch: 210 });
  assert.equal(speakers.autoMatch(b.id, 0.65), 0, 'same embedding but an octave higher: not Carlos');
  speakers.save(b.id, { speakerId: 's1', channel: 'system', centroid: noisy(EMB.man, 0.1, 9), count: 3, pitch: 118 });
  assert.equal(speakers.autoMatch(b.id, 0.65), 1);
});

// A scripted engine: tests decide which utterances come back.
class FakeEngine extends EventEmitter {
  async start() {} feed() {} async flush() {} reset() {}
}

test('recording: raw audio is parked while recording, analysed after Stop, and deleted; two voices behind one embedding become two speakers', async () => {
  const { notes, speakers, settings, bus, events } = world();
  const spoolDir = tmpDir('wb-spool-');
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk' };
  const platform = { capture: { mic: 'renderer', system: 'renderer' }, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource() };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, speakers, spoolDir });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false, system: true });

  // a conversation: man, woman, man, woman… (all with one and the same voice embedding)
  let clock = 0;
  const gap = Buffer.alloc(16000 * 2 * 0.4);
  const same = EMB.man;
  for (let i = 0; i < 16; i++) {
    const who = i % 2 ? WOMAN : MAN;
    const pcm = toPcm16(utterance(who, { seed: 50 + i, seconds: 2 }));
    assert.ok(mgr.pushPcm(n.id, 'system', pcm));
    mgr.pushPcm(n.id, 'system', gap);
    engine.emit('segment', { ch: 'system', startMs: clock, endMs: clock + 2000, text: `line ${i}`, embedding: noisy(same, 0.25, 700 + i) });
    clock += 2400;
  }
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.pcm')).length, 1, 'one spool file while recording');
  assert.equal(new Set(notes.segments(n.id).map((s) => s.speakerId)).size, 1, 'online, the two people look like one');

  const done = await mgr.stop();
  assert.equal(done.noteId, n.id);
  assert.equal(fs.readdirSync(spoolDir).length, 0, 'the audio is gone once the analysis is done');
  const ids = notes.segments(n.id).map((s) => s.speakerId);
  assert.equal(new Set(ids).size, 2, 'afterwards, two speakers');
  assert.ok(ids.every((id, i) => id === ids[i % 2]) && ids[0] !== ids[1], 'alternating, exactly as spoken');
  const pitches = speakers.forNote(n.id).map((s) => Math.round(s.pitch)).sort((a, b) => a - b);
  assert.ok(pitches[0] > 90 && pitches[0] < 140 && pitches[1] > 170 && pitches[1] < 240, `pitches ${pitches}`);
  const stages = events.filter((e) => e.type === 'recording.finalizing').map((e) => e.data.stage);
  assert.deepEqual(stages, ['transcribing', 'speakers']);
  fs.rmSync(spoolDir, { recursive: true });
});

test('recording: the analysis is skippable and never gets in the way of stopping', async () => {
  const { notes, speakers, settings, bus } = world();
  settings.update({ speakerRefine: false, speakerDiarize: false });
  const spoolDir = tmpDir('wb-spool-');
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk' };
  const platform = { capture: { mic: 'renderer', system: 'renderer' }, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource() };
  const engine = new FakeEngine();
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, speakers, spoolDir });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false, system: true });
  mgr.pushPcm(n.id, 'system', toPcm16(utterance(MAN, { seconds: 1 })));
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 900, text: 'hello', embedding: EMB.man });
  assert.equal(fs.readdirSync(spoolDir).length, 0, 'with both after-recording passes off nothing is written to disk');
  await mgr.stop();
  assert.equal(notes.segments(n.id).length, 1);
  // and with a refinement that blows up, Stop still completes and the audio is still cleaned up
  settings.update({ speakerRefine: true });
  const original = speakers.applyRefinement;
  speakers.applyRefinement = () => { throw new Error('disk on fire'); };
  const m = notes.create({});
  await mgr.start(m.id, { mic: false, system: true });
  mgr.pushPcm(m.id, 'system', toPcm16(utterance(MAN, { seconds: 1 })));
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 900, text: 'hello again', embedding: EMB.man });
  const r = await mgr.stop();
  speakers.applyRefinement = original;
  assert.equal(r.note.status, 'done');
  assert.equal(fs.readdirSync(spoolDir).length, 0);
  fs.rmSync(spoolDir, { recursive: true });
});

test('refineNote: audio that cannot be read just means the voice model decides alone', async () => {
  const { notes, speakers } = world();
  const n = notes.create({});
  notes.addSegments(n.id, [1, 2, 3, 4].map((k) => ({ speaker: 'them', speakerId: 's1', startMs: k * 1000, endMs: k * 1000 + 900, text: `t${k}`, embedding: EMB.man })));
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: EMB.man, count: 4 });
  const ids = notes.segments(n.id).map((s) => s.id);
  const out = await refineNote({ speakers, noteId: n.id, refs: ids.map((segId) => ({ segId, ch: 'system', from: 0, to: 16000 })), read: () => { throw new Error('gone'); } });
  assert.equal(out.described, 0);
  assert.deepEqual(notes.segments(n.id).map((s) => s.speakerId), ['s1', 's1', 's1', 's1']);
});

const models = testModels();
const realSkip = models && models.speakerInstalled() && models.isInstalled('parakeet-tdt-0.6b-v3') ? false : 'needs the speaker model and parakeet-tdt-0.6b-v3 (with its sample wavs)';
test('real voices: the after-recording analysis leaves two real speakers apart, records their pitch and deletes the audio', { skip: realSkip, timeout: 180000 }, async (t) => {
  const { notes, speakers, settings, bus, events } = world();
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  const spoolDir = tmpDir('wb-real-spool-');
  t.after(() => fs.rmSync(spoolDir, { recursive: true, force: true }));
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  const wav = (p) => wavToPcm16(fs.readFileSync(p));
  const sample = (f) => path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', f);
  const silence = Buffer.alloc(32000);
  for (const pcm of [wav(sample('en.wav')), silence, wav(fixture('speech-0.wav')), silence, wav(sample('en.wav')), silence]) {
    for (let i = 0; i < pcm.length; i += 3200) mgr.pushPcm(n.id, 'system', pcm.subarray(i, i + 3200));
  }
  await mgr.stop();
  const segs = notes.segments(n.id);
  const ids = segs.map((s) => s.speakerId);
  assert.ok(new Set(ids).size >= 2, JSON.stringify(segs.map((s) => [s.speakerId, s.text.slice(0, 20)])));
  assert.equal(ids[0], ids[ids.length - 1], 'the first speaker is still recognised when they speak again');
  assert.ok(speakers.forNote(n.id).every((s) => s.pitch > 70 && s.pitch < 400), `pitches: ${speakers.forNote(n.id).map((s) => s.pitch)}`);
  assert.deepEqual(events.filter((e) => e.type === 'recording.finalizing').map((e) => e.data.stage), ['transcribing', 'speakers']);
  assert.equal(fs.readdirSync(spoolDir).length, 0);
});
