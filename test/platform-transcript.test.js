'use strict';
// After recording a Teams, Zoom or Google Meet call the note offers to fetch the platform's own transcript, which names every line.
// Provider answers are simulated (src/transcripts/providers.js was written from the vendors' docs and never ran against a real account).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { TranscriptError } = require('../src/transcripts/providers');
const { TranscriptService } = require('../src/transcripts/service');
const { tmpDir, ROOT } = require('./helpers');

// what was said, by whom, when (our timeline): the same call as test/reconcile.test.js, and the platform's version of it, its clock 30 s before ours
const SAID = [
  ['s1', 2000, 7000, 'Good morning everyone thanks for joining the planning call today'], ['s2', 8000, 13000, 'Happy to be here I wanted to start with the budget for the second quarter'],
  ['s3', 14000, 20000, 'Before the budget we should settle the hiring plan for the platform team'], ['s1', 21000, 26000, 'Agreed let us take hiring first and then the budget discussion'],
  ['s2', 27000, 33000, 'The recruiter said we can close two engineers by the end of March'], ['s3', 34000, 40000, 'That works for me but I need a decision on the contractor by Friday'],
  ['s1', 41000, 46000, 'I will confirm the contractor decision tomorrow morning after the review'],
];
const WHO = { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' };
const clock = (ms) => { const t = Math.max(0, ms); return `${String(Math.floor(t / 3600000)).padStart(2, '0')}:${String(Math.floor(t / 60000) % 60).padStart(2, '0')}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`; };
const VTT = `WEBVTT\n\n${SAID.map(([id, a, b, text]) => `${clock(a + 30000)} --> ${clock(b + 30000)}\n<v ${WHO[id]}>${text.replace(/^(\w+) /, '$1, ')}</v>`).join('\n\n')}\n`;
const fakePlatform = () => ({ id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return {}; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null });

async function boot(t, { provider } = {}) {
  const dataDir = tmpDir('wb-ptx-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  // the three providers answer from here; a client that is signed in
  const calls = [];
  const providers = Object.fromEntries(['teams', 'zoom', 'meet'].map((id) => [id, { id, label: { teams: 'Microsoft Teams', zoom: 'Zoom', meet: 'Google Meet' }[id], platform: id, async fetchTranscript(arg) { calls.push([id, arg.ref]); return (provider || (async () => ({ text: VTT, filename: `${id}.vtt` })))({ id, attempt: calls.filter((c) => c[0] === id).length, ...arg }); } }]));
  app.transcripts = new TranscriptService({ app, providers });
  app.transcripts.client = () => ({ connected: () => true });
  return { app, call, calls };
}
// a recorded note: three remote voices as recorded (what the transcript is matched with)
function recordedNote(app, { platform = 'teams', links = [] } = {}) {
  const n = app.notes.create({ title: 'Planning', platform });
  for (const sid of ['s1', 's2', 's3']) app.db.prepare("INSERT INTO note_speakers (note_id, speaker_id, channel, name, count) VALUES (?, ?, 'system', '', 1)").run(n.id, sid);
  app.notes.addSegments(n.id, SAID.map(([sid, startMs, endMs, text]) => ({ speaker: 'them', speakerId: sid, text, startMs, endMs, channel: 'system', words: text.split(' ').map((w, k) => [w, k * 400, k * 400 + 350]) })));
  for (const url of links) app.knowledge.addLink(n.id, { kind: 'url', url, title: url });
  return n;
}
const JOIN = { teams: 'https://teams.live.com/meet/9381234567', zoom: 'https://us02web.zoom.us/j/81234567890', meet: 'https://meet.google.com/abc-defg-hij' };
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timed out'); };

test('the call the meeting window showed becomes the note\'s platform and its meeting link, so it can be looked up afterwards', async (t) => {
  const { app } = await boot(t);
  for (const [platform, code, url] of [['meet', 'abc-defg-hij', 'https://meet.google.com/abc-defg-hij'], ['zoom', '81234567890', 'https://zoom.us/j/81234567890'], ['teams', '9381234567', 'https://teams.live.com/meet/9381234567']]) {
    const n = app.notes.create({ title: platform });
    app.bus.publish('recording.call', { noteId: n.id, platform, code });
    assert.equal(app.notes.get(n.id).platform, platform);
    assert.ok(app.knowledge.links(n.id).some((l) => l.url === url), `${platform}: ${url}`);
  }
  const named = app.notes.create({ title: 'x', platform: 'zoom' });
  app.bus.publish('recording.call', { noteId: named.id, platform: 'meet', code: 'abc-defg-hij' });
  assert.equal(app.notes.get(named.id).platform, 'zoom', 'a platform the note already has is kept');
  const other = app.notes.create({ title: 'd' });
  app.bus.publish('recording.call', { noteId: other.id, platform: 'discord', code: '123' });
  assert.equal(app.knowledge.links(other.id).length, 0, 'no transcript to fetch from Discord: no link made');
});

test('the offer: Teams, Zoom and Meet recordings get one, others do not; what is missing is said', async (t) => {
  const { app, call } = await boot(t);
  const n = recordedNote(app, { platform: 'teams', links: [JOIN.teams] });
  let o = (await call('GET', `/api/notes/${n.id}/platform-transcript`)).body;
  assert.deepEqual([o.platform, o.label, o.state, o.connected, o.hasLink], ['teams', 'Microsoft Teams', 'ready', true, true]);
  assert.equal(o.fallback, 'file');
  const noLink = recordedNote(app, { platform: 'zoom' });
  o = (await call('GET', `/api/notes/${noLink.id}/platform-transcript`)).body;
  assert.deepEqual([o.state, o.needs], ['blocked', 'link']);
  assert.match(o.reason.message, /link/i);
  app.transcripts.client = () => ({ connected: () => false });
  o = (await call('GET', `/api/notes/${n.id}/platform-transcript`)).body;
  assert.deepEqual([o.state, o.needs], ['blocked', 'connect']);
  const discord = recordedNote(app, { platform: 'discord' });
  assert.equal((await call('GET', `/api/notes/${discord.id}/platform-transcript`)).body.state, 'none');
  assert.equal((await call('GET', `/api/notes/${recordedNote(app, { platform: null }).id}/platform-transcript`)).body.state, 'none');
});

test('fetching is a retrying job: "not ready yet" waits and tries again, then the transcript is attached and the voices are named', async (t) => {
  let asked = 0;
  const { app, call } = await boot(t, { provider: async () => { if (++asked < 3) throw new TranscriptError('There is no transcript for this meeting.', 'not-found'); return { text: VTT, filename: 'teams.vtt' }; } });
  app.jobs.backoff = [10];
  const n = recordedNote(app, { platform: 'teams', links: [JOIN.teams] });
  const r = await call('POST', `/api/notes/${n.id}/platform-transcript`);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'working');
  const done = await until(async () => { const o = (await call('GET', `/api/notes/${n.id}/platform-transcript`)).body; return o.state === 'done' && o; }, 8000);
  assert.equal(asked, 3, 'asked until it was there');
  assert.ok(done.result.matched >= 5);
  assert.deepEqual(app.speakers.forNote(n.id).map((s) => s.name).sort(), ['Ana Silva', 'Bruno Costa', 'Carla Dias']);
});

test('while it waits the note says so, with the attempt; asking twice is one job', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { app, call } = await boot(t, { provider: async () => { await gate; return { text: VTT, filename: 'x.vtt' }; } });
  const n = recordedNote(app, { platform: 'meet', links: [JOIN.meet] });
  await call('POST', `/api/notes/${n.id}/platform-transcript`);
  await call('POST', `/api/notes/${n.id}/platform-transcript`);
  const w = await until(async () => { const o = (await call('GET', `/api/notes/${n.id}/platform-transcript`)).body; return o.state === 'working' && o; });
  assert.ok(w.attempt >= 1 && w.of >= 4);
  release();
  await until(async () => (await call('GET', `/api/notes/${n.id}/platform-transcript`)).body.state === 'done');
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'transcript.fetch'").get().n, 1);
});

