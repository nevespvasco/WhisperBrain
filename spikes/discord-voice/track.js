// One output file per Discord user: Opus packets in, 16 kHz mono s16le WAV out.
// Every file shares the same t0 (when the bot joined), and gaps are filled with
// silence, so sample N in any file is the same wall-clock instant in all files.
import fs from 'node:fs';
import OpusScript from 'opusscript';

export const RATE = 16000;
const BYTES_PER_MS = (RATE * 2) / 1000;
// Pad only when we are more than this far behind the wall clock; smaller drift is
// network jitter and catches up on its own.
const GAP_TOLERANCE_MS = 100;

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

export class UserTrack {
  constructor(file, t0, now = Date.now) {
    this.file = file;
    this.t0 = t0;
    this.now = now;
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, wavHeader(0));
    this.bytes = 0;
    // libopus decodes straight to 16 kHz mono (it resamples internally), so no
    // separate 48k -> 16k step is needed.
    this.decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
    this.stats = { packets: 0, decodeErrors: 0, utterances: 0, paddedMs: 0 };
  }

  #writeSilenceUntil(ms) {
    const target = Math.floor(ms * BYTES_PER_MS) & ~1;
    if (target <= this.bytes) return;
    const zeros = Buffer.alloc(target - this.bytes);
    fs.writeSync(this.fd, zeros);
    this.stats.paddedMs += zeros.length / BYTES_PER_MS;
    this.bytes = target;
  }

  push(opus) {
    this.stats.packets++;
    let pcm;
    try {
      pcm = this.decoder.decode(opus);
    } catch {
      // A frame that is still E2EE-encrypted (DAVE not ready) lands here.
      this.stats.decodeErrors++;
      return;
    }
    // The packet just arrived and lasts pcm.length bytes, so it started that long ago.
    const startMs = this.now() - this.t0 - pcm.length / BYTES_PER_MS;
    if (startMs * BYTES_PER_MS - this.bytes > GAP_TOLERANCE_MS * BYTES_PER_MS) this.#writeSilenceUntil(startMs);
    fs.writeSync(this.fd, pcm);
    this.bytes += pcm.length;
  }

  close(endMs = this.now() - this.t0) {
    this.#writeSilenceUntil(endMs);
    fs.writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0);
    fs.closeSync(this.fd);
    this.decoder.delete();
    return { file: this.file, seconds: this.bytes / BYTES_PER_MS / 1000, ...this.stats };
  }
}
