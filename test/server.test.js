'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { wavToPcm16 } = require('../src/audio/pcm');
const { startFakeLlm } = require('./fake-llm');
const { testModels, tmpDir, fixture, ROOT } = require('./helpers');

const models = testModels();

// A platform whose capture is pushed over HTTP, like macOS/Windows.
const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return [{ id: 'm1', name: 'Mic 1', default: true }]; },
  createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; },
  async paste() { return { ok: false }; }, clipboard: null,
});

async function boot(t, { withModels = false } = {}) {
  const dataDir = tmpDir('wb-data-');
  const app = createApp({ dataDir, platform: fakePlatform(), modelsDir: withModels ? models.dir : undefined, version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: { Cookie: `wb_token=${token}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const json = async (method, p, body) => { const r = await call(method, p, body); const j = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(j?.error || r.status), { status: r.status, body: j }); return j; };
  const sse = async (p, body) => {
    const r = await call('POST', p, body);
    const out = [];
    const text = await r.text();
    for (const block of text.split('\n\n')) {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev) out.push({ event: ev, data: JSON.parse(data) });
    }
    return out;
  };
  return { app, srv, base, port, token, call, json, sse };
}

test('auth: token → cookie, wrong host / missing cookie / cross-origin refused', async (t) => {
  const s = await boot(t);
  assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
  assert.equal((await fetch(`${s.base}/?token=wrong`, { redirect: 'manual' })).status, 401);
  const r = await fetch(`${s.base}/?token=${s.token}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('set-cookie'), /wb_token=.*HttpOnly.*SameSite=Strict/);
  assert.equal((await fetch(`${s.base}/api/state`, { headers: { Authorization: `Bearer ${s.token}` } })).status, 200);
  const status = await new Promise((resolve) => {
    const req = require('node:http').request({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { Host: 'evil.example', Cookie: `wb_token=${s.token}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status, 403, 'DNS rebinding guard');
  assert.equal((await s.call('POST', '/api/notes', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.call('GET', '/%2e%2e/%2e%2e/etc/passwd')).status >= 400, true);
});

test('static UI is served with a CSP', async (t) => {
  const s = await boot(t);
  const r = await s.call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await r.text(), /<title>WhisperBrain/);
  assert.equal((await s.call('GET', '/app.js')).status, 200);
});

test('notes API: CRUD, search, folders, export', async (t) => {
  const s = await boot(t);
  const f = await s.json('POST', '/api/folders', { name: 'Clients' });
  const n = await s.json('POST', '/api/notes', { title: 'Acme call', body: 'pricing discussion', folderId: f.id });
  await s.json('PATCH', `/api/notes/${n.id}`, { pinned: true });
  assert.equal((await s.json('GET', `/api/notes/${n.id}`)).pinned, true);
  assert.equal((await s.json('GET', `/api/notes?folder=${f.id}`)).length, 1);
  const hits = await s.json('GET', '/api/notes?q=pricing');
  assert.equal(hits[0].id, n.id);
  assert.match(hits[0].snippet, /<mark>/);
  const md = await s.call('GET', `/api/notes/${n.id}/export`);
  assert.match(md.headers.get('content-disposition'), /attachment/);
  assert.match(await md.text(), /# Acme call/);
  await assert.rejects(s.json('GET', '/api/notes/nope'), (e) => e.status === 404);
  await s.json('DELETE', `/api/notes/${n.id}`);
  assert.equal((await s.json('GET', '/api/notes')).length, 0);
});

test('settings API validates and masks secrets', async (t) => {
  const s = await boot(t);
  const out = await s.json('PUT', '/api/settings', { llm: { apiKey: 'sk-1', model: 'x' }, language: 'pt' });
  assert.equal(out.llm.apiKey, '********');
  assert.equal(out.language, 'pt');
  assert.equal((await s.json('GET', '/api/settings')).llm.apiKey, '********');
  await assert.rejects(s.json('PUT', '/api/settings', { language: 'zz' }), (e) => e.status === 400);
});

test('summarize and chat stream over SSE and persist', async (t) => {
  const llm = await startFakeLlm((m) => (m[0].content.startsWith('You write short') ? 'Pricing talk' : '## Notes\n- pricing agreed'));
  t.after(llm.close);
  const s = await boot(t);
  await s.json('PUT', '/api/settings', { llm: { baseUrl: llm.url, model: 'm' } });
  const n = await s.json('POST', '/api/notes', { body: 'discussed pricing' });
  const ev = await s.sse(`/api/notes/${n.id}/summarize`, {});
  assert.ok(ev.filter((e) => e.event === 'delta').length > 1);
  assert.equal(ev.at(-1).event, 'done');
  assert.equal(ev.at(-1).data.summary, '## Notes\n- pricing agreed');
  assert.equal((await s.json('GET', `/api/notes/${n.id}`)).title, 'Pricing talk');
  const chat = await s.sse('/api/chat', { noteId: n.id, question: 'What was agreed?' });
  assert.equal(chat.at(-1).event, 'done');
  assert.equal((await s.json('GET', `/api/chat?noteId=${n.id}`)).length, 2);
  const bad = await s.sse('/api/chat', { noteId: n.id, question: '   ' });
  assert.equal(bad.at(-1).event, 'error');
  await s.json('PUT', '/api/settings', { llm: { baseUrl: 'http://127.0.0.1:1/v1' } });
  const down = await s.sse(`/api/notes/${n.id}/summarize`, {});
  assert.match(down.at(-1).data.message, /Cannot reach/);
});

test('recording without a model is refused with an actionable error', async (t) => {
  const s = await boot(t);
  await assert.rejects(s.json('POST', '/api/recording/start', {}), (e) => e.status === 412 && /model/i.test(e.message));
  assert.equal((await s.json('GET', '/api/notes')).length, 1, 'the draft note exists so nothing typed is lost');
});

const real = { skip: models ? false : 'no ASR model installed', timeout: 120000 };

test('end to end: UI-pushed audio → live events → stored transcript → search', real, async (t) => {
  const s = await boot(t, { withModels: true });
  const events = [];
  const ac = new AbortController();
  const es = await s.call('GET', '/api/events', undefined, {});
  (async () => { const dec = new TextDecoder(); for await (const c of es.body) { for (const m of dec.decode(c).matchAll(/^event: (.+)$/gm)) events.push(m[1]); } })().catch(() => {});
  t.after(() => ac.abort());

  const st = await s.json('POST', '/api/recording/start', { title: 'E2E', system: false });
  assert.deepEqual(st.needsRenderer, ['mic']);
  const pcm = wavToPcm16(fs.readFileSync(fixture('speech-0.wav')));
  for (let i = 0; i < pcm.length; i += 3200) {
    const r = await s.json('POST', `/api/recording/pcm?noteId=${st.noteId}&ch=mic`, pcm.subarray(i, i + 3200));
    assert.equal(r.ok, true);
  }
  await s.json('POST', `/api/recording/pcm?noteId=${st.noteId}&ch=mic`, Buffer.alloc(32000));
  const done = await s.json('POST', '/api/recording/stop');
  assert.equal(done.note.status, 'done');
  const segs = await s.json('GET', `/api/notes/${st.noteId}/transcript`);
  assert.ok(segs.length >= 1 && segs.every((x) => x.speaker === 'me'));
  const word = segs[0].text.split(/\s+/).find((w) => w.length > 4) || segs[0].text.split(/\s+/)[0];
  const found = await s.json('GET', `/api/notes?q=${encodeURIComponent(word.replace(/[^\p{L}]/gu, ''))}`);
  assert.equal(found[0]?.id, st.noteId, 'transcript text is searchable');
  await new Promise((r) => setTimeout(r, 100));
  for (const e of ['recording.started', 'capture.request', 'transcript.segment', 'recording.stopped']) assert.ok(events.includes(e), `event ${e} missing in ${events}`);
});

test('import a WAV file into a note', real, async (t) => {
  const s = await boot(t, { withModels: true });
  const n = await s.json('POST', '/api/notes', { title: 'Imported' });
  const wav = fs.readFileSync(fixture('speech-0.wav'));
  const r = await s.json('POST', `/api/notes/${n.id}/import-audio?filename=a.wav`, wav);
  assert.ok(r.segments >= 1 && r.durationMs > 5000);
  assert.ok((await s.json('GET', `/api/notes/${n.id}/transcript`)).length >= 1);
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/import-audio`, Buffer.alloc(0)), (e) => e.status === 400);
});

test('spaces, advanced search filters and per-speaker quotes', async (t) => {
  const s = await boot(t);
  const sp = await s.json('POST', '/api/spaces', { name: 'Clients' });
  const a = await s.json('POST', '/api/notes', { title: 'Acme kickoff', body: 'budget talk', folderId: sp.id, attendees: [{ name: 'Ana Silva', email: 'ana@acme.com' }] });
  const b = await s.json('POST', '/api/notes', { title: 'Internal budget', body: 'hiring' });
  s.app.notes.addSegments(a.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 2000, text: 'The budget is approved for March' }, { speaker: 'them', speakerId: 's2', startMs: 3000, endMs: 5000, text: 'I disagree about the budget' }]);
  s.app.speakers.save(a.id, { speakerId: 's1', channel: 'system', centroid: new Float32Array(4).fill(1), count: 1 });
  s.app.speakers.save(a.id, { speakerId: 's2', channel: 'system', centroid: new Float32Array([1, -1, 1, -1]), count: 1 });
  s.app.notes.reindex(a.id);
  await s.json('PATCH', `/api/notes/${a.id}/speakers/s1`, { name: 'Ana', remember: true });
  assert.deepEqual((await s.json('GET', '/api/spaces')).map((x) => [x.name, x.notes]), [['Clients', 1]]);
  assert.equal((await s.json('GET', '/api/search?q=budget')).length, 2);
  assert.deepEqual((await s.json('GET', `/api/search?q=budget&space=${sp.id}`)).map((n) => n.id), [a.id]);
  assert.deepEqual((await s.json('GET', '/api/search?q=budget&scope=title')).map((n) => n.id), [b.id], 'title scope');
  assert.deepEqual((await s.json('GET', '/api/search?q=march&scope=transcript')).map((n) => n.id), [a.id]);
  assert.deepEqual((await s.json('GET', '/api/search?attendee=acme.com')).map((n) => n.id), [a.id]);
  assert.deepEqual((await s.json('GET', '/api/search?has=transcript')).map((n) => n.id), [a.id]);
  assert.equal((await s.json('GET', `/api/search?from=${Date.now() + 60000}`)).length, 0);
  const bySpeaker = await s.json('GET', '/api/search?speaker=ana&q=budget');
  assert.deepEqual(bySpeaker.map((n) => n.id), [a.id]);
  assert.deepEqual(bySpeaker[0].quotes.map((q) => q.text), ['The budget is approved for March'], 'only what Ana said');
  assert.equal((await s.json('GET', '/api/search?q=%25%25')).length, 0, 'punctuation-only query');
  const spk = await s.json('GET', `/api/notes/${a.id}/speakers`);
  assert.deepEqual(spk.map((x) => x.label), ['Ana', 'Speaker 2']);
  assert.deepEqual((await s.json('GET', '/api/voices')).map((v) => v.name), ['Ana']);
  await assert.rejects(s.json('POST', `/api/notes/${a.id}/segments/1/speaker`, { speakerId: 'x; drop' }), (e) => e.status === 400);
  await s.json('DELETE', `/api/spaces/${sp.id}`);
  assert.equal((await s.json('GET', `/api/notes/${a.id}`)).folderId, null, 'notes survive their space');
});

test('account: summary, exports, and danger zone confirmations', async (t) => {
  const s = await boot(t);
  await s.json('PUT', '/api/settings', { userName: 'Alex', llm: { apiKey: 'sk-secret' } });
  const n = await s.json('POST', '/api/notes', { title: 'Plan', body: 'x' });
  s.app.notes.addSegments(n.id, [{ speaker: 'me', startMs: 0, endMs: 1000, text: 'hello' }]);
  const acc = await s.json('GET', '/api/account');
  assert.equal(acc.name, 'Alex');
  assert.equal(acc.stats.notes, 1);
  const json = await (await s.call('GET', '/api/account/export')).text();
  assert.ok(!json.includes('sk-secret'), 'exports never contain the API key');
  assert.equal(JSON.parse(json).notes[0].transcript[0].text, 'hello');
  assert.match(await (await s.call('GET', '/api/account/export?format=md')).text(), /# Plan/);
  await assert.rejects(s.json('POST', '/api/account/delete-transcripts', {}), (e) => e.status === 400);
  assert.equal((await s.json('POST', '/api/account/delete-transcripts', { confirm: 'DELETE' })).deleted, 1);
  await assert.rejects(s.json('POST', '/api/account/delete-everything', { confirm: 'DELETE' }), (e) => e.status === 400);
  await s.json('POST', '/api/account/delete-everything', { confirm: 'DELETE EVERYTHING' });
  assert.equal((await s.json('GET', '/api/notes')).length, 0);
  assert.equal((await s.json('GET', '/api/settings')).userName, '', 'settings back to defaults');
});

test('voices are opt-in: naming a speaker without ticking "remember" saves no voice; ticking it records consent', async (t) => {
  const s = await boot(t);
  const n = await s.json('POST', '/api/notes', { title: 'Call' });
  s.app.notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'hello' }, { speaker: 'them', speakerId: 's2', startMs: 13000, endMs: 25000, text: 'hi' }]);
  s.app.speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: new Float32Array(4).fill(1), count: 3 });
  s.app.speakers.save(n.id, { speakerId: 's2', channel: 'system', centroid: new Float32Array([1, -1, 1, -1]), count: 3 });
  await s.json('PATCH', `/api/notes/${n.id}/speakers/s1`, { name: 'Ana' });
  await s.json('PATCH', `/api/notes/${n.id}/speakers/s2`, { name: 'Bruno', remember: false });
  assert.deepEqual(await s.json('GET', '/api/voices'), [], 'named for this meeting only');
  await s.json('PATCH', `/api/notes/${n.id}/speakers/s1`, { name: 'Ana', remember: true });
  assert.deepEqual((await s.json('GET', '/api/voices')).map((v) => v.name), ['Ana']);
  assert.equal(s.app.db.prepare("SELECT consent_source s FROM voices WHERE name = 'Ana'").get().s, 'user');
});

