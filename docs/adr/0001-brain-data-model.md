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
