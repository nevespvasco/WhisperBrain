'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EnergyEnvelope, frameDb, FRAME_MS } = require('../src/audio/envelope');
const { energyCorrelation, isEnergyEcho, micSegmentIsEnergyEcho, isEcho } = require('../src/audio/echo');

const { speech, echoOf, bytes } = require('./echo-synth');

function envelopes(mic, sys, { micOrigin = 0, sysOrigin = 0 } = {}) {
  const m = new EnergyEnvelope(), s = new EnergyEnvelope();
  m.begin(micOrigin); s.begin(sysOrigin);
  for (let off = 0; off < mic.length; off += 4096) m.push(bytes(mic.subarray(off, off + 4096))); // arbitrary chunking
  for (let off = 0; off < sys.length; off += 5000) s.push(bytes(sys.subarray(off, off + 5000)));
  return { m, s };
}

test('envelope: frames are 10 ms, chunking does not matter, and gaps read as silence', () => {
  const tone = Int16Array.from({ length: 16000 }, (_, i) => Math.round(8000 * Math.sin(i / 5)));
  const whole = frameDb(bytes(tone));
  assert.equal(whole.length, 100);
  assert.ok(Math.abs(whole[0] - 20 * Math.log10(8000 / 32768 / Math.SQRT2)) < 0.5);
  const e = new EnergyEnvelope();
  e.begin(1000);
  for (let off = 0; off < tone.length; off += 333) e.push(bytes(tone.subarray(off, off + 333)));
  const w = e.window(1000, 2000);
  assert.equal(w.length, 100);
  assert.deepEqual(Array.from(w), Array.from(whole), 'odd-sized chunks give the same frames');
  assert.ok(e.window(0, 500).every((v) => v <= -90), 'before the recording started is silence');
  e.begin(5000); // after a pause
  e.push(bytes(tone.subarray(0, 1600)));
  assert.ok(e.window(5000, 5100)[0] > -30);
  assert.ok(e.window(2500, 4900).every((v) => v <= -90), 'the paused stretch is silence');
});

test('envelope: only the recent past is kept', () => {
  const e = new EnergyEnvelope({ keepMs: 1000 });
  e.begin(0);
  const chunk = bytes(Int16Array.from({ length: 16000 }, () => 4000));
  for (let i = 0; i < 20; i++) e.push(chunk); // 20 s
  assert.ok(e.runs[0].frames.length <= 300, `kept ${e.runs[0].frames.length} frames`);
  assert.ok(e.window(19000, 20000)[50] > -40, 'the latest second is there');
  assert.ok(e.window(0, 1000).every((v) => v <= -90), 'the oldest is gone');
});

test('a quiet, late copy of the system audio is an echo, even with no words to compare', () => {
  const sys = speech(1500, 11);
  const mic = echoOf(sys, { delayMs: 140, gain: 0.25 });
  const { m, s } = envelopes(mic, sys);
  const seg = { startMs: 100, endMs: 1400 };
  const r = energyCorrelation(m.window(seg.startMs, seg.endMs), s.window(seg.startMs - 800, seg.endMs + 200), { lagFrames: 80, leadFrames: 20 });
  assert.ok(r.corr > 0.9, `corr ${r.corr}`);
  assert.ok(Math.abs(r.delayMs - 140) <= 30, `delay ${r.delayMs}`);
  assert.equal(isEnergyEcho(r), true, JSON.stringify(r));
  assert.equal(micSegmentIsEnergyEcho(m, s, seg), true);
  // the text check has nothing to say about "yeah right" (fewer than 3 tokens), so only this catches it
  assert.equal(isEcho({ text: 'yeah right', startMs: 100, endMs: 1400 }, { text: 'yea right', startMs: 0, endMs: 1400 }), false);
});

test('the echo is found when the two channels start at different moments, within the search window', () => {
  const sys = speech(2000, 5);
  const mic = echoOf(sys, { delayMs: 60, gain: 0.4 });
  const seg = { startMs: 450, endMs: 2050 };
  // mic timeline 250 ms late: the echo seems to arrive 310 ms after the sound
  const late = envelopes(mic, sys, { micOrigin: 250, sysOrigin: 0 });
  assert.equal(micSegmentIsEnergyEcho(late.m, late.s, seg), true);
  // system timeline 150 ms late: the echo seems to come 90 ms *before* the sound; a small lead is allowed
  const early = envelopes(mic, sys, { micOrigin: 0, sysOrigin: 150 });
  assert.equal(micSegmentIsEnergyEcho(early.m, early.s, { startMs: 200, endMs: 1800 }), true);
  // far outside the window nothing lines up, so nothing is flagged
  const far = envelopes(mic, sys, { micOrigin: 1500, sysOrigin: 0 });
  assert.equal(micSegmentIsEnergyEcho(far.m, far.s, { startMs: 1700, endMs: 3300 }), false);
});

test('someone else talking over the system audio is not an echo', () => {
  let flagged = 0;
  const trials = 40;
  for (let k = 0; k < trials; k++) {
    const sys = speech(2000, 100 + k), me = speech(2000, 900 + k);
    const { m, s } = envelopes(me, sys);
    if (micSegmentIsEnergyEcho(m, s, { startMs: 200, endMs: 1700 })) flagged++;
  }
  assert.ok(flagged <= 1, `${flagged}/${trials} independent speakers were flagged`);
});

test('the user speaking while the system is silent is never an echo', () => {
  const me = speech(2000, 42);
  const silent = new Int16Array(me.length);
  const { m, s } = envelopes(me, silent);
  assert.equal(micSegmentIsEnergyEcho(m, s, { startMs: 100, endMs: 1900 }), false);
});

test('a very short segment needs a near-perfect match', () => {
  const sys = speech(1200, 77);
  const mic = echoOf(sys, { delayMs: 100, gain: 0.3 });
  const { m, s } = envelopes(mic, sys);
  const seg = { startMs: 300, endMs: 700 }; // 0.4 s
  const r = energyCorrelation(m.window(seg.startMs, seg.endMs), s.window(seg.startMs - 800, seg.endMs + 200), { lagFrames: 80, leadFrames: 20 });
  assert.equal(isEnergyEcho({ ...r, corr: 0.85 }), false, 'a so-so match on a short clip is not enough');
  assert.equal(isEnergyEcho({ ...r, frames: 10, corr: 0.99, spreadDb: 1 }), false, 'under a quarter of a second is never judged');
  assert.equal(isEnergyEcho({ ...r, corr: 0.97, spreadDb: 2, sharpness: 0.8, sysActive: 1 }), true);
});

test('the check needs a sharp peak, a speaking system and a steady level difference', () => {
  const base = { frames: 100, corr: 0.9, sharpness: 0.6, sysActive: 0.9, spreadDb: 3 };
  assert.equal(isEnergyEcho(base), true);
  assert.equal(isEnergyEcho({ ...base, sharpness: 0.2 }), false, 'similar at many delays means similar rhythm, not an echo');
  assert.equal(isEnergyEcho({ ...base, sysActive: 0.2 }), false, 'the system was mostly silent');
  assert.equal(isEnergyEcho({ ...base, spreadDb: 9 }), false, 'mic - system level wanders');
  assert.equal(isEnergyEcho(base, { minCorr: 0.95 }), false, 'thresholds can be tightened');
  assert.deepEqual(energyCorrelation(new Float32Array(0), new Float32Array(10), { lagFrames: 2, leadFrames: 2 }).corr, 0);
  assert.equal(FRAME_MS, 10);
});
