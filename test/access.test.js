'use strict';
// Access grants (src/access/grants.js, docs/access.md): one rule decides what each source may give to an AI server, MCP, a live search
// or an action, and every path asks it. The matrix test below sends secrets through every content-carrying AI path with a server that
// counts as REMOTE and proves none of them leaves; then the same with a local server, to prove the test would have seen them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server/app');
const { open, MIGRATIONS } = require('../src/core/db');
const { can, grantColumns } = require('../src/access/grants');
const { Actions } = require('../src/brain/actions');
const { narrate } = require('../src/brain/brief');
const { BrainReader } = require('../src/mcp/server');
const { startFakeLlm } = require('./fake-llm');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const boot = async (t) => {
  const dataDir = tmpDir('wb-access-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  await app.runner.stop();
  return { app, dataDir };
};
// the same fake server, reached through an address the app does NOT count as on this computer (IPv4-mapped IPv6 loopback)
const remote = (url) => url.replace('127.0.0.1', '[::ffff:127.0.0.1]');
const sent = (llm) => JSON.stringify(llm.requests);
const reindex = (app) => { for (let i = 0; i < 50; i++) if (!app.chunkIndex.syncBatch(200).done) break; };

test('can(): each read level and op', () => {
  const src = (g) => ({ readLevel: 'all', aiReach: 'local', actions: [], ...g });
  const local = { baseUrl: 'http://localhost:11434/v1' }, far = { baseUrl: 'https://api.example.com/v1' };
  assert.equal(can(src({ readLevel: 'none' }), 'read.meta'), false);
  assert.equal(can(src({ readLevel: 'metadata' }), 'read.meta'), true);
  assert.equal(can(src({ readLevel: 'metadata' }), 'read.body'), false, 'metadata: who/when/subject, no body');
  assert.equal(can(src({ readLevel: 'part' }), 'read.body'), true);
  assert.equal(can(src({ readLevel: 'part', liveSearch: true }), 'search.live'), true);
  assert.equal(can(src({ readLevel: 'metadata', liveSearch: true }), 'search.live'), false, 'no live search without reading bodies');
  assert.equal(can(src({}), 'ai.remote', { llmConfig: far }), false, 'local: never to a remote server');
  assert.equal(can(src({}), 'ai.remote', { llmConfig: local }), true, 'a server on this computer may');
  assert.equal(can(src({ aiReach: 'ask' }), 'ai.remote', { llmConfig: far }), false, 'ask: not without a yes');
  assert.equal(can(src({ aiReach: 'ask' }), 'ai.remote', { llmConfig: far, confirmed: true }), true);
  assert.equal(can(src({ aiReach: 'any' }), 'ai.remote', { llmConfig: far }), true);
  assert.equal(can(src({ aiReach: 'any' }), 'ai.remote', { llmConfig: far, item: { aiReach: 'local' } }), false, 'an item kept local stays local');
  assert.equal(can(src({ aiReach: 'local' }), 'ai.remote', { llmConfig: far, item: { aiReach: 'any' } }), false, 'an item cannot open up its source');
  assert.equal(can(src({ aiReach: 'any', mcp: true }), 'mcp'), true);
  assert.equal(can(src({ aiReach: 'local', mcp: true }), 'mcp'), false, 'MCP may be a remote model: local stays out');
  assert.equal(can(src({ actions: ['gmail.draft'] }), 'action.gmail.draft'), true);
  assert.equal(can(src({ actions: ['gmail.draft'] }), 'action.gmail.send'), false);
  assert.equal(can(src({ readLevel: 'none', actions: ['webhook.post'] }), 'action.webhook.post'), true, 'action-only: nothing read, one thing sent');
  assert.equal(can(src({ aiReach: 'any', expiresAt: Date.now() - 1 }), 'read.meta'), false, 'an expired grant allows nothing');
  assert.equal(can(src({ aiReach: 'any', expiresAt: Date.now() - 1, actions: ['x.y'] }), 'action.x.y'), false);
  assert.equal(can(null, 'read.meta'), false);
  assert.throws(() => can(src({}), 'read.everything'), /unknown access op/);
  assert.deepEqual(grantColumns({ aiReach: 'any' }), { ai_reach: 'any', sensitivity: 'normal' }, 'sensitivity kept in step');
  assert.throws(() => grantColumns({ readLevel: 'most' }), /readLevel/);
  assert.throws(() => grantColumns({ actions: ['send everything'] }), /action kinds/);
});

test('migration v26: every source keeps what it did, and waiting actions survive the rebuild', () => {
  const dir = tmpDir('wb-mig26-');
  const file = path.join(dir, 'a.db');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, 25)) old.exec(m);
  old.exec('PRAGMA user_version = 25');
  old.exec(`INSERT INTO sources (id, kind, name, mode, sensitivity, config, created_at, updated_at) VALUES
    ('s1', 'gmail', 'Mail', 'copy', 'private', '{"remote":true,"query":"newer_than:30d"}', 1, 1),
    ('s2', 'folder', 'Docs', 'pointer', 'normal', '{"path":"/x"}', 1, 1)`);
  old.exec("INSERT INTO actions (id, kind, title, args, created_at) VALUES ('ac_1', 'linear.issue', 'Make an issue', '{}', 5)");
  old.close();
  const db = open(file);
  const rows = Object.fromEntries(db.prepare('SELECT id, read_level, ai_reach, mcp, sensitivity FROM sources').all().map((r) => [r.id, [r.read_level, r.ai_reach, r.mcp, r.sensitivity]]));
  assert.deepEqual(rows.s1, ['part', 'local', 0, 'private'], 'a service reads its part, mail stays local, MCP never had it');
  assert.deepEqual(rows.s2, ['all', 'any', 1, 'normal'], 'a folder: all of it, as before, and MCP still serves it');
  assert.deepEqual(db.prepare('SELECT id, state FROM actions').all().map((r) => [r.id, r.state]), [['ac_1', 'pending']]);
  db.exec("UPDATE actions SET state = 'running' WHERE id = 'ac_1'");   // the new state is allowed
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// A mail source kept local, a Notion import kept local, and an ordinary meeting: the secrets are in the first two.
function seed(app) {
  const mail = app.items.addSource({ kind: 'gmail', name: 'Mail', mode: 'copy', sensitivity: 'private', config: { remote: true } });
  app.items.upsert(mail.id, { externalId: 'thread:1', kind: 'email', title: 'Budget figures', text: 'The budget is SECRETMAIL7731 for next year.', occurredAt: Date.now() });
  const priv = app.notes.create({ title: 'Budget board', status: 'done', source: 'notion', sourceRef: 'n1', body: 'Board budget: SECRETNOTE4410.' });
  app.notes.update?.(priv.id, { summary: 'The budget board decided SECRETNOTE4410.' });
  app.items.syncNote(priv.id);
  app.items.setGrant(app.items.sourceOfNote(priv.id).id, { aiReach: 'local' });
  const pub = app.notes.create({ title: 'Budget review', status: 'done', body: 'We talked about the budget in general.' });
  app.items.syncNote(pub.id);
  reindex(app);
  return { mail, priv, pub };
}

test('leak matrix: with a REMOTE AI server, nothing from a local-only source reaches it on any path', async (t) => {
  const { app } = await boot(t);
  const { mail, priv } = seed(app);
  const llm = await startFakeLlm(() => 'A short answer.');
  t.after(() => llm.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: remote(llm.url), model: 'fake-model' }, rerank: true });
  assert.equal(app.mayShare('note', priv.id), false);
  assert.equal(app.mayShare('item', app.items.byExternal(mail.id, 'thread:1').id), false);

  await app.ai.chat(null, 'What is the budget?');                                        // Ask across everything (+ rerank)
  await assert.rejects(app.ai.chat(priv.id, 'What is the budget?'), (e) => e.code === 'local-only');
  await assert.rejects(app.ai.summarize(priv.id), (e) => e.code === 'local-only');
  await assert.rejects(app.ai.autoTitle(priv.id), (e) => e.code === 'local-only');
  const ins = await app.ai.insights(priv.id);
  assert.equal(ins.mode, 'local', 'a local-only meeting gets the offline extraction');
  await assert.rejects(app.translator.translateNote(priv.id, 'pt'), (e) => e.code === 'local-only');
  assert.equal(await app.translator.translateSummary(priv.id, 'pt'), null);
  const brief = { people: [], owe: [], waiting: [], decisions: [], related: [{ kind: 'item', id: app.items.byExternal(mail.id, 'thread:1').id, title: 'Budget figures', text: 'The budget is SECRETMAIL7731' }, { kind: 'meeting', id: priv.id, title: 'Budget board', text: 'SECRETNOTE4410' }] };
  assert.equal(await narrate(app.scheduler.client('chat'), brief, { mayShare: app.mayShare }), null, 'no fact may go, so no narrative');
  const retrieved = await app.chunkIndex.search('budget', { limit: 10, allow: app.mayShare });
  assert.ok(retrieved.length >= 1 && !JSON.stringify(retrieved).includes('SECRET'), '/api/retrieve hands over only what may go');

  assert.ok(llm.requests.length >= 1, 'the remote server was used for what may go');
  assert.ok(!sent(llm).includes('SECRETMAIL7731'), 'no mail');
  assert.ok(!sent(llm).includes('SECRETNOTE4410'), 'no local-only meeting');

  // the same question with a server on this computer: now the mail may be used, which proves the test above could see it
  llm.requests.length = 0;
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url }, rerank: false });
  await app.ai.chat(null, 'What is the budget?');
  assert.ok(sent(llm).includes('SECRETMAIL7731'), 'a local server may read local-only mail');
  const run = app.aiRuns.list(5).find((r) => r.sources.length);
  assert.ok(run && run.sources.includes(mail.id), 'the AI ledger says which source the call carried');
});

