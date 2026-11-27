'use strict';
// The outbound actions for connected services (src/brain/actions-services.js): what each one builds (and tells the generic guards about
// where it goes and what leaves), what it needs to be ready, and what it sends when approved, against SIMULATED servers that follow
// each service's documented API. Nothing runs by itself: they are proposed, and only an approval runs them.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/core/db');
const { Actions, HANDLERS: CORE } = require('../src/brain/actions');
const { HANDLERS, urlsIn } = require('../src/brain/actions-services');
const { NotionClient } = require('../src/integrations/notion');
const { LinearClient } = require('../src/integrations/linear');

async function fakeWorld() {
  const w = { routes: [], calls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      w.calls.push({ method: req.method, path: url.pathname, headers: req.headers, body });
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
  w.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return w;
}
const settingsOf = (cfg) => ({ get: (k) => cfg[k] || {} });
const depsFor = (w, cfg = {}) => ({
  settings: settingsOf({ slack: { token: 'xoxb-1' }, github: { token: 'ghp_1' }, discord: { token: 'bot-1' }, notion: { token: 'n', parentId: 'parent-1', parentKind: 'page', parentTitle: 'Inbox' }, linear: { apiKey: 'lin_1' }, ...cfg }),
  fetchImpl: globalThis.fetch, sleep: async () => {},
  bases: { slack: `${w.url}/api`, github: w.url, discord: `${w.url}/api/v10` },
  integrations: { notion: () => new NotionClient({ token: 'n', baseUrl: `${w.url}/v1` }), linear: () => new LinearClient({ apiKey: 'lin_1', url: `${w.url}/graphql` }) },
});
const NO_DEPS = { settings: settingsOf({}) };

test('every handler has the shape of src/brain/actions.js and a kind name the grants accept', () => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), ['discord.send', 'github.comment', 'github.issue', 'linear.comment', 'notion.page', 'slack.post']);
  for (const [kind, h] of Object.entries(HANDLERS)) {
    assert.match(kind, /^[a-z]+\.[a-zA-Z]+$/, 'what grantColumns accepts as an action kind');
    assert.equal(typeof h.label, 'string');
    for (const f of ['ready', 'build', 'run']) assert.equal(typeof h[f], 'function', `${kind}.${f}`);
    assert.ok(!(kind in CORE), 'no clash with the actions already there');
  }
});

test('ready(): the token (or the setting) must exist', () => {
  const only = (cfg) => settingsOf(cfg);
  assert.equal(HANDLERS['slack.post'].ready(NO_DEPS), false);
  assert.equal(HANDLERS['slack.post'].ready({ settings: only({ slack: { token: 'x' } }) }), true);
  assert.equal(HANDLERS['slack.post'].ready({ settings: only({ slack: { userToken: 'only-a-user-token' } }) }), false, 'posting uses the app token');
  for (const k of ['github.comment', 'github.issue']) { assert.equal(HANDLERS[k].ready(NO_DEPS), false); assert.equal(HANDLERS[k].ready({ settings: only({ github: { token: 'x' } }) }), true); }
  assert.equal(HANDLERS['discord.send'].ready({ settings: only({ discord: { token: 'x' } }) }), true);
  assert.equal(HANDLERS['discord.send'].ready(NO_DEPS), false);
  assert.equal(HANDLERS['notion.page'].ready({ settings: only({ notion: { token: 'x' } }) }), false, 'a token without a parent is not ready');
  assert.equal(HANDLERS['notion.page'].ready({ settings: only({ notion: { token: 'x', parentId: 'p' } }) }), true);
  assert.equal(HANDLERS['linear.comment'].ready({ settings: only({ linear: { apiKey: 'k' } }) }), true);
  assert.equal(HANDLERS['linear.comment'].ready(NO_DEPS), false);
});

test('urlsIn finds the links in a text and nothing else', () => {
  assert.deepEqual(urlsIn('See https://a.io/x?y=1, and [doc](https://b.io/d). Also http://c.io!'), ['https://a.io/x?y=1', 'https://b.io/d', 'http://c.io']);
  assert.deepEqual(urlsIn('no links here, just example.com'), []);
  assert.deepEqual(urlsIn('https://a.io https://a.io'), ['https://a.io']);
});

