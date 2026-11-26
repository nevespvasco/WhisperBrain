'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, MIGRATIONS } = require('../src/core/db');
const { tmpDir } = require('./helpers');

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

test('migration v13: a v12 database gains briefings, note links and assistant events, keeping its notes', () => {
  const dir = tmpDir('wb-brief-');
  const file = path.join(dir, 'v12.db');
  const old = new DatabaseSync(file);
  for (let v = 0; v < 12; v++) old.exec(MIGRATIONS[v]);
  old.exec('PRAGMA user_version = 12');
  old.prepare("INSERT INTO notes (id, title, created_at, updated_at) VALUES ('n1', 'Kept', 1, 1)").run();
  old.close();
  const db = open(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    for (const t of ['briefings', 'note_briefings', 'assistant_events']) assert.ok(tables(db).includes(t), t);
    assert.equal(db.prepare("SELECT title FROM notes WHERE id = 'n1'").get().title, 'Kept');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration v14: briefings of the kinds that are gone become notes, the others and their text are kept', () => {
  const dir = tmpDir('wb-brief-');
  const file = path.join(dir, 'v13.db');
  const old = new DatabaseSync(file);
  for (let v = 0; v < 13; v++) old.exec(MIGRATIONS[v]);
  old.exec('PRAGMA user_version = 13');
  const add = old.prepare("INSERT INTO briefings (id, title, kind, text, created_at, updated_at) VALUES (?, ?, ?, 'kept', 1, 1)");
  for (const [id, kind] of [['a', 'resume'], ['b', 'job'], ['c', 'project'], ['d', 'company']]) add.run(id, id.toUpperCase(), kind);
  old.close();
  const db = open(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const kinds = Object.fromEntries(db.prepare('SELECT id, kind FROM briefings').all().map((r) => [r.id, r.kind]));
    assert.deepEqual(kinds, { a: 'notes', b: 'notes', c: 'project', d: 'company' });
    assert.equal(db.prepare("SELECT count(*) AS c FROM briefings WHERE text = 'kept'").get().c, 4);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the store ----------
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Briefings } = require('../src/knowledge/briefings');

function stores() {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  return { db, bus, events, notes: new Notes(db, bus), briefings: new Briefings({ db, bus }) };
}

const CLIENT = `Acme Robotics, client brief.
Acme Robotics builds warehouse automation. Our team runs the fleet scheduler and the telemetry pipeline for them.
Stack: Kubernetes, PostgreSQL, event sourcing. Kubernetes in production since March. PostgreSQL tuning.
The fleet scheduler talks to every robot; the telemetry pipeline ingests sensor data. Acme Robotics values event sourcing.`;

test('create and get: a briefing keeps its title, kind and text', () => {
  const { briefings } = stores();
  const b = briefings.create({ title: 'Acme brief', kind: 'client', text: CLIENT });
  assert.ok(b.id);
  assert.equal(b.title, 'Acme brief');
  assert.equal(b.kind, 'client');
  assert.equal(b.text, CLIENT);
  assert.ok(b.createdAt > 0 && b.updatedAt >= b.createdAt);
  assert.deepEqual(briefings.get(b.id), b);
  assert.equal(briefings.get('nope'), null);
});

test('terms: extracted offline from the text, at most 40, none longer than 40 characters', () => {
  const { briefings } = stores();
  const b = briefings.create({ title: 'Acme brief', kind: 'client', text: CLIENT });
  for (const want of ['Kubernetes', 'PostgreSQL', 'Acme Robotics']) assert.ok(b.terms.includes(want), `${want} in ${JSON.stringify(b.terms)}`);
  const long = Array.from({ length: 300 }, (_, i) => `Project${i.toString(36)}x Zeta${i.toString(36)}q. Project${i.toString(36)}x Zeta${i.toString(36)}q.`).join('\n');
  const many = briefings.create({ title: 'big', text: long });
  assert.ok(many.terms.length > 0 && many.terms.length <= 40, `${many.terms.length} terms`);
  assert.ok(many.terms.every((t) => t.length <= 40));
  assert.deepEqual(briefings.create({ title: 'empty' }).terms, []);
});

test('list: every briefing with its size and terms but not the full text, most recently changed first', () => {
  const { briefings } = stores();
  const a = briefings.create({ title: 'A', text: CLIENT });
  const b = briefings.create({ title: 'B', kind: 'agenda', text: 'Intro' });
  const list = briefings.list();
  assert.deepEqual(list.map((x) => x.id).sort(), [a.id, b.id].sort());
  const la = list.find((x) => x.id === a.id);
  assert.equal(la.size, CLIENT.length);
  assert.equal(la.text, undefined);
  assert.deepEqual(la.terms, a.terms);
  assert.equal(list.find((x) => x.id === b.id).kind, 'agenda');
});

test('update: changes title and kind, recomputes terms only when the text changes; unknown id → null', () => {
  const { briefings } = stores();
  const b = briefings.create({ title: 'Acme brief', kind: 'client', text: CLIENT });
  const renamed = briefings.update(b.id, { title: 'Acme account', kind: 'company' });
  assert.equal(renamed.title, 'Acme account');
  assert.equal(renamed.kind, 'company');
  assert.equal(renamed.text, CLIENT);
  assert.deepEqual(renamed.terms, b.terms);
  const rewritten = briefings.update(b.id, { text: 'Grafana dashboards. Grafana alerts. Terraform modules and Terraform state.' });
  assert.ok(rewritten.terms.includes('Grafana') && !rewritten.terms.includes('Kubernetes'), JSON.stringify(rewritten.terms));
  assert.equal(briefings.get(b.id).title, 'Acme account');
  assert.equal(briefings.update('nope', { title: 'x' }), null);
});

test('kinds: project, agenda, client, company or notes (the default); anything else is refused', () => {
  const { briefings } = stores();
  assert.equal(briefings.create({ title: 'x' }).kind, 'notes');
  for (const kind of ['project', 'agenda', 'client', 'company', 'notes']) assert.equal(briefings.create({ kind }).kind, kind);
  assert.throws(() => briefings.create({ kind: 'diary' }), (e) => e.status === 400 && /kind/.test(e.message));
  assert.throws(() => briefings.create({ kind: 'job' }), (e) => e.status === 400, 'a kind that is gone');
  const b = briefings.create({});
  assert.throws(() => briefings.update(b.id, { kind: 'diary' }), (e) => e.status === 400);
  assert.throws(() => briefings.create({ text: { not: 'text' } }), (e) => e.status === 400 && /text/.test(e.message));
  assert.equal(briefings.list().length, 7, 'nothing half-created');
});

test('text is capped at 200k characters, on create and on update', () => {
  const { briefings } = stores();
  const huge = 'word '.repeat(50000) + 'tail';
  const b = briefings.create({ text: huge });
  assert.equal(b.text.length, 200000);
  assert.equal(briefings.update(b.id, { text: huge + ' more' }).text.length, 200000);
});

const PROJECT = `Payments gateway — project notes.
Kubernetes operators in Go. Kubernetes upgrades. Built the Lisbon payments gateway with PostgreSQL and Kafka.
Kafka streams for the Lisbon payments gateway.`;

test('attach to a note: setForNote replaces the set, forNote lists full briefings, termsForNote is their deduplicated union', () => {
  const { notes, briefings } = stores();
  const n = notes.create({ title: 'Project review' });
  const client = briefings.create({ title: 'Acme brief', kind: 'client', text: CLIENT });
  const proj = briefings.create({ title: 'Payments gateway', kind: 'project', text: PROJECT });
  const other = briefings.create({ title: 'Other', text: 'Unrelated Zebra notes. Zebra.' });
  assert.deepEqual(briefings.forNote(n.id), []);
  assert.deepEqual(briefings.termsForNote(n.id), []);
  briefings.setForNote(n.id, [client.id, other.id]);
  briefings.setForNote(n.id, [client.id, proj.id, client.id]);
  const attached = briefings.forNote(n.id);
  assert.deepEqual(attached.map((b) => b.id).sort(), [client.id, proj.id].sort());
  assert.equal(attached.find((b) => b.id === proj.id).text, PROJECT, 'full objects');
  const terms = briefings.termsForNote(n.id);
  for (const want of ['Kubernetes', 'PostgreSQL', 'Acme Robotics', 'Kafka']) assert.ok(terms.includes(want), `${want} in ${JSON.stringify(terms)}`);
  assert.equal(terms.filter((t) => t.toLowerCase() === 'kubernetes').length, 1, 'deduplicated');
  assert.ok(!terms.includes('Zebra'));
  briefings.setForNote(n.id, []);
  assert.deepEqual(briefings.forNote(n.id), []);
});

test('attach: an unknown briefing or note is refused with 404 and the links stay as they were', () => {
  const { notes, briefings } = stores();
  const n = notes.create({});
  const b = briefings.create({ title: 'A' });
  briefings.setForNote(n.id, [b.id]);
  assert.throws(() => briefings.setForNote(n.id, [b.id, 'nope']), (e) => e.status === 404 && /briefing/.test(e.message));
  assert.throws(() => briefings.setForNote('nope', [b.id]), (e) => e.status === 404 && /note/.test(e.message));
  assert.throws(() => briefings.setForNote(n.id, 'not a list'), (e) => e.status === 400);
  assert.deepEqual(briefings.forNote(n.id).map((x) => x.id), [b.id]);
});

test('remove: the briefing and its links to notes go; unknown id → false', () => {
  const { notes, briefings } = stores();
  const n = notes.create({});
  const a = briefings.create({ title: 'A', text: CLIENT });
  const b = briefings.create({ title: 'B', text: PROJECT });
  briefings.setForNote(n.id, [a.id, b.id]);
  assert.equal(briefings.remove(a.id), true);
  assert.equal(briefings.get(a.id), null);
  assert.deepEqual(briefings.forNote(n.id).map((x) => x.id), [b.id]);
  assert.equal(briefings.remove(a.id), false);
});

test('deleting a note takes its briefing links and assistant events with it, the briefings stay', () => {
  const { db, notes, briefings } = stores();
  const n = notes.create({});
  const b = briefings.create({ title: 'A', text: CLIENT });
  briefings.setForNote(n.id, [b.id]);
  db.prepare("INSERT INTO assistant_events (note_id, kind, question, text, created_at) VALUES (?, 'answer', 'q', 'a', 1)").run(n.id);
  notes.remove(n.id);
  assert.equal(db.prepare('SELECT count(*) AS c FROM note_briefings').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) AS c FROM assistant_events').get().c, 0);
  assert.ok(briefings.get(b.id));
});

test('every change publishes briefings.changed; reads and failed changes do not', () => {
  const { notes, briefings, events } = stores();
  const n = notes.create({});
  const changed = () => events.filter((e) => e.type === 'briefings.changed');
  const b = briefings.create({ title: 'A' });
  assert.equal(changed().length, 1);
  assert.equal(changed()[0].data.id, b.id);
  briefings.update(b.id, { title: 'B' });
  briefings.setForNote(n.id, [b.id]);
  assert.equal(changed().at(-1).data.noteId, n.id);
  briefings.remove(b.id);
  assert.equal(changed().length, 4);
  briefings.list(); briefings.get(b.id); briefings.forNote(n.id);
  briefings.update('nope', { title: 'x' }); briefings.remove('nope');
  assert.throws(() => briefings.create({ kind: 'bad' }));
  assert.equal(changed().length, 4);
});

// ---------- import ----------
test('import Markdown or plain text: the file name without its extension is the title, the text is kept', async () => {
  const { briefings, events } = stores();
  const md = await briefings.importFile('Acme Robotics.md', Buffer.from(`# Acme Robotics\n\n${CLIENT}\n`, 'utf8'));
  assert.equal(md.title, 'Acme Robotics');
  assert.equal(md.kind, 'notes');
  assert.match(md.text, /fleet scheduler/);
  assert.ok(md.terms.includes('Kubernetes'));
  const txt = await briefings.importFile('agenda.v2.txt', Buffer.from('﻿Intro\r\nRoadmap\r\n', 'utf8'));
  assert.equal(txt.title, 'agenda.v2');
  assert.equal(txt.text, 'Intro\nRoadmap');
  assert.equal(briefings.list().length, 2);
  assert.ok(events.some((e) => e.type === 'briefings.changed' && e.data.id === txt.id));
});

test('import: every imported file is notes, whatever its name or text (the kind can be changed afterwards)', async () => {
  const { briefings } = stores();
  const kindOf = async (name, text) => (await briefings.importFile(name, Buffer.from(text, 'utf8'))).kind;
  assert.equal(await kindOf('Payments gateway project.md', PROJECT), 'notes');
  assert.equal(await kindOf('Acme client.md', CLIENT), 'notes');
  assert.equal(await kindOf('agenda.txt', '# Kickoff\n\n## Agenda\n\nIntro\nRoadmap\n'), 'notes');
  assert.equal(await kindOf('company.txt', 'Acme Robotics, founded 2015.'), 'notes');
});

test('import HTML: the visible text, without tags, scripts or styles', async () => {
  const { briefings } = stores();
  const html = '<!doctype html><html><head><title>Acme</title><style>p{color:red}</style></head><body><h1>Acme Robotics</h1><p>Fleet &amp; telemetry.</p><script>alert(1)</script></body></html>';
  const b = await briefings.importFile('acme.html', Buffer.from(html, 'utf8'));
  assert.equal(b.title, 'acme');
  assert.match(b.text, /Acme Robotics/);
  assert.match(b.text, /Fleet & telemetry\./);
  assert.doesNotMatch(b.text, /<|alert|color:red/);
});

const FIX = path.join(__dirname, 'fixtures', 'briefings');

test('import DOCX (fixture): paragraphs and headings become text, terms come from it', async () => {
  const { briefings } = stores();
  const b = await briefings.importFile('client.docx', fs.readFileSync(path.join(FIX, 'client.docx')));
  assert.equal(b.title, 'client');
  assert.equal(b.kind, 'notes');
  assert.match(b.text, /^# Acme Robotics - client brief/);
  assert.match(b.text, /fleet scheduler and the telemetry pipeline/);
  assert.doesNotMatch(b.text, /<w:/);
  for (const want of ['Fleet scheduler', 'Telemetry pipeline', 'PostgreSQL']) assert.ok(b.terms.includes(want), `${want} in ${JSON.stringify(b.terms)}`);
});

test('import PDF (fixture): the text of every page, as notes', async () => {
  const { briefings } = stores();
  const b = await briefings.importFile('Payments gateway.pdf', fs.readFileSync(path.join(FIX, 'project.pdf')));
  assert.equal(b.title, 'Payments gateway');
  assert.equal(b.kind, 'notes');
  assert.match(b.text, /project notes/);
  assert.match(b.text, /café by the office/);
  assert.match(b.text, /payments gateway with PostgreSQL and Kafka/, 'second page');
  assert.doesNotMatch(b.text, /endobj|\bTj\b|%PDF/, 'the text, not the PDF source');
  assert.ok(b.terms.includes('Kafka') && b.terms.includes('Kubernetes'), JSON.stringify(b.terms));
});

test('import PDF: only the first 50 pages are read', async () => {
  const { briefings } = stores();
  const { makePdf } = require('./fixtures/briefings/make-fixtures');
  const pdf = makePdf(Array.from({ length: 55 }, (_, i) => [`Page marker${i + 1}`]));
  const b = await briefings.importFile('long.pdf', pdf);
  assert.match(b.text, /\bmarker1\b/);
  assert.match(b.text, /\bmarker50\b/);
  assert.doesNotMatch(b.text, /\bmarker51\b/);
});

test('import refuses, with a 400 and nothing created: empty files, recordings, images, broken or text-less PDFs', async () => {
  const { briefings } = stores();
  const { makePdf } = require('./fixtures/briefings/make-fixtures');
  const refused = async (name, buf, re) => assert.rejects(briefings.importFile(name, buf), (e) => e.status === 400 && re.test(e.message), name);
  await refused('empty.txt', Buffer.alloc(0), /empty/i);
  await refused('blank.md', Buffer.from('  \n\n '), /no text|empty/i);
  await refused('call.wav', fs.readFileSync(path.join(__dirname, 'fixtures', 'hello.wav')), /not supported|audio/i);
  await refused('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), /not supported/i);
  await refused('broken.pdf', Buffer.from('%PDF-1.4\nthis is not really a pdf'), /PDF/);
  await refused('scan.pdf', makePdf([[]]), /no text/i);
  assert.deepEqual(briefings.list(), []);
});

// ---------- recognition ----------
test('vocabulary: the terms of the briefings attached to a note reach termsForNote; callers without briefings are unchanged', () => {
  const { termsForNote } = require('../src/asr/vocabulary');
  const { notes, briefings } = stores();
  const n = notes.create({ title: 'Client call', attendees: [{ name: 'Ana Silva', email: 'ana@acme.com' }] });
  const client = briefings.create({ title: 'Acme brief', kind: 'client', text: CLIENT });
  briefings.create({ title: 'not attached', text: 'Zebra stripes. Zebra herds.' });
  const before = termsForNote({ notes }, n.id);
  assert.deepEqual(termsForNote({ notes, briefings }, n.id), before, 'nothing attached yet');
  briefings.setForNote(n.id, [client.id]);
  const t = termsForNote({ notes, briefings }, n.id);
  for (const want of ['Ana Silva', 'Kubernetes', 'PostgreSQL', 'Acme Robotics']) assert.ok(t.includes(want), `${want} in ${JSON.stringify(t)}`);
  assert.ok(!t.includes('Zebra'));
  assert.ok(t.indexOf('Ana Silva') < t.indexOf('Kubernetes'), 'people first');
  assert.deepEqual(termsForNote({ notes }, n.id), before, 'briefings are optional');
  assert.deepEqual(termsForNote({ notes, briefings: { termsForNote() { throw new Error('boom'); } } }, n.id), before, 'a failing store is ignored');
});

// ---------- HTTP ----------
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { ROOT } = require('./helpers');

async function serve(t) {
  const dataDir = tmpDir('wb-brief-http-');
  const app = createApp({ dataDir, platform: {
    id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
    async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
    async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
    async micActivity() { return { supported: false, active: false, apps: [] }; }, async meetingWindows() { return []; },
    async paste() { return { ok: false }; }, clipboard: null,
  }, version: 'test' });
  app.briefings ||= new Briefings({ db: app.db, bus: app.bus });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: { Cookie: `wb_token=${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const json = async (method, p, body) => { const r = await call(method, p, body); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { app, base, call, json };
}

test('HTTP: briefings CRUD, import and note links, behind the token', async (t) => {
  const s = await serve(t);
  assert.equal((await fetch(`${s.base}/api/briefings`)).status, 401, 'needs the token');

  let r = await s.json('POST', '/api/briefings', { title: 'Acme brief', kind: 'client', text: CLIENT });
  assert.equal(r.status, 200);
  const client = r.body;
  assert.ok(client.id && client.terms.includes('Kubernetes'));
  assert.equal((await s.json('POST', '/api/briefings', { kind: 'diary' })).status, 400);

  r = await s.json('GET', '/api/briefings');
  assert.deepEqual(r.body.map((b) => b.id), [client.id]);
  assert.equal(r.body[0].text, undefined);
  assert.equal(r.body[0].size, CLIENT.length);

  r = await s.json('PATCH', `/api/briefings/${client.id}`, { title: 'Acme account' });
  assert.equal(r.body.title, 'Acme account');
  assert.equal((await s.json('PATCH', '/api/briefings/nope', { title: 'x' })).status, 404);
  assert.equal((await s.json('PATCH', `/api/briefings/${client.id}`, { kind: 'diary' })).status, 400);

  r = await s.json('POST', `/api/briefings/import?name=${encodeURIComponent('Payments gateway.pdf')}`, fs.readFileSync(path.join(FIX, 'project.pdf')));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const proj = r.body;
  assert.equal(proj.title, 'Payments gateway');
  assert.equal(proj.kind, 'notes');
  r = await s.json('POST', '/api/briefings/import?name=client.docx', fs.readFileSync(path.join(FIX, 'client.docx')));
  assert.equal(r.status, 200);
  assert.equal((await s.json('POST', '/api/briefings/import?name=x.txt', Buffer.alloc(0))).status, 400);
  assert.equal((await s.json('POST', '/api/briefings/import', Buffer.from('hello'))).status, 400, 'name is required');

  const note = s.app.notes.create({ title: 'Project review' });
  assert.deepEqual((await s.json('GET', `/api/notes/${note.id}/briefings`)).body, []);
  r = await s.json('PUT', `/api/notes/${note.id}/briefings`, { ids: [client.id, proj.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((b) => b.id).sort(), [client.id, proj.id].sort());
  assert.equal((await s.json('GET', `/api/notes/${note.id}/briefings`)).body.length, 2);
  assert.equal((await s.json('PUT', `/api/notes/${note.id}/briefings`, { ids: ['nope'] })).status, 404);
  assert.equal((await s.json('PUT', `/api/notes/${note.id}/briefings`, { ids: 'x' })).status, 400);
  assert.equal((await s.json('PUT', '/api/notes/nope/briefings', { ids: [] })).status, 404);
  assert.equal((await s.json('GET', '/api/notes/nope/briefings')).status, 404);

  r = await s.json('DELETE', `/api/briefings/${client.id}`);
  assert.deepEqual(r.body, { ok: true });
  assert.equal((await s.json('DELETE', `/api/briefings/${client.id}`)).status, 404);
  assert.deepEqual((await s.json('GET', `/api/notes/${note.id}/briefings`)).body.map((b) => b.id), [proj.id]);
});
