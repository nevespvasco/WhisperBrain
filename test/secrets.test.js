'use strict';
// Secrets at rest: Settings talks to a SecretBox (OS keystore in the app), keeps plaintext only in memory, and stores
// sealed values. A weak backend (Linux "basic_text") asks the person instead of pretending to protect anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { Settings, MASK } = require('../src/core/settings');
const { SecretBox } = require('../src/core/secret-box');

// A reversible stand-in for a keystore, async like the real one. strength: 'strong' | 'weak' | 'none'.
function fakeBox(strength = 'strong', kind = 'fake') {
  return new SecretBox({
    kind, strength,
    encrypt: async (s) => Buffer.from(`#${Buffer.from(s).reverse().toString('latin1')}`, 'latin1'),
    decrypt: async (b) => Buffer.from(b.toString('latin1').slice(1), 'latin1').reverse().toString(),
  });
}
const rows = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

function plaintextInstall() { // what an older version left behind
  const db = open(':memory:');
  const old = new Settings(db, null);
  old.update({ notion: { token: 'secret_notion_123' }, llm: { apiKey: 'sk-live-abc', baseUrl: 'http://x/v1' }, webhooks: [{ id: 'w1', url: 'https://h.example/x', secret: 'whsec_999' }], userName: 'Ana' });
  return db;
}

test('a keystore backend: existing plaintext secrets are sealed once, and still read back in memory', async () => {
  const db = plaintextInstall();
  assert.match(rows(db).notion, /secret_notion_123/, 'the old install holds it in the clear');
  const s = new Settings(db, null, fakeBox());
  await s.init();
  await s.flush();
  const stored = JSON.stringify(rows(db));
  for (const clear of ['secret_notion_123', 'sk-live-abc', 'whsec_999']) assert.ok(!stored.includes(clear), `${clear} is not at rest any more`);
  assert.match(rows(db).notion, /wbs1:/);
  assert.equal(s.get('notion').token, 'secret_notion_123');
  assert.equal(s.get('llm').apiKey, 'sk-live-abc');
  assert.equal(s.get('webhooks')[0].secret, 'whsec_999');
  assert.equal(s.get('llm').baseUrl, 'http://x/v1', 'non-secret fields stay readable');
  assert.equal(s.publicView().notion.token, MASK, 'the UI still only sees the mask');
  // next start: same box, sealed rows
  const again = new Settings(db, null, fakeBox());
  await again.init();
  assert.equal(again.get('notion').token, 'secret_notion_123');
  assert.equal(again.get('userName'), 'Ana');
});

test('a new or changed secret is sealed before it reaches the table; a masked write-back leaves it alone', async () => {
  const db = open(':memory:');
  const s = new Settings(db, null, fakeBox());
  await s.init();
  s.update({ linear: { apiKey: 'lin_api_777', teamId: 't1' } });
  assert.equal(s.get('linear').apiKey, 'lin_api_777', 'usable at once, before the write finishes');
  await s.flush();
  assert.ok(!rows(db).linear.includes('lin_api_777'));
  assert.ok(rows(db).linear.includes('t1'));
  s.update({ linear: { apiKey: MASK, teamId: 't2' } });
  await s.flush();
  assert.equal(s.get('linear').apiKey, 'lin_api_777');
  const fresh = new Settings(db, null, fakeBox());
  await fresh.init();
  assert.deepEqual([fresh.get('linear').apiKey, fresh.get('linear').teamId], ['lin_api_777', 't2']);
});

test('before init() a sealed value is never handed out as if it were the secret', async () => {
  const db = plaintextInstall();
  const s = new Settings(db, null, fakeBox());
  await s.init(); await s.flush();
  const cold = new Settings(db, null, fakeBox());
  assert.equal(cold.get('notion').token, '');
  assert.equal(cold.get('userName'), 'Ana');
});

// ---- a keystore that is no protection (Linux "basic_text") ----
test('weak backend: nothing is sealed or changed until the person chooses, and they are told', async () => {
  const db = plaintextInstall();
  const s = new Settings(db, null, fakeBox('weak', 'basic_text'));
  await s.init();
  assert.match(rows(db).notion, /secret_notion_123/, 'left exactly as it was');
  assert.equal(s.get('notion').token, 'secret_notion_123');
  const st = s.secretStatus();
  assert.deepEqual([st.needsChoice, st.warning, st.mode, st.policy], [true, 'weak-backend', 'plain', 'ask']);
});

test('weak backend, "keep plaintext": an explicit choice, no more warning, secrets stay readable and are written in the clear', async () => {
  const db = open(':memory:');
  const s = new Settings(db, null, fakeBox('weak', 'basic_text'));
  await s.init();
  s.update({ secretStorage: 'plaintext', notion: { token: 'secret_n' } });
  await s.flush();
  assert.equal(s.secretStatus().needsChoice, false);
  assert.match(rows(db).notion, /secret_n/);
});

