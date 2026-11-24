'use strict';
// The naming-accuracy metric of the speaker evaluation (eval/metrics.js): of all the speech, how much carries the right name?
const test = require('node:test');
const assert = require('node:assert/strict');
const { namingAccuracy } = require('../eval/metrics');

// speech: Map(voice -> [[startMs, endMs]]); truth: voice -> the person's name; assigned: Map(voice -> name | undefined)
const speech = new Map([['s1', [[0, 6000]]], ['s2', [[6000, 10000]]], ['s3', [[10000, 12000]]]]);
const truth = { s1: 'Ana', s2: 'Bruno', s3: 'Carla' };

test('namingAccuracy: the share of speech time whose name is the right one', () => {
  assert.equal(namingAccuracy({ speech, truth, assigned: new Map([['s1', 'Ana'], ['s2', 'Bruno'], ['s3', 'Carla']]) }).accuracy, 1);
  const r = namingAccuracy({ speech, truth, assigned: new Map([['s1', 'Ana'], ['s2', 'Carla'], ['s3', 'Carla']]) });
  assert.equal(r.accuracy, 8 / 12, 'Ana (6 s) and Carla (2 s) are right, Bruno (4 s) is not');
  assert.deepEqual([r.rightMs, r.wrongMs, r.unnamedMs], [8000, 4000, 0]);
});

test('namingAccuracy: unnamed speech is not right, and is told apart from wrongly named speech', () => {
  const r = namingAccuracy({ speech, truth, assigned: new Map([['s1', 'Ana']]) });
  assert.deepEqual([r.rightMs, r.wrongMs, r.unnamedMs], [6000, 0, 6000]);
  assert.equal(r.accuracy, 0.5);
  assert.equal(r.precision, 1, 'of what was named, all right');
});

test('namingAccuracy: names compare as people do (case, accents, spacing)', () => {
  assert.equal(namingAccuracy({ speech, truth: { s1: 'José  da Silva', s2: 'Bruno', s3: 'Carla' }, assigned: new Map([['s1', 'jose da silva'], ['s2', 'BRUNO'], ['s3', 'Carla']]) }).accuracy, 1);
});

test('namingAccuracy: no speech is accuracy 0, not NaN', () => {
  assert.equal(namingAccuracy({ speech: new Map(), truth: {}, assigned: new Map() }).accuracy, 0);
});
