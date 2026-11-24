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
