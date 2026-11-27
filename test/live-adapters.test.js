'use strict';
// The live search adapters (src/search/adapters): a question asked of the service itself, never wider than the grant. Against SIMULATED
// servers that follow each service's documented API: they prove the logic (query splitting, the user-token requirement, the second check
// of every answer, nothing asked at metadata / none / expired), not that the real services answer the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/core/db');
const { ItemStore } = require('../src/items/store');
const ghSync = require('../src/connectors/github');
const slackSync = require('../src/connectors/slack');
const poll = require('../src/connectors/poll');
const { NotionClient } = require('../src/integrations/notion');
const { LinearClient } = require('../src/integrations/linear');
const gh = require('../src/search/adapters/github');
const sl = require('../src/search/adapters/slack');
const no = require('../src/search/adapters/notion');
const li = require('../src/search/adapters/linear');

async function fakeWorld() {
  const w = { routes: [], log: [], auth: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      w.log.push(`${req.method} ${url.pathname}${url.search}`); w.auth.push(req.headers.authorization);
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      for (const [re, fn] of w.routes) {
        const m = re.exec(url.pathname);
        if (m) { const [status, out, headers = {}] = fn(url, req, m, body); res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); return res.end(JSON.stringify(out)); }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'no such route' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  w.url = `http://127.0.0.1:${server.address().port}`;
  w.on = (re, fn) => w.routes.unshift([re, fn]);
  w.count = (re) => w.log.filter((l) => re.test(l)).length;
  w.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return w;
}
const store = () => new ItemStore(open(':memory:'));
const settingsOf = (cfg) => ({ get: (k) => cfg[k] || {} });
const live = (items, kind, config, grant) => items.addSource({ kind, name: kind, mode: 'copy', sensitivity: 'private', config: { ...config, remote: true }, grant: { liveSearch: true, ...grant } });
const NOW = Date.parse('2026-11-26T08:00:00Z');

test('every adapter has the same shape', () => {
  for (const a of [gh, sl, no, li]) {
    assert.equal(typeof a.provider, 'string');
    assert.equal(typeof a.label, 'string');
    for (const f of ['supports', 'search', 'open']) assert.equal(typeof a[f], 'function', `${a.provider}.${f}`);
  }
  assert.deepEqual([gh, sl, no, li].map((a) => a.provider), ['github', 'slack', 'notion', 'linear']);
  assert.ok(/title/i.test(no.note), 'Notion says it matches titles only');
  assert.equal(gh.supports({ kind: 'github' }), true);
  assert.equal(gh.supports({ kind: 'slack' }), false);
});

// ---------------------------------------------------------------- GitHub

test('GitHub: the repositories are split over queries of at most 256 characters and 5 boolean operators, and every repository is in one', () => {
  const repos = Array.from({ length: 40 }, (_, i) => `an-organisation/a-fairly-long-repository-name-${i}`);
  const qs = gh.buildQueries(repos, 'login bug');
  assert.ok(qs.length > 1);
  for (const { q } of qs) {
    assert.ok(q.length <= 256, `${q.length} characters`);
    assert.ok((q.match(/\b(?:AND|OR|NOT)\b/g) || []).length <= 5, 'at most 5 operators');
    assert.ok(q.startsWith('login bug '));
  }
  assert.deepEqual(qs.flatMap((x) => x.repos), repos, 'nothing lost, nothing repeated');
  // one repository: no operator and no parentheses
  assert.equal(gh.buildQueries(['o/r'], 'x')[0].q, 'x repo:o/r');
  // the person's words cannot change the shape of the query
  const evil = gh.buildQueries(['o/r', 'o/s'], 'bug OR repo:secret/private AND (x) NOT is:open in:title').map((x) => x.q);
  assert.equal(evil.length, 1);
  assert.ok(!/secret\/private/.test(evil[0]) && !/is:open/.test(evil[0]), evil[0]);
  assert.equal((evil[0].match(/\b(?:AND|OR|NOT)\b/g) || []).length, 1, 'only ours');
  // very long text is cut so that even a long repository name still fits
  const longq = gh.buildQueries(['o/' + 'r'.repeat(100)], 'word '.repeat(200));
  assert.ok(longq[0].q.length <= 256);
  assert.deepEqual(gh.buildQueries(repos, '   '), [], 'no words, no question');
  assert.deepEqual(gh.buildQueries([], 'x'), []);
});

function ghItem(n, repo, extra = {}) {
  return { number: n, title: `Login bug ${n}`, body: `The login fails ${n}\n\nsecond line`, state: 'open', user: { login: 'ana' }, labels: [{ name: 'bug' }], assignees: [], comments: 0, html_url: `https://github.com/${repo}/issues/${n}`, repository_url: `https://api.github.com/repos/${repo}`, created_at: '2026-11-01T10:00:00Z', updated_at: `2026-11-0${n}T10:00:00Z`, ...extra };
}
const ghCtx = (w, extra = {}) => ({ settings: settingsOf({ github: { token: 'ghp_x' } }), fetchImpl: globalThis.fetch, bases: { github: w.url }, sleep: async () => {}, ...extra });

test('GitHub search: asks only about the granted repositories, checks every answer again, honours the never-read list', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const items = store();
  const src = live(items, 'github', { repos: ['o/r', 'o/s'] }, { readLevel: 'part', filter: { never: { senders: ['mallory'], keywords: ['salary'] } } });
  const asked = [];
  w.on(/^\/search\/issues$/, (u) => {
    asked.push(u.searchParams.get('q'));
    return [200, { items: [ghItem(1, 'o/r'), ghItem(2, 'someone/else'), ghItem(3, 'o/s', { user: { login: 'mallory' } }), ghItem(4, 'O/S', { body: 'the salary' }), ghItem(5, 'o/s', { pull_request: {} })] }];
  });
  const out = await gh.search({ source: src, query: 'login', ctx: ghCtx(w) });
  assert.deepEqual(asked, ['login (repo:o/r OR repo:o/s)']);
  assert.deepEqual(out.map((r) => r.externalId), ['o/s#5', 'o/r#1'], 'newest first; not the other repository, not the never-read author or word');
  assert.deepEqual(Object.keys(out[0]).sort(), ['at', 'externalId', 'snippet', 'title', 'uri', 'who']);
  assert.equal(out[0].title, 'PR #5 Login bug 5');
  assert.equal(out[1].snippet, 'The login fails 1 second line');
  assert.equal(w.auth[0], 'Bearer ghp_x');
  assert.deepEqual((await gh.search({ source: src, query: 'login', limit: 1, ctx: ghCtx(w) })).length, 1);
});

