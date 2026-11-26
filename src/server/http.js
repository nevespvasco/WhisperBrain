'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeAudio, transcribePcm, assignSpeakers } = require('../recording/import');
const { refineNote } = require('../speakers/refine');
const { diarizeChannel } = require('../speakers/final');
const { diarizeOwned } = require('../speakers/owned');
const { nameFromTranscript } = require('../speakers/transcript-names');
const { LANGUAGES, isLanguage } = require('../llm/languages');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const COOKIE = 'wb_token';
const { mayPass } = require('../core/lock');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_AUDIO = 1024 * 1024 * 1024;

const { noticeText } = require('../consent/notice');
const { attachTranscript } = require('../meet/attach');
const { MAX_TEXT_BYTES } = require('../importers');
const noticeRoute = (app, query) => ({ text: noticeText({ preset: query.preset || app.settings.get('consentPreset'), lang: query.lang || app.settings.get('language') }) });

// speaker ids: m1 (microphone), s1 (system audio), d<snowflake> (a person on Discord)
const SPEAKER_ID = /^(?:[ms]\d{1,3}|d\d{1,24})$/;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, 'request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
}

function startSse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  return {
    signal: ac.signal,
    send(event, data) { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (!res.writableEnded) res.end(); },
  };
}

// Server-Sent Events carrying a streamed LLM answer: events `delta`, `stage`, then `done` or `error`.
async function streamJob(req, res, job) {
  const sse = startSse(req, res);
  try {
    const result = await job(sse);
    sse.send('done', result ?? {});
  } catch (e) {
    if (!sse.signal.aborted) sse.send('error', { message: e.message, code: e.code });
  }
  sse.end();
}

