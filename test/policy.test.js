'use strict';
// Admin policy: a read-only file (/etc/whisperbrain/policy.json, %ProgramData%, /Library/Application Support) that an organisation
// puts on a computer to fix some settings: voice prints off, the AI model kept on local servers, how long meetings are kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../src/core/db');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { Account } = require('../src/core/account');
const { loadPolicy, policyFiles } = require('../src/core/policy');
const { tmpDir } = require('./helpers');

function policyFile(obj) {
  const dir = tmpDir('wb-policy-');
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('policyFiles: where each OS looks, and WB_POLICY_FILE wins', () => {
  assert.deepEqual(policyFiles({ platform: 'linux', env: {} }), ['/etc/whisperbrain/policy.json']);
  assert.deepEqual(policyFiles({ platform: 'darwin', env: {} }), ['/Library/Application Support/WhisperBrain/policy.json']);
  assert.deepEqual(policyFiles({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' } }), [path.win32.join('C:\\ProgramData', 'WhisperBrain', 'policy.json')]);
  assert.deepEqual(policyFiles({ platform: 'linux', env: { WB_POLICY_FILE: '/x/p.json' } }), ['/x/p.json']);
});

test('loadPolicy: no file is no policy; a broken file is reported and locks nothing; unknown keys are reported', () => {
  assert.deepEqual(loadPolicy({ files: ['/nonexistent/policy.json'] }).locked, {});
  const bad = policyFile('{ not json');
  const r = loadPolicy({ files: [bad.file] });
  assert.deepEqual(r.locked, {});
  assert.match(r.problems[0], /could not be read/);
  bad.done();
  const odd = policyFile({ lock: { 'meet.learnVoices': false, 'nope.key': 1, 'meet.nope': 2 } });
  const o = loadPolicy({ files: [odd.file] });
  assert.deepEqual(o.locked, { 'meet.learnVoices': false });
  assert.equal(o.problems.length, 2);
  odd.done();
});

test('a locked setting has the policy\'s value whatever was stored, and refuses to be changed', () => {
  const p = policyFile({ lock: { 'meet.learnVoices': false, voiceprints: false, retentionDays: 90 } });
  const db = open(':memory:');
  db.prepare("INSERT INTO settings(key, value) VALUES('meet', ?)").run(JSON.stringify({ ...new Settings(open(':memory:'), null).get('meet'), learnVoices: true }));
  const s = new Settings(db, null, null, loadPolicy({ files: [p.file] }));
  assert.equal(s.get('meet').learnVoices, false, 'stored as true, the policy says false');
  assert.equal(s.get('voiceprints'), false);
  assert.equal(s.get('retentionDays'), 90);
  assert.throws(() => s.update({ meet: { learnVoices: true } }), /learnVoices is managed by your organisation/);
  assert.throws(() => s.update({ voiceprints: true }), /voiceprints is managed/);
  s.update({ meet: { headcount: false }, userName: 'Ana' });                      // everything else is theirs to change
  assert.equal(s.get('meet').headcount, false);
  assert.equal(s.get('meet').learnVoices, false);
  s.update({ meet: { learnVoices: false } });                                      // saying what the policy says is not a change
  assert.deepEqual(s.publicView().managed.sort(), ['meet.learnVoices', 'retentionDays', 'voiceprints']);
  p.done();
});

test('requireLocalLlm: only this computer or the local network may be the AI server', () => {
  const p = policyFile({ requireLocalLlm: true });
  const s = new Settings(open(':memory:'), null, null, loadPolicy({ files: [p.file] }));
  for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://192.168.1.20:1234/v1', 'http://10.0.0.5/v1', 'http://gpu-box.local:8000/v1', '']) s.update({ llm: { baseUrl: ok } });
  for (const bad of ['https://api.openai.com/v1', 'http://example.com/v1', 'http://8.8.8.8/v1', 'http://localhost.evil.com/v1']) assert.throws(() => s.update({ llm: { baseUrl: bad } }), /local/i, bad);
  assert.equal(s.get('llm').baseUrl, '');
  assert.deepEqual(s.publicView().managed, ['llm.baseUrl (local servers only)']);
  p.done();
});

test('voiceprints off: nothing is saved, and saved voices are not matched', () => {
  const db = open(':memory:');
  const notes = new Notes(db, null);
  const speakers = new Speakers(db, null);
  const v = (seed) => { const a = new Float32Array(32); let x = seed * 9301 + 49297; for (let i = 0; i < 32; i++) { x = (x * 9301 + 49297) % 233280; a[i] = x / 233280 - 0.5; } return a; };
  const meet = () => { const n = notes.create({}); speakers.save(n.id, { speakerId: 's1', channel: 'system', centroid: v(1), count: 5 }); notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 12000, text: 'x' }]); return n; };
  const first = meet();
  speakers.rename(first.id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  assert.equal(speakers.voices().length, 1);
  let on = false;
  speakers.enabled = () => on;
  const second = meet();
  assert.equal(speakers.autoMatch(second.id), 0, 'not recognised while off');
  speakers.rename(second.id, 's1', 'Bruno', { remember: true, consentSource: 'user' });
  assert.equal(speakers.forNote(second.id)[0].name, 'Bruno', 'the person can still name a speaker for this meeting');
  assert.equal(speakers.voices().length, 1, 'but no voice was saved');
  speakers.nameFromMeeting(second.id, 's1', 'Ana');
  assert.equal(speakers.learnFromMeeting(second.id, 's1', { consent: true }), false);
  on = true;
  assert.equal(speakers.autoMatch(meet().id), 1, 'back on: recognised again');
});

test('retention: meetings older than the limit are deleted, newer and unfinished ones are not, and 0 keeps everything', () => {
  const db = open(':memory:');
  const notes = new Notes(db, null);
  const DAY = 86400000, now = 1_800_000_000_000;
  const mk = (title, ageDays, extra = {}) => { const n = notes.create({ title }); db.prepare('UPDATE notes SET created_at = ?, ended_at = ? WHERE id = ?').run(now - ageDays * DAY, extra.ended === false ? null : now - ageDays * DAY, n.id); return n; };
  const old = mk('old', 120), recent = mk('recent', 10), edge = mk('edge', 89), recording = mk('still recording', 200, { ended: false });
  db.prepare("UPDATE notes SET status = 'recording' WHERE id = ?").run(recording.id);
  const account = new Account({ db, notes, settings: { reset() {} }, speakers: new Speakers(db, null), models: { catalog: [] }, bus: null });
  assert.equal(account.applyRetention({ days: 0, now }), 0);
  assert.equal(notes.get(old.id) !== null, true);
  assert.equal(account.applyRetention({ days: 90, now }), 1);
  assert.equal(notes.get(old.id), null);
  assert.ok(notes.get(recent.id) && notes.get(edge.id) && notes.get(recording.id));
});

test('the app reads the policy at start: state() says what is managed, and old meetings are swept', async () => {
  const { createApp } = require('../src/server/app');
  const p = policyFile({ lock: { retentionDays: 30 } });
  const dataDir = tmpDir('wb-app-');
  const quiet = { id: 'fake', session: 't', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null };
  const first = createApp({ dataDir, platform: quiet, policy: loadPolicy({ files: [] }) });
  const old = first.notes.create({ title: 'old' });
  first.db.prepare('UPDATE notes SET created_at = ?, ended_at = ? WHERE id = ?').run(Date.now() - 100 * 86400000, Date.now() - 100 * 86400000, old.id);
  first.close(); await first.settled;
  const app = createApp({ dataDir, platform: quiet, policy: loadPolicy({ files: [p.file] }) });
  await app.ready; await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual((await app.state()).policy.managed, ['retentionDays']);
  assert.equal(app.notes.get(old.id), null, 'older than 30 days: gone');
  app.close(); await app.settled;
  fs.rmSync(dataDir, { recursive: true, force: true }); p.done();
});
