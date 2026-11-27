'use strict';
// A platform account (discord:<user id>) is an identity of a person, like an e-mail address: strong. It keeps someone the same person
// across calls, display-name changes and capture paths (docs/adr/0001-brain-data-model.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server/app');
const { open, MIGRATIONS } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { RecordingManager } = require('../src/recording/manager');
const { SignalHub } = require('../src/meet/hub');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({ id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return {}; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null });
const boot = (t) => {
  const dataDir = tmpDir('wb-acct-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return app;
};
// a recorded call where these voices were named: [{ name, account?, voice? }]
function call(app, title, voices) {
  const n = app.notes.create({ title });
  voices.forEach((v, i) => {
    const sid = `s${i + 1}`;
    app.db.prepare("INSERT INTO note_speakers (note_id, speaker_id, channel, name, voice_id, account, count) VALUES (?, ?, 'system', ?, ?, ?, 1)").run(n.id, sid, v.name || '', v.voice || null, v.account || '');
    app.notes.addSegments(n.id, [{ speaker: 'them', speakerId: sid, text: `${v.name || 'someone'} talking about the plan`, startMs: i * 5000, endMs: i * 5000 + 4000, channel: 'system' }]);
  });
  app.entities.markDirty(n.id);
  return n;
}
const addVoice = (app, id, name) => app.db.prepare('INSERT INTO voices (id, name, embedding, samples, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)').run(id, name, Buffer.alloc(4));

// ---- the database ----
test('migration: the account identity kind is added, the copy of the database is made, and what was there is untouched', () => {
  const dir = tmpDir('wb-acct-mig-');
  const file = path.join(dir, 'a.db');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) old.exec(m);
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  old.exec("INSERT INTO entities (id, kind, name, key, created_at, updated_at) VALUES ('e1', 'person', 'Ana Silva', 'ana silva', 1, 1)");
  old.exec("INSERT INTO entity_identities (entity_id, kind, value, created_at) VALUES ('e1', 'name', 'ana silva', 1), ('e1', 'email', 'ana@acme.io', 1)");
  assert.throws(() => old.exec("INSERT INTO entity_identities (entity_id, kind, value, created_at) VALUES ('e1', 'account', 'discord:1', 1)"), /CHECK/, 'before: the kind is refused');
  old.close();
  const db = open(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.ok(fs.existsSync(`${file}.before-v${MIGRATIONS.length}`), 'the pre-migration copy');
  assert.deepEqual(db.prepare('SELECT kind, value FROM entity_identities ORDER BY id').all().map((r) => [r.kind, r.value]), [['name', 'ana silva'], ['email', 'ana@acme.io']]);
  db.exec("INSERT INTO entity_identities (entity_id, kind, value, created_at) VALUES ('e1', 'account', 'discord:1', 1)");
  assert.ok(db.prepare('SELECT account FROM note_speakers LIMIT 1').all() !== undefined, 'note_speakers.account exists');
  assert.throws(() => db.exec("INSERT INTO entity_identities (entity_id, kind, value, created_at) VALUES ('e1', 'nonsense', 'x', 1)"), /CHECK/);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ---- who is who ----
test('a voice named from a Discord call belongs to the person who holds that account, and a new person is made when nobody does', (t) => {
  const app = boot(t);
  call(app, 'Standup', [{ name: 'Ana Silva', account: 'discord:200' }, { name: 'Bruno', account: 'discord:300' }]);
  const people = app.knowledge.people();
  assert.deepEqual(people.map((p) => p.name).sort(), ['Ana Silva', 'Bruno']);
  const ana = app.knowledge.person('ana silva');
  assert.deepEqual(ana.identities.filter((i) => i.kind === 'account').map((i) => i.value), ['discord:200']);
});

test('renaming on Discord adds a name to the same person, never a new person', (t) => {
  const app = boot(t);
  call(app, 'Monday', [{ name: 'Ana Silva', account: 'discord:200' }]);
  call(app, 'Friday', [{ name: 'Ana S. (new nick)', account: 'discord:200' }]);
  const people = app.knowledge.people();
  assert.equal(people.length, 1, 'one person');
  assert.equal(people[0].meetings, 2);
  const names = app.knowledge.person(people[0].key).identities.filter((i) => i.kind === 'name').map((i) => i.value).sort();
  assert.equal(names.length, 2, 'both names are hers now');
});

test('the same name on two different accounts is two people (an account says who someone is; a name does not), with a merge proposed', (t) => {
  const app = boot(t);
  call(app, 'A', [{ name: 'Ana', account: 'discord:200' }]);
  call(app, 'B', [{ name: 'Ana', account: 'discord:999' }]);
  assert.equal(app.knowledge.people().length, 2);
  assert.equal(app.entities.proposals().length, 1);
});

test('a name that had no account yet takes the first account it is seen with', (t) => {
  const app = boot(t);
  call(app, 'Before', [{ name: 'Ana Silva' }]);
  call(app, 'After', [{ name: 'Ana Silva', account: 'discord:200' }]);
  const people = app.knowledge.people();
  assert.equal(people.length, 1);
  assert.deepEqual(app.knowledge.person('ana silva').identities.filter((i) => i.kind === 'account').map((i) => i.value), ['discord:200']);
});

test('a voice taught from a Discord call recognises the person in a later call by voice alone, with no Discord signal', (t) => {
  const app = boot(t);
  addVoice(app, 'v-ana', 'Ana Silva');
  call(app, 'Discord call', [{ name: 'Ana Silva', account: 'discord:200', voice: 'v-ana' }]);
  call(app, 'Phone call, nobody is named', [{ name: '', voice: 'v-ana' }]);
  const people = app.knowledge.people();
  assert.equal(people.length, 1);
  assert.equal(people[0].meetings, 2, 'the second meeting is hers');
});

test('merge and unmerge carry the account identities and undo exactly', (t) => {
  const app = boot(t);
  call(app, 'One', [{ name: 'Ana Silva', account: 'discord:200' }]);
  call(app, 'Two', [{ name: 'Ana Costa', account: 'discord:201' }]);
  const [a, b] = app.knowledge.people();
  const before = app.db.prepare('SELECT entity_id, kind, value FROM entity_identities ORDER BY id').all().map((r) => ({ ...r }));
  app.entities.merge(b.id, a.id);
  const merged = app.entities.identities(a.id).identities.filter((i) => i.kind === 'account').map((i) => i.value).sort();
  assert.deepEqual(merged, ['discord:200', 'discord:201'], 'both accounts are one person now');
  app.entities.unmerge(b.id);
  const after = app.db.prepare('SELECT entity_id, kind, value FROM entity_identities ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(after, before, 'put back exactly');
});

test('people views and the read-only MCP server show the account', (t) => {
  const app = boot(t);
  call(app, 'Standup', [{ name: 'Ana Silva', account: 'discord:200' }]);
  assert.ok(app.knowledge.person('ana silva').identities.some((i) => i.kind === 'account' && i.value === 'discord:200'));
  const { BrainReader } = require('../src/mcp/server');
  assert.deepEqual(new BrainReader(app.db).person({ name: 'Ana Silva' }).accounts, ['discord:200']);
});

// ---- recording: where the account comes from ----
function rig(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  class FakeEngine extends EventEmitter { async start() {} feed() {} async flush() {} reset() {} }
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerRefine: false, echoDedupe: false, speakerDiarize: false });
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-acct-rec-'));
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const hub = new SignalHub();
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir, diarization: { run: async () => ({ turns: [], voices: [] }) }, meet: hub });
  t.after(() => fs.rmSync(spoolDir, { recursive: true, force: true }));
  return { mgr, hub, notes, speakers, engine, n: notes.create({}) };
}
const speak = (ms) => Array.from({ length: Math.floor(ms / 500) }, (_, k) => ['w', k * 500, k * 500 + 400]);
const unit = (i, n = 8) => { const v = new Float32Array(n); v[i] = 1; return v; };
const SCRIPT = [[0, 0, 6000], [1, 6500, 12000], [0, 12500, 18000], [1, 18500, 24000]];

