'use strict';
// Test runs are hermetic: a developer's git-ignored src/core/oauth-clients.local.json or WB_GOOGLE_CLIENT_ID / WB_MICROSOFT_CLIENT_ID
// must not change what createApp() does under `node --test`. Tests that need a shipped client pass `builtIn` themselves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { builtInClient } = require('../src/core/oauth-clients');
const { createApp } = require('../src/server/app');
const { tmpDir, ROOT } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async meetingWindows() { return []; },
  async paste() { return { ok: false }; }, clipboard: null,
});
const NONE = { clientId: '', clientSecret: '' };
const FAKE = { WB_GOOGLE_CLIENT_ID: 'fake-env.apps.googleusercontent.com', WB_GOOGLE_CLIENT_SECRET: 'fake-s', WB_MICROSOFT_CLIENT_ID: 'fake-ms-id' };
const withEnv = (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('under node --test the default built-in clients are empty, whatever the environment says', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT in the process that runs a test file');
  withEnv(FAKE, () => {
    assert.deepEqual(builtInClient('google'), NONE);
    assert.deepEqual(builtInClient('microsoft'), NONE);
  });
});

test('an injected environment still works under test (that is how the client lookup itself is tested)', () => {
  assert.deepEqual(builtInClient('google', { env: { WB_GOOGLE_CLIENT_ID: 'id', WB_GOOGLE_CLIENT_SECRET: 's' }, file: '/nonexistent' }), { clientId: 'id', clientSecret: 's' });
});

test('outside a test run the environment supplies the client, as in the app', () => {
  const env = { ...process.env, ...FAKE };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./src/core/oauth-clients').builtInClient('google')))"], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { clientId: FAKE.WB_GOOGLE_CLIENT_ID, clientSecret: FAKE.WB_GOOGLE_CLIENT_SECRET });
});

test('createApp() in a test gets no built-in Google client from the developer environment', async (t) => {
  const app = withEnv(FAKE, () => createApp({ dataDir: tmpDir('wb-oauth-hermetic-', t), platform: fakePlatform(), version: 'test' }));
  t.after(() => app.close());
  assert.equal(app.google.config().clientId, '');
});
