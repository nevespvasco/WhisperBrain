'use strict';
// Translating a meeting into other languages with the AI server that is set up for the notes (Settings → AI). Off until it is
// switched on in Settings → Translation. A translation is kept per line and language next to the meeting (migration v11) with a
// hash of the words it translated, so a line the speaker pass has cut since, or a summary written again, is never shown with
// the translation of what it used to say. Nothing here sits in the way of recording: the work is queued, one request at a time,
// and a slow or missing AI only makes the translation late.
const crypto = require('node:crypto');
const { translateMessages, translateSummaryMessages } = require('./prompts');
const { isLanguage } = require('./languages');
const { extractJson } = require('./insights');

const BATCH_LINES = 20;
const BATCH_CHARS = 4000;
const CONTEXT_LINES = 2;
const RETRIES = 1;              // a line the model skipped is asked for once more, alone
const LIVE_BACKLOG = 12;        // lines waiting for a live translation; when the AI is slower than the talk, the oldest are dropped
const LIVE_BATCH = 4;           // lines sent together while recording (small: the translation should follow the talk)

const hashText = (text) => crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
const needsTranslation = (text) => /\p{L}/u.test(String(text ?? ''));

// reply: the model's answer; ids: the numbers that were asked for -> Map(number -> text), only those, only real text
function parseTranslations(reply, ids) {
  const out = new Map();
  const obj = extractJson(reply);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const id of ids) {
    const v = obj[id];
    if (typeof v === 'string' && v.trim()) out.set(id, v.trim());
  }
  return out;
}

class Translator {
  constructor({ notes, settings, llm, bus }) {
    Object.assign(this, { notes, settings, llm, bus });
    this.jobs = new Map();   // `${noteId}|${lang}` -> { total, done, ctl, promise }
    this.queue = [];         // live: lines waiting, [{ noteId, id, text, lang }]
    this.recent = new Map(); // live: the last lines translated of each note, as context for the next
    this.warned = new Set(); // notes whose live translation has already said it failed
    this.pumping = null;
    this.gate = Promise.resolve();   // every request to the AI goes through here: one at a time, whatever asked for it
  }

  get db() { return this.notes.db; }
  options() { return this.settings.get('translation'); }
  model() { return this.settings.get('llm').model || ''; }

  // ---- what is stored ----
  // Map(segmentId -> text) of the lines of a note that have a translation that still fits their words
  translations(noteId, lang) {
    const rows = this.db.prepare(`SELECT t.segment_id AS id, t.text, t.src_hash AS hash, s.text AS source FROM segment_translations t
      JOIN segments s ON s.id = t.segment_id WHERE s.note_id = ? AND t.lang = ? ORDER BY s.start_ms, s.id`).all(noteId, lang);
    return new Map(rows.filter((r) => r.hash === hashText(r.source)).map((r) => [r.id, r.text]));
  }

  // The languages a note has been translated into: [{ lang, lines }]
  languages(noteId) {
    const langs = this.db.prepare(`SELECT DISTINCT t.lang FROM segment_translations t JOIN segments s ON s.id = t.segment_id WHERE s.note_id = ? ORDER BY t.lang`).all(noteId).map((r) => r.lang);
    return langs.map((lang) => ({ lang, lines: this.translations(noteId, lang).size })).filter((l) => l.lines > 0);
  }

  clear(noteId, lang) {
    this.db.prepare('DELETE FROM segment_translations WHERE lang = ? AND segment_id IN (SELECT id FROM segments WHERE note_id = ?)').run(lang, noteId);
    this.db.prepare("DELETE FROM note_translations WHERE note_id = ? AND lang = ?").run(noteId, lang);
  }

  // The lines of a note that still need a translation into `lang`: [{ index, id, text }] (index: place among all lines)
  pending(noteId, lang) {
    const rows = this.db.prepare('SELECT id, text FROM segments WHERE note_id = ? ORDER BY start_ms, id').all(noteId);
    const have = this.translations(noteId, lang);
    return rows.map((r, index) => ({ index, ...r })).filter((r) => needsTranslation(r.text) && !have.has(r.id));
  }

  save(segmentId, lang, text, source) {
    this.db.prepare(`INSERT INTO segment_translations(segment_id, lang, text, src_hash, model, created_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_id, lang) DO UPDATE SET text = excluded.text, src_hash = excluded.src_hash, model = excluded.model, created_at = excluded.created_at`)
      .run(segmentId, lang, text, hashText(source), this.model(), Date.now());
  }

