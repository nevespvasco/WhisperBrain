'use strict';
// The knowledge layer over meetings: tags, action items, highlights (snippets), topics and how they connect
// across meetings, a glossary, people (who said what), speaker analytics, external links and unified search.
const { newId } = require('../core/ids');
const { tx } = require('../core/db');
const { ftsQuery, likeEscape } = require('../core/notes');
const { defaultLabel } = require('../speakers/store');
const { words } = require('../core/text');
const kp = require('./keyphrases');

const TAG_COLORS = ['#7c5cff', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316', '#64748b'];
const LINK_KINDS = ['notion', 'linear', 'obsidian', 'url', 'webhook', 'calendar'];
const clean = (s, n = 500) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const personKey = (name) => kp.fold(String(name || '').trim()).replace(/\s+/g, ' ');
const safeSnippet = (s) => String(s || '');

class Knowledge {
  constructor({ db, notes, settings, bus }) {
    Object.assign(this, { db, notes, settings, bus });
    this.corpus = null; // cached docFreq for offline topics
    bus?.subscribe((e) => { if (['note.created', 'note.deleted', 'note.updated', 'recording.stopped'].includes(e.type)) this.corpus = null; });
  }

  changed(what, data = {}) { this.bus?.publish('knowledge.changed', { what, ...data }); }

  // ---------- tags ----------
  tags() {
    return this.db.prepare(`SELECT t.id, t.name, t.color, COUNT(nt.note_id) AS notes FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all();
  }
  tagByName(name) { return this.db.prepare('SELECT id, name, color FROM tags WHERE name = ? COLLATE NOCASE').get(clean(name, 40)); }
  createTag(name, color) {
    const n = clean(name, 40).replace(/^#/, '');
    if (!n) throw new Error('tag name required');
    const hit = this.tagByName(n);
    if (hit) return hit;
    const count = this.db.prepare('SELECT COUNT(*) c FROM tags').get().c;
    const tag = { id: newId(), name: n, color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : TAG_COLORS[count % TAG_COLORS.length] };
    this.db.prepare('INSERT INTO tags(id, name, color, created_at) VALUES(?, ?, ?, ?)').run(tag.id, tag.name, tag.color, Date.now());
    this.changed('tags');
    return tag;
  }
  updateTag(id, { name, color } = {}) {
    if (name !== undefined) { const n = clean(name, 40).replace(/^#/, ''); if (!n) throw new Error('tag name required'); this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(n, id); }
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) this.db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, id);
    this.changed('tags');
    return this.db.prepare('SELECT id, name, color FROM tags WHERE id = ?').get(id) || null;
  }
  removeTag(id) { const ok = this.db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes > 0; this.changed('tags'); return ok; }
  noteTags(noteId) {
    return this.db.prepare('SELECT t.id, t.name, t.color FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ? ORDER BY t.name COLLATE NOCASE').all(noteId);
  }
  setNoteTags(noteId, names) {
    const tags = [...new Set((names || []).map((n) => clean(n, 40).replace(/^#/, '')).filter(Boolean))].slice(0, 20).map((n) => this.createTag(n));
    tx(this.db, () => {
      this.db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES(?, ?)');
      for (const t of tags) ins.run(noteId, t.id);
    });
    this.changed('tags', { noteId });
    return this.noteTags(noteId);
  }

  // ---------- action items ----------
  actionItems({ noteId, done, owner, q, limit = 300 } = {}) {
    const where = [], args = [];
    if (noteId) { where.push('a.note_id = ?'); args.push(noteId); }
    if (done === true || done === false) { where.push('a.done = ?'); args.push(done ? 1 : 0); }
    if (owner) { where.push(`a.owner LIKE ? ESCAPE '\\'`); args.push(`%${likeEscape(owner)}%`); }
    if (q) { where.push(`a.text LIKE ? ESCAPE '\\'`); args.push(`%${likeEscape(q)}%`); }
    return this.db.prepare(`SELECT a.id, a.note_id AS noteId, a.text, a.owner, a.due, a.done, a.auto, a.ext_kind AS extKind, a.ext_id AS extId, a.ext_url AS extUrl,
        a.created_at AS createdAt, n.title AS noteTitle, n.created_at AS noteAt
      FROM action_items a JOIN notes n ON n.id = a.note_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${noteId ? 'a.position, a.created_at' : "a.done, CASE WHEN a.due = '' THEN 1 ELSE 0 END, a.due, n.created_at DESC, a.position"} LIMIT ?`)
      .all(...args, Math.min(limit, 1000)).map((r) => ({ ...r, done: !!r.done, auto: !!r.auto }));
  }
  getAction(id) { return this.actionItems({ limit: 1000 }).find((a) => a.id === id) || null; }
  addAction(noteId, { text, owner = '', due = '', done = false, auto = false } = {}) {
    const tText = clean(text, 500);
    if (!tText) throw new Error('action item text required');
    const pos = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM action_items WHERE note_id = ?').get(noteId).p;
    const id = newId(), now = Date.now();
    this.db.prepare('INSERT INTO action_items(id, note_id, text, owner, due, done, auto, position, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, noteId, tText, clean(owner, 80), normDue(due), done ? 1 : 0, auto ? 1 : 0, pos, now, now);
    this.changed('actions', { noteId });
    return this.actionItems({ noteId }).find((a) => a.id === id);
  }
  updateAction(id, patch = {}) {
    const sets = [], vals = [];
    if ('text' in patch) { const v = clean(patch.text, 500); if (!v) throw new Error('action item text required'); sets.push('text = ?'); vals.push(v); }
    if ('owner' in patch) { sets.push('owner = ?'); vals.push(clean(patch.owner, 80)); }
    if ('due' in patch) { sets.push('due = ?'); vals.push(normDue(patch.due)); }
    if ('done' in patch) { sets.push('done = ?'); vals.push(patch.done ? 1 : 0); }
    if ('ext' in patch) { sets.push('ext_kind = ?, ext_id = ?, ext_url = ?'); vals.push(patch.ext?.kind || null, patch.ext?.id || null, patch.ext?.url || null); }
    if (!sets.length) return this.getAction(id);
    sets.push('auto = 0', 'updated_at = ?'); // an edited item is the user's now: regenerating insights keeps it
    vals.push(Date.now(), id);
    const ok = this.db.prepare(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
    if (!ok) return null;
    this.changed('actions');
    return this.getAction(id);
  }
  removeAction(id) { const ok = this.db.prepare('DELETE FROM action_items WHERE id = ?').run(id).changes > 0; this.changed('actions'); return ok; }
  // Replace the machine-generated items of a note, keeping anything the user touched, completed or pushed elsewhere.
  replaceAutoActions(noteId, items) {
    const keep = this.actionItems({ noteId });
    const seen = new Set(keep.map((a) => personKey(a.text)));
    tx(this.db, () => {
      this.db.prepare('DELETE FROM action_items WHERE note_id = ? AND auto = 1 AND done = 0 AND ext_url IS NULL').run(noteId);
      for (const a of keep.filter((x) => !(x.auto && !x.done && !x.extUrl))) seen.add(personKey(a.text));
    });
    const kept = new Set(this.actionItems({ noteId }).map((a) => personKey(a.text)));
    for (const it of items || []) {
      const k = personKey(it.text);
      if (!k || kept.has(k)) continue;
      kept.add(k);
      this.addAction(noteId, { ...it, auto: true });
    }
    return this.actionItems({ noteId });
  }

  // ---------- snippets (highlights) ----------
  snippets({ noteId, limit = 200 } = {}) {
    return this.db.prepare(`SELECT s.id, s.note_id AS noteId, s.segment_id AS segmentId, s.start_ms AS startMs, s.end_ms AS endMs, s.speaker, s.text, s.label,
        s.created_at AS createdAt, n.title AS noteTitle FROM snippets s JOIN notes n ON n.id = s.note_id
      ${noteId ? 'WHERE s.note_id = ?' : ''} ORDER BY ${noteId ? 's.start_ms' : 's.created_at DESC'} LIMIT ?`).all(...(noteId ? [noteId] : []), limit);
  }
  addSnippet(noteId, { segmentId, label = '', text, startMs, endMs, speaker } = {}) {
    let seg = null;
    if (segmentId != null) {
      seg = this.notes.segments(noteId).find((s) => s.id === Number(segmentId));
      if (!seg) throw new Error('segment not found');
      const dup = this.db.prepare('SELECT id FROM snippets WHERE note_id = ? AND segment_id = ?').get(noteId, seg.id);
      if (dup) return this.snippets({ noteId }).find((s) => s.id === dup.id);
    }
    const body = clean(seg ? seg.text : text, 4000);
    if (!body) throw new Error('snippet text required');
    const id = newId();
    this.db.prepare('INSERT INTO snippets(id, note_id, segment_id, start_ms, end_ms, speaker, text, label, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, noteId, seg?.id ?? null, seg?.startMs ?? (Number(startMs) || 0), seg?.endMs ?? (Number(endMs) || 0), seg ? this.label(seg) : clean(speaker, 80), body, clean(label, 120), Date.now());
    this.changed('snippets', { noteId });
    return this.snippets({ noteId }).find((s) => s.id === id);
  }
  updateSnippet(id, { label }) { this.db.prepare('UPDATE snippets SET label = ? WHERE id = ?').run(clean(label, 120), id); return true; }
  removeSnippet(id) { const ok = this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id).changes > 0; this.changed('snippets'); return ok; }

  // What a line's voice is called. A line from notes.segments already carries the answer of speakers/display.js; one that came
  // from a query of its own (a search hit) does not, so it asks its meeting how the voices are shown (`shown`: one lookup per meeting)
  label(seg, shown = null) {
    if (seg.speakerName) return seg.speakerName;
    const user = this.settings.get('userName');
    const known = seg.labelKind ? seg : shown?.(seg);
    if (known) return known.labelKind === 'me' ? (user || 'Me') : known.label;
    return defaultLabel(seg.speakerId, seg.speaker, user);
  }
  // shown(seg) for label(): the line of the same voice in notes.segments, found once per meeting
  shownLookup() {
    const byNote = new Map();
    return (seg) => {
      if (!seg.noteId || !seg.speakerId) return null;
      if (!byNote.has(seg.noteId)) {
        const m = new Map();
        for (const s of this.notes.segments(seg.noteId)) if (s.speakerId && !m.has(s.speakerId)) m.set(s.speakerId, s);
        byNote.set(seg.noteId, m);
      }
      return byNote.get(seg.noteId).get(seg.speakerId) || null;
    };
  }

  // ---------- topics ----------
  upsertTopic(name) {
    const n = clean(name, 80).replace(/^[#\-*•\s]+/, '');
    const key = kp.phraseKey(n);
    if (!key) return null;
    const hit = this.db.prepare('SELECT id, name, key FROM topics WHERE key = ?').get(key);
    if (hit) return hit;
    const t = { id: newId(), name: n[0].toUpperCase() + n.slice(1), key };
    const now = Date.now();
    this.db.prepare('INSERT INTO topics(id, name, key, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(t.id, t.name, t.key, now, now);
    return t;
  }
  noteTopics(noteId) {
    return this.db.prepare(`SELECT t.id, t.name, nt.weight, nt.summary, nt.auto FROM note_topics nt JOIN topics t ON t.id = nt.topic_id
      WHERE nt.note_id = ? AND t.hidden = 0 ORDER BY nt.weight DESC, t.name`).all(noteId).map((r) => ({ ...r, auto: !!r.auto }));
  }
  // Replace the automatic topics of a note; topics the user added by hand stay.
  setNoteTopics(noteId, list, { auto = true } = {}) {
    tx(this.db, () => {
      if (auto) this.db.prepare('DELETE FROM note_topics WHERE note_id = ? AND auto = 1').run(noteId);
      const ins = this.db.prepare(`INSERT INTO note_topics(note_id, topic_id, weight, summary, auto) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(note_id, topic_id) DO UPDATE SET weight = MAX(weight, excluded.weight), summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE summary END`);
      for (const it of (list || []).slice(0, 12)) {
        const t = this.upsertTopic(typeof it === 'string' ? it : it.name);
        if (!t) continue;
        ins.run(noteId, t.id, Math.max(0.05, Math.min(1, Number(it.weight) || 1)), clean(it.summary, 600), auto ? 1 : 0);
      }
      this.db.prepare('DELETE FROM topics WHERE pinned = 0 AND id NOT IN (SELECT topic_id FROM note_topics)').run();
    });
    this.changed('topics', { noteId });
    return this.noteTopics(noteId);
  }
  addNoteTopic(noteId, name) {
    const t = this.upsertTopic(name);
    if (!t) throw new Error('topic name required');
    this.db.prepare('INSERT INTO note_topics(note_id, topic_id, weight, auto) VALUES(?, ?, 1, 0) ON CONFLICT(note_id, topic_id) DO UPDATE SET auto = 0').run(noteId, t.id);
    this.changed('topics', { noteId });
    return this.noteTopics(noteId);
  }
  removeNoteTopic(noteId, topicId) {
    this.db.prepare('DELETE FROM note_topics WHERE note_id = ? AND topic_id = ?').run(noteId, topicId);
    this.db.prepare('DELETE FROM topics WHERE id = ? AND pinned = 0 AND id NOT IN (SELECT topic_id FROM note_topics)').run(topicId);
    this.changed('topics', { noteId });
    return this.noteTopics(noteId);
  }
  topics({ q, limit = 300 } = {}) {
    const args = [];
    let where = 't.hidden = 0';
    if (q) { where += ` AND t.name LIKE ? ESCAPE '\\'`; args.push(`%${likeEscape(q)}%`); }
    return this.db.prepare(`SELECT t.id, t.name, t.description, t.pinned, COUNT(nt.note_id) AS notes, MAX(n.created_at) AS lastAt, SUM(nt.weight) AS weight
      FROM topics t LEFT JOIN note_topics nt ON nt.topic_id = t.id LEFT JOIN notes n ON n.id = nt.note_id
      WHERE ${where} GROUP BY t.id ORDER BY t.pinned DESC, notes DESC, lastAt DESC LIMIT ?`).all(...args, limit).map((r) => ({ ...r, pinned: !!r.pinned }));
  }
  updateTopic(id, { name, description, pinned, hidden } = {}) {
    const cur = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
    if (!cur) return null;
    if (name !== undefined) {
      const key = kp.phraseKey(name);
      if (!key) throw new Error('topic name required');
      const other = this.db.prepare('SELECT id FROM topics WHERE key = ? AND id <> ?').get(key, id);
      if (other) return this.mergeTopics(id, other.id); // renaming onto an existing topic merges them
      this.db.prepare('UPDATE topics SET name = ?, key = ?, updated_at = ? WHERE id = ?').run(clean(name, 80), key, Date.now(), id);
    }
    if (description !== undefined) this.db.prepare('UPDATE topics SET description = ? WHERE id = ?').run(clean(description, 2000), id);
    if (pinned !== undefined) this.db.prepare('UPDATE topics SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
    if (hidden !== undefined) this.db.prepare('UPDATE topics SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
    this.changed('topics');
    return this.db.prepare('SELECT id, name, description, pinned, hidden FROM topics WHERE id = ?').get(id);
  }
  // Fold topic `fromId` into `intoId` (meetings, weights and summaries move over).
  mergeTopics(fromId, intoId) {
    if (fromId === intoId) return this.db.prepare('SELECT id, name FROM topics WHERE id = ?').get(intoId);
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO note_topics(note_id, topic_id, weight, summary, auto) SELECT note_id, ?, weight, summary, auto FROM note_topics WHERE topic_id = ?
        ON CONFLICT(note_id, topic_id) DO UPDATE SET weight = MAX(weight, excluded.weight)`).run(intoId, fromId);
      this.db.prepare('DELETE FROM topics WHERE id = ?').run(fromId);
    });
    this.changed('topics');
    return this.db.prepare('SELECT id, name FROM topics WHERE id = ?').get(intoId);
  }
  removeTopic(id) { const ok = this.db.prepare('DELETE FROM topics WHERE id = ?').run(id).changes > 0; this.changed('topics'); return ok; }

  // Everything about one topic: the meetings, what each said about it, who talks about it, related topics.
  topic(id) {
    const t = this.db.prepare('SELECT id, name, description, pinned FROM topics WHERE id = ?').get(id);
    if (!t) return null;
    const notes = this.db.prepare(`SELECT n.id, nt.weight, nt.summary FROM note_topics nt JOIN notes n ON n.id = nt.note_id WHERE nt.topic_id = ? ORDER BY n.created_at DESC`).all(id);
    const cards = this.cards(notes.map((r) => this.notes.get(r.id)).filter(Boolean)).map((c) => ({ ...c, topicSummary: notes.find((r) => r.id === c.id)?.summary || '', weight: notes.find((r) => r.id === c.id)?.weight }));
    const related = this.db.prepare(`SELECT t.id, t.name, COUNT(*) AS shared FROM note_topics a JOIN note_topics b ON b.note_id = a.note_id AND b.topic_id <> a.topic_id
      JOIN topics t ON t.id = b.topic_id WHERE a.topic_id = ? AND t.hidden = 0 GROUP BY t.id ORDER BY shared DESC, t.name LIMIT 12`).all(id);
    const ids = new Set(notes.map((r) => r.id));
    const quotes = this.quotes(t.name, { limit: 60, any: true }).filter((q) => ids.has(q.noteId) || q.rank < -2).slice(0, 40);
    const people = new Map();
    for (const q of quotes) { const k = personKey(q.label); const p = people.get(k) || { name: q.label, count: 0 }; p.count++; people.set(k, p); }
    const terms = this.glossary().filter((g) => g.noteId && ids.has(g.noteId)).slice(0, 12);
    return { ...t, pinned: !!t.pinned, notes: cards, related, quotes, people: [...people.values()].sort((a, b) => b.count - a.count), glossary: terms };
  }

  // Topic co-occurrence graph: nodes are topics, edges join topics discussed in the same meetings.
  topicGraph({ limit = 60, minNotes = 1 } = {}) {
    const nodes = this.topics({ limit }).filter((t) => t.notes >= minNotes);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.db.prepare(`SELECT a.topic_id AS source, b.topic_id AS target, COUNT(*) AS weight FROM note_topics a
      JOIN note_topics b ON b.note_id = a.note_id AND a.topic_id < b.topic_id GROUP BY a.topic_id, b.topic_id`).all()
      .filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes: nodes.map((n) => ({ id: n.id, name: n.name, notes: n.notes, pinned: n.pinned })), edges };
  }

  // Everything the Topics overview needs in one go, limited to meetings since `since`: each topic with the dates
  // of its meetings (for sparklines and trends) and co-occurrence edges between the topics returned.
  topicOverview({ since = 0, limit = 150 } = {}) {
    const rows = this.db.prepare(`SELECT nt.topic_id AS id, n.id AS noteId, n.created_at AS at FROM note_topics nt JOIN notes n ON n.id = nt.note_id
      JOIN topics t ON t.id = nt.topic_id WHERE t.hidden = 0 AND n.created_at >= ? ORDER BY n.created_at`).all(since);
    const byTopic = new Map(), byNote = new Map();
    for (const r of rows) {
      if (!byTopic.has(r.id)) byTopic.set(r.id, []);
      if (!byNote.has(r.noteId)) byNote.set(r.noteId, []);
      byTopic.get(r.id).push(r.at); byNote.get(r.noteId).push(r.id);
    }
    // when the topic first came up at all, so "new" means new, not just new inside the period
    const firstEver = new Map(this.db.prepare('SELECT nt.topic_id AS id, MIN(n.created_at) AS at FROM note_topics nt JOIN notes n ON n.id = nt.note_id GROUP BY nt.topic_id').all().map((r) => [r.id, r.at]));
    const topics = this.db.prepare('SELECT id, name, description, pinned FROM topics WHERE hidden = 0').all()
      .filter((m) => byTopic.has(m.id) || (m.pinned && !since))
      .map((m) => { const dates = byTopic.get(m.id) || []; return { id: m.id, name: m.name, description: m.description, pinned: !!m.pinned, notes: dates.length, firstAt: dates[0] || null, lastAt: dates[dates.length - 1] || null, firstEverAt: firstEver.get(m.id) || null, dates, noteIds: [] }; })
      .sort((a, b) => b.pinned - a.pinned || b.notes - a.notes || (b.lastAt || 0) - (a.lastAt || 0)).slice(0, limit);
    const keep = new Map(topics.map((x) => [x.id, x])), w = new Map();
    for (const [noteId, ids] of byNote) {
      for (const id of ids) keep.get(id)?.noteIds.push(noteId);
      const list = ids.filter((id) => keep.has(id)).sort();
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const key = `${list[i]}|${list[j]}`; w.set(key, (w.get(key) || 0) + 1); }
    }
    const edges = [...w].map(([key, weight]) => { const [source, target] = key.split('|'); return { source, target, weight }; });
    return { since, meetings: byNote.size, topics, edges };
  }

  // Offline topics for one meeting (used when no LLM is configured, and for imported meetings).
  localTopics(noteId, { max = 6 } = {}) {
    const n = this.notes.get(noteId);
    if (!n) return [];
    const text = noteText(this.notes, n);
    if (!this.corpus) this.corpus = kp.docFreq(this.notes.list({ limit: 2000 }).map((x) => noteText(this.notes, x)));
    const userWords = new Set(words(this.settings.get('userName') || ''));
    const speakerNames = new Set([...this.notes.segments(noteId).map((s) => kp.phraseKey(s.label)), kp.phraseKey(n.title)]);
    return kp.extract(text, this.corpus, { max: max + 4 })
      .filter((t) => !speakerNames.has(t.key) && !userWords.has(t.key) && !/^(speaker|orador|room speaker)\b/.test(t.key)).slice(0, max);
  }
  autoTopics(noteId) { return this.setNoteTopics(noteId, this.localTopics(noteId)); }

  // ---------- glossary ----------
  glossary({ q } = {}) {
    const args = [];
    let where = '';
    if (q) { where = `WHERE g.term LIKE ? ESCAPE '\\' OR g.definition LIKE ? ESCAPE '\\' OR g.aliases LIKE ? ESCAPE '\\'`; args.push(...Array(3).fill(`%${likeEscape(q)}%`)); }
    return this.db.prepare(`SELECT g.id, g.term, g.definition, g.aliases, g.note_id AS noteId, g.auto, g.updated_at AS updatedAt, n.title AS noteTitle
      FROM glossary g LEFT JOIN notes n ON n.id = g.note_id ${where} ORDER BY g.term COLLATE NOCASE`).all(...args)
      .map((r) => ({ ...r, aliases: JSON.parse(r.aliases || '[]'), auto: !!r.auto }));
  }
  upsertTerm({ term, definition = '', aliases = [], noteId = null, auto = false } = {}) {
    const name = clean(term, 80);
    const key = kp.phraseKey(name);
    if (!key) throw new Error('term required');
    const al = [...new Set((Array.isArray(aliases) ? aliases : String(aliases).split(',')).map((a) => clean(a, 80)).filter(Boolean))].slice(0, 10);
    const hit = this.db.prepare('SELECT id, definition, auto FROM glossary WHERE key = ?').get(key);
    const now = Date.now();
    if (hit) {
      // an automatic definition never overwrites one the user wrote
      if (!auto || hit.auto || !hit.definition) {
        this.db.prepare('UPDATE glossary SET term = ?, definition = CASE WHEN ? <> \'\' THEN ? ELSE definition END, aliases = ?, auto = ?, updated_at = ? WHERE id = ?')
          .run(name, clean(definition, 2000), clean(definition, 2000), JSON.stringify(al), auto && hit.auto ? 1 : 0, now, hit.id);
      }
      this.changed('glossary');
      return this.glossary().find((g) => g.id === hit.id);
    }
    const id = newId();
    this.db.prepare('INSERT INTO glossary(id, term, key, definition, aliases, note_id, auto, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, key, clean(definition, 2000), JSON.stringify(al), noteId, auto ? 1 : 0, now, now);
    this.changed('glossary');
    return this.glossary().find((g) => g.id === id);
  }
  updateTerm(id, { term, definition, aliases } = {}) {
    const cur = this.glossary().find((g) => g.id === id);
    if (!cur) return null;
    if (term !== undefined) {
      const key = kp.phraseKey(term);
      if (!key) throw new Error('term required');
      if (this.db.prepare('SELECT id FROM glossary WHERE key = ? AND id <> ?').get(key, id)) throw new Error('that term is already in the glossary');
      this.db.prepare('UPDATE glossary SET term = ?, key = ? WHERE id = ?').run(clean(term, 80), key, id);
    }
    if (definition !== undefined) this.db.prepare('UPDATE glossary SET definition = ? WHERE id = ?').run(clean(definition, 2000), id);
    if (aliases !== undefined) this.db.prepare('UPDATE glossary SET aliases = ? WHERE id = ?').run(JSON.stringify((Array.isArray(aliases) ? aliases : String(aliases).split(',')).map((a) => clean(a, 80)).filter(Boolean).slice(0, 10)), id);
    this.db.prepare('UPDATE glossary SET auto = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
    this.changed('glossary');
    return this.glossary().find((g) => g.id === id);
  }
  removeTerm(id) { const ok = this.db.prepare('DELETE FROM glossary WHERE id = ?').run(id).changes > 0; this.changed('glossary'); return ok; }
  term(id) {
    const g = this.glossary().find((x) => x.id === id);
    if (!g) return null;
    const quotes = [g.term, ...g.aliases].flatMap((x) => this.quotes(x, { limit: 30, phrase: true }));
    const seen = new Set();
    const uniq = quotes.filter((q) => !seen.has(q.segmentId) && seen.add(q.segmentId)).sort((a, b) => b.at - a.at).slice(0, 40);
    const noteIds = [...new Set([...uniq.map((q) => q.noteId), ...this.notes.search(`"${g.term}"`, 30).map((h) => h.note.id)])];
    return { ...g, quotes: uniq, notes: this.cards(noteIds.map((nid) => this.notes.get(nid)).filter(Boolean)) };
  }
  // Glossary terms that occur in this meeting (for highlighting in the transcript and notes).
  termsInNote(noteId) {
    const n = this.notes.get(noteId);
    if (!n) return [];
    const hay = kp.fold(noteText(this.notes, n));
    return this.glossary().filter((g) => [g.term, ...g.aliases].some((x) => x && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(kp.fold(x))}($|[^\\p{L}\\p{N}])`, 'u').test(hay)));
  }

  // ---------- links to other tools ----------
  links(noteId) { return this.db.prepare('SELECT id, kind, ref, url, title, created_at AS createdAt FROM note_links WHERE note_id = ? ORDER BY created_at').all(noteId); }
  addLink(noteId, { kind = 'url', ref = '', url = '', title = '' } = {}) {
    if (!LINK_KINDS.includes(kind)) throw new Error('invalid link kind');
    if (url && !/^(https?|obsidian|notion|linear):/i.test(url)) throw new Error('unsupported link');
    const existing = this.db.prepare('SELECT id FROM note_links WHERE note_id = ? AND kind = ? AND ((ref <> \'\' AND ref = ?) OR (url <> \'\' AND url = ?))').get(noteId, kind, ref, url);
    if (existing) {
      this.db.prepare('UPDATE note_links SET title = ?, url = ? WHERE id = ?').run(clean(title, 200) || clean(url, 200), url, existing.id);
      return this.links(noteId).find((l) => l.id === existing.id);
    }
    const id = newId();
    this.db.prepare('INSERT INTO note_links(id, note_id, kind, ref, url, title, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(id, noteId, kind, clean(ref, 300), String(url).slice(0, 2000), clean(title, 200) || clean(url, 200), Date.now());
    this.changed('links', { noteId });
    return this.links(noteId).find((l) => l.id === id);
  }
  removeLink(id) { return this.db.prepare('DELETE FROM note_links WHERE id = ?').run(id).changes > 0; }

  // ---------- people ----------
  people({ q } = {}) {
    const me = this.settings.get('userName');
    const map = new Map();
    const add = (name, { noteId, at, talkMs = 0, email = '' }) => {
      const k = personKey(name);
      if (!k || /^(speaker|orador|room speaker|them|me|unknown)( \d+)?$/.test(k)) return;
      const p = map.get(k) || { key: k, name: name.trim(), emails: new Set(), notes: new Set(), talkMs: 0, lastAt: 0, isMe: !!me && personKey(me) === k };
      if (email) p.emails.add(email.toLowerCase());
      if (noteId) p.notes.add(noteId);
      p.talkMs += talkMs;
      p.lastAt = Math.max(p.lastAt, at || 0);
      map.set(k, p);
    };
    for (const r of this.db.prepare(`SELECT ns.note_id AS noteId, n.created_at AS at, ns.speaker_id AS speakerId, ns.channel,
        COALESCE(NULLIF(ns.name, ''), v.name, '') AS name,
        (SELECT COALESCE(SUM(end_ms - start_ms), 0) FROM segments s WHERE s.note_id = ns.note_id AND s.speaker_id = ns.speaker_id) AS talkMs
      FROM note_speakers ns JOIN notes n ON n.id = ns.note_id LEFT JOIN voices v ON v.id = ns.voice_id`).all()) {
      const name = r.name || (r.speakerId === 'm1' ? me : '');
      if (name) add(name, r);
    }
    for (const n of this.db.prepare('SELECT id, attendees, created_at AS at FROM notes').all()) {
      for (const a of JSON.parse(n.attendees || '[]')) add(a.name || (a.email || '').split('@')[0], { noteId: n.id, at: n.at, email: a.email || '' });
    }
    let list = [...map.values()].map((p) => ({ key: p.key, name: p.name, emails: [...p.emails], meetings: p.notes.size, talkMs: p.talkMs, lastAt: p.lastAt, isMe: p.isMe }));
    if (q) { const f = personKey(q); list = list.filter((p) => p.key.includes(f) || p.emails.some((e) => e.includes(f))); }
    return list.sort((a, b) => b.meetings - a.meetings || b.lastAt - a.lastAt);
  }
  person(key) {
    const p = this.people().find((x) => x.key === personKey(key));
    if (!p) return null;
    const noteIds = new Set();
    for (const r of this.db.prepare('SELECT ns.note_id AS id, COALESCE(NULLIF(ns.name, \'\'), v.name, \'\') AS name, ns.speaker_id AS sid FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id').all()) {
      if (personKey(r.name || (r.sid === 'm1' && p.isMe ? p.name : '')) === p.key) noteIds.add(r.id);
    }
    for (const n of this.db.prepare('SELECT id, attendees FROM notes').all()) {
      if (JSON.parse(n.attendees || '[]').some((a) => personKey(a.name || (a.email || '').split('@')[0]) === p.key || (a.email && p.emails.includes(a.email.toLowerCase())))) noteIds.add(n.id);
    }
    const notes = this.cards([...noteIds].map((id) => this.notes.get(id)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt));
    const quotes = [];
    for (const n of notes.slice(0, 30)) {
      for (const s of this.notes.segments(n.id)) if (personKey(this.label(s)) === p.key && words(s.text).length >= 5) quotes.push({ segmentId: s.id, noteId: n.id, noteTitle: n.title, at: n.createdAt, startMs: s.startMs, label: this.label(s), text: s.text });
    }
    const topics = new Map();
    for (const n of notes) for (const t of n.topics || []) { const e = topics.get(t.id) || { id: t.id, name: t.name, count: 0 }; e.count++; topics.set(t.id, e); }
    const actions = this.actionItems({ owner: p.name.split(' ')[0] }).filter((a) => personKey(a.owner).includes(personKey(p.name.split(' ')[0])));
    return { ...p, notes, quotes: quotes.sort((a, b) => b.text.length - a.text.length).slice(0, 25).sort((a, b) => b.at - a.at || a.startMs - b.startMs), topics: [...topics.values()].sort((a, b) => b.count - a.count).slice(0, 15), actions };
  }

  // ---------- analytics ----------
  // Who talked how much: talk time, words per minute, turns, talk % and listen %, plus a coarse timeline.
  analytics(noteId) {
    const segs = this.notes.segments(noteId);
    const by = new Map();
    const timeline = [];
    let prev = null;
    for (const s of segs) {
      const id = s.speakerId || s.speaker;
      const e = by.get(id) || { speakerId: id, label: this.label(s), talkMs: 0, words: 0, turns: 0, longestMs: 0, run: 0, questions: 0 };
      const dur = Math.max(0, s.endMs - s.startMs);
      e.talkMs += dur;
      e.words += (s.text.match(/[\p{L}\p{N}]+/gu) || []).length;
      e.questions += (s.text.match(/\?/g) || []).length;
      if (prev !== id) { e.turns++; e.run = 0; }
      e.run += dur;
      e.longestMs = Math.max(e.longestMs, e.run);
      by.set(id, e);
      const last = timeline[timeline.length - 1];
      if (last && last.speakerId === id && s.startMs - last.endMs < 4000) last.endMs = Math.max(last.endMs, s.endMs);
      else timeline.push({ speakerId: id, startMs: s.startMs, endMs: s.endMs });
      prev = id;
    }
    const total = [...by.values()].reduce((a, e) => a + e.talkMs, 0) || 1;
    const speakers = [...by.values()].map(({ run, ...e }) => ({ ...e, wpm: e.talkMs > 5000 ? Math.round(e.words / (e.talkMs / 60000)) : 0, talkPct: Math.round((e.talkMs / total) * 100), listenPct: 100 - Math.round((e.talkMs / total) * 100) }))
      .sort((a, b) => b.talkMs - a.talkMs);
    const end = segs.length ? Math.max(...segs.map((s) => s.endMs)) : 0;
    return { durationMs: end, words: speakers.reduce((a, s) => a + s.words, 0), speakers, timeline };
  }

  // ---------- search ----------
  // Transcript lines matching q across all meetings ("who said what").
  quotes(q, { speaker, noteId, from, to, limit = 50, any = false, phrase = false } = {}) {
    const fts = phrase ? `"${String(q).replace(/"/g, '')}"` : ftsQuery(q, { any });
    if (!fts || fts === '""') return [];
    const where = ['seg_fts MATCH ?'], args = [fts];
    if (noteId) { where.push('s.note_id = ?'); args.push(noteId); }
    if (from) { where.push('n.created_at >= ?'); args.push(Number(from)); }
    if (to) { where.push('n.created_at < ?'); args.push(Number(to)); }
    const rows = this.db.prepare(`SELECT s.id AS segmentId, s.note_id AS noteId, s.start_ms AS startMs, s.speaker, s.speaker_id AS speakerId, s.text,
        snippet(seg_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet, bm25(seg_fts) AS rank, n.title AS noteTitle, n.created_at AS at,
        COALESCE(NULLIF(ns.name, ''), v.name, '') AS speakerName
      FROM seg_fts JOIN segments s ON s.id = seg_fts.rowid JOIN notes n ON n.id = s.note_id
      LEFT JOIN note_speakers ns ON ns.note_id = s.note_id AND ns.speaker_id = s.speaker_id LEFT JOIN voices v ON v.id = ns.voice_id
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...args, Math.min(limit * (speaker ? 4 : 1), 400));
    const shown = this.shownLookup();
    return rows.map((r) => ({ ...r, label: this.label(r, shown) }))
      .filter((r) => !speaker || personKey(r.label).includes(personKey(speaker))).slice(0, limit)
      .map(({ speakerName, ...r }) => ({ ...r, snippet: safeSnippet(r.snippet) }));
  }

  // One search box over everything: meetings, what people said, topics, people, glossary, tags and action items.
  find({ q = '', kind = 'all', from, to, sort = 'relevance', limit = 40, source } = {}) {
    const query = String(q).trim();
    const out = [];
    const inRange = (at) => (!from || at >= Number(from)) && (!to || at < Number(to));
    const want = (k) => kind === 'all' || kind === k;
    if (want('meetings')) {
      const hits = query ? this.notes.search(query, kind === 'all' ? 15 : limit).map((h) => ({ note: h.note, snippet: h.snippet, rank: h.rank }))
        : this.notes.list({ limit: kind === 'all' ? 15 : limit, source }).map((n) => ({ note: n, snippet: '', rank: 0 }));
      for (const h of hits) {
        if (!inRange(h.note.createdAt) || (source && !sourceMatch(h.note.source, source))) continue;
        out.push({ kind: 'meeting', id: h.note.id, noteId: h.note.id, title: h.note.title || '', snippet: h.snippet, at: h.note.createdAt, rank: h.rank, source: h.note.source, platform: h.note.platform, tags: this.noteTags(h.note.id) });
      }
    }
    if (query && want('quotes')) {
      for (const r of this.quotes(query, { from, to, limit: kind === 'all' ? 12 : limit })) {
        out.push({ kind: 'quote', id: `q${r.segmentId}`, noteId: r.noteId, segmentId: r.segmentId, title: r.label, snippet: r.snippet, at: r.at, startMs: r.startMs, noteTitle: r.noteTitle, rank: r.rank });
      }
    }
    const like = (rows, k, map) => { for (const r of rows) out.push({ kind: k, rank: 0, ...map(r) }); };
    if (want('topics')) like(this.topics({ q: query || undefined, limit: query ? 20 : 12 }), 'topic', (t) => ({ id: t.id, title: t.name, snippet: t.description, at: t.lastAt || 0, count: t.notes }));
    if (want('people')) like(this.people({ q: query || undefined }).slice(0, query ? 20 : 10), 'person', (p) => ({ id: p.key, title: p.name, snippet: p.emails.join(', '), at: p.lastAt, count: p.meetings }));
    if (want('glossary')) like(this.glossary({ q: query || undefined }).slice(0, query ? 20 : 10), 'term', (g) => ({ id: g.id, title: g.term, snippet: g.definition, at: g.updatedAt }));
    if (want('tags')) like(this.tags().filter((tg) => !query || kp.fold(tg.name).includes(kp.fold(query))), 'tag', (tg) => ({ id: tg.id, title: tg.name, color: tg.color, count: tg.notes, at: 0 }));
    if (want('actions')) like(this.actionItems({ q: query || undefined, limit: query ? 20 : 10 }), 'action', (a) => ({ id: a.id, noteId: a.noteId, title: a.text, snippet: [a.owner, a.due].filter(Boolean).join(' · '), at: a.noteAt, done: a.done, noteTitle: a.noteTitle }));
    const filtered = out.filter((r) => !r.at || inRange(r.at) || !['meeting', 'quote', 'action'].includes(r.kind));
    if (sort === 'newest') filtered.sort((a, b) => (b.at || 0) - (a.at || 0));
    else if (sort === 'oldest') filtered.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
    return filtered.slice(0, Math.max(limit, 60));
  }

  // Meetings that share topics, people or tags with this one.
  related(noteId, { limit = 6 } = {}) {
    const score = new Map();
    const bump = (id, s, why) => { if (id === noteId) return; const e = score.get(id) || { score: 0, why: new Set() }; e.score += s; e.why.add(why); score.set(id, e); };
    for (const r of this.db.prepare(`SELECT b.note_id AS id, t.name, a.weight * b.weight AS w FROM note_topics a JOIN note_topics b ON b.topic_id = a.topic_id AND b.note_id <> a.note_id
      JOIN topics t ON t.id = a.topic_id WHERE a.note_id = ?`).all(noteId)) bump(r.id, 2 * r.w + 0.5, r.name);
    for (const r of this.db.prepare(`SELECT b.note_id AS id, t.name FROM note_tags a JOIN note_tags b ON b.tag_id = a.tag_id AND b.note_id <> a.note_id JOIN tags t ON t.id = a.tag_id WHERE a.note_id = ?`).all(noteId)) bump(r.id, 1, `#${r.name}`);
    const me = this.notes.get(noteId);
    const mine = new Set(this.people().filter(() => true).map((p) => p.key));
    if (me) {
      const names = new Set([...me.attendees.map((a) => personKey(a.name || a.email)), ...this.notes.segments(noteId).map((s) => personKey(this.label(s)))].filter((k) => k && mine.has(k)));
      if (names.size) {
        for (const n of this.notes.list({ limit: 400 })) {
          if (n.id === noteId) continue;
          const theirs = new Set(n.attendees.map((a) => personKey(a.name || a.email)));
          for (const k of names) if (theirs.has(k)) bump(n.id, 0.6, n.attendees.find((a) => personKey(a.name || a.email) === k)?.name || k);
        }
      }
    }
    const ids = [...score.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    return ids.map(([id, e]) => ({ ...this.cards([this.notes.get(id)].filter(Boolean))[0], reasons: [...e.why].slice(0, 4), score: Math.round(e.score * 100) / 100 })).filter((c) => c.id);
  }

  // ---------- presentation helpers ----------
  isExternal(note) {
    if (note.external != null) return note.external;
    const domains = new Set(String(this.settings.get('myDomains') || '').split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
    for (const e of [this.settings.get('userEmail'), this.settings.get('google')?.email]) if (e && e.includes('@')) domains.add(e.split('@')[1].toLowerCase());
    const emails = (note.attendees || []).map((a) => String(a.email || '').toLowerCase()).filter((e) => e.includes('@') && !/resource\.calendar|group\.calendar/.test(e));
    if (!domains.size || !emails.length) return null;
    return emails.some((e) => !domains.has(e.split('@')[1]));
  }

  // List entries enriched for cards: tags, topics, duration, speakers, open action items, external flag.
  cards(notes) {
    if (!notes.length) return [];
    const ids = notes.map((n) => n.id);
    const ph = ids.map(() => '?').join(',');
    const tagRows = this.db.prepare(`SELECT nt.note_id AS noteId, t.id, t.name, t.color FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id IN (${ph})`).all(...ids);
    const topicRows = this.db.prepare(`SELECT nt.note_id AS noteId, t.id, t.name, nt.weight FROM note_topics nt JOIN topics t ON t.id = nt.topic_id WHERE t.hidden = 0 AND nt.note_id IN (${ph}) ORDER BY nt.weight DESC`).all(...ids);
    const segRows = this.db.prepare(`SELECT note_id AS noteId, COUNT(*) AS lines, MAX(end_ms) AS endMs, COUNT(DISTINCT COALESCE(speaker_id, speaker)) AS speakers FROM segments WHERE note_id IN (${ph}) GROUP BY note_id`).all(...ids);
    const actRows = this.db.prepare(`SELECT note_id AS noteId, SUM(done = 0) AS open, COUNT(*) AS total FROM action_items WHERE note_id IN (${ph}) GROUP BY note_id`).all(...ids);
    const spRows = this.db.prepare(`SELECT ns.note_id AS noteId, ns.speaker_id AS speakerId, ns.channel, COALESCE(NULLIF(ns.name, ''), v.name, '') AS name FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id WHERE ns.note_id IN (${ph})`).all(...ids);
    const linkRows = this.db.prepare(`SELECT note_id AS noteId, kind, url FROM note_links WHERE note_id IN (${ph})`).all(...ids);
    const group = (rows) => { const m = new Map(); for (const r of rows) { const a = m.get(r.noteId) || []; a.push(r); m.set(r.noteId, a); } return m; };
    const tg = group(tagRows), tp = group(topicRows), sp = group(spRows), lk = group(linkRows);
    const sg = new Map(segRows.map((r) => [r.noteId, r])), ac = new Map(actRows.map((r) => [r.noteId, r]));
    const shown = this.shownLookup();   // an unnamed voice is called what the transcript calls it
    return notes.map((n) => {
      const seg = sg.get(n.id);
      const people = (sp.get(n.id) || []).map((s) => s.name || this.label({ noteId: n.id, speakerId: s.speakerId, speaker: s.channel === 'mic' ? 'me' : 'them' }, shown));
      const attendeeNames = (n.attendees || []).map((a) => a.name || a.email).filter(Boolean);
      return {
        ...n, insights: undefined, hasInsights: !!n.insights,
        tags: (tg.get(n.id) || []).map(({ noteId, ...t }) => t),
        topics: (tp.get(n.id) || []).slice(0, 5).map(({ noteId, ...t }) => t),
        durationMs: n.endedAt && n.startedAt ? n.endedAt - n.startedAt : seg?.endMs || 0,
        lines: seg?.lines || 0, speakerCount: seg?.speakers || 0,
        people: [...new Set([...people, ...attendeeNames])].slice(0, 8),
        actions: { open: ac.get(n.id)?.open || 0, total: ac.get(n.id)?.total || 0 },
        links: (lk.get(n.id) || []).map(({ noteId, ...l }) => l),
        external: this.isExternal(n),
        excerpt: excerpt(n.insights?.overview || n.summary || n.body),
      };
    });
  }

  // Event-level preference: record this calendar meeting automatically when it starts.
  eventPrefs() { return Object.fromEntries(this.db.prepare('SELECT event_id AS id, capture FROM event_prefs').all().map((r) => [r.id, !!r.capture])); }
  setEventCapture(eventId, capture) {
    this.db.prepare('INSERT INTO event_prefs(event_id, capture, updated_at) VALUES(?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET capture = excluded.capture, updated_at = excluded.updated_at').run(String(eventId).slice(0, 400), capture ? 1 : 0, Date.now());
    return { id: eventId, capture: !!capture };
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().c;
    return { tags: c('SELECT COUNT(*) c FROM tags'), topics: c('SELECT COUNT(*) c FROM topics WHERE hidden = 0'), glossary: c('SELECT COUNT(*) c FROM glossary'), openActions: c('SELECT COUNT(*) c FROM action_items WHERE done = 0'), snippets: c('SELECT COUNT(*) c FROM snippets') };
  }
}

function noteText(notes, n) { return [n.title, n.title, n.body, n.summary, notes.segments(n.id).map((s) => s.text).join('\n')].join('\n'); }
// Card preview text: drops code and heading lines so the excerpt starts with the first real sentence, not the word "Summary".
function excerpt(md) { return String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s{0,3}#{1,6}\s.*$/gm, ' ').replace(/[#>*_`\[\]|-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normDue(d) { const s = String(d || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
function sourceMatch(src, want) { return want === 'imported' ? !['recorded', 'manual'].includes(src) : want === 'local' ? ['recorded', 'manual'].includes(src) : src === want; }

module.exports = { Knowledge, TAG_COLORS, LINK_KINDS, personKey };
