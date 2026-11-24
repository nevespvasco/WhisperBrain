'use strict';
// A rolling record of how loud each channel was, frame by frame (10 ms), on the recording's own timeline.
// It lets the echo check compare the microphone with the system audio without keeping any raw audio around.
const FRAME_MS = 10;
const FRAME_SAMPLES = 160;      // 10 ms at 16 kHz
const FLOOR_DB = -90;

// Loudness of each whole 10 ms frame of s16le PCM, in dB relative to full scale.
function frameDb(pcm) {
  const n = Math.floor((pcm.byteLength >> 1) / FRAME_SAMPLES);
  const out = new Float32Array(n);
  const v = new DataView(pcm.buffer, pcm.byteOffset, n * FRAME_SAMPLES * 2);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) { const s = v.getInt16((f * FRAME_SAMPLES + i) * 2, true) / 32768; sum += s * s; }
    out[f] = Math.max(FLOOR_DB, 10 * Math.log10(sum / FRAME_SAMPLES + 1e-12));
  }
  return out;
}

class EnergyEnvelope {
  // keepMs: how much history stays; older frames are dropped.
  constructor({ keepMs = 60000 } = {}) {
    this.keepFrames = Math.round(keepMs / FRAME_MS);
    this.runs = [];            // [{ startFrame, frames: number[] }] on the recording timeline; a pause starts a new run
    this.carry = null;         // bytes of a not-yet-complete frame
  }

  // Audio from here on starts at `originMs` of the recording (call at the first chunk and after every pause).
  begin(originMs) {
    this.carry = null;
    this.runs.push({ startFrame: Math.max(0, Math.round(originMs / FRAME_MS)), frames: [] });
  }

  push(pcm) {
    if (!this.runs.length) this.begin(0);
    let buf = pcm;
    if (this.carry) { buf = Buffer.concat([this.carry, pcm]); this.carry = null; }
    const whole = Math.floor(buf.length / (FRAME_SAMPLES * 2)) * FRAME_SAMPLES * 2;
    if (whole < buf.length) this.carry = Buffer.from(buf.subarray(whole));
    if (!whole) return;
    const run = this.runs[this.runs.length - 1];
    for (const d of frameDb(buf.subarray(0, whole))) run.frames.push(d);
    if (run.frames.length > this.keepFrames * 2) { // trim lazily so this stays cheap
      const drop = run.frames.length - this.keepFrames;
      run.frames.splice(0, drop);
      run.startFrame += drop;
    }
    while (this.runs.length > 1 && this.runs[0].startFrame + this.runs[0].frames.length < run.startFrame + run.frames.length - this.keepFrames) this.runs.shift();
  }

  // Frames covering [startMs, endMs) as dB values; anything not recorded reads as silence.
  window(startMs, endMs) {
    const from = Math.round(startMs / FRAME_MS);
    const n = Math.max(0, Math.round(endMs / FRAME_MS) - from);
    const out = new Float32Array(n).fill(FLOOR_DB);
    for (const run of this.runs) {
      const lo = Math.max(from, run.startFrame);
      const hi = Math.min(from + n, run.startFrame + run.frames.length);
      for (let f = lo; f < hi; f++) out[f - from] = run.frames[f - run.startFrame];
    }
    return out;
  }
}

module.exports = { EnergyEnvelope, frameDb, FRAME_MS, FRAME_SAMPLES, FLOOR_DB };
