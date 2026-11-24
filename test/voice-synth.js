'use strict';
// Tiny source–filter voice synthesiser for tests: a pulse train at the speaker's pitch pushed through three
// formant resonators. A "speaker" is a pitch plus a vocal-tract scale; the vowels (content) vary per utterance,
// exactly as the words do in real speech, so two voices must be told apart despite saying different things.
const RATE = 16000;
const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410], [660, 1720, 2410]];

function rng(seed) { let x = seed >>> 0 || 1; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

function resonator(freq, bw) {
  const r = Math.exp((-Math.PI * bw) / RATE), th = (2 * Math.PI * freq) / RATE;
  const a1 = -2 * r * Math.cos(th), a2 = r * r;
  let y1 = 0, y2 = 0;
  return (x) => { const y = x - a1 * y1 - a2 * y2; y2 = y1; y1 = y; return y; };
}

// speaker: { f0, tract } (tract scales formants: ~1.0 adult male, ~1.17 adult female). Returns Float32Array.
function utterance(speaker, { seconds = 2.4, seed = 1, noise = 0.004, vibrato = 0.04 } = {}) {
  const rand = rng(seed);
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  let phase = 0, vowel = VOWELS[Math.floor(rand() * VOWELS.length)], res = null, untilSwitch = 0;
  const f0drift = 1 + (rand() - 0.5) * 0.12;
  for (let i = 0; i < n; i++) {
    if (i >= untilSwitch) {
      vowel = VOWELS[Math.floor(rand() * VOWELS.length)];
      res = vowel.map((f, k) => resonator(Math.min(f * speaker.tract, 7000), 60 + k * 40));
      untilSwitch = i + Math.round((0.12 + rand() * 0.14) * RATE);
    }
    const t = i / RATE;
    const f0 = speaker.f0 * f0drift * (1 + vibrato * Math.sin(2 * Math.PI * 4.2 * t + seed));
    phase += f0 / RATE;
    let src = 0;
    if (phase >= 1) { phase -= 1; src = 1; }
    let y = src * 14;
    y = res[0](y); y = res[1](y) + y * 0.2; y = res[2](y) + y * 0.2;
    const env = Math.min(1, t * 20, (seconds - t) * 20); // fade in/out
    out[i] = y * env + (rand() - 0.5) * noise * 2;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.5 / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

const toPcm16 = (f32) => { const b = Buffer.alloc(f32.length * 2); for (let i = 0; i < f32.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767), i * 2); return b; };

const MAN = { f0: 115, tract: 1.0 };
const WOMAN = { f0: 205, tract: 1.17 };
const DEEP = { f0: 95, tract: 0.93 };

module.exports = { utterance, toPcm16, rng, RATE, MAN, WOMAN, DEEP };
