'use strict';
// What names are based on is kept, not dropped when the recording stops: the highlights, the roster and the captions from the
// meeting window, the people a Discord bot heard, a platform's own transcript. The aligner (and the "why this name" panel)
// read it back; each speaker also records which kind of evidence named it, and how sure that was.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { open, MIGRATIONS } = require('../src/core/db');
const { Notes } = require('../src/core/notes');
const { Speakers } = require('../src/speakers/store');
const { Evidence } = require('../src/meet/evidence');
const { MeetingCollector } = require('../src/meet/collector');
const { tmpDir } = require('./helpers');

test('migration v10: evidence table and how each speaker was named, on a database as v9 left it', () => {
  const dir = tmpDir('wb-evidence-');
  const file = path.join(dir, 'a.db');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  const upto = MIGRATIONS.findIndex((m) => /CREATE TABLE evidence/.test(m));
  const before = upto < 0 ? MIGRATIONS.length : upto;
  for (let i = 0; i < before; i++) raw.exec(MIGRATIONS[i]);
  raw.exec(`PRAGMA user_version = ${before}`);
  raw.exec("INSERT INTO notes(id, created_at, updated_at) VALUES('n1', 1, 1)");
  raw.exec("INSERT INTO note_speakers(note_id, speaker_id, channel, name) VALUES('n1', 's1', 'system', 'Ana')");
  raw.close();

  const db = open(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const sp = db.prepare('SELECT name_source AS s, name_confidence AS c FROM note_speakers').get();
  assert.deepEqual({ ...sp }, { s: '', c: null }, 'a name from before is of unknown origin, not guessed');
  new Evidence(db).add('n1', [{ kind: 'highlight', source: 'x', key: 'ana', name: 'Ana', t0: 0, t1: 10 }]);
  db.prepare("DELETE FROM notes WHERE id = 'n1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM evidence').get().c, 0, 'evidence goes with its meeting');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('Evidence: add, read back by kind, replace one kind, nothing leaks between meetings', () => {
  const db = open(':memory:');
  const notes = new Notes(db, null), ev = new Evidence(db);
  const a = notes.create({}), b = notes.create({});
  ev.add(a.id, [
    { kind: 'highlight', source: 'extension', key: 'ana', name: 'Ana', t0: 1000, t1: 4000, meta: { lagMs: 300 } },
    { kind: 'roster', source: 'extension', key: 'bruno', name: 'Bruno', t0: 500, meta: { self: false } },
  ]);
  ev.add(b.id, [{ kind: 'highlight', source: 'a11y', key: 'carla', name: 'Carla', t0: 0, t1: 5 }]);
  assert.deepEqual(ev.forNote(a.id).map((e) => [e.kind, e.name]), [['highlight', 'Ana'], ['roster', 'Bruno']]);
  const h = ev.forNote(a.id, { kind: 'highlight' })[0];
  assert.deepEqual([h.source, h.key, h.t0, h.t1, h.weight, h.meta], ['extension', 'ana', 1000, 4000, 1, { lagMs: 300 }]);
  assert.equal(ev.forNote(a.id, { kind: 'roster' })[0].t1, null);
  ev.clear(a.id, { kinds: ['highlight'] });
  assert.deepEqual(ev.forNote(a.id).map((e) => e.kind), ['roster']);
  assert.equal(ev.forNote(b.id).length, 1);
  assert.throws(() => ev.add(a.id, [{ kind: 'gossip', name: 'x' }]), /kind/);
});

// ---- the collector hands over what it saw ----
function collectorRig() {
  const hub = new EventEmitter();
  let now = 0;
  const c = new MeetingCollector({ hub, elapsed: () => now, selfNames: () => ['Vasco'] });
  const say = (t, msg, source = 'x', lagMs = 300) => { now = t; hub.emit('signal', { msg, source, lagMs }); };
  return { c, say };
}

test('MeetingCollector.toEvidence: highlights as raw intervals (lag kept aside), the roster, and the captions with their text', () => {
  const { c, say } = collectorRig();
  say(500, { type: 'roster', participants: [{ name: 'Ana' }, { name: 'Bruno' }, { name: 'Vasco', self: true }] });
  say(1000, { type: 'speaker', name: 'Ana' });
  say(2000, { type: 'caption', name: 'Ana', text: 'hello there everyone', final: true });
  say(4000, { type: 'speaker', name: null });
  say(5000, { type: 'speaker', name: 'Bruno' });
  say(6000, { type: 'speaker', name: 'Vasco', self: true });          // the user's own highlight says nothing about the others
  const rows = c.toEvidence({ endMs: 9000 });
  const by = (kind) => rows.filter((r) => r.kind === kind);
  assert.deepEqual(by('highlight').map((r) => [r.name, r.key, r.t0, r.t1, r.source, r.meta.lagMs]), [['Ana', 'ana', 1000, 4000, 'x', 300], ['Bruno', 'bruno', 5000, 6000, 'x', 300]]);
  assert.deepEqual(by('roster').map((r) => [r.name, r.t0, !!r.meta.self]), [['Ana', 500, false], ['Bruno', 500, false], ['Vasco', 500, true]]);
  const cap = by('caption')[0];
  assert.deepEqual([cap.name, cap.t0, cap.meta.text, cap.meta.final], ['Ana', 2000, 'hello there everyone', true]);
  assert.equal(rows.length, 6);
});

// ---- speakers remember how they were named ----
const voice = (seed, dim = 32) => { const v = new Float32Array(dim); let x = seed * 9301 + 49297; for (let i = 0; i < dim; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; } return v; };

function speakerRig() {
  const db = open(':memory:');
  const notes = new Notes(db, null), speakers = new Speakers(db, null);
  const n = notes.create({});
  for (const id of ['s1', 's2']) {
    speakers.save(n.id, { speakerId: id, channel: 'system', centroid: voice(id === 's1' ? 1 : 2), count: 5 });
    notes.addSegments(n.id, [{ speaker: 'them', speakerId: id, startMs: 0, endMs: 12000, text: 'x' }]);
  }
  const src = (id) => { const s = speakers.forNote(n.id).find((x) => x.speakerId === id); return [s.nameSource, s.nameConfidence]; };
  return { db, speakers, n, src };
}

test('speakers: the evidence a name came from is recorded, and what is typed is never replaced by what is inferred', () => {
  const { speakers, n, src } = speakerRig();
  assert.deepEqual(src('s1'), ['', null]);
  assert.equal(speakers.nameFromMeeting(n.id, 's1', 'Ana', { source: 'meeting:highlight', confidence: 0.83 }), 'named');
  assert.deepEqual(src('s1'), ['meeting:highlight', 0.83]);
  speakers.rename(n.id, 's1', 'Ana Silva');
  assert.deepEqual(src('s1'), ['user', 1], 'typed by the person');
  assert.equal(speakers.nameFromMeeting(n.id, 's1', 'Somebody', { source: 'meeting:caption', confidence: 0.9 }), 'kept');
  assert.deepEqual(src('s1'), ['user', 1], 'unchanged');
  speakers.ensureNamed(n.id, 'd42', 'Rui', 'system');
  assert.deepEqual(src('d42'), ['stream', 1], 'the Discord bot knows who it heard');
});

test('speakers: a saved voice that matched is the source, with its score; and the "why" data is public', () => {
  const { db, speakers, n, src } = speakerRig();
  speakers.rename(n.id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  const m = new Notes(db, null).create({});
  speakers.save(m.id, { speakerId: 's1', channel: 'system', centroid: voice(1), count: 5 });
  new Notes(db, null).addSegments(m.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'x' }]);
  assert.equal(speakers.autoMatch(m.id), 1);
  const s = speakers.publicForNote(m.id).find((x) => x.speakerId === 's1');
  assert.equal(s.label, 'Ana');
  assert.equal(s.nameSource, 'voice');
  assert.ok(s.nameConfidence > 0.5 && s.nameConfidence <= 1);
  assert.ok(src('s2'));
});

test('deleting a transcript deletes the evidence about who spoke in it (names of other people)', () => {
  const db = open(':memory:');
  const notes = new Notes(db, null), ev = new Evidence(db);
  const a = notes.create({}), b = notes.create({});
  for (const n of [a, b]) ev.add(n.id, [{ kind: 'roster', source: 'x', key: 'ana', name: 'Ana', t0: 0 }]);
  notes.clearTranscript(a.id);
  assert.equal(ev.forNote(a.id).length, 0);
  assert.equal(ev.forNote(b.id).length, 1, 'only that meeting');
  const { Account } = require('../src/core/account');
  new Account({ db, notes, settings: { reset() {} }, speakers: new Speakers(db, null), models: { catalog: [] }, bus: null }).deleteTranscripts();
  assert.equal(ev.forNote(b.id).length, 0);
});

test('naming again from the evidence knows the invitation too (renameFromEvidence)', () => {
  const { renameFromEvidence } = require('../src/meet/rename');
  const db = open(':memory:');
  const notes = new Notes(db, null), speakers = new Speakers(db, null), ev = new Evidence(db);
  const n = notes.create({});
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: voice(1), count: 5 });
  notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'x' }]);
  ev.add(n.id, [
    { kind: 'highlight', source: 'x', key: 'ana', name: 'Ana', t0: 500, t1: 12500, meta: { lagMs: 500 } },
    { kind: 'calendar', source: 'calendar', key: 'ana silva', name: 'Ana Silva', meta: { email: 'a@x.org' } },
  ]);
  const r = renameFromEvidence({ notes, speakers, evidence: ev, noteId: n.id });
  assert.deepEqual(r.named.map((x) => x.name), ['Ana Silva']);
});

