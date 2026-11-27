'use strict';
// The service connectors (GitHub, Slack, Discord, Gmail, Notion/Linear polling) against SIMULATED servers that follow each service's
// documented API. They prove the logic (incremental cursors, one item per thread or per day, rate limits, tombstones, privacy); they
// do not prove the real services behave the same: that needs the person's own accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { createApp } = require('../src/server/app');
const { clean } = require('../src/connectors/slack');
const { bodyOf } = require('../src/connectors/gmail');
const { request, RateLimited } = require('../src/connectors/http');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});

// one local server, a route table the test fills in: handler(url, req) -> [status, body, headers?]
async function fakeWorld() {
  const w = { routes: [], log: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    w.log.push(`${req.method} ${url.pathname}${url.search}`);
    for (const [re, fn] of w.routes) {
      const m = re.exec(url.pathname);
      if (m) { const [status, body, headers = {}] = fn(url, req, m); res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); return res.end(JSON.stringify(body)); }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'no such route' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  w.url = `http://127.0.0.1:${server.address().port}`;
  w.on = (re, fn) => w.routes.unshift([re, fn]);
  w.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return w;
}
async function boot(t, w, extra = {}) {
  const dataDir = tmpDir('wb-svc-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test', connectorOptions: { bases: { github: w.url, slack: `${w.url}/api`, discord: `${w.url}/api/v10` }, sleep: async () => {}, google: { gmailBase: `${w.url}/gmail/v1`, tokenUrl: `${w.url}/token` }, ...extra } });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready; await app.runner.stop();
  return app;
}
const run = (app, source) => app.sources.sync(source.id);

test('a rate limit is waited out when short, and stops the run with a message when long', async () => {
  let calls = 0, slept = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : new Response('{"ok":true}', { status: 200 }); };
  const r = await request('http://x/y', { service: 'Svc', fetchImpl, sleep: async (ms) => { slept = ms; } });
  assert.deepEqual([r.status, slept, calls], [200, 2000, 2]);
  await assert.rejects(request('http://x/y', { service: 'Svc', fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '600' } }) }), (e) => e instanceof RateLimited && e.retryAfterMs === 600000);
  await assert.rejects(request('http://x/y', { service: 'Svc', fetchImpl: async () => new Response('{"message":"Bad credentials"}', { status: 401 }) }), (e) => e.code === 'unauthorized' && /Bad credentials/.test(e.message));
});

test('GitHub: issues and pull requests with their comments, incrementally, one item each', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ github: { token: 'ghp_test' } });
  let auth = '';
  const issue = (n, extra = {}) => ({ number: n, title: `Thing ${n}`, body: `Body of ${n}`, state: 'open', user: { login: 'ana' }, labels: [{ name: 'bug' }], assignees: [], comments: 0, comments_url: `${w.url}/repos/o/r/issues/${n}/comments`, html_url: `https://github.com/o/r/issues/${n}`, created_at: '2026-11-01T10:00:00Z', updated_at: `2026-11-0${n}T10:00:00Z`, ...extra });
  let data = [issue(1, { comments: 1 }), issue(2, { pull_request: {} })];
  w.on(/^\/repos\/o\/r\/issues$/, (u, req) => { auth = req.headers.authorization; const since = u.searchParams.get('since'); return [200, data.filter((i) => !since || i.updated_at > since)]; });
  w.on(/^\/repos\/o\/r\/issues\/1\/comments$/, () => [200, [{ user: { login: 'rui' }, created_at: '2026-11-02T09:00:00Z', body: 'I will fix it by Friday' }]]);
  w.on(/^\/user$/, () => [200, { login: 'ana' }]);
  assert.deepEqual(await app.sources.services.github.check(app.sources.ctx), { ok: true, user: 'ana' });
  assert.equal((await app.items.list({}).length), 0);
  const src = app.sources.addRemote({ kind: 'github', name: 'o/r', config: { repos: 'o/r' } });
  assert.equal(src.sensitivity, 'private', 'private by default');
  assert.deepEqual(src.config.repos, ['o/r']);
  const r1 = await run(app, src);
  assert.deepEqual([r1.created, r1.updated], [2, 0]);
  assert.equal(auth, 'Bearer ghp_test');
  const i1 = app.items.byExternal(src.id, 'o/r#1');
  assert.match(i1.title, /Issue #1 Thing 1/);
  assert.match(i1.text, /rui \(2026-11-02\): I will fix it by Friday/, 'the comments are part of the item');
  assert.equal(app.items.byExternal(src.id, 'o/r#2').meta.pr, true);
  // incremental: only what changed since the cursor is asked for, and an update changes the item, not the count
  data = [issue(1, { comments: 1, body: 'Body of 1, edited', updated_at: '2026-11-09T10:00:00Z' })];
  const before = w.log.length;
  const r2 = await run(app, app.items.source(src.id));
  assert.deepEqual([r2.created, r2.updated], [0, 1]);
  assert.ok(w.log.slice(before).some((l) => l.includes('since=2026-11-02')), 'asked only for what changed since the last run');
  assert.equal(app.items.count(), 2);
  assert.match(app.items.byExternal(src.id, 'o/r#1').text, /edited/);
  // bad input and a missing token are said plainly
  assert.throws(() => app.sources.addRemote({ kind: 'github', config: { repos: 'not a repo' } }), /not a repository name/);
  app.settings.update({ github: { token: '' } });
  assert.throws(() => app.sources.addRemote({ kind: 'github', config: { repos: 'o/r' } }), /Connect github first/);
});

