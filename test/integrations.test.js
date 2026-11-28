'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { meetingToMarkdown, meetingToText, fmtClock, slugFileName, yamlEscape } = require('../src/integrations/format');
const { NotionClient, markdownToBlocks, blocksToMarkdown, richTextToMarkdown } = require('../src/integrations/notion');
const { LinearClient, actionItemsToIssues, matchUser } = require('../src/integrations/linear');
const { ObsidianVault, parseFrontmatter } = require('../src/integrations/obsidian');
const { postWebhook, verifySignature } = require('../src/integrations/webhook');

const START = new Date(2026, 10, 24, 14, 30).getTime(); // local time, so dates are TZ-independent

const meeting = (over = {}) => ({
  id: 'm-123', title: 'Q4 planning: roadmap/budget?', createdAt: START, startedAt: START, endedAt: START + 45 * 60000, durationMs: 45 * 60000,
  attendees: [{ name: 'Alice Smith', email: 'alice@example.com' }, { name: '', email: 'bob@example.com' }],
  tags: ['planning', '#q4'], topics: ['Roadmap', 'Budget'], people: ['Alice Smith', 'Bob'], source: 'recorded',
  summary: 'We agreed on the **Q4 roadmap**.', body: 'My own notes.',
  actionItems: [{ text: 'Draft budget', owner: 'Alice', due: '2026-12-01', done: false }, { text: 'Book room', owner: '', due: '', done: true }],
  transcript: [{ label: 'Alice', startMs: 5000, text: 'Hello all.' }, { label: 'Bob', startMs: 3725000, text: 'Bye.' }],
  glossary: [{ term: 'OKR', definition: 'Objectives and key results' }], links: [{ kind: 'doc', url: 'https://example.com/doc', title: 'Spec' }],
  ...over,
});

// Fake HTTP server on 127.0.0.1:0 that records requests; handler(req) → { status, body, headers, raw }.
async function fakeServer(t, handler) {
  const reqs = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = { method: req.method, url: req.url, headers: req.headers, body, json: body ? JSON.parse(body) : null };
    reqs.push(r);
    const out = (await handler(r)) || {};
    if (out.hang) return;
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json', ...(out.headers || {}) });
    res.end(out.raw ?? JSON.stringify(out.body ?? {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return { base: `http://127.0.0.1:${srv.address().port}`, reqs };
}

const tmpVault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vault-'));

// ---------- format ----------

test('fmtClock formats m:ss and h:mm:ss', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(65000), '1:05');
  assert.equal(fmtClock(3725000), '1:02:05');
  assert.equal(fmtClock(undefined), '0:00');
});

test('meetingToMarkdown renders sections in order', () => {
  const md = meetingToMarkdown(meeting());
  const order = ['# Q4 planning', '_2026-11-24 14:30 · 45 min · Alice Smith, bob@example.com_', '## Summary', '## Notes', '## Action items', '## Topics', '## Glossary', '## Transcript'];
  let at = -1;
  for (const s of order) { const i = md.indexOf(s); assert.ok(i > at, `${s} in order`); at = i; }
  assert.match(md, /^- \[ \] Draft budget — Alice \(due 2026-12-01\)$/m);
  assert.match(md, /^- \[x\] Book room$/m);
  assert.match(md, /^\*\*Alice\*\* \[0:05\] Hello all\.$/m);
  assert.match(md, /^\*\*Bob\*\* \[1:02:05\] Bye\.$/m);
  assert.match(md, /^- \*\*OKR\*\* — Objectives and key results$/m);
  assert.ok(!md.includes('---'), 'no frontmatter by default');
  assert.ok(!meetingToMarkdown(meeting(), { transcript: false }).includes('## Transcript'));
});

test('meetingToMarkdown frontmatter and wikilinks', () => {
  const md = meetingToMarkdown(meeting(), { frontmatter: true, wikilinks: true });
  assert.ok(md.startsWith('---\n'));
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.title, 'Q4 planning: roadmap/budget?');
  assert.equal(data.date, new Date(START).toISOString());
  assert.deepEqual(data.attendees, ['Alice Smith', 'bob@example.com']);
  assert.deepEqual(data.tags, ['planning', 'q4']);
  assert.deepEqual(data.topics, ['Roadmap', 'Budget']);
  assert.equal(data.source, 'recorded');
  assert.equal(data.whisperbrain_id, 'm-123');
  assert.equal(data.duration_minutes, 45);
  assert.match(body, /^- \[\[Roadmap\]\]$/m);
  assert.match(body, /\*\*People:\*\* \[\[Alice Smith\]\], \[\[Bob\]\]/);
});

