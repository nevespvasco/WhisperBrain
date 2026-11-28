'use strict';
// How much material a prompt may carry. The setting (contextChars) stays the cap; when an Ollama server says how many tokens the
// model works with, the material also fits in that, less the instructions and room for the reply, so Ollama never cuts the start of
// the prompt (where the "untrusted data" rules and the JSON schema are). Any other server, or no answer, keeps today's budget.
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);
const assert = require('node:assert/strict');
const http = require('node:http');
const { estimateTokens, fitBudget, CHARS_PER_TOKEN } = require('../src/llm/budget');
const { LlmClient } = require('../src/llm/client');
const { LlmScheduler } = require('../src/llm/scheduler');

test('tokens are estimated from characters, CJK text counting about one a character', () => {
  assert.equal(CHARS_PER_TOKEN, 3.5);
  assert.equal(estimateTokens('a'.repeat(350)), 100);
  assert.equal(estimateTokens('会议记录'), 4);
  assert.equal(estimateTokens(''), 0);
});

test('the budget: the setting when the context is unknown, the context less instructions and reply when known, never above the setting', () => {
  assert.equal(fitBudget({ setting: 24000, contextTokens: null, systemTokens: 1000, replyTokens: 4096 }), 24000, 'unknown: as today');
  const small = fitBudget({ setting: 24000, contextTokens: 4096, systemTokens: 1000, replyTokens: 4096 });
  assert.ok(small < 24000 && small > 2000, `a 4k context gets a smaller budget (${small})`);
  assert.ok(estimateTokens('x'.repeat(small)) + 1000 + 1024 <= 4096, 'material, instructions and a quarter of the context for the reply fit');
  assert.equal(fitBudget({ setting: 24000, contextTokens: 131072, systemTokens: 1000, replyTokens: 4096 }), 24000, 'a large context does not raise the cap');
  assert.equal(fitBudget({ setting: 24000, contextTokens: 1024, systemTokens: 1000, replyTokens: 4096 }), 2000, 'never below a floor');
});

// An Ollama-like server: /api/ps lists the loaded models, /api/show a model's parameters.
async function ollamaLike(t, { ps = null, show = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (o) => { if (!o) { res.writeHead(404); return res.end(); } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/api/ps') return send(ps);
    if (req.url === '/api/show') return send(show);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, hits };
}

test("Ollama: the loaded model's context from /api/ps, cached", async (t) => {
  const s = await ollamaLike(t, { ps: { models: [{ name: 'other:1b', context_length: 2048 }, { name: 'qwen3:8b', model: 'qwen3:8b', context_length: 8192 }] } });
  const c = new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'qwen3:8b' }));
  assert.equal(await c.contextLength(), 8192);
  assert.equal(await c.contextLength(), 8192);
  assert.equal(s.hits.length, 1, 'asked once');
});

test("Ollama: a model that is not loaded falls back to a num_ctx in its parameters, else unknown", async (t) => {
  const s = await ollamaLike(t, { ps: { models: [] }, show: { parameters: 'temperature 0.7\nnum_ctx                        16384\nstop "<|im_end|>"' } });
  assert.equal(await new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'llama3.2' })).contextLength(), 16384);
  const s2 = await ollamaLike(t, { ps: { models: [] }, show: { parameters: 'temperature 0.7', model_info: { 'llama.context_length': 131072 } } });
  assert.equal(await new LlmClient(() => ({ provider: 'ollama', baseUrl: s2.url, model: 'llama3.2' })).contextLength(), null, "the model's trained maximum is not what Ollama runs it with");
});

test('not Ollama, or Ollama failing: unknown, without breaking anything', async (t) => {
  const s = await ollamaLike(t);
  assert.equal(await new LlmClient(() => ({ provider: 'openai', baseUrl: s.url, model: 'gpt' })).contextLength(), null);
  assert.equal(s.hits.length, 0, 'another kind of server is not probed');
  assert.equal(await new LlmClient(() => ({ provider: 'ollama', baseUrl: s.url, model: 'm' })).contextLength(), null, '404s: unknown');
  assert.equal(await new LlmClient(() => ({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' })).contextLength(), null, 'unreachable: unknown');
  assert.equal(await new LlmScheduler(new LlmClient(() => ({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }))).client('chat').contextLength(), null, 'through the queue too');
});

test('the notes of a meeting are written in parts when the Ollama context is small, in one go when it is unknown', async (t) => {
  const { open } = require('../src/core/db');
  const { Bus } = require('../src/core/events');
  const { Notes } = require('../src/core/notes');
  const { Settings } = require('../src/core/settings');
  const { Templates } = require('../src/core/templates');
  const { AiService } = require('../src/llm/service');
  let ctx = 4096;
  const asked = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/api/ps') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ models: ctx ? [{ name: 'm', context_length: ctx }] : [] })); }
      if (req.url === '/v1/chat/completions') {
        asked.push(JSON.parse(raw));
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '- point' } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  await settings.init();
  settings.update({ llm: { ...settings.get('llm'), provider: 'ollama', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'm' } });
  const ai = new AiService({ notes, templates: new Templates(db), settings, llm: new LlmClient(() => settings.get('llm')), bus });
  const note = notes.create({ title: 'Long call' });
  notes.addSegments(note.id, Array.from({ length: 120 }, (_, i) => ({ speaker: i % 2 ? 'me' : 'them', text: `Line ${i}: we went through the budget, the hiring plan and the launch date once more.`, startMs: i * 5000, endMs: i * 5000 + 4000 })));
  await ai.summarize(note.id);
  assert.ok(asked.length > 2, `a 4k context: parts first, then the notes (${asked.length} requests)`);
  const longest = Math.max(...asked.map((b) => b.messages.map((m) => m.content).join('').length));
  assert.ok(longest / 3.5 < 4096, 'every prompt fits the context');
  asked.length = 0;
  ctx = 0;
  ai.llm.ctxCache.clear();
  await ai.summarize(note.id);
  assert.equal(asked.length, 1, 'context unknown: the setting (24000 characters) holds, as before');
});
