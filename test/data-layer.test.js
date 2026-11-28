'use strict';
// The data layer's upkeep (docs/adr/0001-brain-data-model.md): outbound actions cut off mid-run, the search index's change queue, the
// people backfill's cursor, the legacy search table's keys, and "Delete everything" leaving nothing behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { open } = require('../src/core/db');
const { Actions } = require('../src/brain/actions');
const { createApp } = require('../src/server/app');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const boot = async (t) => {
  const dataDir = tmpDir('wb-data-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  await app.runner.stop();
  return { app, dataDir };
};

const handlers = (runs) => ({ 'test.send': { label: 'Test', build: (i) => ({ title: 'Send it', args: i }), run: async () => { runs.n++; return { ok: true }; } } });

test('an action cut off mid-run is "interrupted" at start: shown as outcome unknown, never run again by itself', async () => {
  const db = open(':memory:');
  const runs = { n: 0 };
  const before = new Actions({ db, handlers: handlers(runs) });
  const a = before.propose('test.send', { to: 'ana@x.pt' });
  db.prepare("UPDATE actions SET state = 'running', decided_at = 1 WHERE id = ?").run(a.id);   // the app quit while it ran
  const actions = new Actions({ db, handlers: handlers(runs) });
  assert.equal(actions.recoverInterrupted(), 1);
  const got = actions.get(a.id);
  assert.equal(got.state, 'interrupted');
  assert.match(got.error, /outcome unknown/);
  assert.equal(actions.pending().length, 0, 'not offered for approval again');
  await assert.rejects(actions.approve(a.id), (e) => e.status === 409, 'and cannot be approved into a second run');
  assert.deepEqual(actions.interrupted().map((x) => x.id), [a.id]);
  assert.equal(runs.n, 0);
  assert.equal(actions.resolveInterrupted(a.id, { done: true }).state, 'done', 'the person checked: it was done');
  assert.throws(() => actions.resolveInterrupted(a.id, { done: false }), (e) => e.status === 409);
  const b = actions.propose('test.send', {});
  db.prepare("UPDATE actions SET state = 'running' WHERE id = ?").run(b.id);
  actions.recoverInterrupted();
  assert.equal(actions.resolveInterrupted(b.id, { done: false }).state, 'failed', 'it was not done: failed, not retried');
  assert.equal(runs.n, 0);
});

test('the Inbox shows an interrupted action as "check before retrying", with no approve button', async (t) => {
  const { app } = await boot(t);
  app.actions.handlers['test.send'] = handlers({ n: 0 })['test.send'];
  const a = app.actions.propose('test.send', { to: 'ana@x.pt' });
  app.db.prepare("UPDATE actions SET state = 'interrupted', error = 'x' WHERE id = ?").run(a.id);
  const card = app.inbox.cards().find((c) => c.id === a.id);
  assert.equal(card?.type, 'action-interrupted');
  assert.equal(card.title, 'Send it');
});
