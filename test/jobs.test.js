'use strict';
// Durable background work (src/jobs): the queue's states, retries and dedupe, the runner, and the work after a recording
// surviving a quit in the middle (docs/adr/0001-brain-data-model.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../src/core/db');
const { JobQueue, BACKOFF_MS } = require('../src/jobs/queue');
const { JobRunner } = require('../src/jobs/runner');
const { tmpDir } = require('./helpers');

const clock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };

test('a job goes queued → running → done, and a key keeps a second copy out while the first is pending', () => {
  const c = clock();
  const q = new JobQueue(open(':memory:'), { now: c.now });
  const a = q.enqueue('note.summarize', { noteId: 'n1' }, { key: 'n1' });
  const b = q.enqueue('note.summarize', { noteId: 'n1' }, { key: 'n1' });
  assert.equal(a.id, b.id, 'same kind and key while queued: the same job');
  assert.notEqual(q.enqueue('note.insights', { noteId: 'n1' }, { key: 'n1' }).id, a.id, 'another kind is another job');
  const got = q.claim(['note.summarize']);
  assert.equal(got.id, a.id);
  assert.equal(got.state, 'running');
  assert.equal(got.attempts, 1);
  assert.equal(q.claim(['note.summarize']), null, 'nothing else of that kind waits');
  q.complete(a.id, { ok: true });
  assert.equal(q.get(a.id).state, 'done');
  assert.deepEqual(q.get(a.id).result, { ok: true });
  assert.notEqual(q.enqueue('note.summarize', { noteId: 'n1' }, { key: 'n1' }).id, a.id, 'once done, the same key may run again');
});

test('a failure retries after a back-off, then fails for good; a failed job can be retried by hand', () => {
  const c = clock();
  const q = new JobQueue(open(':memory:'), { now: c.now });
  const j = q.enqueue('x', {}, { maxAttempts: 2 });
  q.claim();
  const once = q.fail(j.id, new Error('server down'));
  assert.equal(once.state, 'queued');
  assert.equal(once.error, 'server down');
  assert.equal(q.claim(), null, 'not before the back-off');
  c.t += BACKOFF_MS[0];
  assert.equal(q.claim().id, j.id);
  assert.equal(q.fail(j.id, 'still down').state, 'failed', 'no attempts left');
  assert.equal(q.retry(j.id).state, 'queued');
  assert.equal(q.get(j.id).attempts, 0);
  assert.throws(() => q.retry(q.enqueue('y').id), /queued job cannot be retried/);
});

test('jobs left running by a closed app are queued again at start', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'db.sqlite');
  let db = open(file);
  const j = new JobQueue(db).enqueue('note.summarize', { noteId: 'n1' }, { key: 'n1' });
  new JobQueue(db).claim();
  db.close();   // the app quit while the job ran
  db = open(file);
  const q = new JobQueue(db);
  assert.equal(q.get(j.id).state, 'running');
  assert.equal(q.recover({ all: true }), 1);
  assert.equal(q.get(j.id).state, 'queued');
  assert.equal(q.claim().attempts, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the runner runs jobs in order, chains the next step, and records failures', async () => {
  const q = new JobQueue(open(':memory:'));
  const r = new JobRunner({ queue: q });
  const seen = [];
  r.register('a', async (p, { enqueue }) => { seen.push(`a${p.n}`); if (p.n === 1) enqueue('b', { n: 1 }); return { n: p.n }; });
  r.register('b', async (p) => { seen.push(`b${p.n}`); });
  r.register('boom', async () => { throw Object.assign(new Error('no such meeting'), { permanent: true }); });
  r.enqueue('a', { n: 1 });
  r.enqueue('a', { n: 2 });
  const bad = r.enqueue('boom', {});
  r.start();
  await r.idle();
  assert.deepEqual(seen, ['a1', 'a2', 'b1']);
  assert.equal(q.get(bad.id).state, 'failed', 'a permanent error is not retried');
  assert.equal(q.get(bad.id).error, 'no such meeting');
  assert.deepEqual(q.counts(), { queued: 0, running: 0, done: 3, failed: 1, cancelled: 0 });
  await r.stop();
});

test('a job of a kind with no handler waits instead of failing', async () => {
  const q = new JobQueue(open(':memory:'));
  const r = new JobRunner({ queue: q });
  r.register('known', async () => {});
  const later = q.enqueue('from-a-newer-version', {});
  r.start();
  await r.idle();
  assert.equal(q.get(later.id).state, 'queued');
  await r.stop();
});

