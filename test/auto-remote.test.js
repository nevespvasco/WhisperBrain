'use strict';
// What runs by itself after a recording, and where it goes (audit 2026-11-28, P1-5 and D1-3). After Stop the chain names voices,
// writes the enhanced notes (autoSummarize), finds topics and action items, and looks for decisions and commitments
// (autoAssertions). With an AI server on this computer that stays as it was. With a server elsewhere none of it sends the
// transcript unless the person said so (autoRemote, Settings → AI); what they click by hand still works. A meeting kept "only on
// this computer" by its source never goes to such a server, not even for names.
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
// the same fake server, reached through an address the app does NOT count as this computer (IPv4-mapped IPv6 loopback)
const remote = (url) => url.replace('127.0.0.1', '[::ffff:127.0.0.1]');
const REPLY = JSON.stringify({ speakers: [{ speaker: 'S1', name: 'Maria', evidence: 'L2' }] });

async function boot(t) {
  const dataDir = tmpDir('wb-auto-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  const llm = await startFakeLlm(() => REPLY);
  t.after(async () => { await srv.close(); app.close(); await llm.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  const json = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(j?.error || r.status), { status: r.status, code: j?.code });
    return j;
  };
  const meeting = () => {
    const n = app.notes.create({ title: 'Budget call' });
    for (const [id, ch] of [['m1', 'mic'], ['s1', 'system']]) app.speakers.save(n.id, { speakerId: id, channel: ch, centroid: new Float32Array(8).fill(id === 's1' ? 1 : 0.2), count: 3 });
    app.notes.addSegments(n.id, [['me', 'm1', 'Good morning, shall we start with the budget'], ['them', 's1', 'Sure, I am Maria and I will send the figures by Friday'], ['me', 'm1', 'Thanks Maria, we decided to freeze hiring']]
      .map(([speaker, speakerId, text], i) => ({ speaker, speakerId, text, startMs: i * 4000, endMs: i * 4000 + 3000, channel: speaker === 'me' ? 'mic' : 'system' })));
    app.notes.update(n.id, { status: 'done' });
    return n;
  };
  const stopped = (id) => app.bus.publish('recording.stopped', { noteId: id, durationMs: 1000 });
  const idle = async () => { for (let i = 0; i < 300; i++) { if (!app.db.prepare("SELECT COUNT(*) c FROM jobs WHERE kind LIKE 'note.%' AND state IN ('queued', 'running')").get().c) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('jobs never finished'); };
  return { app, llm, json, meeting, stopped, idle };
}

test('autoRemote is a checked setting, off by default', async (t) => {
  const s = await boot(t);
  assert.equal(s.app.settings.get('autoRemote'), false);
  await assert.rejects(s.json('PUT', '/api/settings', { autoRemote: 'yes' }), (e) => e.status === 400);
});

test('with an AI server elsewhere, nothing after Stop sends the transcript by itself: names, enhanced notes, topics, decisions', async (t) => {
  const s = await boot(t);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: remote(s.llm.url), model: 'fake-model' }, autoSummarize: true, speakerNamesFromTranscript: 'auto' });
  const n = s.meeting(); s.stopped(n.id);
  await new Promise((r) => setTimeout(r, 100)); await s.idle();
  assert.equal(s.llm.requests.length, 0, 'nothing was sent');
  assert.equal(s.app.notes.get(n.id).summary, '', 'no enhanced notes were written there');
});

test('with an AI server elsewhere and automatic sending allowed, the chain runs as before ', async (t) => {
  const s = await boot(t);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: remote(s.llm.url), model: 'fake-model' }, autoSummarize: true, autoRemote: true });
  const n = s.meeting(); s.stopped(n.id);
  await new Promise((r) => setTimeout(r, 100)); await s.idle();
  assert.ok(s.llm.requests.length >= 2, `the summary and what follows it were asked (${s.llm.requests.length})`);
  assert.ok(s.app.notes.get(n.id).summary, 'the enhanced notes were written');
});

test('with an AI server on this computer the chain is unchanged: decisions are looked for even with auto-enhance off', async (t) => {
  const s = await boot(t);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: s.llm.url, model: 'fake-model' }, autoSummarize: false, speakerNamesFromTranscript: 'off' });
  const n = s.meeting(); s.stopped(n.id);
  await new Promise((r) => setTimeout(r, 100)); await s.idle();
  assert.ok(s.llm.requests.length >= 1, 'decisions and commitments were looked for');
});

test('what the person clicks still goes to a server elsewhere: looking for decisions again in one meeting', async (t) => {
  const s = await boot(t);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: remote(s.llm.url), model: 'fake-model' } });
  const n = s.meeting();
  await s.json('POST', `/api/notes/${n.id}/assertions/extract`);
  await new Promise((r) => setTimeout(r, 50)); await s.idle();
  assert.ok(s.llm.requests.length >= 1);
});

// ---- D1-3: names from the conversation respect what the meeting's source allows ----
test('a meeting kept only on this computer: names are not guessed by a server elsewhere, after Stop or by hand', async (t) => {
  const s = await boot(t);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: remote(s.llm.url), model: 'fake-model' }, speakerNamesFromTranscript: 'on', autoAssertions: false });
  const n = s.meeting();
  s.app.items.syncNote(n.id);
  s.app.items.setGrant(s.app.items.sourceOfNote(n.id).id, { aiReach: 'local' });
  s.stopped(n.id);
  await new Promise((r) => setTimeout(r, 100)); await s.idle();
  assert.equal(s.llm.requests.length, 0, 'not after Stop, even with names set to "always"');
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/speakers/guess-names`, { confirm: true }), (e) => e.status === 409 && e.code === 'local-only');
  assert.equal(s.llm.requests.length, 0, 'not by hand either');
});

test('guessing names by hand with a server elsewhere asks first unless names are set to "always"', async (t) => {
  const s = await boot(t);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: remote(s.llm.url), model: 'fake-model' }, speakerNamesFromTranscript: 'auto' });
  const n = s.meeting();
  await assert.rejects(s.json('POST', `/api/notes/${n.id}/speakers/guess-names`), (e) => e.status === 409 && e.code === 'confirm-remote');
  assert.equal(s.llm.requests.length, 0);
  const r = await s.json('POST', `/api/notes/${n.id}/speakers/guess-names`, { confirm: true });
  assert.deepEqual(r.named.map((x) => x.name), ['Maria'], 'with the yes it runs');
  s.app.settings.update({ speakerNamesFromTranscript: 'on' });
  const m = s.meeting();
  await s.json('POST', `/api/notes/${m.id}/speakers/guess-names`);
  s.app.settings.update({ llm: { ...s.app.settings.get('llm'), baseUrl: s.llm.url }, speakerNamesFromTranscript: 'off' });
  const k = s.meeting();
  await s.json('POST', `/api/notes/${k.id}/speakers/guess-names`);   // on this computer a click needs no extra yes
});