// ---- found in review: provenance must stay true ----
function twoSpeakers() {
  const r = speakerRig();
  return r;
}

test('a voice learned from the meeting keeps meeting provenance (it was not typed by the person)', () => {
  const { speakers, n, src } = twoSpeakers();
  speakers.nameFromMeeting(n.id, 's1', 'Ana', { source: 'meeting:highlight', confidence: 0.8 });
  assert.equal(speakers.learnFromMeeting(n.id, 's1', { consent: true }), true);
  assert.deepEqual(src('s1'), ['meeting:highlight', 0.8]);
  speakers.nameFromMeeting(n.id, 's1', 'Ana', { source: 'meeting:highlight', confidence: 0.8 });
});

test('a meeting name that agrees with the saved voice does not take the voice\'s place as the source', () => {
  const { db, speakers, n } = twoSpeakers();
  speakers.rename(n.id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  const notes = new Notes(db, null), m = notes.create({});
  speakers.save(m.id, { speakerId: 's1', channel: 'system', centroid: voice(1), count: 5 });
  notes.addSegments(m.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'x' }]);
  speakers.autoMatch(m.id);
  assert.equal(speakers.nameFromMeeting(m.id, 's1', 'Ana', { source: 'meeting:highlight', confidence: 0.9 }), 'agrees');
  assert.equal(speakers.forNote(m.id).find((s) => s.speakerId === 's1').nameSource, 'voice');
});

