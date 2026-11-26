'use strict';
// People as entities (src/graph/entities.js): identities decide who someone is, a name alone is weak, merges are proposals that a
// person decides and can undo, and the People pages keep reading the same shape (docs/adr/0001-brain-data-model.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const boot = (t) => {
  const dataDir = tmpDir('wb-ent-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return app;
};
// a meeting where these people spoke (names) and/or were invited ({ name, email })
function meeting(app, title, { spoke = [], invited = [], voice = {} } = {}) {
  const n = app.notes.create({ title, attendees: invited });
  spoke.forEach((name, i) => {
    const sid = `s${i + 1}`;
    app.db.prepare("INSERT INTO note_speakers (note_id, speaker_id, channel, name, voice_id, count) VALUES (?, ?, 'system', ?, ?, 1)").run(n.id, sid, name, voice[name] || null);
    app.notes.addSegments(n.id, [{ speaker: 'them', speakerId: sid, text: `${name} talking about the plan`, startMs: i * 5000, endMs: i * 5000 + 4000, channel: 'system' }]);
  });
  return n;
}
const addVoice = (app, id, name) => app.db.prepare('INSERT INTO voices (id, name, embedding, samples, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)').run(id, name, Buffer.alloc(4));

test('a person is one entity across meetings, with the same list shape the pages read', (t) => {
  const app = boot(t);
  meeting(app, 'Roadmap', { spoke: ['Ana Silva', 'Rui'], invited: [{ name: 'Ana Silva', email: 'ana@acme.io' }] });
  meeting(app, 'Budget', { spoke: ['Ana Silva'] });
  const people = app.knowledge.people();
  const ana = people.find((p) => p.name === 'Ana Silva');
  assert.deepEqual([ana.meetings, ana.emails, ana.isMe], [2, ['ana@acme.io'], false]);
  assert.deepEqual(Object.keys(ana).sort(), ['emails', 'id', 'isMe', 'key', 'lastAt', 'meetings', 'name', 'talkMs']);
  assert.equal(ana.talkMs, 8000);
  assert.equal(people.filter((p) => p.name === 'Ana Silva').length, 1, 'one person, not one per meeting');
  assert.equal(app.knowledge.person('ana silva').notes.length, 2);
  assert.equal(app.knowledge.person('ANA SILVA').id, ana.id, 'the key is matched the way it always was');
});

test('placeholders are not people, and "me" is you', (t) => {
  const app = boot(t);
  app.settings.update({ userName: 'Alex' });
  const n = meeting(app, 'Call', { spoke: ['Speaker 1', 'Orador 2', 'Unknown'] });
  app.db.prepare("INSERT INTO note_speakers (note_id, speaker_id, channel, name, count) VALUES (?, 'm1', 'mic', '', 1)").run(n.id);
  app.entities.markDirty(n.id);
  const people = app.knowledge.people();
  assert.deepEqual(people.map((p) => p.name), ['Alex']);
  assert.equal(people[0].isMe, true);
});

test('the same e-mail is the same person whatever the name says; the same name with a different e-mail is NOT merged', (t) => {
  const app = boot(t);
  const e = app.entities;
  const a = e.resolve({ name: 'Ana Silva', email: 'ana@acme.io' });
  assert.equal(e.resolve({ name: 'A. Silva', email: 'ANA@acme.io' }), a, 'an e-mail is a strong identifier');
  assert.equal(e.resolve({ name: 'Ana Silva' }), a, 'a known name finds them');
  const other = e.resolve({ name: 'Ana Silva', email: 'ana@other.com' });
  assert.notEqual(other, a, 'two Anas with different e-mails are two people');
  assert.equal(e.resolve({ name: 'Ana Silva', email: 'ana@other.com' }), other, 'and each is found again by their e-mail');
  const keys = app.db.prepare('SELECT key FROM entities ORDER BY created_at').all().map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'every person has a key of their own');
  const open = app.db.prepare("SELECT reason FROM entity_proposals WHERE state = 'open'").all().map((r) => r.reason);
  assert.ok(open.includes('same name, different e-mail'), 'a person is asked, not told');
});

