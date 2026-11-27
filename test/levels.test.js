'use strict';
// What each service connector stores at each access level (src/access/grants.js): metadata keeps who/when/title and NO text, part keeps what
// the config lists minus the never-read list, all reads everything the token sees, an expired or "none" source reads nothing, and a source
// made before grants existed (no readLevel) behaves as it always did. Against SIMULATED servers that follow each service's documented API:
// they prove the logic, not that the real services answer the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/core/db');
const { ItemStore } = require('../src/items/store');
const slack = require('../src/connectors/slack');
const discord = require('../src/connectors/discord');
const github = require('../src/connectors/github');
const poll = require('../src/connectors/poll');
const chat = require('../src/connectors/chat');
const { NotionClient } = require('../src/integrations/notion');
const { LinearClient } = require('../src/integrations/linear');
const { toEvent, busyEvent } = require('../src/meetings/google');
const { Calendar } = require('../src/meetings/calendar');

// one local server, a route table the test fills in: handler(url, req, match, body) -> [status, body, headers?]
async function fakeWorld() {
  const w = { routes: [], log: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      w.log.push(`${req.method} ${url.pathname}${url.search}`);
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
const base = (w) => ({ fetchImpl: globalThis.fetch, sleep: async () => {}, bases: { slack: `${w.url}/api`, github: w.url, discord: `${w.url}/api/v10` } });
const grant = (readLevel, extra = {}) => ({ readLevel, ...extra });
const live = (items, kind, config, g) => items.addSource({ kind, name: kind, mode: 'copy', sensitivity: 'private', config: { ...config, remote: true }, grant: g });
const textOf = (items, sourceId) => items.db.prepare('SELECT text FROM items WHERE source_id = ?').all(sourceId).map((r) => r.text).join('\n');
const NOW = Date.parse('2026-11-26T08:00:00Z');

// ---------------------------------------------------------------- the chat helper

test('chat: the never-read list leaves out a channel, a person, an address domain or a word; an empty list leaves out nothing', () => {
  const never = { labels: ['#hr', 'legal'], senders: ['@Mallory', 'U9'], domains: ['evil.io'], keywords: ['salary'] };
  assert.equal(chat.neverRead(never, { channel: '#hr' }), true);
  assert.equal(chat.neverRead(never, { channel: ['#general', 'legal'] }), true);
  assert.equal(chat.neverRead(never, { who: 'mallory' }), true);
  assert.equal(chat.neverRead(never, { who: 'someone', uid: 'U9' }), true);
  assert.equal(chat.neverRead(never, { email: 'x@sub.evil.io' }), true);
  assert.equal(chat.neverRead(never, { text: 'about my SALARY review' }), true);
  assert.equal(chat.neverRead(never, { channel: '#general', who: 'ana', text: 'lunch?' }), false);
  assert.equal(chat.neverRead({}, { channel: '#hr', text: 'salary' }), false);
  assert.equal(chat.neverRead(undefined, { text: 'salary' }), false);
  const msgs = [{ who: 'ana', text: 'hi' }, { who: 'mallory', text: 'hello' }, { who: 'rui', text: 'my salary' }];
  assert.deepEqual(chat.filterNever(never, { name: '#general', id: 'C1' }, msgs).map((m) => m.who), ['ana']);
  assert.deepEqual(chat.filterNever(never, { name: '#hr', id: 'C2' }, msgs), [], 'a channel on the list gives nothing at all');
  assert.equal(chat.filterNever({}, { name: '#x' }, msgs), msgs);
});

test('chat: a source without a grant reads as "part"; none and an expired grant block the run', () => {
  assert.equal(chat.levelOf({}), 'part');
  assert.equal(chat.levelOf({ readLevel: 'metadata' }), 'metadata');
  assert.equal(chat.blockedReason({ readLevel: 'none' }), 'nothing may be read');
  assert.equal(chat.blockedReason({ readLevel: 'all', expiresAt: 5 }, 10), 'access expired');
  assert.equal(chat.blockedReason({ readLevel: 'all', expiresAt: 50 }, 10), null);
  assert.equal(chat.blockedReason({}), null);
});

// ---------------------------------------------------------------- Slack

async function slackWorld(t, { channels, history, replies } = {}) {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/api\/users.list$/, () => [200, { ok: true, members: [{ id: 'U1', real_name: 'Ana Silva', profile: {} }, { id: 'U2', profile: { display_name: 'rui' } }, { id: 'U9', profile: { display_name: 'mallory' } }] }]);
  w.on(/^\/api\/conversations.list$/, (u) => {
    const all = channels || [{ id: 'C1', name: 'atlas', is_member: true }, { id: 'C2', name: 'hr', is_member: true }, { id: 'C3', name: 'lurk', is_member: false }];
    const from = Number(u.searchParams.get('cursor') || 0), per = 200;
    return [200, { ok: true, channels: all.slice(from, from + per), response_metadata: { next_cursor: from + per < all.length ? String(from + per) : '' } }];
  });
  w.on(/^\/api\/conversations.history$/, (u) => [200, { ok: true, messages: (history ? history(u.searchParams.get('channel')) : []).filter((m) => Number(m.ts) >= Number(u.searchParams.get('oldest'))) }]);
  w.on(/^\/api\/conversations.replies$/, () => [200, { ok: true, messages: replies || [] }]);
  return w;
}
const base0 = Date.parse('2026-11-25T10:00:00Z') / 1000;
const slackMsgs = (ch) => (ch === 'C2' ? [{ ts: String(base0), user: 'U1', text: 'salary talk' }] : [
  { ts: String(base0), user: 'U1', text: 'Shall we drop the free tier?', reply_count: 1, thread_ts: String(base0) },
  { ts: String(base0 + 60), user: 'U2', text: 'Yes, sending the sheet Friday' },
  { ts: String(base0 + 120), user: 'U9', text: 'ignore me' },
  { ts: String(base0 + 180), user: 'U2', text: 'my salary is private' },
]);

test('Slack: metadata keeps who wrote and how much, with no message text and no thread requests', async (t) => {
  const w = await slackWorld(t, { history: slackMsgs, replies: [{ ts: String(base0 + 5), thread_ts: String(base0), user: 'U1', text: 'a reply' }] });
  const items = store();
  const src = live(items, 'slack', { channels: ['atlas'] }, grant('metadata'));
  const r = await slack.sync({ source: src, items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW });
  assert.equal(r.created, 1);
  const it = items.byExternal(src.id, 'C1:2026-11-25');
  assert.equal(it.text, '');
  assert.match(it.title, /#atlas · 2026-11-25 · 4 messages from Ana Silva, rui, mallory/);
  assert.deepEqual([it.meta.messages, it.meta.people, it.meta.metadataOnly], [4, ['Ana Silva', 'rui', 'mallory'], true]);
  assert.equal(w.count(/conversations.replies/), 0, 'replies are text: not fetched at metadata');
  assert.ok(!textOf(items, src.id).includes('free tier'));
  // widening to "part" must read the text now, not continue after what was read as titles only
  items.setGrant(src.id, { readLevel: 'part' });
  await slack.sync({ source: items.source(src.id), items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW });
  assert.match(items.byExternal(src.id, 'C1:2026-11-25').text, /Shall we drop the free tier\?/);
});

test('Slack: at "part" the never-read list is applied before storing (a channel, a person, a word)', async (t) => {
  const w = await slackWorld(t, { history: slackMsgs });
  const items = store();
  const never = { labels: ['hr'], senders: ['mallory'], keywords: ['salary'] };
  const src = live(items, 'slack', { channels: ['atlas', 'hr'] }, grant('part', { filter: { never } }));
  const r = await slack.sync({ source: src, items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW });
  assert.equal(r.created, 1, 'the channel on the list gives no item at all');
  assert.equal(items.byExternal(src.id, 'C2:2026-11-25'), null);
  const text = items.byExternal(src.id, 'C1:2026-11-25').text;
  assert.match(text, /free tier/);
  assert.match(text, /Yes, sending the sheet/);
  assert.ok(!/ignore me|salary/.test(text), 'the person and the word never reach the item');
  assert.equal(w.count(/conversations.history/), 1, 'the channel on the list is not even asked for its messages');
  // a channel that joins the list later is forgotten
  items.setGrant(src.id, { filter: { never: { ...never, labels: ['hr', 'atlas'] } } });
  const r2 = await slack.sync({ source: items.source(src.id), items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW });
  assert.equal(r2.removed, 1);
  assert.ok(items.byExternal(src.id, 'C1:2026-11-25').deletedAt);
});

test('Slack: at "all" every channel the app is in is read (paginated, capped at 300); the ones it is not in are not', async (t) => {
  const many = Array.from({ length: 305 }, (_, i) => ({ id: `C${1000 + i}`, name: `ch${i}`, is_member: true }));
  const w = await slackWorld(t, { channels: [...many, { id: 'CNOT', name: 'outside', is_member: false }], history: () => [{ ts: String(base0), user: 'U1', text: 'hello' }] });
  const items = store();
  const src = live(items, 'slack', { channels: [] }, grant('all'));
  const r = await slack.sync({ source: src, items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW });
  assert.equal(r.created, 300, 'capped at 300 channels');
  assert.equal(w.count(/conversations.list/), 2, 'the listing was paginated (200 a page)');
  assert.equal(w.count(/channel=CNOT/), 0, 'a channel the app is not in is never read');
});

test('Slack: validate accepts no channels only for level "all"; an expired source and level "none" read nothing', async (t) => {
  assert.throws(() => slack.validate({ channels: '' }), /at least one channel/);
  assert.deepEqual(slack.validate({ channels: '' }, { readLevel: 'all' }), { channels: [], all: true });
  assert.deepEqual(slack.validate({ channels: '#a, b' }).channels, ['a', 'b']);
  const w = await slackWorld(t, { history: slackMsgs });
  const items = store();
  const src = live(items, 'slack', { channels: ['atlas'] }, grant('all', { expiresAt: NOW - 1 }));
  const r = await slack.sync({ source: src, items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW });
  assert.equal(r.skipped, 'access expired');
  assert.equal(w.log.length, 0, 'not one request was made');
  const none = live(items, 'slack', { channels: ['atlas'] }, grant('none'));
  assert.equal((await slack.sync({ source: none, items, settings: settingsOf({ slack: { token: 'x' } }), ...base(w), now: () => NOW })).skipped, 'nothing may be read');
  assert.equal(w.log.length, 0);
});

// ---------------------------------------------------------------- Discord

const id = (ms) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const at = Date.parse('2026-11-25T14:00:00Z');
const dmsg = (n, user, content, uid = '1') => ({ id: id(at + n * 60000), type: 0, content, timestamp: new Date(at + n * 60000).toISOString(), author: { id: uid, username: user } });

async function discordWorld(t, { channels, messages } = {}) {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/api\/v10\/guilds\/(\d+)\/channels$/, () => [200, channels || [{ id: '111111111111111111', name: 'general', type: 0 }, { id: '222222222222222222', name: 'voice', type: 2 }, { id: '333333333333333333', name: 'hr', type: 0 }, { id: '444444444444444444', name: 'news', type: 5 }, { id: '555555555555555555', name: 'Category', type: 4 }]]);
  w.on(/^\/api\/v10\/channels\/(\d+)$/, (u, req, m) => [200, { id: m[1], name: 'general', guild_id: '999999999999999999' }]);
  w.on(/^\/api\/v10\/channels\/(\d+)\/messages$/, (u, req, m) => [200, (messages ? messages(m[1]) : []).filter((x) => BigInt(x.id) > BigInt(u.searchParams.get('after')))]);
  return w;
}
const dsettings = settingsOf({ discord: { token: 'bot', guildId: '' } });

test('Discord: metadata keeps who wrote and how much, no text; part applies the never-read list; both before storing', async (t) => {
  const w = await discordWorld(t, { messages: () => [dmsg(0, 'ana', 'Shall we ship in March?'), dmsg(1, 'rui', 'I will review the contract', '2'), dmsg(2, 'mallory', 'secret plan', '9')] });
  const items = store();
  const meta = live(items, 'discord', { channels: ['111111111111111111'] }, grant('metadata'));
  await discord.sync({ source: meta, items, settings: dsettings, ...base(w), now: () => at + 3600_000 });
  const it = items.byExternal(meta.id, '111111111111111111:2026-11-25');
  assert.equal(it.text, '');
  assert.match(it.title, /3 messages from ana, rui, mallory/);
  assert.equal(it.meta.messages, 3);
  const part = live(items, 'discord', { channels: ['111111111111111111'] }, grant('part', { filter: { never: { senders: ['mallory'], keywords: ['contract'] } } }));
  await discord.sync({ source: part, items, settings: dsettings, ...base(w), now: () => at + 3600_000 });
  const text = items.byExternal(part.id, '111111111111111111:2026-11-25').text;
  assert.match(text, /Shall we ship in March\?/);
  assert.ok(!/secret plan|contract/.test(text));
});

test('Discord: at "all" every text channel of the server is read (not voice or categories), the never-read channels are skipped; validate needs the server id', async (t) => {
  assert.throws(() => discord.validate({ channels: '' }, { readLevel: 'all' }), /server id/);
  assert.deepEqual(discord.validate({ channels: '', guildId: '999999999999999999' }, { readLevel: 'all' }), { channels: [], guildId: '999999999999999999', all: true });
  const w = await discordWorld(t, { messages: (ch) => [dmsg(0, 'ana', `hello from ${ch}`)] });
  const items = store();
  const src = live(items, 'discord', { channels: [], guildId: '999999999999999999' }, grant('all', { filter: { never: { labels: ['hr'] } } }));
  const r = await discord.sync({ source: src, items, settings: dsettings, ...base(w), now: () => at + 3600_000 });
  assert.equal(r.created, 2, 'general and the announcement channel; not voice, not the category, not hr');
  assert.ok(items.byExternal(src.id, '111111111111111111:2026-11-25') && items.byExternal(src.id, '444444444444444444:2026-11-25'));
  assert.equal(w.count(/channels\/(222|333|555)/), 0, 'the others are never asked for');
  assert.equal(w.count(/\/guilds\/999999999999999999\/channels/), 1);
});

test('Discord: a source with no grant reads its channels as before; an expired one reads nothing', async (t) => {
  const w = await discordWorld(t, { messages: () => [dmsg(0, 'ana', 'hello')] });
  const items = store();
  const old = { ...live(items, 'discord', { channels: ['111111111111111111'] }, {}), readLevel: undefined };
  assert.equal((await discord.sync({ source: old, items, settings: dsettings, ...base(w), now: () => at + 3600_000 })).created, 1);
  const gone = live(items, 'discord', { channels: ['111111111111111111'] }, grant('all', { expiresAt: 1 }));
  w.log.length = 0;
  assert.equal((await discord.sync({ source: gone, items, settings: dsettings, ...base(w), now: () => at })).skipped, 'access expired');
  assert.equal(w.log.length, 0);
});

// ---------------------------------------------------------------- GitHub

const issue = (n, extra = {}) => ({ number: n, title: `Thing ${n}`, body: `Body of ${n}`, state: 'open', user: { login: 'ana' }, labels: [{ name: 'bug' }], assignees: [], comments: 1, comments_url: `http://example.invalid/c/${n}`, html_url: `https://github.com/o/r/issues/${n}`, created_at: '2026-11-01T10:00:00Z', updated_at: `2026-11-0${n}T10:00:00Z`, ...extra });

async function githubWorld(t, repoIssues) {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/repos\/([^/]+\/[^/]+)\/issues$/, (u, req, m) => [200, (repoIssues[m[1]] || []).map((i) => ({ ...i, comments_url: `${w.url}/repos/${m[1]}/issues/${i.number}/comments` }))]);
  w.on(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, () => [200, [{ user: { login: 'rui' }, created_at: '2026-11-02T09:00:00Z', body: 'I will fix it by Friday' }, { user: { login: 'mallory' }, created_at: '2026-11-02T10:00:00Z', body: 'my comment' }]]);
  return w;
}

