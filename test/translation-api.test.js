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

// A model for every prompt the app sends: lines come back tagged with the language, a summary too, a meeting summary says what it was told
const summarizeSystems = [];
function respond(messages) {
  const sys = messages[0].content, user = messages[1]?.content || '';
  const lines = /You translate meeting transcript lines into (.+?)\./.exec(sys);
  if (lines) return JSON.stringify(Object.fromEntries([...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(([, n, t]) => [n, `${lines[1]}: ${t}`])));
  const notes = /You translate meeting notes written in Markdown into (.+?)\./.exec(sys);
  if (notes) return `${notes[1]}: ${/<enhanced_notes>\n([\s\S]*)\n<\/enhanced_notes>/.exec(user)[1]}`;
  if (sys.startsWith('You turn a meeting')) { summarizeSystems.push(sys); return '## Notes\n- agreed'; }
  return 'A title';
}

async function boot(t) {
  const dataDir = tmpDir('wb-tr-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  const llm = await startFakeLlm(respond);
  t.after(async () => { await srv.close(); app.close(); await llm.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = async (method, p, body) => { const r = await call(method, p, body); const j = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(j?.error || r.status), { status: r.status }); return j; };
  const text = async (p) => { const r = await call('GET', p); if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status }); return r.text(); };
  await json('PUT', '/api/settings', { llm: { baseUrl: llm.url, model: 'fake-model' } });
  return { app, json, text, call };
}
const meeting = (app) => {
  const n = app.notes.create({ title: 'Reunião' });
  const segs = app.notes.addSegments(n.id, [
    { speaker: 'them', startMs: 0, endMs: 1000, text: 'Bom dia a todos' },
    { speaker: 'me', startMs: 2000, endMs: 3000, text: 'Vamos começar' },
  ]);
  return { n, segs };
};
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

test('API: translation is off until it is switched on, and asks for a known language', async (t) => {
  const s = await boot(t);
  const { n } = meeting(s.app);
  const langs = await s.json('GET', '/api/languages');
  assert.ok(langs.find((l) => l.code === 'pt-PT' && l.name === 'Portuguese (Portugal)' && l.native));
  assert.equal((await s.json('GET', '/api/settings')).translation.enabled, false, 'off by default');
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/translate`, { lang: 'en' }), (e) => e.status === 409 && /turned off/.test(e.message));
  await s.json('PUT', '/api/settings', { translation: { enabled: true, targets: ['en'] } });
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/translate`, { lang: 'klingon' }), (e) => e.status === 400);
  await assert.rejects(s.json('POST', '/api/notes/nope/translate', { lang: 'en' }), (e) => e.status === 404);
  await s.json('PUT', '/api/settings', { llm: { baseUrl: '' } });
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/translate`, { lang: 'en' }), (e) => e.status === 409 && /AI server/.test(e.message));
});

test('API: translate a meeting into a language, read it beside the original, list and remove it', async (t) => {
  const s = await boot(t);
  await s.json('PUT', '/api/settings', { translation: { enabled: true, targets: ['en', 'es'] } });
  const { n, segs } = meeting(s.app);
  const plain = await s.json('GET', `/api/notes/${n.id}/transcript`);
  assert.equal(plain[0].translation, undefined, 'without a language the transcript is as before');

  const started = await s.json('POST', `/api/notes/${n.id}/translate`, { lang: 'es' });
  assert.deepEqual([started.started, started.total], [true, 2]);
  await until(async () => (await s.json('GET', `/api/notes/${n.id}/translations`)).languages.some((l) => l.lang === 'es' && l.lines === 2));
  const info = await s.json('GET', `/api/notes/${n.id}/translations`);
  assert.deepEqual(info, { languages: [{ lang: 'es', lines: 2 }], running: [] });

  const both = await s.json('GET', `/api/notes/${n.id}/transcript?lang=es`);
  assert.deepEqual(both.map((x) => [x.id, x.text, x.translation]), [[segs[0].id, 'Bom dia a todos', 'Spanish: Bom dia a todos'], [segs[1].id, 'Vamos começar', 'Spanish: Vamos começar']]);
  assert.equal((await s.json('GET', `/api/notes/${n.id}/transcript?lang=en`))[0].translation, null, 'not translated into that language yet');
  assert.deepEqual(await s.json('POST', `/api/notes/${n.id}/translate`, { lang: 'es' }), { started: false, total: 0 }, 'nothing left to do');

  await s.json('DELETE', `/api/notes/${n.id}/translations/es`);
  assert.deepEqual((await s.json('GET', `/api/notes/${n.id}/translations`)).languages, []);
});

test('API: a summary in another language, kept while the summary stands; notes can be written in a chosen language', async (t) => {
  const s = await boot(t);
  const { n } = meeting(s.app);
  await s.json('PUT', '/api/settings', { translation: { enabled: true, targets: ['en'] } });
  assert.equal((await s.json('GET', `/api/notes/${n.id}/summary-translation?lang=en`)).text, null);
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/summary-translation`, { lang: 'en' }), (e) => e.status === 409, 'no summary to translate yet');
  s.app.notes.update(n.id, { summary: '## Notas\n- Aprovado' });
  const made = await s.json('POST', `/api/notes/${n.id}/summary-translation`, { lang: 'en' });
  assert.equal(made.text, 'English: ## Notas\n- Aprovado');
  assert.equal((await s.json('GET', `/api/notes/${n.id}/summary-translation?lang=en`)).text, made.text);
  s.app.notes.update(n.id, { summary: '## Notas\n- Recusado' });
  assert.equal((await s.json('GET', `/api/notes/${n.id}/summary-translation?lang=en`)).text, null, 'the summary changed');

  summarizeSystems.length = 0;
  await s.app.ai.summarize(n.id);
  assert.doesNotMatch(summarizeSystems.at(-1), /whatever language/, 'translation on, no language chosen: the meeting\'s own language, as before');
  await s.json('PUT', '/api/settings', { translation: { notesLanguage: 'es' } });
  await s.app.ai.summarize(n.id);
  assert.match(summarizeSystems.at(-1), /Write in Spanish, whatever language the meeting was held in/);
  await s.app.ai.summarize(n.id, { language: 'pt-PT' });
  assert.match(summarizeSystems.at(-1), /Write in Portuguese \(Portugal\)/, 'one run can ask for another language');
  await s.json('PUT', '/api/settings', { translation: { enabled: false } });
  await s.app.ai.summarize(n.id);
  assert.doesNotMatch(summarizeSystems.at(-1), /whatever language/, 'translation off: the chosen notes language is not used');
});

