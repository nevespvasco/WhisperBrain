'use strict';
// The Inbox: everything that wants a person's decision, in one list. Suggestions the AI found (with the words they rest on), people
// who may be the same, commitments that are overdue (yours, and others' to you), and reminders that came due. Calm by construction:
// nothing here pings; the count is what shows in the menu.
const DAY = 86_400_000;
const NOREPLY_MIN_DAYS = 3, NOREPLY_MAX_DAYS = 30;

class Inbox {
  constructor({ notes, assertions, entities, reminders, items = null, db = null, actions = null, now = () => Date.now() }) { Object.assign(this, { notes, assertions, entities, reminders, items, db, actions, now }); }

  dismissKey(itemId, lastAt) { return `dismiss:noreply:${itemId}:${lastAt}`; }

  // E-mail threads where YOU wrote last, asked something, and nobody answered for 3 to 30 days. Precision first: a thread you ended with a
  // statement, or one that is older, is not nagged about. Dismissing one silences it until somebody writes again.
  noReply() {
    if (!this.items || !this.db) return [];
    const now = this.now();
    const out = [];
    for (const it of this.db.prepare("SELECT id, title, uri, meta, source_id FROM items WHERE kind = 'email' AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 400").all()) {
      let m; try { m = JSON.parse(it.meta); } catch { continue; }
      if (!m.lastFromMe || !m.lastAsksSomething || !m.lastAt) continue;
      const days = (now - m.lastAt) / DAY;
      if (days < NOREPLY_MIN_DAYS || days > NOREPLY_MAX_DAYS) continue;
      if (this.db.prepare('SELECT 1 FROM index_meta WHERE key = ?').get(this.dismissKey(it.id, m.lastAt))) continue;
      const others = (m.people || []).filter((e) => e !== m.lastFrom).slice(0, 3);
      out.push({ type: 'noreply', id: it.id, title: it.title, to: others, days: Math.floor(days), uri: it.uri, lastAt: m.lastAt });
    }
    return out;
  }

  dismissNoReply(itemId) {
    const it = this.db.prepare('SELECT meta FROM items WHERE id = ?').get(itemId);
    if (!it) throw Object.assign(new Error('not found'), { status: 404 });
    const m = JSON.parse(it.meta || '{}');
    this.db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)').run(this.dismissKey(itemId, m.lastAt), '1');
  }

  source(a) { const n = a.noteId ? this.notes.get(a.noteId) : null; return { noteId: a.noteId, segmentId: a.segmentId, startMs: a.startMs, title: n?.title || '', at: a.occurredAt }; }

  cards() {
    const out = [];
    for (const a of this.assertions.list({ state: 'suggested', limit: 100 })) out.push({ type: 'suggestion', id: a.id, kind: a.kind, text: a.text, quote: a.quote, speaker: a.speaker, owner: a.owner.name, to: a.to.name, dueText: a.dueText, dueAt: a.dueAt, source: this.source(a) });
    const open = this.assertions.open();
    for (const a of open.overdueMine) out.push({ type: 'overdue', id: a.id, text: a.text, owner: a.owner.name, dueAt: a.dueAt, dueText: a.dueText, source: this.source(a) });
    for (const a of open.overdueTheirs) out.push({ type: 'waiting', id: a.id, text: a.text, owner: a.owner.name || a.speaker, dueAt: a.dueAt, dueText: a.dueText, source: this.source(a) });
    for (const r of this.reminders.pending()) if (!r.assertionId || !open.overdueMine.some((a) => a.id === r.assertionId)) out.push({ type: 'reminder', id: r.id, text: r.text, dueAt: r.dueAt, assertionId: r.assertionId });
    for (const a of this.actions?.pending() || []) out.push({ type: 'action', id: a.id, kind: a.kind, title: a.title, args: a.args });
    out.push(...this.noReply());
    for (const p of this.entities.proposals().slice(0, 5)) out.push({ type: 'merge', id: p.id, a: p.a, b: p.b, reason: p.reason });
    return out;
  }

  counts() {
    const c = this.cards();
    const by = (t) => c.filter((x) => x.type === t).length;
    return { total: c.length, suggestions: by('suggestion'), overdue: by('overdue'), waiting: by('waiting'), reminders: by('reminder'), merges: by('merge'), noreply: by('noreply'), actions: by('action') };
  }
}

module.exports = { Inbox };