async function namedCall(t, platform) {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: true });
  r.mgr.pushPcm(r.n.id, 'system', Buffer.alloc(64000));
  SCRIPT.forEach(([v, a, b]) => r.engine.emit('segment', { ch: 'system', startMs: a, endMs: b, text: `voice ${v}`, words: speak(b - a), embedding: unit(v) }));
  r.hub.ingest({ type: 'roster', platform, participants: [{ name: 'Vasco', id: '100', self: true }, { name: 'Ana Silva', id: '200' }, { name: 'Bruno Costa', id: '300' }] }, { source: 'rpc', kind: 'rpc' });
  let now = 0;
  const at = (ms) => { t.mock.timers.tick(ms - now); now = ms; };
  const WHO = ['Ana Silva', 'Bruno Costa'];
  SCRIPT.forEach(([v, a, b]) => { at(a + 150); r.hub.ingest({ type: 'speaker', platform, name: WHO[v] }, { source: 'rpc', kind: 'rpc', lagMs: 150 }); at(b + 150); r.hub.ingest({ type: 'speaker', platform, name: null }, { source: 'rpc', kind: 'rpc', lagMs: 150 }); });
  await r.mgr.stop();
  const accounts = Object.fromEntries(r.speakers.forNote(r.n.id).filter((s) => s.channel === 'system').map((s) => [s.name, s.account]));
  return [accounts['Ana Silva'], accounts['Bruno Costa']];
}

test('recording: a voice named from the roster of a platform whose ids are accounts is linked to that account', async (t) => {
  assert.deepEqual(await namedCall(t, 'discord'), ['discord:200', 'discord:300']);
});

test('recording: ids of a platform that are not account ids (Meet\'s tiles) are never taken for accounts', async (t) => {
  assert.deepEqual(await namedCall(t, 'meet'), ['', '']);
});

test('recording: the Discord bot\'s per-person speakers point at the same account as the RPC source', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true });
  r.mgr.onDiscordAudio(r.mgr.active, { userId: '777', name: 'Dora', pcm: Buffer.alloc(3200), ts: Date.now() });
  const sp = r.speakers.forNote(r.n.id).find((s) => s.speakerId === 'd777');
  assert.deepEqual([sp.name, sp.account], ['Dora', 'discord:777']);
  await r.mgr.stop().catch(() => {});
});
