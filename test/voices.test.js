'use strict';
// Saved voices: several prints per profile, centred scoring, the margin rule, reinforcement and corrections,
// and the migration that gives existing profiles their first print. (Synthetic 32-dimensional voices: the shipped
// average voice is for the real 256-dimensional model, so these go through the plain-cosine path.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { matchVoices, voiceScore, addPrint, cosine, centre, populationMean, MATCH, VOICE_MEAN, toBlob } = require('../src/speakers/cluster');
const { Speakers } = require('../src/speakers/store');
const { open, MIGRATIONS } = require('../src/core/db');
const { Notes } = require('../src/core/notes');

function voice(seed, dim = 32) { const v = new Float32Array(dim); let x = seed * 9301 + 49297; for (let i = 0; i < dim; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; } return v; }
function utter(base, noise = 0.08, seed = 1) { const v = Float32Array.from(base); let x = seed; for (let i = 0; i < v.length; i++) { x = (x * 16807) % 2147483647; v[i] += (x / 2147483647 - 0.5) * noise; } return v; }
const ANA = voice(1), BRUNO = voice(2);
const TWIN = utter(ANA, 0.6, 5);            // a different person who sounds a lot like Ana

function rig() {
  const db = open(':memory:');
  const notes = new Notes(db, null);
  const speakers = new Speakers(db, null);
  // a meeting with the given speakers [{ id, centroid, channel?, secs? }]
  const meeting = (list) => {
    const n = notes.create({});
    for (const s of list) {
      speakers.save(n.id, { speakerId: s.id, channel: s.channel || 'system', centroid: s.centroid, count: s.count || 5 });
      notes.addSegments(n.id, [{ speaker: 'them', speakerId: s.id, startMs: 0, endMs: (s.secs || 10) * 1000, text: 'x' }]);
    }
    return n.id;
  };
  const linked = (noteId) => Object.fromEntries(speakers.forNote(noteId).map((s) => [s.speakerId, s.voiceName || null]));
  return { db, notes, speakers, meeting, linked };
}

test('the synthetic voices are what the tests need: Twin is close to Ana but not the same', () => {
  const c = cosine(ANA, TWIN);
  assert.ok(c > 0.8 && c < 0.97, `cos ${c}`);
  assert.ok(cosine(ANA, BRUNO) < 0.5);
});

test('matchVoices: a speaker nearly as close to two voices is not guessed; a clear winner is linked', () => {
  const voices = [{ id: 'ana', embedding: ANA }, { id: 'twin', embedding: TWIN }];
  const near = utter(ANA, 0.05, 3);      // right on Ana
  const between = new Float32Array(ANA.length).map((_, i) => ANA[i] + TWIN[i]); // as close to one as to the other
  const T = 0.7;
  assert.equal(matchVoices([{ id: 's1', centroid: near }], voices, T, null, { margin: 0 }).get('s1')?.voiceId, 'ana');
  assert.equal(matchVoices([{ id: 's1', centroid: between }], voices, T, null, { margin: 0 }).size, 1, 'without the rule it picks one of them');
  assert.equal(matchVoices([{ id: 's1', centroid: between }], voices, T, null, { margin: 0.05 }).size, 0, 'with the rule it stays undecided');
  assert.equal(matchVoices([{ id: 's1', centroid: near }], voices, T, null, { margin: 0.05 }).get('s1')?.voiceId, 'ana', 'a clear winner is still linked');
  // one voice, nothing to compare with: the margin does not apply
  assert.equal(matchVoices([{ id: 's1', centroid: near }], [voices[0]], T, null, { margin: 0.05 }).get('s1')?.voiceId, 'ana');
});

test('centring on the average voice separates people who share a large common component', () => {
  const dim = 64;
  const unit = (v) => centre(v, null);
  const common = unit(voice(9, dim));
  const person = (k) => unit(common.map((x, i) => x * 3 + unit(voice(100 + k, dim))[i]));   // what every voice has in common, plus the person
  const mu = new Float32Array(dim);
  for (let k = 0; k < 30; k++) person(k + 10).forEach((x, i) => { mu[i] += x / 30; });      // the average voice
  const a = person(1), b = person(2);
  assert.ok(cosine(a, b) > 0.8, `raw cosine of two different people is high: ${cosine(a, b)}`);
  assert.ok(cosine(centre(a, mu), centre(b, mu)) < 0.5, 'centred, they are far apart');
  assert.ok(cosine(centre(a, mu), centre(utter(a, 0.02, 4), mu)) > 0.9, 'the same person stays close');
  const speaker = [{ id: 's1', centroid: utter(b, 0.02, 6) }];
  const voices = [{ id: 'ana', embedding: a }];
  assert.equal(matchVoices(speaker, voices, 0.7, null, { mu: null, margin: 0 }).size, 1, 'plain cosine links the stranger (raw mode still needs 0.8 or more, and she scores above that)');
  assert.equal(matchVoices([{ id: 's1', centroid: utter(a, 0.02, 6) }], voices, 0.55, null, { mu }).get('s1')?.voiceId, 'ana');
  assert.equal(matchVoices(speaker, voices, 0.55, null, { mu }).size, 0, 'a stranger is not linked at a plain 0.55 centred');
  assert.equal(VOICE_MEAN.length, 256);
});

