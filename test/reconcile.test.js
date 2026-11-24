'use strict';
// Attaching the platform's own transcript (a Teams / Zoom / Meet export) to a recorded meeting: its clock is not ours and its
// words are not quite ours, so the two are matched by what was said, the offset between them is found from the matches, and
// the speaker names the platform wrote become evidence for the voices.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileTranscript } = require('../src/meet/reconcile');

// What was said, by whom, when (our timeline, ms): three voices on the system audio
const SAID = [
  ['s1', 2000, 7000, 'Good morning everyone thanks for joining the planning call today'],
  ['s2', 8000, 13000, 'Happy to be here I wanted to start with the budget for the second quarter'],
  ['s3', 14000, 20000, 'Before the budget we should settle the hiring plan for the platform team'],
  ['s1', 21000, 26000, 'Agreed let us take hiring first and then the budget discussion'],
  ['s2', 27000, 33000, 'The recruiter said we can close two engineers by the end of March'],
  ['s3', 34000, 40000, 'That works for me but I need a decision on the contractor by Friday'],
  ['s1', 41000, 46000, 'I will confirm the contractor decision tomorrow morning after the review'],
];
const WHO = { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' };
const utterances = SAID.map(([speakerId, startMs, endMs, text], id) => ({ id, speakerId, startMs, endMs, text }));

// the platform's version: its clock started 30 s before our recording, and its recogniser words things a little differently
const wobble = (t) => t.replace(/ the /, ' ').replace(/^(\w+) /, (m, w) => `${w}, `);
const platform = (offset = 30000, label = (id) => WHO[id]) => SAID.map(([id, a, b, text]) => ({ label: label(id), startMs: a + offset, endMs: b + offset, text: wobble(text) }));

test('the offset between the two clocks is found from the words, and each voice gets the name the platform wrote', () => {
  const r = reconcileTranscript({ platform: platform(30000), utterances });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offsetMs - -30000) <= 1000, `offset ${r.offsetMs}`);
  assert.equal(r.matches.length, 7);
  assert.deepEqual([...new Map(r.matches.map((m) => [utterances[m.id].speakerId, m.name]))].sort(), [['s1', 'Ana Silva'], ['s2', 'Bruno Costa'], ['s3', 'Carla Dias']]);
});

test('it does not matter whether the platform started before, at, or after the recording', () => {
  for (const shift of [-12000, 0, 90000]) {
    const r = reconcileTranscript({ platform: platform(shift), utterances });
    assert.equal(r.ok, true, `shift ${shift}`);
    assert.ok(Math.abs(r.offsetMs + shift) <= 1000, `shift ${shift}: offset ${r.offsetMs}`);
  }
});

test('a transcript of some other meeting is refused, and says so', () => {
  const other = [
    { label: 'Ana Silva', startMs: 1000, endMs: 6000, text: 'Welcome to the quarterly retrospective for the design team everyone' },
    { label: 'Bruno Costa', startMs: 7000, endMs: 12000, text: 'Our main finding was that onboarding takes far too long for newcomers' },
    { label: 'Carla Dias', startMs: 13000, endMs: 18000, text: 'I suggest we record short videos that explain each of the steps' },
  ];
  const r = reconcileTranscript({ platform: other, utterances });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not look like this meeting/i);
});

test('a transcript without speaker names cannot name anyone, and says so', () => {
  const r = reconcileTranscript({ platform: platform(30000, () => ''), utterances });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no speaker names/i);
});

test('lines from the platform that match nothing are left out; a few stray lines do not move the offset', () => {
  const p = [...platform(30000), { label: 'Ana Silva', startMs: 100000, endMs: 104000, text: 'Something that was only said after the recording stopped' }, { label: 'Bruno Costa', startMs: 5000, endMs: 9000, text: 'Mm hmm yes right okay' }];
  const r = reconcileTranscript({ platform: p, utterances });
  assert.equal(r.ok, true);
  assert.equal(r.matches.length, 7);
  assert.ok(Math.abs(r.offsetMs - -30000) <= 1000);
});
