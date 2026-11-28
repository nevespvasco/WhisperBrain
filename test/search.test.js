'use strict';
// The search index and Ask (src/search/index.js, src/llm/service.js): chunks over meetings and notes, words and meaning fused,
// private sources kept from a remote server, and answers that may only cite what they were given.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { chunkText, queryWords } = require('../src/search/index');
const { startFakeLlm } = require('./fake-llm');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const boot = async (t) => {
  const dataDir = tmpDir('wb-search-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  await app.runner.stop();   // the tests drive the index by hand
  return app;
};
const folder = (app, name = 'Vault', sensitivity = 'normal') => app.items.addSource({ kind: 'folder', name, sensitivity, config: { path: `/nowhere/${name}` } });
const note = (app, title, lines) => {
  const n = app.notes.create({ title, status: 'done' });
  app.notes.addSegments(n.id, lines.map((text, i) => ({ speaker: 'them', speakerId: 's1', text, startMs: i * 5000, endMs: i * 5000 + 4000, channel: 'system' })));
  return n;
};

// An embeddings server whose "meaning" is a handful of concepts, so that "price" and "cost" are neighbours without sharing a word
const CONCEPTS = [['price', 'cost', 'pricing', 'budget', 'euro', 'fee'], ['hire', 'hiring', 'recruit', 'staff', 'team'], ['launch', 'release', 'ship', 'march'], ['legal', 'contract', 'lawyer']];
async function startEmbeddings() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url !== '/v1/embeddings') { res.writeHead(404); return res.end(); }
      calls++;
      const { input, model } = JSON.parse(raw);
      const data = input.map((text, index) => {
        const lower = text.toLowerCase();
        const v = CONCEPTS.map((words) => words.filter((w) => lower.includes(w)).length);
        v.push(0.05 + (model === 'other-model' ? 1 : 0));                    // a little of everything, so no vector is all zeros
        return { index, embedding: v };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls: () => calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('text is cut at paragraph and sentence ends, and a question is reduced to its own words', () => {
  const para = 'First paragraph about the budget.\n\nSecond paragraph about hiring.\n\nThird one.';
  assert.deepEqual(chunkText(para, { max: 70 }), ['First paragraph about the budget.\n\nSecond paragraph about hiring.', 'Third one.']);
  const long = `${'A sentence of some length. '.repeat(10)}`.trim();
  assert.ok(chunkText(long, { max: 80 }).every((c) => c.length <= 80), 'a long paragraph is cut at sentence ends');
  assert.ok(chunkText('x'.repeat(2500), { max: 900 }).every((c) => c.length <= 900), 'and as a last resort anywhere');
  assert.deepEqual(queryWords('What did we decide about the Budget for Órion?'), ['decide', 'budget', 'orion']);
  assert.deepEqual(queryWords('what is the'), ['what', 'is', 'the'], 'a question of only filler words is kept as it is');
});

test('meetings and notes are indexed once, found by words (accents ignored), and opened at the right line', async (t) => {
  const app = await boot(t);
  const src = folder(app);
  app.items.upsert(src.id, { externalId: 'plan.md', title: 'Plano de lançamento', text: 'O orçamento de marketing para a primavera.\n\nContratações previstas para abril.' });
  const n = note(app, 'Atlas semanal', ['We should ship the mobile app in March.', 'The legal review of the contract is still open.']);
  const r1 = app.chunkIndex.syncBatch(50);
  assert.equal(r1.left, 0);
  assert.equal(app.chunkIndex.syncBatch(50).done, 0, 'nothing changed, nothing done');
  const items = await app.chunkIndex.search('orcamento marketing');
  assert.equal(items[0].kind, 'item');
  assert.equal(items[0].title, 'Plano de lançamento');
  const hit = (await app.chunkIndex.search('legal review contract'))[0];
  assert.equal(hit.kind, 'note');
  assert.equal(hit.id, n.id);
  assert.ok(hit.segmentId > 0, 'a hit in a meeting knows the line it starts at');
  assert.deepEqual(hit.via, ['words']);
  // an edit re-indexes only that owner; a deletion removes it
  app.items.upsert(src.id, { externalId: 'plan.md', title: 'Plano de lançamento', text: 'Agora fala só de contratações.' });
  assert.equal(app.chunkIndex.syncBatch(50).done, 1);
  assert.equal((await app.chunkIndex.search('orcamento')).length, 0, 'the old words are gone');
  app.items.tombstone(src.id, 'plan.md');
  app.notes.remove(n.id);
  app.chunkIndex.syncBatch(50);
  assert.equal(app.chunkIndex.stats().chunks, 0, 'nothing of a deleted meeting or note is left');
});

test('with an embedding model, a question finds what it means, not only what it says', async (t) => {
  const app = await boot(t);
  const emb = await startEmbeddings();
  t.after(() => emb.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: emb.url }, embeddingModel: 'fake-embed' });
  const src = folder(app);
  app.items.upsert(src.id, { externalId: 'a.md', title: 'Costs', text: 'The fee and the budget were agreed in euro.' });
  app.items.upsert(src.id, { externalId: 'b.md', title: 'People', text: 'We will recruit more staff for the team.' });
  app.chunkIndex.syncBatch(50);
  assert.equal(await app.chunkIndex.search('what is the price', { meaning: false }).then((h) => h.length), 0, 'no word in common: words alone find nothing');
  const r = await app.chunkIndex.embedPending({ batch: 16 });
  assert.equal(r.embedded, 2);
  assert.equal(app.chunkIndex.stats().vectors, true);
  const run = app.aiRuns.list().find((x) => x.lane === 'embedding');
  assert.ok(run, 'what went to the embedding server is in the egress ledger');
  assert.deepEqual([run.model, run.ok, run.charsIn > 0], ['fake-embed', true, true]);
  const hits = await app.chunkIndex.search('what is the price');
  assert.equal(hits[0].title, 'Costs');
  assert.deepEqual(hits[0].via, ['meaning']);
  assert.equal(hits.length, 1, 'only what is near enough: the staff note is not an answer about price');
  // the same word and the same meaning agree: that chunk leads, with both marks
  const both = await app.chunkIndex.search('budget');
  assert.deepEqual(both[0].via.sort(), ['meaning', 'words']);
  // another model means other vectors: everything is embedded again
  app.settings.update({ embeddingModel: 'other-model' });
  assert.equal(app.chunkIndex.checkModel(), 'other-model');
  assert.equal(app.chunkIndex.stats().embedded, 0);
  assert.equal((await app.chunkIndex.embedPending()).embedded, 2);
});