test('Slack: one item per channel per day, mentions and links made readable, replies included, incremental', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ slack: { token: 'xoxp-test' } });
  const base = Date.parse('2026-11-25T10:00:00Z') / 1000;
  let msgs = [
    { ts: String(base), user: 'U1', text: 'Shall we drop the free tier? cc <@U2> see <https://x.io/p|the doc> &amp; <#C1|atlas>', reply_count: 1, thread_ts: String(base) },
    { ts: String(base + 60), user: 'U2', text: 'Yes, I will send the sheet by Friday' },
    { ts: String(base + 90), subtype: 'channel_join', user: 'U3', text: 'joined' },
  ];
  w.on(/^\/api\/auth.test$/, () => [200, { ok: true, team: 'T', user: 'bot' }]);
  w.on(/^\/api\/users.list$/, () => [200, { ok: true, members: [{ id: 'U1', real_name: 'Ana Silva', profile: {} }, { id: 'U2', profile: { display_name: 'rui' } }] }]);
  w.on(/^\/api\/conversations.list$/, () => [200, { ok: true, channels: [{ id: 'C1', name: 'atlas' }, { id: 'C2', name: 'random' }] }]);
  w.on(/^\/api\/conversations.history$/, (u) => [200, { ok: true, messages: msgs.filter((m) => Number(m.ts) >= Number(u.searchParams.get('oldest'))) }]);
  w.on(/^\/api\/conversations.replies$/, () => [200, { ok: true, messages: [{ ts: String(base), thread_ts: String(base), user: 'U1', text: 'root' }, { ts: String(base + 120), thread_ts: String(base), user: 'U1', text: 'In a thread: agreed' }] }]);
  assert.equal(clean('hi <@U1> <https://a.b|c> &lt;x&gt;', new Map([['U1', 'Ana']])), 'hi @Ana c (https://a.b) <x>');
  const src = app.sources.addRemote({ kind: 'slack', name: 'Slack', config: { channels: '#atlas, nowhere' }, sensitivity: 'private' });
  const r = await app.sources.services.slack.sync({ ...app.sources.ctx, source: src, items: app.items, now: () => Date.parse('2026-11-26T08:00:00Z') });
  assert.deepEqual([r.created, r.errors], [1, 1], 'one day-item; the channel the app is not in is counted, not fatal');
  const it = app.items.byExternal(src.id, 'C1:2026-11-25');
  assert.equal(it.title, '#atlas · 2026-11-25');
  assert.match(it.text, /Ana Silva: Shall we drop the free tier\? cc @rui see the doc \(https:\/\/x\.io\/p\) & #atlas/);
  assert.match(it.text, /rui: Yes, I will send the sheet by Friday/);
  assert.match(it.text, /Ana Silva: In a thread: agreed/, 'replies are in the day');
  assert.ok(!it.text.includes('joined'), 'joins and topic changes are not messages');
  assert.match(it.uri, /app_redirect\?channel=C1/);
  // a new message the same day updates the same item; a new day is a new item
  msgs.push({ ts: String(base + 600), user: 'U2', text: 'Done, sent.' }, { ts: String(base + 90000), user: 'U1', text: 'Next day' });
  const fresh = app.items.source(src.id);
  const r2 = await app.sources.services.slack.sync({ ...app.sources.ctx, source: fresh, items: app.items });
  assert.deepEqual([r2.created, r2.updated], [1, 1]);
  assert.match(app.items.byExternal(src.id, 'C1:2026-11-25').text, /Done, sent\./);
  assert.equal(app.items.count(), 2);
});

