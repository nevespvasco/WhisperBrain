'use strict';
// The app lock (src/core/lock.js): a lock screen with a passphrase, wrong tries slowed, locks again when idle, never switchable without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../src/core/db');
const { AppLock, mayPass } = require('../src/core/lock');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

test('a passphrase locks the app, wrong tries are slowed, and it locks again when idle', () => {
  let t = 1_000_000;
  const l = new AppLock({ db: open(':memory:'), now: () => t });
  assert.deepEqual(l.status(), { enabled: false, locked: false, minutes: 0 });
  assert.throws(() => l.enable({ passphrase: 'short' }), /at least 8/);
  l.enable({ passphrase: 'correct horse', minutes: 10 });
  assert.equal(l.status().locked, false, 'unlocked right after it is set');
  l.lock();
  assert.throws(() => l.unlock('wrong one'), (e) => e.status === 401);
  for (let i = 0; i < 3; i++) assert.throws(() => l.unlock('wrong again'), (e) => e.status === 401);
  assert.throws(() => l.unlock('wrong again'), (e) => e.status === 401);
  assert.throws(() => l.unlock('correct horse'), (e) => e.status === 429 && /30 seconds/.test(e.message), 'five wrong tries in a row: even the right one waits');
  t += 31_000;
  assert.equal(l.unlock('correct horse').locked, false);
  t += 9 * 60_000; l.touch();
  assert.equal(l.locked(), false, 'in use');
  t += 11 * 60_000;
  assert.equal(l.locked(), true, 'ten idle minutes: locked again');
  // a new instance (the app restarted) starts locked, and the passphrase is not stored as it was typed
  const l2 = new AppLock({ db: l.db });
  assert.equal(l2.status().locked, true);
  assert.ok(!JSON.stringify(l.db.prepare('SELECT * FROM index_meta').all()).includes('correct horse'));
  // changing or removing it needs the current one
  l2.unlock('correct horse');
  assert.throws(() => l2.enable({ passphrase: 'another long one', current: 'nope nope' }), /not the passphrase/);
  assert.throws(() => l2.disable({ passphrase: 'nope nope' }), /not the passphrase/);
  l2.enable({ passphrase: 'another long one', current: 'correct horse', minutes: 0 });
  l2.lock();
  assert.throws(() => l2.unlock('correct horse'), /not the passphrase/, 'the old one no longer works');
  l2.unlock('another long one');
  assert.equal(l2.disable({ passphrase: 'another long one' }).enabled, false);
});

test('what a locked app still answers: the lock, and the audio of a recording that is running', () => {
  assert.equal(mayPass('POST', '/api/lock/unlock'), true);
  assert.equal(mayPass('POST', '/api/recording/pcm'), true);
  assert.equal(mayPass('POST', '/api/recording/stop'), true);
  for (const p of ['/api/notes', '/api/settings', '/api/events', '/api/recording/start', '/api/items', '/api/inbox', '/api/find']) assert.equal(mayPass('GET', p), false, p);
});

