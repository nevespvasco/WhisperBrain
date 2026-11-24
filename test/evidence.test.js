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