test('the same voice under two names is proposed, and accepting merges them (the one in more meetings stays)', (t) => {
  const app = boot(t);
  addVoice(app, 'v1', 'Ana');
  meeting(app, 'One', { spoke: ['Ana'], voice: { Ana: 'v1' } });
  meeting(app, 'Two', { spoke: ['Ana'], voice: { Ana: 'v1' } });
  meeting(app, 'Three', { spoke: ['Joana'], voice: { Joana: 'v1' } });
  const props = app.entities.proposals();
  assert.equal(props.length, 1);
  assert.equal(props[0].reason, 'the same voice under two names');
  const [a, b] = [props[0].a, props[0].b].sort((x, y) => y.meetings - x.meetings);
  const done = app.entities.decide(props[0].id, 'accept');
  assert.equal(done.into.id, a.id, 'the person with more meetings survives');
  const people = app.knowledge.people();
  assert.equal(people.length, 1);
  assert.equal(people[0].meetings, 3, 'all three meetings are theirs now');
  assert.equal(app.knowledge.person(b.key).id, a.id, 'the old link to the other name still works');
  assert.equal(app.entities.proposals().length, 0);
});

test('a merge can be undone exactly, and an undone merge is never proposed again', (t) => {
  const app = boot(t);
  meeting(app, 'One', { spoke: ['Ana Silva'], invited: [{ name: 'Ana Silva', email: 'ana@acme.io' }] });
  meeting(app, 'Two', { spoke: ['Ana'], invited: [{ name: 'Ana', email: 'ana@acme.io' }] });
  meeting(app, 'Three', { spoke: ['Ana'] });
  const before = app.knowledge.people().map((p) => ({ name: p.name, meetings: p.meetings })).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(before, [{ name: 'Ana Silva', meetings: 3 }], 'the invite with her e-mail made "Ana" and "Ana Silva" one person');
  // two separate people that a person decides are the same
  const x = app.entities.resolve({ name: 'Zé' }), y = app.entities.resolve({ name: 'José', email: 'jose@x.pt' });
  const n = meeting(app, 'Four', { spoke: ['Zé', 'José'] });
  app.entities.markDirty(n.id);
  assert.equal(app.knowledge.people().filter((p) => ['Zé', 'José'].includes(p.name)).length, 2);
  const m = app.entities.merge(x, y);
  assert.equal(app.knowledge.people().filter((p) => ['Zé', 'José'].includes(p.name)).length, 1);
  assert.ok(app.knowledge.person('jose').identities.some((i) => i.kind === 'name' && i.value === 'ze'), 'their identities moved');
  assert.equal(app.knowledge.person('jose').merged[0].id, x, 'and the page says who was merged in, so it can be undone');
  app.entities.unmerge(x);
  assert.deepEqual(app.knowledge.people().filter((p) => ['Zé', 'José'].includes(p.name)).map((p) => [p.name, p.meetings]).sort(), [['José', 1], ['Zé', 1]]);
  assert.equal(app.knowledge.person('ze').emails.length, 0, 'each kept only what was theirs');
  assert.equal(app.knowledge.person('jose').emails[0], 'jose@x.pt');
  assert.throws(() => app.entities.unmerge(x), /nothing to undo/);
  assert.ok(m.mergeId > 0);
  const st = app.db.prepare('SELECT state FROM entity_proposals WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)').get(x, y, y, x);
  assert.equal(st.state, 'rejected', 'undoing a merge says "not the same": it is not proposed again');
});

test('"Ana" next to "Ana Silva" is a suggestion; rejecting it is remembered', (t) => {
  const app = boot(t);
  meeting(app, 'One', { spoke: ['Ana', 'Ana Silva'] });
  const p = app.entities.proposals();
  assert.equal(p.length, 1);
  assert.equal(p[0].reason, 'a first name that matches');
  assert.equal(app.knowledge.people().length, 2, 'nothing is merged without a person saying so');
  app.entities.decide(p[0].id, 'reject');
  const n = meeting(app, 'Two', { spoke: ['Ana', 'Ana Silva'] });
  app.entities.markDirty(n.id);
  assert.equal(app.entities.proposals().length, 0, 'not asked again');
  assert.equal(app.knowledge.people().length, 2);
});