test('weak backend, "do not save secrets": stored secrets are removed from disk, still usable until quit', async () => {
  const db = plaintextInstall();
  const s = new Settings(db, null, fakeBox('weak', 'basic_text'));
  await s.init();
  s.update({ secretStorage: 'never' });
  await s.flush();
  const stored = JSON.stringify(rows(db));
  for (const clear of ['secret_notion_123', 'sk-live-abc', 'whsec_999']) assert.ok(!stored.includes(clear), clear);
  assert.equal(s.get('notion').token, 'secret_notion_123', 'this session keeps working');
  s.update({ linear: { apiKey: 'lin_new' } });
  await s.flush();
  assert.ok(!rows(db).linear.includes('lin_new'));
  const next = new Settings(db, null, fakeBox('weak', 'basic_text'));
  await next.init();
  assert.equal(next.get('notion').token, '', 'gone after a restart, as chosen');
  assert.equal(next.get('llm').baseUrl, 'http://x/v1', 'everything that is not a secret stays');
});

test('no encryption available: same choice, same rules', async () => {
  const db = plaintextInstall();
  const s = new Settings(db, null, fakeBox('none', 'unavailable'));
  await s.init();
  assert.deepEqual([s.secretStatus().needsChoice, s.secretStatus().warning], [true, 'no-backend']);
  assert.equal(s.get('notion').token, 'secret_notion_123');
});

test('sealed values another keystore cannot open are neither guessed at nor overwritten', async () => {
  const db = plaintextInstall();
  const first = new Settings(db, null, fakeBox());
  await first.init(); await first.flush();
  const before = rows(db).notion;
  const broken = new SecretBox({ kind: 'other', strength: 'strong', encrypt: async (s) => Buffer.from(s), decrypt: async () => { throw new Error('wrong keystore'); } });
  const s = new Settings(db, null, broken);
  await s.init();
  assert.equal(s.get('notion').token, '');
  assert.ok(s.secretStatus().unreadable.includes('notion'));
  assert.equal(rows(db).notion, before, 'the sealed row is left for the keystore that can read it');
});

// ---- the real boxes ----
const { electronSecretBox, fileSecretBox } = require('../src/core/secret-box');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (t) => Buffer.from(`E:${t}`),
    decryptStringAsync: async (b) => ({ result: b.toString().slice(2), shouldReEncrypt: false }),
  };
}

test('electronSecretBox: the keystore decides the strength; Linux basic_text and "unknown" are weak', async () => {
  assert.equal(electronSecretBox(fakeSafeStorage(), 'linux').strength, 'strong');
  assert.equal(electronSecretBox(fakeSafeStorage({ backend: 'kwallet6' }), 'linux').strength, 'strong');
  assert.equal(electronSecretBox(fakeSafeStorage({ backend: 'basic_text' }), 'linux').strength, 'weak');
  assert.equal(electronSecretBox(fakeSafeStorage({ backend: 'unknown' }), 'linux').strength, 'weak');
  assert.equal(electronSecretBox(fakeSafeStorage({ backend: 'basic_text' }), 'darwin').strength, 'strong', 'the backend name only means something on Linux');
  assert.equal(electronSecretBox(fakeSafeStorage({ available: false }), 'win32').strength, 'none');
  const box = electronSecretBox(fakeSafeStorage(), 'linux');
  assert.equal(await box.open(await box.seal('hunter2')), 'hunter2');
});

test('fileSecretBox: round trip, a key file only the user can read, and tampering or a different key is refused', async () => {
  const dir = tmpDir('wb-key-');
  const file = path.join(dir, 'secret.key');
  const box = fileSecretBox(file);
  const sealed = await box.seal('hunter2');
  assert.ok(!sealed.includes('hunter2'));
  assert.equal(await box.open(sealed), 'hunter2');
  assert.equal(await fileSecretBox(file).open(sealed), 'hunter2', 'the key persists');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'no access for group or others');
  const flipped = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await assert.rejects(box.open(flipped));
  fs.rmSync(file);
  await assert.rejects(fileSecretBox(file).open(sealed), 'a new key cannot open the old seal');
  assert.equal(box.strength, 'fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- through the app ----
const { createApp } = require('../src/server/app');
const { DatabaseSync } = require('node:sqlite');

const quietPlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});

