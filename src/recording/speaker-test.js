'use strict';
// A speaker test recording: the Discord bot hears each person on their own stream while the computer's mixed sound of the
// same call is captured too. Both are kept on disk on one wall clock, so the mixed sound can later be scored against who
// really spoke when (eval/discord-test.js turns a folder into an eval recording). Nothing is transcribed from the mixed
// sound while recording; it only goes to disk.
//
// Folder layout (16 kHz mono s16le, sample 0 = `originMs`):
//   system.pcm          the computer's mixed sound of the call
//   person-<userId>.pcm one per person the bot heard, silence where they were quiet
//   meta.json           { version, originMs, selfUserId, endedAt, people: [{ userId, name, file, seconds }], system: { file, seconds, gaps } }
const fs = require('node:fs');
const path = require('node:path');

const RATE = 16000;
const JUMP_SAMPLES = RATE / 2; // the mixed sound is written one chunk after the other; when the wall clock is this far ahead (a pause, a capture hiccup) it jumps

class SpeakerTestRecorder {
  // selfUserId: your Discord user id; your voice is not in the mixed sound (Discord does not play you back), so the scorer leaves it out
  constructor(dir, { now = Date.now, selfUserId = '' } = {}) {
    this.dir = dir;
    this.selfUserId = String(selfUserId || '');
    this.now = now;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.originMs = now();
    this.sys = { fd: fs.openSync(path.join(dir, 'system.pcm'), 'w', 0o600), pos: null, end: 0, gaps: 0 };
    this.people = new Map(); // userId -> { name, fd, file, end }
    this.closed = false;
  }

  // sample position on the shared clock of audio that ended at `endMs` and lasted `samples`
  at(endMs, samples) { return Math.max(0, Math.round(((endMs - this.originMs) / 1000) * RATE) - samples); }

  // A chunk of the mixed sound, as it arrives.
  system(buf, endMs = this.now()) {
    if (this.closed || !buf.length) return;
    const n = buf.length >> 1;
    const wall = this.at(endMs, n);
    const s = this.sys;
    if (s.pos === null) s.pos = wall;
    else if (wall - s.pos > JUMP_SAMPLES) { s.pos = wall; s.gaps++; }
    fs.writeSync(s.fd, buf, 0, n * 2, s.pos * 2);
    s.pos += n;
    s.end = Math.max(s.end, s.pos);
  }

  // A chunk of one person's own stream. `endMs`: when the chunk ended (the bot's `ts`).
  person(userId, name, buf, endMs) {
    if (this.closed || !buf.length) return;
    const id = String(userId);
    let p = this.people.get(id);
    if (!p) {
      const file = `person-${id.replace(/[^0-9A-Za-z_-]/g, '_')}.pcm`;
      p = { name: name || id, file, fd: fs.openSync(path.join(this.dir, file), 'w', 0o600), end: 0 };
      this.people.set(id, p);
    }
    const n = buf.length >> 1;
    const pos = Math.max(p.end, this.at(endMs, n)); // never over what this person already said: late chunks follow on
    fs.writeSync(p.fd, buf, 0, n * 2, pos * 2);
    p.end = pos + n;
  }

  // -> { dir, people, systemSeconds }
  close() {
    if (this.closed) return this.summary;
    this.closed = true;
    const people = [...this.people].map(([userId, p]) => { fs.closeSync(p.fd); return { userId, name: p.name, file: p.file, seconds: p.end / RATE }; });
    fs.closeSync(this.sys.fd);
    const meta = { version: 1, rate: RATE, originMs: this.originMs, selfUserId: this.selfUserId || null, endedAt: this.now(), people, system: { file: 'system.pcm', seconds: this.sys.end / RATE, gaps: this.sys.gaps } };
    fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(meta, null, 1), { mode: 0o600 });
    this.summary = { dir: this.dir, people: people.map((p) => p.name), systemSeconds: meta.system.seconds };
    return this.summary;
  }
}

module.exports = { SpeakerTestRecorder, RATE };