test('addPrint: the same speaker replaces its print, near prints of a channel fold together, other channels stay apart, the list is capped', () => {
  let list = addPrint([], { embedding: ANA, weight: 20, channel: 'system', source: 'n1:s1' });
  list = addPrint(list, { embedding: utter(ANA, 0.04, 2), weight: 10, channel: 'system', source: 'n2:s1' });
  assert.equal(list.length, 1, 'a near-identical print of the same channel is folded in');
  assert.equal(list[0].weight, 30);
  list = addPrint(list, { embedding: utter(ANA, 0.04, 3), weight: 5, channel: 'mic', source: 'n3:s1' });
  assert.deepEqual(list.map((p) => p.channel).sort(), ['mic', 'system'], 'the same sound on another channel is a separate print');
  const again = addPrint(list, { embedding: BRUNO, weight: 8, channel: 'mic', source: 'n3:s1' });
  assert.equal(again.length, 2, 'confirming the same speaker again replaces its print');
  assert.ok(cosine(again.find((p) => p.channel === 'mic').embedding, BRUNO) > 0.99);
  let many = [];
  for (let k = 0; k < 12; k++) many = addPrint(many, { embedding: voice(50 + k), weight: 5, channel: k % 2 ? 'mic' : 'system', source: `n${k}:s1` }, { max: 4 });
  assert.equal(many.length, 4);
  assert.ok(many.every((p) => p.weight > 0));
});

test('a profile keeps a print per channel: a person saved on the mic and on a call is recognised either way', () => {
  // the call changes the sound: a fixed offset on a few dimensions
  const call = (v) => v.map((x, i) => (i % 4 === 0 ? x + 0.5 : x));
  const mic = ANA, onCall = call(ANA);
  assert.ok(cosine(mic, onCall) < 0.9);
  let prints = addPrint([], { embedding: mic, weight: 20, channel: 'mic' });
  prints = addPrint(prints, { embedding: onCall, weight: 20, channel: 'system' });
  assert.equal(prints.length, 2);
  const both = { id: 'ana', embedding: ANA, exemplars: prints };
  const micOnly = { id: 'ana', embedding: ANA, exemplars: [prints[0]] };
  const heardOnCall = utter(onCall, 0.05, 8);
  assert.ok(voiceScore(heardOnCall, both, { mu: null, channel: 'system' }) > 0.98);
  assert.ok(voiceScore(heardOnCall, micOnly, { mu: null, channel: 'system' }) < voiceScore(heardOnCall, both, { mu: null, channel: 'system' }) - MATCH.cross + 0.05, 'a print from the other channel is discounted');
});

test('rename(remember) adds prints weighted by speech time; confirming the same speaker twice does not count it twice', () => {
  const { speakers, meeting } = rig();
  const n1 = meeting([{ id: 's1', centroid: ANA, secs: 40, count: 12 }]);
  speakers.rename(n1, 's1', 'Ana', { remember: true, consentSource: 'user' });
  let [v] = speakers.voices();
  assert.equal(v.exemplars.length, 1);
  assert.equal(v.exemplars[0].weight, 30, 'weight is the seconds of speech, capped at the 30 s a print covers');
  assert.equal(v.exemplars[0].channel, 'system');
  assert.equal(v.samples, 12);
  const n2 = meeting([{ id: 's1', centroid: call(ANA), channel: 'mic', secs: 6, count: 2 }]);
  speakers.rename(n2, 's1', 'Ana', { remember: true, consentSource: 'user' });
  [v] = speakers.voices();
  assert.deepEqual(v.exemplars.map((x) => [x.channel, x.weight]).sort(), [['mic', 6], ['system', 30]], 'a print per channel');
  assert.equal(v.samples, 14);
  speakers.rename(n2, 's1', 'Ana', { remember: true, consentSource: 'user' });
  assert.equal(speakers.voices()[0].exemplars.length, 2, 'the same speaker confirmed again replaces its print');
  assert.equal(speakers.publicVoices()[0].prints, 2);
  function call(x) { return x.map((y, i) => (i % 3 === 0 ? y + 0.4 : y)); }
});

