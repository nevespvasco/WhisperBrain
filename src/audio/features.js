'use strict';
// Acoustic voice features: pitch, timbre (MFCC), brightness. Pure JS, no models, no I/O.
// These complement the neural voice embedding: the embedding says "sounds like", the acoustics say whether the
// fundamental frequency and the vocal-tract shape really match. They run after a recording, never during it.
const RATE = 16000;
const FRAME = 400;          // 25 ms analysis frame
const HOP = 160;            // 10 ms hop
const NFFT = 512;
const NMEL = 26;
const NCOEF = 12;           // MFCC c1..c12 (c0 is loudness)
const PITCH_WIN = 512;      // samples at 8 kHz = 64 ms
const LAG_MIN = 20;         // 400 Hz
const LAG_MAX = 114;        // 70 Hz
const MIN_VOICED = 20;      // frames (0.2 s of voiced speech) needed for a trustworthy description

// Names and weights of the vector returned by voiceFeatures(); weights say how much each dimension matters
// when comparing two voices (pitch is the strongest single cue, the cepstrum carries the vocal-tract timbre).
const DIMS = [
  ...Array.from({ length: NCOEF }, (_, i) => `mfcc${i + 1}`),
  'logF0', 'f0Spread', 'centroid', 'rolloff', 'tilt', 'periodicity',
];
const WEIGHTS = Float64Array.from([...Array(NCOEF).fill(1), 3, 0.6, 1, 1, 1, 0.6]);

// ---- FFT (radix-2, in place) ----
function makeFft(n) {
  const levels = Math.log2(n);
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim; re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const fft = makeFft(NFFT);
const hann = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

const mel = (f) => 2595 * Math.log10(1 + f / 700);
const unmel = (m) => 700 * (10 ** (m / 2595) - 1);
const FILTERS = (() => {
  const lo = mel(80), hi = mel(7600);
  const pts = Array.from({ length: NMEL + 2 }, (_, i) => Math.floor(((NFFT + 1) * unmel(lo + ((hi - lo) * i) / (NMEL + 1))) / RATE));
  return Array.from({ length: NMEL }, (_, m) => {
    const [a, b, c] = [pts[m], pts[m + 1], pts[m + 2]];
    const w = [];
    for (let k = a; k < c; k++) w.push(k < b ? (k - a) / Math.max(1, b - a) : (c - k) / Math.max(1, c - b));
    return { start: a, w };
  });
})();
const DCT = Array.from({ length: NCOEF }, (_, c) => Float64Array.from({ length: NMEL }, (_, m) => Math.cos((Math.PI * (c + 1) * (m + 0.5)) / NMEL)));

// Fundamental frequency of a window of 8 kHz audio by normalised autocorrelation. -> { f0, strength } | null
function pitchOf(x, from) {
  let mean = 0;
  for (let i = 0; i < PITCH_WIN; i++) mean += x[from + i];
  mean /= PITCH_WIN;
  const w = new Float64Array(PITCH_WIN);
  for (let i = 0; i < PITCH_WIN; i++) w[i] = x[from + i] - mean;
  const sq = new Float64Array(PITCH_WIN + 1);
  for (let i = 0; i < PITCH_WIN; i++) sq[i + 1] = sq[i] + w[i] * w[i];
  const nac = new Float64Array(LAG_MAX + 2);
  let best = 0;
  for (let lag = LAG_MIN - 1; lag <= LAG_MAX + 1; lag++) {
    const len = PITCH_WIN - lag;
    let num = 0;
    for (let i = 0; i < len; i++) num += w[i] * w[i + lag];
    const den = Math.sqrt(sq[len] * (sq[PITCH_WIN] - sq[lag])) || 1e-12;
    nac[lag] = num / den;
    if (lag >= LAG_MIN && lag <= LAG_MAX && nac[lag] > best) best = nac[lag];
  }
  if (best < 0.45) return null;
  // the shortest lag whose peak is nearly as strong as the best one (avoids octave-down errors)
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    if (nac[lag] >= 0.88 * best && nac[lag] >= nac[lag - 1] && nac[lag] >= nac[lag + 1]) {
      const a = nac[lag - 1], b = nac[lag], c = nac[lag + 1];
      const d = a - 2 * b + c;
      const delta = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      return { f0: 8000 / (lag + delta), strength: Math.min(1, b) };
    }
  }
  return null;
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)))];