test('GitHub search: many repositories become several queries, and the 30-a-minute window is waited for', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const items = store();
  const repos = Array.from({ length: 14 }, (_, i) => `acme/repo-${i}`);
  const src = live(items, 'github', { repos }, { readLevel: 'part' });
  const asked = [];
  let n = 0;
  w.on(/^\/search\/issues$/, (u) => { asked.push(u.searchParams.get('q')); n++; return [200, { items: [] }, n === 1 ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3) } : {}]; });
  const slept = [];
  await gh.search({ source: src, query: 'bug', ctx: ghCtx(w, { sleep: async (ms) => { slept.push(ms); } }) });
  assert.equal(asked.length, 3, '14 repositories, 6 to a query (5 operators)');
  assert.ok(asked.every((q) => q.length <= 256));
  assert.ok(slept.length === 1 && slept[0] > 0 && slept[0] <= 4000, `it waited for the window to reopen (${slept})`);
  // and a 403 "rate limit" answer is waited out once by the shared HTTP helper, then the same question is asked again
  const w2 = await fakeWorld(); t.after(() => w2.close());
  let tries = 0;
  w2.on(/^\/search\/issues$/, () => (++tries === 1 ? [403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'retry-after': '2' }] : [200, { items: [ghItem(1, 'o/r')] }]));
  const slept2 = [];
  const out = await gh.search({ source: live(items, 'github', { repos: ['o/r'] }, { readLevel: 'part' }), query: 'login', ctx: ghCtx(w2, { sleep: async (ms) => { slept2.push(ms); } }) });
  assert.deepEqual([out.length, slept2], [1, [2000]]);
});

