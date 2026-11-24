'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Templates } = require('../src/core/templates');
const { LlmClient, ThinkFilter } = require('../src/llm/client');
const { AiService } = require('../src/llm/service');
const prompts = require('../src/llm/prompts');
const retrieve = require('../src/llm/retrieve');
const { startFakeLlm } = require('./fake-llm');

function setup(llmCfg) {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const templates = new Templates(db);
  if (llmCfg) settings.update({ llm: llmCfg });
  const llm = new LlmClient(() => settings.get('llm'));
  return { notes, settings, templates, llm, ai: new AiService({ notes, templates, settings, llm, bus }) };
}

test('ThinkFilter hides <think> blocks even when tags are split across chunks', () => {
  const f = new ThinkFilter();
  let out = '';
  for (const c of ['Hel', 'lo <thi', 'nk>secret reasoning</th', 'ink>\n\nWorld', '!']) out += f.push(c);
  out += f.flush();
  assert.equal(out, 'Hello World!');
  const g = new ThinkFilter();
  assert.equal(g.push('a < b and <t') + g.flush(), 'a < b and <t');
});

test('client streams, lists models, sends the API key and reports HTTP errors', async (t) => {
  const srv = await startFakeLlm(() => 'Hello from the model', { apiKey: 'k1' });
  t.after(srv.close);
  const ok = new LlmClient(() => ({ baseUrl: srv.url, apiKey: 'k1', model: '', temperature: 0.2 }));
  assert.deepEqual(await ok.listModels(), ['fake-model']);
  assert.equal(await ok.complete([{ role: 'user', content: 'hi' }]), 'Hello from the model');
  assert.equal(srv.requests[0].model, 'fake-model', 'falls back to the first server model');
  assert.equal(srv.requests[0].stream, true);
  const bad = new LlmClient(() => ({ baseUrl: srv.url, apiKey: 'nope', model: 'm' }));
  await assert.rejects(bad.complete([{ role: 'user', content: 'x' }]), (e) => e.code === 'unauthorized');
  const down = new LlmClient(() => ({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }));
  await assert.rejects(down.complete([{ role: 'user', content: 'x' }]), (e) => e.code === 'unreachable' && /Is it running/.test(e.message));
  assert.equal((await ok.test()).ok, true);
  assert.equal((await down.test()).ok, false);
  await assert.rejects(new LlmClient(() => ({ baseUrl: '' })).listModels(), (e) => e.code === 'not-configured');
});

test('summarize: prompt carries notes, transcript and template; result stored and title generated', async (t) => {
  const srv = await startFakeLlm((messages) => (messages[0].content.startsWith('You write short') ? '"Budget review."' : '## Key points\n- ship friday'));
  t.after(srv.close);
  const { ai, notes } = setup({ baseUrl: srv.url, model: 'm' });
  const n = notes.create({ body: 'my note: budget' });
  notes.addSegments(n.id, [{ speaker: 'them', startMs: 0, endMs: 1000, text: 'Budget is approved' }, { speaker: 'me', startMs: 2000, endMs: 3000, text: 'Great' }]);
  const deltas = [];
  const out = await ai.summarize(n.id, { templateId: 'standup', onDelta: (d) => deltas.push(d) });
  const prompt = srv.requests[0].messages[1].content;
  assert.match(prompt, /<user_notes>\nmy note: budget/);
  assert.match(prompt, /\[0:00\] Them: Budget is approved/);
  assert.match(prompt, /For each speaker produce/);
  assert.equal(out.summary, '## Key points\n- ship friday');
  assert.equal(out.title, 'Budget review', 'auto title strips quotes and the trailing period');
  assert.equal(out.templateId, 'standup');
  assert.ok(deltas.length > 1, 'streamed in pieces');
});

