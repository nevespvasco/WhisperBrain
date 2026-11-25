'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { startFakeLlm } = require('./fake-llm');
const { tmpDir, ROOT } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});

async function boot(t, reply = () => 'They said Friday.') {
  const dataDir = tmpDir('wb-as-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  const llm = await startFakeLlm(reply);
  t.after(async () => { await srv.close(); app.close(); await llm.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = async (method, p, body) => { const r = await call(method, p, body); const j = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(j?.error || r.status), { status: r.status }); return j; };
  await app.ready;
  await json('PUT', '/api/settings', { llm: { baseUrl: llm.url, model: 'fake-model' } });
  return { app, json, call, llm, port, token };
}

test('the assistant settings are part of the settings API, off by default', async (t) => {
  const { json } = await boot(t);
  const s = await json('GET', '/api/settings');
  assert.equal(s.assistant.enabled, false);
  const after = await json('PUT', '/api/settings', { assistant: { enabled: true, mode: 'interview' } });
  assert.equal(after.assistant.mode, 'interview');
  await assert.rejects(json('PUT', '/api/settings', { assistant: { mode: 'stealth' } }), { status: 400 });
});

test('state and toggle: per meeting, and actions need a recording', async (t) => {
  const { app, json } = await boot(t);
  const n = app.notes.create({ title: 'Call' });
  let st = await json('GET', `/api/assistant/state?noteId=${n.id}`);
  assert.equal(st.enabled, false);
  st = await json('POST', '/api/assistant/toggle', { noteId: n.id, enabled: true });
  assert.equal(st.enabled, true);
  await assert.rejects(json('POST', '/api/assistant/action', { noteId: n.id, action: 'answer' }), { status: 409 });
  await assert.rejects(json('GET', '/api/assistant/state?noteId=nope'), { status: 404 });
});

test('ask about a meeting streams the answer over SSE and the history lists it', async (t) => {
  const { app, call, json } = await boot(t);
  const n = app.notes.create({ title: 'Call' });
  app.notes.addSegments(n.id, [{ speaker: 'them', startMs: 0, endMs: 1000, text: 'The deadline is Friday.' }]);
  const res = await call('POST', '/api/assistant/ask', { noteId: n.id, question: 'What deadline?' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /event: delta/);
  assert.match(body, /event: done/);
  assert.match(body, /They said Friday\./);
  const hist = await json('GET', `/api/notes/${n.id}/assistant`);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].kind, 'ask');
  await json('DELETE', `/api/notes/${n.id}/assistant`);
  assert.equal((await json('GET', `/api/notes/${n.id}/assistant`)).length, 0);
});

test('a screenshot question: the picture goes to the AI as an image part and the answer comes back', async (t) => {
  const { app, llm, port, token } = await boot(t, () => 'Q: What is 2+2?\n- 4');
  app.settings.update({ assistant: { enabled: true } });
  const n = app.notes.create({ title: 'Call' });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const res = await fetch(`http://127.0.0.1:${port}/api/assistant/screenshot?noteId=${n.id}`, { method: 'POST', headers: { Cookie: `wb_token=${token}`, 'Content-Type': 'image/jpeg' }, body: jpeg });
  assert.equal(res.status, 200);
  assert.match((await res.json()).text, /- 4/);
  const parts = llm.requests.at(-1).messages[1].content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts[1].type, 'image_url');
  assert.match(parts[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(app.assistant.history(n.id).at(-1).question, '(question on screen)');
});