test('GitHub: metadata keeps title, state, author, labels and date, no body, no comments and no comment requests', async (t) => {
  const w = await githubWorld(t, { 'o/r': [issue(1), issue(2, { pull_request: {} })] });
  const items = store();
  const src = live(items, 'github', { repos: ['o/r'] }, grant('metadata'));
  const r = await github.sync({ source: src, items, settings: settingsOf({ github: { token: 't' } }), ...base(w), now: () => NOW });
  assert.equal(r.created, 2);
  const it = items.byExternal(src.id, 'o/r#1');
  assert.equal(it.text, '');
  assert.match(it.title, /Issue #1 Thing 1/);
  assert.deepEqual([it.meta.state, it.meta.author, it.meta.labels, it.meta.metadataOnly], ['open', 'ana', ['bug'], true]);
  assert.equal(items.byExternal(src.id, 'o/r#2').meta.pr, true);
  assert.equal(w.count(/comments/), 0, 'comments are text: never requested at metadata');
  assert.ok(!textOf(items, src.id).includes('Body of'));
});

test('GitHub: at "part" the never-read list and the filter apply before storing (author, label, word; a comment alone is left out)', async (t) => {
  const w = await githubWorld(t, { 'o/r': [issue(1), issue(2, { user: { login: 'mallory' } }), issue(3, { labels: [{ name: 'hr' }] }), issue(4, { body: 'my salary' }), issue(5, { labels: [{ name: 'wontfix' }] })] });
  const items = store();
  const src = live(items, 'github', { repos: ['o/r'] }, grant('part', { filter: { excludeLabels: ['wontfix'], never: { senders: ['mallory'], labels: ['hr'], keywords: ['salary'] } } }));
  const r = await github.sync({ source: src, items, settings: settingsOf({ github: { token: 't' } }), ...base(w), now: () => NOW });
  assert.equal(r.created, 1);
  const text = items.byExternal(src.id, 'o/r#1').text;
  assert.match(text, /rui \(2026-11-02\): I will fix it by Friday/);
  assert.ok(!text.includes('my comment'), 'a comment by a never-read person is left out, not the whole issue');
  for (const n of [2, 3, 4, 5]) assert.equal(items.byExternal(src.id, `o/r#${n}`), null, `issue ${n} is never stored`);
});

test('GitHub: at "all" every repository the token sees is read (paginated, archived skipped unless asked); validate needs no list', async (t) => {
  assert.deepEqual(github.validate({ repos: '' }, { readLevel: 'all' }), { repos: [], all: true });
  assert.throws(() => github.validate({ repos: '' }), /at least one repository/);
  const w = await githubWorld(t, { 'o/a': [issue(1)], 'o/b': [issue(2)], 'o/old': [issue(3)], 'o/c': [issue(4)] });
  w.on(/^\/user\/repos$/, (u) => (u.searchParams.get('page') === '2' ? [200, [{ full_name: 'o/c' }]] : [200, [{ full_name: 'o/a' }, { full_name: 'o/b' }, { full_name: 'o/old', archived: true }], { Link: `<${w.url}/user/repos?page=2>; rel="next"` }]));
  const items = store();
  const src = live(items, 'github', { repos: [] }, grant('all'));
  const r = await github.sync({ source: src, items, settings: settingsOf({ github: { token: 't' } }), ...base(w), now: () => NOW });
  assert.equal(r.created, 3);
  assert.equal(items.byExternal(src.id, 'o/old#3'), null, 'archived repositories are skipped');
  assert.ok(items.byExternal(src.id, 'o/c#4'), 'the second page of the listing was read');
  const withOld = live(items, 'github', { repos: [], includeArchived: true }, grant('all'));
  const r2 = await github.sync({ source: withOld, items, settings: settingsOf({ github: { token: 't' } }), ...base(w), now: () => NOW });
  assert.equal(r2.created, 4);
});

test('GitHub: an expired source and level "none" read nothing; no grant = as before', async (t) => {
  const w = await githubWorld(t, { 'o/r': [issue(1)] });
  const items = store();
  const cfg = settingsOf({ github: { token: 't' } });
  const gone = live(items, 'github', { repos: ['o/r'] }, grant('all', { expiresAt: NOW - 1 }));
  assert.equal((await github.sync({ source: gone, items, settings: cfg, ...base(w), now: () => NOW })).skipped, 'access expired');
  assert.equal((await github.sync({ source: live(items, 'github', { repos: ['o/r'] }, grant('none')), items, settings: cfg, ...base(w), now: () => NOW })).skipped, 'nothing may be read');
  assert.equal(w.log.length, 0);
  const old = { ...live(items, 'github', { repos: ['o/r'] }, {}), readLevel: undefined };
  const r = await github.sync({ source: old, items, settings: cfg, ...base(w), now: () => NOW });
  assert.match(items.byExternal(old.id, 'o/r#1').text, /Body of 1/);
  assert.equal(r.created, 1);
});

// ---------------------------------------------------------------- Notion and Linear: mode 'all'

const rich = (t) => [{ type: 'text', plain_text: t, text: { content: t } }];
const npage = (id, title, edited) => ({ object: 'page', id, url: `https://notion.so/${id}`, created_time: '2026-10-01T00:00:00.000Z', last_edited_time: edited, properties: { Name: { type: 'title', title: rich(title) } } });

async function notionWorld(t, pages) {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/v1\/search$/, (u, req, m, body) => {
    const sorted = [...pages].sort((a, b) => (a.last_edited_time < b.last_edited_time ? 1 : -1));
    const from = Number(body.start_cursor || 0), per = 2;
    return [200, { results: sorted.slice(from, from + per), has_more: from + per < sorted.length, next_cursor: String(from + per) }];
  });
  w.on(/^\/v1\/pages\/([\w-]+)$/, (u, req, m) => [200, pages.find((p) => p.id === m[1])]);
  w.on(/^\/v1\/blocks\/([\w-]+)\/children$/, (u, req, m) => [200, { results: [{ type: 'paragraph', has_children: false, paragraph: { rich_text: rich(`Text of ${m[1]}`) } }], has_more: false }]);
  return w;
}
const pollCtx = (w, extra = {}) => ({
  settings: settingsOf({ notion: { token: 'n' }, linear: { apiKey: 'l', teamId: 'team-1' } }),
  integrations: { notion: () => new NotionClient({ token: 'n', baseUrl: `${w.url}/v1` }), linear: () => new LinearClient({ apiKey: 'l', url: `${w.url}/graphql` }), importNotion: async () => [], importLinear: async () => [] },
  ...extra,
});