// Filenames may hold any character (meeting titles); headers may not. ASCII fallback + RFC 5987 UTF-8 name.
function disposition(name) {
  const ascii = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function createRoutes(app) {
  const r = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    r.push({ method, re, keys, handler });
  };
  const noteOr404 = (id) => { const n = app.notes.get(id); if (!n) throw new HttpError(404, 'note not found'); return n; };

  add('GET', '/api/state', async () => app.state());
  add('GET', '/api/setup', async () => app.setup());
  add('GET', '/api/settings', async () => app.settings.publicView());
  add('PUT', '/api/settings', async ({ body }) => { try { return app.settings.update(body); } catch (e) { throw new HttpError(400, e.message); } });

  // notes
  add('GET', '/api/notes', async ({ query }) => {
    if (query.q) return app.notes.search(query.q, Number(query.limit) || 30).map((h) => ({ ...h.note, snippet: h.snippet }));
    return app.notes.list({ folderId: query.folder, limit: Number(query.limit) || 200, before: Number(query.before) || undefined, pinnedFirst: true });
  });
  add('POST', '/api/notes', async ({ body }) => app.notes.create({ source: 'manual', ...body }));
  add('GET', '/api/notes/:id', async ({ params }) => noteOr404(params.id));
  add('PATCH', '/api/notes/:id', async ({ params, body }) => { noteOr404(params.id); try { return app.notes.update(params.id, body); } catch (e) { throw new HttpError(400, e.message); } });
  add('DELETE', '/api/notes/:id', async ({ params }) => {
    if (app.recording.status().noteId === params.id) throw new HttpError(409, 'stop the recording first');
    if (!app.notes.remove(params.id)) throw new HttpError(404, 'note not found');
    return { ok: true };
  });
  add('GET', '/api/notes/:id/transcript', async ({ params, query }) => {
    noteOr404(params.id);
    const segs = app.notes.segments(params.id);
    if (!query.lang) return segs;
    if (!isLanguage(query.lang)) throw new HttpError(400, `Unknown language "${query.lang}".`);
    const said = app.translator.translations(params.id, query.lang);   // each line beside its translation (null: not translated yet)
    return segs.map((s) => ({ ...s, translation: said.get(s.id) ?? null }));
  });

  // translation (Settings → Translation): off until switched on; the work runs in the background and reports on the event stream
  const translating = (fn) => async (ctx) => { try { return await fn(ctx); } catch (e) { throw e instanceof HttpError || !e.status ? e : new HttpError(e.status, e.message); } };
  add('GET', '/api/languages', async () => LANGUAGES);
  add('POST', '/api/notes/:id/translate', translating(async ({ params, body }) => {
    noteOr404(params.id);
    const job = app.translator.start(params.id, body.lang);
    return job.running ? { started: false, running: true, total: job.total } : { started: job.total > 0, total: job.total };
  }));
  add('POST', '/api/notes/:id/translate/cancel', async ({ params, body }) => { noteOr404(params.id); app.translator.cancel(params.id, body.lang); return { ok: true }; });
  add('GET', '/api/notes/:id/translations', async ({ params }) => { noteOr404(params.id); return { languages: app.translator.languages(params.id), running: app.translator.running(params.id) }; });
  add('DELETE', '/api/notes/:id/translations/:lang', async ({ params }) => { noteOr404(params.id); app.translator.clear(params.id, params.lang); return { ok: true }; });
  add('GET', '/api/notes/:id/summary-translation', async ({ params, query }) => {
    noteOr404(params.id);
    if (!isLanguage(query.lang)) throw new HttpError(400, `Unknown language "${query.lang}".`);
    return { lang: query.lang, text: app.translator.summaryTranslation(params.id, query.lang)?.text ?? null };
  });
  add('POST', '/api/notes/:id/summary-translation', translating(async ({ params, body }) => {
    noteOr404(params.id);
    app.translator.check(body.lang);
    if (!app.notes.get(params.id).summary?.trim()) throw new HttpError(409, 'There are no notes to translate yet: write them first.');
    try { return await app.translator.translateSummary(params.id, body.lang); } catch (e) { throw new HttpError(502, `The AI server did not translate: ${e.message}`); }
  }));
  add('DELETE', '/api/notes/:id/transcript', async ({ params }) => { noteOr404(params.id); app.notes.clearTranscript(params.id); return { ok: true }; });
  add('POST', '/api/notes/:id/summarize', async ({ params, body, req, res }) => {
    noteOr404(params.id);
    return { stream: (sse) => app.ai.summarize(params.id, {
      templateId: body.templateId, language: body.language && isLanguage(body.language) ? body.language : undefined, signal: sse.signal,
      onDelta: (d) => sse.send('delta', { text: d }), onStage: (s) => sse.send('stage', s),
    }) };
  });
  add('POST', '/api/notes/:id/title', async ({ params }) => { noteOr404(params.id); return app.ai.autoTitle(params.id); });
  add('POST', '/api/notes/:id/import-audio', async ({ params, req, query }) => {
    noteOr404(params.id);
    if (app.recording.status().active) throw new HttpError(409, 'a recording is in progress');
    const buf = await readBody(req, MAX_AUDIO);
    if (!buf.length) throw new HttpError(400, 'empty audio');
    let model;
    try { model = await app.recording.ensureEngine('batch'); } catch (e) { throw new HttpError(e.code === 'no-model' ? 412 : 500, e.message, e.code); }
    let pcm;
    try { pcm = await decodeAudio(buf, query.filename, { engine: app.engine }); } catch (e) { throw new HttpError(415, e.message); }
    const segs = await transcribePcm(app.engine, pcm);
    const labelled = assignSpeakers(params.id, segs, app.speakers, { threshold: app.settings.get('speakerThreshold') });
    const saved = app.notes.addSegments(params.id, labelled);
    const prefs = app.settings.all();
    let diarized = false;
    const alt = app.recording.altVoiceModel();
    if (prefs.speakerDetection && prefs.speakerDiarize && saved.length && app.models.segmentationInstalled() && app.models.speakerInstalled()) { // who spoke when, word by word
      try {
        diarized = !!await diarizeChannel({ ...(prefs.speakerPipeline === 'owned' ? { diarize: diarizeOwned } : {}), notes: app.notes, speakers: app.speakers, noteId: params.id, channel: 'system', source: { pcm }, stretches: [{ at: 0, ms: 0 }], segIds: saved.map((x) => x.id),
          segmentation: app.models.segmentationPath(), embedding: app.models.speakerPath(), altEmbedding: alt?.path, altModel: alt?.id, threads: prefs.asrThreads });
      } catch (e) { console.warn('speaker diarization failed:', e.message); }
    }
    if (prefs.speakerDetection && prefs.speakerRefine && saved.length) { // a second, acoustic look (pitch, timbre) at who spoke
      const refs = saved.map((x) => ({ segId: x.id, ch: 'system', from: Math.round(x.startMs * 16), to: Math.round(x.endMs * 16) }));
      try { await refineNote({ speakers: app.speakers, noteId: params.id, refs, read: (_ch, from, to) => pcm.subarray(from * 2, to * 2), threshold: prefs.speakerThreshold }); } catch (e) { console.warn('speaker analysis failed:', e.message); }
    }
    app.speakers.consolidate(params.id, app.settings.get('speakerThreshold'), { channels: diarized ? ['mic'] : ['mic', 'system'] });
    app.speakers.autoMatch(params.id);
    app.notes.update(params.id, { status: 'done', endedAt: Date.now() });
    app.notes.reindex(params.id);
    return { segments: saved.length, durationMs: Math.round((pcm.length / 2 / 16000) * 1000), model: model.id };
  });

  // search by words and by meaning together (opt-in, see src/search/semantic.js); without the index it is the word search
  add('GET', '/api/search/semantic', async ({ query }) => {
    const rows = await app.semantic.hybrid(query.q || '', { limit: Number(query.limit) || 20 });
    return { available: app.semantic.available, reason: app.semantic.reason, results: rows.map((r) => ({ ...r.note, snippet: r.snippet, via: r.via })) };
  });

  // advanced search
  add('GET', '/api/search', async ({ query }) => app.notes.advancedSearch({
    q: query.q || '', scope: query.scope || 'all', folderId: query.space || undefined, from: query.from, to: query.to,
    speaker: query.speaker || undefined, attendee: query.attendee || undefined, has: query.has || undefined, limit: Number(query.limit) || 50,
  }).map((r) => ({ ...r.note, snippet: r.snippet, quotes: r.quotes })));

  // a platform's own transcript (Teams / Zoom / Meet export): its speaker names become evidence for the voices
  add('POST', '/api/notes/:id/attach-transcript', async ({ params, req, query }) => {
    noteOr404(params.id);
    if (app.recording.status().active) throw new HttpError(409, 'a recording is in progress');
    const buf = await readBody(req, MAX_TEXT_BYTES);
    if (!buf.length) throw new HttpError(400, 'empty file');
    try { return attachTranscript(app, params.id, buf, query.filename); } catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
  });

  // the meeting platforms' own transcripts (Teams, Meet, Zoom): sign in once, then fetch a note's transcript. Experimental, see src/transcripts.
  const transcriptError = (e) => {
    if (e.status) return new HttpError(e.status, e.message);
    const status = { unknown: 400, 'not-connected': 409, auth: 409 }[e.code] ?? (e.code ? 422 : 0);
    return status ? new HttpError(status, e.message, e.code) : e;
  };
  add('GET', '/api/transcript-sources', async () => app.transcripts.status());
  add('POST', '/api/transcript-sources/:id/connect', async ({ params }) => {
    try { const { authUrl, done } = await app.transcripts.connect(params.id, { openExternal: app.openExternal }); done.then(() => app.bus.publish('transcript-source.connected', { id: params.id }), (e) => app.bus.publish('transcript-source.error', { id: params.id, message: e.message })); return { authUrl }; }
    catch (e) { throw new HttpError(e.code === 'unknown' ? 404 : 400, e.message); }
  });
  add('DELETE', '/api/transcript-sources/:id', async ({ params }) => { try { await app.transcripts.disconnect(params.id); return { ok: true }; } catch (e) { throw transcriptError(e); } });
  add('POST', '/api/notes/:id/fetch-transcript', async ({ params, body }) => {
    noteOr404(params.id);
    if (app.recording.status().active) throw new HttpError(409, 'a recording is in progress');
    try { return await app.transcripts.fetchForNote(params.id, String(body.provider || '')); } catch (e) { throw transcriptError(e); }
  });

  // the "this call is recorded" notice, to paste into the meeting chat
  add('GET', '/api/consent/notice', async ({ query }) => noticeRoute(app, query));

  // speakers (who is talking) and saved voices
  add('GET', '/api/notes/:id/speakers', async ({ params }) => {
    noteOr404(params.id);
    // a name that came from the conversation says which line it was read from (evidenceQuote, evidenceMs)
    const said = new Map(app.evidence.forNote(params.id, { kind: 'mention' }).map((r) => [r.meta?.speakerId, r]));
    return app.speakers.publicForNote(params.id, app.settings.get('userName')).map((s) => {
      const e = /^transcript/.test(s.nameSource || '') ? said.get(s.speakerId) : null;
      return e ? { ...s, evidenceQuote: e.meta.quote, evidenceMs: e.t0 } : s;
    });
  });
  // ask the AI who the unnamed voices are, from what people say; a name stands only with the line that shows it
  add('POST', '/api/notes/:id/speakers/guess-names', async ({ params }) => {
    noteOr404(params.id);
    if (!app.ai.configured()) throw new HttpError(409, 'No AI server is set up. Add one in Settings → AI.');
    const r = await nameFromTranscript({ notes: app.notes, speakers: app.speakers, evidence: app.evidence, llm: app.scheduler.client('background'), userName: app.settings.get('userName') }, params.id);
    if (r.error) throw new HttpError(502, `The AI server did not answer: ${r.error}`);
    if (r.named.length) app.notes.reindex(params.id);
    return { named: r.named.map(({ speakerId, name, line, quote }) => ({ speakerId, name, line, quote })), refused: r.refuted.length };
  });
  // turn down a guessed name: the voice goes back to unnamed and the name is not offered for it again
  add('POST', '/api/notes/:id/speakers/:sid/reject-name', async ({ params }) => {
    noteOr404(params.id);
    if (!app.speakers.rejectName(params.id, params.sid, { evidence: app.evidence })) throw new HttpError(409, 'This name was not guessed from the conversation.');
    app.notes.reindex(params.id);
    return { ok: true };
  });
  add('PATCH', '/api/notes/:id/speakers/:sid', async ({ params, body }) => {
    noteOr404(params.id);
    const r = app.speakers.rename(params.id, params.sid, body.name, { remember: !!body.remember, consentSource: body.remember ? 'user' : null });
    if (!r) throw new HttpError(404, 'speaker not found');
    app.notes.reindex(params.id);
    return r;
  });
  // "Ana?": the user confirms or declines a saved voice the speaker was suggested (not sure enough to be linked by itself)
  add('POST', '/api/notes/:id/speakers/:sid/suggestion', async ({ params, body }) => {
    noteOr404(params.id);
    const r = app.speakers.answerSuggestion(params.id, params.sid, !!body.accept);
    if (!r) throw new HttpError(409, 'There is no suggestion for this speaker.');
    app.notes.reindex(params.id);
    return r;
  });
  add('POST', '/api/notes/:id/segments/:segId/speaker', async ({ params, body }) => {
    noteOr404(params.id);
    if (!SPEAKER_ID.test(body.speakerId || '')) throw new HttpError(400, 'invalid speakerId');
    if (!app.speakers.reassignSegment(params.id, Number(params.segId), body.speakerId)) throw new HttpError(404, 'segment not found');
    return { ok: true };
  });
  // fold one speaker of the note into another (the same person heard twice); refused when the voices clearly differ
  add('POST', '/api/notes/:id/speakers/:sid/merge', async ({ params, body }) => {
    noteOr404(params.id);
    if (!SPEAKER_ID.test(params.sid) || !SPEAKER_ID.test(body.into || '') || params.sid === body.into) throw new HttpError(400, 'invalid speaker');
    if (!app.speakers.mergeSpeakers(params.id, params.sid, body.into)) throw new HttpError(409, 'These speakers cannot be merged: they are on different channels, sound too different, or already have different names.');
    app.notes.reindex(params.id);
    return { ok: true };
  });
  add('GET', '/api/voices', async () => app.speakers.publicVoices());
  add('PATCH', '/api/voices/:id', async ({ params, body }) => ({ ok: app.speakers.renameVoice(params.id, body.name || '') }));
  add('DELETE', '/api/voices/:id', async ({ params }) => ({ ok: app.speakers.removeVoice(params.id) }));
  add('POST', '/api/speaker-model/install', async () => {
    app.models.installSpeakerModels().catch((e) => app.bus.publish('model.error', { id: 'speaker-voice', message: e.message }));
    return { started: true };
  });

  // account + danger zone
  add('GET', '/api/account', async () => app.account.summary());
  add('GET', '/api/account/export', async ({ query }) => {
    const day = new Date().toISOString().slice(0, 10);
    if (query.format === 'md') return { raw: app.account.exportMarkdown(), type: 'text/markdown; charset=utf-8', filename: `whisperbrain-${day}.md` };
    return { raw: JSON.stringify(app.account.exportJson(), null, 2), type: 'application/json', filename: `whisperbrain-${day}.json` };
  });
  const confirmed = (body, word) => { if (body.confirm !== word) throw new HttpError(400, `type ${word} to confirm`); };
  add('POST', '/api/account/delete-transcripts', async ({ body }) => { confirmed(body, 'DELETE'); if (app.recording.status().active) throw new HttpError(409, 'stop the recording first'); return { deleted: app.account.deleteTranscripts() }; });
  add('POST', '/api/account/delete-voices', async ({ body }) => { confirmed(body, 'DELETE'); return { deleted: app.account.deleteVoices() }; });
  add('POST', '/api/account/delete-everything', async ({ body }) => {
    confirmed(body, 'DELETE EVERYTHING');
    if (app.recording.status().active) throw new HttpError(409, 'stop the recording first');
    return { ok: app.account.deleteEverything({ removeModels: !!body.removeModels }) };
  });

  // spaces (stored as folders)
  add('GET', '/api/spaces', async () => { const counts = app.notes.folderCounts(); return app.notes.folders().map((f) => ({ ...f, notes: counts[f.id] || 0 })); });
  add('POST', '/api/spaces', async ({ body }) => { try { return app.notes.createFolder(body.name); } catch (e) { throw new HttpError(400, e.message); } });
  add('PATCH', '/api/spaces/:id', async ({ params, body }) => { if (!String(body.name || '').trim()) throw new HttpError(400, 'name required'); return { ok: app.notes.renameFolder(params.id, body.name) }; });
  add('DELETE', '/api/spaces/:id', async ({ params }) => ({ ok: app.notes.removeFolder(params.id) }));

  // folders
  add('GET', '/api/folders', async () => app.notes.folders());
  add('POST', '/api/folders', async ({ body }) => { try { return app.notes.createFolder(body.name); } catch (e) { throw new HttpError(400, e.message); } });
  add('PATCH', '/api/folders/:id', async ({ params, body }) => ({ ok: app.notes.renameFolder(params.id, body.name || '') }));
  add('DELETE', '/api/folders/:id', async ({ params }) => ({ ok: app.notes.removeFolder(params.id) }));

  // templates
  add('GET', '/api/templates', async () => app.templates.list());
  add('POST', '/api/templates', async ({ body }) => { try { return app.templates.create(body); } catch (e) { throw new HttpError(400, e.message); } });
  add('PATCH', '/api/templates/:id', async ({ params, body }) => { try { return app.templates.update(params.id, body) || (() => { throw new HttpError(404, 'template not found'); })(); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); } });
  add('DELETE', '/api/templates/:id', async ({ params }) => { try { return { ok: app.templates.remove(params.id) }; } catch (e) { throw new HttpError(400, e.message); } });

  // chat
  add('GET', '/api/chat', async ({ query }) => app.notes.chatHistory(query.noteId || null));
  add('DELETE', '/api/chat', async ({ query }) => { app.notes.clearChat(query.noteId || null); return { ok: true }; });
  add('POST', '/api/chat', async ({ body }) => {
    if (body.noteId) noteOr404(body.noteId);
    return { stream: (sse) => app.ai.chat(body.noteId || null, body.question, { signal: sse.signal, onDelta: (d) => sse.send('delta', { text: d }) }) };
  });

  // recording
  add('GET', '/api/recording', async () => app.recording.status());
  add('POST', '/api/recording/start', async ({ body }) => {
    let noteId = body.noteId;
    if (!noteId) noteId = app.notes.create({ title: body.title || '', eventUid: body.eventUid, eventStart: body.eventStart, attendees: body.attendees, templateId: body.templateId, folderId: body.folderId, platform: body.platform }).id;
    else if (app.notes.get(noteId)?.source === 'manual') app.notes.update(noteId, { source: 'recorded' });
    // calls: the live calls the person chose to record (ids such as 'zoom', 'discord'), turned into the applications behind them
    const apps = Array.isArray(body.calls) && body.calls.length ? app.detector.appsFor?.(body.calls.map(String)) : undefined;
    const wholeOutput = Array.isArray(body.calls) && !body.calls.length; // [] = the person chose everything the computer plays
    try { return await app.recording.start(noteId, { mic: body.mic, system: body.system, apps: apps?.length ? apps : undefined, wholeOutput }); } catch (e) {
      throw new HttpError({ 'no-model': 412, busy: 409, 'not-found': 404 }[e.code] || 500, e.message, e.code);
    }
  });
  add('POST', '/api/recording/pause', async () => app.recording.pause());
  add('POST', '/api/recording/resume', async () => app.recording.resume());
  // mute / unmute the user's own microphone in the middle of a meeting; without `muted` it toggles
  add('POST', '/api/recording/mic-mute', async ({ body }) => {
    if (body.muted !== undefined && typeof body.muted !== 'boolean') throw new HttpError(400, 'muted must be true or false');
    try { return app.recording.setMicMuted(body.muted ?? !app.recording.status().micMuted); } catch (e) { throw new HttpError(409, e.message, e.code); }
  });
  add('POST', '/api/recording/stop', async () => { try { return await app.recording.stop(); } catch (e) { throw new HttpError(409, e.message, e.code); } });
  add('POST', '/api/recording/pcm', async ({ req, query }) => {
    const buf = await readBody(req, 4 * 1024 * 1024);
    const ok = app.recording.pushPcm(query.noteId, query.ch === 'system' ? 'system' : 'mic', buf);
    return { ok };
  });
  add('GET', '/api/audio/devices', async () => ({ mics: await app.platform.listMics() }));

  // dictation
  add('GET', '/api/dictation', async () => app.dictation.status());
  add('POST', '/api/dictation/toggle', async () => { try { return await app.dictation.toggle(); } catch (e) { throw new HttpError(412, e.message); } });
  add('POST', '/api/dictation/pcm', async ({ req }) => ({ ok: app.dictation.pushPcm(await readBody(req, 4 * 1024 * 1024)) }));

  // models
  add('GET', '/api/models', async () => app.models.list());
  add('POST', '/api/models/:id/install', async ({ params }) => {
    if (!app.models.catalog.some((m) => m.id === params.id)) throw new HttpError(404, 'unknown model');
    app.models.install(params.id).catch((e) => app.bus.publish('model.error', { id: params.id, message: e.message }));
    return { started: true };
  });
  add('POST', '/api/models/:id/cancel', async ({ params }) => { app.models.cancel(params.id); return { ok: true }; });
  add('DELETE', '/api/models/:id', async ({ params }) => { app.models.remove(params.id); return { ok: true }; });

  // llm
  add('GET', '/api/llm/models', async () => { try { return { models: await app.llm.listModels() }; } catch (e) { throw new HttpError(502, e.message, e.code); } });
  add('POST', '/api/llm/test', async () => app.llm.test());

  // calendar
  add('GET', '/api/calendar/events', async ({ query }) => {
    const now = Date.now();
    return app.calendar.events({ from: Number(query.from) || now - 3600000, to: Number(query.to) || now + 7 * 86400000, force: query.refresh === '1' });
  });
  add('POST', '/api/calendar/sources', async ({ body }) => { try { return app.calendar.addSource(body); } catch (e) { throw new HttpError(400, e.message); } });
  add('DELETE', '/api/calendar/sources/:id', async ({ params }) => { app.calendar.removeSource(params.id); return { ok: true }; });
  add('GET', '/api/calendar/current', async () => ({ event: await app.calendar.current() }));

  require('./routes-brain')(add, app, { HttpError, readBody });   // before the knowledge routes: /api/people/proposals must not be read as a person's key
  require('./routes-knowledge')(add, app, { HttpError, noteOr404, readBody });
  require('./routes-briefings')(add, app, { HttpError, noteOr404, readBody });
  require('./routes-assistant')(add, app, { HttpError, noteOr404, readBody });
  require('./routes-meet')(add, app, { HttpError });
  require('./routes-jobs')(add, app, { HttpError });

  // events (SSE)
  add('GET', '/api/events', async ({ req, res }) => {
    const sse = startSse(req, res);
    const off = app.bus.subscribe((e) => sse.send(e.type, e.data));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => { off(); clearInterval(ping); });
    return { handled: true };
  });
  return r;
}

