'use strict';
// Reading JSON out of a model's reply: chatter and code fences around it, a broken first try followed by a good one, and a reply cut
// off by the token cap (whole array elements before the cut are kept, and the caller is told it was cut).
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);
const assert = require('node:assert/strict');
const { extractJson, parseJsonReply } = require('../src/llm/insights');
const { extractAssertions } = require('../src/brain/extract');
const { LlmClient } = require('../src/llm/client');

test('the first object that parses wins, not just the first "{"', () => {
  assert.deepEqual(extractJson('Sure {not json} here: ```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a": 1,}'), { a: 1 }, 'a trailing comma is forgiven');
  assert.deepEqual(extractJson('no braces'), null);
  assert.deepEqual(extractJson('the list: [1, 2]'), [1, 2], 'an array when there is no object');
  assert.deepEqual(extractJson('see [1] and {"n": 2}'), { n: 2 }, 'an object is preferred over a citation-like [1]');
});

test('a reply cut off mid-array keeps the complete elements before the cut, and says it was cut', () => {
  const cut = '{"items":[{"kind":"decision","quote":"we drop it"},{"kind":"commitment","quote":"I will se';
  assert.deepEqual(parseJsonReply(cut), { value: { items: [{ kind: 'decision', quote: 'we drop it' }] }, truncated: true });
  assert.deepEqual(parseJsonReply('{"scores":[{"n":1,"score":7},{"n":2,"sc'), { value: { scores: [{ n: 1, score: 7 }] }, truncated: true });
  assert.deepEqual(parseJsonReply('{"a": ["x", "y", "z'), { value: { a: ['x', 'y'] }, truncated: true });
  assert.deepEqual(parseJsonReply('{"a": 1}'), { value: { a: 1 }, truncated: false });
  assert.deepEqual(parseJsonReply('{"summary": "half a sen'), { value: null, truncated: true }, 'nothing complete to keep');
});

test('a long reply full of braces is read in bounded time', () => {
  const t0 = Date.now();
  extractJson('{'.repeat(20000));
  extractJson('{"a":'.repeat(5000));
  assert.ok(Date.now() - t0 < 1000);
});

test("the client reports the finish reason, so 'length' (the reply hit its cap) can be told apart", async () => {
  const enc = (o) => new TextEncoder().encode(`data: ${JSON.stringify(o)}\n\n`);
  const fetchImpl = async () => ({ ok: true, body: (async function* () { yield enc({ choices: [{ delta: { content: '{"items":[' } }] }); yield enc({ choices: [{ delta: {}, finish_reason: 'length' }] }); yield new TextEncoder().encode('data: [DONE]\n\n'); })() });
  let finish = null;
  await new LlmClient(() => ({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }), { fetchImpl }).complete([], { onFinish: (r) => { finish = r; } });
  assert.equal(finish, 'length');
});

test('extraction counts windows cut off by the token cap apart from findings without proof', async () => {
  const segs = [{ id: 1, speaker: 'them', text: 'We will drop the free tier from January.', startMs: 0 }, { id: 2, speaker: 'me', text: 'I will send the pricing sheet by Friday.', startMs: 1000 }];
  const llm = {
    getConfig: () => ({ model: 'm' }),
    async complete(messages, opts) {
      opts.onFinish?.('length');
      return '{"items":[{"kind":"decision","text":"Drop the free tier","quote":"We will drop the free tier from January","line":"L1"},{"kind":"commitment","text":"Invented","quote":"nobody said th';
    },
  };
  const added = [];
  const r = await extractAssertions({ notes: { get: () => ({ id: 'n', createdAt: Date.now() }), segments: () => segs }, knowledge: { label: (s) => s.speaker }, llm, assertions: { add: (a) => { added.push(a); return { created: true }; } }, settings: { get: () => '' } }, 'n');
  assert.equal(r.added, 1, 'the complete finding before the cut is kept');
  assert.equal(r.truncated, 1);
  assert.equal(r.dropped, 0, 'a cut-off reply is not counted as findings without proof');
  assert.equal(added[0].text, 'Drop the free tier');
});