test('GitHub search: at "all" the repositories come from what the token sees; at metadata, none or expired nothing is asked', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const items = store();
  w.on(/^\/user\/repos$/, () => [200, [{ full_name: 'o/a' }, { full_name: 'o/old', archived: true }]]);
  const asked = [];
  w.on(/^\/search\/issues$/, (u) => { asked.push(u.searchParams.get('q')); return [200, { items: [ghItem(1, 'o/a'), ghItem(2, 'o/old')] }]; });
  const all = live(items, 'github', { repos: [] }, { readLevel: 'all' });
  const out = await gh.search({ source: all, query: 'login', ctx: ghCtx(w) });
  assert.deepEqual(asked, ['login repo:o/a']);
  assert.deepEqual(out.map((r) => r.externalId), ['o/a#1'], 'an archived repository is not part of it');
  w.log.length = 0;
  for (const [level, extra] of [['metadata', {}], ['none', {}], ['all', { expiresAt: NOW - 1 }]]) {
    const src = live(items, 'github', { repos: ['o/r'] }, { readLevel: level, ...extra });
    assert.deepEqual(await gh.search({ source: src, query: 'login', ctx: ghCtx(w, { now: () => NOW }) }), [], level);
    await assert.rejects(gh.open({ source: src, externalId: 'o/r#1', ctx: ghCtx(w, { now: () => NOW }) }), (e) => e.status === 403);
  }
  assert.equal(w.log.length, 0, 'not one request');
  await assert.rejects(gh.search({ source: live(items, 'github', { repos: ['o/r'] }, { readLevel: 'part' }), query: 'x', ctx: { ...ghCtx(w), settings: settingsOf({}) } }), /GitHub token/);
});

test('GitHub open: gives exactly what the sync would have stored, and refuses a repository or an issue outside the grant', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const it1 = ghItem(1, 'o/r', { comments: 2, comments_url: `${w.url}/repos/o/r/issues/1/comments` });
  w.on(/^\/repos\/o\/r\/issues$/, () => [200, [it1]]);
  w.on(/^\/repos\/o\/r\/issues\/1$/, () => [200, it1]);
  w.on(/^\/repos\/o\/r\/issues\/2$/, () => [200, ghItem(2, 'o/r', { user: { login: 'mallory' } })]);
  w.on(/^\/repos\/o\/r\/issues\/1\/comments$/, () => [200, [{ user: { login: 'rui' }, created_at: '2026-11-02T09:00:00Z', body: 'Friday' }, { user: { login: 'mallory' }, created_at: '2026-11-02T10:00:00Z', body: 'x' }]]);
  const items = store();
  const src = live(items, 'github', { repos: ['o/r'] }, { readLevel: 'part', filter: { never: { senders: ['mallory'] } } });
  await ghSync.sync({ source: src, items, settings: settingsOf({ github: { token: 't' } }), fetchImpl: globalThis.fetch, bases: { github: w.url }, sleep: async () => {} });
  const stored = items.byExternal(src.id, 'o/r#1');
  const payload = await gh.open({ source: src, externalId: 'o/r#1', ctx: ghCtx(w) });
  for (const k of ['externalId', 'kind', 'title', 'text', 'uri', 'occurredAt']) assert.equal(payload[k], stored[k], k);
  assert.deepEqual(payload.meta, stored.meta);
  assert.equal(items.upsert(src.id, payload).action, 'unchanged', 'upserting it changes nothing: it is the same item');
  await assert.rejects(gh.open({ source: src, externalId: 'o/other#1', ctx: ghCtx(w) }), (e) => e.status === 403 && /not part/.test(e.message));
  await assert.rejects(gh.open({ source: src, externalId: 'o/r#2', ctx: ghCtx(w) }), (e) => e.status === 403 && /never-read/.test(e.message));
  await assert.rejects(gh.open({ source: src, externalId: 'nonsense', ctx: ghCtx(w) }), (e) => e.status === 400);
});