test('meetingToMarkdown / meetingToText tolerate a bare meeting', () => {
  const bare = { id: 'x', title: '', createdAt: START };
  const md = meetingToMarkdown(bare, { frontmatter: true, wikilinks: true });
  assert.match(md, /# Untitled/);
  assert.match(md, /attendees: \[\]/);
  assert.ok(!md.includes('## '));
  assert.match(meetingToText(bare), /^Untitled\n/);
});

test('meetingToText is plain text', () => {
  const txt = meetingToText(meeting());
  assert.match(txt, /^SUMMARY\nWe agreed on the Q4 roadmap\.$/m);
  assert.match(txt, /^\[ \] Draft budget — Alice \(due 2026-12-01\)$/m);
  assert.match(txt, /^\[0:05\] Alice: Hello all\.$/m);
  assert.match(txt, /Spec: https:\/\/example\.com\/doc/);
  assert.ok(!txt.includes('**'));
});

test('yamlEscape quotes when needed', () => {
  assert.equal(yamlEscape('plain title'), 'plain title');
  assert.equal(yamlEscape('a: b'), '"a: b"');
  assert.equal(yamlEscape('true'), '"true"');
  assert.equal(yamlEscape('123'), '"123"');
  assert.equal(yamlEscape('say "hi"\n'), '"say \\"hi\\"\\n"');
});

test('slugFileName strips illegal characters and caps length', () => {
  assert.equal(slugFileName('Q4 planning: roadmap/budget?', START), '2026-11-24 Q4 planning roadmap budget.md');
  assert.equal(slugFileName('  <>|*  ', START), '2026-11-24 Untitled.md');
  assert.equal(slugFileName('', null), 'Untitled.md');
  assert.equal(slugFileName('CON', START), '2026-11-24 CON_.md');
  assert.equal(slugFileName('ends with dots...', START), '2026-11-24 ends with dots.md');
  const long = slugFileName('x'.repeat(500), START);
  assert.ok(long.length <= 120, `length ${long.length}`);
  assert.ok(long.endsWith('x.md'));
});

// ---------- markdown ⇄ notion blocks ----------

test('markdownToBlocks converts block types and inline formatting', () => {
  const md = ['# Title', '## Sub', '#### Deep', '', 'Some **bold**, _it_, *it2*, `code`, ~~gone~~ and [link](https://x.io).', '', '- one', '  - nested', '* two', '1. first', '2. second', '- [ ] todo', '- [x] done', '> quoted', '> more', '', '```js', 'const a = 1;', '```', '', '---', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const b = markdownToBlocks(md);
  assert.deepEqual(b.map((x) => x.type), ['heading_1', 'heading_2', 'heading_3', 'paragraph', 'bulleted_list_item', 'bulleted_list_item', 'numbered_list_item', 'numbered_list_item', 'to_do', 'to_do', 'quote', 'code', 'divider', 'table']);
  const rt = b[3].paragraph.rich_text;
  assert.deepEqual(rt.find((r) => r.text.content === 'bold').annotations, { bold: true });
  assert.deepEqual(rt.find((r) => r.text.content === 'it').annotations, { italic: true });
  assert.deepEqual(rt.find((r) => r.text.content === 'it2').annotations, { italic: true });
  assert.deepEqual(rt.find((r) => r.text.content === 'code').annotations, { code: true });
  assert.deepEqual(rt.find((r) => r.text.content === 'gone').annotations, { strikethrough: true });
  assert.equal(rt.find((r) => r.text.content === 'link').text.link.url, 'https://x.io');
  assert.equal(b[4].bulleted_list_item.children[0].bulleted_list_item.rich_text[0].text.content, 'nested');
  assert.equal(b[8].to_do.checked, false);
  assert.equal(b[9].to_do.checked, true);
  assert.equal(b[10].quote.rich_text[0].text.content, 'quoted\nmore');
  assert.equal(b[11].code.language, 'javascript');
  assert.equal(b[11].code.rich_text[0].text.content, 'const a = 1;');
  assert.equal(b[13].table.table_width, 2);
  assert.equal(b[13].table.children.length, 2);
  assert.equal(markdownToBlocks('```weirdlang\nx\n```')[0].code.language, 'plain text');
  assert.equal(markdownToBlocks('snake_case_word stays')[0].paragraph.rich_text.length, 1);
});

test('markdownToBlocks chunks long text to 2000 chars and 100 items per block', () => {
  const long = 'a'.repeat(4500);
  const [p] = markdownToBlocks(long);
  assert.deepEqual(p.paragraph.rich_text.map((r) => r.text.content.length), [2000, 2000, 500]);
  const code = markdownToBlocks('```\n' + 'b'.repeat(2500) + '\n```')[0];
  assert.deepEqual(code.code.rich_text.map((r) => r.text.content.length), [2000, 500]);
  const many = markdownToBlocks('**x** y '.repeat(120).trim());
  assert.ok(many.length >= 3 && many.every((x) => x.type === 'paragraph' && x.paragraph.rich_text.length <= 100));
  assert.equal(many.flatMap((x) => x.paragraph.rich_text).filter((r) => r.annotations?.bold).length, 120);
});

test('markdown → blocks → markdown round-trips', () => {
  const md = ['# Title', '', 'Para with **bold**, _italic_, `code`, ~~strike~~ and [a link](https://example.com/x).', '', '- one', '- two', '  - child', '', '1. first', '2. second', '', '- [ ] open', '- [x] closed', '', '> a quote', '', '```python', 'print("hi")', '```', '', '---', '', '| h1 | h2 |', '| --- | --- |', '| c1 | c2 |'].join('\n');
  assert.equal(blocksToMarkdown(markdownToBlocks(md)), md);
});

test('richTextToMarkdown applies annotations and links', () => {
  const rich = [
    { type: 'text', plain_text: 'Hi ', annotations: {} },
    { type: 'text', plain_text: 'bold ', annotations: { bold: true } },
    { type: 'text', plain_text: 'both', annotations: { bold: true, italic: true } },
    { type: 'text', plain_text: ' x', annotations: { code: true } },
    { type: 'text', plain_text: 'site', href: 'https://s.io', annotations: {} },
    { type: 'equation', plain_text: 'e', equation: { expression: 'e=mc^2' } },
  ];
  assert.equal(richTextToMarkdown(rich), 'Hi **bold** _**both**_ `x`[site](https://s.io)$e=mc^2$');
  assert.equal(richTextToMarkdown(undefined), '');
});

// ---------- Notion client against a fake server ----------

function notionFake(t) {
  const pageBlocks = (start) => (start === 'c2'
    ? { results: [{ id: 'b3', type: 'to_do', has_children: false, to_do: { checked: true, rich_text: [{ plain_text: 'shipped' }] } }, { id: 'b4', type: 'code', code: { language: 'bash', rich_text: [{ plain_text: 'ls -la' }] } }, { id: 'b5', type: 'image', image: { type: 'external', external: { url: 'https://i.io/a.png' }, caption: [] } }, { id: 'b6', type: 'table', has_children: true, table: { table_width: 2 } }, { id: 'b7', type: 'child_page', has_children: true, child_page: { title: 'Sub' } }], has_more: false, next_cursor: null }
    : { results: [{ id: 'b1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Agenda' }] } }, { id: 'b2', type: 'bulleted_list_item', has_children: true, bulleted_list_item: { rich_text: [{ plain_text: 'Parent', annotations: { bold: true } }] } }], has_more: true, next_cursor: 'c2' });
  return fakeServer(t, (r) => {
    const u = new URL(r.url, 'http://x');
    if (r.method === 'GET' && u.pathname === '/users/me') return { body: { object: 'user', name: 'WB bot', bot: { workspace_name: 'Acme' } } };
    if (r.method === 'POST' && u.pathname === '/search') return { body: { results: [{ object: 'page', id: 'p1', url: 'https://notion.so/p1', last_edited_time: '2026-11-01T00:00:00Z', properties: { Name: { type: 'title', title: [{ plain_text: 'Weekly' }] } } }, { object: 'database', id: 'db1', url: 'https://notion.so/db1', title: [{ plain_text: 'Meetings DB' }] }] } };
    if (r.method === 'GET' && u.pathname === '/databases/db1') return { body: { id: 'db1', properties: { Status: { type: 'select' }, 'Meeting name': { type: 'title' } } } };
    if (r.method === 'POST' && u.pathname === '/pages') return { body: { id: 'new-page', url: 'https://notion.so/new-page' } };
    if (r.method === 'PATCH' && /^\/blocks\/[^/]+\/children$/.test(u.pathname)) return { body: { results: [] } };
    if (r.method === 'GET' && u.pathname === '/pages/p1') return { body: { id: 'p1', url: 'https://notion.so/p1', created_time: '2026-11-01T00:00:00Z', last_edited_time: '2026-11-02T00:00:00Z', properties: { Tags: { type: 'multi_select' }, Name: { type: 'title', title: [{ plain_text: 'Weekly' }] } } } };
    if (r.method === 'GET' && u.pathname === '/blocks/p1/children') return { body: pageBlocks(u.searchParams.get('start_cursor')) };
    if (r.method === 'GET' && u.pathname === '/blocks/b2/children') return { body: { results: [{ id: 'b2a', type: 'bulleted_list_item', has_children: false, bulleted_list_item: { rich_text: [{ plain_text: 'child' }] } }], has_more: false } };
    if (r.method === 'GET' && u.pathname === '/blocks/b6/children') return { body: { results: [{ type: 'table_row', table_row: { cells: [[{ plain_text: 'h1' }], [{ plain_text: 'h2' }]] } }, { type: 'table_row', table_row: { cells: [[{ plain_text: 'a' }], [{ plain_text: 'b|c' }]] } }], has_more: false } };
    return { status: 404, body: { object: 'error', status: 404, code: 'object_not_found', message: `Could not find ${u.pathname}` } };
  });
}

