'use strict';
// HTTP routes for the knowledge layer, exports/imports and integrations. Registered by http.js.
const { FORMATS, fileName, toHtml } = require('../knowledge/meeting');
const { zip } = require('../core/zip-writer');
const { isLanguage } = require('../llm/languages');

const MAX_IMPORT = 1024 * 1024 * 1024;

module.exports = function knowledgeRoutes(add, app, { HttpError, noteOr404, readBody }) {
  const k = app.knowledge;
  const wrap = (fn) => async (ctx) => {
    try { return await fn(ctx); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(e.status || (/required|invalid|must|already|unsupported/i.test(e.message) ? 400 : 502), e.message, e.code);
    }
  };
  const r = (method, pattern, fn) => add(method, pattern, wrap(fn));
  const bool = (v) => (v === undefined ? undefined : v === '1' || v === 'true');
  // An export (or a send) with the translation: `lang` and `translation` ('translation' = in place of the words, 'both' = under them).
  // Without both, the meeting as it was said.
  const withTranslation = (o = {}) => {
    if (o.translation !== undefined && !['translation', 'both'].includes(o.translation)) throw new HttpError(400, 'translation must be "translation" or "both"');
    if (o.lang !== undefined && !isLanguage(o.lang)) throw new HttpError(400, `Unknown language "${o.lang}".`);
    return o.lang && o.translation ? { lang: o.lang, mode: o.translation } : {};
  };

  // ---- enriched lists ----
  r('GET', '/api/meetings', async ({ query }) => {
    const notes = query.q ? app.notes.search(query.q, Number(query.limit) || 60).map((h) => ({ ...h.note, snippet: h.snippet }))
      : app.notes.list({ folderId: query.space || undefined, source: query.source || undefined, tagId: query.tag || undefined, limit: Number(query.limit) || 300, order: query.sort, pinnedFirst: query.sort !== 'oldest' && query.sort !== 'title' });
    let cards = k.cards(notes);
    if (query.q && (query.source || query.tag)) cards = cards.filter((c) => (!query.source || (query.source === 'imported' ? !['recorded', 'manual'].includes(c.source) : c.source === query.source)) && (!query.tag || c.tags.some((t) => t.id === query.tag)));
    if (query.external === '1') cards = cards.filter((c) => c.external === true);
    if (query.external === '0') cards = cards.filter((c) => c.external === false);
    return cards;
  });
  r('GET', '/api/notes/:id/overview', async ({ params }) => {
    const n = noteOr404(params.id);
    return {
      note: n, card: k.cards([n])[0], tags: k.noteTags(n.id), topics: k.noteTopics(n.id), actions: k.actionItems({ noteId: n.id }), snippets: k.snippets({ noteId: n.id }),
      links: k.links(n.id), analytics: k.analytics(n.id), glossary: k.termsInNote(n.id), related: k.related(n.id),
    };
  });
  r('GET', '/api/notes/:id/related', async ({ params }) => { noteOr404(params.id); return k.related(params.id); });
  r('GET', '/api/notes/:id/analytics', async ({ params }) => { noteOr404(params.id); return k.analytics(params.id); });

  // ---- insights ----
  r('POST', '/api/notes/:id/insights', async ({ params, body }) => { noteOr404(params.id); return app.ai.insights(params.id, { local: !!body.local }); });

  // ---- tags ----
  r('GET', '/api/tags', async () => k.tags());
  r('POST', '/api/tags', async ({ body }) => k.createTag(body.name, body.color));
  r('PATCH', '/api/tags/:id', async ({ params, body }) => k.updateTag(params.id, body) || (() => { throw new HttpError(404, 'tag not found'); })());
  r('DELETE', '/api/tags/:id', async ({ params }) => ({ ok: k.removeTag(params.id) }));
  r('PUT', '/api/notes/:id/tags', async ({ params, body }) => { noteOr404(params.id); return k.setNoteTags(params.id, body.tags || []); });

  // ---- action items ----
  r('GET', '/api/actions', async ({ query }) => k.actionItems({ noteId: query.noteId, done: bool(query.done), owner: query.owner, q: query.q, limit: Number(query.limit) || 300 }));
  r('POST', '/api/notes/:id/actions', async ({ params, body }) => { noteOr404(params.id); return k.addAction(params.id, body); });
  r('PATCH', '/api/actions/:id', async ({ params, body }) => k.updateAction(params.id, body) || (() => { throw new HttpError(404, 'action item not found'); })());
  r('DELETE', '/api/actions/:id', async ({ params }) => ({ ok: k.removeAction(params.id) }));

  // ---- snippets ----
  r('GET', '/api/snippets', async ({ query }) => k.snippets({ noteId: query.noteId }));
  r('POST', '/api/notes/:id/snippets', async ({ params, body }) => { noteOr404(params.id); return k.addSnippet(params.id, body); });
  r('PATCH', '/api/snippets/:id', async ({ params, body }) => ({ ok: k.updateSnippet(params.id, body) }));
  r('DELETE', '/api/snippets/:id', async ({ params }) => ({ ok: k.removeSnippet(params.id) }));

  // ---- topics ----
  r('GET', '/api/topics', async ({ query }) => k.topics({ q: query.q }));
  r('GET', '/api/topics/overview', async ({ query }) => k.topicOverview({ since: Math.max(0, Number(query.since) || 0), limit: Math.min(300, Number(query.limit) || 150) }));
  r('GET', '/api/topics/graph',async ({ query }) => k.topicGraph({ limit: Number(query.limit) || 60 }));
  r('GET', '/api/topics/:id', async ({ params }) => k.topic(params.id) || (() => { throw new HttpError(404, 'topic not found'); })());
  r('PATCH', '/api/topics/:id', async ({ params, body }) => k.updateTopic(params.id, body) || (() => { throw new HttpError(404, 'topic not found'); })());
  r('POST', '/api/topics/:id/merge', async ({ params, body }) => k.mergeTopics(params.id, body.into));
  r('DELETE', '/api/topics/:id', async ({ params }) => ({ ok: k.removeTopic(params.id) }));
  r('POST', '/api/topics/:id/brief', async ({ params }) => ({ stream: (sse) => app.ai.topicBrief(params.id, { signal: sse.signal, onDelta: (d) => sse.send('delta', { text: d }) }) }));
  r('POST', '/api/notes/:id/topics', async ({ params, body }) => { noteOr404(params.id); return k.addNoteTopic(params.id, body.name); });
  r('DELETE', '/api/notes/:id/topics/:tid', async ({ params }) => { noteOr404(params.id); return k.removeNoteTopic(params.id, params.tid); });

  // ---- glossary ----
  r('GET', '/api/glossary', async ({ query }) => k.glossary({ q: query.q }));
  r('POST', '/api/glossary', async ({ body }) => k.upsertTerm({ term: body.term, definition: body.definition, aliases: body.aliases, noteId: body.noteId || null }));
  r('GET', '/api/glossary/:id', async ({ params }) => k.term(params.id) || (() => { throw new HttpError(404, 'term not found'); })());
  r('PATCH', '/api/glossary/:id', async ({ params, body }) => k.updateTerm(params.id, body) || (() => { throw new HttpError(404, 'term not found'); })());
  r('DELETE', '/api/glossary/:id', async ({ params }) => ({ ok: k.removeTerm(params.id) }));

  // ---- people ----
  r('GET', '/api/people', async ({ query }) => k.people({ q: query.q }));
  r('GET', '/api/people/:key', async ({ params }) => k.person(params.key) || (() => { throw new HttpError(404, 'person not found'); })());

  // ---- search ----
  r('GET', '/api/find', async ({ query }) => {
    const kind = query.kind || 'all', q = query.q || '', limit = Number(query.limit) || 40;
    const rows = k.find({ q, kind, from: query.from, to: query.to, sort: query.sort || 'relevance', source: query.source || undefined, limit });
    // notes and files from folders and vaults (src/items) are found next to meetings
    if (q && (kind === 'all' || kind === 'docs') && app.items) {
      for (const it of app.items.list({ q, limit: kind === 'all' ? 8 : limit })) rows.push({ kind: 'doc', id: it.id, title: it.title, snippet: it.snippet || it.preview, at: it.occurredAt, rank: 0, source: it.sourceName });
    }
    return rows;
  });
  r('GET', '/api/quotes', async ({ query }) => k.quotes(query.q || '', { speaker: query.speaker, noteId: query.noteId, from: query.from, to: query.to, limit: Number(query.limit) || 50 }));

  // ---- links ----
  r('GET', '/api/notes/:id/links', async ({ params }) => { noteOr404(params.id); return k.links(params.id); });
  r('POST', '/api/notes/:id/links', async ({ params, body }) => { noteOr404(params.id); return k.addLink(params.id, body); });
  r('DELETE', '/api/links/:id', async ({ params }) => ({ ok: k.removeLink(params.id) }));

  // ---- calendar extras ----
  r('GET', '/api/calendar/prefs', async () => k.eventPrefs());
  r('PUT', '/api/calendar/prefs/:id', async ({ params, body }) => k.setEventCapture(params.id, !!body.capture));
  r('GET', '/api/detector', async () => (typeof app.detector.status === 'function' ? app.detector.status() : { active: false }));

  // ---- export ----
  r('GET', '/api/notes/:id/export', async ({ params, query }) => {
    noteOr404(params.id);
    const fmt = query.format || 'md';
    const m = app.meeting(params.id, withTranslation(query));
    const opts = { transcript: query.transcript !== '0' };
    if (fmt === 'pdf') {
      if (!app.renderPdf) throw new HttpError(501, 'PDF export needs the desktop app; use Print instead.', 'no-pdf');
      return { raw: await app.renderPdf(toHtml(m, opts)), type: 'application/pdf', filename: fileName(m, 'pdf') };
    }
    const f = FORMATS[fmt];
    if (!f) throw new HttpError(400, 'unknown format');
    if (query.inline === '1') return { text: f.render(m, opts), filename: fileName(m, f.ext), type: f.type };
    return { raw: f.render(m, opts), type: f.type, filename: fileName(m, f.ext) };
  });
  // Many meetings at once: one ZIP with one file per meeting (or a single combined JSON).
  r('POST', '/api/export', async ({ body }) => {
    const ids = (body.ids?.length ? body.ids : app.notes.list({ limit: 5000 }).map((n) => n.id)).slice(0, 5000);
    const fmt = body.format || 'md';
    const f = FORMATS[fmt];
    if (!f) throw new HttpError(400, 'unknown format');
    const day = new Date().toISOString().slice(0, 10);
    const shown = withTranslation(body);
    const files = ids.map((id) => app.meeting(id, shown)).filter(Boolean).map((m) => ({ name: fileName(m, f.ext), data: f.render(m, { transcript: body.transcript !== false, frontmatter: fmt === 'obsidian', wikilinks: fmt === 'obsidian' }) }));
    if (!files.length) throw new HttpError(400, 'nothing to export');
    return { raw: zip(files), type: 'application/zip', filename: `whisperbrain-${fmt}-${day}.zip` };
  });

  // ---- send to other tools ----
  // sending can carry the translation too; a language or mode that does not exist is refused as it is for an export
  const sendOptions = (body) => { const shown = withTranslation(body); return { ...body, lang: shown.lang, translation: shown.mode }; };
  r('POST', '/api/notes/:id/send', async ({ params, body }) => { noteOr404(params.id); return app.integrations.send(params.id, sendOptions(body)); });
  r('POST', '/api/send', async ({ body }) => {
    const results = [], options = sendOptions(body);
    for (const id of (body.ids || []).slice(0, 200)) {
      try { results.push({ id, ok: true, ...(await app.integrations.send(id, options)) }); } catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    return { results };
  });

  // ---- import ----
  r('POST', '/api/import', async ({ req, query }) => {
    const buf = await readBody(req, MAX_IMPORT);
    const tags = String(query.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    return app.importer.importFile(buf, query.filename || 'import', { folderId: query.space || undefined, me: query.me || undefined, tags });
  });
  r('POST', '/api/import/text', async ({ body }) => {
    const text = String(body.text || '');
    if (!text.trim()) throw new HttpError(400, 'nothing to import');
    return app.importer.importFile(Buffer.from(text, 'utf8'), `${(body.title || 'Pasted transcript').replace(/[\\/]/g, ' ')}.txt`, { folderId: body.space || undefined });
  });
  r('POST', '/api/import/notion', async ({ body }) => ({ notes: await app.integrations.importNotion(body.ids || [], { folderId: body.space }) }));
  r('POST', '/api/import/obsidian', async ({ body }) => ({ notes: app.integrations.importObsidian(body.paths || [], { folderId: body.space }) }));
  r('POST', '/api/import/linear', async ({ body }) => ({ notes: await app.integrations.importLinear(body.ids || [], { folderId: body.space }) }));

  // ---- integrations ----
  r('GET', '/api/integrations', async () => app.integrations.status());
  // Discord without a bot (the Discord app's local RPC)
  r('GET', '/api/integrations/discord-rpc/status', async () => app.integrations.discordRpcStatus());
  r('POST', '/api/integrations/discord-rpc/authorise', async () => {
    try { await app.discordRpc.authorise(); } catch (e) { throw new HttpError(409, e.message); }
    return app.integrations.discordRpcStatus();
  });
  r('POST', '/api/integrations/discord-rpc/disconnect', async () => {
    app.settings.update({ discordRpc: { ...app.settings.get('discordRpc'), enabled: false, accessToken: '', refreshToken: '' } });
    app.discordRpc.stop();
    return app.integrations.discordRpcStatus();
  });
  r('POST', '/api/integrations/:kind/test', async ({ params }) => app.integrations.test(params.kind));
  r('GET', '/api/integrations/notion/search', async ({ query }) => app.integrations.notion().search(query.q || '', { kind: query.kind || undefined }));
  r('GET', '/api/integrations/linear/teams', async () => app.integrations.linear().teams());
  r('GET', '/api/integrations/linear/search', async ({ query }) => app.integrations.linear().searchIssues(query.q || ''));
  r('GET', '/api/integrations/obsidian/notes', async ({ query }) => app.integrations.obsidian().listNotes({ query: query.q || undefined, folder: query.folder ?? '', limit: 300 }));
  r('POST', '/api/integrations/webhooks/:id/test', async ({ params }) => {
    const hook = app.settings.get('webhooks').find((w) => w.id === params.id);
    if (!hook) throw new HttpError(404, 'webhook not found');
    const { postWebhook } = require('../integrations/webhook');
    return postWebhook({ url: hook.url, secret: hook.secret, payload: { event: 'test', sentAt: new Date().toISOString() } });
  });

  // ---- Google Calendar ----
  r('POST', '/api/google/connect', async ({ body }) => {
    const patch = {};
    if (body.clientId) patch.clientId = String(body.clientId).trim();
    if (body.clientSecret && body.clientSecret !== '********') patch.clientSecret = String(body.clientSecret).trim();
    if (Object.keys(patch).length) app.settings.update({ google: { ...app.settings.get('google'), ...patch } });
    if (!app.settings.get('google').clientId) throw new HttpError(400, 'Add the OAuth client ID from Google Cloud first.');
    app.pendingGoogleAuth?.cancel?.();
    const auth = await app.google.beginAuth({ openExternal: app.openExternal || undefined, gmail: !!body.gmail });
    app.pendingGoogleAuth = auth;
    auth.done.then((r2) => { app.calendar.invalidate?.(); app.bus.publish('google.connected', { email: r2.email, calendars: r2.calendars?.length || 0 }); })
      .catch((e) => app.bus.publish('google.error', { message: e.message }))
      .finally(() => { if (app.pendingGoogleAuth === auth) app.pendingGoogleAuth = null; });
    return { authUrl: auth.authUrl, opened: !!app.openExternal };
  });
  r('GET', '/api/google/calendars', async () => app.google.listCalendars());
  r('PUT', '/api/google/calendars', async ({ body }) => {
    const sel = new Set(body.selected || []);
    const cals = app.settings.get('google').calendars.map((c) => ({ ...c, selected: sel.has(c.id) }));
    app.settings.update({ google: { ...app.settings.get('google'), calendars: cals } });
    app.calendar.invalidate?.();
    return cals;
  });
  r('POST', '/api/google/disconnect', async () => { await app.google.disconnect(); app.calendar.invalidate?.(); return { ok: true }; });
};
