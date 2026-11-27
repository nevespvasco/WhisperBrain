'use strict';
// People as entities (docs/adr/0001-brain-data-model.md). Until now a person was whatever name string showed up, worked out again on
// every request. Now a person is a row with identities: an e-mail address or a saved voice is a STRONG identifier (it says who someone
// is; so is a platform account such as discord:<user id>), a name alone is weak (two people can share one). The People pages read these rows; the API shape they return is unchanged.
//
//   resolve():   name / e-mail / voice → the entity. Strong identifiers decide. A name that already belongs to someone with a
//                DIFFERENT e-mail is not merged into them: a new entity is made and a merge is proposed for a person to decide.
//   proposals:   "same person?" cards (same voice under two names, "Ana" and "Ana Silva", same name with different e-mails).
//                A rejected proposal is a tombstone: it is never proposed again.
//   merge/undo:  merging moves the identities onto the surviving entity and records what moved, so it can be undone exactly.
//   mentions:    which meetings a person spoke in or was invited to; kept up to date from the meetings themselves (syncNote).
const crypto = require('node:crypto');
const kp = require('../knowledge/keyphrases');

const personKey = (name) => kp.fold(String(name || '').trim()).replace(/\s+/g, ' ');
const PLACEHOLDER = /^(speaker|orador|room speaker|them|me|unknown)( \d+)?$/;
const isPlaceholder = (key) => !key || PLACEHOLDER.test(key);
const normEmail = (e) => String(e || '').trim().toLowerCase();
// a platform account: 'discord:123456' (platform id, a colon, the account's id on it); anything else is no account
const normAccount = (a) => { const m = /^([a-z0-9-]{1,24}):([\w.@-]{1,120})$/i.exec(String(a || '').trim()); return m ? `${m[1].toLowerCase()}:${m[2]}` : ''; };
const newId = () => `ent_${crypto.randomBytes(6).toString('hex')}`;
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

class Entities {
  constructor({ db, settings = null, bus = null, now = () => Date.now() }) {
    this.db = db;
    this.settings = settings;
    this.bus = bus;
    this.now = now;
    this.dirty = new Set();       // notes whose people changed; synced before anyone reads people (see refresh)
    this.drainTimer = null;
  }

  // ---------- keeping mentions current ----------
  // Called for anything that can change who is in a meeting. Cheap: only remembers the note; the work happens in refresh().
  markDirty(noteId) {
    if (!noteId) return;
    this.dirty.add(noteId);
    if (!this.drainTimer) { this.drainTimer = setImmediate(() => { this.drainTimer = null; try { this.refresh(); } catch { /* a closed database: nothing to keep up to date */ } }); this.drainTimer.unref?.(); }
  }

  attach(bus = this.bus) {
    if (!bus) return () => {};
    return bus.subscribe((e) => {
      const d = e.data || {};
      if (['note.created', 'note.updated', 'recording.stopped', 'transcript.removed'].includes(e.type)) this.markDirty(d.id || d.noteId);
      else if (e.type === 'speakers.updated') this.markDirty(d.noteId);
      else if (e.type === 'note.deleted') { this.dirty.delete(d.id); this.prune(); }
    });
  }