// ---------------------------------------------------------------- Slack

const sbase = Date.parse('2026-11-25T10:00:00Z') / 1000;
const slackCtx = (w, cfg = { token: 'xoxb-app', userToken: 'xoxp-user' }) => ({ settings: settingsOf({ slack: cfg }), fetchImpl: globalThis.fetch, bases: { slack: `${w.url}/api` }, sleep: async () => {} });
function slackWorld(w, matches) {
  w.on(/^\/api\/conversations.list$/, () => [200, { ok: true, channels: [{ id: 'C1', name: 'atlas', is_member: true }, { id: 'C2', name: 'hr', is_member: true }, { id: 'C3', name: 'lurk', is_member: false }] }]);
  w.on(/^\/api\/users.list$/, () => [200, { ok: true, members: [{ id: 'U1', real_name: 'Ana Silva', profile: {} }, { id: 'U2', profile: { display_name: 'rui' } }] }]);
  w.on(/^\/api\/search.messages$/, (u) => [200, { ok: true, messages: { matches: matches(u.searchParams.get('query')) } }]);
}
const smatch = (channel, user, text, ts = sbase) => ({ channel: { id: channel.id, name: channel.name }, user, username: user, text, ts: String(ts), permalink: `https://x.slack.com/archives/${channel.id}/p1` });

test('Slack search: needs a USER token (search:read); without it it says so instead of searching', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  slackWorld(w, () => []);
  const src = live(store(), 'slack', { channels: ['atlas'] }, { readLevel: 'part' });
  assert.equal(sl.supports(src, slackCtx(w)), true);
  assert.equal(sl.supports(src, slackCtx(w, { token: 'xoxb-app', userToken: '' })), false, 'no user token: not supported');
  assert.equal(sl.supports(src), true, 'without a context it only checks the kind');
  assert.equal(sl.supports({ kind: 'github' }, slackCtx(w)), false);
  await assert.rejects(sl.search({ source: src, query: 'x', ctx: slackCtx(w, { token: 'xoxb-app', userToken: '' }) }), (e) => e.code === 'needs-user-token' && /search:read/.test(e.message));
  assert.equal(w.count(/search.messages/), 0);
});

test('Slack search: one question per granted channel with in:#channel, asked with the user token; every answer is checked again', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const asked = [];
  slackWorld(w, (q) => {
    asked.push(q);
    return [smatch({ id: 'C1', name: 'atlas' }, 'U1', 'Shall we drop <@U2> the free tier?', sbase), smatch({ id: 'C9', name: 'private-elsewhere' }, 'U1', 'not granted', sbase + 5), smatch({ id: 'D1', name: 'U1' }, 'U1', 'a direct message', sbase + 6), smatch({ id: 'C1', name: 'atlas' }, 'mallory', 'by a never-read person', sbase + 7), smatch({ id: 'C1', name: 'atlas' }, 'U2', 'about the salary', sbase + 8)];
  });
  const items = store();
  const src = live(items, 'slack', { channels: ['atlas', 'hr'] }, { readLevel: 'part', filter: { never: { labels: ['hr'], senders: ['mallory'], keywords: ['salary'] } } });
  const out = await sl.search({ source: src, query: 'free tier in:#hr from:@someone', ctx: slackCtx(w) });
  assert.deepEqual(asked, ['free tier in:#atlas'], 'the person\'s own modifiers are dropped, the granted channel is ours; the never-read channel is not asked');
  assert.equal(w.auth[w.log.findIndex((l) => /search.messages/.test(l))], 'Bearer xoxp-user', 'the user token, not the app token');
  assert.equal(out.length, 1, 'not another channel, not a DM, not the never-read person or word');
  assert.deepEqual(out[0], { externalId: `C1:2026-11-25`, title: '#atlas · 2026-11-25', snippet: 'Shall we drop @U2 the free tier?', uri: 'https://x.slack.com/archives/C1/p1', at: sbase * 1000, who: 'U1' });
});

