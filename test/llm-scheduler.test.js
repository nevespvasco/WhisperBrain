'use strict';
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);   // a scheduler bug shows as a hang: fail fast
const assert = require('node:assert/strict');
const { LlmScheduler, PRIORITIES } = require('../src/llm/scheduler');
const { LlmClient } = require('../src/llm/client');
const { startFakeLlm } = require('./fake-llm');

// A job whose finish the test controls.
function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}
const tick = () => new Promise((r) => setImmediate(r));
const fakeLlm = (baseUrl = 'http://127.0.0.1:11434/v1') => ({ getConfig: () => ({ baseUrl }) });

test('PRIORITIES lists assistant first and background last', () => {
  assert.deepEqual(PRIORITIES, ['assistant', 'chat', 'summary', 'translation', 'background']);
});

test('with concurrency 1, queued jobs run by priority, FIFO within a priority', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 1 });
  const order = [];
  const first = gate();
  const blocker = s.run('background', async () => { order.push('blocker'); await first.promise; });
  await tick();
  const jobs = [
    s.run('background', async () => { order.push('bg1'); }),
    s.run('translation', async () => { order.push('tr'); }),
    s.run('chat', async () => { order.push('chat1'); }),
    s.run('assistant', async () => { order.push('assistant'); }),
    s.run('chat', async () => { order.push('chat2'); }),
    s.run('background', async () => { order.push('bg2'); }),
  ];
  first.open();
  await Promise.all([blocker, ...jobs]);
  assert.deepEqual(order, ['blocker', 'assistant', 'chat1', 'chat2', 'tr', 'bg1', 'bg2']);
});

test('with concurrency 2, two jobs run at once and the third waits for a free slot', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 2 });
  const gates = [gate(), gate(), gate()];
  const started = [];
  const jobs = gates.map((g, i) => s.run('summary', async () => { started.push(i); await g.promise; return i; }));
  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(s.stats(), { running: 2, queued: { assistant: 0, chat: 0, summary: 1, translation: 0, background: 0 } });
  gates[1].open();
  await tick(); await tick();
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(s.stats().running, 2);
  gates[0].open(); gates[2].open();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.deepEqual(s.stats(), { running: 0, queued: { assistant: 0, chat: 0, summary: 0, translation: 0, background: 0 } });
});

test('concurrency may be a function, read each time a slot is considered', async () => {
  let limit = 1;
  const s = new LlmScheduler(fakeLlm(), { concurrency: () => limit });
  const gates = [gate(), gate()];
  const started = [];
  const jobs = gates.map((g, i) => s.run('chat', async () => { started.push(i); await g.promise; }));
  await tick();
  assert.deepEqual(started, [0]);
  limit = 2;
  const third = s.run('chat', async () => { started.push(2); });   // the next run() sees the new limit
  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.equal(s.stats().queued.chat, 1);
  gates.forEach((g) => g.open());
  await Promise.all([...jobs, third]);
});

async function runningAtOnce(s) {
  const gates = [gate(), gate(), gate()];
  const jobs = gates.map((g) => s.run('chat', () => g.promise));
  await tick();
  const n = s.stats().running;
  gates.forEach((g) => g.open());
  await Promise.all(jobs);
  return n;
}

test('default concurrency is 1 for a server on this computer and 2 for a remote one, following the setting', async () => {
  let baseUrl = 'http://localhost:11434/v1';
  const s = new LlmScheduler({ getConfig: () => ({ baseUrl }) });
  assert.equal(await runningAtOnce(s), 1);
  baseUrl = 'https://api.openai.com/v1';
  assert.equal(await runningAtOnce(s), 2);
  baseUrl = 'http://192.168.1.20:8080/v1';
  assert.equal(await runningAtOnce(s), 1);
});

test('aborting a queued job removes it from the queue and rejects with AbortError; it never runs', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 1 });
  const g = gate();
  const blocker = s.run('chat', () => g.promise);
  const ac = new AbortController();
  let ran = false;
  const queued = s.run('summary', async () => { ran = true; }, { signal: ac.signal });
  await tick();
  assert.equal(s.stats().queued.summary, 1);
  ac.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(s.stats().queued.summary, 0);
  g.open();
  await blocker;
  await tick();
  assert.equal(ran, false);
});

test('a job whose signal is already aborted is rejected without running', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 1 });
  let ran = false;
  await assert.rejects(s.run('chat', async () => { ran = true; }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(ran, false);
  assert.equal(s.stats().running, 0);
});

test('aborting a running job forwards the abort to the signal handed to fn, and frees the slot', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 1 });
  const ac = new AbortController();
  let seen;
  const running = s.run('chat', (signal) => new Promise((_, reject) => {
    seen = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { signal: ac.signal });
  const next = s.run('background', async () => 'next ran');
  await tick();
  assert.equal(seen.aborted, false);
  ac.abort();
  assert.equal(seen.aborted, true);
  await assert.rejects(running);
  assert.equal(await next, 'next ran');
});

test('a job with a key replaces a queued job with the same key, which is rejected as replaced', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 1 });
  const g = gate();
  const blocker = s.run('chat', () => g.promise);
  const ran = [];
  const old = s.run('translation', async () => { ran.push('old'); }, { key: 'note-1' });
  const other = s.run('translation', async () => { ran.push('other'); }, { key: 'note-2' });
  const fresh = s.run('translation', async () => { ran.push('fresh'); return 'fresh'; }, { key: 'note-1' });
  await assert.rejects(old, { name: 'AbortError', code: 'replaced' });
  assert.equal(s.stats().queued.translation, 2);
  g.open();
  await blocker;
  assert.equal(await fresh, 'fresh');
  await other;
  assert.deepEqual(ran, ['other', 'fresh']);
});

