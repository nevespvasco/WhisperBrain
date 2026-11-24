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

async function boot(t) {
  const dataDir = tmpDir('wb-names-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = async (method, p, body) => { const r = await call(method, p, body); const j = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(j?.error || r.status), { status: r.status }); return j; };
  return { app, json, call };
}

const LINES = [
  ['me', 'm1', 'Good morning everyone, shall we start with the budget'],
  ['them', 's1', 'Sure, I am Maria and I run the data team'],
  ['them', 's2', 'And I can cover the hiring plan today'],
  ['me', 'm1', 'Thanks Maria, go ahead with the numbers'],
];
function meeting(app) {
  const n = app.notes.create({ title: 'Call' });
  for (const [id, ch] of [['m1', 'mic'], ['s1', 'system'], ['s2', 'system']]) app.speakers.save(n.id, { speakerId: id, channel: ch, centroid: new Float32Array(8).fill(id === 's1' ? 1 : 0.2), count: 3 });
  app.notes.addSegments(n.id, LINES.map(([speaker, speakerId, text], i) => ({ speaker, speakerId, text, startMs: i * 4000, endMs: i * 4000 + 3000, channel: speaker === 'me' ? 'mic' : 'system' })));
  return n;
}
const REPLY = JSON.stringify({ speakers: [{ speaker: 'S1', name: 'Maria', evidence: 'L2' }] });
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('API: guess the names from the conversation, see the line that shows each, turn one down', async (t) => {
  const s = await boot(t);
  const llm = await startFakeLlm(() => REPLY);
  t.after(() => llm.close());
  await s.json('PUT', '/api/settings', { llm: { ...s.app.settings.get('llm'), baseUrl: llm.url, model: 'fake-model' } });
  const n = meeting(s.app);

  const r = await s.json('POST', `/api/notes/${n.id}/speakers/guess-names`);
  assert.deepEqual(r.named.map((x) => [x.speakerId, x.name]), [['s1', 'Maria']]);
  const list = await s.json('GET', `/api/notes/${n.id}/speakers`);
  const maria = list.find((x) => x.speakerId === 's1');
  assert.equal(maria.label, 'Maria');
  assert.equal(maria.nameSource, 'transcript:llm');
  assert.match(maria.evidenceQuote, /I am Maria/);
  assert.equal(maria.evidenceMs, 4000);
  assert.equal(list.find((x) => x.speakerId === 's2').evidenceQuote, undefined);
  assert.equal(s.app.speakers.publicVoices().length, 0, 'no voice was saved');

  await s.json('POST', `/api/notes/${n.id}/speakers/s1/reject-name`);
  assert.equal((await s.json('GET', `/api/notes/${n.id}/speakers`)).find((x) => x.speakerId === 's1').nameSource, '');
  const again = await s.json('POST', `/api/notes/${n.id}/speakers/guess-names`);
  assert.deepEqual(again.named, [], 'the name that was turned down is not offered again');
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/speakers/s2/reject-name`), (e) => e.status === 409, 'there is no guess to turn down');
  await assert.rejects(s.json('POST', '/api/notes/nope/speakers/guess-names'), (e) => e.status === 404);
});

test('API: confirming a guessed name makes it the user\'s: it has no "guess" mark any more', async (t) => {
  const s = await boot(t);
  const llm = await startFakeLlm(() => REPLY);
  t.after(() => llm.close());
  await s.json('PUT', '/api/settings', { llm: { ...s.app.settings.get('llm'), baseUrl: llm.url, model: 'fake-model' } });
  const n = meeting(s.app);
  await s.json('POST', `/api/notes/${n.id}/speakers/guess-names`);
  await s.json('PATCH', `/api/notes/${n.id}/speakers/s1`, { name: 'Maria' });
  const maria = (await s.json('GET', `/api/notes/${n.id}/speakers`)).find((x) => x.speakerId === 's1');
  assert.equal(maria.nameSource, 'user');
  assert.equal(maria.evidenceQuote, undefined);
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/speakers/s1/reject-name`), (e) => e.status === 409, 'a name the user gave cannot be "turned down" as a guess');
});

test('API: without an AI server the button says so, and nothing is sent', async (t) => {
  const s = await boot(t);
  await s.json('PUT', '/api/settings', { llm: { ...s.app.settings.get('llm'), baseUrl: '' } });
  const n = meeting(s.app);
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/speakers/guess-names`), (e) => e.status === 409 && /AI/.test(e.message));
});

test('after a recording the voices are named by themselves only when asked: auto = a server on this computer, on = always, off = never', async (t) => {
  const s = await boot(t);
  const llm = await startFakeLlm(() => REPLY);
  t.after(() => llm.close());
  const local = { ...s.app.settings.get('llm'), baseUrl: llm.url, model: 'fake-model' };
  const stopped = (id) => s.app.bus.publish('recording.stopped', { noteId: id, durationMs: 1000 });
  const nameOf = (id) => s.app.speakers.forNote(id).find((x) => x.speakerId === 's1').name;
  let asked = 0;
  const real = s.app.llm.complete.bind(s.app.llm);
  s.app.llm.complete = async (...a) => { asked++; return real(...a); };

  assert.equal(s.app.settings.get('speakerNamesFromTranscript'), 'auto', 'the default');
  await s.json('PUT', '/api/settings', { llm: local });
  const a = meeting(s.app); stopped(a.id);
  await until(() => nameOf(a.id) === 'Maria');
  assert.equal(asked, 1, 'a server on this computer: asked');

  await s.json('PUT', '/api/settings', { llm: { ...local, baseUrl: 'https://llm.example.com/v1' } });
  const b = meeting(s.app); stopped(b.id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(asked, 1, 'a server elsewhere: the transcript is not sent unasked');
  assert.equal(nameOf(b.id), '');

  await s.json('PUT', '/api/settings', { speakerNamesFromTranscript: 'off', llm: local });
  const c = meeting(s.app); stopped(c.id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(asked, 1, 'off: never');

  await s.json('PUT', '/api/settings', { speakerNamesFromTranscript: 'on' });
  const d = meeting(s.app); stopped(d.id);
  await until(() => nameOf(d.id) === 'Maria');
  assert.equal(asked, 2);
  await assert.rejects(s.json('PUT', '/api/settings', { speakerNamesFromTranscript: 'sometimes' }));
});