test('notion: headers, me() and search()', async (t) => {
  const srv = await notionFake(t);
  const n = new NotionClient({ token: 'secret_abc', baseUrl: srv.base });
  assert.deepEqual(await n.me(), { ok: true, name: 'WB bot', workspace: 'Acme' });
  const h = srv.reqs[0].headers;
  assert.equal(h.authorization, 'Bearer secret_abc');
  assert.equal(h['notion-version'], '2022-06-28');
  assert.equal(h['content-type'], 'application/json');
  const res = await n.search('week', { kind: 'page' });
  assert.deepEqual(srv.reqs[1].json, { query: 'week', page_size: 25, filter: { property: 'object', value: 'page' } });
  assert.deepEqual(res[0], { id: 'p1', kind: 'page', title: 'Weekly', url: 'https://notion.so/p1', lastEdited: '2026-11-01T00:00:00Z' });
  assert.equal(res[1].kind, 'database');
  assert.equal(res[1].title, 'Meetings DB');
  await n.search('x');
  assert.equal(srv.reqs[2].json.filter, undefined);
});

test('notion: errors carry message, status and code', async (t) => {
  const srv = await notionFake(t);
  const n = new NotionClient({ token: 't', baseUrl: srv.base });
  await assert.rejects(n.pageToMarkdown('missing'), (e) => e.status === 404 && e.code === 'object_not_found' && /Could not find/.test(e.message));
  await assert.rejects(new NotionClient({ baseUrl: srv.base }).me(), (e) => e.code === 'not-configured');
});

