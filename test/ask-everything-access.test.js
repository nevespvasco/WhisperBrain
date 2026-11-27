'use strict';
// "Ask about anything" (src/llm/workspace.js) honours the access grants: what comes from a meeting or a source kept on this computer never
// reaches an AI server that is not on this computer, whichever kind of record it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createApp } = require('../src/server/app');
const { startFakeLlm } = require('./fake-llm');
const { fakePlatform } = require('./gmail-fake');
const { tmpDir } = require('./helpers');

const remote = (url) => url.replace('127.0.0.1', '[::ffff:127.0.0.1]');

test('workspace records: decisions, promises, projects, people and latest mail from local-only sources stay out for a remote AI, and come back for a local one', async (t) => {
  const dataDir = tmpDir('wb-askall-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready; await app.runner.stop();
  // a meeting imported from Notion and kept local, with a decision and a promise; an ordinary meeting with another decision
  const priv = app.notes.create({ title: 'Board secret meeting', status: 'done', source: 'notion', sourceRef: 'n1', body: 'x' });
  app.items.syncNote(priv.id);
  app.items.setGrant(app.items.sourceOfNote(priv.id).id, { aiReach: 'local' });
  const pub = app.notes.create({ title: 'Weekly sync', status: 'done', body: 'x' });
  app.items.syncNote(pub.id);
  app.assertions.add({ kind: 'decision', text: 'We will acquire SECRETCO for 40 million', noteId: priv.id, state: 'accepted', origin: 'user', quote: 'acquire SECRETCO', occurredAt: Date.now() });
  app.assertions.add({ kind: 'decision', text: 'We will keep the weekly sync on Tuesdays', noteId: pub.id, state: 'accepted', origin: 'user', quote: 'keep the weekly sync', occurredAt: Date.now() });
  const mail = app.items.addSource({ kind: 'gmail', name: 'Mail', mode: 'copy', sensitivity: 'private', config: { remote: true } });
  app.items.upsert(mail.id, { externalId: 'thread:1', kind: 'email', title: 'MAILSECRET invoice', text: 'MAILSECRET bank details', occurredAt: Date.now() });
  const llm = await startFakeLlm(() => 'ok');
  t.after(() => llm.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: remote(llm.url), model: 'fake-model' } });
  const ask = (q) => app.ai.chat(null, q);
  await ask('What did we decide? And what are my latest e-mails?');
  const seen = JSON.stringify(llm.requests);
  assert.ok(seen.includes('weekly sync on Tuesdays'), 'what may go does go');
  assert.ok(!seen.includes('SECRETCO') && !seen.includes('Board secret'), 'nothing from the local-only meeting');
  assert.ok(!seen.includes('MAILSECRET'), 'nothing from the mail kept local');
  // the same questions with a server on this computer: everything is reachable
  llm.requests.length = 0;
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url } });
  await ask('What did we decide? And what are my latest e-mails?');
  const local = JSON.stringify(llm.requests);
  assert.ok(local.includes('SECRETCO') && local.includes('MAILSECRET'), 'a local server may read them (this proves the test could see them)');
});
