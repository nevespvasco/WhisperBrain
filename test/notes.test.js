'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes, ftsQuery } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Templates } = require('../src/core/templates');

function fresh() {
  const db = open(':memory:');
  const bus = new Bus();
  return { db, bus, notes: new Notes(db, bus), settings: new Settings(db, bus), templates: new Templates(db) };
}

test('create/update/list/delete notes and publish events', () => {
  const { notes, bus } = fresh();
  const seen = [];
  bus.subscribe((e) => seen.push(e.type));
  const n = notes.create({ title: 'Kickoff', body: 'agenda' });
  assert.equal(notes.get(n.id).title, 'Kickoff');
  notes.update(n.id, { title: 'Kickoff v2', pinned: true, attendees: [{ name: 'Ana' }] });
  const got = notes.get(n.id);
  assert.equal(got.title, 'Kickoff v2');
  assert.equal(got.pinned, true);
  assert.deepEqual(got.attendees, [{ name: 'Ana' }]);
  assert.equal(notes.list().length, 1);
  assert.ok(notes.remove(n.id));
  assert.equal(notes.get(n.id), null);
  assert.deepEqual(seen, ['note.created', 'note.updated', 'note.deleted']);
});

test('full-text search covers title, body, summary and transcript, with diacritics folded', () => {
  const { notes } = fresh();
  const a = notes.create({ title: 'Reunião de orçamento', body: 'rever custos' });
  const b = notes.create({ title: 'Other' });
  notes.addSegments(b.id, [{ speaker: 'them', startMs: 0, endMs: 1000, text: 'We should migrate to PostgreSQL next quarter' }]);
  notes.reindex(b.id);
  assert.equal(notes.search('reuniao')[0].note.id, a.id);
  assert.equal(notes.search('postgres')[0].note.id, b.id);
  assert.match(notes.search('postgres')[0].snippet, /<mark>PostgreSQL<\/mark>/i);
  assert.deepEqual(notes.search('   '), []);
  assert.deepEqual(notes.search('"; DROP TABLE notes; --').length, 0);
  assert.ok(ftsQuery('foo bar').endsWith('"bar"*'));
});

test('segments are ordered, cascade on delete and render as a labelled transcript', () => {
  const { notes } = fresh();
  const n = notes.create({ title: 't' });
  notes.addSegments(n.id, [
    { speaker: 'them', startMs: 5000, endMs: 6000, text: 'second' },
    { speaker: 'me', startMs: 1000, endMs: 2000, text: 'first' },
  ]);
  assert.equal(notes.transcriptText(n.id), 'Me: first\nThem: second');
  notes.remove(n.id);
  assert.equal(notes.db.prepare('SELECT COUNT(*) c FROM segments').get().c, 0);
});

test('markdown export includes summary, notes and transcript', () => {
  const { notes } = fresh();
  const n = notes.create({ title: 'Plan', body: 'my notes', attendees: [{ name: 'Ana' }] });
  notes.update(n.id, { summary: '- decided X' });
  notes.addSegments(n.id, [{ speaker: 'me', startMs: 65000, endMs: 66000, text: 'hello' }]);
  const md = notes.exportMarkdown(n.id);
  assert.match(md, /^# Plan/);
  assert.match(md, /## Summary\n\n- decided X/);
  assert.match(md, /\*\*Me\*\* \[1:05\] hello/);
  assert.match(md, /Attendees:\*\* Ana/);
});

test('settings validate, merge nested objects, and mask the API key', () => {
  const { settings } = fresh();
  assert.equal(settings.get('language'), 'en');
  settings.update({ llm: { model: 'llama3.1', apiKey: 'sk-secret' } });
  assert.equal(settings.get('llm').model, 'llama3.1');
  assert.equal(settings.get('llm').baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(settings.publicView().llm.apiKey, '********');
  settings.update({ llm: { apiKey: '********', model: 'x' } });
  assert.equal(settings.get('llm').apiKey, 'sk-secret', 'masked value must not overwrite the secret');
  assert.throws(() => settings.update({ nope: 1 }), /unknown setting/);
  assert.throws(() => settings.update({ language: 'xx' }), /language/);
  assert.throws(() => settings.update({ llm: { model: 5 } }), /llm.model/);
  assert.equal(settings.update({ asrThreads: 99 }).asrThreads, 16);
});

test('templates: builtin read-only, custom CRUD', () => {
  const { templates } = fresh();
  assert.ok(templates.list().some((t) => t.id === 'general' && t.builtin));
  const t = templates.create({ name: 'Mine', prompt: 'Do X' });
  assert.equal(templates.get(t.id).name, 'Mine');
  templates.update(t.id, { name: 'Mine2' });
  assert.equal(templates.get(t.id).name, 'Mine2');
  assert.throws(() => templates.update('general', { name: 'x' }), /read-only/);
  assert.ok(templates.remove(t.id));
});