test('summarize: a transcript over the budget is reduced chunk by chunk first', async (t) => {
  const srv = await startFakeLlm((messages) => (/^Part \d+ of/.test(messages[1].content) ? '- partial fact' : '## Summary\nfinal'));
  t.after(srv.close);
  const { ai, notes, settings } = setup({ baseUrl: srv.url, model: 'm', contextChars: 3000 });
  settings.update({ llm: { contextChars: 100 } }); // budget() floors at 2000
  const n = notes.create({ title: 'Long', body: '' });
  const segs = Array.from({ length: 120 }, (_, i) => ({ speaker: 'them', startMs: i * 1000, endMs: i * 1000 + 900, text: `statement number ${i} about the roadmap and other topics` }));
  notes.addSegments(n.id, segs);
  const stages = [];
  await ai.summarize(n.id, { onStage: (s) => stages.push(s.stage) });
  const reduces = srv.requests.filter((r) => /^Part \d+ of/.test(r.messages[1].content)).length;
  assert.ok(reduces >= 2, `expected several reduce calls, got ${reduces}`);
  assert.deepEqual([...new Set(stages)], ['reduce', 'write']);
  const final = srv.requests.at(-1).messages[1].content;
  assert.match(final, /--- Part 1 ---\n- partial fact/);
  assert.ok(final.length < 6000, 'final prompt stays small');
});

test('summarize refuses when there is nothing to summarize', async () => {
  const { ai, notes } = setup({ baseUrl: 'http://x/v1', model: 'm' });
  const n = notes.create({});
  await assert.rejects(ai.summarize(n.id), /Nothing to summarize/);
});

test('note chat: keeps history, includes the transcript, and picks relevant excerpts when too long', async (t) => {
  const srv = await startFakeLlm((messages) => `answer ${messages.length}`);
  t.after(srv.close);
  const { ai, notes, settings } = setup({ baseUrl: srv.url, model: 'm' });
  const n = notes.create({ title: 'Roadmap' });
  const filler = Array.from({ length: 400 }, (_, i) => ({ speaker: 'them', startMs: i * 1000, endMs: i * 1000 + 900, text: `generic filler sentence number ${i} nothing special` }));
  filler.push({ speaker: 'them', startMs: 500000, endMs: 501000, text: 'The migration to PostgreSQL happens in March' });
  notes.addSegments(n.id, filler);
  settings.update({ llm: { contextChars: 2000 } });
  const r1 = await ai.chat(n.id, 'When is the PostgreSQL migration?');
  assert.equal(r1.answer, 'answer 2');
  assert.match(srv.requests[0].messages.at(-1).content, /PostgreSQL happens in March/);
  assert.ok(srv.requests[0].messages.at(-1).content.length < 6000);
  const r2 = await ai.chat(n.id, 'And who owns it?');
  assert.equal(r2.answer, 'answer 4', 'system + 2 history + question');
  assert.equal(notes.chatHistory(n.id).length, 4);
  assert.deepEqual(r1.sources, [{ id: n.id, title: 'Roadmap' }]);
});

test('global chat retrieves matching meetings and reports sources', async (t) => {
  const srv = await startFakeLlm(() => 'ok');
  t.after(srv.close);
  const { ai, notes } = setup({ baseUrl: srv.url, model: 'm' });
  const a = notes.create({ title: 'Hiring sync', body: 'discussed the recruiter budget' });
  notes.create({ title: 'Unrelated', body: 'lunch plans' });
  const r = await ai.chat(null, 'what did we say about the recruiter budget?');
  assert.deepEqual(r.sources.map((s) => s.id), [a.id]);
  assert.match(srv.requests[0].messages.at(-1).content, /### Hiring sync/);
  assert.equal(notes.chatHistory(null).length, 2);
  assert.equal(notes.chatHistory(a.id).length, 0, 'global chat is separate from note chat');
});

test('retrieval ranks windows by query terms and keeps chronological order', () => {
  const lines = Array.from({ length: 60 }, (_, i) => (i === 5 ? 'we discussed hiring plans' : i === 50 ? 'hiring budget is fixed' : `noise line ${i} unrelated content here`));
  const wins = retrieve.pick('hiring budget', lines, 700, 300);
  const text = wins.map((w) => w.text).join('\n');
  assert.match(text, /hiring plans/);
  assert.match(text, /hiring budget is fixed/);
  assert.deepEqual(wins.map((w) => w.idx), [...wins.map((w) => w.idx)].sort((a, b) => a - b));
  assert.deepEqual(prompts.chunkText('a\nb\nc', 3), ['a\nb', 'c']);
});
