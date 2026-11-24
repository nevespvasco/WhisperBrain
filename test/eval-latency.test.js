'use strict';
// The latency harness (eval/latency.js): from the evidence kept about recorded meetings, how late does each source show who is
// speaking, per platform. Checked here on a made-up database whose delays are known.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { Notes } = require('../src/core/notes');
const { Speakers } = require('../src/speakers/store');
const { Evidence } = require('../src/meet/evidence');
const { latencyReport, percentile } = require('../eval/latency');

const SAID = [
  ['s1', 2000, 6000, 'good morning everyone thanks for joining the planning call today'],
  ['s2', 8000, 12000, 'happy to be here I wanted to start with the budget for the second quarter'],
  ['s3', 14000, 19000, 'before the budget we should settle the hiring plan for the platform team'],
  ['s1', 21000, 25000, 'agreed let us take hiring first and then the budget discussion'],
  ['s2', 27000, 32000, 'the recruiter said we can close two engineers by the end of march'],
  ['s3', 34000, 38000, 'that works for me but I need a decision on the contractor by friday'],
];
const NAMES = { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' };
const key = (n) => n.toLowerCase();

function meeting(db, { platform, highlightLag, captionLag }) {
  const notes = new Notes(db, null), speakers = new Speakers(db, null), ev = new Evidence(db);
  const n = notes.create({ title: platform });
  notes.update(n.id, { platform });
  notes.addSegments(n.id, SAID.map(([speakerId, startMs, endMs, text]) => ({ speaker: 'them', speakerId, startMs, endMs, text })));
  for (const id of Object.keys(NAMES)) { speakers.save(n.id, { speakerId: id, channel: 'system', centroid: new Float32Array(4).fill(1), count: 1 }); speakers.nameFromMeeting(n.id, id, NAMES[id], { source: 'meeting:highlight', confidence: 0.9 }); }
  ev.add(n.id, [
    ...SAID.map(([id, a, b]) => ({ kind: 'highlight', source: 'extension', key: key(NAMES[id]), name: NAMES[id], t0: a + highlightLag, t1: b + highlightLag, meta: { lagMs: 300 } })),
    ...SAID.map(([id, a, , text]) => ({ kind: 'caption', source: 'captions', key: key(NAMES[id]), name: NAMES[id], t0: a + captionLag, meta: { text, final: true } })),
  ]);
  return n;
}

test('percentile: the usual way, on a short list', () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 90), 46);
  assert.equal(percentile([], 50), null);
});

test('latencyReport: per platform and source, the delay of the highlights and of the captions behind the speech', () => {
  const db = open(':memory:');
  meeting(db, { platform: 'meet', highlightLag: 700, captionLag: 2000 });
  meeting(db, { platform: 'meet', highlightLag: 700, captionLag: 2000 });
  meeting(db, { platform: 'zoom', highlightLag: 1200, captionLag: 3000 });
  const rep = latencyReport(db);
  const meet = rep.find((r) => r.platform === 'meet' && r.source === 'extension');
  assert.equal(meet.meetings, 2);
  assert.ok(Math.abs(meet.estimatedLagMs - 700) <= 100, `estimated ${meet.estimatedLagMs}`);
  assert.ok(Math.abs(meet.onset.p50 - 700) <= 50 && meet.onset.n === 12, JSON.stringify(meet.onset));
  const capt = rep.find((r) => r.platform === 'meet' && r.source === 'captions');
  assert.ok(Math.abs(capt.caption.p50 - 2000) <= 50 && capt.caption.n === 12, JSON.stringify(capt.caption));
  const zoom = rep.find((r) => r.platform === 'zoom' && r.source === 'extension');
  assert.ok(Math.abs(zoom.estimatedLagMs - 1200) <= 100);
});

test('latencyReport: meetings with no evidence are left out, and a note without a platform is "unknown"', () => {
  const db = open(':memory:');
  new Notes(db, null).create({ title: 'nothing recorded' });
  const n = meeting(db, { platform: null, highlightLag: 400, captionLag: 1500 });
  const rep = latencyReport(db);
  assert.ok(rep.every((r) => r.platform === 'unknown'));
  assert.ok(n);
});