test('Slack search: at "all" it asks once, and keeps only channels the app is in; metadata, none and expired ask nothing', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const asked = [];
  slackWorld(w, (q) => { asked.push(q); return [smatch({ id: 'C1', name: 'atlas' }, 'U1', 'hello'), smatch({ id: 'C3', name: 'lurk' }, 'U1', 'a channel the app is not in'), smatch({ id: 'C2', name: 'hr' }, 'U1', 'hr stuff')]; });
  const items = store();
  const all = live(items, 'slack', { channels: [] }, { readLevel: 'all', filter: { never: { labels: ['hr'] } } });
  const out = await sl.search({ source: all, query: 'hello', ctx: slackCtx(w) });
  assert.deepEqual(asked, ['hello']);
  assert.deepEqual(out.map((r) => r.externalId), ['C1:2026-11-25']);
  w.log.length = 0;
  for (const [level, extra] of [['metadata', {}], ['none', {}], ['all', { expiresAt: NOW - 1 }]]) {
    const src = live(items, 'slack', { channels: ['atlas'] }, { readLevel: level, ...extra });
    assert.deepEqual(await sl.search({ source: src, query: 'hello', ctx: { ...slackCtx(w), now: () => NOW } }), [], level);
  }
  assert.equal(w.log.length, 0);
});

test('Slack open: a channel-day exactly as the sync stores it; a channel outside the grant is refused', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  slackWorld(w, () => []);
  w.on(/^\/api\/conversations.history$/, (u) => [200, { ok: true, messages: [{ ts: String(sbase), user: 'U1', text: 'Shall we drop the free tier? cc <@U2>', reply_count: 1, thread_ts: String(sbase) }, { ts: String(sbase + 60), user: 'U2', text: 'Yes' }, { ts: String(sbase + 90000), user: 'U2', text: 'the next day' }].filter((m) => Number(m.ts) >= Number(u.searchParams.get('oldest')) && (!u.searchParams.get('latest') || Number(m.ts) < Number(u.searchParams.get('latest')))) }]);
  w.on(/^\/api\/conversations.replies$/, () => [200, { ok: true, messages: [{ ts: String(sbase), thread_ts: String(sbase), user: 'U1', text: 'root' }, { ts: String(sbase + 120), thread_ts: String(sbase), user: 'U1', text: 'in a thread' }] }]);
  const items = store();
  const src = live(items, 'slack', { channels: ['atlas'] }, { readLevel: 'part' });
  await slackSync.sync({ source: src, items, settings: settingsOf({ slack: { token: 'xoxb-app' } }), fetchImpl: globalThis.fetch, bases: { slack: `${w.url}/api` }, sleep: async () => {}, now: () => Date.parse('2026-11-25T20:00:00Z') });
  const stored = items.byExternal(src.id, 'C1:2026-11-25');
  const payload = await sl.open({ source: src, externalId: 'C1:2026-11-25', ctx: slackCtx(w) });
  assert.deepEqual([payload.externalId, payload.kind, payload.title, payload.text, payload.uri], [stored.externalId, stored.kind, stored.title, stored.text, stored.uri]);
  assert.deepEqual(payload.meta, stored.meta);
  assert.match(payload.text, /in a thread/);
  assert.ok(!payload.text.includes('the next day'), 'only that day');
  assert.equal(items.upsert(src.id, payload).action, 'unchanged');
  await assert.rejects(sl.open({ source: src, externalId: 'C2:2026-11-25', ctx: slackCtx(w) }), (e) => e.status === 403);
  const never = live(items, 'slack', { channels: ['atlas'] }, { readLevel: 'part', filter: { never: { labels: ['atlas'] } } });
  await assert.rejects(sl.open({ source: never, externalId: 'C1:2026-11-25', ctx: slackCtx(w) }), (e) => e.status === 403 && /never-read/.test(e.message));
});