test('notion: createPage in a database discovers the title property', async (t) => {
  const srv = await notionFake(t);
  const n = new NotionClient({ token: 't', baseUrl: srv.base });
  const out = await n.createPage({ parentId: 'db1', parentKind: 'database', title: 'Standup', markdown: '# Hi\n\nBody', icon: '📝' });
  assert.deepEqual(out, { id: 'new-page', url: 'https://notion.so/new-page' });
  const post = srv.reqs.find((r) => r.method === 'POST' && r.url === '/pages').json;
  assert.deepEqual(post.parent, { database_id: 'db1' });
  assert.equal(post.properties['Meeting name'].title[0].text.content, 'Standup');
  assert.deepEqual(post.icon, { type: 'emoji', emoji: '📝' });
  assert.equal(post.children.length, 2);
  assert.ok(!srv.reqs.some((r) => r.method === 'PATCH'), 'no append needed');
});

test('notion: createPage batches more than 100 blocks', async (t) => {
  const srv = await notionFake(t);
  const n = new NotionClient({ token: 't', baseUrl: srv.base });
  const md = Array.from({ length: 250 }, (_, i) => `Paragraph ${i}`).join('\n\n');
  await n.createPage({ parentId: 'p1', title: 'Big', markdown: md });
  const post = srv.reqs.find((r) => r.url === '/pages').json;
  assert.deepEqual(post.parent, { page_id: 'p1' });
  assert.equal(post.properties.title.title[0].text.content, 'Big');
  assert.equal(post.children.length, 100);
  const patches = srv.reqs.filter((r) => r.method === 'PATCH');
  assert.deepEqual(patches.map((p) => [p.url, p.json.children.length]), [['/blocks/new-page/children', 100], ['/blocks/new-page/children', 50]]);
  assert.equal(patches[1].json.children[49].paragraph.rich_text[0].text.content, 'Paragraph 249');
  srv.reqs.length = 0;
  assert.deepEqual(await n.appendMarkdown('p1', md), { appended: 250 });
  assert.deepEqual(srv.reqs.map((r) => r.json.children.length), [100, 100, 50]);
});

