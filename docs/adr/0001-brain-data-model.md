# ADR 0001 — From meeting notes to a personal brain: data model, jobs and provenance

- Status: accepted (2026-11-26)
- Scope: Phase 1 of the "Personal Intelligence Brain" plan (research notes, Parts 4, 5 and 8)

## Context

WhisperBrain started as a meeting recorder. Its schema reflects that:
- "note" means "a meeting".
- People are worked out from name strings on every request (`Knowledge.people()`).
- Decisions live inside the `notes.insights` JSON blob.
- Imports are one-off copies, so re-importing duplicates them.
- The work after a recording runs in memory, so quitting midway loses it.

The goal is one local place for meetings, notes, files, mail and chat, with people, projects, decisions and commitments that keep a link back to where they came from. That needs a more general model.

Two constraints apply. We do not rebuild, and we do not lose anything that works today.

## Decision

**1. Keep the stack.**
- Keep `createApp`, the local HTTP API, `node:sqlite` in one file, the vanilla UI and the speech pipeline.
- No graph database and no second vector store. sqlite-vec stays optional, behind the existing index interface.

**2. Six concepts, added beside the current tables (never replacing them):**

| Concept | What it is | Examples |
|---|---|---|
| **Item** | One thing captured from one source | a meeting, a markdown file, an email thread, a Slack thread |
| **Chunk** | A searchable span of an item, with its offsets or seconds | a paragraph, a transcript window |
| **Entity** + **Identity** | A person, project, organisation or topic, recognised by its identifiers | email, Slack id, Discord id, voice print, folded name |
| **Assertion** | A decision, commitment, task, fact or idea | "Ana sends the deck by Friday" |
| **Edge** | A typed link between entities and items | attended, mentions, owns, supersedes |
| **Provenance** | Where a derived row came from | item, span (chars or ms), quote, actor (user / AI / import / rule), model and prompt version |

- A meeting becomes an item of kind `meeting` that points at its existing `notes` row.
- The `notes` table and its API stay as they are.

**3. Provenance is mandatory.**
- Every derived row (assertion, edge, entity merge) carries a provenance row.
- AI output starts as `suggested` and becomes `accepted` only by a person.
- Rejections are kept as tombstones so automation never re-creates them.
- AI quotes are checked in code against the source text before they are stored.

**4. Sources say how much they copy.** Each source picks one storage mode:
- `pointer`: we keep the path, the hash and the derived text, and the file stays the original.
- `excerpt`: we keep only the relevant parts.
- `copy`: only where an API forces it.

Every item has a unique `(source_id, external_id)` and a content hash, so re-importing updates instead of duplicating.

**5. Background work is durable.**
- A `jobs` table holds every unit of background work: kind, dedupe key, payload, state, attempts, lease and last error.
- Jobs are claimed with a lease. Failures retry with backoff, and jobs left running when the app quit are queued again at start.
- The work after a recording (names from the transcript → summary → topics, glossary and action items) runs as chained jobs. An interrupted meeting therefore finishes on the next start.
- Jobs run in the main process at first. Moving the runner into an Electron `utilityProcess` later changes no table or API.

**6. Migrations are additive and backed up.**
- Before the database is moved to a newer schema, a copy of the old file is written next to it (`VACUUM INTO`).
- Backfills are resumable jobs, never one long transaction at start.
- Migration numbers are global: branches that add migrations must be rebased so that their numbers do not collide.

## What Phase 1 delivered, and what it did not

Delivered (branch `brain/phase-1-foundation`):
- Migrations v15 (jobs), v16 (sources, items, `items_fts`, `ai_runs`) and v17 (entities, identities, mentions, proposals, merges). Sync state (`cursor`, `last_sync_at`, `last_error`) lives on `sources` instead of a separate `sync_state` table.
- `src/jobs` with lanes (a long folder scan never delays the steps after a recording), and the post-recording chain on it.
- `src/items`, `src/connectors` (folder and Obsidian, pointer mode, `fs.watch` with a periodic reconcile), `src/graph/entities.js`, `src/audit/ai-runs.js`, and the per-source sensitivity rule (`src/items/policy.js`).
- Re-importing a Notion page, Obsidian note or Linear issue updates its meeting instead of duplicating it (hash of the last import).
- Pages: Today/Ask/Library/Setup doors, Folders & vaults, Notes & files, People merges, Activity with the AI-call ledger.

Not done, on purpose or for later:
- **No `utilityProcess` brain worker.** Jobs run in the main process. The folder scan yields to the event loop (measured: 2,000 notes in about 0.4 s, the event loop blocked at most about 40 ms), so there was no need yet. The runner has no dependency on where it runs, so moving it later changes no table or API.
- **No chokidar.** `fs.watch` (recursive) plus a scan every 10 minutes does the job without a dependency.
- **Notion and Linear are not polling sources yet.** Imports are still started by the person; they no longer duplicate. Polling them is Phase 4.
- **Sensitivity is stored, editable and tested, but nothing feeds items to an AI yet.** The check (`mayReachAi`) is the single place retrieval and briefs must call from Phase 2.
- **PDFs** are read when a text layer exists. Scanned PDFs need OCR, which is not built.
- **`entity_revisions`** (edit history of an entity) is not built: merges are recorded and reversible, which covers what Phase 1 needed.

