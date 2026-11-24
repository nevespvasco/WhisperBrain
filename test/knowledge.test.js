'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = require('../src/core/db');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const kp = require('../src/knowledge/keyphrases');
const ins = require('../src/llm/insights');
const { readZip } = require('../src/importers/zip');
const { startFakeLlm } = require('./fake-llm');
const { tmpDir, ROOT } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async meetingWindows() { return []; },
  async paste() { return { ok: false }; }, clipboard: null,
});

function boot(t, opts = {}) {
  const dataDir = tmpDir('wb-k-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test', ...opts });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return app;
}

async function serve(t, app) {
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${port}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { Cookie: `wb_token=${token}`, ...(body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body) });
  const json = async (method, p, body) => { const r = await call(method, p, body); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j; };
  return { call, json };
}

const meeting = (app, title, lines, extra = {}) => {
  let at = 0;
  const segments = lines.map(([label, text]) => { const s = { speaker: label === 'Me' ? 'me' : 'them', label, startMs: at, endMs: at + 6000, text }; at += 6500; return s; });
  return app.importer.createFromParsed({ title, segments, attendees: extra.attendees || [], tags: extra.tags || [], date: extra.date }, { source: extra.source || 'recorded' });
};

test('migration v2 → v3 keeps notes, marks note-only ones manual and indexes old transcript lines', () => {
  const dir = tmpDir('wb-mig-');
  const file = path.join(dir, 'x.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(db.MIGRATIONS[0]); raw.exec(db.MIGRATIONS[1]); raw.exec('PRAGMA user_version = 2');
  raw.prepare("INSERT INTO notes(id, title, created_at, updated_at) VALUES ('a', 'Recorded', 1, 1), ('b', 'Typed', 2, 2)").run();
  raw.prepare("INSERT INTO segments(note_id, speaker, start_ms, end_ms, text) VALUES ('a', 'them', 0, 1000, 'the quarterly budget is tight')").run();
  raw.close();
  const conn = db.open(file);
  assert.equal(conn.prepare('PRAGMA user_version').get().user_version, db.MIGRATIONS.length);
  const src = Object.fromEntries(conn.prepare('SELECT id, source FROM notes').all().map((r) => [r.id, r.source]));
  assert.deepEqual(src, { a: 'recorded', b: 'manual' });
  assert.equal(conn.prepare("SELECT COUNT(*) c FROM seg_fts WHERE seg_fts MATCH 'budget'").get().c, 1);
  // triggers keep the index in sync
  conn.prepare("DELETE FROM segments WHERE note_id = 'a'").run();
  assert.equal(conn.prepare("SELECT COUNT(*) c FROM seg_fts WHERE seg_fts MATCH 'budget'").get().c, 0);
  conn.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('keyphrases: multi-word subjects beat filler words, and plural/singular share a key', () => {
  const text = 'We discussed the pricing model again. The pricing model needs a discount tier. Um, yeah, the discount tier and the pricing model. Okay so the API rate limits too, API rate limits matter.';
  const out = kp.extract(text, kp.docFreq([text, 'unrelated meeting about hiring']));
  assert.equal(out[0].name.toLowerCase(), 'pricing model');
  assert.ok(out.some((x) => /discount tier/i.test(x.name)));
  assert.ok(!out.some((x) => /^(yeah|um|okay)$/i.test(x.name)));
  assert.equal(kp.phraseKey('Pricing Models'), kp.phraseKey('pricing model'));
});

test('insights parser tolerates fences, chatter and trailing commas; checklist parsing finds owners', () => {
  const r = ins.parseInsights('Sure!\n```json\n{"overview":"ok","topics":[{"name":"Pricing","summary":"s"},],"actionItems":[{"text":"Do it","owner":"Ana","due":"2026-12-01"},"Plain"],"glossary":[{"term":"ARR","definition":"Annual"}],}\n```');
  assert.equal(r.overview, 'ok');
  assert.equal(r.topics[0].name, 'Pricing');
  assert.deepEqual(r.actionItems.map((a) => [a.text, a.owner, a.due]), [['Do it', 'Ana', '2026-12-01'], ['Plain', '', '']]);
  assert.equal(r.glossary[0].term, 'ARR');
  assert.equal(ins.parseInsights('no json here'), null);
  const items = ins.parseChecklist('- [ ] Ana: send the deck\n- [x] Fix login — Rui\n- [ ] Book room @Marta\n- not a task');
  assert.deepEqual(items.map((i) => [i.text, i.owner, i.done]), [['send the deck', 'Ana', false], ['Fix login', 'Rui', true], ['Book room @Marta', 'Marta', false]]);
});

test('tags, action items, snippets and links', (t) => {
  const app = boot(t);
  const k = app.knowledge;
  const a = meeting(app, 'Sync', [['Ana', 'Hello there team'], ['Rui', 'The release is on Friday']]);
  assert.deepEqual(k.setNoteTags(a.id, ['Customer', 'customer', '#Q3']).map((x) => x.name).sort(), ['Customer', 'Q3']);
  assert.equal(app.notes.list({ tagId: k.tagByName('q3').id }).length, 1);
  const x1 = k.addAction(a.id, { text: 'Ship it', owner: 'Rui', due: '2026-12-01' });
  k.replaceAutoActions(a.id, [{ text: 'Auto one' }, { text: 'Auto two' }]);
  const two = k.actionItems({ noteId: a.id }).find((x) => x.text === 'Auto two');
  k.updateAction(two.id, { done: true });
  const after = k.replaceAutoActions(a.id, [{ text: 'Auto three' }, { text: 'ship it' }]);
  assert.deepEqual(after.map((x) => x.text).sort(), ['Auto three', 'Auto two', 'Ship it'], 'manual and completed items survive; duplicates are skipped');
  assert.equal(k.actionItems({ done: false }).length, 2);
  assert.equal(x1.due, '2026-12-01');
  const seg = app.notes.segments(a.id)[1];
  const sn = k.addSnippet(a.id, { segmentId: seg.id, label: 'Date' });
  assert.equal(sn.speaker, 'Rui');
  assert.equal(k.addSnippet(a.id, { segmentId: seg.id }).id, sn.id, 'starring twice does not duplicate');
  const l = k.addLink(a.id, { kind: 'linear', ref: 'ENG-1', url: 'https://linear.app/x/issue/ENG-1', title: 'ENG-1' });
  assert.equal(k.addLink(a.id, { kind: 'linear', ref: 'ENG-1', url: 'https://linear.app/x/issue/ENG-1', title: 'renamed' }).id, l.id);
  assert.throws(() => k.addLink(a.id, { kind: 'url', url: 'javascript:alert(1)' }), /unsupported/);
});

test('topics connect meetings: same subject across meetings, graph, related, quotes, merge and rename', (t) => {
  const app = boot(t);
  const k = app.knowledge;
  const a = meeting(app, 'Pricing review', [['Ana', 'The pricing model needs a discount tier.'], ['Rui', 'I prefer a usage based pricing model.']], { attendees: [{ name: 'Ana', email: 'ana@acme.io' }] });
  const b = meeting(app, 'Board prep', [['Ana', 'Investors asked about our pricing models and hiring plan.']], { attendees: [{ name: 'Ana', email: 'ana@acme.io' }] });
  const c = meeting(app, 'Lunch', [['Me', 'The weather is nice today.']]);
  k.setNoteTopics(a.id, [{ name: 'Pricing model', summary: 'discount vs usage', weight: 1 }, { name: 'Discount tier', weight: 0.5 }]);
  k.setNoteTopics(b.id, [{ name: 'Pricing models', weight: 0.8 }, { name: 'Hiring plan', weight: 0.6 }]);
  const topics = k.topics();
  const pricing = topics.find((x) => /pricing/i.test(x.name));
  assert.equal(pricing.notes, 2, '"Pricing models" and "Pricing model" are one topic');
  const g = k.topicGraph();
  assert.ok(g.edges.some((e) => [e.source, e.target].includes(pricing.id)));
  const ov = k.topicOverview();
  assert.equal(ov.meetings, 2, 'only meetings that have topics count');
  const op = ov.topics.find((x) => x.id === pricing.id);
  assert.equal(op.dates.length, 2);
  assert.ok(op.firstAt <= op.lastAt);
  assert.equal(ov.edges.length, 2, 'pricing–discount and pricing–hiring');
  assert.equal(k.topicOverview({ since: Date.now() + 60000 }).topics.length, 0, 'a period with no meetings has no topics');
  const rel = k.related(a.id);
  assert.equal(rel[0].id, b.id);
  assert.ok(rel[0].reasons.some((r) => /pricing/i.test(r)));
  assert.ok(!rel.some((r) => r.id === c.id));
  const tp = k.topic(pricing.id);
  assert.equal(tp.notes.length, 2);
  assert.ok(tp.quotes.length >= 2 && tp.quotes.every((q) => /pricing/i.test(q.text)));
  assert.ok(tp.people.some((p) => p.name === 'Ana'));
  // renaming onto an existing topic merges
  const hiring = topics.find((x) => /hiring/i.test(x.name));
  const discount = topics.find((x) => /discount/i.test(x.name));
  k.updateTopic(discount.id, { name: 'hiring plans' });
  assert.equal(k.topics().find((x) => x.id === hiring.id).notes, 2);
  assert.ok(!k.topics().some((x) => x.id === discount.id));
  // regenerating automatic topics keeps the user's own
  k.addNoteTopic(c.id, 'Team lunch');
  k.setNoteTopics(c.id, [{ name: 'Weather' }]);
  assert.deepEqual(k.noteTopics(c.id).map((x) => x.name).sort(), ['Team lunch', 'Weather']);
  // offline extraction never returns the speakers or the title
  const local = k.localTopics(a.id).map((x) => x.key);
  assert.ok(!local.includes('ana') && !local.includes('pricing review'));
});

test('glossary: AI never overwrites a definition the user wrote; terms are found in meetings', (t) => {
  const app = boot(t);
  const k = app.knowledge;
  const a = meeting(app, 'Metrics', [['Ana', 'Our ARR grew and the NPS score is up.']]);
  k.upsertTerm({ term: 'ARR', definition: 'Annual recurring revenue', noteId: a.id });
  k.upsertTerm({ term: 'arr', definition: 'Something else', auto: true });
  assert.equal(k.glossary()[0].definition, 'Annual recurring revenue');
  k.upsertTerm({ term: 'NPS', definition: 'Net promoter', auto: true });
  k.upsertTerm({ term: 'NPS', definition: 'Net promoter score', auto: true });
  assert.equal(k.glossary().find((g) => g.term === 'NPS').definition, 'Net promoter score');
  assert.deepEqual(k.termsInNote(a.id).map((g) => g.term).sort(), ['ARR', 'NPS']);
  const term = k.term(k.glossary()[0].id);
  assert.equal(term.quotes.length, 1);
  assert.equal(term.notes[0].id, a.id);
  assert.throws(() => k.updateTerm(k.glossary().find((g) => g.term === 'NPS').id, { term: 'arr' }), /already/);
});

test('people, who said what, speaker analytics and unified search', (t) => {
  const app = boot(t);
  app.settings.update({ userName: 'Alex' });
  const k = app.knowledge;
  const a = meeting(app, 'Roadmap', [['Ana Silva', 'We should launch the mobile app in March, it is our biggest bet?'], ['Rui', 'The mobile app needs offline mode first.'], ['Ana Silva', 'Fine, offline mode then the launch.']], { attendees: [{ name: 'Ana Silva', email: 'ana@acme.io' }, { name: 'Zé', email: 'ze@other.com' }] });
  const people = k.people();
  assert.ok(people.find((p) => p.name === 'Ana Silva' && p.meetings === 1 && p.emails.includes('ana@acme.io')));
  const ana = k.person('ana silva');
  assert.equal(ana.quotes.length, 2);
  const q = k.quotes('mobile app', { speaker: 'rui' });
  assert.equal(q.length, 1);
  assert.equal(q[0].label, 'Rui');
  assert.match(q[0].snippet, /<mark>mobile<\/mark>/);
  const an = k.analytics(a.id);
  const anaStats = an.speakers.find((s) => s.label === 'Ana Silva');
  assert.equal(anaStats.turns, 2);
  assert.equal(anaStats.questions, 1);
  assert.ok(anaStats.wpm > 0 && anaStats.talkPct > anaStats.listenPct === false || anaStats.talkPct + anaStats.listenPct === 100);
  assert.equal(an.speakers.reduce((s, x) => s + x.talkPct, 0) >= 99, true);
  k.upsertTerm({ term: 'Offline mode', definition: 'Works without network' });
  const found = k.find({ q: 'offline' });
  for (const kind of ['meeting', 'quote', 'term']) assert.ok(found.some((r) => r.kind === kind), `find returns ${kind}`);
  assert.ok(k.find({ q: 'ana', kind: 'people' }).every((r) => r.kind === 'person'));
  // external = attendees from other domains, once your domain is known
  assert.equal(k.cards([app.notes.get(a.id)])[0].external, null);
  app.settings.update({ myDomains: 'acme.io' });
  assert.equal(k.cards([app.notes.get(a.id)])[0].external, true);
  app.notes.update(a.id, { external: false });
  assert.equal(k.cards([app.notes.get(a.id)])[0].external, false, 'a manual choice wins');
});

test('AI insights with an LLM fill topics, glossary and action items; without one they fall back offline', async (t) => {
  const llm = await startFakeLlm((messages) => (messages[0].content.includes('JSON')
    ? '```json\n{"overview":"Budget talk","keyPoints":[{"title":"Money","bullets":["Tight"]}],"decisions":["Cut travel"],"actionItems":[{"text":"Send budget","owner":"Ana","due":""}],"nextSteps":[],"topics":[{"name":"Travel budget","summary":"cut","weight":1}],"glossary":[{"term":"OPEX","definition":"Operating expenses"}]}\n```'
    : 'x'));
  t.after(() => llm.close());
  const app = boot(t);
  const a = meeting(app, 'Budget', [['Ana', 'The travel budget is tight, OPEX is too high.'], ['Rui', 'Cut the travel budget then.']]);
  app.settings.update({ llm: { baseUrl: llm.url, model: 'fake-model' } });
  const r = await app.ai.insights(a.id);
  assert.equal(r.mode, 'llm');
  assert.equal(app.notes.get(a.id).insights.overview, 'Budget talk');
  assert.deepEqual(app.knowledge.noteTopics(a.id).map((x) => x.name), ['Travel budget']);
  assert.equal(app.knowledge.glossary()[0].term, 'OPEX');
  assert.equal(app.knowledge.actionItems({ noteId: a.id })[0].owner, 'Ana');
  // a second meeting is told about existing topics and terms, so names converge
  const b = meeting(app, 'Budget 2', [['Ana', 'More on the travel budget.']]);
  await app.ai.insights(b.id);
  assert.match(llm.requests.at(-1).messages[1].content, /EXISTING TOPICS:.*Travel budget/);
  assert.match(llm.requests.at(-1).messages[1].content, /EXISTING TERMS: OPEX/);
  // no LLM configured → offline
  app.settings.update({ llm: { baseUrl: '' } });
  app.notes.update(b.id, { summary: '## Action items\n- [ ] Rui: book flights' });
  const off = await app.ai.insights(b.id);
  assert.equal(off.mode, 'local');
  assert.ok(app.knowledge.actionItems({ noteId: b.id }).some((x) => x.text === 'book flights' && x.owner === 'Rui'));
});

test('HTTP: meetings filters, exports (md/html/srt/vtt/json/zip), imports and settings secrets', async (t) => {
  const app = boot(t);
  const s = await serve(t, app);
  const a = meeting(app, 'Ação de vendas', [['Ana', 'Olá equipa, vamos rever o funil.'], ['Rui', 'O funil está ótimo.']]);
  // import: a Teams-style VTT and an unsupported file
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Marta>We need a decision on vendors.\n\n00:00:05.000 --> 00:00:08.000\n<v Joel>Vendor B is cheaper.\n';
  const imp = await s.json('POST', '/api/import?filename=Vendor%20call.vtt&tags=imported,vendors', vtt);
  assert.equal(imp.notes.length, 1);
  const ov = await s.json('GET', `/api/notes/${imp.notes[0].id}/overview`);
  assert.equal(ov.note.source, 'file');
  assert.deepEqual(ov.tags.map((x) => x.name).sort(), ['imported', 'vendors']);
  assert.deepEqual(ov.analytics.speakers.map((x) => x.label).sort(), ['Joel', 'Marta']);
  const bad = await s.call('POST', '/api/import?filename=x.pdf', Buffer.from('%PDF-1.4 hello'));
  assert.equal(bad.status, 415);
  const pasted = await s.json('POST', '/api/import/text', { title: 'Pasted', text: 'Ana: hi there\nRui: hello Ana\nAna: shall we start' });
  assert.equal(pasted.notes[0].segments, 3);
  // source filters keep outside material apart
  const imported = await s.json('GET', '/api/meetings?source=imported');
  assert.deepEqual(imported.map((n) => n.title).sort(), ['Pasted', 'Vendor call']);
  assert.ok((await s.json('GET', '/api/meetings?source=local')).every((n) => n.id === a.id));
  // exports
  const md = await s.call('GET', `/api/notes/${a.id}/export?format=md`);
  assert.match(md.headers.get('content-disposition'), /filename\*=UTF-8''.*A%C3%A7%C3%A3o/);
  assert.match(await md.text(), /\*\*Ana\*\* \[0:00\] Olá equipa/);
  assert.match(await (await s.call('GET', `/api/notes/${a.id}/export?format=srt`)).text(), /^1\n00:00:00,000 --> 00:00:06,000\nAna: Olá/);
  assert.match(await (await s.call('GET', `/api/notes/${a.id}/export?format=vtt`)).text(), /^WEBVTT\n\n00:00:00\.000 --> .*\n<v Ana>Olá/);
  const html = await (await s.call('GET', `/api/notes/${a.id}/export?format=html`)).text();
  assert.match(html, /<h1>Ação de vendas<\/h1>/);
  assert.ok(!/<script/i.test(html));
  assert.equal(JSON.parse(await (await s.call('GET', `/api/notes/${a.id}/export?format=json`)).text()).meeting.title, 'Ação de vendas');
  assert.equal((await s.call('GET', `/api/notes/${a.id}/export?format=pdf`)).status, 501, 'PDF needs the desktop app');
  const zr = await s.call('POST', '/api/export', { format: 'obsidian' });
  assert.equal(zr.headers.get('content-type'), 'application/zip');
  const z = readZip(Buffer.from(await zr.arrayBuffer()));
  assert.equal(z.entries.length, 3);
  assert.match(z.read(z.entries.find((e) => /vendas/.test(e.name)).name).toString(), /^---\ntitle: /);
  // secrets never reach the UI, and a masked value written back keeps the secret
  await s.json('PUT', '/api/settings', { notion: { token: 'secret_abc' }, linear: { apiKey: 'lin_api_x' }, google: { clientSecret: 'gs' } });
  const pub = await s.json('GET', '/api/settings');
  assert.equal(pub.notion.token, '********');
  assert.equal(pub.linear.apiKey, '********');
  assert.equal(pub.google.clientSecret, '********');
  await s.json('PUT', '/api/settings', { notion: pub.notion });
  assert.equal(app.settings.get('notion').token, 'secret_abc');
  const backup = JSON.parse(await (await s.call('GET', '/api/account/export')).text());
  assert.ok(!JSON.stringify(backup).includes('secret_abc') && !JSON.stringify(backup).includes('lin_api_x'));
  assert.ok(backup.notes.some((n) => n.tags?.includes('vendors')));
});

test('HTTP: send to Obsidian and to a signed webhook; integrations report what is missing', async (t) => {
  const app = boot(t);
  const s = await serve(t, app);
  const a = meeting(app, 'Planning', [['Ana', 'Plan the quarter.']]);
  const missing = await s.call('POST', `/api/notes/${a.id}/send`, { target: 'notion' });
  assert.equal(missing.status, 412);
  const vault = tmpDir('wb-vault-');
  fs.mkdirSync(path.join(vault, '.obsidian'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  await s.json('PUT', '/api/settings', { obsidian: { vaultPath: vault, folder: 'Meetings' } });
  const r1 = await s.json('POST', `/api/notes/${a.id}/send`, { target: 'obsidian' });
  const r2 = await s.json('POST', `/api/notes/${a.id}/send`, { target: 'obsidian' });
  assert.equal(r1.path, r2.path, 're-export updates the same file');
  assert.match(fs.readFileSync(r1.path, 'utf8'), /whisperbrain_id: "?[0-9a-f-]{36}/);
  assert.equal((await s.json('GET', `/api/notes/${a.id}/links`)).length, 1);
  // webhook receives the meeting, signed
  const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push({ body: b, sig: req.headers['x-whisperbrain-signature'] }); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  t.after(() => hook.close());
  await s.json('PUT', '/api/settings', { webhooks: [{ id: 'h1', name: 'Test', url: `http://127.0.0.1:${hook.address().port}/in`, secret: 'k3y' }] });
  await s.json('POST', `/api/notes/${a.id}/send`, { target: 'webhook', webhookId: 'h1' });
  assert.equal(got.length, 1);
  assert.equal(got[0].sig, `sha256=${crypto.createHmac('sha256', 'k3y').update(got[0].body).digest('hex')}`);
  assert.equal(JSON.parse(got[0].body).meeting.title, 'Planning');
  const st = await s.json('GET', '/api/integrations');
  assert.equal(st.obsidian.configured, true);
  assert.equal(st.notion.configured, false);
  assert.equal(st.webhooks[0].secret, '********');
});

test('calendar capture: a starting meeting set to "capture all" creates a note and tries to record', async (t) => {
  const app = boot(t);
  app.settings.update({ captureCalendar: 'all' });
  const seen = [];
  app.bus.subscribe((e) => seen.push(e.type));
  app.bus.publish('meeting.starting', { event: { id: 'e1', uid: 'u1', start: Date.now(), summary: 'Standup', attendees: [{ name: 'Ana', email: 'a@x.io' }], url: 'https://meet.google.com/abc-defg-hij' } });
  await new Promise((r) => setTimeout(r, 50));
  const n = app.notes.list()[0];
  assert.equal(n.title, 'Standup');
  assert.equal(app.knowledge.links(n.id)[0].url, 'https://meet.google.com/abc-defg-hij');
  assert.ok(seen.includes('meeting.autostart-failed'), 'no speech model in tests, so recording reports why it could not start');
  app.settings.update({ captureCalendar: 'off' });
  app.bus.publish('meeting.starting', { event: { id: 'e2', uid: 'u2', start: Date.now(), summary: 'Other' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(app.notes.list().length, 1);
});

test('HTTP: Google sign-in starts a loopback PKCE flow and needs a client ID', async (t) => {
  const app = boot(t);
  const s = await serve(t, app);
  assert.equal((await s.call('POST', '/api/google/connect', {})).status, 400);
  const r = await s.json('POST', '/api/google/connect', { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' });
  const u = new URL(r.authUrl);
  assert.equal(u.searchParams.get('client_id'), 'abc.apps.googleusercontent.com');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(u.searchParams.get('scope'), /calendar\.readonly/);
  assert.equal((await s.json('GET', '/api/settings')).google.clientSecret, '********');
  // a forged callback is refused and the listener keeps waiting
  const bad = await fetch(`${u.searchParams.get('redirect_uri')}?code=x&state=wrong`);
  assert.equal(bad.status, 400);
  const errs = [];
  app.bus.subscribe((e) => { if (e.type === 'google.error') errs.push(e.data.message); });
  await s.json('POST', '/api/google/connect', { clientId: 'abc.apps.googleusercontent.com' }); // restarting cancels the first attempt
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(errs.length, 1);
});