test('notion: pageToMarkdown paginates and recurses', async (t) => {
  const srv = await notionFake(t);
  const n = new NotionClient({ token: 't', baseUrl: srv.base });
  const page = await n.pageToMarkdown('p1');
  assert.equal(page.title, 'Weekly');
  assert.equal(page.url, 'https://notion.so/p1');
  assert.equal(page.createdTime, '2026-11-01T00:00:00Z');
  assert.equal(page.lastEditedTime, '2026-11-02T00:00:00Z');
  assert.equal(page.markdown, ['## Agenda', '', '- **Parent**', '  - child', '', '- [x] shipped', '', '```bash', 'ls -la', '```', '', '![](https://i.io/a.png)', '', '| h1 | h2 |', '| --- | --- |', '| a | b\\|c |', '', 'Subpage: Sub'].join('\n'));
  const urls = srv.reqs.map((r) => r.url);
  assert.ok(urls.includes('/blocks/p1/children?page_size=100&start_cursor=c2'));
  assert.ok(urls.includes('/blocks/b2/children?page_size=100'));
  assert.ok(!urls.some((u) => u.startsWith('/blocks/b7')), 'does not descend into child pages');
});

test('notion: retries once on 429', async (t) => {
  let n429 = 0;
  const srv = await fakeServer(t, () => (n429++ === 0 ? { status: 429, headers: { 'Retry-After': '0' }, body: { code: 'rate_limited', message: 'slow down' } } : { body: { name: 'bot', bot: {} } }));
  const out = await new NotionClient({ token: 't', baseUrl: srv.base }).me();
  assert.equal(out.name, 'bot');
  assert.equal(srv.reqs.length, 2);
});

// ---------- Linear against a fake GraphQL server ----------