test('Slack: a bad token stops for good with a clear message instead of retrying forever', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ slack: { token: 'xoxp-bad' } });
  w.on(/^\/api\//, () => [200, { ok: false, error: 'invalid_auth' }]);
  const src = app.sources.addRemote({ kind: 'slack', config: { channels: 'atlas' } });
  await assert.rejects(app.sources.sync(src.id), (e) => e.permanent === true && /invalid_auth/.test(e.message));
  assert.match(app.items.source(src.id).lastError, /invalid_auth/, 'the Sources page can say what is wrong');
});

test('Discord: your own server read with your bot, one item per channel per day, from where it stopped', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ discord: { ...app.settings.get('discord'), token: 'bot-token' } });
  const id = (ms) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
  const at = Date.parse('2026-11-25T14:00:00Z');
  let msgs = [{ id: id(at + 60000), type: 0, content: 'I will review the contract tomorrow', timestamp: new Date(at + 60000).toISOString(), author: { username: 'rui', global_name: 'Rui' } }, { id: id(at), type: 0, content: 'Shall we ship in March?', timestamp: new Date(at).toISOString(), author: { username: 'ana' } }, { id: id(at + 1), type: 7, content: '', timestamp: new Date(at).toISOString(), author: { username: 'x' } }];
  let auth = '', after = [];
  w.on(/^\/api\/v10\/users\/@me$/, () => [200, { username: 'brainbot' }]);
  w.on(/^\/api\/v10\/channels\/(\d+)$/, (u, req, m) => [200, { id: m[1], name: 'general', guild_id: '999999999999999999' }]);
  w.on(/^\/api\/v10\/channels\/\d+\/messages$/, (u, req) => { auth = req.headers.authorization; after.push(u.searchParams.get('after')); return [200, msgs.filter((m) => BigInt(m.id) > BigInt(u.searchParams.get('after')))]; });
  assert.equal((await app.sources.services.discord.check(app.sources.ctx)).bot, 'brainbot');
  assert.throws(() => app.sources.addRemote({ kind: 'discord', config: { channels: 'general' } }), /not a channel id/);
  const src = app.sources.addRemote({ kind: 'discord', name: 'My server', config: { channels: '123456789012345678' } });
  const r = await app.sources.services.discord.sync({ ...app.sources.ctx, source: src, items: app.items, now: () => at + 3600_000 });
  assert.equal(auth, 'Bot bot-token');
  assert.equal(r.created, 1);
  const it = app.items.byExternal(src.id, '123456789012345678:2026-11-25');
  assert.match(it.text, /ana: Shall we ship in March\?\n\[14:01\] Rui: I will review the contract tomorrow/, 'in time order, with the display name');
  assert.ok(!it.text.includes('type'), 'system messages (joins, pins) are left out');
  assert.match(it.uri, /discord\.com\/channels\/999999999999999999\/123456789012345678\//);
  msgs.push({ id: id(at + 120000), type: 0, content: 'Thanks!', timestamp: new Date(at + 120000).toISOString(), author: { username: 'ana' } });
  const r2 = await app.sources.services.discord.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items });
  assert.deepEqual([r2.created, r2.updated], [0, 1]);
  assert.equal(BigInt(after.at(-1)) <= BigInt(id(at)), true, 'it re-reads from the start of that day, so the item is always the whole day');
});

