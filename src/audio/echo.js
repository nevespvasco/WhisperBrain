'use strict';
// When the user listens on speakers, the microphone re-captures the other side of the call. Both channels then
// transcribe the same words. A mic segment that closely matches a time-overlapping system segment is an echo.
// Two backstops, used when echo cancellation did not remove the echo (or is not available):
//   isEcho        compares the text of the two segments
//   isEnergyEcho  compares how loud the two channels were, which also catches short or differently transcribed echoes
const { FRAME_MS, FLOOR_DB } = require('./envelope');
const tokens = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);

function overlaps(a, b, slackMs = 2500) {
  return a.startMs < b.endMs + slackMs && b.startMs < a.endMs + slackMs;
}

function isEcho(mic, sys) {
  if (!overlaps(mic, sys)) return false;
  const a = new Set(tokens(mic.text));
  const b = new Set(tokens(sys.text));
  if (a.size < 3 || b.size < 3) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = inter / Math.min(a.size, b.size);
  return jaccard >= 0.5 || containment >= 0.8;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 1e-9 && sbb > 1e-9 ? sab / Math.sqrt(saa * sbb) : 0;
}

// How well the microphone's loudness contour follows the system audio's, allowing the echo to arrive late.
//   mic: per-frame dB of the mic segment
//   sys: per-frame dB of the system channel from `lagFrames` before the segment start to `leadFrames` after its end
// The mic is the delayed copy: mic[i] ≈ sys[i - d]. Returns the best correlation over d in [-leadFrames, lagFrames].
function energyCorrelation(mic, sys, { lagFrames, leadFrames }) {
  const n = mic.length;
  if (n === 0 || sys.length < n) return { corr: 0, delayMs: 0, sharpness: 0, sysActive: 0, spreadDb: Infinity, frames: n };
  const slice = new Float32Array(n);
  const all = [];
  let best = -2, bestD = 0;
  for (let d = -leadFrames; d <= lagFrames; d++) {
    const start = lagFrames - d;
    if (start < 0 || start + n > sys.length) continue;
    for (let i = 0; i < n; i++) slice[i] = sys[start + i];
    const r = pearson(mic, slice);
    all.push([d, r]);
    if (r > best) { best = r; bestD = d; }
  }
  // A real echo has one sharp peak; speech that merely has a similar rhythm correlates a little at many delays.
  const others = all.filter(([d]) => Math.abs(d - bestD) > 10).map(([, r]) => r);
  const baseline = others.length ? others.reduce((m, r) => m + r, 0) / others.length : 0;
  const start = lagFrames - bestD;
  // Level spread: an echo is the same loudness contour a fixed number of dB lower, so mic - sys barely varies
  // while the system is speaking. Unrelated speech with a coincidentally similar rhythm varies a lot.
  let active = 0, sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    if (sys[start + i] <= SYS_ACTIVE_DB) continue;
    active++;
    const diff = mic[i] - sys[start + i];
    sum += diff; sumSq += diff * diff;
  }
  const spreadDb = active ? Math.sqrt(Math.max(0, sumSq / active - (sum / active) ** 2)) : Infinity;
  return { corr: best, delayMs: bestD * FRAME_MS, sharpness: best - baseline, sysActive: active / n, spreadDb, frames: n };
}

const SYS_ACTIVE_DB = -50;        // below this the system channel is effectively silent
// Under 0.6 s the loudness contour has too few syllables to trust a looser match: unrelated speech can resemble it by chance.
const ENERGY_DEFAULTS = { minFrames: 25, minCorr: 0.8, minSharpness: 0.45, minSysActive: 0.5, maxSpreadDb: 6, shortFrames: 60, shortMinCorr: 0.92, shortMaxSpreadDb: 4 };

// True when the microphone segment looks like the system audio played back through the room.
function isEnergyEcho(result, opts = {}) {
  const o = { ...ENERGY_DEFAULTS, ...opts };
  const short = result.frames < o.shortFrames;
  return result.frames >= o.minFrames
    && result.corr >= (short ? o.shortMinCorr : o.minCorr)
    && result.spreadDb <= (short ? o.shortMaxSpreadDb : o.maxSpreadDb)
    && result.sharpness >= o.minSharpness && result.sysActive >= o.minSysActive;
}

// Convenience for the recording manager: segment times are on the recording's timeline, envelopes are EnergyEnvelopes.
function micSegmentIsEnergyEcho(micEnv, sysEnv, { startMs, endMs }, { maxDelayMs = 800, maxLeadMs = 200, ...opts } = {}) {
  const lagFrames = Math.round(maxDelayMs / FRAME_MS), leadFrames = Math.round(maxLeadMs / FRAME_MS);
  const mic = micEnv.window(startMs, endMs);
  const sys = sysEnv.window(startMs - maxDelayMs, endMs + maxLeadMs);
  if (sys.length < mic.length + lagFrames + leadFrames) return false;
  return isEnergyEcho(energyCorrelation(mic, sys, { lagFrames, leadFrames }), opts);
}

module.exports = { isEcho, tokens, energyCorrelation, isEnergyEcho, micSegmentIsEnergyEcho, ENERGY_DEFAULTS, FLOOR_DB };
