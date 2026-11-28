'use strict';
// Short, structured or latency-sensitive AI calls ask the server not to think first (reasoning 'off': Ollama's reasoning_effort none).
// With qwen3 or deepseek, thinking ate the reply cap: extraction windows were dropped and the meeting window was never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAssertions } = require('../src/brain/extract');
const { narrate } = require('../src/brain/brief');
const { Translator } = require('../src/llm/translate');
const { VisionSource } = require('../src/meet/vision');
const { SignalHub } = require('../src/meet/hub');

// An LLM stand-in that records the options of every call and answers with reply().
function stub(reply) {
  const calls = [];
  return { calls, getConfig: () => ({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' }), async complete(messages, opts) { calls.push(opts); return reply(messages); } };
}

test("extraction of decisions and commitments asks for no thinking", async () => {
  const llm = stub(() => '{"items":[]}');
  const segs = [{ id: 1, speaker: 'them', text: 'We will drop the free tier.', startMs: 0 }, { id: 2, speaker: 'me', text: 'Agreed, from January.', startMs: 1000 }];
  await extractAssertions({ notes: { get: () => ({ id: 'n' }), segments: () => segs }, knowledge: { label: (s) => s.speaker }, llm, assertions: { add: () => ({}) }, settings: { get: () => '' } }, 'n');
  assert.equal(llm.calls[0].reasoning, 'off');
});

test('the brief narration asks for no thinking', async () => {
  const llm = stub(() => 'You decided to drop the free tier [1].');
  const brief = { people: [], owe: [], waiting: [], decisions: [{ text: 'Drop the free tier', source: { noteId: 'n' }, segmentId: 1 }], mail: [], related: [] };
  assert.ok(await narrate(llm, brief));
  assert.equal(llm.calls[0].reasoning, 'off');
});

test('a translation batch asks for no thinking', async () => {
  const llm = stub(() => '[1] Olá');
  const t = new Translator({ notes: { db: null }, settings: { get: () => ({}) }, llm, bus: null });
  await t.ask([{ id: 1, text: 'Hello' }], 'pt', [], undefined);
  assert.equal(llm.calls[0].reasoning, 'off');
});

test('reading the meeting window asks for no thinking, and is live work for the meeting in progress', async () => {
  const llm = stub(() => '{"participants":["Ana"],"speaking":[],"confidence":"low"}');
  const v = new VisionSource({ hub: new SignalHub(), llm, capture: async () => ({ jpeg: Buffer.from('x'), title: 'Meet' }), userName: () => 'V', intervalMs: 3600000 });
  v.timer = {};
  await v.tick();
  assert.equal(llm.calls[0].reasoning, 'off');
  assert.equal(llm.calls[0].live, true, 'runs while the assistant holds background work');
});