test('Notion: mode "all" at level "all" syncs every page shared with the integration, newest first, only what changed since', async (t) => {
  const pages = [npage('p1', 'Plan', '2026-11-01T10:00:00.000Z'), npage('p2', 'Roadmap', '2026-11-02T10:00:00.000Z'), npage('p3', 'Salary bands', '2026-11-03T10:00:00.000Z')];
  const w = await notionWorld(t, pages);
  const items = store();
  const app = { db: items.db };
  const src = live(items, 'notion', { mode: 'all' }, grant('all', { filter: { never: { keywords: ['salary'] } } }));
  const r = await poll.notion.sync({ source: src, items, app, ...pollCtx(w) });
  assert.equal(r.created, 2, 'the page whose title is on the never-read list is not stored');
  const it = items.byExternal(src.id, 'p1');
  assert.equal(it.kind, 'document');
  assert.equal(it.title, 'Plan');
  assert.match(it.text, /Text of p1/);
  assert.equal(items.byExternal(src.id, 'p3'), null);
  assert.equal(w.count(/search/), 2, 'two pages of results were read');
  // nothing changed: the sweep stops at what it already knows, reads no page
  w.log.length = 0;
  const again = await poll.notion.sync({ source: items.source(src.id), items, app, ...pollCtx(w) });
  assert.equal(again.created + again.updated, 0);
  assert.equal(w.count(/\/pages\//), 0);
  // one page is edited: only it is read again
  pages[0] = npage('p1', 'Plan v2', '2026-11-09T10:00:00.000Z');
  w.log.length = 0;
  const third = await poll.notion.sync({ source: items.source(src.id), items, app, ...pollCtx(w) });
  assert.equal(third.updated, 1);
  assert.equal(items.byExternal(src.id, 'p1').title, 'Plan v2');
  assert.equal(w.count(/\/pages\//), 1);
});

test('Notion: at metadata only titles are kept (no page is read); at "part" the mode "all" does nothing; a source with no grant is unchanged', async (t) => {
  const w = await notionWorld(t, [npage('p1', 'Plan', '2026-11-01T10:00:00.000Z')]);
  const items = store();
  const app = { db: items.db };
  const meta = live(items, 'notion', { mode: 'all' }, grant('metadata'));
  await poll.notion.sync({ source: meta, items, app, ...pollCtx(w) });
  assert.equal(items.byExternal(meta.id, 'p1').text, '');
  assert.equal(w.count(/\/pages\//) + w.count(/children/), 0);
  const part = live(items, 'notion', { mode: 'all' }, grant('part'));
  w.log.length = 0;
  const r = await poll.notion.sync({ source: part, items, app, ...pollCtx(w) });
  assert.equal(w.count(/search/), 0);
  assert.equal(r.created, 0);
  const old = { ...live(items, 'notion', {}, {}), readLevel: undefined };
  w.log.length = 0;
  await poll.notion.sync({ source: old, items, app, ...pollCtx(w) });
  assert.equal(w.count(/search/), 0, 'without mode "all" nothing new is pulled in');
  assert.deepEqual(poll.notion.validate({ mode: 'all', junk: 1 }), { poll: true, mode: 'all' });
  assert.deepEqual(poll.notion.validate({}), { poll: true });
});

test('Linear: mode "all" at level "all" syncs every issue of the configured team as items, resumably paginated, incremental by updatedAt', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  let issues = [
    { id: 'i1', identifier: 'ENG-1', title: 'Fix login', description: 'It fails', url: 'https://linear.app/x/ENG-1', updatedAt: '2026-11-03T10:00:00.000Z', state: { name: 'Todo' }, assignee: { name: 'Ana' }, creator: { name: 'Ana' }, labels: { nodes: [{ name: 'bug' }] }, comments: { nodes: [{ body: 'On it', createdAt: '2026-11-03T11:00:00Z', user: { name: 'Rui' } }, { body: 'my salary', createdAt: '2026-11-03T12:00:00Z', user: { name: 'Mallory' } }] } },
    { id: 'i2', identifier: 'ENG-2', title: 'Secret hiring', description: 'x', url: 'u', updatedAt: '2026-11-02T10:00:00.000Z', state: { name: 'Todo' }, assignee: null, creator: { name: 'Ana' }, labels: { nodes: [{ name: 'hr' }] }, comments: { nodes: [] } },
    { id: 'i3', identifier: 'ENG-3', title: 'Old thing', description: 'old', url: 'u3', updatedAt: '2026-11-01T10:00:00.000Z', state: { name: 'Done' }, assignee: null, creator: { name: 'Ana' }, labels: { nodes: [] }, comments: { nodes: [] } },
  ];
  const seenFilters = [];
  w.on(/^\/graphql$/, (u, req, m, body) => {
    seenFilters.push(body.variables.filter);
    const since = body.variables.filter?.updatedAt?.gt || '';
    const rows = issues.filter((i) => i.updatedAt > since);
    const from = Number(body.variables.after || 0), per = 2;
    return [200, { data: { issues: { nodes: rows.slice(from, from + per), pageInfo: { hasNextPage: from + per < rows.length, endCursor: String(from + per) } } } }];
  });
  const items = store();
  const app = { db: items.db };
  const src = live(items, 'linear', { mode: 'all' }, grant('all', { filter: { never: { labels: ['hr'], senders: ['mallory'] } } }));
  const r = await poll.linear.sync({ source: src, items, app, ...pollCtx(w) });
  assert.equal(r.created, 2, 'the issue with a never-read label is not stored');
  assert.equal(seenFilters[0].team.id.eq, 'team-1');
  const it = items.byExternal(src.id, 'ENG-1');
  assert.deepEqual([it.kind, it.title], ['issue', 'ENG-1 Fix login']);
  assert.match(it.text, /It fails[\s\S]*Rui[\s\S]*On it/);
  assert.ok(!it.text.includes('my salary'), 'a comment by a never-read person is left out');
  assert.equal(items.byExternal(src.id, 'ENG-2'), null);
  // incremental: only what changed after the newest seen
  issues = [{ ...issues[2], title: 'Old thing renamed', updatedAt: '2026-11-09T10:00:00.000Z' }, ...issues.slice(0, 2)];
  seenFilters.length = 0;
  const r2 = await poll.linear.sync({ source: items.source(src.id), items, app, ...pollCtx(w) });
  assert.equal(seenFilters[0].updatedAt.gt, '2026-11-03T10:00:00.000Z');
  assert.equal(r2.updated, 1);
  assert.equal(items.byExternal(src.id, 'ENG-3').title, 'ENG-3 Old thing renamed');
  // metadata: titles and states, no text, no description or comments asked for
  const meta = live(items, 'linear', { mode: 'all' }, grant('metadata'));
  await poll.linear.sync({ source: meta, items, app, ...pollCtx(w) });
  assert.equal(items.byExternal(meta.id, 'ENG-1').text, '');
});

test('Linear: no configured team stops with a clear message; an expired source reads nothing', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  const items = store();
  const app = { db: items.db };
  const src = live(items, 'linear', { mode: 'all' }, grant('all'));
  await assert.rejects(poll.linear.sync({ source: src, items, app, ...pollCtx(w, { settings: settingsOf({ linear: { apiKey: 'l' } }) }) }), /Pick a Linear team/);
  const gone = live(items, 'linear', { mode: 'all' }, grant('all', { expiresAt: 1 }));
  assert.equal((await poll.linear.sync({ source: gone, items, app, ...pollCtx(w) })).skipped, 'access expired');
  assert.equal(w.log.length, 0);
});

// ---------------------------------------------------------------- Calendar detail

test('Calendar: free/busy detail shows only when someone is busy: title "Busy", no attendees, description, location or join link', async () => {
  const raw = { id: 'e1', iCalUID: 'u1', summary: 'Salary review with HR', description: 'zoom https://zoom.us/j/123', location: 'Room 4', start: { dateTime: '2026-11-26T10:00:00Z' }, end: { dateTime: '2026-11-26T11:00:00Z' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', organizer: { email: 'boss@x.pt', displayName: 'Boss' }, attendees: [{ email: 'ana@x.pt', displayName: 'Ana', responseStatus: 'accepted' }] };
  const full = toEvent(raw, { id: 'cal' });
  assert.equal(full.summary, 'Salary review with HR');
  assert.equal(full.attendees.length, 1);
  const busy = toEvent(raw, { id: 'cal' }, { detail: 'busy' });
  assert.deepEqual([busy.summary, busy.attendees, busy.description, busy.location, busy.url, busy.organizer], ['Busy', [], '', '', '', undefined]);
  assert.deepEqual([busy.start, busy.end, busy.allDay], [full.start, full.end, full.allDay], 'when is kept');
  assert.equal(toEvent(raw, { id: 'cal' }, { detail: 'full' }).summary, 'Salary review with HR');
  assert.equal(busyEvent(null), null);
  // the Calendar applies it too, on what it has cached, so changing the setting shows at once
  let detail = 'full';
  const google = { connected: () => true, config: () => ({ calendarDetail: detail }), events: async () => [full] };
  const cal = new Calendar({ settings: { get: () => ({ sources: [] }) }, google, now: () => Date.parse('2026-11-26T09:00:00Z') });
  const from = Date.parse('2026-11-26T00:00:00Z'), to = Date.parse('2026-11-27T00:00:00Z');
  assert.equal((await cal.events({ from, to })).events[0].summary, 'Salary review with HR');
  detail = 'busy';
  const e = (await cal.events({ from, to })).events[0];
  assert.deepEqual([e.summary, e.attendees, e.url], ['Busy', [], '']);
});

test('settings: calendarDetail is full or busy; the Slack user token is a sealed secret', () => {
  const { Settings } = require('../src/core/settings');
  const db = open(':memory:');
  const s = new Settings(db);
  assert.equal(s.get('google').calendarDetail, 'full');
  s.update({ google: { calendarDetail: 'busy' } });
  assert.equal(s.get('google').calendarDetail, 'busy');
  assert.throws(() => s.update({ google: { calendarDetail: 'secret' } }), /full or busy/);
  s.update({ slack: { userToken: 'xoxp-secret' } });
  assert.equal(s.get('slack').userToken, 'xoxp-secret');
  assert.notEqual(s.publicView().slack.userToken, 'xoxp-secret', 'the public view masks it');
  assert.equal(s.publicView().slack.userToken, '********');
});