test('a name inferred earlier can be corrected even when it had linked a saved voice', () => {
  const { db, speakers, n } = twoSpeakers();
  speakers.rename(n.id, 's2', 'Wrongway', { remember: true, consentSource: 'user' });          // a saved voice called Wrongway
  const notes = new Notes(db, null), m = notes.create({});
  speakers.save(m.id, { speakerId: 's1', channel: 'system', centroid: voice(2), count: 5 });
  notes.addSegments(m.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'x' }]);
  assert.equal(speakers.nameFromMeeting(m.id, 's1', 'Wrongway', { source: 'meeting:highlight', confidence: 0.6 }), 'named');   // linked to the voice
  assert.equal(speakers.nameFromMeeting(m.id, 's1', 'Ana', { source: 'transcript', confidence: 1, replaceInferred: true }), 'named', 'corrected, not dropped as a conflict');
  const s = speakers.forNote(m.id).find((x) => x.speakerId === 's1');
  assert.deepEqual([s.name, s.nameSource, s.voiceId], ['Ana', 'transcript', null]);
});

test('merging speakers carries the name\'s provenance with the name', () => {
  const { speakers, n, src } = twoSpeakers();
  speakers.nameFromMeeting(n.id, 's2', 'Bruno', { source: 'meeting:caption', confidence: 0.7 });
  assert.equal(speakers.mergeSpeakers(n.id, 's2', 's1', { minSimilarity: -1 }), true);
  assert.deepEqual([speakers.forNote(n.id).find((s) => s.speakerId === 's1').name, ...src('s1')], ['Bruno', 'meeting:caption', 0.7]);
});