function createServer(app, { uiDir, token = crypto.randomBytes(24).toString('hex') } = {}) {
  const routes = createRoutes(app);
  let port = 0;
  const hostOk = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (!hostOk(req.headers.host)) throw new HttpError(403, 'bad host');
      const cookies = parseCookies(req.headers.cookie);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      // Entry point: ?token= sets the cookie, then redirects to a clean URL.
      if (url.searchParams.has('token') && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (!safeEqual(url.searchParams.get('token'), token)) throw new HttpError(401, 'bad token');
        url.searchParams.delete('token');
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: url.pathname + url.search });
        return res.end();
      }
      const authed = [cookies[COOKIE], bearer, req.headers['x-wb-token']].some((t) => t && safeEqual(t, token));
      if (!authed) throw new HttpError(401, 'unauthorized');
      if (req.method !== 'GET' && req.headers.origin && !hostOk(new URL(req.headers.origin).host)) throw new HttpError(403, 'cross-origin request refused');

      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[server]', e);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, code: e.code }));
      } else res.end();
    }
  }

  async function api(req, res, url) {
    const query = Object.fromEntries(url.searchParams);
    // the app lock: while locked, nothing but the lock itself (and the audio of a recording already running) is answered
    if (app.lock) {
      if (app.lock.locked() && !mayPass(req.method, url.pathname)) throw new HttpError(423, 'The app is locked.', 'locked');
      if (!/^\/api\/(events|lock)/.test(url.pathname)) app.lock.touch();
    }
    for (const rt of routes) {
      if (rt.method !== req.method) continue;
      const m = rt.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) && /json/.test(req.headers['content-type'] || '') ? await readJson(req) : {};
      const out = await rt.handler({ req, res, params, query, body });
      if (out?.handled) return;
      if (out?.stream) return streamJob(req, res, out.stream);
      if (out?.raw !== undefined) { res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': disposition(out.filename) }); return res.end(out.raw); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out ?? null));
    }
    throw new HttpError(404, 'not found');
  }

  function serveStatic(res, pathname) {
    if (!uiDir) throw new HttpError(404, 'no UI');
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(uiDir, rel);
    if (!file.startsWith(path.resolve(uiDir) + path.sep)) throw new HttpError(403, 'forbidden');
    let data;
    try { data = fs.readFileSync(file); } catch { throw new HttpError(404, 'not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return {
    server, token,
    listen(wantedPort = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantedPort, '127.0.0.1', () => { port = server.address().port; resolve({ port, url: `http://127.0.0.1:${port}`, token }); });
      });
    },
    close() { return new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}

module.exports = { createServer, HttpError };
