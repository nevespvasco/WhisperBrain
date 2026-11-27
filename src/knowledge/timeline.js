'use strict';
// One line of events per person or project, newest first, joining what is kept in different places: meetings, mail, chat messages, issues,
// notes. "What did X say about Y across mail, meetings and Slack" starts from here. Only what the grants let the person see is listed
// (they are the one looking, so this is about the sources they switched off or revoked, and about metadata-only ones, which show who and
// when but no text). Related mail on a meeting page is attendees' mail plus what the search index finds for the meeting's words, minus
// what the person unlinked, plus what they linked by hand.
const KIND_LABEL = { email: 'mail', message: 'message', issue: 'issue', document: 'note' };

class Timeline {
  constructor({ db, notes, entities, items, projects = null, index = null, allow = () => true }) { Object.assign(this, { db, notes, entities, items, projects, index, allow }); }

  sourceName(id) { return this.items.source(id)?.name || ''; }

  itemEntry(it) {
    return { type: KIND_LABEL[it.kind] || 'note', id: it.id, title: it.title || '(no title)', at: it.at ?? it.occurredAt, uri: it.uri || '', sourceId: it.sourceId, sourceName: this.sourceName(it.sourceId), role: it.role || undefined };
  }

  // allowed(sourceId): is this source on (not revoked or expired)?
  visible(sourceId) { const s = this.items.source(sourceId); return !!s && s.enabled && s.readLevel !== 'none' && (s.expiresAt == null || s.expiresAt > Date.now()); }

  person(entityId, { limit = 40 } = {}) {
    const meetings = this.entities.noteIds(entityId).map((nid) => this.notes.get(nid)).filter(Boolean).map((n) => ({ type: 'meeting', id: n.id, title: n.title || '(untitled)', at: n.startedAt || n.createdAt }));
    const mail = this.entities.itemsOf(entityId, { limit, allow: (sid) => this.visible(sid) }).map((it) => this.itemEntry(it));
    const all = [...meetings, ...mail].sort((a, b) => b.at - a.at);
    return { entries: all.slice(0, limit), lastContact: all[0]?.at || null, meetings: meetings.length, mail: mail.length };
  }

  project(id, { limit = 60 } = {}) {
    if (!this.projects) return { entries: [] };
    const p = this.projects.page(id);
    const entries = [
      ...p.meetings.map((n) => ({ type: 'meeting', id: n.id, title: n.title || '(untitled)', at: n.startedAt || n.createdAt })),
      ...p.docs.filter((d) => this.visible(d.sourceId)).map((d) => this.itemEntry(d)),
    ].sort((a, b) => b.at - a.at);
    return { entries: entries.slice(0, limit) };
  }

  // Related mail and messages of a meeting: the attendees' (and speakers') mail, and what the index finds for its title and topics.
  async related(noteId, { limit = 8 } = {}) {
    const note = this.notes.get(noteId);
    if (!note) return [];
    const state = new Map(this.db.prepare('SELECT item_id, state FROM item_links WHERE note_id = ?').all(noteId).map((r) => [r.item_id, r.state]));
    const out = new Map();
    const add = (it, why) => { if (it && !out.has(it.id) && this.visible(it.sourceId) && state.get(it.id) !== 'unlinked') out.set(it.id, { ...this.itemEntry(it), why, linked: state.get(it.id) === 'linked' }); };
    for (const [id] of [...state].filter(([, v]) => v === 'linked')) { const it = this.items.item(id); if (it && !it.deletedAt) add(it, 'linked'); }
    // the invitation mail of this very event (its calendar UID is in the mail)
    if (note.eventUid) for (const r of this.db.prepare("SELECT id FROM items WHERE kind = 'email' AND deleted_at IS NULL AND json_extract(meta, '$.invite.uid') = ? LIMIT 3").all(note.eventUid)) add(this.items.item(r.id), 'invite');
    const people = this.db.prepare("SELECT DISTINCT entity_id FROM mentions WHERE note_id = ? AND role IN ('attendee', 'speaker')").all(noteId).map((r) => r.entity_id);
    for (const e of people) for (const it of this.entities.itemsOf(e, { limit: 4, allow: (sid) => this.visible(sid) })) add(it, 'attendee');
    if (this.index && note.title) {
      try { for (const h of await this.index.search(note.title, { limit: 6, allow: (k, id) => k === 'item' && this.allow(k, id) })) if (h.kind === 'item') add(this.items.item(h.id), 'topic'); } catch { /* words still found the people's mail */ }
    }
    return [...out.values()].sort((a, b) => (b.linked - a.linked) || (b.at - a.at)).slice(0, limit);
  }

  // The person's own yes or no on one related item: 'linked' | 'unlinked' | null (back to automatic)
  setLink(noteId, itemId, state) {
    if (state === null) { this.db.prepare('DELETE FROM item_links WHERE note_id = ? AND item_id = ?').run(noteId, itemId); return true; }
    if (!['linked', 'unlinked'].includes(state)) throw Object.assign(new Error('state must be linked, unlinked or null'), { status: 400 });
    this.db.prepare('INSERT INTO item_links (note_id, item_id, state) VALUES (?, ?, ?) ON CONFLICT (note_id, item_id) DO UPDATE SET state = excluded.state').run(noteId, itemId, state);
    return true;
  }
}

module.exports = { Timeline };