test('createApp with a SecretBox: ready when secrets are opened, reported in state(), sealed on disk after close', async () => {
  const dataDir = tmpDir('wb-sec-');
  const app = createApp({ dataDir, platform: quietPlatform(), secretBox: fakeBox('weak', 'basic_text') });
  await app.ready;
  assert.deepEqual([(await app.state()).secrets.needsChoice, (await app.state()).secrets.warning], [true, 'weak-backend']);
  app.settings.update({ secretStorage: 'plaintext' });
  app.close();
  await app.settled;
  const again = createApp({ dataDir, platform: quietPlatform(), secretBox: fakeBox() });
  await again.ready;
  again.settings.update({ notion: { token: 'secret_app_1' } });
  again.close();
  await again.settled;
  const raw = new DatabaseSync(path.join(dataDir, 'whisperbrain.sqlite'));
  const stored = raw.prepare("SELECT value FROM settings WHERE key = 'notion'").get().value;
  raw.close();
  assert.ok(stored.includes('wbs1:') && !stored.includes('secret_app_1'), 'the update made just before close still reached the disk, sealed');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('createApp without a SecretBox behaves as before', async () => {
  const dataDir = tmpDir('wb-sec-');
  const app = createApp({ dataDir, platform: quietPlatform() });
  await app.ready;
  app.settings.update({ notion: { token: 'plain_t' } });
  assert.equal((await app.state()).secrets.warning, null);
  app.close(); await app.settled;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- found in review ----
test('settings cannot be changed while sealed secrets are still being opened (a write would clobber them)', async () => {
  const db = plaintextInstall();
  const s = new Settings(db, null, fakeBox());
  assert.throws(() => s.update({ userName: 'Bia' }), /unlock|init/i);
  await s.init();
  s.update({ userName: 'Bia' });
  assert.equal(s.get('userName'), 'Bia');
});

test('startup work that reads secrets (extension pairing token) waits for them: a sealed token is not replaced by a new one', async () => {
  const dataDir = tmpDir('wb-sec-');
  const first = createApp({ dataDir, platform: quietPlatform(), secretBox: fakeBox() });
  await first.ready;
  first.settings.update({ meet: { ...first.settings.get('meet'), token: 'paired-token-123' } });
  first.close(); await first.settled;
  const app = createApp({ dataDir, platform: quietPlatform(), secretBox: fakeBox(), detect: true });
  await app.ready;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.settings.get('meet').token, 'paired-token-123');
  app.close(); await app.settled;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('"delete everything" is not undone by a secret that was still waiting to be written', async () => {
  const dataDir = tmpDir('wb-sec-');
  const app = createApp({ dataDir, platform: quietPlatform(), secretBox: fakeBox() });
  await app.ready;
  app.settings.update({ notion: { token: 'secret_late' } });   // sealed write still queued
  app.account.deleteEverything();
  await app.settings.flush();
  const stored = app.db.prepare('SELECT COUNT(*) c FROM settings').get().c;
  assert.equal(stored, 0, 'nothing came back');
  assert.equal(app.settings.get('notion').token, '', 'and the memory is clean too');
  app.close(); await app.settled;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('an unrelated edit does not wipe a sealed secret this keystore could not open', async () => {
  const db = plaintextInstall();
  const sealer = new Settings(db, null, fakeBox());
  await sealer.init(); await sealer.flush();
  const before = JSON.parse(rows(db).llm).apiKey;
  const broken = new SecretBox({ kind: 'other', strength: 'strong', encrypt: async (s) => Buffer.from(s), decrypt: async () => { throw new Error('wrong keystore'); } });
  const s = new Settings(db, null, broken);
  await s.init();
  s.update({ llm: { model: 'b' } });
  await s.flush();
  assert.equal(JSON.parse(rows(db).llm).apiKey, before, 'the sealed key is still there for the keystore that can read it');
  assert.equal(JSON.parse(rows(db).llm).model, 'b', 'the edit itself was saved');
  s.update({ llm: { apiKey: 'typed-again' } });
  await s.flush();
  assert.notEqual(JSON.parse(rows(db).llm).apiKey, before, 'typing a new key replaces it');
  assert.ok(!s.secretStatus().unreadable.includes('llm'));
});

test('a damaged webhooks row does not stop startup', async () => {
  const db = open(':memory:');
  db.prepare("INSERT INTO settings(key, value) VALUES('webhooks', '[null, 5]')").run();
  const s = new Settings(db, null, fakeBox());
  await s.init();
  assert.deepEqual(s.get('webhooks'), []);
});

test('fileSecretBox: only a missing key file is created; any other read error stops instead of replacing the key', async () => {
  const dir = tmpDir('wb-key-');
  const file = path.join(dir, 'secret.key');
  fs.writeFileSync(file, Buffer.alloc(5));                         // damaged: wrong length
  await assert.rejects(fileSecretBox(file).seal('x'), /not a valid key file/);
  assert.equal(fs.readFileSync(file).length, 5, 'the damaged file was left alone');
  fs.rmSync(file); fs.mkdirSync(file);                              // reading a directory fails with EISDIR, not ENOENT
  await assert.rejects(fileSecretBox(file).seal('x'));
  assert.ok(fs.statSync(file).isDirectory(), 'nothing was overwritten');
  fs.rmSync(dir, { recursive: true, force: true });
});