// ---- Gmail ----
const b64 = (s) => Buffer.from(s).toString('base64url');
const mail = (id, from, to, date, text, extra = {}) => ({ id, labelIds: ['INBOX'], internalDate: String(Date.parse(date)), payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Date', value: date }, { name: 'Subject', value: 'Contract terms' }], mimeType: 'text/plain', body: { data: b64(text) } }, ...extra });

test('Gmail: a thread is one item with its plain text; quoted history is cut; a reply never made a duplicate', async () => {
  assert.equal(bodyOf({ mimeType: 'text/plain', body: { data: b64('Thanks, will do.\n\nOn Tue, 24 Nov 2026 at 10:00, Rui <r@x.pt> wrote:\n> the old text') } }), 'Thanks, will do.');
  assert.equal(bodyOf({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hello <b>Ana</b></p><style>x{}</style>') } }] }).replace(/\s+/g, ' ').trim(), 'Hello Ana');
});

test('Gmail: first run lists the window, later runs read only the history; a stale history starts again from scratch', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ google: { ...app.settings.get('google'), clientId: 'c', clientSecret: 's', refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 3600_000, gmail: true, email: 'ana@x.pt' } });
  const threads = {
    t1: { id: 't1', historyId: '10', messages: [mail('m1', 'Rui <rui@x.pt>', 'ana@x.pt', 'Tue, 24 Nov 2026 10:00:00 +0000', 'Can you send the contract?'), mail('m2', 'Ana <ana@x.pt>', 'rui@x.pt', 'Tue, 24 Nov 2026 11:00:00 +0000', 'Sending it Friday. Does that work for you?')] },
    t2: { id: 't2', historyId: '11', messages: [mail('m3', 'News <news@y.com>', 'ana@x.pt', 'Mon, 23 Nov 2026 09:00:00 +0000', 'Weekly digest')] },
  };
  let profile = '20', historyOk = true;
  const seen = [];
  w.on(/^\/gmail\/v1\/users\/me\/profile$/, () => [200, { emailAddress: 'ana@x.pt', historyId: profile, messagesTotal: 3 }]);
  w.on(/^\/gmail\/v1\/users\/me\/threads$/, (u) => { seen.push(`list q=${u.searchParams.get('q')}`); return [200, { threads: Object.keys(threads).map((id) => ({ id })) }]; });
  w.on(/^\/gmail\/v1\/users\/me\/threads\/(\w+)$/, (u, req, m) => (threads[m[1]] ? [200, threads[m[1]]] : [404, { error: { message: 'Requested entity was not found.' } }]));
  w.on(/^\/gmail\/v1\/users\/me\/history$/, (u) => { seen.push(`history ${u.searchParams.get('startHistoryId')}`); return historyOk ? [200, { historyId: '25', history: [{ messagesAdded: [{ message: { threadId: 't1' } }] }] }] : [404, { error: { message: 'Requested entity was not found.' } }]; });
  assert.equal((await app.sources.services.gmail.check(app.sources.ctx)).email, 'ana@x.pt');
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' } });
  assert.equal(src.sensitivity, 'private', 'mail is private unless you say otherwise');
  const r1 = await run(app, src);
  assert.deepEqual([r1.created, seen[0]], [2, 'list q=newer_than:30d']);
  const t1 = app.items.byExternal(src.id, 'thread:t1');
  assert.equal(t1.title, 'Contract terms');
  assert.equal(t1.kind, 'email');
  assert.match(t1.text, /From: Rui[\s\S]*Can you send the contract\?[\s\S]*———[\s\S]*Sending it Friday/);
  assert.deepEqual([t1.meta.lastFromMe, t1.meta.lastAsksSomething, t1.meta.messages], [true, true, 2], 'enough to know you asked something and are waiting');
  assert.equal(app.items.source(src.id).cursor, '20', 'the history id from BEFORE the listing, so nothing in between is missed');
  // incremental
  threads.t1.messages.push(mail('m4', 'Rui <rui@x.pt>', 'ana@x.pt', 'Wed, 25 Nov 2026 08:00:00 +0000', 'Friday is fine.'));
  seen.length = 0;
  const r2 = await run(app, app.items.source(src.id));
  assert.deepEqual([r2.created, r2.updated, r2.unchanged], [0, 1, 0]);
  assert.deepEqual(seen, ['history 20'], 'only the history was read, not the whole mailbox');
  assert.equal(app.items.byExternal(src.id, 'thread:t1').meta.lastFromMe, false);
  assert.equal(app.items.source(src.id).cursor, '25');
  // the history is too old: start again; what is no longer listed is tombstoned
  historyOk = false; delete threads.t2; seen.length = 0;
  const r3 = await run(app, app.items.source(src.id));
  assert.deepEqual(seen.slice(0, 2), ['history 25', 'list q=newer_than:30d'], 'a 404 on the history means a full resync');
  assert.equal(r3.removed, 1);
  assert.ok(app.items.byExternal(src.id, 'thread:t2').deletedAt);
  // without mail connected the connector says what to do
  app.settings.update({ google: { ...app.settings.get('google'), gmail: false } });
  assert.throws(() => app.sources.addRemote({ kind: 'gmail', config: {} }), /Connect gmail first/);
});

test('Google sign-in asks for mail only when you choose it', async () => {
  const { SCOPE, SCOPE_GMAIL } = require('../src/meetings/google');
  assert.ok(!SCOPE.includes('gmail'));
  assert.ok(SCOPE_GMAIL.includes('gmail.readonly') && !SCOPE_GMAIL.includes('gmail.send') && !SCOPE_GMAIL.includes('gmail.modify'), 'read-only: it can never send or change mail');
});

test('Notion and Linear: pages and issues you imported are read again and the meeting updates; nothing new is pulled in', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ notion: { ...app.settings.get('notion'), token: 'secret_x' } });
  const calls = [];
  app.integrations.importNotion = async (refs) => { calls.push(refs); return refs.map((r) => (r === 'p2' ? { id: r, updated: true } : { id: r, unchanged: true })); };
  app.importer.importMarkdown('# A\n\ntext', { title: 'A', source: 'notion', sourceRef: 'p1' });
  app.importer.importMarkdown('# B\n\ntext', { title: 'B', source: 'notion', sourceRef: 'p2' });
  app.importer.importMarkdown('# C\n\ntext', { title: 'C', source: 'obsidian', sourceRef: 'x.md' });
  const src = app.sources.addRemote({ kind: 'notion', name: 'Notion pages', config: {} });
  const r = await run(app, src);
  assert.deepEqual([calls.flat().sort(), r.updated, r.unchanged], [['p1', 'p2'], 1, 1], 'only the Notion pages you already imported');
  app.settings.update({ notion: { ...app.settings.get('notion'), token: '' } });
  assert.throws(() => app.sources.addRemote({ kind: 'notion', config: {} }), /Connect notion first/);
});

