'use strict';
// A reasoning model (qwen3 on Ollama) can spend a short reply cap thinking and end with no answer. That must never turn
// into a silent empty title: the client asks for no thinking where it can, retries once, and otherwise says why.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Templates } = require('../src/core/templates');
const { LlmClient } = require('../src/llm/client');
const { AiService } = require('../src/llm/service');

// An OpenAI-style streaming server. reply(body) -> { reasoning, content, finish, thinkTags }.
async function server(reply) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] })); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const r = reply(body, requests.length);
      res.setHeader('content-type', 'text/event-stream');
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
      if (r.reasoning) send(r.thinkTags ? { content: `<think>${r.reasoning}` } : { reasoning: r.reasoning });
      if (r.content) send({ content: r.content });
      send({}, r.finish || 'stop');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, requests, close: () => new Promise((ok) => srv.close(ok)) };
}

const cut = { reasoning: 'Okay, the user wants a short title', finish: 'length' };

test("reasoning 'off' is sent to Ollama as reasoning_effort none, and not to other servers", async (t) => {
  const s = await server(() => ({ content: 'ok' }));
  t.after(s.close);
  const msg = [{ role: 'user', content: 'hi' }];
  await new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'qwen3:8b' })).complete(msg, { reasoning: 'off' });
  await new LlmClient(() => ({ provider: 'openai', baseUrl: s.url, model: 'gpt' })).complete(msg, { reasoning: 'off' });
  await new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'qwen3:8b' })).complete(msg);
  assert.equal(s.requests[0].reasoning_effort, 'none');
  assert.equal(s.requests[1].reasoning_effort, undefined);
  assert.equal(s.requests[2].reasoning_effort, undefined, 'only when asked');
  assert.equal(LlmClient.isOllama({ baseUrl: 'http://127.0.0.1:11434/v1' }), true);
});

test('an answer cut off while thinking is retried without thinking on Ollama', async (t) => {
  const s = await server((body) => (body.reasoning_effort === 'none' ? { content: 'Budget review' } : cut));
  t.after(s.close);
  const out = await new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'qwen3:8b' })).complete([{ role: 'user', content: 'x' }], { maxTokens: 40 });
  assert.equal(out, 'Budget review');
  assert.equal(s.requests.length, 2);
});

test('elsewhere the retry gets a larger cap; <think> tags count as thinking too', async (t) => {
  const s = await server((body) => (body.max_tokens > 40 ? { content: 'Budget review' } : { ...cut, thinkTags: true }));
  t.after(s.close);
  const out = await new LlmClient(() => ({ provider: 'openai', baseUrl: s.url, model: 'r1' })).complete([{ role: 'user', content: 'x' }], { maxTokens: 40 });
  assert.equal(out, 'Budget review');
  assert.equal(s.requests[1].max_tokens, 2048);
});

test('still nothing after the retry is an error that names the model, not an empty string', async (t) => {
  const s = await server(() => cut);
  t.after(s.close);
  await assert.rejects(new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'qwen3:8b' })).complete([{ role: 'user', content: 'x' }], { maxTokens: 40 }),
    (e) => e.code === 'thinking-cutoff' && /qwen3:8b/.test(e.message));
  assert.equal(s.requests.length, 2, 'one retry only');
});

test('a normal empty reply (no thinking) is not retried', async (t) => {
  const s = await server(() => ({ content: '' }));
  t.after(s.close);
  assert.equal(await new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'm' })).complete([{ role: 'user', content: 'x' }]), '');
  assert.equal(s.requests.length, 1);
});

function setup(url) {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ llm: { provider: 'ollama', baseUrl: url, model: 'qwen3:8b' } });
  return { notes, ai: new AiService({ notes, templates: new Templates(db), settings, llm: new LlmClient(() => settings.get('llm')), bus }) };
}

test('autoTitle titles a recorded meeting from its transcript, without thinking', async (t) => {
  const s = await server(() => ({ content: '"Budget review."' }));
  t.after(s.close);
  const { ai, notes } = setup(s.url);
  const n = notes.create({ body: '' });
  notes.addSegments(n.id, [{ speaker: 'them', startMs: 0, endMs: 1000, text: 'The budget is approved for next quarter' }]);
  const out = await ai.autoTitle(n.id);
  assert.equal(out.title, 'Budget review');
  assert.match(s.requests[0].messages[1].content, /budget is approved/, 'the transcript is what gets titled');
  assert.equal(s.requests[0].reasoning_effort, 'none');
});

test('autoTitle drops a "Meeting Title:" label the model puts in front', async (t) => {
  const replies = ['Meeting Title: Disruptive Behavior', '**Título:** Revisão do orçamento'];
  const s = await server((_b, n) => ({ content: replies[n - 1] }));
  t.after(s.close);
  const { ai, notes } = setup(s.url);
  const n = notes.create({ body: 'notes' });
  assert.equal((await ai.autoTitle(n.id)).title, 'Disruptive Behavior');
  assert.equal((await ai.autoTitle(n.id)).title, 'Revisão do orçamento');
});

test('autoTitle says why instead of keeping the note untitled in silence', async (t) => {
  const s = await server(() => ({ content: '   ' }));
  t.after(s.close);
  const { ai, notes } = setup(s.url);
  const empty = notes.create({ body: '' });
  await assert.rejects(ai.autoTitle(empty.id), (e) => e.status === 422 && /Nothing to make a title from/.test(e.message));
  assert.equal(s.requests.length, 0, 'nothing is sent for an empty meeting');
  const n = notes.create({ body: 'we agreed on the budget' });
  await assert.rejects(ai.autoTitle(n.id), (e) => e.status === 502 && /did not return a title/.test(e.message));
  assert.equal(notes.get(n.id).title, '');
});

test('glossary: definitions the model only guessed at are not kept', () => {
  const { vagueDefinition: v } = require('../src/llm/service');
  for (const d of ['A term used by Speaker 1, possibly referring to a specific item or concept', 'A term used by Speaker 1, possibly referring to a specific activity or challenge', 'Um termo usado pelo orador, possivelmente referindo-se a algo', '?']) assert.equal(v(d), true, d);
  for (const d of ['Metrics measuring web performance and user experience', 'Practice combining software development and IT operations for efficiency', 'A SWAT officer is a member of a specialized police unit trained to handle high-risk situations', 'Methodology for designing systems based on structured data formats']) assert.equal(v(d), false, d);
});