test('API: export with the translation: the translation alone, or the original and the translation together', async (t) => {
  const s = await boot(t);
  await s.json('PUT', '/api/settings', { translation: { enabled: true, targets: ['en'] } });
  const { n } = meeting(s.app);
  await s.json('POST', `/api/notes/${n.id}/translate`, { lang: 'en' });
  await until(async () => (await s.json('GET', `/api/notes/${n.id}/translations`)).languages.length === 1);
  const md = (q) => s.text(`/api/notes/${n.id}/export?format=md${q}`);
  const original = await md('');
  assert.match(original, /Bom dia a todos/);
  assert.doesNotMatch(original, /English:/);
  const only = await md('&lang=en&translation=translation');
  assert.match(only, /English: Bom dia a todos/);
  assert.doesNotMatch(only, /\] Bom dia a todos/, 'the translation replaces the words');
  const both = await md('&lang=en&translation=both');
  assert.match(both, /Bom dia a todos\nEnglish: Bom dia a todos/);
  const srt = await s.text(`/api/notes/${n.id}/export?format=srt&lang=en&translation=both`);
  assert.match(srt, /Bom dia a todos\nEnglish: Bom dia a todos/);
  await assert.rejects(md('&lang=xx&translation=both'), (e) => e.status === 400);
  await assert.rejects(md('&lang=en&translation=sideways'), (e) => e.status === 400);
  const q = await md('&translation=both');
  assert.doesNotMatch(q, /English:/, 'no language: nothing to add');
});

test('API: sending with a translation refuses a language or a mode that does not exist, as an export does', async (t) => {
  const s = await boot(t);
  const { n } = meeting(s.app);
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/send`, { target: 'obsidian', lang: 'xx', translation: 'both' }), (e) => e.status === 400);
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/send`, { target: 'obsidian', lang: 'en', translation: 'sideways' }), (e) => e.status === 400);
});