test('no starvation of running jobs: a key never pre-empts the running job with the same key', async () => {
  const s = new LlmScheduler(fakeLlm(), { concurrency: 1 });
  const g = gate();
  let seen;
  const running = s.run('background', (signal) => { seen = signal; return g.promise.then(() => 'first done'); }, { key: 'k' });
  await tick();
  const second = s.run('assistant', async () => 'second done', { key: 'k' });
  await tick();
  assert.equal(seen.aborted, false);
  assert.deepEqual(s.stats(), { running: 1, queued: { assistant: 1, chat: 0, summary: 0, translation: 0, background: 0 } });
  g.open();
  assert.equal(await running, 'first done');
  assert.equal(await second, 'second done');
});

// An LlmClient stand-in whose stream yields the given chunks and records how it ended.
function streamingLlm(chunks) {
  const calls = [];
  return {
    calls,
    getConfig: () => ({ baseUrl: 'http://127.0.0.1:1/v1' }),
    async *stream(messages, opts) {
      const call = { messages, opts, closed: false };
      calls.push(call);
      try { for (const c of chunks) { await tick(); yield c; } } finally { call.closed = true; }
    },
  };
}

test('client(priority).stream occupies one slot until the stream is fully consumed', async () => {
  const llm = streamingLlm(['a', 'b', 'c']);
  const s = new LlmScheduler(llm, { concurrency: 1 });
  const it = s.client('summary').stream([{ role: 'user', content: 'hi' }], { temperature: 0.2 });
  assert.deepEqual(await it.next(), { value: 'a', done: false });
  let otherRan = false;
  const other = s.run('assistant', async () => { otherRan = true; });
  await tick();
  assert.equal(otherRan, false);
  assert.equal(s.stats().running, 1);
  assert.equal((await it.next()).value, 'b');
  assert.equal((await it.next()).value, 'c');
  assert.equal((await it.next()).done, true);
  await other;
  assert.equal(otherRan, true);
  assert.equal(llm.calls[0].opts.temperature, 0.2);
  assert.ok(llm.calls[0].opts.signal instanceof AbortSignal);
});

test('breaking out of a client stream early closes the underlying stream and releases the slot', async () => {
  const llm = streamingLlm(['a', 'b', 'c']);
  const s = new LlmScheduler(llm, { concurrency: 1 });
  for await (const chunk of s.client('chat').stream([])) { assert.equal(chunk, 'a'); break; }
  assert.equal(llm.calls[0].closed, true);
  assert.equal(s.stats().running, 0);
  assert.equal(await s.run('chat', async () => 'free'), 'free');
});

test('a client stream waiting for a slot can be cancelled or replaced through opts.signal and opts.key', async () => {
  const llm = streamingLlm(['x']);
  const s = new LlmScheduler(llm, { concurrency: 1 });
  const g = gate();
  const blocker = s.run('chat', () => g.promise);
  const ac = new AbortController();
  const cancelled = s.client('translation').stream([], { signal: ac.signal }).next();
  const replaced = assert.rejects(s.client('translation').stream([], { key: 'seg' }).next(), { name: 'AbortError', code: 'replaced' });
  const winner = s.client('translation').stream([], { key: 'seg' }).next();
  await tick();
  ac.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await replaced;
  g.open();
  await blocker;
  assert.deepEqual(await winner, { value: 'x', done: false });
  assert.equal(llm.calls.length, 1);
});

test('client(priority).complete runs against an OpenAI-compatible server, and the passthroughs reach the client', async (t) => {
  const srv = await startFakeLlm((messages) => `echo: ${messages.at(-1).content}`, { models: ['m1', 'm2'] });
  t.after(() => srv.close());
  const cfg = { baseUrl: srv.url, model: '' };
  const s = new LlmScheduler(new LlmClient(() => cfg));
  const chat = s.client('chat');
  assert.equal(await chat.complete([{ role: 'user', content: 'hello' }], { temperature: 0, maxTokens: 50 }), 'echo: hello');
  assert.equal(srv.requests[0].temperature, 0);
  assert.equal(srv.requests[0].max_tokens, 50);
  assert.deepEqual(await chat.listModels(), ['m1', 'm2']);
  assert.equal(await chat.resolveModel(cfg), 'm1');
  assert.equal(chat.getConfig(), cfg);
  const probe = await chat.test();
  assert.equal(probe.ok, true);
  assert.equal(probe.model, 'm1');
  assert.equal(s.stats().running, 0);
});

test('aborting a running client request aborts its fetch, and the next queued request then runs', async () => {
  const fetched = [];
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    fetched.push(init.signal);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const s = new LlmScheduler(new LlmClient(() => ({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }), { fetchImpl }), { concurrency: 1 });
  const ac = new AbortController();
  const first = s.client('summary').complete([{ role: 'user', content: 'a' }], { signal: ac.signal });
  const ac2 = new AbortController();
  const second = s.client('background').complete([{ role: 'user', content: 'b' }], { signal: ac2.signal });
  await tick();
  assert.equal(fetched.length, 1);
  ac.abort();
  assert.equal(fetched[0].aborted, true);
  await assert.rejects(first, { name: 'AbortError' });
  await tick();
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1].aborted, false);
  ac2.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(s.stats().running, 0);
});