  // ---- the work ----
  // Ask for the translation of some lines, one batch. rows: [{ id, text }], before: the texts said just before. -> Map(id -> text)
  // One request at a time across live lines, jobs and summaries, so translating never crowds the AI out from the notes it is also asked for
  oneAtATime(fn) {
    const turn = this.gate.then(fn, fn);
    this.gate = turn.catch(() => {});
    return turn;
  }

  async ask(rows, lang, before, signal) {
    const items = rows.map((r, i) => ({ n: i + 1, text: r.text }));
    const reply = await this.oneAtATime(() => this.llm.complete(translateMessages({ language: lang, items, before }), { temperature: 0.1, signal, reasoning: 'off' }));
    const got = parseTranslations(reply, items.map((i) => i.n));
    return new Map(items.filter((i) => got.has(i.n)).map((i) => [rows[i.n - 1].id, got.get(i.n)]));
  }

  // Translate every line of a note that has no translation into `lang` yet. -> { total, done, failed }
  // mayShare(kind, id): set by the app from the access grants; a meeting kept on this computer is never sent to a remote server
  shareable(noteId) { return this.mayShare ? this.mayShare('note', noteId) : true; }

  async translateNote(noteId, lang, { signal, onProgress } = {}) {
    if (!this.shareable(noteId)) throw Object.assign(new Error('This meeting comes from a source you keep on this computer, and the AI server is not on this computer.'), { status: 409, code: 'local-only' });
    const todo = this.pending(noteId, lang);
    const stats = { total: todo.length, done: 0, failed: 0 };
    if (!todo.length) return stats;
    const all = this.db.prepare('SELECT id, text FROM segments WHERE note_id = ? ORDER BY start_ms, id').all(noteId);
    const batches = [];
    for (let cur = []; todo.length || cur.length;) {
      const next = todo[0];
      if (next && cur.length < BATCH_LINES && cur.reduce((n, r) => n + r.text.length, next.text.length) <= BATCH_CHARS) { cur.push(todo.shift()); continue; }
      if (cur.length) { batches.push(cur); cur = []; } else if (next) { batches.push([todo.shift()]); }
    }
    const run = async (rows) => {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const before = all.slice(Math.max(0, rows[0].index - CONTEXT_LINES), rows[0].index).map((r) => r.text);
      const got = await this.ask(rows, lang, before, signal);
      for (const r of rows) {
        if (!got.has(r.id)) continue;
        this.save(r.id, lang, got.get(r.id), r.text);
        stats.done++;
        this.bus?.publish('translation.segment', { noteId, segmentId: r.id, lang, text: got.get(r.id) });
      }
      this.bus?.publish('translation.progress', { noteId, lang, done: stats.done, total: stats.total });
      onProgress?.(stats.done);
      return rows.filter((r) => !got.has(r.id));
    };
    let missing = [];
    for (const rows of batches) missing.push(...await run(rows));
    for (let k = 0; k < RETRIES && missing.length; k++) {
      const again = [];
      for (let i = 0; i < missing.length; i += BATCH_LINES) again.push(...await run(missing.slice(i, i + BATCH_LINES)));
      missing = again;
    }
    stats.failed = missing.length;
    return stats;
  }

  // The summary of a note in another language: written again by the model only if the summary changed since. -> { lang, text } or null
  summaryTranslation(noteId, lang) {
    const note = this.notes.get(noteId);
    const row = this.db.prepare("SELECT text, src_hash AS hash FROM note_translations WHERE note_id = ? AND lang = ? AND field = 'summary'").get(noteId, lang);
    return note && row && row.hash === hashText(note.summary) ? { lang, text: row.text } : null;
  }

  async translateSummary(noteId, lang, { signal } = {}) {
    const note = this.notes.get(noteId);
    if (!note?.summary?.trim() || !this.shareable(noteId)) return null;
    const fresh = this.summaryTranslation(noteId, lang);
    if (fresh) return fresh;
    const text = (await this.oneAtATime(() => this.llm.complete(translateSummaryMessages({ language: lang, text: note.summary }), { temperature: 0.1, signal }))).trim();
    if (!text) throw new Error('The model returned an empty translation.');
    this.db.prepare(`INSERT INTO note_translations(note_id, lang, field, text, src_hash, created_at) VALUES(?, ?, 'summary', ?, ?, ?)
      ON CONFLICT(note_id, lang, field) DO UPDATE SET text = excluded.text, src_hash = excluded.src_hash, created_at = excluded.created_at`).run(noteId, lang, text, hashText(note.summary), Date.now());
    return { lang, text };
  }

