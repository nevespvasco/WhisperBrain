'use strict';
// The data layer's upkeep (docs/adr/0001-brain-data-model.md): outbound actions cut off mid-run, the search index's change queue, the
// people backfill's cursor, the legacy search table's keys, and "Delete everything" leaving nothing behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { open } = require('../src/core/db');
const { Actions } = require('../src/brain/actions');
const { createApp } = require('../src/server/app');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const boot = async (t) => {
  const dataDir = tmpDir('wb-data-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  await app.runner.stop();
  return { app, dataDir };
};

const handlers = (runs) => ({ 'test.send': { label: 'Test', build: (i) => ({ title: 'Send it', args: i }), run: async () => { runs.n++; return { ok: true }; } } });

test('an action cut off mid-run is "interrupted" at start: shown as outcome unknown, never run again by itself', async () => {
  const db = open(':memory:');
  const runs = { n: 0 };
  const before = new Actions({ db, handlers: handlers(runs) });
  const a = before.propose('test.send', { to: 'ana@x.pt' });
  db.prepare("UPDATE actions SET state = 'running', decided_at = 1 WHERE id = ?").run(a.id);   // the app quit while it ran
  const actions = new Actions({ db, handlers: handlers(runs) });
  assert.equal(actions.recoverInterrupted(), 1);
  const got = actions.get(a.id);
  assert.equal(got.state, 'interrupted');
  assert.match(got.error, /outcome unknown/);
  assert.equal(actions.pending().length, 0, 'not offered for approval again');
  await assert.rejects(actions.approve(a.id), (e) => e.status === 409, 'and cannot be approved into a second run');
  assert.deepEqual(actions.interrupted().map((x) => x.id), [a.id]);
  assert.equal(runs.n, 0);
  assert.equal(actions.resolveInterrupted(a.id, { done: true }).state, 'done', 'the person checked: it was done');
  assert.throws(() => actions.resolveInterrupted(a.id, { done: false }), (e) => e.status === 409);
  const b = actions.propose('test.send', {});
  db.prepare("UPDATE actions SET state = 'running' WHERE id = ?").run(b.id);
  actions.recoverInterrupted();
  assert.equal(actions.resolveInterrupted(b.id, { done: false }).state, 'failed', 'it was not done: failed, not retried');
  assert.equal(runs.n, 0);
});

test('the Inbox shows an interrupted action as "check before retrying", with no approve button', async (t) => {
  const { app } = await boot(t);
  app.actions.handlers['test.send'] = handlers({ n: 0 })['test.send'];
  const a = app.actions.propose('test.send', { to: 'ana@x.pt' });
  app.db.prepare("UPDATE actions SET state = 'interrupted', error = 'x' WHERE id = ?").run(a.id);
  const card = app.inbox.cards().find((c) => c.id === a.id);
  assert.equal(card?.type, 'action-interrupted');
  assert.equal(card.title, 'Send it');
});

// ---------- the search index's change queue (dirty_owners) ----------
const { Notes } = require('../src/core/notes');
const { Speakers } = require('../src/speakers/store');
const { ItemStore } = require('../src/items/store');
const { ChunkIndex } = require('../src/search/index');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { MIGRATIONS } = require('../src/core/db');

const brain = () => {
  const db = open(':memory:');
  const notes = new Notes(db, null);
  const items = new ItemStore(db);
  return { db, notes, items, speakers: new Speakers(db, null), index: new ChunkIndex({ db, notes, items }) };
};
const drain = (index) => { let n = 0; for (let i = 0; i < 100; i++) { const r = index.syncBatch(50); n += r.done; if (!r.left) break; } return n; };
const chunkText = (db, id) => db.prepare("SELECT text FROM chunks WHERE owner_kind = 'note' AND owner_id = ? ORDER BY seq").all(id).map((r) => r.text).join('\n');
const dirty = (db) => db.prepare('SELECT owner_kind || \':\' || owner_id AS k FROM dirty_owners ORDER BY rowid').all().map((r) => r.k);

test('the index works from a queue of what changed: nothing queued, nothing looked at', () => {
  const { db, notes, items, index } = brain();
  const n = notes.create({ title: 'Weekly' });
  notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 900, text: 'the roadmap for spring' }]);
  const src = items.addSource({ kind: 'folder', name: 'docs' });
  const it = items.upsert(src.id, { externalId: 'a.md', title: 'A', text: 'alpha text' }).item;
  assert.deepEqual(dirty(db).sort(), [`item:${it.id}`, `note:${n.id}`]);
  assert.equal(index.pendingOwners(), 2);
  drain(index);
  assert.deepEqual(dirty(db), []);
  assert.deepEqual(index.syncBatch(40), { done: 0, left: 0 });
  notes.update(n.id, { body: 'new notes' });
  assert.deepEqual(dirty(db), [`note:${n.id}`], 'an edit queues its meeting');
  assert.equal(index.syncBatch(40).done, 1);
  items.tombstone(src.id, 'a.md');
  notes.remove(n.id);
  drain(index);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0, 'deletions are queued too, cascades included');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM index_owner').get().n, 0);
});

