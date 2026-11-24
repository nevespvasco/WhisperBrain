'use strict';
// Synthetic audio for the echo tests: noise carriers shaped by a syllable-like loudness contour (the energy check only
// looks at loudness, never at the words).
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function speech(ms, seed, { peak = 8000 } = {}) {
  const r = rng(seed);
  const n = Math.round(ms * 16);
  const out = new Int16Array(n);
  let i = 0;
  while (i < n) {
    const len = Math.round((60 + r() * 160) * 16);       // a syllable
    const amp = peak * (0.25 + 0.75 * r());
    for (let k = 0; k < len && i + k < n; k++) out[i + k] = Math.round((r() * 2 - 1) * amp * Math.sin(Math.PI * (k / len)));
    i += len + Math.round((20 + r() * 110) * 16);          // a pause
  }
  return out;
}

// What the microphone hears of `src`: delayed, quieter, with a noise floor.
function echoOf(src, { delayMs = 120, gain = 0.3, floor = 25, seed = 7 } = {}) {
  const r = rng(seed);
  const d = Math.round(delayMs * 16);
  return Int16Array.from(src, (_, i) => Math.round((i >= d ? src[i - d] * gain : 0) + (r() * 2 - 1) * floor));
}
const mix = (a, b, gb = 1) => Int16Array.from(a, (x, i) => Math.max(-32768, Math.min(32767, x + (b[i] || 0) * gb)));
const bytes = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);

module.exports = { rng, speech, echoOf, mix, bytes };