function linearFake(t) {
  return fakeServer(t, (r) => {
    if (r.headers.authorization !== 'lin_api_good') return { status: 401, body: { errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] } };
    const q = r.json.query;
    const v = r.json.variables;
    if (q.includes('viewer')) return { body: { data: { viewer: { id: 'u1', name: 'Alice Smith', email: 'alice@example.com' } } } };
    if (q.includes('teams')) return { body: { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } } } };
    if (q.includes('users')) return { body: { data: { users: { nodes: [{ id: 'u1', name: 'Alice Smith', email: 'alice@example.com', active: true }, { id: 'u9', name: 'Gone', email: 'g@x', active: false }] } } } };
    if (q.includes('projects')) return { body: { data: null, errors: [{ message: 'Projects are disabled', extensions: { code: 'FORBIDDEN' } }] } };
    if (q.includes('searchIssues')) return { body: { data: { searchIssues: { nodes: [{ id: 'i1', identifier: 'ENG-1', title: `Match ${v.term}`, url: 'https://linear.app/i1', state: { name: 'Todo' }, assignee: null }] } } } };
    if (q.includes('issueCreate')) return { body: { data: { issueCreate: { success: true, issue: { id: 'i2', identifier: 'ENG-2', title: v.input.title, url: 'https://linear.app/i2' } } } } };
    if (q.includes('commentCreate')) return { body: { data: { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/c1' } } } } };
    if (q.includes('issue(')) {
      if (v.id === 'ENG-404') return { body: { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INVALID_INPUT' } }] } };
      return { body: { data: { issue: { id: 'i7', identifier: v.id, title: 'Fix it', description: 'Desc', url: 'https://linear.app/i7', state: { name: 'In Progress' }, assignee: { name: 'Alice Smith' }, comments: { nodes: [{ body: 'On it', createdAt: '2026-11-20T00:00:00Z', user: { name: 'Alice Smith' } }] } } } } };
    }
    return { body: { errors: [{ message: 'unknown query' }] } };
  });
}

test('linear: sends the raw API key and maps queries', async (t) => {
  const srv = await linearFake(t);
  const l = new LinearClient({ apiKey: 'lin_api_good', url: srv.base });
  assert.deepEqual(await l.viewer(), { id: 'u1', name: 'Alice Smith', email: 'alice@example.com' });
  assert.equal(srv.reqs[0].headers.authorization, 'lin_api_good');
  assert.equal(srv.reqs[0].headers['content-type'], 'application/json');
  assert.deepEqual(await l.teams(), [{ id: 't1', key: 'ENG', name: 'Engineering' }]);
  const users = await l.users();
  assert.deepEqual(users.map((u) => u.id), ['u1'], 'inactive users are dropped');
  const found = await l.searchIssues('login bug', { first: 5 });
  assert.deepEqual(found, [{ id: 'i1', identifier: 'ENG-1', title: 'Match login bug', url: 'https://linear.app/i1', state: 'Todo', assignee: null }]);
  assert.deepEqual(srv.reqs.at(-1).json.variables, { term: 'login bug', first: 5 });
  const byId = await l.searchIssues('eng-7');
  assert.equal(byId[0].identifier, 'ENG-7');
  assert.match(srv.reqs.at(-1).json.query, /issue\(id: \$id\)/);
  assert.deepEqual(await l.searchIssues('ENG-404'), []);
  const issue = await l.issue('ENG-7');
  assert.deepEqual(issue, { id: 'i7', identifier: 'ENG-7', title: 'Fix it', url: 'https://linear.app/i7', state: 'In Progress', assignee: 'Alice Smith', description: 'Desc', comments: [{ body: 'On it', user: 'Alice Smith', createdAt: '2026-11-20T00:00:00Z' }] });
});

test('linear: createIssue omits empty fields; createComment', async (t) => {
  const srv = await linearFake(t);
  const l = new LinearClient({ apiKey: 'lin_api_good', url: srv.base });
  const out = await l.createIssue({ teamId: 't1', title: 'Do it', description: 'D', assigneeId: undefined, dueDate: '' });
  assert.deepEqual(out, { id: 'i2', identifier: 'ENG-2', title: 'Do it', url: 'https://linear.app/i2' });
  assert.deepEqual(srv.reqs.at(-1).json.variables.input, { teamId: 't1', title: 'Do it', description: 'D' });
  assert.deepEqual(await l.createComment({ issueId: 'i2', body: 'hi' }), { id: 'c1', url: 'https://linear.app/c1' });
  assert.deepEqual(srv.reqs.at(-1).json.variables.input, { issueId: 'i2', body: 'hi' });
});

test('linear: errors[] and HTTP 401 throw', async (t) => {
  const srv = await linearFake(t);
  await assert.rejects(new LinearClient({ apiKey: 'lin_api_good', url: srv.base }).projects(), (e) => e.message === 'Projects are disabled' && e.code === 'FORBIDDEN');
  await assert.rejects(new LinearClient({ apiKey: 'nope', url: srv.base }).viewer(), (e) => e.status === 401 && /API key/.test(e.message));
  await assert.rejects(new LinearClient({ url: srv.base }).viewer(), (e) => e.code === 'not-configured');
});

test('linear: actionItemsToIssues maps owners, due dates and back-references', () => {
  const users = [{ id: 'u1', name: 'Alice Smith', email: 'alice@example.com' }, { id: 'u2', name: 'Bob Jones', email: 'bob@example.com' }, { id: 'u3', name: 'Bob Marley', email: 'marley@example.com' }, { id: 'u4', name: 'Carol King', email: 'ck@example.com' }];
  const m = meeting({
    summary: 'word '.repeat(300),
    actionItems: [
      { text: 'Draft budget', owner: 'alice', due: '2026-12-01', done: false },
      { text: 'Ping vendor', owner: 'BOB@EXAMPLE.COM', due: 'soon', done: false },
      { text: 'Ambiguous', owner: 'Bob', due: '', done: false },
      { text: 'Full name', owner: 'Carol King', done: false },
      { text: 'Finished', owner: 'alice', done: true },
      { text: 'x'.repeat(400), owner: 'Nobody' },
      { text: '   ' },
    ],
  });
  const issues = actionItemsToIssues(m, { teamId: 't1', users });
  assert.equal(issues.length, 5);
  assert.deepEqual(issues.map((i) => i.assigneeId), ['u1', 'u2', undefined, 'u4', undefined]);
  assert.equal(issues[0].dueDate, '2026-12-01');
  assert.equal(issues[1].dueDate, undefined);
  assert.equal(issues[0].teamId, 't1');
  assert.ok(issues[0].description.startsWith('From meeting “Q4 planning: roadmap/budget?” on 2026-11-24'));
  assert.ok(issues[0].description.length < 800);
  assert.match(issues[2].description, /Owner: Bob/);
  assert.equal(issues[4].title.length, 255);
  assert.equal(matchUser('', users), null);
  assert.equal(matchUser('Alice S.', users).id, 'u1');
});

// ---------- Obsidian ----------

test('obsidian: parseFrontmatter handles scalars and lists', () => {
  const { data, body } = parseFrontmatter('---\ntitle: "Hi: there"\nn: 3\nok: true\nnone:\nquoted: \'it\'\'s\'\ninline: [a, "b, c", 3]\nblock:\n  - x\n  - "y z"\nurl: https://a.io/x # comment\n---\n# Body\n');
  assert.deepEqual(data, { title: 'Hi: there', n: 3, ok: true, none: null, quoted: "it's", inline: ['a', 'b, c', 3], block: ['x', 'y z'], url: 'https://a.io/x' });
  assert.equal(body, '# Body\n');
  assert.deepEqual(parseFrontmatter('no frontmatter'), { data: {}, body: 'no frontmatter' });
});

test('obsidian: check() validates the vault path', (t) => {
  const dir = tmpVault();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => new ObsidianVault({}).check(), /No Obsidian vault/);
  assert.throws(() => new ObsidianVault({ vaultPath: path.join(dir, 'nope') }).check(), /does not exist/);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  assert.throws(() => new ObsidianVault({ vaultPath: path.join(dir, 'file.txt') }).check(), /not a folder/);
  const v = new ObsidianVault({ vaultPath: dir });
  assert.deepEqual(v.check(), { ok: true, isVault: false, path: fs.realpathSync(dir), notes: 0 });
  fs.mkdirSync(path.join(dir, '.obsidian'));
  assert.equal(v.check().isVault, true);
});

test('obsidian: writeNote creates, updates in place and avoids collisions', (t) => {
  const dir = tmpVault();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const v = new ObsidianVault({ vaultPath: dir, folder: 'Work/Meetings' });
  const a = v.writeNote(meeting());
  assert.equal(a.relPath, 'Work/Meetings/2026-11-24 Q4 planning roadmap budget.md');
  assert.equal(a.uri, `obsidian://open?vault=${encodeURIComponent(path.basename(dir))}&file=${encodeURIComponent('Work/Meetings/2026-11-24 Q4 planning roadmap budget')}`);
  const text = fs.readFileSync(a.path, 'utf8');
  assert.match(text, /^whisperbrain_id: m-123$/m);
  assert.match(text, /\[\[Roadmap\]\]/);
  assert.match(text, /## Transcript/);
  // re-export with a new title overwrites the same file
  const b = v.writeNote(meeting({ title: 'Renamed', summary: 'Updated summary' }));
  assert.equal(b.path, a.path);
  assert.match(fs.readFileSync(a.path, 'utf8'), /Updated summary/);
  assert.equal(v.check().notes, 1);
  // a different meeting whose name collides gets a suffix
  fs.writeFileSync(path.join(dir, 'Work/Meetings/2026-11-24 Other.md'), '# someone else\n');
  const c = v.writeNote(meeting({ id: 'm-2', title: 'Other' }));
  assert.equal(c.relPath, 'Work/Meetings/2026-11-24 Other (2).md');
  const d = v.writeNote(meeting({ id: 'm-3', title: 'Other' }));
  assert.equal(d.relPath, 'Work/Meetings/2026-11-24 Other (3).md');
  const noTranscript = new ObsidianVault({ vaultPath: dir, folder: 'Work/Meetings', transcript: false }).writeNote(meeting({ id: 'm-3', title: 'Other' }));
  assert.equal(noTranscript.relPath, d.relPath);
  assert.ok(!fs.readFileSync(noTranscript.path, 'utf8').includes('## Transcript'));
});

test('obsidian: listNotes and readNote', (t) => {
  const dir = tmpVault();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = (rel, text, mtime) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); fs.utimesSync(p, mtime, mtime); };
  w('Meetings/old.md', '# Old heading\n', 1000);
  w('Meetings/sub/new.md', '---\ntitle: Fresh one\n---\nbody\n', 3000);
  w('Meetings/plain.md', 'no heading', 2000);
  w('Meetings/skip.txt', 'x', 4000);
  w('.obsidian/workspace.md', 'x', 5000);
  w('.trash/deleted.md', 'x', 5000);
  w('Root.md', '# Root', 6000);
  const v = new ObsidianVault({ vaultPath: dir });
  assert.deepEqual(v.listNotes().map((n) => [n.relPath, n.title]), [['Meetings/sub/new.md', 'Fresh one'], ['Meetings/plain.md', 'plain'], ['Meetings/old.md', 'Old heading']]);
  assert.deepEqual(v.listNotes({ folder: '' }).map((n) => n.relPath), ['Root.md', 'Meetings/sub/new.md', 'Meetings/plain.md', 'Meetings/old.md']);
  assert.deepEqual(v.listNotes({ query: 'FRESH' }).map((n) => n.relPath), ['Meetings/sub/new.md']);
  assert.deepEqual(v.listNotes({ query: 'old' }).map((n) => n.relPath), ['Meetings/old.md']);
  assert.equal(v.listNotes({ limit: 1 }).length, 1);
  const n = v.listNotes()[0];
  assert.equal(n.mtime, 3000 * 1000);
  assert.equal(n.size, fs.statSync(path.join(dir, 'Meetings/sub/new.md')).size);
  assert.deepEqual(new ObsidianVault({ vaultPath: dir, folder: 'Missing' }).listNotes(), []);
  const r = v.readNote('Meetings/sub/new.md');
  assert.deepEqual({ ...r, mtime: 0 }, { relPath: 'Meetings/sub/new.md', title: 'Fresh one', frontmatter: { title: 'Fresh one' }, body: 'body\n', mtime: 0 });
  assert.equal(v.readNote('Meetings/old.md').title, 'Old heading');
  // round-trip an exported meeting
  const out = v.writeNote(meeting());
  const back = v.readNote(out.relPath);
  assert.equal(back.title, 'Q4 planning: roadmap/budget?');
  assert.equal(back.frontmatter.whisperbrain_id, 'm-123');
  assert.match(back.body, /^# Q4 planning/);
  assert.throws(() => v.readNote('Meetings/nope.md'), /not found/);
});

test('obsidian: refuses paths outside the vault', (t) => {
  const dir = tmpVault();
  const outside = tmpVault();
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
  fs.symlinkSync(outside, path.join(dir, 'link'), 'dir');
  const v = new ObsidianVault({ vaultPath: dir });
  assert.throws(() => v.readNote('../secret.md'), /inside the vault/);
  assert.throws(() => v.readNote(path.join(outside, 'secret.md')), /inside the vault/);
  assert.throws(() => v.readNote('Meetings/../../x.md'), /inside the vault/);
  assert.throws(() => v.readNote('link/secret.md'), /inside the vault/);
  assert.throws(() => v.readNote('notes.txt'), /Markdown/);
  assert.throws(() => v.listNotes({ folder: '..' }), /inside the vault/);
  assert.throws(() => v.listNotes({ folder: 'link' }), /inside the vault/);
  assert.throws(() => new ObsidianVault({ vaultPath: dir, folder: '../escape' }).writeNote(meeting()), /inside the vault/);
  assert.throws(() => new ObsidianVault({ vaultPath: dir, folder: 'link/sub' }).writeNote(meeting()), /inside the vault/);
  assert.ok(!fs.existsSync(path.join(outside, 'sub')), 'nothing was written outside');
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape')));
});

// ---------- webhook ----------

test('webhook: signs the exact body and sends the event header', async (t) => {
  const srv = await fakeServer(t, () => ({ status: 204, raw: '' }));
  const payload = { event: 'meeting.completed', meeting: { id: 'm-1', title: 'Ünïcode ✓' } };
  assert.deepEqual(await postWebhook({ url: `${srv.base}/hook`, secret: 's3cret', payload }), { ok: true, status: 204 });
  const r = srv.reqs[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/hook');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['x-whisperbrain-event'], 'meeting.completed');
  assert.deepEqual(r.json, payload);
  const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(r.body).digest('hex');
  assert.equal(r.headers['x-whisperbrain-signature'], expected);
  assert.ok(verifySignature(r.body, 's3cret', r.headers['x-whisperbrain-signature']));
  assert.ok(!verifySignature(r.body, 'wrong', r.headers['x-whisperbrain-signature']));
  await postWebhook({ url: srv.base, payload: { hello: 1 } });
  assert.equal(srv.reqs[1].headers['x-whisperbrain-signature'], undefined);
  assert.equal(srv.reqs[1].headers['x-whisperbrain-event'], undefined);
});

test('webhook: rejects bad URLs, non-2xx and timeouts', async (t) => {
  const srv = await fakeServer(t, (r) => (r.url === '/slow' ? { hang: true } : { status: 500, raw: 'boom' }));
  await assert.rejects(postWebhook({ url: 'ftp://x.io/a', payload: {} }), /http:\/\/ or https:\/\//);
  await assert.rejects(postWebhook({ url: 'not a url', payload: {} }), /not valid/);
  await assert.rejects(postWebhook({ url: srv.base, payload: { event: 'x' } }), (e) => e.status === 500 && /HTTP 500: boom/.test(e.message));
  await assert.rejects(postWebhook({ url: `${srv.base}/slow`, payload: {}, timeoutMs: 150 }), (e) => e.code === 'timeout');
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response('', { status: 200 }); };
  assert.deepEqual(await postWebhook({ url: 'https://hooks.example.com/x', payload: { event: 'e' }, fetchImpl }), { ok: true, status: 200 });
  assert.equal(seen.url, 'https://hooks.example.com/x');
  assert.equal(seen.init.headers['X-WhisperBrain-Event'], 'e');
  // a redirect is never followed (a 307 would re-POST the signed payload to wherever it points): it is a failure that says so
  assert.equal(seen.init.redirect, 'manual');
  const redirecting = async () => new Response('', { status: 307, headers: { Location: 'https://elsewhere.example.net/steal' } });
  await assert.rejects(postWebhook({ url: 'https://hooks.example.com/x', payload: {}, secret: 's', fetchImpl: redirecting }), (e) => e.code === 'redirect' && e.status === 307 && /redirect/i.test(e.message) && /elsewhere\.example\.net/.test(e.message));
});