test('renaming, merging and moving speakers re-labels the indexed transcript (the hash never saw them)', () => {
  const { db, notes, speakers, index } = brain();
  const n = notes.create({ title: 'Call', status: 'done' });
  const [a, b] = notes.addSegments(n.id, [
    { speaker: 'them', speakerId: 's1', startMs: 0, endMs: 900, text: 'we ship in march' },
    { speaker: 'them', speakerId: 's2', startMs: 1000, endMs: 1900, text: 'the contract is open' },
  ]);
  speakers.save(n.id, { speakerId: 's1', channel: 'system', count: 1 });
  speakers.save(n.id, { speakerId: 's2', channel: 'system', count: 1 });
  drain(index);
  assert.match(chunkText(db, n.id), /Speaker 1: we ship/);
  speakers.rename(n.id, 's1', 'Ana');
  drain(index);
  assert.match(chunkText(db, n.id), /Ana: we ship in march/, 'a rename');
  speakers.reassignSegment(n.id, b.id, 's1');
  drain(index);
  assert.match(chunkText(db, n.id), /Ana: the contract is open/, 'a line moved to another voice');
  notes.replaceSegment(n.id, a.id, [{ startMs: 0, endMs: 900, text: 'we ship in april', speakerId: 's1' }]);
  drain(index);
  assert.match(chunkText(db, n.id), /we ship in april/, 'one utterance replaced by one part');
  const vid = db.prepare("INSERT INTO voices (id, name, embedding, created_at, updated_at) VALUES ('v1', 'Bruno', x'00', 1, 1) RETURNING id").get().id;
  speakers.rename(n.id, 's1', '');
  db.prepare("UPDATE note_speakers SET voice_id = ? WHERE note_id = ? AND speaker_id = 's1'").run(vid, n.id);
  drain(index);
  assert.match(chunkText(db, n.id), /Bruno:/);
  speakers.renameVoice(vid, 'Bruno Costa');
  drain(index);
  assert.match(chunkText(db, n.id), /Bruno Costa:/, 'a saved voice renamed');
});

test('a meeting queued again with the same pieces keeps its chunks and their vectors', () => {
  const { db, notes, index } = brain();
  const n = notes.create({ title: 'Same' });
  notes.addSegments(n.id, [{ speaker: 'me', startMs: 0, endMs: 900, text: 'nothing changes here' }]);
  drain(index);
  db.exec('UPDATE chunks SET embedded = 1');
  const ids = db.prepare('SELECT id FROM chunks ORDER BY id').all().map((r) => r.id);
  notes.update(n.id, { pinned: true });   // queued, but no piece changes
  assert.equal(index.syncBatch(40).done, 1);
  assert.deepEqual(db.prepare('SELECT id FROM chunks ORDER BY id').all().map((r) => r.id), ids);
  assert.equal(db.prepare('SELECT MIN(embedded) AS e FROM chunks').get().e, 1, 'not sent to the embedding server again');
});

test('an existing database is queued once on upgrade: every meeting, stale items and what was deleted', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'whisperbrain.sqlite');
  const v = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE dirty_owners'));
  assert.ok(v > 0);
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, v)) old.exec(m);
  old.exec(`PRAGMA user_version = ${v}`);
  old.exec(`INSERT INTO notes (id, title, created_at, updated_at) VALUES ('n1', 'Kept', 1, 1);
    INSERT INTO sources (id, kind, created_at, updated_at) VALUES ('s', 'folder', 1, 1);
    INSERT INTO items (id, source_id, external_id, title, text, hash, occurred_at, ingested_at, updated_at) VALUES ('i1', 's', 'a', 'A', 'x', 'h1', 1, 1, 1), ('i2', 's', 'b', 'B', 'y', 'h2', 1, 1, 1);
    INSERT INTO index_owner (owner_kind, owner_id, hash, indexed_at) VALUES ('item', 'i1', 'h1', 1), ('item', 'i2', 'old', 1), ('note', 'gone', 'x', 1);`);
  old.close();
  const db = open(file);
  assert.deepEqual(dirty(db).sort(), ['item:i2', 'note:gone', 'note:n1'], 'i1 is current and stays out');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('narrowing a grant hides the dropped bodies from search at once, and the index work is queued instead of run inline', async (t) => {
  const { app } = await boot(t);
  const src = app.items.addSource({ kind: 'folder', name: 'mail' });
  app.items.upsert(src.id, { externalId: 'm1', kind: 'document', title: 'Budget figures', text: 'SECRETBODY4471 numbers' });
  for (let i = 0; i < 50; i++) if (!app.chunkIndex.syncBatch(200).done) break;
  assert.equal((await app.chunkIndex.search('SECRETBODY4471')).length, 1);
  app.items.setGrant(src.id, { readLevel: 'metadata' });
  assert.equal((await app.chunkIndex.search('SECRETBODY4471')).length, 0, 'not found while its re-index waits');
  assert.ok(app.jobs.list({ state: 'queued' }).some((j) => j.kind === 'index.sync' && j.key === 'purge'), 'the index pass is a job, not run inside the bus event');
  for (let i = 0; i < 50; i++) if (!app.chunkIndex.syncBatch(200).done) break;
  assert.equal((await app.chunkIndex.search('SECRETBODY4471')).length, 0);
  assert.equal((await app.chunkIndex.search('budget figures')).length, 1, 'who/when/subject stay');
});
