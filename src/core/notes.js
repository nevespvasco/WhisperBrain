'use strict';
const { newId } = require('./ids');
const { tx } = require('./db');
const { words } = require('./text');
const { displayFor, describe } = require('../speakers/display');
const { toBlob } = require('../speakers/cluster');

const NOTE_COLS = 'id, title, body, summary, template_id, folder_id, status, pinned, event_uid, event_start, attendees, created_at, updated_at, started_at, ended_at, source, source_ref, platform, insights, external, speaker_count, consent';
const MAX_SPEAKER_COUNT = 12; // the most other people the user can say are on a call
// Where a meeting came from. Recorded/manual live here; the rest arrived from outside.
const SOURCES = ['recorded', 'manual', 'audio', 'file', 'notion', 'obsidian', 'linear', 'calendar'];
const CONSENT = ['unknown', 'announced', 'declined'];   // were the others on the call told it is recorded

function rowToNote(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title, body: r.body, summary: r.summary,
    templateId: r.template_id, folderId: r.folder_id, status: r.status, pinned: !!r.pinned,
    eventUid: r.event_uid, eventStart: r.event_start,
    attendees: JSON.parse(r.attendees || '[]'),
    createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, endedAt: r.ended_at,
    source: r.source || 'recorded', sourceRef: r.source_ref || null, platform: r.platform || null,
    insights: parseJson(r.insights), external: r.external == null ? null : !!r.external,
    speakerCount: r.speaker_count || null,
    consent: r.consent || 'unknown',
  };
}
function parseJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

// FTS5 treats bare punctuation as syntax. Quote every token and AND them; the last one is a prefix match.
// With { any: true } (natural-language questions) stop-words are dropped and tokens are OR-ed.
function ftsQuery(q, { any = false } = {}) {
  const tokens = any ? words(q) : String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map((t, i) => `"${t}"${!any && i === tokens.length - 1 ? '*' : ''}`).join(any ? ' OR ' : ' ');
}

class Notes {
  constructor(db, bus) { this.db = db; this.bus = bus; }

