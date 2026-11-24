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
  // v4: pitch (median fundamental frequency, Hz) of each speaker and saved voice, measured after a recording
  `
  ALTER TABLE note_speakers ADD COLUMN pitch REAL;
  ALTER TABLE voices ADD COLUMN pitch REAL;
  `,
  // v5: what the recognizer knew about each segment: word timings (JSON [[word, startMs, endMs], ...] relative to the
  // segment start) and the mean / minimum token log-probability (0 = certain). Stored for later use; nothing reads them yet.
  `
  ALTER TABLE segments ADD COLUMN words TEXT;
  ALTER TABLE segments ADD COLUMN logprob_mean REAL;
  ALTER TABLE segments ADD COLUMN logprob_min REAL;
  `,
  // v6: a saved voice keeps several voice prints (exemplars) instead of one blended mean: one per meeting or microphone,
  // near-duplicates merged, at most a handful. voices.embedding stays as the weighted mean of them (what older versions
  // read). weight = seconds of speech behind the print; channel = 'mic' | 'system' | '' (unknown); source = "<note>:<speaker>"
  // so that confirming the same speaker twice replaces the print instead of counting it twice. negative = 1 marks a voice
  // the user said is NOT this person (a corrected automatic link), see Speakers.rename.
  // Existing profiles get one exemplar each from their mean, so they keep matching exactly as before.
  `
  CREATE TABLE voice_exemplars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id TEXT NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    channel TEXT NOT NULL DEFAULT '',
    pitch REAL,
    negative INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX voice_exemplars_voice ON voice_exemplars(voice_id);
  INSERT INTO voice_exemplars(voice_id, embedding, weight, channel, pitch, negative, source, created_at)
    SELECT id, embedding, samples * 4.0, '', pitch, 0, NULL, updated_at FROM voices;
  `,
  // v7: how many other people the user says are on the call (the voices on the system audio). NULL = work it out.
  `
  ALTER TABLE notes ADD COLUMN speaker_count INTEGER;
  `,
  // v8: voice prints are opt-in, so a saved voice records when, and on whose say-so, it was enrolled (consent_source =
  // 'user' | 'meeting' | 'import'; enrolled_from = "<note>:<speaker>"). Profiles from before this keep NULL: no consent is
  // invented for them. And every utterance names its channel: 'mic' | 'system' | 'dc:<discord user id>', so a person on
  // Discord stays distinguishable from the mixed system audio (speaker still reads 'them' for them).
  `
  ALTER TABLE voices ADD COLUMN consent_at INTEGER;
  ALTER TABLE voices ADD COLUMN consent_source TEXT;
  ALTER TABLE voices ADD COLUMN enrolled_from TEXT;
  ALTER TABLE segments ADD COLUMN channel TEXT;
  UPDATE segments SET channel = CASE
    WHEN speaker = 'me' THEN 'mic'
    WHEN speaker_id GLOB 'd[0-9]*' THEN 'dc:' || substr(speaker_id, 2)
    ELSE 'system' END;
  `,
  // v9: whether the other people on the call were told it is being recorded: 'unknown' (nothing said yet) | 'announced' |
  // 'declined' (somebody objected). Kept on the meeting so it can be seen again, and exported with it.
  `
  ALTER TABLE notes ADD COLUMN consent TEXT NOT NULL DEFAULT 'unknown';
  `,
  // v10: what names are based on, kept instead of dropped when a recording stops. kind: 'highlight' (who the meeting window
  // lit up, raw: the source's lag is in meta), 'roster' (who is on the call), 'caption' (a name and the words they said),
  // 'stream' (a Discord bot heard this person), 'transcript' (a platform's own transcript), 'calendar' (an invited attendee).
  // participant_key = the name folded for comparison; t0/t1 = timeline ms of the recording (t1 NULL for a point).
  // And each speaker records which kind of evidence named it ('user', 'voice', 'stream', 'meeting:highlight'...) and how
  // sure that was (0..1); '' = of unknown origin, as every name from before this is.
  `
  CREATE TABLE evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    participant_key TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    t0 INTEGER,
    t1 INTEGER,
    weight REAL NOT NULL DEFAULT 1,
    meta TEXT
  );
  CREATE INDEX evidence_note ON evidence(note_id, kind);
  ALTER TABLE note_speakers ADD COLUMN name_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE note_speakers ADD COLUMN name_confidence REAL;
  `,
  // v11: search by meaning (src/search/semantic.js): a meeting's transcript cut into chunks, kept with where they are. The vectors
  // live in a sqlite-vec table (semantic_vec) made by the program when the extension is there, since a virtual table needs it.
  `
  CREATE TABLE semantic_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX semantic_chunks_note ON semantic_chunks(note_id);
  `,
  // v11: translations. A line translated into a language (segment_translations) and a note's summary (note_translations; `field` leaves room for more).
  // src_hash is a hash of the text that was translated: a translation whose source has changed since (the speaker pass cuts a line,
  // the summary is written again) is stale and is not shown. Lines and notes take their translations with them.
  `
  CREATE TABLE segment_translations (
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    text TEXT NOT NULL,
    src_hash TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (segment_id, lang)
  );
  CREATE TABLE note_translations (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    field TEXT NOT NULL,
    text TEXT NOT NULL,
    src_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (note_id, lang, field)
  );
  `,
];

// allowExtension: lets the program load an extension (sqlite-vec) once, on purpose; it is switched off again right after
function open(file, { allowExtension = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, allowExtension ? { allowExtension: true } : {});
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
