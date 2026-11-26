'use strict';
// Decisions and commitments (docs/adr/0001-brain-data-model.md, Phase 3). Everything here is a SUGGESTION until a person accepts it:
// the AI that finds one must give the exact words it rests on, those words are checked in code to be in the transcript (extract.js),
// and a dismissed one is a tombstone that is never suggested again for that meeting. A commitment has an owner (who owes it), a
// person it is for, and a date resolved in code (dates.js), never by the model.
const crypto = require('node:crypto');

const KINDS = ['decision', 'commitment'];
const newId = () => `as_${crypto.randomBytes(6).toString('hex')}`;
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const keyOf = (kind, text) => crypto.createHash('sha256').update(`${kind}:${fold(text)}`).digest('hex').slice(0, 20);
const err = (message, status = 400) => Object.assign(new Error(message), { status });

const rowOf = (fin) => (r) => r && ({
  id: r.id, kind: r.kind, text: r.text, owner: { id: r.owner_id && fin(r.owner_id), name: r.owner_name }, to: { id: r.to_id && fin(r.to_id), name: r.to_name },
  dueAt: r.due_at, dueText: r.due_text, state: r.state, origin: r.origin, noteId: r.note_id, segmentId: r.segment_id, startMs: r.start_ms,
  quote: r.quote, speaker: r.speaker, model: r.model, supersedes: r.supersedes, occurredAt: r.occurred_at, createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at,
});

class Assertions {
  constructor({ db, notes, entities, settings = null, reminders = null, bus = null, now = () => Date.now() }) {
    Object.assign(this, { db, notes, entities, settings, reminders, bus, now });
    this.row = rowOf((id) => this.entities.final(id) || id);   // a person merged into someone else is still that someone
  }

  // The person this app belongs to (their name from Settings), as an entity when they are one.
  meId() { const n = this.settings?.get('userName'); if (!n) return null; this.entities.refresh(); return this.entities.resolve({ name: n, create: false }); }

  get(id) { return this.row(this.db.prepare('SELECT * FROM assertions WHERE id = ?').get(id)); }