test('an item kept local stays out even when its source may go', async (t) => {
  const { app } = await boot(t);
  const { mail } = seed(app);
  app.items.setGrant(mail.id, { aiReach: 'any' });
  const it = app.items.byExternal(mail.id, 'thread:1');
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: 'https://api.example.com/v1' } });
  assert.equal(app.mayShare('item', it.id), true);
  app.items.setItemReach(it.id, 'local');
  assert.equal(app.mayShare('item', it.id), false);
  app.items.setItemReach(it.id, null);
  assert.equal(app.mayShare('item', it.id), true);
});

test('narrowing a grant forgets at once: metadata drops the bodies, none drops everything (search index included)', async (t) => {
  const { app } = await boot(t);
  const { mail } = seed(app);
  const words = (q) => app.chunkIndex.search(q, { limit: 10 }).then((h) => h.filter((x) => x.sourceId === mail.id).length);
  assert.equal(await words('SECRETMAIL7731'), 1);
  const r = app.items.setGrant(mail.id, { readLevel: 'metadata' });
  assert.equal(r.purged, 1);
  const it = app.items.byExternal(mail.id, 'thread:1');
  assert.equal(it.text, '', 'the body is gone');
  assert.equal(it.title, 'Budget figures', 'who/when/subject stay');
  assert.equal(app.items.list({ q: 'SECRETMAIL7731' }).length, 0, 'not in the word index');
  assert.equal(await words('SECRETMAIL7731'), 0, 'not in the chunk index');
  app.items.setGrant(mail.id, { readLevel: 'none' });
  assert.equal(app.items.list({ sourceId: mail.id }).length, 0);
  assert.equal(await words('Budget'), 0);
  assert.ok(app.items.source(mail.id), 'the source stays, so it can be opened up again');
});

