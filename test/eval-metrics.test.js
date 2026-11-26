'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { turnsFromWords, diarization, overlapRegions, werByOverlap, normalize, scoreTime } = require('../eval/metrics');

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('turnsFromWords joins one speaker\'s words across short gaps only', () => {
  const t = turnsFromWords([
    { speaker: 'A', start: 0, end: 1, word: 'a' }, { speaker: 'A', start: 1.3, end: 2, word: 'b' },
    { speaker: 'A', start: 3, end: 4, word: 'c' }, { speaker: 'B', start: 1.5, end: 2.5, word: 'd' },
  ], { mergeGap: 0.5 });
  assert.deepEqual(t, [{ speaker: 'A', start: 0, end: 2 }, { speaker: 'B', start: 1.5, end: 2.5 }, { speaker: 'A', start: 3, end: 4 }]);
});

test('a perfect hypothesis with other labels scores 0 DER and 0 JER', () => {
  const ref = [{ speaker: 'A', start: 0, end: 5 }, { speaker: 'B', start: 4, end: 10 }];
  const hyp = [{ speaker: 'x', start: 0, end: 5 }, { speaker: 'y', start: 4, end: 10 }];
  const r = diarization(ref, hyp);
  near(r.der, 0); near(r.jer, 0);
  near(r.overlap.precision, 1); near(r.overlap.recall, 1);
});

test('DER splits into miss, false alarm and confusion like md-eval', () => {
  // reference: A 0-10, B 10-20 (20 s of speaker time)
  const ref = [{ speaker: 'A', start: 0, end: 10 }, { speaker: 'B', start: 10, end: 20 }];
  // hypothesis: x 0-8 (2 s missed), x 10-12 (2 s confused: x is mapped to A), y 12-20, z 20-22 (2 s false alarm)
  const hyp = [{ speaker: 'x', start: 0, end: 8 }, { speaker: 'x', start: 10, end: 12 }, { speaker: 'y', start: 12, end: 20 }, { speaker: 'z', start: 20, end: 22 }];
  const r = diarization(ref, hyp);
  near(r.miss, 2 / 20); near(r.confusion, 2 / 20); near(r.falseAlarm, 2 / 20); near(r.der, 6 / 20);
  // JER: A vs x: |∩|=8, |∪|=12 -> 1/3; B vs y: 8/10 -> 0.2; mean 0.2667
  near(r.jer, (1 / 3 + 0.2) / 2);
});

test('a single-speaker hypothesis misses all of the overlap', () => {
  const ref = [{ speaker: 'A', start: 0, end: 10 }, { speaker: 'B', start: 5, end: 10 }];
  const hyp = [{ speaker: 'x', start: 0, end: 10 }];
  const r = diarization(ref, hyp);
  near(r.miss, 5 / 15); near(r.der, 5 / 15);
  assert.equal(r.overlap.precision, null); near(r.overlap.recall, 0);
});

test('the collar leaves boundaries unscored', () => {
  const ref = [{ speaker: 'A', start: 0, end: 10 }];
  const hyp = [{ speaker: 'x', start: 0.2, end: 9.8 }];
  near(diarization(ref, hyp).der, 0.4 / 10);
  near(diarization(ref, hyp, { collar: 0.25 }).der, 0);
});

test('overlapRegions and the WER split put errors on the right side', () => {
  const turns = [{ speaker: 'A', start: 0, end: 4 }, { speaker: 'B', start: 3, end: 6 }];
  assert.deepEqual(overlapRegions(turns).map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), [[3, 4]]);
  const ref = normalize([{ speaker: 'A', start: 0, end: 1, word: 'one' }, { speaker: 'A', start: 3.2, end: 3.6, word: 'two' }, { speaker: 'B', start: 3.4, end: 3.8, word: 'three' }, { speaker: 'B', start: 5, end: 5.5, word: 'four' }]);
  const hyp = normalize([{ speaker: 'x', start: 0, end: 1, word: 'one' }, { speaker: 'x', start: 3.2, end: 3.6, word: 'two' }, { speaker: 'x', start: 5, end: 5.5, word: 'for' }]);
  const s = werByOverlap(ref, hyp, overlapRegions(turns));
  assert.equal(s.in.words, 2); assert.equal(s.in.errors, 1); // "three" deleted
  assert.equal(s.out.words, 2); assert.equal(s.out.errors, 1); // "four" -> "for"
});

test('scoreTime runs end to end on words', () => {
  const ref = [{ speaker: 'A', start: 0, end: 1, word: 'hello' }, { speaker: 'B', start: 1.2, end: 2, word: 'there' }];
  const s = scoreTime(ref, ref.map((w) => ({ ...w, speaker: w.speaker.toLowerCase() })));
  near(s.der, 0); near(s.werOutOverlap, 0);
});