// samples: Float32Array in [-1, 1] at 16 kHz. Returns { vec: Float32Array(DIMS.length), f0, voicedMs } or null when there is
// too little voiced speech to describe a voice.
function voiceFeatures(samples) {
  const n = samples.length;
  if (n < RATE * 0.5) return null;
  const frames = Math.floor((n - FRAME) / HOP) + 1;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * HOP, e = i + FRAME; i < e; i++) s += samples[i] * samples[i];
    rms[f] = Math.sqrt(s / FRAME);
  }
  const sorted = Float32Array.from(rms).sort();
  const gate = Math.max(quantile(sorted, 0.95) * 0.25, 0.002);

  // 8 kHz copy for pitch tracking (3-tap low-pass, then decimate)
  const m = n >> 1;
  const dec = new Float32Array(m);
  for (let i = 1; i < m - 1; i++) dec[i] = 0.25 * samples[2 * i - 1] + 0.5 * samples[2 * i] + 0.25 * samples[2 * i + 1];

  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const logMel = new Float64Array(NMEL);
  const sum = new Float64Array(NCOEF);
  const f0s = [], periodic = [];
  let voiced = 0, cSum = 0, rSum = 0, tSum = 0, lastPitch = null;

  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    if (f % 2 === 0) { // one pitch estimate per 20 ms, centred on this frame
      const c8 = (start + FRAME / 2) >> 1;
      const from = c8 - PITCH_WIN / 2;
      lastPitch = rms[f] >= gate && from >= 0 && from + PITCH_WIN <= m ? pitchOf(dec, from) : null;
    }
    if (rms[f] < gate || !lastPitch) continue; // timbre is measured on voiced, audible frames only
    if (f % 2 === 0) { f0s.push(lastPitch.f0); periodic.push(lastPitch.strength); }

    for (let i = 0; i < FRAME; i++) re[i] = (samples[start + i] - (i ? 0.97 * samples[start + i - 1] : 0)) * hann[i];
    re.fill(0, FRAME); im.fill(0);
    fft(re, im);
    const bins = NFFT / 2 + 1;
    const p = new Float64Array(bins);
    for (let k = 0; k < bins; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    for (let q = 0; q < NMEL; q++) {
      const { start: a, w } = FILTERS[q];
      let e = 0;
      for (let j = 0; j < w.length; j++) e += w[j] * (p[a + j] || 0);
      logMel[q] = Math.log(e + 1e-9);
    }
    for (let c = 0; c < NCOEF; c++) { let s = 0; for (let q = 0; q < NMEL; q++) s += DCT[c][q] * logMel[q]; sum[c] += s; }

    // brightness: centroid, 85 % roll-off, and the slope of the spectrum between 100 Hz and 4 kHz
    let tot = 0, cen = 0;
    for (let k = 1; k < bins; k++) { tot += p[k]; cen += p[k] * k; }
    let acc = 0, roll = bins - 1;
    for (let k = 1; k < bins; k++) { acc += p[k]; if (acc >= 0.85 * tot) { roll = k; break; } }
    cSum += (cen / (tot || 1)) * (RATE / NFFT);
    rSum += roll * (RATE / NFFT);
    const k0 = Math.round((100 * NFFT) / RATE), k1 = Math.round((4000 * NFFT) / RATE);
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let k = k0; k <= k1; k++) { const x = (k * RATE) / NFFT / 1000, y = 10 * Math.log10(p[k] + 1e-12); sx += x; sy += y; sxx += x * x; sxy += x * y; cnt++; }
    tSum += (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx || 1);
    voiced++;
  }

  if (voiced < MIN_VOICED || f0s.length < 8) return null;
  const f0sorted = Float64Array.from(f0s).sort();
  const med = quantile(f0sorted, 0.5);
  const spread = Math.log2(quantile(f0sorted, 0.9) / quantile(f0sorted, 0.1));
  const vec = new Float32Array(DIMS.length);
  for (let c = 0; c < NCOEF; c++) vec[c] = sum[c] / voiced;
  vec[NCOEF] = Math.log(med);
  vec[NCOEF + 1] = Math.min(2, spread);
  vec[NCOEF + 2] = cSum / voiced / 1000;
  vec[NCOEF + 3] = rSum / voiced / 1000;
  vec[NCOEF + 4] = tSum / voiced;
  vec[NCOEF + 5] = periodic.reduce((a, b) => a + b, 0) / periodic.length;
  return { vec, f0: med, voicedMs: voiced * 10 };
}

// Distance between two pitches in semitones.
const semitones = (a, b) => Math.abs(12 * Math.log2(a / b));

module.exports = { voiceFeatures, semitones, DIMS, WEIGHTS, RATE };
