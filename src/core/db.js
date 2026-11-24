'use strict';
// SQLite via the runtime's built-in node:sqlite (Node >= 24 / Electron >= 38): no native module to ship.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    template_id TEXT,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    pinned INTEGER NOT NULL DEFAULT 0,
    event_uid TEXT,
    event_start INTEGER,
    attendees TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX notes_created ON notes(created_at DESC);
  CREATE INDEX notes_folder ON notes(folder_id);
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX segments_note ON segments(note_id, start_ms);
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX chat_note ON chat_messages(note_id, id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE search USING fts5(
    note_id UNINDEXED, title, body, summary, transcript,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
  // v2: speaker identification (who is talking) and saved voice profiles
  `
  ALTER TABLE segments ADD COLUMN speaker_id TEXT;
  ALTER TABLE segments ADD COLUMN embedding BLOB;
  CREATE TABLE voices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    embedding BLOB NOT NULL,
    samples INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE note_speakers (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    speaker_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    voice_id TEXT REFERENCES voices(id) ON DELETE SET NULL,
    centroid BLOB,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, speaker_id)
  );
  `,
  // v3: knowledge layer (where a meeting came from, tags, action items, highlights, topics, glossary, external links)
  // and a per-line full-text index so "who said what" can be searched across every meeting.
  `
  ALTER TABLE notes ADD COLUMN source TEXT NOT NULL DEFAULT 'recorded';
  ALTER TABLE notes ADD COLUMN source_ref TEXT;
  ALTER TABLE notes ADD COLUMN platform TEXT;
  ALTER TABLE notes ADD COLUMN insights TEXT NOT NULL DEFAULT '';
  ALTER TABLE notes ADD COLUMN external INTEGER;
  UPDATE notes SET source = 'manual' WHERE NOT EXISTS (SELECT 1 FROM segments s WHERE s.note_id = notes.id);
  CREATE INDEX notes_source ON notes(source);
  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
  );
  CREATE INDEX note_tags_tag ON note_tags(tag_id);
  CREATE TABLE action_items (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    auto INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    ext_kind TEXT, ext_id TEXT, ext_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX action_items_note ON action_items(note_id, position);
  CREATE TABLE snippets (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    segment_id INTEGER,
    start_ms INTEGER NOT NULL DEFAULT 0,
    end_ms INTEGER NOT NULL DEFAULT 0,
    speaker TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX snippets_note ON snippets(note_id, start_ms);
  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE note_topics (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    weight REAL NOT NULL DEFAULT 1,
    summary TEXT NOT NULL DEFAULT '',
    auto INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (note_id, topic_id)
  );
  CREATE INDEX note_topics_topic ON note_topics(topic_id);
  CREATE TABLE glossary (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    definition TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',
    note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE note_links (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX note_links_note ON note_links(note_id);
  CREATE TABLE event_prefs (
    event_id TEXT PRIMARY KEY,
    capture INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE seg_fts USING fts5(text, content = 'segments', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER seg_ai AFTER INSERT ON segments BEGIN INSERT INTO seg_fts(rowid, text) VALUES (new.id, new.text); END;
  CREATE TRIGGER seg_ad AFTER DELETE ON segments BEGIN INSERT INTO seg_fts(seg_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
  CREATE TRIGGER seg_au AFTER UPDATE OF text ON segments BEGIN
    INSERT INTO seg_fts(seg_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO seg_fts(rowid, text) VALUES (new.id, new.text);
  END;
  INSERT INTO seg_fts(seg_fts) VALUES ('rebuild');
  `,
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* not supported on this fs */ } }
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, tx, MIGRATIONS };
