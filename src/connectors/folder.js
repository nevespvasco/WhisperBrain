'use strict';
// A folder of notes as a source: plain Markdown/text files and PDFs, in a folder or an Obsidian vault. Pointer mode: the files stay
// the originals and are never written or moved; the item keeps the path, a hash of the content and the text for search.
//
// Reading is cheap on purpose: a file whose modified time and size match what the last scan saw is not even opened. Scanning yields
// to the event loop often (a vault of thousands of files must not freeze the window) and writes in small transactions.
// After a full scan, items whose file is gone are tombstoned. A watcher (fs.watch) picks up edits within about a second; a periodic
// scan (src/connectors/manager.js) covers what the watcher can miss.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFrontmatter } = require('../integrations/obsidian');

const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.stfolder', '.DS_Store']);
const MAX_TEXT_FILE = 5 * 1024 * 1024;
const MAX_PDF_FILE = 30 * 1024 * 1024;
const BATCH = 25;
const YIELD_MS = 15;                                        // never hold the event loop longer than this between yields

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
const tick = () => new Promise((r) => setImmediate(r));
const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const toRel = (root, p) => path.relative(root, p).split(path.sep).join('/');

class FolderConnector {
  // source: { id, kind: 'folder' | 'obsidian', config: { path, exclude?: [dir names] } }. items: the ItemStore.
  constructor({ source, items, pdfToText = null, now = () => Date.now() }) {
    this.source = source;
    this.items = items;
    this.pdfToText = pdfToText;
    this.now = now;
    this.watcher = null;
  }

  get exclude() { return new Set((this.source.config.exclude || []).map((d) => String(d).replace(/^\/+|\/+$/g, ''))); }

  root() {
    const p = String(this.source.config.path || '').trim();
    if (!p) throw new Error('No folder is set for this source.');
    let st;
    try { st = fs.statSync(p); } catch { throw new Error(`The folder does not exist: ${p}`); }
    if (!st.isDirectory()) throw new Error(`This is not a folder: ${p}`);
    return fs.realpathSync(path.resolve(p));
  }

  // quick look for the Sources page: is the folder readable, is it a vault, how many files would be read
  check() {
    const root = this.root();
    let n = 0;
    this.walk(root, () => { n++; });
    return { ok: true, path: root, isVault: fs.existsSync(path.join(root, '.obsidian')), files: n };
  }