  // ---- notes ----
  create(input = {}) {
    const now = Date.now();
    const id = newId();
    const created = Number(input.createdAt) > 0 ? Number(input.createdAt) : now;
    const source = SOURCES.includes(input.source) ? input.source : 'recorded';
    this.db.prepare(`INSERT INTO notes(id, title, body, summary, template_id, folder_id, event_uid, event_start, attendees, created_at, updated_at, source, source_ref, platform, status)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, String(input.title || '').slice(0, 300), input.body || '', input.summary || '', input.templateId || null, input.folderId || null,
      input.eventUid || null, input.eventStart || null, JSON.stringify(input.attendees || []), created, now,
      source, input.sourceRef || null, input.platform || null, input.status || 'draft');
    this.reindex(id);
    const note = this.get(id);
    this.bus?.publish('note.created', { id });
    return note;
  }

  get(id) { return rowToNote(this.db.prepare(`SELECT ${NOTE_COLS} FROM notes WHERE id = ?`).get(id)); }

  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const map = {
      title: 'title', body: 'body', summary: 'summary', templateId: 'template_id', folderId: 'folder_id',
      status: 'status', startedAt: 'started_at', endedAt: 'ended_at', source: 'source', sourceRef: 'source_ref', platform: 'platform',
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) { sets.push(`${col} = ?`); vals.push(patch[k] ?? null); }
    }
    if ('pinned' in patch) { sets.push('pinned = ?'); vals.push(patch.pinned ? 1 : 0); }
    if ('attendees' in patch) { sets.push('attendees = ?'); vals.push(JSON.stringify(patch.attendees || [])); }
    if ('insights' in patch) { sets.push('insights = ?'); vals.push(patch.insights ? JSON.stringify(patch.insights) : ''); }
    if ('external' in patch) { sets.push('external = ?'); vals.push(patch.external == null ? null : patch.external ? 1 : 0); }
    if ('speakerCount' in patch) {
      const n = patch.speakerCount == null || patch.speakerCount === '' ? null : Number(patch.speakerCount);
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= MAX_SPEAKER_COUNT)) throw new Error(`speakerCount must be 1-${MAX_SPEAKER_COUNT} or null`);
      sets.push('speaker_count = ?'); vals.push(n);
    }
    if ('source' in patch && !SOURCES.includes(patch.source)) throw new Error('invalid source');
    if ('consent' in patch) {
      if (!CONSENT.includes(patch.consent)) throw new Error(`consent must be one of ${CONSENT.join(', ')}`);
      sets.push('consent = ?'); vals.push(patch.consent);
    }
    if (!sets.length) return cur;
    sets.push('updated_at = ?');
    vals.push(Date.now(), id);
    this.db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if ('title' in patch || 'body' in patch || 'summary' in patch) this.reindex(id);
    this.bus?.publish('note.updated', { id });
    return this.get(id);
  }

  remove(id) {
    const changes = this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes;   // its search row goes with it (trigger, migration 32)
    if (changes) this.bus?.publish('note.deleted', { id });
    return changes > 0;
  }

  // Filters: folderId (space, or 'none'), source ('recorded' | … | 'imported' = anything from outside), tagId, before.
  list({ folderId, limit = 100, before, pinnedFirst = false, source, tagId, order: sortOrder } = {}) {
    const where = [];
    const args = [];
    if (folderId === 'none') where.push('folder_id IS NULL');
    else if (folderId) { where.push('folder_id = ?'); args.push(folderId); }
    if (before) { where.push('created_at < ?'); args.push(before); }
    if (source === 'imported') where.push("source NOT IN ('recorded', 'manual')");
    else if (source === 'local') where.push("source IN ('recorded', 'manual')");
    else if (source) { where.push('source = ?'); args.push(source); }
    if (tagId) { where.push('id IN (SELECT note_id FROM note_tags WHERE tag_id = ?)'); args.push(tagId); }
    const base = sortOrder === 'oldest' ? 'created_at ASC' : sortOrder === 'title' ? 'title COLLATE NOCASE ASC' : 'created_at DESC';
    const order = pinnedFirst ? `pinned DESC, ${base}` : base;
    const sql = `SELECT ${NOTE_COLS} FROM notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(limit, 500)).map(rowToNote);
  }

