'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { eigSym, trainPlda } = require('../eval/plda-train');
const { pldaFeatures, vbx } = require('../src/speakers/owned/vbx');
const { DiarizationState } = require('../src/speakers/owned/pipeline');

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

test('eigSym recovers eigenvalues of a symmetric matrix', () => {
  const A = Float64Array.from([4, 1, 0, 1, 3, 0, 0, 0, 1]);
  const { values, vectors } = eigSym(A, 3);
  const expect = [(7 + Math.sqrt(5)) / 2, (7 - Math.sqrt(5)) / 2, 1];
  values.forEach((v, i) => assert.ok(Math.abs(v - expect[i]) < 1e-9));
  // A v = λ v for the first vector
  const v0 = [vectors[0], vectors[3], vectors[6]];
  const Av = [4 * v0[0] + v0[1], v0[0] + 3 * v0[1], v0[2]];
  Av.forEach((x, i) => assert.ok(Math.abs(x - values[0] * v0[i]) < 1e-9));
});

// Synthetic "voices": each speaker a random direction, utterances = that direction + noise.
function speakers(r, nSpk, perSpk, dim, spread = 1, noise = 0.35) {
  const E = [], L = [];
  for (let s = 0; s < nSpk; s++) {
    const c = Array.from({ length: dim }, () => gauss(r) * spread);
    for (let k = 0; k < perSpk; k++) { E.push(c.map((v) => v + gauss(r) * noise)); L.push(s); }
  }
  return { E, L };
}

test('PLDA features whiten one speaker\'s variation and VBx prunes an over-split start', () => {
  const r = rng(9);
  const train = speakers(r, 60, 20, 16);
  const plda = trainPlda(train.E, train.L, 12);
  assert.equal(plda.phi.length, 12);
  assert.ok(plda.phi[0] > plda.phi[11]);
  // a "meeting" with 3 new speakers, started from 6 clusters (each true speaker split in two)
  const meet = speakers(r, 3, 40, 16);
  const fea = meet.E.map((e) => pldaFeatures(e, plda));
  const init = Int32Array.from(meet.L, (l, i) => l * 2 + (i % 2));
  const { gamma, pi } = vbx(fea, Float64Array.from(plda.phi), init, { Fa: 0.3, Fb: 17 });
  const kept = [...pi].filter((p) => p > 1e-3).length;
  assert.equal(kept, 3, `kept ${kept}: ${[...pi].map((p) => p.toFixed(3))}`);
  // every utterance of one true speaker ends in the same kept component
  for (let s = 0; s < 3; s++) {
    const arg = meet.L.map((l, i) => (l === s ? gamma[i].indexOf(Math.max(...gamma[i])) : -1)).filter((x) => x >= 0);
    assert.equal(new Set(arg).size, 1);
  }
});

test('the pipeline uses VBx when it has a PLDA', () => {
  const st = new DiarizationState({ plda: { mean1: [0, 0], lda: [1, 0, 0, 1], mean2: [0, 0], mu: [0, 0], tr: [1, 0, 0, 1], phi: [5, 5] }, minClusterSize: 1 });
  // two windows, one voice each, both clearly different
  const seg = new Uint8Array(589 * 3); for (let f = 0; f < 589; f++) seg[f * 3] = 1;
  st.windows = [0, 1, 2, 3].map((i) => ({ start: i * 16000, seg, emb: [Float32Array.from(i < 2 ? [1, 0.05 * i] : [0.05 * i, 1]), null, null], active: [589, 0, 0], solo: [589, 0, 0] }));
  const { labels, centroids } = st.cluster();
  assert.ok(centroids.length >= 1);
  assert.equal(labels[0][0], labels[1][0]);
});