  // Calls fn(abs, relPath, stat) for every file that would be indexed. Does not follow symlinks (a link could lead out of the folder).
  walk(root, fn) {
    const exclude = this.exclude;
    const visit = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') || exclude.has(toRel(root, abs))) continue;
          visit(abs);
        } else if (e.isFile() && this.wanted(e.name)) {
          let st; try { st = fs.statSync(abs); } catch { continue; }
          fn(abs, toRel(root, abs), st);
        }
      }
    };
    visit(root);
  }

  wanted(name) {
    const ext = path.extname(name).toLowerCase();
    return TEXT_EXT.has(ext) || (ext === '.pdf' && !!this.pdfToText);
  }

  // One file → the fields of its item (or null when it must not be indexed: too big, empty, or a note WhisperBrain exported itself).
  async read(abs, rel, st, root) {
    const ext = path.extname(abs).toLowerCase();
    const base = path.basename(abs, path.extname(abs));
    const common = { externalId: rel, path: abs, occurredAt: Math.round(st.mtimeMs), meta: { mtime: Math.round(st.mtimeMs), size: st.size } };
    if (ext === '.pdf') {
      if (st.size > MAX_PDF_FILE) return null;
      const buf = fs.readFileSync(abs);
      let text = '';
      try { text = (await this.pdfToText(buf)).text || ''; } catch { return { ...common, kind: 'document', title: base, text: '', hash: sha(buf), meta: { ...common.meta, unreadable: true } }; }
      return { ...common, kind: 'document', title: base, text, hash: sha(buf) };
    }
    if (st.size > MAX_TEXT_FILE) return null;
    const buf = fs.readFileSync(abs);
    const raw = buf.toString('utf8');
    if (ext === '.txt') return { ...common, kind: 'note', title: base, text: raw, hash: sha(buf) };
    const { data, body } = parseFrontmatter(raw);
    if (data.whisperbrain_id) return null;                  // a meeting WhisperBrain wrote into the vault: it is already a meeting here
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const links = [...new Set([...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))].slice(0, 50);
    const tags = [...new Set([...(Array.isArray(data.tags) ? data.tags : data.tags ? String(data.tags).split(/[,\s]+/) : []), ...[...body.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_/-]{1,40})/gu)].map((m) => m[1])].map((x) => String(x).replace(/^#/, '')).filter(Boolean))].slice(0, 30);
    const dated = Date.parse(data.date || data.created || '');
    const vault = path.basename(root);
    return {
      ...common, kind: 'note', title: String(data.title || heading || base).slice(0, 300), text: body, hash: sha(buf),
      occurredAt: Number.isFinite(dated) ? dated : common.occurredAt,
      uri: this.source.kind === 'obsidian' ? `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(rel.replace(/\.(md|markdown)$/i, ''))}` : '',
      meta: { ...common.meta, tags, links },
    };
  }

  // Index every file, tombstone what disappeared. onProgress({ done, total }) is called now and then.
  async scan({ onProgress = null, signal = null } = {}) {
    const root = this.root();
    const files = [];
    this.walk(root, (abs, rel, st) => files.push({ abs, rel, st }));
    const known = this.items.fingerprints(this.source.id);
    const seen = new Set();
    const out = { created: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, errors: 0, total: files.length };
    let last = Date.now();
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      this.items.db.exec('BEGIN');
      try {
        for (const doc of pending) {
          const r = this.items.upsert(this.source.id, doc);
          if (r.action === 'unchanged') { this.items.setMeta(r.item.id, doc.meta); out.unchanged++; } else out[r.action === 'revived' ? 'updated' : r.action]++;
        }
        this.items.db.exec('COMMIT');
      } catch (e) { this.items.db.exec('ROLLBACK'); throw e; }
      pending = [];
    };
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'aborted' });
      const { abs, rel, st } = files[i];
      const fp = known.get(rel);
      if (fp && fp.mtime === Math.round(st.mtimeMs) && fp.size === st.size) { seen.add(rel); out.unchanged++; } else {
        try {
          const doc = await this.read(abs, rel, st, root);
          if (doc) { pending.push(doc); seen.add(rel); } else out.skipped++;
        } catch { out.errors++; }
      }
      if (pending.length >= BATCH) flush();
      if (Date.now() - last > YIELD_MS) { flush(); onProgress?.({ done: i + 1, total: files.length }); await tick(); last = Date.now(); }
    }
    flush();
    out.removed = this.items.tombstoneMissing(this.source.id, seen);
    return out;
  }

  // One path changed (from the watcher): index it, or tombstone it when it is gone.
  async syncPath(rel) {
    const root = this.root();
    const abs = path.resolve(root, rel);
    if (!inside(root, abs)) return 'ignored';
    let st = null;
    try { st = fs.statSync(abs); } catch { /* gone */ }
    if (!st) return this.items.tombstone(this.source.id, rel) ? 'removed' : 'ignored';
    if (!st.isFile() || !this.wanted(abs)) return 'ignored';
    const relParts = rel.split('/');
    if (relParts.some((p) => SKIP_DIRS.has(p) || p.startsWith('.')) || this.exclude.has(relParts.slice(0, -1).join('/'))) return 'ignored';
    const doc = await this.read(abs, rel, st, root);
    if (!doc) return this.items.tombstone(this.source.id, rel) ? 'removed' : 'ignored';
    const r = this.items.upsert(this.source.id, doc);
    if (r.action === 'unchanged') this.items.setMeta(r.item.id, doc.meta);
    return r.action;
  }

  // Watch the folder. Changes are gathered for `delay` ms, then each path is synced. onChange(summary) after each round.
  watch({ delay = 700, onChange = null, onError = null } = {}) {
    this.unwatch();
    let root;
    try { root = this.root(); } catch (e) { onError?.(e); return null; }
    let dirty = new Set();
    let full = false;
    let timer = null;
    const flush = async () => {
      timer = null;
      const paths = [...dirty]; dirty = new Set();
      const wantFull = full; full = false;
      try {
        if (wantFull) await this.scan();
        else for (const rel of paths) await this.syncPath(rel);
        onChange?.({ paths: wantFull ? null : paths });
      } catch (e) { onError?.(e); }
    };
    try {
      this.watcher = fs.watch(root, { recursive: true, persistent: false }, (evt, name) => {
        if (!name) { full = true; } else {
          const rel = String(name).split(path.sep).join('/');
          // a folder renamed or removed changes many paths at once: reconcile everything
          const abs = path.join(root, rel);
          let isDir = false; try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = !path.extname(rel); }
          if (isDir) full = true; else dirty.add(rel);
        }
        if (!timer) { timer = setTimeout(flush, delay); timer.unref?.(); }
      });
      this.watcher.on('error', (e) => onError?.(e));
    } catch (e) { onError?.(e); this.watcher = null; }
    return this.watcher;
  }

  unwatch() { try { this.watcher?.close(); } catch { /* already closed */ } this.watcher = null; }
}

module.exports = { FolderConnector };