  search(q, limit = 20, opts = {}) {
    const fts = ftsQuery(q, opts);
    if (!fts) return [];
    const rows = this.db.prepare(`
      SELECT note_id, bm25(search, 0, 8, 3, 2, 1) AS rank,
             snippet(search, -1, '<mark>', '</mark>', '…', 14) AS snippet
      FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?`).all(fts, limit);
    const ids = [...new Set(rows.map((r) => r.note_id))];
    const byId = new Map(ids.length ? this.db.prepare(`SELECT ${NOTE_COLS} FROM notes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => [r.id, rowToNote(r)]) : []);   // one query, not one per hit
    return rows.map((r) => ({ note: byId.get(r.note_id) || null, snippet: r.snippet, rank: r.rank })).filter((r) => r.note);
  }

  // Advanced search: free text limited to one part of the note, plus filters. Every filter is optional.
  //   scope: all | title | notes | summary | transcript   folderId (space), from/to (ms), speaker (name), attendee, has: summary|transcript
  advancedSearch({ q = '', scope = 'all', folderId, from, to, speaker, attendee, has, limit = 50 } = {}) {
    const where = [];
    const args = [];
    let rankSel = '0 AS rank', snippetSel = "'' AS snippet", join = '';
    const fts = q.trim() ? ftsQuery(q) : null;
    if (q.trim() && !fts) return [];
    if (fts) {
      const col = { title: 'title', notes: 'body', summary: 'summary', transcript: 'transcript' }[scope];
      join = 'JOIN search ON search.note_id = n.id';
      where.push('search MATCH ?');
      args.push(col ? `{${col}} : (${fts})` : fts);
      rankSel = 'bm25(search, 0, 8, 3, 2, 1) AS rank';
      snippetSel = `snippet(search, ${col ? ['', 'title', 'body', 'summary', 'transcript'].indexOf(col) : -1}, '<mark>', '</mark>', '…', 14) AS snippet`;
    }
    if (folderId === 'none') where.push('n.folder_id IS NULL');
    else if (folderId) { where.push('n.folder_id = ?'); args.push(folderId); }
    if (from) { where.push('n.created_at >= ?'); args.push(Number(from)); }
    if (to) { where.push('n.created_at < ?'); args.push(Number(to)); }
    if (attendee) { where.push(`n.attendees LIKE ? ESCAPE '\\'`); args.push(`%${likeEscape(attendee)}%`); }
    if (has === 'summary') where.push("n.summary <> ''");
    if (has === 'transcript') where.push('EXISTS (SELECT 1 FROM segments s WHERE s.note_id = n.id)');
    if (speaker) {
      where.push(`EXISTS (SELECT 1 FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id WHERE ns.note_id = n.id AND (ns.name LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\'))`);
      args.push(`%${likeEscape(speaker)}%`, `%${likeEscape(speaker)}%`);
    }
    const sql = `SELECT n.id, ${rankSel}, ${snippetSel} FROM notes n ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${fts ? 'rank' : 'n.created_at DESC'} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, Math.min(limit, 200));
    return rows.map((r) => {
      const note = this.get(r.id);
      const out = { note, snippet: r.snippet };
      if (speaker) { // what that person said (matching the text, if any)
        const terms = words(q);
        out.quotes = this.segments(r.id).filter((s) => s.label.toLowerCase().includes(speaker.toLowerCase()))
          .filter((s) => !terms.length || terms.some((t) => s.text.toLowerCase().includes(t))).slice(0, 5)
          .map((s) => ({ id: s.id, label: s.label, startMs: s.startMs, text: s.text }));
      }
      return out;
    });
  }

  // The note's row in the whole-note search, replaced by its rowid (search_rowid): note_id is not indexed there, so a delete by it
  // would scan every note.
  reindex(id) {
    const n = this.get(id);
    const transcript = n ? this.transcriptText(id) : '';
    const run = () => {
      const had = this.db.prepare('SELECT fts_rowid AS r FROM search_rowid WHERE note_id = ?').get(id);
      if (had) this.db.prepare('DELETE FROM search WHERE rowid = ?').run(had.r);
      if (!n) { this.db.prepare('DELETE FROM search_rowid WHERE note_id = ?').run(id); return; }
      const r = this.db.prepare('INSERT INTO search(note_id, title, body, summary, transcript) VALUES(?, ?, ?, ?, ?)').run(id, n.title, n.body, n.summary, transcript);
      this.db.prepare('INSERT INTO search_rowid (note_id, fts_rowid) VALUES (?, ?) ON CONFLICT (note_id) DO UPDATE SET fts_rowid = excluded.fts_rowid').run(id, Number(r.lastInsertRowid));
    };
    if (this.db.isTransaction) run(); else tx(this.db, run);
  }

  // ---- transcript ----
  addSegments(noteId, segments) {
    if (!segments.length) return [];
    const stmt = this.db.prepare('INSERT INTO segments(note_id, speaker, start_ms, end_ms, text, speaker_id, embedding, words, logprob_mean, logprob_min, channel) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id');
    // words: [[word, startMs, endMs], ...] relative to the segment start; logProbMean/Min: recognizer confidence (0 = certain). Stored only.
    const out = tx(this.db, () => segments.map((s) => {
      const { embedding, ...rest } = s;
      const words = Array.isArray(s.words) && s.words.length ? JSON.stringify(s.words) : null;
      const channel = s.channel || channelOf(s.speaker, s.speakerId);
      return { id: stmt.get(noteId, s.speaker, s.startMs, s.endMs, s.text, s.speakerId || null, embedding ? toBlob(embedding) : null, words, s.logProbMean ?? null, s.logProbMin ?? null, channel).id, ...rest, channel, noteId };
    }));
    return out;
  }

  // Each segment carries its channel speaker ('me' | 'them'), the identified voice (speakerId, e.g. "s2") and a
  // display label (speakers/display.js): the name the user gave, else a saved voice profile's name, else "Speaker 2" / "Them" / "Me"
  // (which of them depends on whether the note is being recorded), with labelKind and displayNo for a screen to write it its own way.
  hasSegments(noteId) { return !!this.db.prepare('SELECT 1 FROM segments WHERE note_id = ? LIMIT 1').get(noteId); }
  segments(noteId) {
    const rows = this.db.prepare(`SELECT s.id, s.speaker, s.channel, s.speaker_id AS speakerId, s.start_ms AS startMs, s.end_ms AS endMs, s.text,
        CASE WHEN s.words IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM json_each(s.words) w WHERE json_extract(w.value, '$[3]') = 1) END AS overlap,
        COALESCE(NULLIF(ns.name, ''), v.name, '') AS speakerName
      FROM segments s LEFT JOIN note_speakers ns ON ns.note_id = s.note_id AND ns.speaker_id = s.speaker_id LEFT JOIN voices v ON v.id = ns.voice_id
      WHERE s.note_id = ? ORDER BY s.start_ms, s.id`).all(noteId);
    const map = displayFor(rows, noteId, this.bus?.live);
    return rows.map((r) => { const d = describe(map, r); return { ...r, label: d.label, labelKind: d.kind, displayNo: d.n }; });
  }

  // Utterances with their word timings ([[word, startMs, endMs], ...] relative to the utterance start), for the
  // after-recording speaker pass.
  segmentWords(noteId) {
    return this.db.prepare('SELECT id, speaker, channel, speaker_id AS speakerId, start_ms AS startMs, end_ms AS endMs, text, words FROM segments WHERE note_id = ? ORDER BY start_ms, id').all(noteId)
      .map((r) => ({ ...r, words: r.words ? JSON.parse(r.words) : null }));
  }

  // Replace one utterance with consecutive parts [{ startMs, endMs, text, words, speakerId }] (the after-recording
  // speaker pass cuts an utterance where the speaker changes). The first part keeps the row and its id; a cut utterance
  // loses its voice embedding, which described the whole of it. -> the parts' ids
  replaceSegment(noteId, id, parts) {
    const row = this.db.prepare('SELECT speaker, channel, logprob_mean AS mean, logprob_min AS min FROM segments WHERE id = ? AND note_id = ?').get(id, noteId);
    if (!row || !parts.length) return [];
    const json = (w) => (Array.isArray(w) && w.length ? JSON.stringify(w) : null);
    const update = this.db.prepare('UPDATE segments SET start_ms = ?, end_ms = ?, text = ?, speaker_id = ?, words = ?, embedding = CASE WHEN ? THEN embedding END WHERE id = ?');
    const insert = this.db.prepare('INSERT INTO segments(note_id, speaker, start_ms, end_ms, text, speaker_id, words, logprob_mean, logprob_min, channel) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id');
    return tx(this.db, () => parts.map((p, k) => {
      if (k === 0) { update.run(p.startMs, p.endMs, p.text, p.speakerId || null, json(p.words), parts.length === 1 ? 1 : 0, id); return id; }
      return insert.get(noteId, row.speaker, p.startMs, p.endMs, p.text, p.speakerId || null, json(p.words), row.mean, row.min, row.channel).id;
    }));
  }

  removeSegments(noteId, ids) {
    if (!ids.length) return;
    const stmt = this.db.prepare('DELETE FROM segments WHERE note_id = ? AND id = ?');
    tx(this.db, () => { for (const id of ids) stmt.run(noteId, id); });
  }

  transcriptText(noteId) {
    return this.segments(noteId).map((s) => `${s.label}: ${s.text}`).join('\n');
  }

  clearTranscript(noteId) {
    this.db.prepare('DELETE FROM segments WHERE note_id = ?').run(noteId);
    this.db.prepare('DELETE FROM note_speakers WHERE note_id = ?').run(noteId);
    this.db.prepare('DELETE FROM evidence WHERE note_id = ?').run(noteId);   // who was on the call and who spoke goes with the transcript
    this.reindex(noteId);
  }

  // ---- folders ----
  folders() { return this.db.prepare('SELECT id, name, created_at AS createdAt FROM folders ORDER BY name COLLATE NOCASE').all(); }
  createFolder(name) {
    if (!name?.trim()) throw new Error('folder name required');
    const id = newId();
    this.db.prepare('INSERT INTO folders(id, name, created_at) VALUES(?, ?, ?)').run(id, name.trim(), Date.now());
    return { id, name: name.trim() };
  }
  renameFolder(id, name) { return this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name.trim(), id).changes > 0; }
  removeFolder(id) { return this.db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes > 0; }
  sourceCounts() { return Object.fromEntries(this.db.prepare('SELECT source, COUNT(*) AS c FROM notes GROUP BY source').all().map((r) => [r.source, r.c])); }
  folderCounts() { return Object.fromEntries(this.db.prepare('SELECT folder_id AS id, COUNT(*) AS c FROM notes GROUP BY folder_id').all().map((r) => [r.id ?? 'none', r.c])); }

  // ---- chat ----
  chatHistory(noteId) {
    const rows = noteId
      ? this.db.prepare('SELECT id, role, content, sources, created_at AS createdAt FROM chat_messages WHERE note_id = ? ORDER BY id').all(noteId)
      : this.db.prepare('SELECT id, role, content, sources, created_at AS createdAt FROM chat_messages WHERE note_id IS NULL ORDER BY id').all();
    return rows.map(({ sources, ...r }) => { let s = null; try { s = sources ? JSON.parse(sources) : null; } catch { /* kept as none */ } return s?.length ? { ...r, sources: s } : r; });
  }
  addChat(noteId, role, content, sources = null) {
    const r = this.db.prepare('INSERT INTO chat_messages(note_id, role, content, sources, created_at) VALUES(?, ?, ?, ?, ?) RETURNING id').get(noteId || null, role, content, sources?.length ? JSON.stringify(sources) : null, Date.now());
    return { id: r.id, role, content };
  }
  clearChat(noteId) {
    if (noteId) this.db.prepare('DELETE FROM chat_messages WHERE note_id = ?').run(noteId);
    else this.db.prepare('DELETE FROM chat_messages WHERE note_id IS NULL').run();
  }

  // ---- export ----
  exportMarkdown(id, { includeTranscript = true } = {}) {
    const n = this.get(id);
    if (!n) return null;
    const lines = [`# ${n.title || 'Untitled'}`, '', `_${new Date(n.createdAt).toISOString()}_`, ''];
    if (n.attendees.length) lines.push(`**Attendees:** ${n.attendees.map((a) => a.name || a.email).join(', ')}`, '');
    if (n.summary) lines.push('## Summary', '', n.summary, '');
    if (n.body) lines.push('## Notes', '', n.body, '');
    if (includeTranscript) {
      const segs = this.segments(id);
      if (segs.length) {
        lines.push('## Transcript', '');
        for (const s of segs) lines.push(`**${s.label}** [${fmtClock(s.startMs)}] ${s.text}`, '');
      }
    }
    return lines.join('\n').trimEnd() + '\n';
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().c;
    return { notes: c('SELECT COUNT(*) c FROM notes'), segments: c('SELECT COUNT(*) c FROM segments') };
  }
}

function likeEscape(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }
// Which capture channel a line came from: 'mic' | 'system' | 'dc:<discord user id>'. The recorder says so itself; this is
// for lines that arrive without it (imports, uploads) and mirrors the v8 backfill.
function channelOf(speaker, speakerId) {
  if (speaker === 'me') return 'mic';
  return /^d\d/.test(speakerId || '') ? `dc:${speakerId.slice(1)}` : 'system';
}
function speakerLabel(s) { return s === 'me' ? 'Me' : s === 'them' ? 'Them' : s; }
function fmtClock(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

module.exports = { Notes, ftsQuery, speakerLabel, fmtClock, SOURCES, CONSENT, likeEscape };
