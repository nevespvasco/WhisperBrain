'use strict';
// PCM helpers. The pipeline's wire format is signed 16-bit little-endian, mono, 16 kHz.
const RATE = 16000;

function rms(pcm) {
  const n = pcm.byteLength >> 1;
  if (!n) return 0;
  const v = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = v.getInt16(i * 2, true) / 32768; sum += s * s; }
  return Math.sqrt(sum / n);
}

// Linear resampler for Float32 input (used by renderer capture when the AudioContext cannot be 16 kHz).
function resampleLinear(input, fromRate, toRate = RATE) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0];
    const b = input[Math.min(i0 + 1, input.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function floatToPcm16(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return out;
}

function pcm16ToFloat(buf) {
  const n = buf.byteLength >> 1;
  const out = new Float32Array(n);
  const v = new DataView(buf.buffer, buf.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 32768;
  return out;
}

// Minimal RIFF parser: 16-bit PCM mono/stereo at any rate -> { samples: mono Float32, rate }, not resampled.
function parseWav(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: wav.readUInt16LE(pos + 8), channels: wav.readUInt16LE(pos + 10), rate: wav.readUInt32LE(pos + 12), bits: wav.readUInt16LE(pos + 22) };
    if (id === 'data') { data = wav.subarray(pos + 8, pos + 8 + size); break; }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('malformed WAV');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM WAV is supported');
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    samples[i] = s / fmt.channels / 32768;
  }
  return { samples, rate: fmt.rate };
}

// WAV -> mono 16 kHz Int16 Buffer. Other rates go through resampleLinear (no anti-alias filter), so the import path
// uses parseWav and the ASR worker's resampler instead; this is for callers that need the result synchronously.
function wavToPcm16(wav) {
  const { samples, rate } = parseWav(wav);
  return floatToPcm16(resampleLinear(samples, rate));
}

function pcm16ToWav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

module.exports = { RATE, rms, resampleLinear, floatToPcm16, pcm16ToFloat, parseWav, wavToPcm16, pcm16ToWav };