test('an existing database is copied before it moves to a newer schema, once, and a new one is not', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { MIGRATIONS } = require('../src/core/db');
  const dir = tmpDir();
  const file = path.join(dir, 'whisperbrain.sqlite');
  const old = new DatabaseSync(file);   // a database as the previous version left it
  for (const m of MIGRATIONS.slice(0, -1)) old.exec(m);
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  old.exec("INSERT INTO notes (id, title, created_at, updated_at) VALUES ('n1', 'Kept', 1, 1)");
  old.close();
  const db = open(file);
  const copy = `${file}.before-v${MIGRATIONS.length}`;
  assert.ok(fs.existsSync(copy), 'the copy is next to the database');
  const back = new DatabaseSync(copy, { readOnly: true });
  assert.equal(back.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length - 1, 'the copy is the old schema');
  assert.equal(back.prepare('SELECT title FROM notes').get().title, 'Kept');
  back.close();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  db.close();
  const fresh = path.join(dir, 'new.sqlite');
  open(fresh).close();
  assert.equal(fs.existsSync(`${fresh}.before-v${MIGRATIONS.length}`), false, 'nothing to keep from an empty database');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the work after a recording survives a quit in the middle and finishes at the next start', async (t) => {
  const { createApp } = require('../src/server/app');
  const fakePlatform = () => ({
    id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
    async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
    async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
    async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
  });
  const dataDir = tmpDir('wb-jobs-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

  // 1st run: the recording stops, then the app quits while the first step is still running
  const one = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  await one.ready;
  await one.runner.stop();   // so the step is caught "in flight" below, as a quit would leave it
  const n = one.notes.create({ title: 'Budget review' });
  one.notes.addSegments(n.id, [{ speaker: 'me', text: 'We agreed the marketing budget for the spring campaign and the hiring plan.', startMs: 0, endMs: 4000, channel: 'mic' }]);
  one.bus.publish('recording.stopped', { noteId: n.id, durationMs: 4000 });
  const first = one.jobs.claim(['note.names']);
  assert.equal(first.kind, 'note.names');
  one.close();
  await one.settled;

  // 2nd run: the step is picked up again and the whole chain completes
  const two = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => two.close());
  const seen = [];
  two.bus.subscribe((e) => { if (e.type === 'note.insights') seen.push(e.data.id); });
  await two.ready;
  await until(() => seen.includes(n.id));
  await two.runner.idle();
  const chain = two.jobs.list().filter((j) => j.kind.startsWith('note.'));   // (the start-up jobs for items and people are not part of the chain)
  const byKind = Object.fromEntries(chain.map((j) => [j.kind, j]));
  assert.deepEqual(Object.keys(byKind).sort(), ['note.insights', 'note.names', 'note.summarize']);
  assert.ok(chain.every((j) => j.state === 'done'), JSON.stringify(chain));
  assert.equal(byKind['note.names'].attempts, 2, 'the interrupted step ran again');
});

test('the Activity API lists jobs with their meeting, and runs a failed one again', async (t) => {
  const { createApp } = require('../src/server/app');
  const { createServer } = require('../src/server/http');
  const { ROOT } = require('./helpers');
  const dataDir = tmpDir('wb-jobs-api-');
  const app = createApp({ dataDir, version: 'test', platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null } });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (method, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}` } }); return { status: r.status, body: await r.json() }; };
  await app.ready;
  await app.runner.stop();
  const n = app.notes.create({ title: 'Weekly' });
  const j = app.jobs.enqueue('note.insights', { noteId: n.id }, { maxAttempts: 1 });
  app.jobs.claim(['note.insights']);
  app.jobs.fail(j.id, new Error('AI server unreachable'));
  const list = await call('GET', '/api/jobs');
  assert.equal(list.status, 200);
  assert.equal(list.body.counts.failed, 1);
  const mine = list.body.jobs.find((x) => x.id === j.id);
  assert.deepEqual(mine.note, { id: n.id, title: 'Weekly' });
  assert.equal(mine.error, 'AI server unreachable');
  const again = await call('POST', `/api/jobs/${j.id}/retry`);
  assert.equal(again.body.state, 'queued');
  assert.equal((await call('POST', `/api/jobs/${j.id}/retry`)).status, 409, 'a waiting job is not retried twice');
  assert.equal((await call('POST', '/api/jobs/99999/cancel')).status, 404);
});

test('jobs in different lanes run at the same time: a long scan does not hold up the other work', async () => {
  const q = new JobQueue(open(':memory:'));
  const r = new JobRunner({ queue: q });
  const order = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  r.register('slow', async () => { order.push('slow:start'); await gate; order.push('slow:end'); }, { lane: 'sources' });
  r.register('quick', async () => { order.push('quick'); });
  r.enqueue('slow', {});
  r.enqueue('quick', {});
  r.start();
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual([...order].sort(), ['quick', 'slow:start'], 'quick ran while slow was still running');
  release();
  await r.idle();
  assert.equal(order.at(-1), 'slow:end');
  await r.stop();
});

test('the AI-run ledger notes every call and whether it left this computer, without keeping any text', async (t) => {
  const { createApp } = require('../src/server/app');
  const { startFakeLlm } = require('./fake-llm');
  const dataDir = tmpDir('wb-ledger-');
  const app = createApp({ dataDir, version: 'test', platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null } });
  const llm = await startFakeLlm(() => 'A short answer');
  t.after(() => { llm.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url, model: 'fake-model' } });
  const secret = 'The quarterly numbers are confidential';
  assert.equal(await app.scheduler.client('chat').complete([{ role: 'user', content: secret }]), 'A short answer');
  let runs = app.aiRuns.list();
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].lane, runs[0].model, runs[0].local, runs[0].ok, runs[0].charsIn, runs[0].charsOut], ['chat', 'fake-model', true, true, secret.length, 14]);
  assert.ok(!JSON.stringify(app.db.prepare('SELECT * FROM ai_runs').all()).includes('quarterly'), 'the text itself is never kept');
  // a server somewhere else: the call is recorded as one that left the computer, even though it fails here
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: 'http://203.0.113.9:9/v1' } });
  await assert.rejects(app.scheduler.client('background').complete([{ role: 'user', content: 'hello' }], { signal: AbortSignal.timeout(300) }));
  runs = app.aiRuns.list();
  assert.deepEqual([runs[0].lane, runs[0].host, runs[0].local, runs[0].ok], ['background', '203.0.113.9:9', false, false]);
  assert.deepEqual([app.aiRuns.summary().total, app.aiRuns.summary().remote, app.aiRuns.summary().remoteChars], [2, 1, 5]);
  const old = app.db.prepare('INSERT INTO ai_runs (at, lane) VALUES (?, ?)').run(Date.now() - 200 * 86400000, 'chat');
  assert.equal(app.aiRuns.prune(), 1, 'old entries go');
  assert.ok(old);
});