  // Can this language be translated now? Throws an error with the HTTP status that says why.
  check(lang) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    if (!this.options().enabled) throw fail(409, 'Translation is turned off. Turn it on in Settings → Translation.');
    if (!isLanguage(lang)) throw fail(400, `Unknown language "${lang}".`);
    if (!this.settings.get('llm').baseUrl) throw fail(409, 'No AI server is set up. Add one in Settings → AI.');
  }

  // ---- jobs: one per note and language, in the background ----
  // -> { total, running, promise }; running: a job for this note and language was already going and this call joined it
  start(noteId, lang) {
    this.check(lang);
    const key = `${noteId}|${lang}`;
    const live = this.jobs.get(key);
    if (live) return { total: live.total, running: true, promise: live.promise };
    const total = this.pending(noteId, lang).length;
    if (!total) return { total: 0, running: false, promise: Promise.resolve({ total: 0, done: 0, failed: 0 }) };
    const job = { total, done: 0, ctl: new AbortController() };
    job.promise = this.translateNote(noteId, lang, { signal: job.ctl.signal, onProgress: (done) => { job.done = done; } })
      .then((r) => { this.bus?.publish('translation.done', { noteId, lang, ...r }); return r; })
      .catch((e) => {
        if (!job.ctl.signal.aborted && e.name !== 'AbortError') this.bus?.publish('translation.failed', { noteId, lang, message: e.message });
        return { total, done: job.done, failed: total - job.done, error: e.message };
      })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    this.bus?.publish('translation.started', { noteId, lang, total });
    return { total, running: false, promise: job.promise };
  }

  running(noteId) {
    return [...this.jobs].filter(([k]) => k.startsWith(`${noteId}|`)).map(([k, j]) => ({ lang: k.slice(noteId.length + 1), total: j.total, done: j.done }));
  }

  cancel(noteId, lang) { this.jobs.get(`${noteId}|${lang}`)?.ctl.abort(); }

  // ---- while recording ----
  // Listen to the recording: each line heard is translated into the first language chosen, if live translation is on; when the
  // recording stops, whatever the live pass dropped or missed is translated as a normal job. -> unsubscribe
  attach() {
    return this.bus.subscribe((e) => {
      if (e.type === 'transcript.segment') this.hear(e.data.noteId, e.data.segment);
      else if (e.type === 'recording.stopped') this.catchUp(e.data.noteId);
    });
  }

  liveLanguage() {
    const o = this.options();
    return o.enabled && o.live && o.targets.length && this.settings.get('llm').baseUrl ? o.targets[0] : null;
  }

  hear(noteId, segment) {
    const lang = this.liveLanguage();
    if (!lang || !segment || !needsTranslation(segment.text) || !this.shareable(noteId)) return;
    this.queue.push({ noteId, id: segment.id, text: segment.text, lang });
    while (this.queue.length > LIVE_BACKLOG) this.queue.shift();   // the AI is behind the talk: the oldest wait for Stop
    this.pumping ||= this.pump().finally(() => { this.pumping = null; });
  }

  // One request at a time, a few lines each, newest context from what was just translated. Never throws.
  async pump() {
    while (this.queue.length) {
      const first = this.queue.shift();
      const rows = [first];
      while (rows.length < LIVE_BATCH && this.queue[0]?.noteId === first.noteId && this.queue[0].lang === first.lang) rows.push(this.queue.shift());
      try {
        const got = await this.ask(rows, first.lang, this.recent.get(first.noteId) || [], undefined);
        for (const r of rows) {
          if (!got.has(r.id)) continue;
          try { this.save(r.id, first.lang, got.get(r.id), r.text); } catch { continue; }   // the line is gone (the speaker pass cut it)
          this.bus?.publish('translation.segment', { noteId: first.noteId, segmentId: r.id, lang: first.lang, text: got.get(r.id) });
        }
        this.recent.set(first.noteId, rows.map((r) => r.text).slice(-CONTEXT_LINES));
      } catch (e) {
        if (!this.warned.has(first.noteId)) { this.warned.add(first.noteId); this.bus?.publish('recording.warning', { message: `Live translation: ${e.message}` }); }
      }
    }
  }

  idle() { return this.pumping || Promise.resolve(); }

  async catchUp(noteId) {
    this.recent.delete(noteId);
    this.warned.delete(noteId);
    const lang = this.liveLanguage();
    if (!lang) return;
    this.queue = this.queue.filter((q) => q.noteId !== noteId);   // what is still waiting is done below, in order
    await this.idle();
    try { await this.start(noteId, lang).promise; } catch { /* turned off or no AI meanwhile: nothing to catch up */ }
  }
}

module.exports = { Translator, translateMessages, translateSummaryMessages, parseTranslations, needsTranslation, hashText };