// ---------------------------------------------------------------- Notion

const rich = (t) => [{ type: 'text', plain_text: t, text: { content: t } }];
const npage = (id, title, edited) => ({ object: 'page', id, url: `https://notion.so/${id}`, created_time: '2026-10-01T00:00:00.000Z', last_edited_time: edited, properties: { Name: { type: 'title', title: rich(title) } } });
function notionWorld(w, pages) {
  w.on(/^\/v1\/search$/, (u, req, m, body) => [200, { results: [...pages, { object: 'database', id: 'd1', title: rich('A database'), url: 'u', last_edited_time: '2026-11-01T00:00:00.000Z' }], has_more: false, _body: body }]);
  w.on(/^\/v1\/pages\/([\w-]+)$/, (u, req, m) => [200, pages.find((p) => p.id === m[1])]);
  w.on(/^\/v1\/blocks\/([\w-]+)\/children$/, (u, req, m) => [200, { results: [{ type: 'paragraph', has_children: false, paragraph: { rich_text: rich(`Text of ${m[1]}`) } }], has_more: false }]);
}
const integrationsFor = (w) => ({ notion: () => new NotionClient({ token: 'n', baseUrl: `${w.url}/v1` }), linear: () => new LinearClient({ apiKey: 'l', url: `${w.url}/graphql` }) });
const nctx = (w, extra = {}) => ({ settings: settingsOf({ notion: { token: 'n' }, linear: { apiKey: 'l', teamId: 'team-1' } }), integrations: integrationsFor(w), ...extra });

test('Notion search: titles of pages (and says so), never a database or a title on the never-read list; open gives the same item as the sync', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  notionWorld(w, [npage('p1', 'Launch plan', '2026-11-02T10:00:00.000Z'), npage('p2', 'Salary bands', '2026-11-03T10:00:00.000Z')]);
  const items = store();
  const src = live(items, 'notion', { mode: 'all' }, { readLevel: 'all', filter: { never: { keywords: ['salary'] } } });
  const out = await no.search({ source: src, query: 'plan', ctx: nctx(w) });
  assert.deepEqual(out, [{ externalId: 'p1', title: 'Launch plan', snippet: '', uri: 'https://notion.so/p1', at: Date.parse('2026-11-02T10:00:00.000Z'), who: '' }]);
  assert.match(no.note, /titles only/);
  const body = w.log.find((l) => /search/.test(l));
  assert.ok(body);
  // open == what the sync stores for that page
  await poll.notion.sync({ source: src, items, app: { db: items.db }, ...nctx(w), integrations: { ...integrationsFor(w), importNotion: async () => [] } });
  const stored = items.byExternal(src.id, 'p1');
  const payload = await no.open({ source: src, externalId: 'p1', ctx: nctx(w) });
  assert.deepEqual([payload.externalId, payload.kind, payload.title, payload.text, payload.uri], [stored.externalId, stored.kind, stored.title, stored.text, stored.uri]);
  assert.equal(items.upsert(src.id, payload).action, 'unchanged');
  await assert.rejects(no.open({ source: src, externalId: 'p2', ctx: nctx(w) }), (e) => e.status === 403);
  // nothing at metadata, none or expired
  w.log.length = 0;
  for (const [level, extra] of [['metadata', {}], ['none', {}], ['all', { expiresAt: NOW - 1 }]]) {
    const s = live(items, 'notion', {}, { readLevel: level, ...extra });
    assert.deepEqual(await no.search({ source: s, query: 'plan', ctx: { ...nctx(w), now: () => NOW } }), [], level);
  }
  assert.equal(w.log.length, 0);
});

// ---------------------------------------------------------------- Linear