test('every failure has a reason in words, and the file drop is always the way out', async (t) => {
  const cases = [
    ['teams', 'disabled', /policy/i], ['teams', 'no-names', /names/i], ['zoom', 'not-found', /cloud recording|paid|host/i], ['meet', 'not-found', /30 days|transcription/i],
    ['meet', 'forbidden', /permission|allowed/i], ['zoom', 'auth', /connect again|sign-in/i],
  ];
  for (const [platform, code, re] of cases) {
    const { app, call } = await boot(t, { provider: async () => { throw new TranscriptError('provider says no', code); } });
    app.jobs.backoff = [10];
    const n = recordedNote(app, { platform, links: [JOIN[platform]] });
    await call('POST', `/api/notes/${n.id}/platform-transcript`);
    const o = await until(async () => { const x = (await call('GET', `/api/notes/${n.id}/platform-transcript`)).body; return x.state === 'failed' && x; }, 8000);
    assert.equal(o.reason.code, code);
    assert.match(o.reason.message, re, `${platform} ${code}`);
    assert.match(o.reason.hint, /drop|file|\.vtt/i, 'the file drop is offered');
    assert.equal(o.fallback, 'file');
  }
});

test('a permanent failure is not retried; "not found" is retried for a bounded time and then given up with its reason', async (t) => {
  let n403 = 0, nNotFound = 0;
  const a = await boot(t, { provider: async () => { n403++; throw new TranscriptError('x', 'disabled'); } });
  a.app.jobs.backoff = [10];
  const na = recordedNote(a.app, { platform: 'teams', links: [JOIN.teams] });
  await a.call('POST', `/api/notes/${na.id}/platform-transcript`);
  await until(async () => (await a.call('GET', `/api/notes/${na.id}/platform-transcript`)).body.state === 'failed', 8000);
  assert.equal(n403, 1, 'a policy will not change in a minute');
  const b = await boot(t, { provider: async () => { nNotFound++; throw new TranscriptError('x', 'not-found'); } });
  b.app.jobs.backoff = [10];
  const nb = recordedNote(b.app, { platform: 'zoom', links: [JOIN.zoom] });
  await b.call('POST', `/api/notes/${nb.id}/platform-transcript`);
  const o = await until(async () => { const x = (await b.call('GET', `/api/notes/${nb.id}/platform-transcript`)).body; return x.state === 'failed' && x; }, 15000);
  assert.ok(nNotFound >= 4 && nNotFound <= 8, `tried ${nNotFound} times`);
  assert.equal(o.reason.code, 'not-found');
});

