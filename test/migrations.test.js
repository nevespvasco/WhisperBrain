'use strict';
// How the schema moves forward (src/core/db.js): a migration may rebuild a table other tables point at without losing their rows, a
// migration that leaves a dangling reference is undone, and a database made by a newer WhisperBrain is refused instead of opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, migrate, MIGRATIONS } = require('../src/core/db');
const { tmpDir } = require('./helpers');

const PARENT_CHILD = `
  CREATE TABLE parent (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (name <> ''));
  CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE, text TEXT);
  INSERT INTO parent VALUES ('p1', 'one'), ('p2', 'two');
  INSERT INTO child (parent_id, text) VALUES ('p1', 'a'), ('p1', 'b'), ('p2', 'c');
`;
// the create / copy / DROP / RENAME pattern SQLite needs to change a CHECK
const REBUILD_PARENT = `
  CREATE TABLE parent_v2 (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO parent_v2 (id, name) SELECT id, name FROM parent;
  DROP TABLE parent;
  ALTER TABLE parent_v2 RENAME TO parent;
`;

const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); return db; };

test('a migration that rebuilds a parent table keeps the rows that point at it', () => {
  const db = fresh();
  migrate(db, [PARENT_CHILD, REBUILD_PARENT]);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child').get().n, 3, 'no cascade from the DROP');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are on again afterwards');
  db.exec("DELETE FROM parent WHERE id = 'p1'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child').get().n, 1, 'and the children still follow the rebuilt parent');
});

test('a migration that leaves a dangling reference is rolled back with a clear error', () => {
  const db = fresh();
  migrate(db, [PARENT_CHILD]);
  const bad = "CREATE TABLE parent_v2 (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO parent_v2 SELECT * FROM parent WHERE id = 'p1'; DROP TABLE parent; ALTER TABLE parent_v2 RENAME TO parent;";
  assert.throws(() => migrate(db, [PARENT_CHILD, bad]), /migration 2 .*foreign key.*child/i);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1, 'not applied');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parent').get().n, 2, 'the old table is back');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('a dangling reference that was already there before does not block a migration', () => {
  const db = fresh();
  migrate(db, [PARENT_CHILD]);
  db.exec('PRAGMA foreign_keys = OFF'); db.exec("INSERT INTO child (parent_id, text) VALUES ('gone', 'old')"); db.exec('PRAGMA foreign_keys = ON');
  migrate(db, [PARENT_CHILD, 'CREATE TABLE other (x)']);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
});

test('every real migration applies on an empty database with no foreign key left dangling', () => {
  const db = open(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('a database made by a newer WhisperBrain is refused, and left as it was', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'whisperbrain.sqlite');
  const newer = new DatabaseSync(file);
  newer.exec(`CREATE TABLE notes (id TEXT); PRAGMA user_version = ${MIGRATIONS.length + 3}`);
  newer.close();
  assert.throws(() => open(file), (e) => e.code === 'SCHEMA_TOO_NEW' && /newer WhisperBrain/.test(e.message));
  const back = new DatabaseSync(file, { readOnly: true });
  assert.equal(back.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length + 3);
  back.close();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('before-v')), [], 'no copy is written either');
  fs.rmSync(dir, { recursive: true, force: true });
});