  // Add one. Returns { created, item }: created is false when the same thing is already there for that meeting (in any state, so a
  // dismissed one stays dismissed).
  add({ kind, text, noteId = null, segmentId = null, startMs = null, quote = '', speaker = '', owner = '', to = '', dueText = '', dueAt = null, origin = 'ai', model = '', occurredAt = null, state = null }) {
    if (!KINDS.includes(kind)) throw err('kind must be decision or commitment');
    const body = String(text || '').trim().slice(0, 400);
    if (!body) throw err('empty text');
    const key = keyOf(kind, body);
    const t = this.now();
    if (noteId) { const dup = this.db.prepare('SELECT * FROM assertions WHERE note_id = ? AND key = ?').get(noteId, key); if (dup) return { created: false, item: this.row(dup) }; }
    this.entities.refresh();   // people known so far, so the owner can be found
    const ownerId = owner ? this.entities.resolve({ name: owner, create: false }) : null;
    const toId = to ? this.entities.resolve({ name: to, create: false }) : null;
    const id = newId();
    const when = occurredAt || (noteId ? this.notes.get(noteId)?.createdAt : null) || t;
    this.db.prepare(`INSERT INTO assertions (id, kind, text, key, owner_id, owner_name, to_id, to_name, due_at, due_text, state, origin, note_id, segment_id, start_ms, quote, speaker, model, occurred_at, created_at, updated_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, body, key, ownerId, String(owner).slice(0, 80), toId, String(to).slice(0, 80), dueAt, String(dueText).slice(0, 80),
      state || (origin === 'user' ? 'accepted' : 'suggested'), origin, noteId, segmentId, startMs, String(quote).slice(0, 400), String(speaker).slice(0, 80), String(model).slice(0, 80), when, t, t, origin === 'user' ? t : null);
    this.bus?.publish('assertions.changed', { id });
    return { created: true, item: this.get(id) };
  }

  list({ state, kind, noteId, ownerId, limit = 200 } = {}) {
    const where = [], args = [];
    if (state) { const list = [].concat(state); where.push(`state IN (${list.map(() => '?').join(',')})`); args.push(...list); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (noteId) { where.push('note_id = ?'); args.push(noteId); }
    if (ownerId) { where.push('owner_id = ?'); args.push(ownerId); }
    return this.db.prepare(`SELECT * FROM assertions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC, created_at DESC LIMIT ?`).all(...args, limit).map(this.row);
  }

  counts() {
    const out = { suggested: 0, accepted: 0, done: 0, dismissed: 0, superseded: 0 };
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n FROM assertions GROUP BY state').all()) out[r.state] = r.n;
    return out;
  }

  // accept | dismiss | done | reopen. A person's choice, made once: it is what makes a suggestion count.
  decide(id, decision) {
    const a = this.get(id);
    if (!a) throw err('not found', 404);
    const next = { accept: 'accepted', dismiss: 'dismissed', done: 'done', reopen: 'accepted' }[decision];
    if (!next) throw err('decision must be accept, dismiss, done or reopen');
    if (decision === 'done' && (a.kind !== 'commitment' || a.state !== 'accepted')) throw err('only an accepted commitment can be marked done', 409);
    const t = this.now();
    this.db.prepare('UPDATE assertions SET state = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(next, t, t, id);
    if (next === 'accepted' && a.kind === 'commitment' && a.dueAt) this.reminders?.forAssertion(this.get(id));
    if (next === 'done' || next === 'dismissed') this.reminders?.closeFor(id);
    this.bus?.publish('assertions.changed', { id });
    return this.get(id);
  }

  // Fix what the AI got wrong; the quote and where it was said stay as they were.
  edit(id, patch) {
    const a = this.get(id);
    if (!a) throw err('not found', 404);
    this.entities.refresh();
    const sets = [], vals = [];
    if (patch.text !== undefined) { const x = String(patch.text).trim(); if (!x) throw err('empty text'); sets.push('text = ?'); vals.push(x.slice(0, 400)); }
    if (patch.owner !== undefined) { sets.push('owner_name = ?', 'owner_id = ?'); vals.push(String(patch.owner).slice(0, 80), patch.owner ? this.entities.resolve({ name: patch.owner, create: false }) : null); }
    if (patch.to !== undefined) { sets.push('to_name = ?', 'to_id = ?'); vals.push(String(patch.to).slice(0, 80), patch.to ? this.entities.resolve({ name: patch.to, create: false }) : null); }
    if (patch.dueAt !== undefined) { sets.push('due_at = ?'); vals.push(patch.dueAt ? Number(patch.dueAt) : null); }
    if (patch.dueText !== undefined) { sets.push('due_text = ?'); vals.push(String(patch.dueText).slice(0, 80)); }
    if (sets.length) this.db.prepare(`UPDATE assertions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
    const out = this.get(id);
    if (out.state === 'accepted' && out.kind === 'commitment') this.reminders?.forAssertion(out);
    this.bus?.publish('assertions.changed', { id });
    return out;
  }

  // A later decision replaces an earlier one: the earlier stays, marked superseded, with the way back to it.
  supersede(oldId, newId_) {
    const a = this.get(oldId), b = this.get(newId_);
    if (!a || !b) throw err('not found', 404);
    if (a.kind !== 'decision' || b.kind !== 'decision') throw err('only a decision can be superseded by a decision');
    this.db.prepare("UPDATE assertions SET state = 'superseded', updated_at = ? WHERE id = ?").run(this.now(), oldId);
    this.db.prepare('UPDATE assertions SET supersedes = ?, updated_at = ? WHERE id = ?').run(oldId, this.now(), newId_);
    this.bus?.publish('assertions.changed', { id: newId_ });
    return this.get(newId_);
  }

  // What is open, from the person's side: what they owe, and what others owe them or the meeting.
  open() {
    const me = this.meId();
    const accepted = this.list({ state: 'accepted', kind: 'commitment', limit: 500 });
    const mine = accepted.filter((a) => me && a.owner.id === me);
    const theirs = accepted.filter((a) => !(me && a.owner.id === me));
    const now = this.now();
    const overdue = (a) => a.dueAt && a.dueAt < now;
    return { mine, theirs, overdueMine: mine.filter(overdue), overdueTheirs: theirs.filter(overdue) };
  }
}

module.exports = { Assertions, keyOf, KINDS };