test('the setting: ask (the note offers), auto (it is fetched after Stop when it can be), off (no offer at all)', async (t) => {
  const { app, call, calls } = await boot(t);
  app.jobs.backoff = [10];
  assert.equal(app.settings.get('platformTranscript'), 'ask', 'ask by default');
  assert.ok(app.platformTranscripts.firstDelayMs >= 10000, 'an automatic start waits a little: the platform needs a moment after the call ends');
  app.platformTranscripts.firstDelayMs = 0;
  const n = recordedNote(app, { platform: 'meet', links: [JOIN.meet] });
  app.bus.publish('recording.stopped', { noteId: n.id });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 0, 'ask: nothing happens by itself');
  app.settings.update({ platformTranscript: 'auto' });
  const m = recordedNote(app, { platform: 'meet', links: [JOIN.meet] });
  app.bus.publish('recording.stopped', { noteId: m.id });
  await until(async () => (await call('GET', `/api/notes/${m.id}/platform-transcript`)).body.state === 'done', 8000);
  assert.equal(calls.length, 1);
  const unlinked = recordedNote(app, { platform: 'zoom' });
  app.bus.publish('recording.stopped', { noteId: unlinked.id });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 1, 'auto, but with nothing to look up: it waits for the person');
  app.settings.update({ platformTranscript: 'off' });
  assert.equal((await call('GET', `/api/notes/${n.id}/platform-transcript`)).body.state, 'none');
  assert.equal((await call('POST', `/api/notes/${n.id}/platform-transcript`)).status, 409);
});
