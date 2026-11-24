'use strict';
// Discord voice audio -> what the speech engine takes. Discord sends 20 ms Opus packets, 48 kHz stereo once decoded;
// the engine wants s16le mono 16 kHz.

// 48 kHz stereo s16le -> 16 kHz mono s16le: each output sample is the mean of the 3 input frames (both channels), which
// is also a gentle low-pass, so nothing above 8 kHz folds back into the speech band.
function toMono16k(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const n = Math.floor(frames / 3);
  const out = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const sum = pcm.readInt16LE(o) + pcm.readInt16LE(o + 2) + pcm.readInt16LE(o + 4) + pcm.readInt16LE(o + 6) + pcm.readInt16LE(o + 8) + pcm.readInt16LE(o + 10);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
  }
  return out;
}

// One Opus decoder per speaker (the codec is stateful). opusscript is WebAssembly: no native module to rebuild for Electron.
class OpusDecoder {
  constructor(OpusScript) {
    this.dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  }
  // Opus packet -> 16 kHz mono s16le, or null when the packet is damaged (it is skipped; the next one resynchronises).
  decode(packet) {
    try { return toMono16k(this.dec.decode(packet)); } catch { return null; }
  }
  destroy() { try { this.dec.delete(); } catch { /* already freed */ } }
}

// Joins small decoded packets into chunks of about `ms` so the engine is not sent 50 messages a second per speaker.
class Coalescer {
  constructor(ms, emit) { this.limit = Math.round(ms * 16) * 2; this.emit = emit; this.parts = []; this.bytes = 0; }
  push(buf) {
    this.parts.push(buf);
    this.bytes += buf.length;
    if (this.bytes >= this.limit) this.flush();
  }
  flush() {
    if (!this.bytes) return;
    const out = Buffer.concat(this.parts);
    this.parts = [];
    this.bytes = 0;
    this.emit(out);
  }
}

module.exports = { toMono16k, OpusDecoder, Coalescer };