test('a private source is only sent to an embedding server on this computer', async (t) => {
  const app = await boot(t);
  const emb = await startEmbeddings();
  t.after(() => emb.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: emb.url }, embeddingModel: 'fake-embed' });
  const open = folder(app, 'Open', 'normal'), secret = folder(app, 'Secret', 'private');
  app.items.upsert(open.id, { externalId: 'o.md', title: 'Open', text: 'The budget for the launch.' });
  app.items.upsert(secret.id, { externalId: 's.md', title: 'Secret', text: 'The private budget talks.' });
  app.chunkIndex.syncBatch(50);
  const local = await app.chunkIndex.embedPending({ mayEmbed: app.mayShare });
  assert.equal(local.embedded, 2, 'this server is on this computer: both');
  // the same server seen as remote: the private one is not embedded and not offered to an answer
  app.db.exec('UPDATE chunks SET embedded = 0');
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: 'https://203.0.113.5/v1' } });
  assert.equal(app.mayShare('item', app.items.byExternal(secret.id, 's.md').id), false);
  assert.equal(app.mayShare('item', app.items.byExternal(open.id, 'o.md').id), true);
  const hits = await app.chunkIndex.search('budget', { allow: app.mayShare, meaning: false });
  assert.deepEqual(hits.map((h) => h.title), ['Open'], 'the private note never reaches a remote server');
});

