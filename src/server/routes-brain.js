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
  // Aborts when the page that asked goes away before the answer is sent, so its AI request stops holding the queue. The response's
  // 'close' (not the request's: that one fires once the body has been read) tells a dropped connection from a finished reply.
  const gone = (res) => { const ac = new AbortController(); res?.on?.('close', () => { if (!res.writableFinished) ac.abort(); }); return ac.signal; };

  // ---- sources ----
  r('GET', '/api/sources', async () => app.sources.view());
  // the services that can be connected (GitHub, Slack, Discord, Gmail, Notion and Linear polling) and whether each has its token or sign-in
  r('GET', '/api/services', async () => Object.values(app.sources.services).map((v) => ({ kind: v.kind, ready: !!v.ready(app.sources.ctx), everyMin: Math.round(v.every / 60000) })));
  r('POST', '/api/sources', async ({ body }) => {
    const { service } = object(body);
    const grant = body.grant && typeof body.grant === 'object' ? object(body.grant) : {};   // the access sheet's answers (src/access/grants.js)
    if (service) return app.sources.addRemote({ kind: service, name: body.name, config: object(body.config || {}), sensitivity: body.sensitivity === 'normal' ? 'normal' : 'private', grant });
    const { path, flavour, name, sensitivity, exclude } = object(body);
    return app.sources.add({ path, flavour, name, sensitivity, exclude: Array.isArray(exclude) ? exclude.map(String) : [], grant });
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
  // A Google Takeout / any .mbox file on this computer, read in place into a source ('mbox'): the level and the never-read list apply
  r('POST', '/api/sources/mbox', async ({ body }) => {
    const b = object(body);
    const file = require('node:path').resolve(String(b.path || ''));
    const fs = require('node:fs');
    if (!b.path || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(400, `There is no such file: ${b.path || ''}`);
    const grant = b.grant && typeof b.grant === 'object' ? object(b.grant) : {};
    const src = app.items.addSource({ kind: 'mbox', name: String(b.name || require('node:path').basename(file)).slice(0, 120), mode: 'copy', sensitivity: 'private', config: { path: file }, grant: { readLevel: 'all', ...grant } });
    const { importMbox } = require('../importers/mbox');
    try {
      const r = await importMbox({ items: app.items, source: app.items.source(src.id), file, filter: app.items.source(src.id).filter, level: app.items.source(src.id).readLevel });
      app.items.markSync(src.id, { ok: true });
      app.bus.publish('sources.changed', { id: src.id });
      return { source: src.id, ...r };
    } catch (e) { app.items.removeSource(src.id); throw Object.assign(new HttpError(e.status || 400, e.message), {}); }
  });
  // Outlook / Microsoft 365: sign in with the app the person registered (settings.outlook); the permissions follow the access they chose
  r('POST', '/api/outlook/connect', async ({ body }) => {
    const b = object(body);
    const patch = {};
    for (const k of ['clientId', 'tenant']) if (typeof b[k] === 'string' && b[k].trim()) patch[k] = b[k].trim();
    if (typeof b.clientSecret === 'string' && b.clientSecret && b.clientSecret !== '********') patch.clientSecret = b.clientSecret.trim();
    if (Object.keys(patch).length) app.settings.update({ outlook: { ...app.settings.get('outlook'), ...patch } });
    if (!app.settings.get('outlook').clientId) throw new HttpError(400, 'Add the application (client) ID of your Microsoft app first.');
    const outlook = require('../connectors/outlook');
    const auth = await outlook.authFor(app.sources.ctx).beginAuth({ openExternal: app.openExternal || undefined, level: ['metadata', 'part', 'all'].includes(b.level) ? b.level : 'part', actions: Array.isArray(b.actions) ? b.actions.map(String) : [] });
    auth.done.then((r2) => app.bus.publish('outlook.connected', { email: r2?.email || app.settings.get('outlook').email }), (e) => app.bus.publish('outlook.error', { message: e.message }));
    return { authUrl: auth.authUrl, opened: !!app.openExternal };
  });
  r('POST', '/api/outlook/disconnect', async () => { await require('../connectors/outlook').authFor(app.sources.ctx).disconnect(); return { ok: true }; });
  r('GET', '/api/outlook/status', async () => { const c = app.settings.get('outlook'); return { configured: !!c.clientId, connected: !!c.refreshToken, email: c.email, needsReconnect: !!c.needsReconnect, scopes: c.scopes || [] }; });
  // IMAP: try a mailbox account (host, user, password) before adding it as a source
  r('POST', '/api/imap/test', async ({ body }) => {
    const imap = require('../connectors/imap');
    return imap.check(app.sources.ctx, { config: { account: String(object(body).account || '') } });
  });
  r('POST', '/api/sources/check', async ({ body }) => {
    const { path, flavour, service, config } = object(body);
    if (service) {
      const svc = app.sources.services[service];
      if (!svc) throw new HttpError(404, 'unknown service');
      if (!svc.ready(app.sources.ctx, object(config || {}))) throw new HttpError(412, `Connect ${service} first.`);
      return svc.check(app.sources.ctx, { config: object(config || {}) });
    }
    const { FolderConnector } = require('../connectors/folder');
    return new FolderConnector({ source: { id: 'check', kind: flavour === 'obsidian' ? 'obsidian' : 'folder', config: { path } }, items: app.items }).check();
  });
  r('PATCH', '/api/sources/:id', async ({ params, body }) => {
    const { name, sensitivity, enabled, config } = object(body);
    const cur = source(params.id);
    if (config !== undefined) {                                  // what to read (labels, channels, repositories, a search): checked by the service
      const svc = cur.config?.remote && app.sources.services[cur.kind];
      const next = svc ? { ...svc.validate({ ...cur.config, ...object(config) }, { readLevel: cur.readLevel }), remote: true } : object(config);
      app.items.updateSource(params.id, { config: next });
    }
    if (enabled === false) return app.sources.pause(params.id);
    if (enabled === true) app.sources.resume(params.id);
    return app.items.updateSource(params.id, { ...(name !== undefined ? { name } : {}), ...(sensitivity !== undefined ? { sensitivity } : {}) });
  });
  // What a source is granted (src/access/grants.js): read level, filter, actions, who may see it, live search, MCP, expiry.
  // Narrowing what may be read forgets what is no longer allowed at once; the answer says how many items were dropped.
  r('PATCH', '/api/sources/:id/grant', async ({ params, body }) => {
    source(params.id);
    const allowed = ['readLevel', 'filter', 'actions', 'autoActions', 'aiReach', 'liveSearch', 'mcp', 'retentionDays', 'expiresAt'];
    const patch = Object.fromEntries(Object.entries(object(body)).filter(([k]) => allowed.includes(k)));
    const r2 = app.items.setGrant(params.id, patch);
    app.accessLog?.add({ sourceId: params.id, op: 'grant.changed', detail: Object.keys(patch).join(',') });
    return r2;
  });
  r('POST', '/api/sources/:id/sync', async ({ params }) => { source(params.id); app.sources.enqueueSync(params.id); return { ok: true }; });
  r('DELETE', '/api/sources/:id', async ({ params }) => { source(params.id); app.sources.remove(params.id); return { ok: true }; });

  // ---- items (the Library's notes and files) ----
  r('GET', '/api/items', async ({ query }) => ({
    total: app.items.count(),
    items: app.items.list({ sourceId: query.source || undefined, q: query.q || undefined, limit: Math.max(1, Math.min(200, Number(query.limit) || 60)), offset: Math.max(0, Number(query.offset) || 0) }),
  }));
  // keep one item stricter than its source ('local' / 'ask'), or back to its source's rule (null)
  r('PATCH', '/api/items/:id/reach', async ({ params, body }) => {
    const it = app.items.item(params.id);
    if (!it || it.deletedAt) throw new HttpError(404, 'item not found');
    const v = object(body).aiReach;
    return app.items.setItemReach(params.id, v === undefined ? null : v);
  });
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
  r('POST', '/api/outbound/:id/approve', async ({ params, body }) => app.actions.approve(params.id, { confirmRisky: body?.confirmRisky === true }));
  r('POST', '/api/outbound/:id/reject', async ({ params }) => app.actions.reject(params.id));
  r('POST', '/api/outbound/:id/resolve', async ({ params, body }) => app.actions.resolveInterrupted(params.id, { done: body?.done === true }));   // an interrupted one, after the person checked
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
  r('POST', '/api/brief', async ({ body, res }) => {
    const b = object(body);
    const brief = await app.briefs.build({ title: b.title || '', start: b.start || null, attendees: Array.isArray(b.attendees) ? b.attendees : [] }, { live: b.live === true });
    // optional: a model phrases the facts (only the facts, each cited); without a server, or when it cites nothing, the facts stand alone
    if (b.narrate && !brief.empty && app.ai.configured()) { try { brief.narrative = await require('../brain/brief').narrate(app.scheduler.client('chat'), brief, { mayShare: app.mayShare, signal: gone(res) }); } catch { brief.narrative = null; } }
    return brief;
  });

  // ---- rules in plain words: parsed by the AI into a fixed structure, previewed, saved; they can only propose ----
  r('GET', '/api/rules', async () => app.rules.list());
  r('POST', '/api/rules/parse', async ({ body, res }) => {
    if (!app.ai.configured()) throw new HttpError(412, 'Connect an AI model first (Settings → AI).');
    const out = await app.rules.parse(app.scheduler.client('chat'), object(body).text, { signal: gone(res) });
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
    // retrieval is what an AI tool would be handed: only what may reach the AI server in Settings (src/access/grants.js)
    const hits = await app.chunkIndex.search(String(query.q || ''), { limit: Math.max(1, Math.min(30, Number(query.limit) || 8)), allow: app.mayShare });
    return hits.map((h) => ({ ...h, text: h.text.slice(0, 1200) }));
  });

  // ---- the AI-run ledger: what was asked of an AI server and whether it left this computer ----
  // ---- access: accounts, grants, what is kept, what to review (src/access/center.js) ----
  r('GET', '/api/access', async () => app.accessCenter.overview());
  r('DELETE', '/api/access/copies', async () => ({ removed: app.account.removeCopies() }));
  r('POST', '/api/access/notice/dismiss', async () => ({ ok: app.accessCenter.dismissNotice() }));
  r('POST', '/api/access/review/:id', async ({ params }) => { source(params.id); return { ok: app.accessCenter.markReviewed(params.id) }; });
  r('POST', '/api/inbox/access-review/:id/dismiss', async ({ params }) => { source(params.id); return { ok: app.accessCenter.markReviewed(params.id) }; });
  r('POST', '/api/sources/:id/revoke', async ({ params, body }) => { source(params.id); const b = object(body); return app.accessCenter.revoke(params.id, { signOut: !!b.signOut, keepSource: b.keepSource !== false }); });
  r('POST', '/api/access/estimate', async ({ body }) => {
    const { service, config } = object(body);
    const svc = app.sources.services[service];
    if (!svc?.estimate) throw new HttpError(404, 'no estimate for this service');
    if (!svc.ready(app.sources.ctx, object(config || {}))) throw new HttpError(412, `Connect ${service} first.`);
    return svc.estimate(app.sources.ctx, { config: object(config || {}) });
  });
  r('POST', '/api/people/:id/forget', async ({ params }) => app.entities.forget(params.id, { items: app.items }));
  r('DELETE', '/api/blocked-addresses/:address', async ({ params }) => ({ ok: app.items.unblock(decodeURIComponent(params.address)) }));
  // ---- live search: ask the services that allow it, with a short cache; opening a result keeps its body for the grant's retention ----
  r('GET', '/api/live-search', async ({ query }) => app.liveSearch.search(String(query.q || ''), { sourceIds: query.sources ? String(query.sources).split(',') : null, limit: Math.max(1, Math.min(20, Number(query.limit) || 8)), force: query.fresh === '1' }));
  r('POST', '/api/live-search/open', async ({ body }) => { const b = object(body); return app.liveSearch.open(String(b.sourceId || ''), String(b.externalId || '')); });
  r('POST', '/api/items/:id/pin', async ({ params }) => app.items.pin(params.id));
  // ---- one line of events: per person, per project; related mail and messages on a meeting ----
  r('GET', '/api/people/:key/timeline', async ({ params, query }) => { const id = app.entities.find(params.key); if (!id) throw new HttpError(404, 'person not found'); return app.timeline.person(id, { limit: Math.max(1, Math.min(100, Number(query.limit) || 40)) }); });
  r('GET', '/api/projects/:id/timeline', async ({ params }) => app.timeline.project(params.id));
  r('GET', '/api/notes/:id/related', async ({ params }) => app.timeline.related(params.id));
  r('PUT', '/api/notes/:id/related/:itemId', async ({ params, body }) => ({ ok: app.timeline.setLink(params.id, params.itemId, object(body).state ?? null) }));
  // ---- mail: suggest the text of a reply (the AI only if its source allows it), and propose an action on mail (waits in the Inbox) ----
  r('POST', '/api/mail/suggest', async ({ body }) => { const b = object(body); return app.ai.draftReply(String(b.itemId || ''), String(b.instruction || '')); });
  r('POST', '/api/mail/propose', async ({ body }) => {
    const b = object(body);
    const kind = String(b.kind || '');
    if (!kind.startsWith('gmail.')) throw new HttpError(400, 'unknown mail action');
    return app.actions.propose(kind, { itemId: b.itemId, itemIds: Array.isArray(b.itemIds) ? b.itemIds.map(String) : undefined, sourceId: b.sourceId, to: b.to, cc: b.cc, subject: b.subject, body: b.body, add: b.add, remove: b.remove, create: b.create === true, typedRecipients: Array.isArray(b.typedRecipients) ? b.typedRecipients.map(String) : [] }, { origin: b.origin === 'ask' ? 'ask' : 'user', provenance: Array.isArray(b.provenance) ? b.provenance.map(String) : [] });
  });
  // the recap of a meeting, as a message to the people who were in it (a draft or a send, approved in the Inbox)
  r('POST', '/api/notes/:id/propose-recap', async ({ params, body }) => {
    const b = object(body);
    const n = app.notes.get(params.id);
    if (!n) throw new HttpError(404, 'meeting not found');
    const text = [n.summary?.trim() || n.body?.trim() || '', ...(app.knowledge?.actionItems?.({ noteId: params.id }) || []).map((a) => `- ${a.text}`)].filter(Boolean).join('\n\n').trim();
    if (!text) throw new HttpError(409, 'This meeting has no notes to send yet.');
    const to = (Array.isArray(b.to) ? b.to : []).map(String);
    return app.actions.propose(b.send ? 'gmail.send' : 'gmail.draft', { sourceId: b.sourceId, to, subject: b.subject || `Recap: ${n.title || 'our meeting'}`, body: text, typedRecipients: to });
  });
  r('GET', '/api/access-log', async ({ query }) => app.accessLog.list({ sourceId: query.source || undefined, limit: Math.max(1, Math.min(500, Number(query.limit) || 100)) }));
  r('GET', '/api/ai-runs', async ({ query }) => ({ summary: app.aiRuns.summary(Number(query.days) || 30), runs: app.aiRuns.list(Math.max(1, Math.min(500, Number(query.limit) || 50))) }));
};
