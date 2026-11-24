'use strict';
// Phase 0: voiceprints are opt-in (consent recorded, refused without it) and every segment carries its channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, MIGRATIONS } = require('../src/core/db');
const { tmpDir } = require('./helpers');

// A database exactly as v7 left it, holding one meeting with a mic line, a system line and a Discord person.
function v7Database(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  const upto = MIGRATIONS.findIndex((m) => /consent_at/.test(m));
  const v7 = upto < 0 ? MIGRATIONS.length : upto;
  for (let i = 0; i < v7; i++) raw.exec(MIGRATIONS[i]);
  raw.exec(`PRAGMA user_version = ${v7}`);
  raw.exec("INSERT INTO notes(id, created_at, updated_at) VALUES('n1', 1, 1)");
  const seg = raw.prepare('INSERT INTO segments(note_id, speaker, speaker_id, start_ms, end_ms, text) VALUES(?, ?, ?, ?, ?, ?)');
  seg.run('n1', 'me', 'm1', 0, 1000, 'hello');
  seg.run('n1', 'them', 's1', 1000, 2000, 'hi there');
  seg.run('n1', 'them', 'd4242', 2000, 3000, 'from discord');
  raw.exec("INSERT INTO voices(id, name, embedding, created_at, updated_at) VALUES('v1', 'Ana', x'00', 5, 5)");
  raw.close();
}

test('migration v8: segments get an explicit channel (mic | system | dc:<user>) and voices get consent columns', () => {
  const dir = tmpDir('wb-consent-');
  const file = path.join(dir, 'a.db');
  v7Database(file);
  const db = open(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const rows = db.prepare('SELECT speaker_id AS sid, channel FROM segments ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.sid, r.channel]), [['m1', 'mic'], ['s1', 'system'], ['d4242', 'dc:4242']]);
  const v = db.prepare('SELECT consent_at, consent_source, enrolled_from FROM voices WHERE id = ?').get('v1');
  assert.deepEqual({ ...v }, { consent_at: null, consent_source: null, enrolled_from: null }, 'profiles from before the change keep no invented consent');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ---- voiceprints need consent ----
const { Speakers } = require('../src/speakers/store');
const { Notes } = require('../src/core/notes');

function voice(seed, dim = 32) { const v = new Float32Array(dim); let x = seed * 9301 + 49297; for (let i = 0; i < dim; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; } return v; }

function rig() {
  const db = open(':memory:');
  const notes = new Notes(db, null);
  const speakers = new Speakers(db, null);
  const meeting = (secs = 12) => {
    const n = notes.create({});
    speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: voice(1), count: 5 });
    notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: secs * 1000, text: 'x' }]);
    return n.id;
  };
  return { db, speakers, meeting };
}

test('rename(remember) without consent names the speaker but saves no voice', () => {
  const { db, speakers, meeting } = rig();
  const n = meeting();
  speakers.rename(n, 's1', 'Ana', { remember: true });
  assert.equal(speakers.forNote(n)[0].name, 'Ana');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM voices').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM voice_exemplars').get().c, 0);
});

test('rename(remember) with a consent source saves the voice and records when, how and from where', () => {
  const { db, speakers, meeting } = rig();
  const n = meeting();
  const before = Date.now();
  speakers.rename(n, 's1', 'Ana', { remember: true, consentSource: 'user' });
  const v = db.prepare('SELECT consent_at, consent_source, enrolled_from FROM voices WHERE name = ?').get('Ana');
  assert.equal(v.consent_source, 'user');
  assert.equal(v.enrolled_from, `${n}:s1`);
  assert.ok(v.consent_at >= before && v.consent_at <= Date.now());
});

test('an unknown consent source is refused like a missing one', () => {
  const { db, speakers, meeting } = rig();
  const n = meeting();
  speakers.rename(n, 's1', 'Ana', { remember: true, consentSource: 'because' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM voices').get().c, 0);
});

test('learnFromMeeting saves a voice only when the caller attests consent, recorded as "meeting"', () => {
  const { db, speakers, meeting } = rig();
  const n = meeting();
  speakers.nameFromMeeting(n, 's1', 'Ana');
  assert.equal(speakers.learnFromMeeting(n, 's1'), false, 'no consent given');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM voices').get().c, 0);
  assert.equal(speakers.learnFromMeeting(n, 's1', { consent: true }), true);
  assert.equal(db.prepare("SELECT consent_source s FROM voices WHERE name = 'Ana'").get().s, 'meeting');
});

test('reinforcing a voice that predates consent records the consent given now', () => {
  const { db, speakers, meeting } = rig();
  db.prepare("INSERT INTO voices(id, name, embedding, created_at, updated_at) VALUES('old', 'Ana', ?, 1, 1)").run(Buffer.from(voice(1).buffer));
  const n = meeting();
  speakers.rename(n, 's1', 'Ana', { remember: true, consentSource: 'user' });
  assert.equal(db.prepare("SELECT consent_source s FROM voices WHERE id = 'old'").get().s, 'user');
});
