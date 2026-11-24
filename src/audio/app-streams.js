'use strict';
// The audio of several chosen applications as one channel (the system channel of a recording that follows, say, Zoom and Discord
// but not the music playing next to them). Their playback streams are not there all the time: Discord's exists a few seconds
// while somebody speaks, then goes away; Zoom's stays. So the streams are looked for again and again, each one found is followed
// until it ends, and what they play is mixed on the wall clock, with silence in between: the channel never stops or runs fast, and
// the transcript's timeline stays true against the microphone's.
const { AudioSource } = require('./source');

const RATE = 16000;
const BYTES = 2;                 // signed 16-bit little-endian mono, the pipeline's wire format
const MAX_QUEUE = RATE * BYTES * 3; // a stream that delivers in a burst is not allowed to build up more than 3 s of delay

class AppStreamsSource extends AudioSource {
  // list(): -> [{ key, name }] the streams to follow right now (playing, and the chosen applications' own)
  // open(stream): -> an AudioSource of that stream's PCM, not started
  // capture: what is said about it ({ mode: 'apps', app, reason })
  constructor({ list, open, capture, pollMs = 700, frameMs = 100, now = Date.now }) {
    super();
    Object.assign(this, { list, open, capture, pollMs, frameMs, now });
    this.streams = new Map();    // key -> { src, buf }
    this.stopping = false;
    this.busy = false;
    this.emitted = 0;            // samples sent so far; the clock decides how many are due
  }

  start() {
    this.t0 = this.now();
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), this.pollMs);
    this.frameTimer = setInterval(() => this.flush(), this.frameMs);
    this.pollTimer.unref?.(); this.frameTimer.unref?.();
  }

  async refresh() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      for (const s of await this.list()) {
        if (this.stopping || this.streams.has(s.key)) continue;
        const entry = { src: null, buf: Buffer.alloc(0) };
        this.streams.set(s.key, entry);
        try {
          entry.src = this.open(s);
          entry.src.on('pcm', (b) => { entry.buf = entry.buf.length + b.length > MAX_QUEUE ? Buffer.concat([entry.buf, b]).subarray(-MAX_QUEUE) : Buffer.concat([entry.buf, b]); });
          entry.src.on('error', () => {});                 // a stream ending is not an error; 'end' follows
          entry.src.once('end', () => { if (this.streams.get(s.key) === entry) entry.ended = true; }); // its last audio is still mixed in
          entry.src.start();
        } catch { this.streams.delete(s.key); }
      }
    } catch { /* PipeWire did not answer this time; the next look decides */ }
    this.busy = false;
  }

  // Send what is due by the clock: the sum of what each followed stream has played, silence where there is none.
  flush() {
    if (this.stopping) return;
    const due = Math.floor(((this.now() - this.t0) * RATE) / 1000) - this.emitted;
    if (due <= 0) return;
    const mix = new Int32Array(due);
    for (const [key, e] of this.streams) {
      const n = Math.min(due, e.buf.length >> 1);
      for (let i = 0; i < n; i++) mix[i] += e.buf.readInt16LE(i * 2);
      e.buf = e.buf.subarray(n * 2);
      if (e.ended && !e.buf.length) this.streams.delete(key);
    }
    const out = Buffer.alloc(due * BYTES);
    for (let i = 0; i < due; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i])), i * 2);
    this.emitted += due;
    this.emit('pcm', out);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.pollTimer); clearInterval(this.frameTimer);
    for (const e of this.streams.values()) { try { e.src?.stop(); } catch { /* already gone */ } }
    this.streams.clear();
    this.emit('end');
  }
}

module.exports = { AppStreamsSource };
