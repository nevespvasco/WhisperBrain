'use strict';
// The client's own time limits: a server that stops sending (a stuck Ollama, a dropped tunnel) must not hold the one AI slot until
// undici's 300 s defaults run out. Short injected limits keep these tests fast.
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);
const assert = require('node:assert/strict');
const { LlmClient, IDLE_MS, FIRST_BYTE_MS } = require('../src/llm/client');

const sse = (delta) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const abortable = (signal) => new Promise((_, reject) => {
  const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
  if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
});

// fetchImpl whose response streams `script`: an array of chunks (Uint8Array) and pauses ({ wait: ms }), then stalls forever
// (until aborted) when `stall` is set, else ends.
function fakeFetch(script, { stall = false, noHeaders = false } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.signal);
    if (noHeaders) return abortable(init.signal);
    return {
      ok: true,
      body: (async function* () {
        for (const step of script) {
          if (step.wait) await Promise.race([wait(step.wait), abortable(init.signal)]);
          else yield step;
        }
        if (stall) await abortable(init.signal);
        yield new TextEncoder().encode('data: [DONE]\n\n');
      })(),
    };
  };
  return { fetchImpl, seen };
}
const client = (fetchImpl) => new LlmClient(() => ({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }), { fetchImpl });
const msg = [{ role: 'user', content: 'hi' }];

test('the defaults: a minute without a byte once streaming, longer for the first byte (a model loading, a long prompt read)', () => {
  assert.equal(IDLE_MS, 60_000);
  assert.ok(FIRST_BYTE_MS >= 120_000);
});

test('a reply that stops arriving mid-stream fails with a clear timeout error, and the fetch is aborted', async () => {
  const f = fakeFetch([sse({ content: 'Hello' })], { stall: true });
  const t0 = Date.now();
  await assert.rejects(client(f.fetchImpl).complete(msg, { idleMs: 60 }), (e) => e.code === 'timeout' && /stopped sending|nothing/i.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(f.seen[0].aborted, true);
});

test('a server that never answers fails after firstByteMs', async () => {
  const f = fakeFetch([], { noHeaders: true });
  await assert.rejects(client(f.fetchImpl).complete(msg, { idleMs: 20, firstByteMs: 80 }), { code: 'timeout' });
  assert.equal(f.seen[0].aborted, true);
});

test('a slow but steady reply is not cut: every chunk, reasoning included, resets the idle limit', async () => {
  const steps = [];
  for (let i = 0; i < 5; i++) steps.push({ wait: 30 }, sse({ reasoning: 'hmm ' }));
  for (let i = 0; i < 3; i++) steps.push({ wait: 30 }, sse({ content: `w${i} ` }));
  const f = fakeFetch(steps);
  let progress = 0;
  const out = await client(f.fetchImpl).complete(msg, { idleMs: 70, onProgress: () => { progress++; } });
  assert.equal(out, 'w0 w1 w2');
  assert.ok(progress >= 8, `onProgress called for reasoning and content (${progress})`);
});

test("the caller's abort still ends the request as an AbortError, not as a timeout", async () => {
  const f = fakeFetch([sse({ content: 'Hello' })], { stall: true });
  const ac = new AbortController();
  const p = client(f.fetchImpl).complete(msg, { signal: ac.signal, idleMs: 5000 });
  await wait(20);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(f.seen[0].aborted, true);
});

test('a slow consumer does not count as an idle server', async () => {
  const f = fakeFetch([sse({ content: 'a' }), sse({ content: 'b' })]);
  let out = '';
  for await (const d of client(f.fetchImpl).stream(msg, { idleMs: 40 })) { out += d; await wait(90); }
  assert.equal(out, 'ab');
});

test('onStart is called once the request is under way', async () => {
  const f = fakeFetch([sse({ content: 'x' })]);
  let started = 0;
  assert.equal(await client(f.fetchImpl).complete(msg, { onStart: () => { started++; } }), 'x');
  assert.equal(started, 1);
});