test('mentions follow the meetings: renaming a speaker moves them, deleting a meeting drops them, and people nobody is with are gone', (t) => {
  const app = boot(t);
  const n = meeting(app, 'One', { spoke: ['Rui'] });
  assert.equal(app.knowledge.people().length, 1);
  app.db.prepare("UPDATE note_speakers SET name = 'Rui Costa' WHERE note_id = ? AND speaker_id = 's1'").run(n.id);
  app.bus.publish('speakers.updated', { noteId: n.id });
  assert.deepEqual(app.knowledge.people().map((p) => p.name), ['Rui Costa']);
  app.notes.remove(n.id);
  assert.equal(app.knowledge.people().length, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM entities').get().c, 0, 'no orphan people are kept');
});

test('the start-up backfill builds people from meetings made before entities existed, and is safe to run twice', (t) => {
  const app = boot(t);
  meeting(app, 'Old one', { spoke: ['Ana Silva'], invited: [{ name: 'Rui', email: 'rui@x.pt' }] });
  meeting(app, 'Old two', { spoke: ['Ana Silva'] });
  app.db.exec('DELETE FROM mentions; DELETE FROM entity_proposals; DELETE FROM entity_identities; DELETE FROM entities;');
  app.entities.dirty.clear();
  let after = 0, rounds = 0;
  for (let next; (next = app.entities.backfillBatch(after, 1)) != null; after = next) rounds++;
  assert.equal(rounds, 2, 'in small chunks');
  const first = app.knowledge.people().map((p) => [p.name, p.meetings]).sort();
  assert.deepEqual(first, [['Ana Silva', 2], ['Rui', 1]]);
  assert.equal(app.entities.backfillBatch(0, 100), null, 'nothing left to do');
  assert.deepEqual(app.knowledge.people().map((p) => [p.name, p.meetings]).sort(), first);
});

test('the People API: proposals, accept, merge, undo', async (t) => {
  const app = boot(t);
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(() => srv.close());
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  meeting(app, 'One', { spoke: ['Ana', 'Ana Silva'] });
  const props = (await call('GET', '/api/people/proposals')).body;
  assert.equal(props.length, 1, '/api/people/proposals is not read as a person called "proposals"');
  assert.equal((await call('GET', '/api/people/ana')).status, 200);
  const merged = await call('POST', `/api/people/proposals/${props[0].id}/accept`);
  assert.equal(merged.body.state, 'accepted');
  const people = (await call('GET', '/api/people')).body;
  assert.equal(people.length, 1);
  const gone = [props[0].a, props[0].b].find((x) => x.id !== merged.body.into.id);
  assert.equal((await call('POST', `/api/entities/${gone.id}/unmerge`)).status, 200);
  assert.equal((await call('GET', '/api/people')).body.length, 2);
  assert.equal((await call('POST', `/api/entities/${gone.id}/unmerge`)).status, 404);
  assert.equal((await call('POST', '/api/people/proposals/999/accept')).status, 404);
  assert.equal((await call('POST', `/api/people/proposals/${props[0].id}/maybe`)).status, 400, 'only accept or reject');
});

test('after a merge the fuller name is shown, and undoing brings the other name back', (t) => {
  const app = boot(t);
  meeting(app, 'One', { spoke: ['Ana'] });
  meeting(app, 'Two', { spoke: ['Ana'] });
  meeting(app, 'Three', { spoke: ['Ana Silva'] });
  const [p] = app.entities.proposals();
  const res = app.entities.decide(p.id, 'accept');
  assert.equal(res.into.name, 'Ana Silva', 'the more complete name wins even when "Ana" is in more meetings');
  assert.equal(app.knowledge.people()[0].key, 'ana', 'the URL key of the survivor does not change');
  const gone = [p.a, p.b].find((x) => x.id !== res.into.id);
  app.entities.unmerge(gone.id);
  assert.deepEqual(app.knowledge.people().map((x) => x.name).sort(), ['Ana', 'Ana Silva']);
});
