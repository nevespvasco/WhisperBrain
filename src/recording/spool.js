'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Raw audio (s16le mono 16 kHz) of one channel, parked in a private temp file while a recording runs, so the
// after-recording speaker pass can listen again to every utterance. It is deleted when the pass is done.
// A spool never throws into the capture path: if the disk misbehaves it marks itself broken and goes quiet.
class Spool {
  constructor(dir, noteId, channel) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, `${String(noteId).replace(/[^\w-]/g, '_')}-${channel}-${process.pid}-${Date.now()}.pcm`);
    this.fd = fs.openSync(this.file, 'w+', 0o600);
    this.samples = 0;
    this.broken = false;
  }

  write(buf) {
    if (this.broken || this.fd === null) return;
    try {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off);
      this.samples += buf.length >> 1;
    } catch { this.broken = true; }
  }

  // Samples [from, to) as an s16le Buffer.
  read(from, to) {
    if (this.fd === null) return null;
    const n = Math.max(0, Math.min(to, this.samples) - Math.max(0, from)) * 2;
    if (!n) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const r = fs.readSync(this.fd, out, got, n - got, Math.max(0, from) * 2 + got);
      if (!r) break;
      got += r;
    }
    return got === n ? out : out.subarray(0, got);
  }

  close() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* already closed */ } this.fd = null; }
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
  }

  // Remove spools left behind by a crash.
  static sweep(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const f of names) if (f.endsWith('.pcm')) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch { /* in use elsewhere */ } }
    return n;
  }
}

module.exports = { Spool };
