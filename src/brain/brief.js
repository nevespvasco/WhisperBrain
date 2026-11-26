'use strict';
// The brief before a meeting: who is coming, when you last met, what you owe them and they owe you, what was decided in meetings with
// them, and the notes that match the meeting's title. Built from what is already known, with no AI in the middle, so every line is a
// fact with a place to open it: a brief that cannot be wrong is worth more than one that reads well.
const BRIEF_NOTES = 3;

class Briefs {
  constructor({ notes, entities, assertions, index, mayShare = () => true }) { Object.assign(this, { notes, entities, assertions, index, mayShare }); }

  source(a) {
    const n = a.noteId ? this.notes.get(a.noteId) : null;
    return { noteId: a.noteId, segmentId: a.segmentId, startMs: a.startMs, title: n?.title || '', at: a.occurredAt };
  }

  // event: { title, start, attendees: [{ name, email }] }
  async build(event) {
    this.entities.refresh();
    const people = [];
    const ids = new Set();
    for (const a of event.attendees || []) {
      const id = this.entities.resolve({ name: a.name || String(a.email || '').split('@')[0], email: a.email, create: false });
      if (id && !ids.has(id)) ids.add(id);
    }
    const me = this.assertions.meId();
    const noteIds = new Set();
    for (const id of ids) {
      if (id === me) continue;
      const mine = this.entities.noteIds(id);
      mine.forEach((n) => noteIds.add(n));
      const list = mine.map((nid) => this.notes.get(nid)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
      const s = this.entities.summary(id);
      people.push({ id, name: s.name, key: s.key, meetings: list.length, last: list[0] ? { id: list[0].id, title: list[0].title, at: list[0].startedAt || list[0].createdAt } : null });
    }
    const them = new Set(people.map((p) => p.id));
    const open = this.assertions.list({ state: 'accepted', kind: 'commitment', limit: 500 });
    const withSource = (a) => ({ ...a, source: this.source(a) });
    const owe = open.filter((a) => me && a.owner.id === me && (noteIds.has(a.noteId) || them.has(a.to.id))).map(withSource);
    const waiting = open.filter((a) => them.has(a.owner.id)).map(withSource);
    const decisions = this.assertions.list({ state: 'accepted', kind: 'decision', limit: 200 }).filter((a) => noteIds.has(a.noteId)).slice(0, 5).map(withSource);
    let related = [];
    if (event.title && this.index) {
      const hits = await this.index.search(event.title, { limit: BRIEF_NOTES + 4, allow: this.mayShare });
      related = hits.filter((h) => h.kind === 'item' || !noteIds.size || h.kind === 'note').slice(0, BRIEF_NOTES).map((h) => ({ kind: h.kind === 'note' ? 'meeting' : 'item', id: h.id, title: h.title, text: h.text.slice(0, 200), segmentId: h.segmentId, uri: h.uri }));
    }
    const unknown = (event.attendees || []).length - ids.size;
    return { title: event.title || '', start: event.start || null, people, owe, waiting, decisions, related, unknown, empty: !people.length && !owe.length && !waiting.length && !decisions.length && !related.length };
  }
}

module.exports = { Briefs };
