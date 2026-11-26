# WhisperBrain as an MCP server

Other tools (Claude Code, Claude Desktop, Cursor, a launcher) can ask your brain a question. The server is **read-only**: it opens the database in read-only mode, so it cannot change anything, and it never shares anything from a source you marked **private** (the one on the other end may be a remote model). Promises and decisions are shared only once **you accepted** them.

```bash
claude mcp add whisperbrain -- node /path/to/whisperbrain/scripts/mcp-server.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "whisperbrain": { "command": "node", "args": ["/path/to/whisperbrain/scripts/mcp-server.js"] } } }
```

`--data <folder>` points at another data folder (default: the app's own). WhisperBrain must have been opened once on this version, so that the database is up to date.

| Tool | What it does |
|---|---|
| `search` | Meetings and notes by words (and by meaning when an embedding model is set up), with where each excerpt comes from |
| `get_note` | The text of one note or file, or a meeting's summary |
| `list_people` / `get_person` | Who you have met, how they are known, recent meetings, promises open with them |
| `open_commitments` | What you owe, what others owe you |
| `recent_decisions` | Decisions you accepted, newest first |

The transport is stdio (one JSON message per line). There is no tool that writes.
