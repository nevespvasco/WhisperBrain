'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KEEP_MS = 7 * 86400000; // a spool kept for later (a crash, a quit, a stretch the speech engine missed) is given up after this

// Raw audio (s16le mono 16 kHz) of one channel, parked in a private temp file while a recording runs, so the
// after-recording speaker pass can listen again to every utterance. It is deleted when the pass is done.
// A spool never throws into the capture path: if the disk misbehaves it marks itself broken, says so once (onError) and goes quiet.
// Beside it, a small JSON file (`meta`) says what the audio is: { noteId, channel, stretches: [{ at, ms }] (where each stretch
// of audio starts in the spool and on the note's timeline), gaps: [{ from, to }] (samples the speech engine never decoded),
// state: 'recording' | 'deferred' }. It is what lets the next start finish a recording a crash or a quit cut short.
class Spool {
  constructor(dir, noteId, channel, { onError = null } = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, `${String(noteId).replace(/[^\w-]/g, '_')}-${channel}-${process.pid}-${Date.now()}.pcm`);
    this.metaFile = Spool.metaFileOf(this.file);
    this.fd = fs.openSync(this.file, 'w+', 0o600);
    this.samples = 0;
    this.broken = false;
    this.onError = onError;
    this.meta = { noteId: String(noteId), channel, stretches: [], gaps: [], state: 'recording' };
    this.writeMeta({});
  }

  static metaFileOf(file) { return file.replace(/\.pcm$/, '.json'); }

  // Changes to what the audio is (rare: a new stretch, a gap). Best effort, like the audio.
  writeMeta(patch) {
    Object.assign(this.meta, patch);
    try { fs.writeFileSync(this.metaFile, JSON.stringify(this.meta), { mode: 0o600 }); } catch { /* the audio is what matters */ }
  }

  write(buf) {
    if (this.broken || this.fd === null) return;
    try {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off);
      this.samples += buf.length >> 1;
    } catch (e) { this.broken = true; try { this.onError?.(e); } catch { /* never into the capture path */ } }
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
    try { fs.unlinkSync(this.metaFile); } catch { /* already gone */ }
  }

  // Close it for writing but leave it on disk, for the work that finishes the recording later (see RecordingManager.recoverNote).
  keep(patch = {}) {
    this.writeMeta({ state: 'deferred', ...patch });
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* already closed */ } this.fd = null; }
  }

  // A spool left on disk, opened again to be read (and deleted with close()).
  static attach(file) {
    const sp = Object.create(Spool.prototype);
    sp.file = file;
    sp.metaFile = Spool.metaFileOf(file);
    sp.meta = JSON.parse(fs.readFileSync(sp.metaFile, 'utf8'));
    sp.fd = fs.openSync(file, 'r');
    sp.samples = fs.fstatSync(sp.fd).size >> 1;
    sp.broken = true; // never written again
    sp.onError = null;
    return sp;
  }

  // The spools left on disk that say what they are. -> [{ file, meta, samples, mtimeMs }]
  static leftovers(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const f of names.filter((x) => x.endsWith('.pcm')).sort()) {
      const file = path.join(dir, f);
      try {
        const meta = JSON.parse(fs.readFileSync(Spool.metaFileOf(file), 'utf8'));
        const st = fs.statSync(file);
        out.push({ file, meta, samples: st.size >> 1, mtimeMs: st.mtimeMs });
      } catch { /* no notes beside it: not ours to finish */ }
    }
    return out;
  }

  // Remove spools left behind by a crash, except the ones still worth finishing: younger than maxAgeMs, with their notes, and
  // that keep(meta) wants (the note still exists). Without `keep`, everything goes, as before.
  static sweep(dir, { keep = null, maxAgeMs = KEEP_MS, now = Date.now() } = {}) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    const wanted = new Set();
    if (keep) for (const l of Spool.leftovers(dir)) { try { if (now - l.mtimeMs <= maxAgeMs && keep(l.meta)) wanted.add(l.file); } catch { /* not wanted */ } }
    let n = 0;
    for (const f of names) {
      const file = path.join(dir, f);
      if (f.endsWith('.pcm') && !wanted.has(file)) { try { fs.unlinkSync(file); n++; } catch { /* in use elsewhere */ } try { fs.unlinkSync(Spool.metaFileOf(file)); } catch { /* none */ } }
      else if (f.endsWith('.json') && !names.includes(f.replace(/\.json$/, '.pcm'))) { try { fs.unlinkSync(file); } catch { /* gone */ } }
    }
    return n;
  }
}

module.exports = { Spool, KEEP_MS };