test('approving is claimed once: a double click runs an action one time; a narrowed grant stops a waiting one; old proposals expire', async (t) => {
  const { app } = await boot(t);
  let runs = 0, allowedNow = true, now = 1000;
  let release;
  const gate = new Promise((r) => { release = r; });
  const actions = new Actions({ db: app.db, now: () => now, allowed: () => allowedNow, handlers: { 'test.send': { label: 'Test', build: (i) => ({ title: 'Send it', args: i }), run: async () => { runs++; await gate; return { ok: true }; } } } });
  const a = actions.propose('test.send', { to: 'ana@x.pt' });
  const first = actions.approve(a.id);
  await assert.rejects(actions.approve(a.id), (e) => e.status === 409, 'the second click is refused');
  release();
  assert.equal((await first).state, 'done');
  assert.equal(runs, 1);
  const b = actions.propose('test.send', {});
  allowedNow = false;
  await assert.rejects(actions.approve(b.id), (e) => e.status === 403);
  assert.equal(actions.get(b.id).state, 'rejected');
  assert.throws(() => actions.propose('test.send', {}), (e) => e.status === 403, 'nor can a new one be made');
  allowedNow = true;
  const c = actions.propose('test.send', {});
  now += 8 * 86_400_000;
  assert.equal(actions.pending().length, 0);
  assert.equal(actions.get(c.id).state, 'expired');
  await assert.rejects(actions.approve(c.id), (e) => e.status === 409);
  assert.equal(runs, 1);
});