test('build: every handler says where it goes and what leaves (outbound), in plain words', () => {
  const d = depsFor({ url: 'x' });
  const slack = HANDLERS['slack.post'].build({ channel: '#general', text: 'Shipped! Details: https://ex.io/r?token=abc' }, d);
  assert.match(slack.title, /Post in Slack #general: “Shipped!/);
  assert.deepEqual(slack.args, { channel: 'general', text: 'Shipped! Details: https://ex.io/r?token=abc' });
  assert.deepEqual(slack.outbound, { recipients: ['slack:#general'], urls: ['https://ex.io/r?token=abc'], text: 'Shipped! Details: https://ex.io/r?token=abc' });
  const thread = HANDLERS['slack.post'].build({ channel: 'C0123ABCDEF', text: 'reply', threadTs: '1700000000.000100' }, d);
  assert.deepEqual(thread.outbound.recipients, ['slack:C0123ABCDEF', 'slack:C0123ABCDEF/1700000000.000100']);
  assert.equal(thread.args.threadTs, '1700000000.000100');
  assert.match(thread.title, /in a thread/);

  const c = HANDLERS['github.comment'].build({ repo: 'o/r', number: '12', text: 'Fixed in https://github.com/o/r/pull/13' }, d);
  assert.deepEqual(c.args, { repo: 'o/r', number: 12, text: 'Fixed in https://github.com/o/r/pull/13' });
  assert.deepEqual(c.outbound, { recipients: ['github:o/r#12'], urls: ['https://github.com/o/r/pull/13'], text: 'Fixed in https://github.com/o/r/pull/13' });
  const i = HANDLERS['github.issue'].build({ repo: 'o/r', title: '  Login   fails ', text: 'Steps\n1. open https://x.io', labels: 'bug, ui,bug' }, d);
  assert.deepEqual(i.args, { repo: 'o/r', title: 'Login fails', text: 'Steps\n1. open https://x.io', labels: ['bug', 'ui'] });
  assert.deepEqual(i.outbound.recipients, ['github:o/r']);
  assert.equal(i.outbound.text, 'Login fails\n\nSteps\n1. open https://x.io', 'title and body: all of it leaves');
  assert.deepEqual(i.outbound.urls, ['https://x.io']);

  const dc = HANDLERS['discord.send'].build({ channelId: '123456789012345678', channelName: '#general', text: 'hello @everyone' }, d);
  assert.match(dc.title, /Send in Discord #general/);
  assert.deepEqual(dc.outbound, { recipients: ['discord:123456789012345678'], urls: [], text: 'hello @everyone' });

  const n = HANDLERS['notion.page'].build({ title: 'Meeting notes', text: '# Notes\nsee https://n.io' }, d);
  assert.deepEqual(n.args, { parentId: 'parent-1', parentKind: 'page', parentTitle: 'Inbox', title: 'Meeting notes', text: '# Notes\nsee https://n.io' });
  assert.deepEqual(n.outbound.recipients, ['notion:parent-1']);
  assert.match(n.title, /Notion page “Meeting notes” in Inbox/);
  const n2 = HANDLERS['notion.page'].build({ title: 'T', parentId: 'attacker-page' }, d);
  assert.equal(n2.args.parentId, 'parent-1', 'the parent comes from the settings, never from the request');

  const l = HANDLERS['linear.comment'].build({ identifier: 'eng-12', text: 'On it' }, d);
  assert.deepEqual(l.args, { identifier: 'ENG-12', text: 'On it' });
  assert.deepEqual(l.outbound, { recipients: ['linear:ENG-12'], urls: [], text: 'On it' });
});

test('build: bad input is refused with a plain message, and a long text is refused, never cut', () => {
  const d = depsFor({ url: 'x' });
  assert.throws(() => HANDLERS['slack.post'].build({ channel: '', text: 'x' }, d), /Slack channel/);
  assert.throws(() => HANDLERS['slack.post'].build({ channel: 'general', text: '   ' }, d), /empty/);
  assert.throws(() => HANDLERS['slack.post'].build({ channel: 'general', text: 'x', threadTs: 'yesterday' }, d), /thread/);
  assert.throws(() => HANDLERS['slack.post'].build({ channel: 'general', text: 'x'.repeat(4001) }, d), /too long/);
  assert.throws(() => HANDLERS['github.comment'].build({ repo: 'not a repo', number: 1, text: 'x' }, d), /owner\/name/);
  assert.throws(() => HANDLERS['github.comment'].build({ repo: 'o/r', number: 0, text: 'x' }, d), /number/);
  assert.throws(() => HANDLERS['github.issue'].build({ repo: 'o/r', title: '' }, d), /title/);
  assert.throws(() => HANDLERS['discord.send'].build({ channelId: 'general', text: 'x' }, d), /channel id/);
  assert.throws(() => HANDLERS['discord.send'].build({ channelId: '123456789012345678', text: 'x'.repeat(2001) }, d), /too long/);
  assert.throws(() => HANDLERS['notion.page'].build({ title: 'T' }, { settings: settingsOf({ notion: { token: 'x' } }) }), /Notion page or database/);
  assert.throws(() => HANDLERS['linear.comment'].build({ identifier: 'nope', text: 'x' }, d), /ENG-12/);
  assert.equal(HANDLERS['slack.post'].build({ channel: 'g', text: 'a\u0000b' }, d).args.text, 'ab', 'a control character is removed, not an error');
});

test('run: Slack posts with the app token, to a thread when given, without unfurling links, and says what Slack refused', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/api\/chat.postMessage$/, (u, req, m, body) => (body.channel === 'nowhere' ? [200, { ok: false, error: 'channel_not_found' }] : body.channel === 'locked' ? [200, { ok: false, error: 'missing_scope', needed: 'chat:write' }] : [200, { ok: true, channel: 'C1', ts: '1700000000.000200' }]));
  const d = depsFor(w);
  const { args } = HANDLERS['slack.post'].build({ channel: 'general', text: 'hello', threadTs: '1700000000.000100' }, d);
  const r = await HANDLERS['slack.post'].run(args, d);
  assert.deepEqual(r, { url: 'https://slack.com/app_redirect?channel=C1&message_ts=1700000000.000200', ts: '1700000000.000200' });
  const call = w.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer xoxb-1');
  assert.match(call.headers['content-type'], /application\/json/);
  assert.deepEqual(call.body, { channel: 'general', text: 'hello', thread_ts: '1700000000.000100', unfurl_links: false, unfurl_media: false });
  await assert.rejects(HANDLERS['slack.post'].run({ channel: 'nowhere', text: 'x' }, d), /channel_not_found/);
  await assert.rejects(HANDLERS['slack.post'].run({ channel: 'locked', text: 'x' }, d), /needs chat:write/);
});

