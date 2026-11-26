'use strict';
// HTTP routes for the brain layer: sources (folders, vaults) and their items, people merges, and the AI-run ledger.
// Registered by http.js BEFORE the knowledge routes, so /api/people/proposals is not read as a person's key.

module.exports = function brainRoutes(add, app, { HttpError, readBody }) {
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
  // the services that can be connected (GitHub, Slack, Discord, Gmail, Notion and Linear polling) and whether each has its token or sign-in
  r('GET', '/api/services', async () => Object.values(app.sources.services).map((v) => ({ kind: v.kind, ready: !!v.ready(app.sources.ctx), everyMin: Math.round(v.every / 60000) })));
  r('POST', '/api/sources', async ({ body }) => {
    const { service } = object(body);
    if (service) return app.sources.addRemote({ kind: service, name: body.name, config: object(body.config || {}), sensitivity: body.sensitivity === 'normal' ? 'normal' : 'private' });
    const { path, flavour, name, sensitivity, exclude } = object(body);
    return app.sources.add({ path, flavour, name, sensitivity, exclude: Array.isArray(exclude) ? exclude.map(String) : [] });
  });
  // check a folder before adding it (is it readable, is it an Obsidian vault, how many notes)
  // Discord's own data package (a ZIP): the messages you wrote, one item per channel per day. Private by default.
  r('POST', '/api/sources/discord-export', async ({ req }) => {
    const buf = await readBody(req, 100 * 1024 * 1024);
    if (!buf?.length) throw new HttpError(400, 'The file is empty.');
    const { importPackage } = require('../connectors/discord-export');
    const src = app.items.ensureExport ? app.items.ensureExport() : (app.items.sources().find((s) => s.kind === 'discord' && s.config.export) || app.items.addSource({ kind: 'discord', name: 'Discord data package', mode: 'copy', sensitivity: 'private', config: { export: true } }));
    let r;
    try { r = importPackage(buf, { items: app.items, source: src }); } catch (e) { if (e.code === 'EZIP') throw new HttpError(400, `This is not a readable ZIP file (${e.message}).`); throw e; }
    app.bus.publish('sources.changed', { id: src.id });
    return { source: src.id, ...r };
  });
  r('POST', '/api/sources/check', async ({ body }) => {
    const { path, flavour, service } = object(body);
    if (service) {
      const svc = app.sources.services[service];
      if (!svc) throw new HttpError(404, 'unknown service');
      if (!svc.ready(app.sources.ctx)) throw new HttpError(412, `Connect ${service} first.`);
      return svc.check(app.sources.ctx);
    }
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
  // actions that reach outside (/api/outbound; /api/actions is the meetings' action items, routes-knowledge.js): proposed here, run only when approved in the Inbox, with exactly the arguments shown
  r('GET', '/api/outbound', async () => ({ kinds: app.actions.kinds(), pending: app.actions.pending(), recent: app.actions.recent(20) }));
  r('POST', '/api/outbound', async ({ body }) => {
    const b = object(body);
    const assertion = b.assertionId ? app.assertions.get(b.assertionId) : null;
    if (b.assertionId && !assertion) throw new HttpError(404, 'promise not found');
    if (assertion && assertion.state !== 'accepted') throw new HttpError(409, 'only a promise you accepted can be sent anywhere');
    return app.actions.propose(String(b.kind || ''), { assertion, note: assertion?.noteId ? app.notes.get(assertion.noteId) : null, webhookId: b.webhookId }, { assertionId: assertion?.id || null });
  });
  r('POST', '/api/outbound/:id/approve', async ({ params }) => app.actions.approve(params.id));
  r('POST', '/api/outbound/:id/reject', async ({ params }) => app.actions.reject(params.id));
  r('POST', '/api/inbox/supersede/:old/:new/:decision', async ({ params }) => (params.decision === 'confirm' ? app.supersession.confirm(params.old, params.new) : params.decision === 'reject' ? app.supersession.reject(params.old, params.new) : (() => { throw new HttpError(400, 'decision must be confirm or reject'); })()));
  r('POST', '/api/inbox/noreply/:id/dismiss', async ({ params }) => { app.inbox.dismissNoReply(params.id); return { ok: true }; });
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
  r('POST', '/api/brief', async ({ body }) => {
    const b = object(body);
    const brief = await app.briefs.build({ title: b.title || '', start: b.start || null, attendees: Array.isArray(b.attendees) ? b.attendees : [] });
    // optional: a model phrases the facts (only the facts, each cited); without a server, or when it cites nothing, the facts stand alone
    if (b.narrate && !brief.empty && app.ai.configured()) { try { brief.narrative = await require('../brain/brief').narrate(app.scheduler.client('chat'), brief); } catch { brief.narrative = null; } }
    return brief;
  });

  // ---- rules in plain words: parsed by the AI into a fixed structure, previewed, saved; they can only propose ----
  r('GET', '/api/rules', async () => app.rules.list());
  r('POST', '/api/rules/parse', async ({ body }) => {
    if (!app.ai.configured()) throw new HttpError(412, 'Connect an AI model first (Settings → AI).');
    const out = await app.rules.parse(app.scheduler.client('chat'), object(body).text);
    return { ...out, preview: app.rules.preview(out.spec) };
  });
  r('POST', '/api/rules/preview', async ({ body }) => { const { validateSpec, explain } = require('../brain/rules'); const spec = validateSpec(object(body).spec); return { spec, explain: explain(spec), preview: app.rules.preview(spec) }; });
  r('POST', '/api/rules', async ({ body }) => { const b = object(body); return app.rules.create(b.text || '', b.spec); });
  r('PATCH', '/api/rules/:id', async ({ params, body }) => app.rules.setEnabled(params.id, !!object(body).enabled));
  r('DELETE', '/api/rules/:id', async ({ params }) => { if (!app.rules.remove(params.id)) throw new HttpError(404, 'not found'); return { ok: true }; });

  // ---- projects ----
  r('GET', '/api/projects', async () => app.projects.summary());
  r('POST', '/api/projects', async ({ body }) => app.projects.create(object(body)));
  r('GET', '/api/projects/:id', async ({ params }) => app.projects.page(params.id));
  r('PATCH', '/api/projects/:id', async ({ params, body }) => app.projects.update(params.id, object(body)));
  r('DELETE', '/api/projects/:id', async ({ params }) => { if (!app.projects.remove(params.id)) throw new HttpError(404, 'not found'); return { ok: true }; });
  r('POST', '/api/inbox/idle/:id/dismiss', async ({ params }) => { const p = app.projects.page(params.id); app.inbox.dismissIdle(params.id, p.lastAt); return { ok: true }; });

  r('GET', '/api/review', async ({ query }) => app.reviews.build(Math.max(0, Math.min(52, Number(query.weeks) || 0))));

  // ---- the app lock: a lock screen (not encryption at rest, see src/core/lock.js) ----
  r('GET', '/api/lock', async () => app.lock.status());
  r('POST', '/api/lock/enable', async ({ body }) => app.lock.enable(object(body)));
  r('POST', '/api/lock/minutes', async ({ body }) => app.lock.setMinutes(object(body).minutes, object(body)));
  r('POST', '/api/lock/disable', async ({ body }) => app.lock.disable(object(body)));
  r('POST', '/api/lock/unlock', async ({ body }) => app.lock.unlock(object(body).passphrase));
  r('POST', '/api/lock/lock', async () => app.lock.lock());

  // ---- backups of the database ----
  r('GET', '/api/backup', async () => ({ dir: app.settings.get('backupDir'), backups: app.listBackups().slice(0, 10).map((b) => ({ name: b.name, at: b.at, bytes: b.bytes })) }));
  r('POST', '/api/backup', async () => { const out = app.backupNow(); return { name: require('node:path').basename(out.file), bytes: out.bytes, kept: out.kept }; });

  // ---- the search index: how much is searchable, and what a question finds (meetings and notes, by words and by meaning) ----
  r('GET', '/api/index', async () => app.chunkIndex.stats());
  r('GET', '/api/retrieve', async ({ query }) => {
    const hits = await app.chunkIndex.search(String(query.q || ''), { limit: Math.max(1, Math.min(30, Number(query.limit) || 8)) });
    return hits.map((h) => ({ ...h, text: h.text.slice(0, 1200) }));
  });

  // ---- the AI-run ledger: what was asked of an AI server and whether it left this computer ----
  r('GET', '/api/ai-runs', async ({ query }) => ({ summary: app.aiRuns.summary(Number(query.days) || 30), runs: app.aiRuns.list(Math.max(1, Math.min(500, Number(query.limit) || 50))) }));
};