test('MCP: serves only sources switched on for it, follows imported meetings, and refuses while the app is locked', async (t) => {
  const { app, dataDir } = await boot(t);
  const { mail, priv, pub } = seed(app);
  const file = path.join(dataDir, 'whisperbrain.sqlite');
  const reader = () => BrainReader.open(file);
  let r = reader();
  t.after(() => r.db.close());
  const hits = await r.call('search', { query: 'budget', limit: 10 });
  assert.ok(!JSON.stringify(hits).includes('SECRET'));
  assert.ok(hits.some((h) => h.id === pub.id), 'an ordinary meeting is served');
  assert.throws(() => r.getNote({ id: priv.id }), /not shared/);
  assert.throws(() => r.getNote({ id: app.items.byExternal(mail.id, 'thread:1').id }), /private|not shared/);
  app.items.setGrant(mail.id, { aiReach: 'any' });
  assert.ok(JSON.stringify(await r.call('search', { query: 'SECRETMAIL7731' })) === '[]', 'may go to AI, but MCP is off for it');
  app.items.setGrant(mail.id, { mcp: true });
  assert.ok(JSON.stringify(await r.call('search', { query: 'SECRETMAIL7731' })).includes('SECRETMAIL7731'), 'switched on');
  app.lock.enable({ passphrase: 'correct horse battery' });
  app.lock.lock();
  r.db.close(); r = reader();
  await assert.rejects(r.call('search', { query: 'budget' }), /locked/);
  app.lock.unlock('correct horse battery');
  assert.ok(Array.isArray(await r.call('search', { query: 'budget' })));
});

test('delete everything also forgets sources, mail, the search index and the records, and the pre-update copies', async (t) => {
  const { app, dataDir } = await boot(t);
  const { mail } = seed(app);
  app.aiRuns.record({ lane: 'chat', config: { baseUrl: '' }, messages: [], sources: [mail.id] });
  app.accessLog.add({ sourceId: mail.id, op: 'grant.changed' });
  const copy = path.join(dataDir, 'whisperbrain.sqlite.before-v99');
  fs.writeFileSync(copy, 'old mail');
  app.account.deleteEverything();
  const count = (tbl) => app.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;
  assert.deepEqual(['items', 'sources', 'chunks', 'ai_runs', 'access_log', 'notes'].map(count), [0, 0, 0, 0, 0, 0]);
  assert.equal(app.items.list({ q: 'SECRETMAIL7731' }).length, 0);
  assert.ok(!fs.existsSync(copy), 'the copy made before an update held the mail too');
});