test('over HTTP: locked means nothing is served, the hash never leaves, and the settings API cannot switch the lock off', async (t) => {
  const dataDir = tmpDir('wb-lock-');
  const app = createApp({ dataDir, version: 'test', platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null } });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  await app.ready;
  assert.equal((await call('GET', '/api/notes')).status, 200, 'no lock set: as before');
  assert.equal((await call('POST', '/api/lock/enable', { passphrase: 'correct horse', minutes: 0 })).body.enabled, true);
  assert.equal((await call('GET', '/api/notes')).status, 200, 'unlocked until it is locked');
  assert.equal((await call('POST', '/api/lock/lock')).body.locked, true);
  const locked = await call('GET', '/api/notes');
  assert.deepEqual([locked.status, locked.body.code], [423, 'locked']);
  assert.equal((await call('GET', '/api/settings')).status, 423);
  assert.equal((await call('GET', '/api/events')).status, 423, 'live events (they carry what is being said) are closed too');
  assert.equal((await call('GET', '/api/lock')).body.locked, true, 'the lock screen can ask');
  assert.equal((await call('POST', '/api/lock/unlock', { passphrase: 'nope nope nope' })).status, 401);
  assert.equal((await call('POST', '/api/lock/disable', { passphrase: 'nope nope nope' })).status, 401);
  assert.equal((await call('POST', '/api/lock/unlock', { passphrase: 'correct horse' })).body.locked, false);
  assert.equal((await call('GET', '/api/notes')).status, 200);
  const everything = JSON.stringify((await call('GET', '/api/settings')).body) + JSON.stringify((await call('GET', '/api/state')).body);
  assert.ok(!/lock:hash|"hash"|scrypt/.test(everything), 'the hash is not in anything the interface can read');
  assert.equal((await call('PUT', '/api/settings', { lock: { hash: '' } })).status >= 400, true, 'the settings API has no way to touch the lock');
  assert.equal((await call('POST', '/api/lock/disable', { passphrase: 'correct horse' })).body.enabled, false);
});

// ---- audit 2026-11-28 (P3 lock): idle locks by itself, audio does not count as use, MCP needs a live app ----
test('the idle lock closes by itself on a timer, without waiting for a request, and the app keeps saying it is alive', async () => {
  let t = 1_000_000;
  const events = [];
  const l = new AppLock({ db: open(':memory:'), now: () => t, bus: { publish: (type, data) => events.push([type, data]) }, tickMs: 10 });
  try {
    l.enable({ passphrase: 'correct horse', minutes: 1 });
    t += 61_000;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(l.isLocked, true, 'locked by the timer');
    assert.equal(l.meta('state'), 'locked', 'and written where MCP reads it');
    assert.deepEqual(events.at(-1), ['lock.changed', { locked: true }]);
    assert.equal(Number(l.meta('seen')), t, 'the heartbeat MCP checks');
  } finally { l.close(); }
  assert.equal(l.timer, null, 'closing stops the timer');
});

test('MCP reads a passphrase-locked app as locked unless the app said "unlocked" recently (a crashed app is locked)', () => {
  const { BrainReader } = require('../src/mcp/server');
  const db = open(':memory:');
  const r = new BrainReader(db);
  const set = (k, v) => db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`lock:${k}`, String(v));
  assert.equal(r.locked(), false, 'no passphrase: never locked');
  set('hash', 'x'); set('state', 'unlocked');
  assert.equal(r.locked(), true, 'unlocked but no heartbeat at all');
  set('seen', Date.now());
  assert.equal(r.locked(), false, 'unlocked and alive');
  set('seen', Date.now() - 10 * 60_000);
  assert.equal(r.locked(), true, 'the app stopped saying it is alive (crashed): locked');
  set('seen', Date.now()); set('state', 'locked');
  assert.equal(r.locked(), true);
});

test('over HTTP: streaming audio does not keep the app unlocked, and live events close when it locks', async (t) => {
  const dataDir = tmpDir('wb-lock-');
  const app = createApp({ dataDir, version: 'test', platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null } });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const headers = { Cookie: `wb_token=${token}` };
  app.lock.enable({ passphrase: 'correct horse', minutes: 5 });
  const before = app.lock.lastUse = Date.now() - 60_000;
  await fetch(url('/api/recording/pcm?ch=mic'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(320) }).then((r) => r.arrayBuffer());
  await fetch(url('/api/dictation/pcm'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(320) }).then((r) => r.arrayBuffer());
  assert.equal(app.lock.lastUse, before, 'audio chunks are not somebody using the app');
  await fetch(url('/api/notes'), { headers }).then((r) => r.arrayBuffer());
  assert.ok(app.lock.lastUse > before, 'a real request is');

  const res = await fetch(url('/api/events'), { headers });
  const reader = res.body.getReader();
  await reader.read();   // ': ok'
  app.lock.lock();
  let text = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); }
  assert.match(text, /event: lock\.changed/, 'the page is told, then the stream ends');
});
