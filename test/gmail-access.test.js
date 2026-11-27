'use strict';
// Gmail by access level, against a SIMULATED Gmail that follows the documented API (and, like the real one, refuses a search under the
// metadata scope). It proves the connector's logic; the real Gmail needs the person's own account.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { createApp } = require('../src/server/app');
const { compileQuery, neverRead, readCursor, writeCursor, threadItem } = require('../src/connectors/gmail');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const b64 = (s) => Buffer.from(s).toString('base64url');
const mail = (id, from, to, text, { labels = ['INBOX'], cc = '', subject = 'Contract terms', at = Date.parse('2026-11-24T10:00:00Z'), unsubscribe = false } = {}) => ({
  id, labelIds: labels, internalDate: String(at), snippet: `snippet of ${text}`,
  payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to }, ...(cc ? [{ name: 'Cc', value: cc }] : []), { name: 'Date', value: new Date(at).toUTCString() }, { name: 'Subject', value: subject }, ...(unsubscribe ? [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] : [])],
    mimeType: 'text/plain', body: { data: b64(text) } },
});

// A small Gmail. scope: 'readonly' | 'metadata' (then q and format=full are refused, as Google does).
async function fakeGmail({ scope = 'readonly' } = {}) {
  const g = { threads: {}, history: [], historyId: 100, log: [], scope, sendAs: ['ana@x.pt'], pageSize: 100 };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    g.log.push(`${p}${u.search}`);
    if (p === '/profile') return send(res, 200, { emailAddress: 'ana@x.pt', historyId: String(g.historyId), messagesTotal: 9, threadsTotal: Object.keys(g.threads).length });
    if (p === '/settings/sendAs') return g.scope === 'metadata' ? send(res, 403, { error: { message: 'Insufficient Permission' } }) : send(res, 200, { sendAs: g.sendAs.map((e) => ({ sendAsEmail: e })) });
    if (p === '/threads') {
      if (u.searchParams.get('q') && g.scope === 'metadata') return send(res, 403, { error: { message: "Metadata scope does not support 'q' parameter" } });
      const all = Object.keys(g.threads).sort().reverse();
      const start = Number(u.searchParams.get('pageToken') || 0);
      const page = all.slice(start, start + g.pageSize);
      return send(res, 200, { threads: page.map((id) => ({ id })), ...(start + g.pageSize < all.length ? { nextPageToken: String(start + g.pageSize) } : {}) });
    }
    const t = /^\/threads\/(\w+)$/.exec(p);
    if (t) {
      const th = g.threads[t[1]];
      if (!th) return send(res, 404, { error: { message: 'Requested entity was not found.' } });
      const format = u.searchParams.get('format');
      if (format === 'full' && g.scope === 'metadata') return send(res, 403, { error: { message: 'Metadata scope doesn\'t allow format FULL' } });
      if (format === 'metadata') {
        const want = new Set(u.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase()));
        return send(res, 200, { ...th, messages: th.messages.map((m) => ({ ...m, payload: { headers: m.payload.headers.filter((h) => want.has(h.name.toLowerCase())) } })) });
      }
      return send(res, 200, th);
    }
    if (p === '/history') {
      const types = u.searchParams.getAll('historyTypes');
      const start = Number(u.searchParams.get('startHistoryId'));
      if (start < 50) return send(res, 404, { error: { message: 'Requested entity was not found.' } });
      const events = g.history.filter((h) => h.id > start && types.includes(h.type));
      const from = Number(u.searchParams.get('pageToken') || 0);
      const page = events.slice(from, from + 2);
      return send(res, 200, { historyId: String(g.historyId), history: page.map((h) => ({ id: String(h.id), [h.field]: [{ message: { threadId: h.threadId } }] })), ...(from + 2 < events.length ? { nextPageToken: String(from + 2) } : {}) });
    }
    send(res, 404, { error: { message: 'no such route' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.url = `http://127.0.0.1:${server.address().port}`;
  g.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  g.event = (type, threadId) => { g.historyId++; const field = { messageAdded: 'messagesAdded', messageDeleted: 'messagesDeleted', labelAdded: 'labelsAdded', labelRemoved: 'labelsRemoved' }[type]; g.history.push({ id: g.historyId, type, field, threadId }); };
  return g;
}
async function boot(t, g) {
  const dataDir = tmpDir('wb-gmail-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test', connectorOptions: { sleep: async () => {}, google: { gmailBase: `${g.url}/gmail/v1`, tokenUrl: `${g.url}/token` } } });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready; await app.runner.stop();
  app.settings.update({ google: { ...app.settings.get('google'), clientId: 'c', clientSecret: 's', refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 3600_000, gmail: true, email: 'ana@x.pt' } });
  return app;
}

test('the Gmail search for a part: labels are any-of, exclusions and the never-read list go in, categories can be skipped', () => {
  assert.equal(compileQuery({ query: 'newer_than:30d' }), 'newer_than:30d');
  assert.equal(compileQuery({ query: 'newer_than:30d', labels: ['Work'] }), 'newer_than:30d label:Work');
  assert.equal(compileQuery({ query: '', labels: ['Work', 'Clients 2026'] }), '{label:Work label:"Clients 2026"}', 'labelIds would mean ALL of them');
  assert.equal(compileQuery({ query: 'in:anywhere' }, { excludeLabels: ['HR'], fromDomains: ['acme.io', 'b.pt'], never: { senders: ['boss@x.pt'], labels: ['Medical'] }, skipCategories: true }),
    'in:anywhere -label:HR -label:Medical {from:acme.io from:b.pt} -from:boss@x.pt -category:promotions -category:social -category:updates -category:forums');
  const m = mail('m', 'Doctor <dr@clinic.pt>', 'ana@x.pt', 'Results', { subject: 'Your lab results' });
  assert.equal(neverRead([m], { domains: ['clinic.pt'] }), true);
  assert.equal(neverRead([m], { keywords: ['LAB RESULTS'] }), true);
  assert.equal(neverRead([m], { senders: ['other@x.pt'] }), false);
  assert.deepEqual(readCursor('42'), { h: '42' }, 'an old cursor is read as before');
  assert.equal(writeCursor({ h: '42' }), '42');
  assert.deepEqual(readCursor(writeCursor({ h: '42', hp: '2' })), { h: '42', hp: '2' });
});

test('a thread: Cc counts as people, aliases count as me, the link opens the right account, quoted Outlook/pt-PT text is cut', () => {
  const t = { id: 'abc', historyId: '7', messages: [
    mail('1', 'Rui <rui@x.pt>', 'ana@x.pt', 'Can you?', { cc: 'Eva <eva@y.pt>' }),
    mail('2', 'Ana <ana.work@x.pt>', 'rui@x.pt', 'Sim, envio amanhã.\n\nDe: Rui <rui@x.pt>\nEnviado: segunda-feira\nAssunto: x\n\ntexto antigo'),
  ] };
  const it = threadItem(t, new Set(['ana@x.pt', 'ana.work@x.pt']), { account: 'ana@x.pt' });
  assert.ok(it.meta.people.includes('eva@y.pt'));
  assert.equal(it.meta.lastFromMe, true, 'a reply from an alias is from me');
  assert.match(it.uri, /authuser=ana%40x\.pt#all\/abc$/);
  assert.ok(it.text.includes('Sim, envio amanhã.') && !it.text.includes('texto antigo'));
});

test('metadata level: no search, no body, no snippet; the part is chosen by label here', async (t) => {
  const g = await fakeGmail({ scope: 'metadata' }); t.after(() => g.close());
  g.threads.t1 = { id: 't1', historyId: '90', messages: [mail('m1', 'Rui <rui@x.pt>', 'ana@x.pt', 'BODYSECRET one', { labels: ['INBOX', 'Label_work'] })] };
  g.threads.t2 = { id: 't2', historyId: '91', messages: [mail('m2', 'Eva <eva@y.pt>', 'ana@x.pt', 'BODYSECRET two', { labels: ['INBOX'] })] };
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' }, grant: { readLevel: 'metadata', filter: { labels: ['Label_work'] } } });
  const r = await app.sources.sync(src.id);
  assert.equal(r.created, 1, 'only the labelled thread');
  const it = app.items.byExternal(src.id, 'thread:t1');
  assert.equal(it.text, '');
  assert.equal(it.title, 'Contract terms');
  assert.ok(!JSON.stringify(it).includes('BODYSECRET') && !JSON.stringify(it).includes('snippet'), 'neither the body nor Gmail\'s snippet');
  assert.ok(g.log.every((l) => !l.includes('q=') && !l.includes('format=full')), 'never asks what the metadata scope forbids');
  assert.ok(g.log.some((l) => l.includes('metadataHeaders=From') && l.includes('metadataHeaders=Subject')));
});

test('history: every change type is asked for, a long history is read across runs without skipping, Trash and Spam are gone', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  for (const id of ['t1', 't2', 't3', 't4']) g.threads[id] = { id, historyId: '90', messages: [mail(`m${id}`, 'Rui <rui@x.pt>', 'ana@x.pt', `hello ${id}`)] };
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' } });
  await app.sources.sync(src.id);
  assert.equal(app.items.source(src.id).cursor, '100');
  // four changes; Gmail returns two per page; this run may read one page (budget 2)
  g.threads.t1.messages[0].labelIds = ['TRASH'];                      // trashed
  g.threads.t2.messages.push(mail('m2b', 'Ana <ana@x.pt>', 'rui@x.pt', 'reply'));
  g.threads.t3.messages[0].labelIds = ['SPAM'];
  delete g.threads.t4;                                                 // deleted for good
  g.event('labelAdded', 't1'); g.event('messageAdded', 't2'); g.event('labelAdded', 't3'); g.event('messageDeleted', 't4');
  const svc = app.sources.services.gmail;
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  const mid = app.items.source(src.id).cursor;
  assert.deepEqual(readCursor(mid), { h: '100', hp: '2' }, 'stopped at a page: the next run continues it, same start');
  assert.ok(g.log.some((l) => /historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved/.test(l)));
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  assert.equal(app.items.source(src.id).cursor, '104', 'only now fully read up to the newest history id');
  assert.ok(app.items.byExternal(src.id, 'thread:t1').deletedAt, 'trashed');
  assert.ok(app.items.byExternal(src.id, 'thread:t3').deletedAt, 'spam');
  assert.ok(app.items.byExternal(src.id, 'thread:t4').deletedAt, 'deleted');
  assert.equal(app.items.byExternal(src.id, 'thread:t2').meta.messages, 2);
});

test('a big first listing is read across runs, newest first, and the never-read list keeps threads out', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.pageSize = 2;
  for (let i = 1; i <= 5; i++) g.threads[`t${i}`] = { id: `t${i}`, historyId: '90', messages: [mail(`m${i}`, i === 3 ? 'HR <hr@corp.pt>' : 'Rui <rui@x.pt>', 'ana@x.pt', `hello ${i}`)] };
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' }, grant: { filter: { never: { domains: ['corp.pt'] } } } });
  const svc = app.sources.services.gmail;
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  assert.deepEqual(readCursor(app.items.source(src.id).cursor), { lp: '2', lh: '100' });
  assert.ok(app.items.byExternal(src.id, 'thread:t5') && !app.items.byExternal(src.id, 'thread:t1'), 'newest first');
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  assert.equal(app.items.source(src.id).cursor, '100', 'listing done: history from before it started');
  assert.equal(app.items.byExternal(src.id, 'thread:t3'), null, 'never stored');
  assert.equal(app.items.list({ sourceId: src.id }).length, 4);
  assert.ok(g.log.some((l) => decodeURIComponent(l.replace(/\+/g, ' ')).includes('-from:corp.pt')), 'and asked Gmail to leave it out too');
});