test('autoMatch judges again: a live guess is corrected by a better print, speakers the user named are left alone', () => {
  const { speakers, meeting, linked } = rig();
  const n0 = meeting([{ id: 's1', centroid: ANA }, { id: 's2', centroid: BRUNO }]);
  speakers.rename(n0, 's1', 'Ana', { remember: true, consentSource: 'user' });
  speakers.rename(n0, 's2', 'Bruno', { remember: true, consentSource: 'user' });
  const n = meeting([{ id: 's1', centroid: utter(ANA, 0.05, 2) }, { id: 's2', centroid: voice(3) }]);
  assert.equal(speakers.autoMatch(n), 1);
  assert.deepEqual(linked(n), { s1: 'Ana', s2: null });
  // the live print of s2 was a bit like Bruno: that guess is made, then the after-recording print says otherwise
  speakers.save(n, { speakerId: 's2', channel: 'system', centroid: utter(BRUNO, 0.05, 4), count: 5 });
  speakers.autoMatch(n);
  assert.deepEqual(linked(n), { s1: 'Ana', s2: 'Bruno' });
  speakers.save(n, { speakerId: 's2', channel: 'system', centroid: voice(3), count: 9 });
  speakers.autoMatch(n);
  assert.deepEqual(linked(n), { s1: 'Ana', s2: null }, 'the better print no longer sounds like Bruno: the link is withdrawn');
  speakers.rename(n, 's2', 'Carla');
  speakers.save(n, { speakerId: 's2', channel: 'system', centroid: utter(BRUNO, 0.05, 5), count: 9 });
  speakers.autoMatch(n);
  assert.equal(speakers.forNote(n).find((s) => s.speakerId === 's2').voiceId, null, 'a speaker the user named is never re-linked');
});

test('a correction pushes the wrong profile away: the same wrong match is not made again, and the profile is not renamed', () => {
  const { speakers, meeting, linked } = rig();
  const n0 = meeting([{ id: 's1', centroid: ANA }]);
  speakers.rename(n0, 's1', 'Ana', { remember: true, consentSource: 'user' });
  // Ana's lookalike on a later call is linked to Ana automatically ...
  const n1 = meeting([{ id: 's1', centroid: TWIN }]);
  assert.deepEqual(linked(n1), { s1: null });
  speakers.autoMatch(n1, 0.7, { margin: 0 });
  assert.deepEqual(linked(n1), { s1: 'Ana' }, 'the setup: a wrong automatic link');
  // ... the user says it is Twin, and remembers the voice
  speakers.rename(n1, 's1', 'Twin', { remember: true, consentSource: 'user' });
  assert.deepEqual(speakers.voices().map((v) => v.name), ['Ana', 'Twin'], 'Ana stays Ana: a second profile is born');
  const ana = speakers.voices().find((v) => v.name === 'Ana');
  assert.equal(ana.exemplars.filter((x) => x.negative).length, 1, 'Ana remembers that this was not her');
  assert.equal(ana.exemplars.filter((x) => !x.negative).length, 1);
  // next time Twin speaks, the same sound is Twin, not Ana
  const n2 = meeting([{ id: 's1', centroid: utter(TWIN, 0.05, 6) }]);
  speakers.autoMatch(n2, 0.7, { margin: 0 });
  assert.deepEqual(linked(n2), { s1: 'Twin' });
  // and without a Twin profile the rejected sound is not given back to Ana either
  speakers.removeVoice(speakers.voices().find((v) => v.name === 'Twin').id);
  const n3 = meeting([{ id: 's1', centroid: utter(TWIN, 0.05, 7) }]);
  speakers.autoMatch(n3, 0.7, { margin: 0 });
  assert.deepEqual(linked(n3), { s1: null });
  // Ana herself is still recognised
  const n4 = meeting([{ id: 's1', centroid: utter(ANA, 0.05, 8) }]);
  speakers.autoMatch(n4, 0.7, { margin: 0 });
  assert.deepEqual(linked(n4), { s1: 'Ana' });
});

test('renaming a speaker the user had confirmed under a name nobody else has renames the profile (as before)', () => {
  const { speakers, meeting } = rig();
  const n = meeting([{ id: 's1', centroid: ANA }]);
  speakers.rename(n, 's1', 'Anna', { remember: true, consentSource: 'user' });
  speakers.rename(n, 's1', 'Ana', { remember: true, consentSource: 'user' });
  const vs = speakers.voices();
  assert.deepEqual(vs.map((v) => v.name), ['Ana']);
  assert.equal(vs[0].exemplars.filter((x) => x.negative).length, 0);
});

