'use strict';
// Telling the other people on a call that it is being recorded: where the answer is kept (notes.consent), what the
// notice says, and what happens when a recording starts by itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, MIGRATIONS } = require('../src/core/db');
const { Notes } = require('../src/core/notes');
const { tmpDir } = require('./helpers');

test('migration v9: existing notes get consent "unknown"; it can be set to announced or declined and nothing else', () => {
  const dir = tmpDir('wb-consent-note-');
  const file = path.join(dir, 'a.db');
  const raw = new DatabaseSync(file);
  const upto = MIGRATIONS.findIndex((m) => /notes ADD COLUMN consent/.test(m));
  const before = upto < 0 ? MIGRATIONS.length : upto;
  for (let i = 0; i < before; i++) raw.exec(MIGRATIONS[i]);
  raw.exec(`PRAGMA user_version = ${before}`);
  raw.exec("INSERT INTO notes(id, created_at, updated_at) VALUES('old', 1, 1)");
  raw.close();

  const db = open(file);
  const notes = new Notes(db, null);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(notes.get('old').consent, 'unknown');
  assert.equal(notes.create({}).consent, 'unknown');
  assert.equal(notes.update('old', { consent: 'announced' }).consent, 'announced');
  assert.equal(notes.update('old', { consent: 'declined' }).consent, 'declined');
  assert.throws(() => notes.update('old', { consent: 'yes' }), /consent/);
  assert.equal(notes.get('old').consent, 'declined', 'a refused value changes nothing');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the notice ----
const { noticeText, PRESETS } = require('../src/consent/notice');
const { Settings } = require('../src/core/settings');

test('noticeText: every preset reads in both languages; EU adds what happens to the recording, US asks for agreement by staying', () => {
  assert.deepEqual(PRESETS, ['general', 'eu', 'us']);
  const t = (preset, lang) => noticeText({ preset, lang });
  for (const p of PRESETS) for (const l of ['en', 'pt']) assert.ok(t(p, l).length > 40, `${p}/${l}`);
  assert.match(t('general', 'en'), /recording this meeting with WhisperBrain/);
  assert.doesNotMatch(t('general', 'en'), /delete|staying/i);
  assert.match(t('eu', 'en'), /stays on my computer and I will delete it if you ask/);
  assert.match(t('us', 'en'), /By staying on the call you agree to be recorded/);
  assert.match(t('general', 'pt'), /a gravar esta reunião com o WhisperBrain/);
  assert.match(t('eu', 'pt'), /apago/);
  assert.match(t('us', 'pt'), /Ao permanecerem na chamada/);
  assert.doesNotMatch(t('us', 'pt'), /recording|staying/);
});

test('noticeText: an unknown preset or language falls back to general English', () => {
  assert.equal(noticeText({ preset: 'mars', lang: 'xx' }), noticeText({ preset: 'general', lang: 'en' }));
  assert.equal(noticeText(), noticeText({ preset: 'general', lang: 'en' }));
});

test('settings: consentPreset defaults to general and accepts only the known presets', () => {
  const s = new Settings(open(':memory:'), null);
  assert.equal(s.get('consentPreset'), 'general');
  s.update({ consentPreset: 'eu' });
  assert.equal(s.get('consentPreset'), 'eu');
  assert.throws(() => s.update({ consentPreset: 'moon' }), /consentPreset/);
});
