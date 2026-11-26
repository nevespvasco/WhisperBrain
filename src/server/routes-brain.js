'use strict';
// HTTP routes for the brain layer: sources (folders, vaults) and their items, people merges, and the AI-run ledger.
// Registered by http.js BEFORE the knowledge routes, so /api/people/proposals is not read as a person's key.

module.exports = function brainRoutes(add, app, { HttpError }) {
  const object = (b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'expected a JSON object'); return b; };
  const wrap = (fn) => async (ctx) => {
    try { return await fn(ctx); } catch (e) {
      if (e instanceof HttpError || !e.status) throw e;
      throw new HttpError(e.status, e.message, e.code);
    }
  };
  const r = (method, pattern, fn) => add(method, pattern, wrap(fn));
  const source = (id) => { const s = app.items.source(id); if (!s) throw new HttpError(404, 'source not found'); return s; };

  // ---- sources ----
  r('GET', '/api/sources', async () => app.sources.view());
  r('POST', '/api/sources', async ({ body }) => {
    const { path, flavour, name, sensitivity, exclude } = object(body);
    return app.sources.add({ path, flavour, name, sensitivity, exclude: Array.isArray(exclude) ? exclude.map(String) : [] });
  });
  // check a folder before adding it (is it readable, is it an Obsidian vault, how many notes)
  r('POST', '/api/sources/check', async ({ body }) => {
    const { path, flavour } = object(body);
    const { FolderConnector } = require('../connectors/folder');
    return new FolderConnector({ source: { id: 'check', kind: flavour === 'obsidian' ? 'obsidian' : 'folder', config: { path } }, items: app.items }).check();
  });
  r('PATCH', '/api/sources/:id', async ({ params, body }) => {
    const { name, sensitivity, enabled } = object(body);
    source(params.id);
    if (enabled === false) return app.sources.pause(params.id);
    if (enabled === true) app.sources.resume(params.id);
    return app.items.updateSource(params.id, { ...(name !== undefined ? { name } : {}), ...(sensitivity !== undefined ? { sensitivity } : {}) });
  });
  r('POST', '/api/sources/:id/sync', async ({ params }) => { source(params.id); app.sources.enqueueSync(params.id); return { ok: true }; });
  r('DELETE', '/api/sources/:id', async ({ params }) => { source(params.id); app.sources.remove(params.id); return { ok: true }; });

  // ---- items (the Library's notes and files) ----
  r('GET', '/api/items', async ({ query }) => ({
    total: app.items.count(),
    items: app.items.list({ sourceId: query.source || undefined, q: query.q || undefined, limit: Math.max(1, Math.min(200, Number(query.limit) || 60)), offset: Math.max(0, Number(query.offset) || 0) }),
  }));
  r('GET', '/api/items/:id', async ({ params }) => {
    const it = app.items.item(params.id);
    if (!it || it.deletedAt) throw new HttpError(404, 'item not found');
    const src = app.items.source(it.sourceId);
    return { ...it, sourceName: src?.name || '', sourceKind: src?.kind || '' };
  });

  // ---- people: merge proposals, merge, undo ----
  r('GET', '/api/people/proposals', async () => app.entities.proposals());
  r('POST', '/api/people/proposals/:id/:decision', async ({ params }) => app.entities.decide(Number(params.id), params.decision));
  r('POST', '/api/entities/:id/merge', async ({ params, body }) => app.entities.merge(params.id, String(object(body).into || '')));
  r('POST', '/api/entities/:id/unmerge', async ({ params }) => app.entities.unmerge(params.id));

  // ---- the Inbox, decisions and commitments, reminders, and the brief before a meeting ----
  r('GET', '/api/inbox', async () => ({ counts: app.inbox.counts(), cards: app.inbox.cards() }));
  r('GET', '/api/assertions', async ({ query }) => app.assertions.list({ state: query.state ? String(query.state).split(',') : undefined, kind: query.kind || undefined, noteId: query.noteId || undefined, limit: Math.min(500, Number(query.limit) || 200) }));
  r('POST', '/api/assertions', async ({ body }) => {
    const b = object(body);
    const { resolveDue } = require('../brain/dates');
    const note = b.noteId ? app.notes.get(b.noteId) : null;
    return app.assertions.add({ kind: b.kind, text: b.text, noteId: note ? note.id : null, owner: b.owner || '', to: b.to || '', dueText: b.dueText || '', dueAt: b.dueAt || resolveDue(b.dueText || '', Date.now()), origin: 'user' }).item;
  });
  r('GET', '/api/commitments', async () => app.assertions.open());
  r('PATCH', '/api/assertions/:id', async ({ params, body }) => app.assertions.edit(params.id, object(body)));
  r('POST', '/api/assertions/:id/supersede', async ({ params, body }) => app.assertions.supersede(params.id, String(object(body).by || '')));
  r('POST', '/api/assertions/:id/:decision', async ({ params }) => app.assertions.decide(params.id, params.decision));
  // look for decisions and commitments in one meeting again (what was dismissed stays dismissed)
  r('POST', '/api/notes/:id/assertions/extract', async ({ params }) => {
    if (!app.notes.get(params.id)) throw new HttpError(404, 'meeting not found');
    if (!app.ai.configured()) throw new HttpError(412, 'Connect an AI model first (Settings → AI).');
    app.runner.enqueue('note.assertions', { noteId: params.id }, { key: params.id, maxAttempts: 2 });
    return { queued: true };
  });
  r('GET', '/api/reminders', async () => ({ pending: app.reminders.pending(), upcoming: app.reminders.upcoming(14) }));
  r('POST', '/api/reminders', async ({ body }) => { const b = object(body); if (!b.text || !Number(b.dueAt)) throw new HttpError(400, 'text and dueAt are required'); return app.reminders.create({ text: b.text, dueAt: Number(b.dueAt) }); });
  r('POST', '/api/reminders/:id/snooze', async ({ params, body }) => app.reminders.snooze(params.id, Number(body?.ms) || 3600_000));
  r('POST', '/api/reminders/:id/:state', async ({ params }) => app.reminders.setState(params.id, params.state === 'dismiss' ? 'dismissed' : params.state));
  r('POST', '/api/brief', async ({ body }) => { const b = object(body); return app.briefs.build({ title: b.title || '', start: b.start || null, attendees: Array.isArray(b.attendees) ? b.attendees : [] }); });

  // ---- the search index: how much is searchable, and what a question finds (meetings and notes, by words and by meaning) ----
  r('GET', '/api/index', async () => app.chunkIndex.stats());
  r('GET', '/api/retrieve', async ({ query }) => {
    const hits = await app.chunkIndex.search(String(query.q || ''), { limit: Math.max(1, Math.min(30, Number(query.limit) || 8)) });
    return hits.map((h) => ({ ...h, text: h.text.slice(0, 1200) }));
  });

  // ---- the AI-run ledger: what was asked of an AI server and whether it left this computer ----
  r('GET', '/api/ai-runs', async ({ query }) => ({ summary: app.aiRuns.summary(Number(query.days) || 30), runs: app.aiRuns.list(Math.max(1, Math.min(500, Number(query.limit) || 50))) }));
};