// ---- per-voice provenance from the intervals ----
test('nameSpeakers says, per voice, which kind of evidence carried the name', () => {
  const { nameSpeakers } = require('../src/meet/names');
  const speech = new Map([['s1', [[0, 9000]]], ['s2', [[10000, 19000]]], ['s3', [[20000, 29000]]]]);
  const active = [
    { startMs: 0, endMs: 9000, name: 'Ana' },                                  // highlight (untagged)
    { startMs: 10000, endMs: 19000, name: 'Bruno', from: 'caption' },
    { startMs: 20000, endMs: 29000, name: 'Carla', from: 'transcript' },
  ];
  const by = Object.fromEntries(nameSpeakers({ speech, active }).named.map((n) => [n.speakerId, n.from]));
  assert.deepEqual(by, { s1: 'highlight', s2: 'caption', s3: 'transcript' });
});

// ---- invitations without a display name ----
test('invitedNames: a name when there is one, else a careful guess from the address, else nothing', () => {
  const { invitedNames } = require('../src/meet/names');
  assert.deepEqual(invitedNames([{ name: 'Ana Silva', email: 'x@y.org' }, { name: '', email: 'bruno.costa@acme.com' }, { name: '', email: 'carla_dias+cal@acme.com' }, { name: '', email: 'info@acme.com' }, { name: '', email: 'jd@acme.com' }, { name: '', email: '' }]),
    ['Ana Silva', 'Bruno Costa', 'Carla Dias']);
});

// ---- the evidence is not written twice ----
test('captions are kept once they are final (interim readings only when nothing marks a final)', () => {
  const { c, say } = collectorRig();
  say(1000, { type: 'caption', name: 'Ana', text: 'hello there', final: false });
  say(1500, { type: 'caption', name: 'Ana', text: 'hello there everyone', final: false });
  say(2000, { type: 'caption', name: 'Ana', text: 'hello there everyone today', final: true });
  assert.deepEqual(c.toEvidence({}).filter((r) => r.kind === 'caption').map((r) => r.meta.text), ['hello there everyone today']);
  const { c: d, say: say2 } = collectorRig();
  say2(1000, { type: 'caption', name: 'Ana', text: 'only interim readings here', final: false });
  assert.equal(d.toEvidence({}).filter((r) => r.kind === 'caption').length, 1);
});

test('Evidence.replace swaps some kinds for new rows in one step: a failure leaves what was there', () => {
  const db = open(':memory:');
  const notes = new Notes(db, null), ev = new Evidence(db);
  const n = notes.create({});
  ev.add(n.id, [{ kind: 'transcript', source: 'vtt', key: 'ana', name: 'Ana', t0: 0, t1: 5 }, { kind: 'roster', source: 'x', key: 'bruno', name: 'Bruno', t0: 0 }]);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => ev.replace(n.id, ['transcript'], [{ kind: 'transcript', source: 'vtt', key: 'carla', name: 'Carla', t0: 0, t1: 5, meta: cycle }]));
  assert.deepEqual(ev.forNote(n.id).map((e) => e.name), ['Ana', 'Bruno'], 'nothing was lost');
  ev.replace(n.id, ['transcript'], [{ kind: 'transcript', source: 'vtt', key: 'carla', name: 'Carla', t0: 0, t1: 5 }]);
  assert.deepEqual(ev.forNote(n.id).map((e) => e.name), ['Bruno', 'Carla']);
});

test('evidence kind "mention" (planned in docs/plans.md) is accepted', () => {
  const db = open(':memory:');
  const n = new Notes(db, null).create({});
  assert.equal(new Evidence(db).add(n.id, [{ kind: 'mention', source: 'llm', key: 'ana', name: 'Ana', t0: 1000, meta: { quote: 'thanks Ana' } }]), 1);
});
