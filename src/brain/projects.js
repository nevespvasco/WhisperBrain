'use strict';
// Projects: a name and the words that belong to it. Everything that mentions those words, or sits in the project's space, belongs to it:
// meetings, notes from folders, and the decisions and promises taken from those meetings. It is worked out when the project is looked at,
// so nothing has to be filed by hand. A project that has open promises and has been quiet for 3 weeks is offered in the Inbox.
const crypto = require('node:crypto');

const DAY = 86_400_000;
const IDLE_DAYS = 21;
const newId = () => `pr_${crypto.randomBytes(6).toString('hex')}`;
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[,\n]+/)).map((k) => String(k).trim()).filter(Boolean))].slice(0, 20);
const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };
const row = (r) => r && ({ id: r.id, name: r.name, keywords: parse(r.keywords), spaceId: r.space_id, archived: !!r.archived, createdAt: r.created_at });

class Projects {
  constructor({ db, notes, items, assertions, now = () => Date.now() }) { Object.assign(this, { db, notes, items, assertions, now }); }

  create({ name, keywords, spaceId = null }) {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw err('A project needs a name.');
    const kw = clean(keywords && clean(keywords).length ? keywords : [n]);
    const id = newId(), t = this.now();
    this.db.prepare('INSERT INTO projects (id, name, keywords, space_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, n, JSON.stringify(kw), spaceId || null, t, t);
    return this.get(id);
  }

  update(id, { name, keywords, spaceId, archived }) {
    const p = this.get(id);
    if (!p) throw err('not found', 404);
    const sets = [], vals = [];
    if (name !== undefined) { const n = String(name).trim().slice(0, 80); if (!n) throw err('A project needs a name.'); sets.push('name = ?'); vals.push(n); }
    if (keywords !== undefined) { const kw = clean(keywords); if (!kw.length) throw err('Give at least one word that belongs to it.'); sets.push('keywords = ?'); vals.push(JSON.stringify(kw)); }
    if (spaceId !== undefined) { sets.push('space_id = ?'); vals.push(spaceId || null); }
    if (archived !== undefined) { sets.push('archived = ?'); vals.push(archived ? 1 : 0); }
    if (sets.length) this.db.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
    return this.get(id);
  }

  remove(id) { return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0; }
  get(id) { return row(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)); }
  rows(archived = false) { return this.db.prepare('SELECT * FROM projects WHERE archived = ? ORDER BY name COLLATE NOCASE').all(archived ? 1 : 0).map(row); }

  // What belongs to a project right now. shared: one object passed for several projects, so the accepted decisions and promises are
  // read once for all of them (the Inbox checks every project on each load), not twice per project.
  members(p, shared = {}) {
    const q = p.keywords.join(' ');
    const meetings = new Map();
    for (const h of this.notes.search(q, 100, { any: true })) meetings.set(h.note.id, h.note);
    if (p.spaceId) for (const n of this.notes.list({ folderId: p.spaceId, limit: 200 })) meetings.set(n.id, n);
    const list = [...meetings.values()].sort((a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt));
    const seen = new Map();
    for (const k of p.keywords) for (const it of this.items.list({ q: k, limit: 30 })) seen.set(it.id, it);
    const docs = [...seen.values()].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 30);
    const ids = new Set(list.map((n) => n.id));
    const fromHere = (a) => ids.has(a.noteId);
    shared.decisions ??= this.assertions.list({ state: ['accepted', 'superseded'], kind: 'decision', limit: 300 });
    shared.promises ??= this.assertions.list({ state: 'accepted', kind: 'commitment', limit: 300 });
    const decisions = shared.decisions.filter(fromHere);
    const promises = shared.promises.filter(fromHere);
    const lastAt = Math.max(0, ...list.map((n) => n.startedAt || n.createdAt), ...docs.map((d) => d.occurredAt));
    return { meetings: list, docs, decisions, promises, lastAt };
  }

  page(id) {
    const p = this.get(id);
    if (!p) throw err('not found', 404);
    return { ...p, ...this.members(p), idleDays: null };
  }

  summary() {
    const shared = {};
    return this.rows().map((p) => { const m = this.members(p, shared); return { ...p, meetings: m.meetings.length, docs: m.docs.length, openPromises: m.promises.length, lastAt: m.lastAt }; });
  }

  // projects with open promises and no activity for 3 weeks
  idle(dismissed = () => false) {
    const out = [], shared = {};
    for (const p of this.rows()) {
      const m = this.members(p, shared);
      if (!m.promises.length || !m.lastAt) continue;
      const days = Math.floor((this.now() - m.lastAt) / DAY);
      if (days < IDLE_DAYS || dismissed(p, m.lastAt)) continue;
      out.push({ id: p.id, name: p.name, days, open: m.promises.length, lastAt: m.lastAt });
    }
    return out;
  }
}

module.exports = { Projects, IDLE_DAYS };
