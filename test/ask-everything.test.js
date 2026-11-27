'use strict';
// Ask AI across everything in the app, not only meetings (src/llm/workspace.js + AiService.chat): documents from connected
// sources, action items, decisions and promises, people, projects, topics, glossary and calendar are numbered sources the
// answer can cite, and each cited one comes back with what the UI needs to open it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createApp } = require('../src/server/app');
const { workspaceRecords } = require('../src/llm/workspace');
const { startFakeLlm } = require('./fake-llm');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const boot = async (t) => {
  const dataDir = tmpDir('wb-ask-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  await app.runner.stop();
  return app;
};
const withLlm = async (t, app, reply) => {
  const llm = await startFakeLlm((messages) => (typeof reply === 'function' ? reply(messages) : reply));
  t.after(() => llm.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url, model: 'fake-model' } });
  return llm;
};
// the [n] a source was given in the context sent to the AI
const numberOf = (sent, re) => Number((sent.match(new RegExp(`\\[(\\d+)\\] ${re.source}`)) || [])[1]);

test('Ask AI reaches action items, decisions, promises and documents, and cites them', async (t) => {
  const app = await boot(t);
  const n = app.notes.create({ title: 'Pricing call', body: 'talked about plans', status: 'done' });
  app.knowledge.addAction(n.id, { text: 'Send the revised pricing sheet', owner: 'Rui', due: '2026-12-04' });
  app.assertions.add({ kind: 'decision', text: 'Drop the free tier from January', noteId: n.id, origin: 'user' });
  app.assertions.add({ kind: 'commitment', text: 'Review the vendor contract', owner: 'Ana', noteId: n.id, origin: 'user' });
  const src = app.items.addSource({ kind: 'gmail', name: 'Gmail', config: {} });
  const mail = app.items.upsert(src.id, { externalId: 'm1', kind: 'email', title: 'Invoice from Acme', text: 'Your invoice for November is attached.', occurredAt: Date.now() }).item;

  let sent = '';
  const llm = await withLlm(t, app, (messages) => {
    sent = messages.at(-1).content;
    const a = numberOf(sent, /Action item/), d = numberOf(sent, /Decision/), m = numberOf(sent, /Document from Gmail/);
    return `Open: send the sheet [${a}]. Decided: drop it [${d}]. Mail: invoice [${m}]. Invented [99].`;
  });
  void llm;

  const r1 = await app.ai.chat(null, 'What are my open tasks, what did we decide, and what are my latest e-mails?');
  assert.match(sent, /Action item “Send the revised pricing sheet”.*\n\[open\] Send the revised pricing sheet — owner Rui, due 2026-12-04; from the meeting “Pricing call”/);
  assert.match(sent, /Decision “Drop the free tier from January”.*\nDrop the free tier from January; from the meeting “Pricing call”/);
  assert.match(sent, /Document from Gmail “Invoice from Acme”/);
  assert.doesNotMatch(r1.answer, /\[99\]/, 'an invented number is dropped');
  const kinds = r1.sources.filter((s) => s.n).map((s) => s.kind);
  assert.deepEqual(kinds, ['action', 'decision', 'item']);
  const action = r1.sources.find((s) => s.kind === 'action');
  assert.equal(action.noteId, n.id, 'an action item opens the meeting it came from');
  assert.equal(r1.sources.find((s) => s.kind === 'item').id, mail.id);
  // stored with the chat, so the links still work after a reload
  assert.equal(app.notes.chatHistory(null).at(-1).sources.find((s) => s.kind === 'action').noteId, n.id);

  await app.ai.chat(null, 'What do I owe people?');
  assert.match(sent, /Promise “Review the vendor contract”.*\nReview the vendor contract — Ana owes/);
});

test('when no meeting matches, other sources still answer instead of a flat "nothing found"', async (t) => {
  const app = await boot(t);
  app.notes.create({ title: 'Design review', body: 'tokens and dark mode', status: 'done' });
  const src = app.items.addSource({ kind: 'folder', name: 'Vault', config: { path: '/nowhere/v' } });
  app.items.upsert(src.id, { externalId: 'roadmap.md', title: 'Roadmap', text: 'The kiwi launch moves to March because of hiring.' });
  app.chunkIndex.syncBatch(50);
  let sent = '';
  await withLlm(t, app, (messages) => { sent = messages.at(-1).content; return `It moves to March [${numberOf(sent, /Document/)}].`; });
  const r = await app.ai.chat(null, 'When is the kiwi launch?');
  assert.match(sent, /No meeting mentions/);
  assert.match(sent, /Answer from the numbered sources below|Unless a numbered source below covers it/);
  assert.match(sent, /Document “Roadmap”/);
  assert.deepEqual(r.sources.map((s) => s.kind), ['item']);
});

