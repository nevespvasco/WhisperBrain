# ADR 0002 — Access grants: one rule for what each source may give

- Status: accepted (2026-11-27)
- Scope: phase 0 of the access plan (grants, enforcement, hardening). The access sheet, multiple Google accounts, live search,
  correlation, Gmail actions, the other services' levels and Outlook/IMAP come in later phases (`docs/access.md`).

## Context

Connectors read mail, chat and files, but the only control was `sources.sensitivity` (normal | private), nobody was asked about it,
and several paths ignored it:
- `mayShare` answered yes for every meeting, so Notion/Linear imports never followed their source;
- `/api/retrieve` and the MCP server used their own rules (MCP read the database while the app was locked);
- an approval could run twice (the row stayed `pending` while the action ran);
- "Delete everything" left items, sources, the search index, people, actions and the AI ledger behind, and the copies made before each
  schema update kept the mail too;
- Gmail asked only for `messageAdded` history, jumped its cursor past what it had not read, and kept trashed threads.

## Decision

**1. A grant lives on its source** (migration v26), with two axes:
- what may be read: `read_level` none · metadata · part · all, plus `filter` (the part, and a "never read" list);
- which actions may be proposed: `actions` (each still waits for approval); `auto_actions` only for exporting one's own meeting notes.

Beside them: `ai_reach` local · ask · any (replaces `sensitivity`, which is kept in step), `live_search`, `mcp`, `retention_days`,
`expires_at`. An item may be stricter than its source (`items.ai_reach`), never looser.

**2. One function decides**: `can(source, op, { item, llmConfig, confirmed })` in `src/access/grants.js`. Every path asks it:
Ask (and its reranker), summaries, titles, insights, translation, decision extraction, the brief's narrative, `/api/retrieve`, MCP, the
connectors' sync, and actions (when proposed and again when run). A meeting follows the source it came from.

**3. Narrowing forgets at once.** Down to `metadata` drops the bodies; `none` drops the items; the chunk index (words and vectors)
follows in the same moment. Removing a source does the same.

**4. Hardening that had to come first:** atomic approval (`pending → running` claimed by one statement) and expiring proposals
(7 days); MCP refuses while the app is locked (the lock state is written to `index_meta`); "Delete everything" covers every table and the
pre-update copies; Gmail asks for every history type, keeps a resumable cursor, tombstones Trash/Spam, counts Cc and send-as aliases,
opens links in the right account, and cuts Outlook/pt-PT quoted text.

## Consequences

- Existing sources keep exactly what they did (the migration maps them).
- A test sends secrets through every content-carrying AI path with a server that counts as remote and proves none leaves
  (`test/access.test.js`), and repeats it with a local server to prove the test can see them.
- `ai_runs.source_ids` says which sources each AI call carried; `access_log` records grant changes (later: live searches, actions run).
- Not done here: encryption at rest (still open; the UI must not claim it), backups in a folder the person chose (listed, not deleted).
