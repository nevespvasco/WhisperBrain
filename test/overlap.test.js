'use strict';
// Overlapped speech (two people talking at once): the after-recording pass already knows which words it was; they are kept
// (a fourth element of the word, 1), shown as such, and do not count as a person's clean speech when their voice is saved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Speakers } = require('../src/speakers/store');
const { diarizeChannel } = require('../src/speakers/final');

const v = (k) => Float32Array.from({ length: 8 }, (_, i) => (i === k ? 1 : 0.1));

function meeting() {
  const db = open(':memory:');
  const notes = new Notes(db, new Bus()), speakers = new Speakers(db, new Bus());
  const n = notes.create({});
  // one utterance of five words; the 2nd and 3rd are spoken while the other person talks
  const [a] = notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 6000, text: 'we should ship it today', words: [['we', 0, 400], ['should', 1000, 1600], ['ship', 1600, 2200], ['it', 4000, 4300], ['today', 4300, 4900]] }]);
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: v(0), count: 1 });
  return { db, notes, speakers, n, a };
}
// speaker 0 talks 0-5 s; speaker 1 talks 0.9-2.3 s over them
const turns = [{ start: 0, end: 5, speaker: 0 }, { start: 0.9, end: 2.3, speaker: 1 }];
const fake = async () => ({ turns, voices: [{ speaker: 0, centroid: v(0), pitch: 120, ms: 5000 }, { speaker: 1, centroid: v(3), pitch: 200, ms: 1400 }] });
const run = (m) => diarizeChannel({ diarize: fake, notes: m.notes, speakers: m.speakers, noteId: m.n.id, channel: 'system', source: { file: '/x' }, stretches: [{ at: 0, ms: 0 }], segIds: [m.a.id], segmentation: '/s', embedding: '/e' });

test('the overlapped words are stored with the transcript, whether or not the utterance changed speaker', async () => {
  const m = meeting();
  await run(m);
  const flagged = m.notes.segmentWords(m.n.id).flatMap((s) => (s.words || []).filter((w) => w[3] === 1).map((w) => w[0]));
  assert.deepEqual(flagged, ['should', 'ship'], 'the two words that two people were saying at once');
  const total = m.notes.segments(m.n.id).reduce((n, s) => n + s.overlap, 0);
  assert.equal(total, 2, 'the transcript says how many words of each line were overlapped');
});

test('a second pass does not pile the flag up: words keep one flag, clean words none', async () => {
  const m = meeting();
  await run(m);
  await diarizeChannel({ diarize: fake, notes: m.notes, speakers: m.speakers, noteId: m.n.id, channel: 'system', source: { file: '/x' }, stretches: [{ at: 0, ms: 0 }], segIds: m.notes.segmentWords(m.n.id).map((s) => s.id), segmentation: '/s', embedding: '/e' });
  for (const s of m.notes.segmentWords(m.n.id)) for (const w of s.words || []) assert.ok(w.length === 3 || (w.length === 4 && w[3] === 1), JSON.stringify(w));
});

// ---- enrolment ----
function enrolRig({ overlapSeconds }) {
  const db = open(':memory:');
  const notes = new Notes(db, null), speakers = new Speakers(db, null);
  const n = notes.create({});
  // 12 s of speech, `overlapSeconds` of it overlapped (words are one second each)
  const words = Array.from({ length: 12 }, (_, i) => (i < overlapSeconds ? ['w', i * 1000, i * 1000 + 1000, 1] : ['w', i * 1000, i * 1000 + 1000]));
  notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'w '.repeat(12).trim(), words }]);
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: v(0), count: 5 });
  return { db, speakers, n };
}

test('a voice saved from a speaker counts only the clean seconds of their speech', () => {
  const clean = enrolRig({ overlapSeconds: 0 }), mixed = enrolRig({ overlapSeconds: 5 });
  clean.speakers.rename(clean.n.id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  mixed.speakers.rename(mixed.n.id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  const w = (r) => r.db.prepare('SELECT weight FROM voice_exemplars WHERE negative = 0').get().weight;
  assert.equal(w(clean), 12);
  assert.equal(w(mixed), 7, '12 s of speech, 5 s of it overlapped');
});

test('learning a voice from the meeting needs 8 clean seconds, not 8 seconds', () => {
  const ok = enrolRig({ overlapSeconds: 0 }), tooMixed = enrolRig({ overlapSeconds: 5 });
  for (const r of [ok, tooMixed]) r.speakers.nameFromMeeting(r.n.id, 's1', 'Ana', { source: 'meeting:highlight', confidence: 0.9 });
  assert.equal(ok.speakers.learnFromMeeting(ok.n.id, 's1', { consent: true }), true);
  assert.equal(tooMixed.speakers.learnFromMeeting(tooMixed.n.id, 's1', { consent: true }), false, '7 clean seconds');
});