test('the services API lists what can be connected, and says which already have their token', async (t) => {
  const { createServer } = require('../src/server/http');
  const path = require('node:path');
  const { ROOT } = require('./helpers');
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  app.settings.update({ github: { token: 'x' } });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(() => srv.close());
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const list = (await call('GET', '/api/services')).body;
  assert.deepEqual(list.map((s) => s.kind).sort(), ['discord', 'github', 'gmail', 'imap', 'linear', 'notion', 'outlook', 'slack']);
  assert.equal(list.find((s) => s.kind === 'github').ready, true);
  assert.equal(list.find((s) => s.kind === 'slack').ready, false);
  assert.equal((await call('POST', '/api/sources/check', { service: 'slack' })).status, 412);
  w.on(/^\/user$/, () => [200, { login: 'ana' }]);
  assert.equal((await call('POST', '/api/sources/check', { service: 'github' })).body.user, 'ana');
  const added = await call('POST', '/api/sources', { service: 'github', name: 'o/r', config: { repos: ['o/r'] } });
  assert.equal(added.status, 200);
  assert.equal(added.body.sensitivity, 'private');
  assert.equal((await call('POST', '/api/sources', { service: 'slack', config: { channels: 'x' } })).status, 412);
});

test('the Inbox notices an e-mail you asked something in that nobody answered, and only that', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  const src = app.items.addSource({ kind: 'gmail', name: 'Mail', sensitivity: 'private', config: { remote: true } });
  const day = 86_400_000, now = Date.now();
  const thread = (id, lastAt, meta) => app.items.upsert(src.id, { externalId: `thread:${id}`, kind: 'email', title: `Subject ${id}`, text: 'x', uri: `https://mail/${id}`, occurredAt: lastAt, metaInHash: true, meta: { people: ['me@x.pt', 'rui@x.pt'], lastFrom: 'me@x.pt', lastAt, ...meta } });
  thread('waiting', now - 5 * day, { lastFromMe: true, lastAsksSomething: true });
  thread('fresh', now - 1 * day, { lastFromMe: true, lastAsksSomething: true });                  // too soon
  thread('ancient', now - 60 * day, { lastFromMe: true, lastAsksSomething: true });               // too old to nag about
  thread('statement', now - 5 * day, { lastFromMe: true, lastAsksSomething: false });             // you ended it yourself
  thread('answered', now - 5 * day, { lastFromMe: false, lastAsksSomething: true });              // they wrote last
  const cards = app.inbox.cards().filter((c) => c.type === 'noreply');
  assert.deepEqual(cards.map((c) => [c.title, c.days, c.to]), [['Subject waiting', 5, ['rui@x.pt']]]);
  assert.equal(app.inbox.counts().noreply, 1);
  app.inbox.dismissNoReply(cards[0].id);
  assert.equal(app.inbox.cards().filter((c) => c.type === 'noreply').length, 0, 'dismissed');
  thread('waiting', now - 4 * day, { lastFromMe: true, lastAsksSomething: true });                 // you wrote again: a new situation
  assert.equal(app.inbox.cards().filter((c) => c.type === 'noreply').length, 1);
});

