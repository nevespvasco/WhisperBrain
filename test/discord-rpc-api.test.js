'use strict';
// Settings → Integrations → Discord → "Connect without a bot": the settings, the status and the routes behind the card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

async function boot(t) {
  const dataDir = tmpDir('wb-rpcapi-');
  const app = createApp({ dataDir, platform: { id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return {}; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null }, version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { app, call };
}

test('settings: your own Discord application is saved, and its secret and tokens never travel back', async (t) => {
  const { app, call } = await boot(t);
  const put = await call('PUT', '/api/settings', { discordRpc: { enabled: true, clientId: '123', clientSecret: 'sec-ret', accessToken: 'tok', refreshToken: 'ref' } });
  assert.equal(put.status, 200);
  const shown = (await call('GET', '/api/settings')).body.discordRpc;
  assert.equal(shown.clientId, '123');
  assert.ok(!JSON.stringify(shown).includes('sec-ret') && !JSON.stringify(shown).includes('"tok"') && !JSON.stringify(shown).includes('"ref"'), 'masked like the other integration secrets');
  assert.equal(app.settings.get('discordRpc').clientSecret, 'sec-ret', 'the app itself still has it');
});

test('status: what the card shows, and the call the person is in right now', async (t) => {
  const { app, call } = await boot(t);
  let st = (await call('GET', '/api/integrations')).body.discordRpc;
  assert.deepEqual([st.configured, st.enabled, st.authorised, st.state, st.call], [false, false, false, 'off', null]);
  app.settings.update({ discordRpc: { ...app.settings.get('discordRpc'), enabled: true, clientId: '123', clientSecret: 's', accessToken: 'tok' } });
  app.discordRpc.s.state = 'in-call'; app.discordRpc.s.call = { id: 'c1', name: 'Standup' }; app.discordRpc.people.set('1', { id: '1', name: 'Ana' }); app.discordRpc.people.set('2', { id: '2', name: 'Bruno' });
  st = (await call('GET', '/api/integrations')).body.discordRpc;
  assert.deepEqual([st.configured, st.authorised, st.state, st.call.name, st.call.people], [true, true, 'in-call', 'Standup', 2]);
  assert.deepEqual((await call('GET', '/api/integrations/discord-rpc/status')).body, st);
});

test('routes: authorise asks the Discord app and answers with the state; disconnect forgets the tokens and switches it off', async (t) => {
  const { app, call } = await boot(t);
  let asked = 0;
  app.discordRpc.authorise = async () => { asked++; app.discordRpc.s.state = 'connected'; };
  const r = await call('POST', '/api/integrations/discord-rpc/authorise');
  assert.equal(r.status, 200);
  assert.equal(asked, 1);
  assert.equal(r.body.state, 'connected');
  app.discordRpc.authorise = async () => { throw new Error('The Discord app is not running.'); };
  const bad = await call('POST', '/api/integrations/discord-rpc/authorise');
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /not running/);
  app.settings.update({ discordRpc: { ...app.settings.get('discordRpc'), enabled: true, clientId: '1', clientSecret: 's', accessToken: 'a', refreshToken: 'r' } });
  await call('POST', '/api/integrations/discord-rpc/disconnect');
  const c = app.settings.get('discordRpc');
  assert.deepEqual([c.enabled, c.accessToken, c.refreshToken, c.clientId], [false, '', '', '1'], 'the application stays set up; the access goes');
});