function linearWorld(w, issues) {
  w.on(/^\/graphql$/, (u, req, m, body) => {
    const q = body.query;
    if (/teams\(/.test(q)) return [200, { data: { teams: { nodes: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }, { id: 'team-2', key: 'OPS', name: 'Ops' }] } } }];
    if (/searchIssues/.test(q)) return [200, { data: { searchIssues: { nodes: issues.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, url: i.url, state: { name: 'Todo' }, assignee: i.assignee ? { name: i.assignee } : null })) } } }];
    if (/issue\(id/.test(q)) { const i = issues.find((x) => x.identifier === body.variables.id); return [200, { data: { issue: i ? { id: i.id, identifier: i.identifier, title: i.title, url: i.url, state: { name: 'Todo' }, assignee: i.assignee ? { name: i.assignee } : null, description: i.description, comments: { nodes: [{ body: 'On it', createdAt: '2026-11-03T11:00:00Z', user: { name: 'Rui' } }, { body: 'private', createdAt: '2026-11-03T12:00:00Z', user: { name: 'Mallory' } }] } } : null } }]; }
    return [200, { data: {} }];
  });
}
const ISSUES = [
  { id: 'i1', identifier: 'ENG-1', title: 'Fix login', url: 'https://linear.app/x/ENG-1', assignee: 'Ana', description: 'It fails' },
  { id: 'i2', identifier: 'OPS-7', title: 'Login in ops', url: 'u', assignee: 'Rui', description: 'x' },
  { id: 'i3', identifier: 'ENG-3', title: 'Login salary', url: 'u3', assignee: 'Ana', description: 'x' },
  { id: 'i4', identifier: 'ENG-4', title: 'Login by mallory', url: 'u4', assignee: 'Mallory', description: 'x' },
];

test('Linear search: the configured team only (checked again by its key), the never-read list, nothing at metadata; open gives the sync item', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  linearWorld(w, ISSUES);
  const items = store();
  const src = live(items, 'linear', { mode: 'all' }, { readLevel: 'all', filter: { never: { senders: ['mallory'], keywords: ['salary'] } } });
  const out = await li.search({ source: src, query: 'login', ctx: nctx(w) });
  assert.deepEqual(out.map((r) => r.externalId), ['ENG-1']);
  assert.deepEqual(out[0], { externalId: 'ENG-1', title: 'ENG-1 Fix login', snippet: 'Todo · Ana', uri: 'https://linear.app/x/ENG-1', at: 0, who: 'Ana' });
  // no team configured: the whole workspace (the never-read list still applies)
  const wide = await li.search({ source: src, query: 'login', ctx: nctx(w, { settings: settingsOf({ linear: { apiKey: 'l' } }) }) });
  assert.deepEqual(wide.map((r) => r.externalId), ['ENG-1', 'OPS-7']);
  // a team that cannot be found shows nothing rather than everything
  assert.deepEqual(await li.search({ source: src, query: 'login', ctx: nctx(w, { settings: settingsOf({ linear: { apiKey: 'l', teamId: 'gone' } }) }) }), []);
  // open
  const payload = await li.open({ source: src, externalId: 'ENG-1', ctx: nctx(w) });
  assert.deepEqual([payload.externalId, payload.kind, payload.title, payload.uri], ['ENG-1', 'issue', 'ENG-1 Fix login', 'https://linear.app/x/ENG-1']);
  assert.match(payload.text, /It fails[\s\S]*Rui[\s\S]*On it/);
  assert.equal(items.upsert(src.id, payload).action, 'created', 'it is an item like any other');
  await assert.rejects(li.open({ source: src, externalId: 'OPS-7', ctx: nctx(w) }), (e) => e.status === 403 && /team/.test(e.message));
  await assert.rejects(li.open({ source: src, externalId: 'ENG-4', ctx: nctx(w) }), (e) => e.status === 403 && /never-read/.test(e.message));
  w.log.length = 0;
  for (const [level, extra] of [['metadata', {}], ['none', {}], ['all', { expiresAt: NOW - 1 }]]) {
    const s = live(items, 'linear', {}, { readLevel: level, ...extra });
    assert.deepEqual(await li.search({ source: s, query: 'login', ctx: { ...nctx(w), now: () => NOW } }), [], level);
  }
  assert.equal(w.log.length, 0);
});