test('speakers: a line can be moved to a Discord person, and one speaker can be merged into another', async (t) => {
  const s = await boot(t);
  const n = await s.json('POST', '/api/notes', { title: 'Call' });
  const [seg] = s.app.notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 2000, text: 'hello' }]);
  const same = new Float32Array([1, 0.9, 1, 0.9]);
  s.app.speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: same, count: 2 });
  s.app.speakers.save(n.id, { speakerId: 's2', channel: 'system', centroid: same, count: 2 });
  s.app.speakers.ensureNamed(n.id, 'd4242', 'Rui', 'system');
  const move = (speakerId) => s.json('POST', `/api/notes/${n.id}/segments/${seg.id}/speaker`, { speakerId });
  await move('d4242');
  assert.equal(s.app.notes.segments(n.id)[0].speakerId, 'd4242');
  for (const bad of ['d', 'dabc', 'x1', 's1; drop', 'd' + '9'.repeat(30)]) await assert.rejects(move(bad), (e) => e.status === 400, bad);

  const merge = (from, into) => s.json('POST', `/api/notes/${n.id}/speakers/${from}/merge`, { into });
  await move('s2');
  assert.deepEqual(await merge('s2', 's1'), { ok: true });
  assert.equal(s.app.notes.segments(n.id)[0].speakerId, 's1', 'its lines moved over');
  assert.ok(!s.app.speakers.forNote(n.id).some((x) => x.speakerId === 's2'), 'and the speaker is gone');
  await assert.rejects(merge('s1', 's1'), (e) => e.status === 400, 'a speaker cannot join itself');
  await assert.rejects(merge('s9', 's1'), (e) => e.status === 409, 'unknown speakers, or voices that clearly differ, are refused');
  await assert.rejects(merge('s1', 'nope'), (e) => e.status === 400);
});

test('recording notice: text follows the language and preset (or the query), and a note remembers what was said', async (t) => {
  const s = await boot(t);
  assert.match((await s.json('GET', '/api/consent/notice')).text, /recording this meeting with WhisperBrain/);
  await s.json('PUT', '/api/settings', { consentPreset: 'eu', language: 'pt' });
  assert.match((await s.json('GET', '/api/consent/notice')).text, /apago/, 'defaults come from the settings');
  assert.match((await s.json('GET', '/api/consent/notice?lang=en&preset=us')).text, /By staying on the call/, 'the query wins');
  const n = await s.json('POST', '/api/notes', { title: 'Call' });
  assert.equal(n.consent, 'unknown');
  assert.equal((await s.json('PATCH', `/api/notes/${n.id}`, { consent: 'announced' })).consent, 'announced');
  await assert.rejects(s.json('PATCH', `/api/notes/${n.id}`, { consent: 'whatever' }), (e) => e.status === 400);
});
