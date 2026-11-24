'use strict';
// Search by meaning, beside the word search (a spike: the index, the fusion and the graceful absence are real; the embedder that
// ships is a hashing stand-in, not a language model, and says so). sqlite-vec is optional: without it, search is the word search.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { open, MIGRATIONS } = require('../src/core/db');
const { Notes } = require('../src/core/notes');
const { rrf, chunkTranscript, HashEmbedder, SemanticIndex } = require('../src/search/semantic');

let vecOk = true;
try { require('sqlite-vec'); } catch { vecOk = false; }
const skip = vecOk ? false : 'sqlite-vec is not installed';

test('rrf: reciprocal rank fusion, an item high in both lists beats one that leads only one', () => {
  const fused = rrf([['a', 'b', 'c'], ['b', 'd', 'a']]);
  assert.deepEqual(fused.map((x) => x.id), ['b', 'a', 'd', 'c']);
  assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(rrf([[], []]), []);
  assert.deepEqual(rrf([['x']]).map((x) => x.id), ['x']);
});

test('chunkTranscript: consecutive lines grouped up to a size, with who and when', () => {
  const segs = Array.from({ length: 8 }, (_, i) => ({ id: i, startMs: i * 5000, endMs: i * 5000 + 4000, label: i % 2 ? 'Bruno' : 'Ana', text: `sentence number ${i} about the budget`.padEnd(60, '.') }));
  const chunks = chunkTranscript(segs, { maxChars: 200 });
  assert.ok(chunks.length >= 2 && chunks.every((c) => c.text.length <= 260));
  assert.equal(chunks[0].startMs, 0);
  assert.match(chunks[0].text, /^Ana: sentence number 0/);
  assert.equal(chunks.flatMap((c) => c.text.split('\n')).length, 8, 'every line is in exactly one chunk');
});

test('HashEmbedder: deterministic, unit length, and texts that share words are nearer than texts that do not', async () => {
  const e = new HashEmbedder();
  const [a, a2, b] = await e.embed(['the recruiter budget for hiring engineers', 'the recruiter budget for hiring engineers', 'completely unrelated football match tonight']);
  const [c] = await e.embed(['hiring budget recruiter']);
  const dot = (x, y) => x.reduce((n, v, i) => n + v * y[i], 0);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-6);
  assert.deepEqual(Array.from(a), Array.from(a2));
  assert.ok(dot(a, c) > dot(b, c));
  assert.equal(e.dim, a.length);
});

function rig() {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  const notes = new Notes(db, null);
  const mk = (title, lines) => { const n = notes.create({ title }); notes.addSegments(n.id, lines.map((text, i) => ({ speaker: 'them', speakerId: 's1', startMs: i * 5000, endMs: i * 5000 + 4000, text }))); notes.reindex(n.id); return n; };
  return { db, notes, mk, index: new SemanticIndex({ db, notes, embedder: new HashEmbedder() }) };
}

test('SemanticIndex: indexes meetings and finds the chunk nearest to a question', { skip }, async () => {
  const r = rig();
  assert.equal(await r.index.init(), true);
  const a = r.mk('Hiring sync', ['the recruiter said we can close two engineers by march', 'the hiring budget for the platform team is approved']);
  const b = r.mk('Football', ['did you see the match last night', 'the striker scored twice in the second half']);
  await r.index.indexNote(a.id); await r.index.indexNote(b.id);
  const hits = await r.index.search('recruiter hiring engineers budget', { k: 3 });
  assert.equal(hits[0].noteId, a.id);
  assert.match(hits[0].text, /recruiter/);
  await r.index.indexNote(a.id);                                       // again: replaced, not doubled
  assert.equal(r.db.prepare('SELECT COUNT(*) c FROM semantic_chunks WHERE note_id = ?').get(a.id).c, 1);
});

test('SemanticIndex: a deleted meeting leaves nothing to find', { skip }, async () => {
  const r = rig();
  await r.index.init();
  const a = r.mk('Hiring sync', ['the recruiter said we can close two engineers by march']);
  await r.index.indexNote(a.id);
  r.notes.remove(a.id);
  assert.deepEqual(await r.index.search('recruiter engineers'), []);
  r.index.prune();
  assert.equal(r.db.prepare('SELECT COUNT(*) c FROM semantic_vec').get().c, 0);
});

test('hybrid: a meeting that matches by words and by meaning leads one that matches only one way', { skip }, async () => {
  const r = rig();
  await r.index.init();
  const both = r.mk('Hiring sync', ['the recruiter said we can close two engineers by march', 'budget for hiring approved']);
  const wordsOnly = r.mk('Offsite', ['we mentioned the recruiter once while planning the offsite dinner and the venue and the bus']);
  const neither = r.mk('Football', ['the striker scored twice']);
  for (const n of [both, wordsOnly, neither]) await r.index.indexNote(n.id);
  const res = await r.index.hybrid('recruiter hiring engineers', { limit: 5 });
  assert.equal(res[0].note.id, both.id);
  assert.ok(res.every((x) => x.note.id !== neither.id), 'a meeting that matches neither way is not returned');
});

