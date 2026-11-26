'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { eer, fitLogistic, logistic, ece, scoreAt, bandTally, cacheFor, CACHE } = require('../eval/voices');

test('eval voices: EER is 0 for separated scores, 0.5 for identical ones, and in between for an overlap', () => {
  assert.equal(eer([0.9, 0.8, 0.7], [0.1, 0.2, 0.3]).eer, 0);
  assert.equal(eer([0.5, 0.5], [0.5, 0.5]).eer, 0.5);
  // one target below one non-target out of 4 each: 25 % misses at the point where 25 % of non-targets are accepted
  assert.equal(eer([0.9, 0.8, 0.7, 0.2], [0.75, 0.1, 0.05, 0.0]).eer, 0.25);
  assert.equal(eer([], [0.1]).eer, null);
});

test('eval voices: logistic fit recovers the coefficients that generated the labels', () => {
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const X = [], y = [];
  for (let i = 0; i < 20000; i++) { const s = rand() * 1.4 - 0.2; X.push([s]); y.push(rand() < 1 / (1 + Math.exp(-(-6 + 10 * s))) ? 1 : 0); }
  const b = fitLogistic(X, y);
  assert.ok(Math.abs(b[0] + 6) < 0.4, `intercept ${b[0]}`);
  assert.ok(Math.abs(b[1] - 10) < 0.6, `slope ${b[1]}`);
  assert.ok(Math.abs(scoreAt(b, 0.5) - 0.6) < 0.02);
  assert.ok(Math.abs(logistic(b, [scoreAt(b, 0.9)]) - 0.9) < 1e-9);
  assert.ok(ece(X.map((x) => logistic(b, x)), y) < 0.02, 'a fitted model is well calibrated on its own data');
  assert.ok(ece(X.map(() => 0.99), y) > 0.3, 'a constant overconfident prediction is not');
});

test('eval voices: the three-outcome rule links one speaker per voice, asks in the band and counts strangers', () => {
  const b = [-6, 10];                       // P = 0.5 at score 0.6
  const decs = [
    { truth: 'a', best: 'a', score: 0.95, gap: 0.3 },   // P ~ 0.97: match, right
    { truth: 'b', best: 'b', score: 0.62, gap: 0.3 },   // P ~ 0.55: ask, right
    { truth: null, best: 'c', score: 0.9, gap: 0.3 },   // stranger, P ~ 0.95: match (wrong)
    { truth: 'd', best: 'a', score: 0.7, gap: 0.3 },    // wants voice a, already taken by a better score: unlinked
    { truth: 'e', best: 'e', score: 0.3, gap: 0.3 },    // below lo: no match
  ];
  const t = bandTally(decs, b, false, 0.9, 0.5, 0.02, { known: 0, strangers: 0, matchRight: 0, matchWrong: 0, askRight: 0, askWrong: 0, none: 0, matchStranger: 0, askStranger: 0 });
  assert.deepEqual(t, { known: 4, strangers: 1, matchRight: 1, matchWrong: 0, askRight: 1, askWrong: 0, none: 2, matchStranger: 1, askStranger: 0 });
});

test('eval voices: the shipped model keeps the old cache, any other model gets its own', () => {
  assert.equal(cacheFor(null), CACHE);
  assert.equal(cacheFor('/x/speaker/wespeaker_en_voxceleb_resnet34_LM.onnx'), CACHE);
  assert.equal(cacheFor('/x/nemo_en_titanet_large.onnx'), path.join(CACHE, 'nemo_en_titanet_large'));
});
