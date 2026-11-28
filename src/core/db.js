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
  // v13: meeting assistant. Briefings are the user's own material (project notes, an agenda, client or company notes)
  // that suggestions are grounded on; terms is a JSON array of offline keyphrases (also ASR hotwords). note_briefings attaches
  // them to a meeting. assistant_events is what the assistant said during a meeting. Links and events go with their note.
  `
  CREATE TABLE briefings (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'notes', text TEXT NOT NULL DEFAULT '', terms TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE note_briefings (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE, PRIMARY KEY (note_id, briefing_id));
  CREATE TABLE assistant_events (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, kind TEXT NOT NULL, question TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', meta TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX assistant_events_note ON assistant_events(note_id, created_at);
  `,
  // v14: the briefing kinds 'resume' and 'job' are gone (the assistant is for meetings); such briefings become plain notes.
  `
  UPDATE briefings SET kind = 'notes' WHERE kind IN ('resume', 'job');
  `,
  // v15: a saved voice the speaker probably is, but not surely enough to link it ("Ana?", the user confirms or declines), and how
  // clean the speech behind the speaker's voice print was (JSON: seconds, clipped, snrDb), checked before a print is remembered.
  `
  ALTER TABLE note_speakers ADD COLUMN suggested_voice_id TEXT;
  ALTER TABLE note_speakers ADD COLUMN suggested_score REAL;
  ALTER TABLE note_speakers ADD COLUMN quality TEXT;
  `,
  // v16: which voice model made each voice print. Prints of different models are never compared (other dimensions, other
  // geometry); everything stored so far came from WeSpeaker ResNet34, hence the default. A speaker of a meeting can also carry
  // a second print (alt_centroid, made by the older model) so saved voices of that model can still be recognised after the
  // app moved to a new one; once the voice is remembered again it gains a print of the new model.
  `
  ALTER TABLE voices ADD COLUMN model TEXT NOT NULL DEFAULT 'wespeaker-resnet34-lm';
  ALTER TABLE voice_exemplars ADD COLUMN model TEXT NOT NULL DEFAULT 'wespeaker-resnet34-lm';
  ALTER TABLE note_speakers ADD COLUMN model TEXT NOT NULL DEFAULT 'wespeaker-resnet34-lm';
  ALTER TABLE note_speakers ADD COLUMN alt_centroid BLOB;
  ALTER TABLE note_speakers ADD COLUMN alt_model TEXT;
  `,
  // v17: durable background work (src/jobs, docs/adr/0001-brain-data-model.md). key deduplicates while a job is pending;
  // lease_until marks a running job as abandoned once it passes (the app quit or crashed).
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    key TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    run_after INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    last_error TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_ready ON jobs(state, run_after);
  CREATE INDEX jobs_key ON jobs(kind, key);
  `,
  // v18: sources and items (docs/adr/0001-brain-data-model.md). A source is somewhere material comes from (the recorder,
  // an Obsidian vault, a folder, Notion...); `mode` says how much of it we keep: 'pointer' = path + hash + derived text only,
  // the file stays the original; `cursor`/`last_sync_at`/`last_error` are its sync state. An item is one thing from one
  // source; (source_id, external_id) is unique, so syncing again updates instead of duplicating; `deleted_at` is a tombstone.
  // A meeting is an item of kind 'meeting' that points at its notes row (note_id) and keeps no text of its own.
  // ai_runs: every call to an AI server, and whether it left this computer (the egress log).
  `
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'pointer' CHECK (mode IN ('pointer', 'excerpt', 'copy')),
    sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'private')),
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    cursor TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'document',
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL DEFAULT '',
    uri TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    occurred_at INTEGER NOT NULL,
    ingested_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE (source_id, external_id)
  );
  CREATE INDEX items_source ON items(source_id, deleted_at);
  CREATE INDEX items_note ON items(note_id);
  CREATE INDEX items_when ON items(occurred_at DESC);
  CREATE VIRTUAL TABLE items_fts USING fts5(title, text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
  CREATE TABLE ai_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    lane TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    local INTEGER NOT NULL DEFAULT 1,
    chars_in INTEGER NOT NULL DEFAULT 0,
    chars_out INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT
  );
  CREATE INDEX ai_runs_at ON ai_runs(at DESC);
  `,
  // v19: people as entities (the same ADR). An entity is a person with identities (email, voice, name): a strong identifier
  // (email, voice) decides who someone is, a name alone is weak. `key` is the URL key the People pages use. Merges are recorded
  // so they can be undone; proposals ("same person?") are decided by a person and a rejected one is never proposed again.
  // mentions: which meetings a person spoke in or was invited to.
  `
  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'person',
    name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    merged_into TEXT REFERENCES entities(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE entity_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('name', 'email', 'voice')),
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, value)
  );
  CREATE INDEX entity_identities_entity ON entity_identities(entity_id);
  CREATE TABLE mentions (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('speaker', 'attendee')),
    talk_ms INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, note_id, role)
  );
  CREATE INDEX mentions_note ON mentions(note_id);
  CREATE TABLE entity_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    b_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'rejected')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    UNIQUE (a_id, b_id)
  );
  CREATE TABLE entity_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    into_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    moved TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  );
  `,
  // v20: the search index over everything (docs/adr/0001-brain-data-model.md, Phase 2). A chunk is a searchable piece of a meeting
  // or of an item; chunks_fts is the word index over them (BM25); the vectors live in chunk_vec (sqlite-vec, made on demand when an
  // embedding model is set). index_owner remembers the content hash each owner was last indexed at, so only what changed is done.
  `
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('note', 'item')),
    owner_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_ms INTEGER,
    end_ms INTEGER,
    segment_id INTEGER,
    embedded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX chunks_owner ON chunks(owner_kind, owner_id, seq);
  CREATE INDEX chunks_pending ON chunks(embedded) WHERE embedded = 0;
  CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
  CREATE TABLE index_owner (
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    chunks INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (owner_kind, owner_id)
  );
  CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE fts_reset (id INTEGER PRIMARY KEY);   -- see src/core/fts.js
  ALTER TABLE chat_messages ADD COLUMN sources TEXT;   -- what an answer cited, so the links survive a restart
  `,
  // v21: what was decided and promised (docs/adr/0001-brain-data-model.md, Phase 3). An assertion is a decision or a commitment taken
  // from a meeting. Nothing the AI finds is trusted: it starts 'suggested' with the exact words it rests on (quote, checked in code to
  // be in the transcript) and the line they are on, and only a person makes it 'accepted'. 'dismissed' is a tombstone: the same thing
  // is never suggested again for that meeting (UNIQUE note_id + key). A commitment names who owes it (owner) and to whom, and when.
  // reminders: something to be told about at a time; one may belong to a commitment.
  `
  CREATE TABLE assertions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'commitment')),
    text TEXT NOT NULL,
    key TEXT NOT NULL,
    owner_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    owner_name TEXT NOT NULL DEFAULT '',
    to_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    to_name TEXT NOT NULL DEFAULT '',
    due_at INTEGER,
    due_text TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested', 'accepted', 'dismissed', 'done', 'superseded')),
    origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'user')),
    note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    segment_id INTEGER,
    start_ms INTEGER,
    quote TEXT NOT NULL DEFAULT '',
    speaker TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    supersedes TEXT,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    UNIQUE (note_id, key)
  );
  CREATE INDEX assertions_state ON assertions(state, kind);
  CREATE INDEX assertions_owner ON assertions(owner_id);
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'dismissed')),
    assertion_id TEXT REFERENCES assertions(id) ON DELETE CASCADE,
    fired_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_due ON reminders(state, due_at);
  `,
  // v22: actions that act outside this computer. An action is PROPOSED with its exact arguments and does nothing until a person approves
  // it in the Inbox; what is sent is exactly what was shown. 'origin' says who proposed it (the person, later a rule).
  `
  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'rejected', 'done', 'failed')),
    origin TEXT NOT NULL DEFAULT 'user',
    assertion_id TEXT REFERENCES assertions(id) ON DELETE SET NULL,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX actions_state ON actions(state);
  `,
  // v23: projects. A project is a name with the words that belong to it (and optionally a space). What belongs to it is worked out when it is
  // looked at (meetings, notes and promises that mention those words or sit in that space), so nothing has to be filed by hand.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    space_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v24: rules. A rule is a sentence the person wrote and the structured form it was understood as (checked in code against a fixed set of
  // triggers, conditions and actions). A rule can only PROPOSE: it never sends anything by itself, every proposal waits in the Inbox for approval.
  // rule_runs makes a rule act once per promise or decision.
  `
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    spec TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE rule_runs (
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    assertion_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (rule_id, assertion_id)
  );
  `,
  // v25: platform accounts as identities (docs/adr/0001-brain-data-model.md lists the Discord id among the identifiers of a person).
  // A platform account ('discord:<user id>') is strong, like an e-mail address. SQLite cannot change a CHECK, so the table is
  // rebuilt with the same rows and ids (merges record identity ids). note_speakers.account: the account a voice was named with.
  `
  CREATE TABLE entity_identities_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('name', 'email', 'voice', 'account')),
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, value)
  );
  INSERT INTO entity_identities_v2 (id, entity_id, kind, value, created_at) SELECT id, entity_id, kind, value, created_at FROM entity_identities;
  DROP TABLE entity_identities;
  ALTER TABLE entity_identities_v2 RENAME TO entity_identities;
  CREATE INDEX entity_identities_entity ON entity_identities(entity_id);
  ALTER TABLE note_speakers ADD COLUMN account TEXT NOT NULL DEFAULT '';
  `,
  // v26: access grants on sources (src/access/grants.js, docs/access.md). What may be read (read_level, filter), which actions may be
  // proposed (actions; auto_actions = exports of one's own notes that run without asking), who may see it (ai_reach, replacing
  // sensitivity, which is kept in step), live search, MCP, retention of live-fetched copies, an optional expiry. Existing sources
  // keep exactly what they did: services read the part they were given, folders all, private stays local, and what MCP served it
  // still serves. items.ai_reach: one item kept stricter than its source. ai_runs.source_ids: which sources an AI call carried.
  // access_log: live searches and actions run. actions: rebuilt so an approval can claim a row ('running') and proposals can expire.
  `
  ALTER TABLE sources ADD COLUMN read_level TEXT NOT NULL DEFAULT 'all' CHECK (read_level IN ('none', 'metadata', 'part', 'all'));
  ALTER TABLE sources ADD COLUMN filter TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE sources ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sources ADD COLUMN auto_actions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sources ADD COLUMN ai_reach TEXT NOT NULL DEFAULT 'any' CHECK (ai_reach IN ('local', 'ask', 'any'));
  ALTER TABLE sources ADD COLUMN live_search INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sources ADD COLUMN mcp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sources ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 7;
  ALTER TABLE sources ADD COLUMN expires_at INTEGER;
  UPDATE sources SET ai_reach = CASE sensitivity WHEN 'private' THEN 'local' ELSE 'any' END,
                     mcp = CASE sensitivity WHEN 'private' THEN 0 ELSE 1 END,
                     read_level = CASE WHEN json_extract(config, '$.remote') THEN 'part' ELSE 'all' END;
  INSERT OR IGNORE INTO index_meta (key, value) SELECT 'access:review:' || id, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM sources;
  INSERT INTO index_meta (key, value) SELECT 'access:notice', 'pending' WHERE EXISTS (SELECT 1 FROM sources WHERE kind <> 'native' AND id NOT LIKE 'src_imports_%');
  ALTER TABLE items ADD COLUMN ai_reach TEXT CHECK (ai_reach IS NULL OR ai_reach IN ('local', 'ask', 'any'));
  ALTER TABLE ai_runs ADD COLUMN source_ids TEXT NOT NULL DEFAULT '';
  CREATE TABLE access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    source_id TEXT,
    op TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX access_log_at ON access_log(at DESC);
  CREATE TABLE actions_v2 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'rejected', 'done', 'failed', 'expired')),
    origin TEXT NOT NULL DEFAULT 'user',
    assertion_id TEXT REFERENCES assertions(id) ON DELETE SET NULL,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    expires_at INTEGER
  );
  INSERT INTO actions_v2 (id, kind, title, args, state, origin, assertion_id, result, error, created_at, decided_at)
    SELECT id, kind, title, args, state, origin, assertion_id, result, error, created_at, decided_at FROM actions;
  DROP TABLE actions;
  ALTER TABLE actions_v2 RENAME TO actions;
  CREATE INDEX actions_state ON actions(state);
  `,
  // v27: live search and correlation (docs/access.md). live_cache: what a search sent to a service answered, keyed by the query AND a hash
  // of the source's grant, so changing a grant never serves what the old one allowed (short life). items.origin 'live': a body opened
  // from a live result; it expires (items.expires_at, from the grant's retention) unless pinned. item_mentions: who wrote or received an
  // item (the item-side twin of `mentions`), so a person's page and a meeting's brief can find their mail. item_links: a person's own
  // yes/no on "related mail and messages" of a meeting. blocked_addresses: addresses forgotten on purpose, never read again.
  `
  CREATE TABLE live_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '',
    results TEXT NOT NULL DEFAULT '[]',
    fetched_at INTEGER NOT NULL,
    UNIQUE (source_id, key)
  );
  ALTER TABLE items ADD COLUMN origin TEXT NOT NULL DEFAULT 'sync' CHECK (origin IN ('sync', 'live'));
  ALTER TABLE items ADD COLUMN expires_at INTEGER;
  ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX items_expires ON items(expires_at) WHERE expires_at IS NOT NULL;
  CREATE TABLE item_mentions (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'author')),
    at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, item_id, role)
  );
  CREATE INDEX item_mentions_item ON item_mentions(item_id);
  CREATE INDEX item_mentions_entity ON item_mentions(entity_id, at DESC);
  CREATE TABLE item_links (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('linked', 'unlinked')),
    PRIMARY KEY (note_id, item_id)
  );
  CREATE TABLE blocked_addresses (
    address TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  `,
  // v28: what a proposed action is checked for (src/access/guards.js). flags: what looked wrong when it was proposed (a recipient who is not
  // in the thread, a link that was not there before, material from another source). provenance: the sources its text was made from.
  // args_hash: a hash of the arguments as shown; an approval that finds the arguments changed since refuses to run.
  `
  ALTER TABLE actions ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE actions ADD COLUMN provenance TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE actions ADD COLUMN args_hash TEXT NOT NULL DEFAULT '';
  `,
];

// allowExtension: lets the program load an extension (sqlite-vec) once, on purpose; it is switched off again right after
function open(file, { allowExtension = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, allowExtension ? { allowExtension: true } : {});
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    refuseNewer(db);
    if (file !== ':memory:') backupBeforeMigrating(db, file);
    migrate(db);
  } catch (e) { try { db.close(); } catch { /* already closed */ } throw e; }
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* not supported on this fs */ } }
  return db;
}

// Before an existing database moves to a newer schema, a copy of it as it was is written next to it
// (whisperbrain.sqlite.before-v15), once per schema version: the way back if an update goes wrong. A new, empty database has
// nothing to keep. A copy that cannot be written stops the update: better an app that does not open than data at risk.
function backupBeforeMigrating(db, file) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current === 0 || current >= MIGRATIONS.length) return null;
  const copy = `${file}.before-v${MIGRATIONS.length}`;
  if (fs.existsSync(copy)) return copy;
  db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  try { fs.chmodSync(copy, 0o600); } catch { /* not supported on this fs */ }
  return copy;
}

// A database a newer WhisperBrain moved to a schema this one does not know: opening it would read columns wrongly and write
// rows the newer version does not expect. It is refused (and left as it was) rather than opened.
function refuseNewer(db, migrations = MIGRATIONS) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current <= migrations.length) return;
  throw Object.assign(new Error(`This data was made by a newer WhisperBrain (schema ${current}; this version knows up to ${migrations.length}). Install the newer version to open it; nothing was changed.`), { code: 'SCHEMA_TOO_NEW' });
}

// Foreign keys are switched off while migrations run, BEFORE the transaction (inside one the pragma is a no-op): the
// create / copy / DROP / RENAME pattern SQLite needs to change a CHECK would otherwise cascade the DROP into every child row
// (segments, reminders, item links...). What a migration leaves dangling that was not dangling before is checked before COMMIT,
// so a migration that loses a parent row is undone instead of committed. Old dangling rows (if any) never block an update.
function migrate(db, migrations = MIGRATIONS) {
  refuseNewer(db, migrations);
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current >= migrations.length) return;
  const key = (r) => `${r.table}:${r.rowid}:${r.parent}:${r.fkid}`;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = current; v < migrations.length; v++) {
      db.exec('BEGIN');
      try {
        const before = new Set(db.prepare('PRAGMA foreign_key_check').all().map(key));
        db.exec(migrations[v]);
        const broken = db.prepare('PRAGMA foreign_key_check').all().filter((r) => !before.has(key(r)));
        if (broken.length) {
          const where = [...new Set(broken.map((r) => `${r.table} -> ${r.parent}`))].join(', ');
          throw new Error(`migration ${v + 1} would leave ${broken.length} foreign key reference(s) dangling (${where}); not applied`);
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
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

module.exports = { open, tx, migrate, MIGRATIONS };