  // Sync every note marked dirty. Reads call this first, so a list is never older than the last change.
  refresh() {
    if (!this.dirty.size) return 0;
    const ids = [...this.dirty]; this.dirty.clear();
    this.tx(() => { for (const id of ids) this.syncNote(id); });
    this.proposeMerges();
    return ids.length;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  me() { return personKey(this.settings?.get('userName') || ''); }

  // Recompute one meeting's mentions from its speakers and attendees. Idempotent.
  syncNote(noteId) {
    const n = this.db.prepare('SELECT id, attendees, created_at FROM notes WHERE id = ?').get(noteId);
    this.db.prepare('DELETE FROM mentions WHERE note_id = ?').run(noteId);
    if (!n) return;
    const meName = this.settings?.get('userName') || '';
    const ins = this.db.prepare(`INSERT INTO mentions (entity_id, note_id, role, talk_ms, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (entity_id, note_id, role) DO UPDATE SET talk_ms = talk_ms + excluded.talk_ms`);
    // The invited first: they come with an e-mail address, which is a strong identifier, so a speaker labelled with just a first
    // name in the same meeting finds the right person instead of making a second one.
    for (const a of parse(n.attendees, [])) {
      const id = this.resolve({ name: a.name || String(a.email || '').split('@')[0], email: a.email });
      if (id) ins.run(id, noteId, 'attendee', 0, n.created_at);
    }
    for (const r of this.db.prepare(`SELECT ns.speaker_id AS sid, ns.voice_id AS voiceId, ns.account AS account, COALESCE(NULLIF(ns.name, ''), v.name, '') AS name,
        (SELECT COALESCE(SUM(end_ms - start_ms), 0) FROM segments s WHERE s.note_id = ns.note_id AND s.speaker_id = ns.speaker_id) AS talkMs
      FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id WHERE ns.note_id = ? ORDER BY ns.speaker_id`).all(noteId)) {
      const name = r.name || (r.sid === 'm1' ? meName : '');
      const id = this.resolve({ name, voiceId: r.voiceId, account: r.account, createFromVoice: false });
      if (id) ins.run(id, noteId, 'speaker', r.talkMs || 0, n.created_at);
    }
  }

  // Link one mail or message to the people it is from and to. Only people WhisperBrain already knows (met in a meeting, or merged by an
  // e-mail address): a newsletter or a no-reply sender never makes a person. Idempotent.
  syncItem(itemId) {
    const it = this.db.prepare("SELECT id, kind, meta, occurred_at FROM items WHERE id = ? AND deleted_at IS NULL").get(itemId);
    this.db.prepare('DELETE FROM item_mentions WHERE item_id = ?').run(itemId);
    if (!it) return 0;
    const m = parse(it.meta, {});
    const ins = this.db.prepare('INSERT OR IGNORE INTO item_mentions (entity_id, item_id, role, at) VALUES (?, ?, ?, ?)');
    let n = 0;
    const link = (list, role) => { for (const email of (Array.isArray(list) ? list : []).slice(0, 40)) { const id = this.resolve({ email, create: false }); if (id) { ins.run(id, it.id, role, it.occurred_at); n++; } } };
    link(m.senders || (m.lastFrom ? [m.lastFrom] : []), 'from');
    link(m.recipients || (m.people || []).filter((e) => e !== m.lastFrom), 'to');
    return n;
  }

  // Items changed since `after` (a time), a batch at a time, for the job that keeps item_mentions current. -> the next `after`, or null
  backfillItems(after = 0, size = 200) {
    const rows = this.db.prepare("SELECT id, updated_at FROM items WHERE updated_at > ? AND kind = 'email' ORDER BY updated_at LIMIT ?").all(after, size);
    if (!rows.length) return null;
    this.tx(() => { for (const r of rows) this.syncItem(r.id); });
    return rows[rows.length - 1].updated_at;
  }

  // What the person has with someone, newest first, across the sources the grants allow: mail and messages (item_mentions) as a list
  // of { id, kind, title, at, role, sourceId, uri }. `allow(sourceId)` filters by access.
  itemsOf(entityId, { limit = 30, allow = () => true } = {}) {
    const ids = [entityId, ...this.db.prepare('SELECT id FROM entities WHERE merged_into = ?').all(entityId).map((r) => r.id)];
    const rows = this.db.prepare(`SELECT i.id, i.kind, i.title, i.occurred_at AS at, i.source_id AS sourceId, i.uri, MIN(m.role) AS role FROM item_mentions m JOIN items i ON i.id = m.item_id
      WHERE m.entity_id IN (${ids.map(() => '?').join(',')}) AND i.deleted_at IS NULL GROUP BY i.id ORDER BY i.occurred_at DESC LIMIT ?`).all(...ids, limit * 3);
    return rows.filter((r) => allow(r.sourceId)).slice(0, limit);
  }

  // Forget a person: their one-to-one mail is deleted, every address of theirs is blocked from being read again, their identities and
  // what links them to mail go. Meetings they were in stay (they are the person's own record); the count is returned so it can be said.
  // -> { items, addresses, meetings }
  forget(entityId, { items = null } = {}) {
    const id = this.final(entityId) || entityId;
    const ent = this.db.prepare('SELECT id FROM entities WHERE id = ?').get(id);
    if (!ent) throw err('person not found', 404);
    const emails = this.emailsOf(id);
    let purged = 0;
    for (const r of this.db.prepare('SELECT DISTINCT item_id AS id FROM item_mentions WHERE entity_id = ?').all(id)) {
      const row = this.db.prepare('SELECT meta FROM items WHERE id = ?').get(r.id);
      const people = (parse(row?.meta, {}).people || []).filter((e) => !emails.includes(e));
      if (people.length <= 1) { if (items?.purgeItem?.(r.id)) purged++; }        // a thread with them and (at most) one other: theirs to forget
    }
    const meetings = this.noteIds(id).length;
    this.tx(() => {
      for (const e of emails) this.db.prepare('INSERT OR IGNORE INTO blocked_addresses (address, created_at) VALUES (?, ?)').run(e, this.now());
      this.db.prepare('DELETE FROM item_mentions WHERE entity_id = ?').run(id);
      this.db.prepare("DELETE FROM entity_identities WHERE entity_id = ? AND kind IN ('email', 'account')").run(id);
    });
    this.bus?.publish('people.changed', { id });
    return { items: purged, addresses: emails.length, meetings };
  }

  // Every meeting that is not yet reflected (for the start-up job): the next batch after `after` (a rowid), or null when done.
  backfillBatch(after = 0, size = 100) {
    const rows = this.db.prepare(`SELECT rowid AS rid, id FROM notes n WHERE rowid > ? AND (n.attendees <> '[]' OR EXISTS (SELECT 1 FROM note_speakers s WHERE s.note_id = n.id))
      AND NOT EXISTS (SELECT 1 FROM mentions m WHERE m.note_id = n.id) ORDER BY rowid LIMIT ?`).all(after, size);
    if (!rows.length) return null;
    this.tx(() => { for (const r of rows) this.syncNote(r.id); });
    this.proposeMerges();
    return rows[rows.length - 1].rid;
  }

  // ---------- resolving ----------
  final(id) {
    let cur = id, hops = 0;
    for (;;) {
      const r = this.db.prepare('SELECT merged_into FROM entities WHERE id = ?').get(cur);
      if (!r || !r.merged_into || ++hops > 20) return r ? cur : null;
      cur = r.merged_into;
    }
  }

  byIdentity(kind, value) {
    if (!value) return null;
    const r = this.db.prepare('SELECT entity_id FROM entity_identities WHERE kind = ? AND value = ?').get(kind, value);
    return r ? this.final(r.entity_id) : null;
  }

  accountsOf(id) { return this.db.prepare("SELECT value FROM entity_identities WHERE entity_id = ? AND kind = 'account'").all(id).map((r) => r.value); }

  emailsOf(id) { return this.db.prepare("SELECT value FROM entity_identities WHERE entity_id = ? AND kind = 'email'").all(id).map((r) => r.value); }

  addIdentity(entityId, kind, value) {
    if (!value) return false;
    return this.db.prepare('INSERT OR IGNORE INTO entity_identities (entity_id, kind, value, created_at) VALUES (?, ?, ?, ?)').run(entityId, kind, value, this.now()).changes > 0;
  }

  // The entity for a name / e-mail / voice, made when new (unless create is false). null when there is nothing to go on.
  // createFromVoice: a voice with no name never makes a person; it only finds one that has it.
  resolve({ name = '', email = '', voiceId = '', account = '', create = true, createFromVoice = true } = {}) {
    const key = isPlaceholder(personKey(name)) ? '' : personKey(name);
    const mail = normEmail(email).includes('@') ? normEmail(email) : '';
    const acct = normAccount(account);
    const byAccount = this.byIdentity('account', acct);
    const byEmail = this.byIdentity('email', mail);
    const byVoice = this.byIdentity('voice', voiceId || '');
    const byName = key ? this.byIdentity('name', key) : null;
    let ent = null;

    if (byAccount) {
      ent = byAccount;                                                   // so does a platform account: a new display name is just another name of the same person
      if (byEmail && byEmail !== ent) this.propose(ent, byEmail, 'the same account and e-mail on two people', 0.9);
      if (byName && byName !== ent) this.propose(ent, byName, 'same name, different people on record', 0.55);
    } else if (byEmail) {
      ent = byEmail;                                                     // an e-mail address says who it is
      if (byName && byName !== ent) this.propose(ent, byName, 'same name, different people on record', 0.55);
    } else if (byName) {
      const theirs = this.emailsOf(byName), theirAccounts = this.accountsOf(byName);
      const otherMail = mail && theirs.length && !theirs.includes(mail), otherAccount = acct && theirAccounts.length && !theirAccounts.includes(acct);
      if (otherMail || otherAccount) {                                    // same name, another e-mail or account: not merged on a name alone
        if (!create) return null;
        ent = this.make(name, key);
        this.propose(byName, ent, otherAccount ? 'same name, different account' : 'same name, different e-mail', 0.6);
      } else ent = byName;
    } else if (byVoice && !key) {
      ent = byVoice;
    } else if (key) {
      if (!create) return null;
      ent = this.make(name, key);
    } else if (mail) {
      if (!create) return null;
      ent = this.make(String(email).split('@')[0], '');
    } else return byVoice || null;

    if (!ent) return null;
    if (mail) this.addIdentity(ent, 'email', mail);
    if (acct) this.addIdentity(ent, 'account', acct);
    if (key) this.addIdentity(ent, 'name', key);
    if (voiceId) {
      if (byVoice && byVoice !== ent) this.propose(ent, byVoice, 'the same voice under two names', 0.9);
      else this.addIdentity(ent, 'voice', voiceId);
    }
    return ent;
  }

  // a new person: its URL key is its name key, made unique if another entity already has it
  make(name, key) {
    const base = key || personKey(name) || 'person';
    let k = base, n = 1;
    while (this.db.prepare('SELECT 1 FROM entities WHERE key = ?').get(k)) k = `${base}~${++n}`;
    const id = newId(), t = this.now();
    this.db.prepare("INSERT INTO entities (id, kind, name, key, created_at, updated_at) VALUES (?, 'person', ?, ?, ?, ?)").run(id, String(name).trim().slice(0, 120) || base, k, t, t);
    return id;
  }

  // ---------- proposals ----------
  propose(a, b, reason, score = 0.5) {
    if (!a || !b || a === b) return null;
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db.prepare('INSERT OR IGNORE INTO entity_proposals (a_id, b_id, reason, score, created_at) VALUES (?, ?, ?, ?, ?)').run(x, y, reason, score, this.now());
    return this.db.prepare('SELECT * FROM entity_proposals WHERE a_id = ? AND b_id = ?').get(x, y);
  }

  // "Ana" next to "Ana Silva": a one-word person whose name starts a longer name. A suggestion only, never a merge.
  proposeMerges() {
    const rows = this.db.prepare('SELECT id, key FROM entities WHERE merged_into IS NULL').all();
    const single = rows.filter((r) => !r.key.includes(' ') && !r.key.includes('~'));
    for (const s of single) {
      const longer = rows.filter((r) => r.key.startsWith(`${s.key} `));
      if (longer.length && longer.length <= 3) for (const l of longer) this.propose(s.id, l.id, 'a first name that matches', 0.45);
    }
  }

  summary(id) {
    const e = this.db.prepare('SELECT id, name, key FROM entities WHERE id = ?').get(id);
    if (!e) return null;
    const m = this.db.prepare('SELECT COUNT(DISTINCT note_id) AS meetings, MAX(at) AS lastAt FROM mentions WHERE entity_id = ?').get(id);
    return { id: e.id, name: e.name, key: e.key, emails: this.emailsOf(id), meetings: m.meetings, lastAt: m.lastAt || 0 };
  }

  // Open proposals whose two sides are both still live people.
  proposals() {
    this.refresh();
    return this.db.prepare(`SELECT p.* FROM entity_proposals p JOIN entities a ON a.id = p.a_id JOIN entities b ON b.id = p.b_id
      WHERE p.state = 'open' AND a.merged_into IS NULL AND b.merged_into IS NULL ORDER BY p.score DESC, p.id`).all()
      .map((p) => ({ id: p.id, reason: p.reason, score: p.score, a: this.summary(p.a_id), b: this.summary(p.b_id) }))
      .filter((p) => p.a.meetings || p.b.meetings);
  }

  // accept: merge the two (the one in more meetings survives); reject: remembered, never proposed again
  decide(proposalId, decision) {
    const p = this.db.prepare('SELECT * FROM entity_proposals WHERE id = ?').get(proposalId);
    if (!p) throw err('proposal not found', 404);
    if (decision === 'reject') {
      this.db.prepare("UPDATE entity_proposals SET state = 'rejected', decided_at = ? WHERE id = ?").run(this.now(), proposalId);
      return { state: 'rejected' };
    }
    if (decision !== 'accept') throw err('decision must be accept or reject');
    const a = this.summary(p.a_id), b = this.summary(p.b_id);
    const [keep, drop] = (b.meetings > a.meetings) ? [b, a] : [a, b];
    const out = this.merge(drop.id, keep.id);
    return { state: 'accepted', ...out };
  }

  // ---------- merging ----------
  // Everything `fromId` is (its identities) becomes `intoId`'s. What moved is recorded so unmerge() can put it back.
  merge(fromId, intoId) {
    if (fromId === intoId) throw err('cannot merge a person into themselves');
    const from = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(fromId), into = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(intoId);
    if (!from || !into) throw err('person not found', 404);
    if (from.merged_into || into.merged_into) throw err('one of them is already merged into someone else', 409);
    const noteIds = this.db.prepare('SELECT DISTINCT note_id FROM mentions WHERE entity_id IN (?, ?)').all(fromId, intoId).map((r) => r.note_id);
    return this.tx(() => {
      const moved = this.db.prepare('SELECT id FROM entity_identities WHERE entity_id = ?').all(fromId).map((r) => r.id);
      this.db.prepare('UPDATE entity_identities SET entity_id = ? WHERE entity_id = ?').run(intoId, fromId);
      this.db.prepare('UPDATE entities SET merged_into = ?, updated_at = ? WHERE id = ?').run(intoId, this.now(), fromId);
      // the fuller name is the one shown ("Ana Silva" rather than "Ana"); the URL key of the survivor stays as it was
      const words = (n) => String(n).trim().split(/\s+/).length;
      if (words(from.name) > words(into.name)) this.db.prepare('UPDATE entities SET name = ? WHERE id = ?').run(from.name, intoId);
      const info = this.db.prepare('INSERT INTO entity_merges (from_id, into_id, moved, created_at) VALUES (?, ?, ?, ?)').run(fromId, intoId, JSON.stringify({ ids: moved, intoName: into.name }), this.now());
      const [x, y] = fromId < intoId ? [fromId, intoId] : [intoId, fromId];
      this.db.prepare("UPDATE entity_proposals SET state = 'accepted', decided_at = ? WHERE a_id = ? AND b_id = ?").run(this.now(), x, y);
      this.db.prepare("DELETE FROM entity_proposals WHERE state = 'open' AND (a_id = ? OR b_id = ?)").run(fromId, fromId);
      for (const id of noteIds) this.syncNote(id);
      this.bus?.publish('people.changed', { merged: fromId, into: intoId });
      return { mergeId: Number(info.lastInsertRowid), into: this.summary(intoId) };
    });
  }

  // Put a merge back: the identities that moved return to their person, who is a person of their own again. Not proposed again.
  unmerge(fromId) {
    const m = this.db.prepare('SELECT * FROM entity_merges WHERE from_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1').get(fromId);
    if (!m) throw err('nothing to undo for this person', 404);
    const noteIds = this.db.prepare('SELECT DISTINCT note_id FROM mentions WHERE entity_id IN (?, ?)').all(m.from_id, m.into_id).map((r) => r.note_id);
    return this.tx(() => {
      const rec = parse(m.moved, []);
      const ids = Array.isArray(rec) ? rec : rec.ids || [];
      for (const id of ids) this.db.prepare('UPDATE entity_identities SET entity_id = ? WHERE id = ?').run(m.from_id, id);
      if (rec.intoName) this.db.prepare('UPDATE entities SET name = ? WHERE id = ?').run(rec.intoName, m.into_id);   // the survivor's own name comes back
      this.db.prepare('UPDATE entities SET merged_into = NULL, updated_at = ? WHERE id = ?').run(this.now(), m.from_id);
      this.db.prepare('UPDATE entity_merges SET undone_at = ? WHERE id = ?').run(this.now(), m.id);
      const [x, y] = m.from_id < m.into_id ? [m.from_id, m.into_id] : [m.into_id, m.from_id];
      this.db.prepare("INSERT INTO entity_proposals (a_id, b_id, reason, score, state, created_at, decided_at) VALUES (?, ?, 'merge undone', 0, 'rejected', ?, ?) ON CONFLICT (a_id, b_id) DO UPDATE SET state = 'rejected', decided_at = excluded.decided_at").run(x, y, this.now(), this.now());
      for (const id of noteIds) this.syncNote(id);
      this.bus?.publish('people.changed', { unmerged: fromId });
      return this.summary(m.from_id);
    });
  }

  // people nobody is in any meeting with any more (a name was corrected, a meeting deleted) are dropped, unless a merge needs them
  prune() {
    this.db.prepare(`DELETE FROM entities WHERE merged_into IS NULL AND id NOT IN (SELECT entity_id FROM mentions) AND id NOT IN (SELECT entity_id FROM item_mentions)
      AND id NOT IN (SELECT merged_into FROM entities WHERE merged_into IS NOT NULL)
      AND id NOT IN (SELECT into_id FROM entity_merges WHERE undone_at IS NULL)`).run();
  }

  // ---------- reading (the People pages) ----------
  // Same shape as before: { key, name, emails, meetings, talkMs, lastAt, isMe }, plus the id.
  list({ q } = {}) {
    this.refresh();
    this.prune();
    const me = this.me();
    const rows = this.db.prepare(`SELECT e.id, e.key, e.name, COUNT(DISTINCT m.note_id) AS meetings, COALESCE(SUM(m.talk_ms), 0) AS talkMs, MAX(m.at) AS lastAt
      FROM entities e JOIN mentions m ON m.entity_id = e.id WHERE e.merged_into IS NULL GROUP BY e.id`).all();
    const names = new Map(), emails = new Map();
    for (const r of this.db.prepare("SELECT entity_id, kind, value FROM entity_identities WHERE kind IN ('name', 'email')").all()) {
      const m = r.kind === 'name' ? names : emails;
      (m.get(r.entity_id) || m.set(r.entity_id, []).get(r.entity_id)).push(r.value);
    }
    let list = rows.map((r) => ({ id: r.id, key: r.key, name: r.name, emails: (emails.get(r.id) || []).sort(), meetings: r.meetings, talkMs: r.talkMs, lastAt: r.lastAt || 0, isMe: !!me && (names.get(r.id) || []).includes(me) }));
    if (q) { const f = personKey(q); list = list.filter((p) => p.key.includes(f) || p.emails.some((e) => e.includes(f)) || (names.get(p.id) || []).some((n) => n.includes(f))); }
    return list.sort((a, b) => b.meetings - a.meetings || b.lastAt - a.lastAt);
  }

  // A key from a URL: the entity's own key, or any name it is known by (so an old link survives a merge)
  find(key) {
    this.refresh();
    const k = personKey(key);
    const own = this.db.prepare('SELECT id FROM entities WHERE key = ?').get(String(key));
    const id = own ? this.final(own.id) : (this.byIdentity('name', k) || this.final((this.db.prepare('SELECT id FROM entities WHERE key = ?').get(k) || {}).id));
    return id || null;
  }

  noteIds(id) { return this.db.prepare('SELECT DISTINCT note_id AS id FROM mentions WHERE entity_id = ?').all(id).map((r) => r.id); }
  nameKeys(id) { return new Set(this.db.prepare("SELECT value FROM entity_identities WHERE entity_id = ? AND kind = 'name'").all(id).map((r) => r.value)); }

  // what a person page shows about who they are: identities, and who was merged into them (with the way to undo it)
  identities(id) {
    const ids = this.db.prepare('SELECT kind, value FROM entity_identities WHERE entity_id = ? ORDER BY kind, id').all(id);
    const merged = this.db.prepare(`SELECT m.from_id AS id, m.created_at AS at FROM entity_merges m WHERE m.into_id = ? AND m.undone_at IS NULL`).all(id)
      .map((m) => ({ ...(this.summary(m.id) || { id: m.id, name: '?', key: '' }), at: m.at }));
    return { identities: ids, merged };
  }
}

module.exports = { Entities, personKey, isPlaceholder, normAccount };