test('Ask: excerpts are numbered, only given numbers can be cited, and the sources say where to open each one', async (t) => {
  const app = await boot(t);
  const src = folder(app, 'Obsidian');
  app.items.upsert(src.id, { externalId: 'launch.md', title: 'Launch plan', text: 'The mobile app launches in March, after the legal review.', uri: 'obsidian://open?vault=v&file=launch' });
  const m = note(app, 'Atlas semanal', ['We agreed to ship the mobile app in March.']);
  app.chunkIndex.syncBatch(50);
  let seen = '';
  const llm = await startFakeLlm((messages) => { seen = messages.at(-1).content; return 'The launch is in March [1]. Legal must finish first [2], and also [9].'; });
  t.after(() => llm.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url, model: 'fake-model' } });
  const res = await app.ai.chat(null, 'When does the mobile app launch?');
  assert.match(seen, /Numbered sources that may be relevant/);
  assert.match(seen, /\[1\] (Document|Meeting)/);
  assert.ok(!res.answer.includes('[9]'), 'a number that was never given is removed');
  assert.equal(res.answer.includes('[1]'), true);
  const cited = res.sources.filter((s) => s.n);
  assert.deepEqual(cited.map((s) => s.n), [1, 2]);
  const titles = cited.map((s) => s.title).sort();
  assert.deepEqual(titles, ['Atlas semanal', 'Launch plan'].sort());
  const item = cited.find((s) => s.kind === 'item');
  assert.equal(item.uri, 'obsidian://open?vault=v&file=launch');
  const meeting = cited.find((s) => s.kind === 'meeting' && s.id === m.id);
  assert.ok(meeting.segmentId > 0, 'a citation of a meeting opens the transcript at that line');
  // the answer and its sources are kept, so the links are there after a restart
  const last = app.notes.chatHistory(null).at(-1);
  assert.equal(last.role, 'assistant');
  assert.deepEqual(last.sources.filter((s) => s.n).map((s) => s.n), [1, 2]);
});

test('the index and retrieval API answer for the app, and a question with no words finds nothing', async (t) => {
  const { createServer } = require('../src/server/http');
  const path = require('node:path');
  const { ROOT } = require('./helpers');
  const app = await boot(t);
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(() => srv.close());
  const call = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: `wb_token=${token}` } })).json();
  const src = folder(app);
  app.items.upsert(src.id, { externalId: 'x.md', title: 'Roadmap', text: 'The roadmap for next year has three themes.' });
  app.chunkIndex.syncBatch(50);
  const status = await call('/api/index');
  assert.deepEqual([status.chunks, status.pending, status.vectors], [1, 0, false]);
  const hits = await call('/api/retrieve?q=roadmap%20themes');
  assert.equal(hits[0].title, 'Roadmap');
  assert.deepEqual(await call('/api/retrieve?q=%3F%21'), []);
});

test('the retrieval evaluation counts what comes back and how high', async (t) => {
  const { evaluate } = require('../src/search/eval');
  const app = await boot(t);
  const src = folder(app);
  app.items.upsert(src.id, { externalId: '1', title: 'Preço', text: 'Decisão sobre o preço do plano gratuito.' });
  app.items.upsert(src.id, { externalId: '2', title: 'Equipa', text: 'Contratações para o segundo trimestre.' });
  app.chunkIndex.syncBatch(50);
  const r = await evaluate([{ q: 'preço plano', expect: ['Preço'] }, { q: 'contratações', expect: ['Equipa', 'Preço'] }, { q: 'nada disto existe', expect: ['Preço'] }], (q) => app.chunkIndex.search(q), { k: 3 });
  assert.deepEqual([r.cases, r.recallAtK, r.mrr], [3, 0.5, 0.667]);
  assert.deepEqual(r.rows.map((x) => x.firstRank), [1, 1, null]);
});

test('Portuguese: a hand-written corpus and questions, so a change to chunking or ranking that hurts pt-PT is noticed', async (t) => {
  const { evaluate } = require('../src/search/eval');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/eval-pt.json'), 'utf8'));
  const app = await boot(t);
  const src = folder(app);
  fx.corpus.forEach((d, i) => app.items.upsert(src.id, { externalId: `d${i}`, title: d.title, text: d.text }));
  app.chunkIndex.syncBatch(100);
  const r = await evaluate(fx.questions, (q) => app.chunkIndex.search(q, { limit: 10 }), { k: 3 });
  console.log(`      pt-PT, words only: recall@3 ${r.recallAtK}, MRR ${r.mrr} (${r.cases} questions); missed: ${r.rows.filter((x) => x.found < x.wanted).map((x) => x.q).join(' | ') || 'none'}`);
  // a floor, not a target: this is the word index alone. Inflections ("contratar" for "contratações") are what a meaning index is for.
  const hard = await evaluate(fx.hard, (q) => app.chunkIndex.search(q, { limit: 10 }), { k: 3 });
  console.log(`      hard questions (few words in common): recall@3 ${hard.recallAtK} on ${hard.cases}: the part meaning search has to cover`);
  assert.ok(r.recallAtK >= 0.8, `recall@3 fell to ${r.recallAtK}`);
  assert.ok(r.mrr >= 0.7, `MRR fell to ${r.mrr}`);
});