test('people, projects, topics and glossary terms named in the question come with the answer', async (t) => {
  const app = await boot(t);
  const n = app.notes.create({ title: 'Kickoff', body: 'Orion kickoff', status: 'done', attendees: [{ name: 'Marta Silva', email: 'marta@example.com' }] });
  app.entities.syncNote(n.id);
  app.projects.create({ name: 'Orion', keywords: ['orion'] });
  const tp = app.knowledge.upsertTopic('Onboarding');
  app.knowledge.setNoteTopics(n.id, [{ name: 'Onboarding', weight: 1 }]);
  app.knowledge.upsertTerm({ term: 'ARR', definition: 'Annual recurring revenue' });
  const ws = { ...app.ai.workspace, notes: app.notes, knowledge: app.knowledge };

  const recs = await workspaceRecords('What did Marta say about Orion onboarding and ARR?', ws, { scope: { terms: 'marta orion onboarding arr' } });
  const kinds = recs.map((r) => r.kind);
  for (const k of ['term', 'person', 'project', 'topic']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  const person = recs.find((r) => r.kind === 'person');
  assert.equal(person.title, 'Marta Silva');
  assert.ok(person.key, 'a person opens by key');
  assert.match(recs.find((r) => r.kind === 'project').text, /meetings: Kickoff/);
  assert.equal(recs.find((r) => r.kind === 'topic').id, tp.id ?? tp);
  assert.match(recs.find((r) => r.kind === 'term').text, /Annual recurring revenue/);

  // a question naming none of them gets none: nothing is guessed
  assert.deepEqual(await workspaceRecords('How is the weather?', ws, { scope: { terms: 'weather' } }), []);
});

test('calendar events come in when the question asks about the schedule; a slow calendar is not waited on forever', async (t) => {
  const now = Date.now();
  const calendar = { async events() { return { events: [{ id: 'e1', summary: 'Board meeting', start: now + 86400000, end: now + 90000000, attendees: [{ name: 'Rui' }] }] }; } };
  const recs = await workspaceRecords('What is on my calendar this week?', { calendar }, { scope: {}, now });
  assert.deepEqual(recs.map((r) => [r.kind, r.title]), [['event', 'Board meeting']]);
  assert.match(recs[0].text, /with Rui/);
  assert.deepEqual(await workspaceRecords('Summarise the pricing call', { calendar }, { scope: { terms: 'pricing' }, now }), [], 'no calendar words, no events');
  const broken = { events() { return Promise.reject(new Error('offline')); } };
  assert.deepEqual(await workspaceRecords('my agenda tomorrow', { calendar: broken }, { scope: {}, now }), []);
});

test('a private source is never handed to an AI server that may not see it', async () => {
  const items = {
    sources: () => [{ id: 's1', kind: 'gmail', name: 'Gmail' }],
    list: () => [{ id: 'i1', title: 'Secret', preview: 'x', occurredAt: Date.now() }, { id: 'i2', title: 'Open', preview: 'y', occurredAt: Date.now() }],
  };
  const recs = await workspaceRecords('latest emails', { items, mayShare: (k, id) => id !== 'i1' }, { scope: {} });
  assert.deepEqual(recs.map((r) => r.title), ['Open']);
});

test('a question about a source that is not connected says so, instead of "found nothing"', async (t) => {
  const app = await boot(t);
  app.notes.create({ title: 'Standup', body: 'status', status: 'done' });
  let sent = '';
  await withLlm(t, app, (messages) => { sent = messages.at(-1).content; return 'Gmail is not connected.'; });
  await app.ai.chat(null, 'read my last two emails');
  assert.match(sent, /Connected sources: none besides meetings\. Not connected: e-mail \(Gmail\)/);
  app.items.addSource({ kind: 'gmail', name: 'Gmail', config: {} });
  await app.ai.chat(null, 'read my last two emails');
  assert.match(sent, /Connected sources: Gmail \(0 items\)\./);
  assert.doesNotMatch(sent, /Not connected/);
  await app.ai.chat(null, 'summarise the standup');
  assert.doesNotMatch(sent, /Connected sources/, 'only when the question asks about a kind of source');
});
