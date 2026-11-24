'use strict';
// Turns imported material into meetings: audio/video files are transcribed on-device; transcripts and documents
// (VTT, SRT, TXT, Markdown, JSON, DOCX, HTML, CSV) become notes with named speakers; Notion pages, Obsidian notes
// and Linear issues come in the same way, marked with their source so they can be kept apart from recordings.
const path = require('node:path');
const { decodeAudio, transcribePcm, assignSpeakers } = require('../recording/import');

let importers = null;
const parsers = () => (importers ??= require('../importers'));

const prettyTitle = (filename) => path.basename(String(filename || ''), path.extname(String(filename || ''))).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported meeting';

class Importer {
  constructor(app) { this.app = app; this.queue = Promise.resolve(); }

  // Detect what a file is and import it. Audio is queued for transcription; returns immediately with the note ids.
  async importFile(buffer, filename, { folderId, me, source = 'file', sourceRef, tags = [] } = {}) {
    if (!buffer?.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
    const kind = parsers().detectKind(filename, buffer);
    if (kind === 'audio' || kind === 'video') {
      const note = this.app.notes.create({ title: prettyTitle(filename), source: 'audio', sourceRef: sourceRef || filename, folderId, status: 'processing' });
      if (tags.length) this.app.knowledge.setNoteTags(note.id, tags);
      this.enqueue(() => this.transcribeInto(note.id, buffer, filename));
      return { notes: [{ id: note.id, title: note.title, status: 'processing' }], kind };
    }
    if (kind === 'unsupported') throw Object.assign(new Error(`${path.extname(filename) || 'This'} files cannot be imported. Supported: audio/video, .vtt, .srt, .txt, .md, .json, .docx, .html, .csv`), { status: 415 });
    let parsed;
    try { parsed = parsers().parseFile(buffer, filename, { me: me || this.app.settings.get('userName') || undefined }); } catch (e) { throw Object.assign(new Error(e.message), { status: 415 }); }
    const notes = parsed.map((p) => this.createFromParsed(p, { folderId, source, sourceRef: sourceRef || filename, tags }));
    return { notes, kind };
  }

  enqueue(job) {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  // On-device transcription of an audio/video file into an existing note (with voice-based speakers).
  async transcribeInto(noteId, buffer, filename) {
    const { app } = this;
    const bus = app.bus;
    try {
      if (app.recording.status().active) throw new Error('A recording is in progress; the import will need to be retried after it stops.');
      bus.publish('import.progress', { noteId, stage: 'decode', progress: 0 });
      const model = await app.recording.ensureEngine('batch');
      const pcm = await decodeAudio(buffer, filename, { engine: app.engine });
      bus.publish('import.progress', { noteId, stage: 'transcribe', progress: 0 });
      const segs = await transcribePcm(app.engine, pcm, { onProgress: (p) => bus.publish('import.progress', { noteId, stage: 'transcribe', progress: p }) });
      const labelled = assignSpeakers(noteId, segs, app.speakers, { threshold: app.settings.get('speakerThreshold') });
      app.notes.addSegments(noteId, labelled);
      app.speakers.consolidate(noteId, app.settings.get('speakerThreshold'));
      app.speakers.autoMatch(noteId);
      const durationMs = Math.round((pcm.length / 2 / 16000) * 1000);
      const n = app.notes.get(noteId);
      app.notes.update(noteId, { status: 'done', startedAt: n.createdAt, endedAt: n.createdAt + durationMs });
      app.notes.reindex(noteId);
      await app.analyze(noteId, { local: true });
      bus.publish('import.done', { noteId, segments: labelled.length, durationMs, model: model.id });
      return { segments: labelled.length, durationMs };
    } catch (e) {
      if (app.notes.get(noteId)) app.notes.update(noteId, { status: 'failed' });
      bus.publish('import.failed', { noteId, message: e.message, code: e.code });
      throw e;
    }
  }

  // A parsed transcript/document → a note with named speakers, tags and action items, then offline topics.
  createFromParsed(p, { folderId, source = 'file', sourceRef, tags = [] } = {}) {
    const { notes, speakers, knowledge, db } = this.app;
    const created = Number(p.date) > 0 ? Number(p.date) : Date.now();
    const segs = (p.segments || []).filter((s) => s.text);
    const last = segs.length ? Math.max(...segs.map((s) => s.endMs || s.startMs || 0)) : 0;
    const note = notes.create({
      title: p.title || prettyTitle(p.sourceName), body: p.body || '', summary: p.summary || '', attendees: p.attendees || [],
      createdAt: created, source, sourceRef, folderId, status: 'done',
    });
    if (segs.length) {
      // every distinct label becomes a named speaker: the user is m1, everyone else s1, s2…
      const ids = new Map();
      let n = 0;
      const ins = db.prepare('INSERT OR IGNORE INTO note_speakers(note_id, speaker_id, channel, name, count) VALUES(?, ?, ?, ?, 0)');
      for (const s of segs) {
        const key = (s.label || '').trim() || (s.speaker === 'me' ? '__me' : '__them');
        if (ids.has(key)) continue;
        const sid = s.speaker === 'me' ? 'm1' : `s${++n}`;
        ids.set(key, sid);
        ins.run(note.id, sid, s.speaker === 'me' ? 'mic' : 'system', s.label && !key.startsWith('__') ? s.label.trim().slice(0, 80) : '');
      }
      notes.addSegments(note.id, segs.map((s) => ({ speaker: s.speaker === 'me' ? 'me' : 'them', speakerId: ids.get((s.label || '').trim() || (s.speaker === 'me' ? '__me' : '__them')), startMs: s.startMs || 0, endMs: s.endMs || s.startMs || 0, text: String(s.text).trim() })));
      db.prepare('UPDATE note_speakers SET count = (SELECT COUNT(*) FROM segments WHERE segments.note_id = note_speakers.note_id AND segments.speaker_id = note_speakers.speaker_id) WHERE note_id = ?').run(note.id);
      notes.update(note.id, { startedAt: created, endedAt: created + last });
      speakers.autoMatch?.(note.id);
    }
    notes.reindex(note.id);
    const allTags = [...new Set([...(p.tags || []), ...tags])];
    if (allTags.length) knowledge.setNoteTags(note.id, allTags);
    for (const a of p.actionItems || []) { try { knowledge.addAction(note.id, a); } catch { /* skip empty */ } }
    knowledge.corpus = null;
    try { knowledge.autoTopics(note.id); } catch { /* topics are best effort */ }
    return { id: note.id, title: notes.get(note.id).title, status: 'done', segments: segs.length };
  }

  // Markdown from another tool (Notion page, Obsidian note, Linear issue) → a meeting with that source.
  importMarkdown(markdown, { title, date, source, sourceRef, folderId, link } = {}) {
    const [p] = parsers().parseFile(Buffer.from(String(markdown || ''), 'utf8'), `${(title || 'note').replace(/[\\/]/g, ' ')}.md`, { me: this.app.settings.get('userName') || undefined });
    const parsed = p || { title, body: markdown, segments: [] };
    if (title && (!parsed.title || parsed.title === 'note')) parsed.title = title;
    if (date && !parsed.date) parsed.date = date;
    const out = this.createFromParsed(parsed, { folderId, source, sourceRef });
    if (link?.url) this.app.knowledge.addLink(out.id, link);
    return out;
  }
}

module.exports = { Importer, prettyTitle };
