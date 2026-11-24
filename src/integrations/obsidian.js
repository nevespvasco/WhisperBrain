'use strict';
// Obsidian export/import: plain Markdown files in a vault folder. Every path is confined to the vault.
const fs = require('node:fs');
const path = require('node:path');
const { meetingToMarkdown, slugFileName, meetingDate } = require('./format');

const HEAD_BYTES = 8192; // frontmatter / first heading live near the top
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

// ---------- frontmatter ----------

function scalar(raw) {
  let s = String(raw).trim();
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.replace(/^"|"$/g, ''); } }
  if (s.startsWith("'")) return s.replace(/^'|'$/g, '').replace(/''/g, "'");
  s = s.replace(/\s+#.*$/, ''); // trailing comment
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^(null|~)?$/i.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return s;
}

function inlineList(s) {
  const inner = s.trim().slice(1, -1);
  const out = [];
  let cur = '', q = null;
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; } else if (ch === '"' || ch === "'") { q = ch; cur += ch; } else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '').map(scalar);
}

function parseFrontmatter(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const m = t.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/) || t.match(/^---[ \t]*\r?\n()(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: t };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*)$/) || line.match(/^\s*-$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      if (item[1] !== undefined && item[1].trim()) data[key].push(scalar(item[1]));
      continue;
    }
    const kv = line.match(/^([^\s:#][^:]*?):(?:\s+(.*)|\s*)$/);
    if (!kv || /^\s/.test(line)) continue; // nested maps are not supported
    key = kv[1].trim();
    const v = (kv[2] || '').trim();
    data[key] = v.startsWith('[') && v.endsWith(']') ? inlineList(v) : scalar(v);
  }
  return { data, body: t.slice(m[0].length).replace(/^\r?\n/, '') };
}

// ---------- vault ----------

const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const toRel = (root, p) => path.relative(root, p).split(path.sep).join('/');

class ObsidianVault {
  constructor({ vaultPath, folder = 'Meetings', transcript = true } = {}) {
    Object.assign(this, { vaultPath, folder: folder ?? '', transcript });
  }

  root() {
    const p = String(this.vaultPath || '').trim();
    if (!p) throw new Error('No Obsidian vault is set. Choose your vault folder in Settings → Integrations.');
    let st;
    try { st = fs.statSync(p); } catch { throw new Error(`The Obsidian vault folder does not exist: ${p}`); }
    if (!st.isDirectory()) throw new Error(`The Obsidian vault path is not a folder: ${p}`);
    return fs.realpathSync(path.resolve(p));
  }

  // Vault-relative path → absolute path, refusing anything that escapes the vault (.., absolute, symlinks).
  resolve(relPath, root = this.root()) {
    const rel = String(relPath ?? '');
    if (rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\')) throw new Error(`Path must be inside the vault: ${rel}`);
    const abs = path.resolve(root, rel);
    if (!inside(root, abs)) throw new Error(`Path must be inside the vault: ${rel}`);
    // Follow symlinks on the deepest existing ancestor.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { throw new Error(`Path must be inside the vault: ${rel}`); }
    if (!inside(root, real)) throw new Error(`Path must be inside the vault: ${rel}`);
    return abs;
  }

  // Markdown files under a directory: [{ abs, stat }] (does not follow symlinks).
  walk(dir) {
    const out = [];
    const visit = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(abs); } else if (e.isFile() && /\.md$/i.test(e.name)) {
          try { out.push({ abs, stat: fs.statSync(abs) }); } catch { /* vanished */ }
        }
      }
    };
    visit(dir);
    return out;
  }

  head(abs) {
    const fd = fs.openSync(abs, 'r');
    try { const buf = Buffer.alloc(HEAD_BYTES); return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)); } finally { fs.closeSync(fd); }
  }

  check() {
    const root = this.root();
    const dir = this.resolve(this.folder, root);
    return { ok: true, isVault: fs.existsSync(path.join(root, '.obsidian')), path: root, notes: fs.existsSync(dir) ? this.walk(dir).length : 0 };
  }

  // The note previously exported for this meeting (by whisperbrain_id in its frontmatter), if any.
  findById(dir, id) {
    if (id == null || id === '' || !fs.existsSync(dir)) return null;
    for (const { abs } of this.walk(dir)) {
      const h = this.head(abs);
      if (!h.includes('whisperbrain_id')) continue;
      const { data } = parseFrontmatter(h);
      if (data.whisperbrain_id != null && String(data.whisperbrain_id) === String(id)) return abs;
    }
    return null;
  }

  writeNote(meeting) {
    const root = this.root();
    const dir = this.resolve(this.folder, root);
    fs.mkdirSync(dir, { recursive: true });
    this.resolve(toRel(root, dir), root); // re-check now that it exists (symlinked folder)
    let file = this.findById(dir, meeting?.id);
    if (!file) {
      const name = slugFileName(meeting?.title, meetingDate(meeting || {}));
      const base = name.replace(/\.md$/, '');
      file = path.join(dir, name);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).md`);
    }
    const relPath = toRel(root, this.resolve(toRel(root, file), root));
    const md = meetingToMarkdown(meeting, { frontmatter: true, wikilinks: true, transcript: this.transcript });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, md);
    fs.renameSync(tmp, file);
    const uri = `obsidian://open?vault=${encodeURIComponent(path.basename(root))}&file=${encodeURIComponent(relPath.replace(/\.md$/i, ''))}`;
    return { path: file, relPath, uri };
  }

  titleOf(text, relPath) {
    const { data, body } = parseFrontmatter(text);
    if (data.title != null && String(data.title).trim()) return String(data.title).trim();
    const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
    return h1 ? h1[1] : path.posix.basename(relPath).replace(/\.md$/i, '');
  }

  listNotes({ folder = this.folder, limit = 200, query } = {}) {
    const root = this.root();
    const dir = this.resolve(folder || '', root);
    if (!fs.existsSync(dir)) return [];
    const files = this.walk(dir).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const { abs, stat } of files) {
      if (out.length >= limit) break;
      const relPath = toRel(root, abs);
      let title;
      try { title = this.titleOf(this.head(abs), relPath); } catch { continue; }
      if (q && !relPath.toLowerCase().includes(q) && !title.toLowerCase().includes(q)) continue;
      out.push({ relPath, title, mtime: stat.mtimeMs, size: stat.size });
    }
    return out;
  }

  readNote(relPath) {
    const root = this.root();
    if (!/\.md$/i.test(String(relPath || ''))) throw new Error('Only Markdown (.md) notes can be read');
    const abs = this.resolve(relPath, root);
    let text, stat;
    try { text = fs.readFileSync(abs, 'utf8'); stat = fs.statSync(abs); } catch { throw new Error(`Note not found: ${relPath}`); }
    const { data, body } = parseFrontmatter(text);
    return { relPath: toRel(root, abs), title: this.titleOf(text, toRel(root, abs)), frontmatter: data, body, mtime: stat.mtimeMs };
  }
}

module.exports = { ObsidianVault, parseFrontmatter };
