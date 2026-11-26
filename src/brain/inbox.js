'use strict';
// The Inbox: everything that wants a person's decision, in one list. Suggestions the AI found (with the words they rest on), people
// who may be the same, commitments that are overdue (yours, and others' to you), and reminders that came due. Calm by construction:
// nothing here pings; the count is what shows in the menu.
class Inbox {
  constructor({ notes, assertions, entities, reminders }) { Object.assign(this, { notes, assertions, entities, reminders }); }

  source(a) { const n = a.noteId ? this.notes.get(a.noteId) : null; return { noteId: a.noteId, segmentId: a.segmentId, startMs: a.startMs, title: n?.title || '', at: a.occurredAt }; }

  cards() {
    const out = [];
    for (const a of this.assertions.list({ state: 'suggested', limit: 100 })) out.push({ type: 'suggestion', id: a.id, kind: a.kind, text: a.text, quote: a.quote, speaker: a.speaker, owner: a.owner.name, to: a.to.name, dueText: a.dueText, dueAt: a.dueAt, source: this.source(a) });
    const open = this.assertions.open();
    for (const a of open.overdueMine) out.push({ type: 'overdue', id: a.id, text: a.text, owner: a.owner.name, dueAt: a.dueAt, dueText: a.dueText, source: this.source(a) });
    for (const a of open.overdueTheirs) out.push({ type: 'waiting', id: a.id, text: a.text, owner: a.owner.name || a.speaker, dueAt: a.dueAt, dueText: a.dueText, source: this.source(a) });
    for (const r of this.reminders.pending()) if (!r.assertionId || !open.overdueMine.some((a) => a.id === r.assertionId)) out.push({ type: 'reminder', id: r.id, text: r.text, dueAt: r.dueAt, assertionId: r.assertionId });
    for (const p of this.entities.proposals().slice(0, 5)) out.push({ type: 'merge', id: p.id, a: p.a, b: p.b, reason: p.reason });
    return out;
  }

  counts() {
    const c = this.cards();
    const by = (t) => c.filter((x) => x.type === t).length;
    return { total: c.length, suggestions: by('suggestion'), overdue: by('overdue'), waiting: by('waiting'), reminders: by('reminder'), merges: by('merge') };
  }
}

module.exports = { Inbox };