test('Discord data package: the messages you wrote, in JSON or the older CSV layout, one item per channel per day, again without duplicates', async (t) => {
  const { zip } = require('../src/core/zip-writer');
  const { createServer } = require('../src/server/http');
  const path = require('node:path');
  const { ROOT } = require('./helpers');
  const { csv } = require('../src/connectors/discord-export');
  assert.deepEqual(csv('ID,Timestamp,Contents\n1,2026-11-25 10:00:00,"hello, ""world""\nsecond line"\n2,2026-11-25 10:01:00,plain'), [['ID', 'Timestamp', 'Contents'], ['1', '2026-11-25 10:00:00', 'hello, "world"\nsecond line'], ['2', '2026-11-25 10:01:00', 'plain']]);
  const w = await fakeWorld(); t.after(() => w.close());
  const app = await boot(t, w);
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(() => srv.close());
  const pkg = zip([
    { name: 'messages/index.json', data: JSON.stringify({ 111: 'general', 222: 'Direct Message with rui' }) },
    { name: 'messages/c111/messages.json', data: JSON.stringify([{ ID: '9', Timestamp: '2026-11-25T10:00:00+00:00', Contents: 'I will send the sheet tomorrow', Attachments: '' }, { ID: '10', Timestamp: '2026-11-25T11:00:00+00:00', Contents: '', Attachments: 'https://cdn/x.png' }]) },
    { name: 'messages/c222/messages.csv', data: 'ID,Timestamp,Contents,Attachments\n7,2026-11-24 09:00:00,Thanks Rui,\n' },
  ]);
  const send = (body) => fetch(`http://127.0.0.1:${port}/api/sources/discord-export`, { method: 'POST', headers: { Cookie: `wb_token=${token}`, 'Content-Type': 'application/octet-stream' }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const r1 = await send(pkg);
  assert.deepEqual([r1.status, r1.body.channels, r1.body.created], [200, 2, 2]);
  const src = app.items.source(r1.body.source);
  assert.equal(src.sensitivity, 'private');
  const day = app.items.byExternal(src.id, '111:2026-11-25');
  assert.equal(day.title, '#general · 2026-11-25');
  assert.match(day.text, /you: I will send the sheet tomorrow\n\[11:00\] you: \[attachment\]/);
  assert.equal(app.items.byExternal(src.id, '222:2026-11-24').title, '#DM: rui · 2026-11-24');
  const r2 = await send(pkg);
  assert.deepEqual([r2.body.created, r2.body.unchanged, r2.body.source], [0, 2, r1.body.source], 'again: the same items, nothing duplicated');
  assert.equal((await send(Buffer.from('not a zip'))).status >= 400, true);
  assert.equal((await send(zip([{ name: 'readme.txt', data: 'x' }]))).status, 400);
});