## Phases 2 to 4: what was built

Search and Ask (Phase 2):
- Migration v18: `chunks`, `chunks_fts` (BM25), `index_owner` (the hash each meeting or item was indexed at), `index_meta`, `chat_messages.sources`. `src/search/index.js` cuts meetings and items into chunks, keeps only what changed up to date, and fuses the word list and (when an embedding model is set) the vector list by RRF.
- Vectors come from the AI server's `/v1/embeddings` (`src/search/embedder.js`, setting `embeddingModel`, empty = words only) and live in a sqlite-vec table made on demand. A private source is embedded and shown only when the server is on this computer.
- Ask: the chat across all meetings gets numbered excerpts from the index next to the meetings the question is about. Only given numbers may be cited; others are removed in code. Citations open the transcript line or the note, and are saved with the answer.
- `src/core/fts.js`: writes to FTS5 tables with `contentless_delete` can leave SQLite's last-insert rowid beyond JavaScript's safe integers and make the next write throw; those writes now reset it.
- `scripts/retrieval-eval.js` measures recall@k and MRR on a question set the person writes from their own data. No real set exists yet, and Portuguese quality of any embedding model is therefore still unmeasured.

Decisions, promises, Inbox, brief, MCP (Phase 3) and reminders (Phase 4):
- Migration v19: `assertions` (decision or commitment; suggested, accepted, dismissed as a tombstone, done, superseded) and `reminders`. The AI must give the exact words and the line; they are checked against the transcript in code and an item without proof is thrown away. Dates are worked out in code (`src/brain/dates.js`, English and Portuguese). Nothing is accepted by itself.
- Inbox, Promises, Home "Needs you", and a brief before a meeting (`src/brain/brief.js`) built from facts only, with no AI in between. Reminders have a calm budget (three announcements, then one line).
- `src/mcp` and `scripts/mcp-server.js`: a read-only MCP server (database opened read-only, no tool writes, nothing from a private source, only accepted promises and decisions).
- Database backups to a folder, daily while the app runs (`src/core/backup.js`).

Services and approved actions (Phases 4 and 5):
- GitHub, Slack (your own app), Discord (your own bot, your own server), Gmail (read-only, incremental by `historyId`) and Notion/Linear polling plug into `SourceManager` as service sources (`src/connectors/*.js`): one item per issue, thread or channel-day, a cursor on the source, `Retry-After` handled, private by default. See `docs/services.md`.
- Inbox signal "No reply yet" from e-mail items (you asked, nobody answered, 3 to 30 days). Deterministic, no AI.
- `src/brain/actions.js` (migration v20): an action is proposed with its exact arguments, shown in the Inbox, and runs only when approved, once, with those arguments. One action exists: a Linear issue from an accepted promise.

**Tested only against simulated servers** that follow each service's documented API: none of these connectors has talked to the real GitHub, Slack, Discord or Google, which needs the person's own accounts.

Not built: incremental Google Calendar sync (the calendar re-reads its window and caches it; a sync-token cache would be a rewrite of that cache for little gain); natural-language rules (a safe version needs a model that turns a sentence into a structured rule, a preview of what it would do, and the same approval gate; none of that exists); a vault mode (locking the app with a passphrase needs encryption at rest, which node:sqlite does not offer); the pre-meeting brief phrased by an AI (the facts-only brief is what exists); a Discord data-package import.

## Order of work (Phase 1)

1. The "Doors" navigation shell (`ui/nav.js`). It maps onto today's pages, so nothing becomes unreachable (`test/navigation.test.js`).
2. `jobs` + the runner, then move the post-recording chain onto it (with a test that quits midway and resumes).
3. `sources` + `items`, with a backfill that gives every existing note an item.
4. `entities` + `entity_identities`, with a backfill from speakers, attendees and voice prints. `Knowledge.people()` reads them and keeps its API shape.
5. The folder/Obsidian connector in pointer mode, the first new source.

## Consequences

- Each step ships on its own and keeps every existing test green.
- Everything is additive: an older WhisperBrain cannot open the newer database, and the pre-migration copy is how a person goes back.
- A few things are computed twice for a while (`people()` from names, and entities) until step 4 switches the readers.

## Glossary

- **item**: one captured thing.
- **chunk**: a searchable piece of an item.
- **entity**: a person, project, organisation or topic.
- **identity**: an identifier that points at an entity.
- **assertion**: a statement with a kind and a state.
- **edge**: a typed link.
- **provenance**: where a row came from.
- **signal**: a card that asks for the person's attention (Inbox, Phase 3).
- **job**: a durable unit of background work.