test('run: GitHub comment and issue go to the right place with the token, and give back the link', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/repos\/o\/r\/issues\/12\/comments$/, () => [201, { html_url: 'https://github.com/o/r/issues/12#issuecomment-1' }]);
  w.on(/^\/repos\/o\/r\/issues$/, () => [201, { html_url: 'https://github.com/o/r/issues/77', number: 77 }]);
  w.on(/^\/repos\/o\/locked\/issues\/1\/comments$/, () => [403, { message: 'Resource not accessible by personal access token' }]);
  const d = depsFor(w);
  assert.deepEqual(await HANDLERS['github.comment'].run({ repo: 'o/r', number: 12, text: 'Fixed' }, d), { url: 'https://github.com/o/r/issues/12#issuecomment-1' });
  assert.equal(w.calls[0].headers.authorization, 'Bearer ghp_1');
  assert.deepEqual(w.calls[0].body, { body: 'Fixed' });
  assert.deepEqual(await HANDLERS['github.issue'].run({ repo: 'o/r', title: 'Login fails', text: 'Steps', labels: ['bug'] }, d), { url: 'https://github.com/o/r/issues/77', number: 77 });
  assert.deepEqual(w.calls[1].body, { title: 'Login fails', body: 'Steps', labels: ['bug'] });
  assert.deepEqual((await (async () => { await HANDLERS['github.issue'].run({ repo: 'o/r', title: 'T', text: '', labels: [] }, d); return w.calls[2].body; })()), { title: 'T' }, 'no empty body or labels are sent');
  await assert.rejects(HANDLERS['github.comment'].run({ repo: 'o/locked', number: 1, text: 'x' }, d), (e) => e.code === 'unauthorized' && /not accessible/.test(e.message));
});