test('without sqlite-vec (or when it will not load) search is the word search, and says so', async () => {
  const r = rig();
  const index = new SemanticIndex({ db: r.db, notes: r.notes, embedder: new HashEmbedder(), load: () => { throw new Error('no extension here'); } });
  assert.equal(await index.init(), false);
  assert.match(index.reason, /no extension here/);
  const a = r.mk('Hiring sync', ['the recruiter said we can close two engineers by march']);
  const res = await index.hybrid('recruiter', { limit: 5 });
  assert.equal(res[0].note.id, a.id);
  assert.deepEqual(res[0].via, ['words']);
});

test('the app: off by default; switched on, it indexes and the route fuses both searches', { skip }, async () => {
  const { createApp } = require('../src/server/app');
  const { createServer } = require('../src/server/http');
  const fs = require('node:fs'), path = require('node:path');
  const { tmpDir, ROOT } = require('./helpers');
  const quiet = { id: 'fake', session: 't', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null };
  const dataDir = tmpDir('wb-sem-');
  const app = createApp({ dataDir, platform: quiet });
  await app.ready;
  assert.equal(app.semantic.available, false, 'nothing is loaded until it is switched on');
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: `wb_token=${token}` } }).then((r) => r.json());
  const n = app.notes.create({ title: 'Hiring sync' });
  app.notes.addSegments(n.id, [{ speaker: 'them', startMs: 0, endMs: 4000, text: 'the recruiter said we can close two engineers by march' }]);
  app.notes.reindex(n.id);
  const before = await get('/api/search/semantic?q=recruiter');
  assert.deepEqual([before.available, before.results.map((r) => r.id), before.results[0].via], [false, [n.id], ['words']]);
  app.settings.update({ semanticSearch: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.semantic.available, true);
  await app.semantic.indexNote(n.id);
  const after = await get('/api/search/semantic?q=recruiter%20engineers');
  assert.equal(after.available, true);
  assert.deepEqual(after.results[0].via.sort(), ['meaning', 'words']);
  await srv.close(); app.close(); await app.settled;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('deleting transcripts or everything removes what was indexed from them (text and vectors)', { skip }, async () => {
  const { Account } = require('../src/core/account');
  const { Speakers } = require('../src/speakers/store');
  const r = rig();
  await r.index.init();
  const a = r.mk('Hiring sync', ['the recruiter said we can close two engineers by march']);
  await r.index.indexNote(a.id);
  assert.equal(r.db.prepare('SELECT COUNT(*) c FROM semantic_chunks').get().c, 1);
  const account = new Account({ db: r.db, notes: r.notes, settings: { reset() {} }, speakers: new Speakers(r.db, null), models: { catalog: [] }, bus: null, semantic: r.index });
  account.deleteTranscripts();
  assert.equal(r.db.prepare('SELECT COUNT(*) c FROM semantic_chunks').get().c, 0, 'the text copy is gone');
  assert.equal(r.db.prepare('SELECT COUNT(*) c FROM semantic_vec').get().c, 0, 'and so are the vectors');
  const b = r.mk('Again', ['the budget was approved yesterday afternoon']);
  await r.index.indexNote(b.id);
  account.deleteEverything();
  assert.equal(r.db.prepare('SELECT COUNT(*) c FROM semantic_chunks').get().c + r.db.prepare('SELECT COUNT(*) c FROM semantic_vec').get().c, 0);
});

test('chunks carry the names of the people, not "Them"', { skip }, async () => {
  const { Speakers } = require('../src/speakers/store');
  const r = rig();
  await r.index.init();
  const n = r.mk('Call', ['good morning everyone']);
  const speakers = new Speakers(r.db, null);
  speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: new Float32Array(4).fill(1), count: 1 });
  speakers.rename(n.id, 's1', 'Ana Silva');
  await r.index.indexNote(n.id);
  assert.match(r.db.prepare('SELECT text FROM semantic_chunks').get().text, /^Ana Silva: good morning/);
});

test('switching the setting off stops vector results at once (without unloading anything)', { skip }, async () => {
  const r = rig();
  await r.index.init();
  const n = r.mk('Hiring', ['the recruiter said we can close two engineers by march']);
  await r.index.indexNote(n.id);
  assert.equal((await r.index.hybrid('recruiter engineers')).at(0).via.includes('meaning'), true);
  r.index.enabled = () => false;
  assert.deepEqual((await r.index.hybrid('recruiter engineers')).at(0).via, ['words']);
});