test('migration: a profile from before the print table keeps matching and becomes its first print', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-voices-'));
  const file = path.join(dir, 'x.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  const upto = MIGRATIONS.findIndex((m) => /voice_exemplars/.test(m));
  assert.ok(upto > 0, 'the voice_exemplars migration exists');
  for (let i = 0; i < upto; i++) raw.exec(MIGRATIONS[i]);
  raw.exec(`PRAGMA user_version = ${upto}`);
  raw.prepare('INSERT INTO voices(id, name, embedding, samples, pitch, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run('v1', 'Ana', toBlob(ANA), 7, 190, 1, 2);
  raw.prepare('INSERT INTO voices(id, name, embedding, samples, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)').run('v2', 'Bruno', toBlob(BRUNO), 1, 1, 2);
  raw.close();
  const db = open(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const rows = db.prepare('SELECT voice_id, weight, channel, negative, pitch FROM voice_exemplars ORDER BY voice_id').all();
  assert.deepEqual(rows.map((r) => [r.voice_id, r.channel, r.negative]), [['v1', '', 0], ['v2', '', 0]]);
  assert.equal(rows[0].weight, 28, 'seven utterances count as about four seconds each');
  assert.equal(rows[0].pitch, 190);
  const speakers = new Speakers(db, null);
  assert.deepEqual(speakers.voices().map((v) => [v.name, v.exemplars.length]), [['Ana', 1], ['Bruno', 1]]);
  const notes = new Notes(db, null);
  const n = notes.create({});
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: utter(ANA, 0.05, 3), count: 4 });
  speakers.save(n.id, { speakerId: 's2', channel: 'system', centroid: voice(7), count: 4 });
  assert.equal(speakers.autoMatch(n.id), 1);
  assert.equal(speakers.forNote(n.id).find((s) => s.speakerId === 's1').voiceName, 'Ana');
  // a profile with no print row at all (rows made by an older build) still matches through its mean
  db.prepare('DELETE FROM voice_exemplars').run();
  const m = notes.create({});
  speakers.save(m.id, { speakerId: 's1', channel: 'system', centroid: utter(BRUNO, 0.05, 3), count: 4 });
  assert.equal(speakers.autoMatch(m.id), 1);
  // reinforcing it brings its mean in as the first print
  speakers.rename(m.id, 's1', 'Bruno', { remember: true, consentSource: 'user' });
  assert.equal(speakers.voices().find((v) => v.name === 'Bruno').exemplars.length, 1, 'the mean and the new print were close enough to fold together');
  // forgetting a voice takes its prints along
  speakers.removeVoice('v1');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM voice_exemplars WHERE voice_id = 'v1'").get().c, 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('populationMean: a voice heard often counts once, and the shipped mean counts as a few voices', () => {
  const dim = 16;
  const e = (k) => Float32Array.from({ length: dim }, (_, i) => (i === k ? 1 : 0));
  const prior = Float32Array.from({ length: dim }, () => 0.25);
  const often = Array.from({ length: 20 }, (_, k) => utter(e(0), 0.02, k + 1));       // the user's own voice, in every meeting
  const mu = populationMean([...often, e(1), e(2)], null, 0);
  assert.ok(Math.abs(mu[0] - 1 / 3) < 0.02 && Math.abs(mu[1] - 1 / 3) < 0.02, `three distinct voices, one third each: ${mu[0]}, ${mu[1]}`);
  assert.deepEqual(Array.from(populationMean([], prior, 3)), Array.from(prior), 'nothing heard yet: the shipped mean');
  const mix = populationMean([e(0)], prior, 3);
  assert.ok(Math.abs(mix[0] - (0.75 + 1) / 4) < 1e-6, 'a prior of weight 3 and one heard voice');
  assert.equal(populationMean([], null, 0), null);
});

test('Speakers.channelMeans: each channel is centred on the voices heard on it', () => {
  const { speakers, meeting } = rig();
  const dim = 256;
  const rnd = (k) => Float32Array.from({ length: dim }, (_, i) => voice(k, dim)[i]);
  const callColour = rnd(777).map((x) => x * 3);
  for (let k = 0; k < 12; k++) meeting([{ id: 's1', centroid: rnd(k + 1).map((x, i) => x + callColour[i]), channel: 'system' }]);
  const mean = speakers.channelMeans();
  const unit = (v) => centre(v, null);
  assert.ok(cosine(mean('system'), callColour) > cosine(VOICE_MEAN, callColour) + 0.3, 'the call channel mean moved towards what the calls sound like');
  assert.ok(cosine(mean('mic'), VOICE_MEAN) > 0.99, 'nothing heard on the mic: the shipped mean');
  speakers.adapt = false;
  assert.equal(speakers.channelMeans()('system'), VOICE_MEAN, 'adaptation off: the shipped mean for every channel');
  assert.ok(unit(callColour).length === dim);
});