test('run: Discord posts as the bot with mentions off and embeds suppressed', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/api\/v10\/channels\/123456789012345678\/messages$/, () => [200, { id: '999', guild_id: '555' }]);
  const d = depsFor(w);
  const r = await HANDLERS['discord.send'].run({ channelId: '123456789012345678', text: 'hello @everyone <@123>' }, d);
  assert.equal(r.url, 'https://discord.com/channels/555/123456789012345678/999');
  assert.equal(w.calls[0].headers.authorization, 'Bot bot-1');
  assert.deepEqual(w.calls[0].body, { content: 'hello @everyone <@123>', allowed_mentions: { parse: [] }, flags: 4 });
  await assert.rejects(HANDLERS['discord.send'].run({ channelId: '999999999999999999', text: 'x' }, d), /no such route/);
});

test('run: Notion creates the page under the configured parent; Linear looks the issue up, then comments', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/v1\/pages$/, () => [200, { id: 'newpage', url: 'https://notion.so/newpage' }]);
  w.on(/^\/v1\/blocks\/newpage\/children$/, () => [200, {}]);
  w.on(/^\/graphql$/, (u, req, m, body) => {
    if (/commentCreate/.test(body.query)) return [200, { data: { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/ENG-12#comment-c1' } } } }];
    return [200, { data: { issue: { id: 'uuid-12', identifier: 'ENG-12', title: 'T', url: 'https://linear.app/x/ENG-12', state: { name: 'Todo' }, assignee: null, description: '', comments: { nodes: [] } } } }];
  });
  const d = depsFor(w);
  const b = HANDLERS['notion.page'].build({ title: 'Notes', text: '# Hello\n\nbody' }, d);
  assert.deepEqual(await HANDLERS['notion.page'].run(b.args, d), { url: 'https://notion.so/newpage', id: 'newpage' });
  const created = w.calls.find((c) => c.path === '/v1/pages');
  assert.deepEqual(created.body.parent, { page_id: 'parent-1' });
  assert.equal(created.body.properties.title.title[0].text.content, 'Notes');
  const lb = HANDLERS['linear.comment'].build({ identifier: 'ENG-12', text: 'On it' }, d);
  assert.deepEqual(await HANDLERS['linear.comment'].run(lb.args, d), { url: 'https://linear.app/x/ENG-12#comment-c1' });
  const sent = w.calls.filter((c) => c.path === '/graphql').map((c) => c.body);
  assert.equal(sent[0].variables.id, 'ENG-12', 'the issue is found by its identifier first');
  assert.deepEqual(sent[1].variables.input, { issueId: 'uuid-12', body: 'On it' }, 'the comment goes to that issue\'s own id');
});

test('through Actions: they only propose; nothing is sent until approved, and an approval runs once', async (t) => {
  const w = await fakeWorld(); t.after(() => w.close());
  w.on(/^\/api\/chat.postMessage$/, () => [200, { ok: true, channel: 'C1', ts: '1.2' }]);
  const db = open(':memory:');
  const actions = new Actions({ db, handlers: { ...CORE, ...HANDLERS }, deps: depsFor(w) });
  assert.ok(actions.kinds().find((k) => k.kind === 'slack.post').ready);
  const a = actions.propose('slack.post', { channel: 'general', text: 'hello' });
  assert.equal(a.state, 'pending');
  assert.equal(w.calls.length, 0, 'a proposal changes nothing anywhere');
  const done = await actions.approve(a.id);
  assert.equal(done.state, 'done');
  assert.match(done.result.url, /app_redirect/);
  assert.equal(w.calls.length, 1);
  await assert.rejects(actions.approve(a.id), (e) => e.status === 409);
  assert.equal(w.calls.length, 1);
  // a service that is not connected cannot be proposed
  const bare = new Actions({ db, handlers: HANDLERS, deps: { ...depsFor(w), settings: settingsOf({}) } });
  assert.throws(() => bare.propose('github.comment', { repo: 'o/r', number: 1, text: 'x' }), (e) => e.status === 412);
});
