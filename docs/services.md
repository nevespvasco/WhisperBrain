# Connecting services

Folders & vaults → **Connect a service**. Everything is **read-only**, the keys are kept sealed on this computer, and what is read is **private by default**: only an AI on this computer may ever see it (change it per source). A copy of the text is kept so it can be searched; removing a source forgets that copy and touches nothing at the service.

| Service | What you give it | What is read | Notes |
|---|---|---|---|
| **GitHub** | A personal access token with read access to the repositories | Issues and pull requests with their comments, one item each | Only what changed since the last run (`since`); every 15 min |
| **Slack** | The token of **your own** Slack app (`channels:history`, `channels:read`, `users:read`, and `groups:history` for private channels) | Channels you list, one item per channel per day, replies included | An app of your own is not under the limits Slack put on shared apps. A short `Retry-After` is waited out; a long one stops the run until the next |
| **Discord** | Your own bot token (the same as the voice feature), View Channel + Read Message History, Message Content intent on | Channels you list, one item per channel per day | Your own server only. Personal accounts and unofficial clients are never used |
| **Gmail** | Your Google OAuth client, connected again **with mail switched on** (`gmail.readonly`) | Threads matching your search (default the last 90 days), plain text, quoted history cut | Incremental by `historyId`; a stale history (404) starts again and tombstones what left the window |
| **Notion / Linear** | The keys already in Integrations | Pages and issues you **already imported**, read again every 6 h | Nothing new is pulled in by itself |

**What the e-mail connector adds to the Inbox:** a thread where you wrote last, asked something, and nobody answered for 3 to 30 days ("No reply yet"). Nothing is sent: it can be opened, turned into a reminder, or dismissed.

**Approved actions.** An action that reaches outside (today: a Linear issue made from a promise you accepted) is *proposed* and waits in the Inbox with its exact text. It runs only when you approve it, with exactly what you saw. Nothing the AI reads (an e-mail, a transcript) can run one; the MCP server has no tool that writes.

## What has and has not been tested

The connectors are tested against **simulated servers** that follow each service's documented API (`test/services.test.js`): cursors, one item per thread or per day, rate limits, bad tokens, tombstones, privacy. They have **not** been run against the real GitHub, Slack, Discord or Google, which needs your own accounts. Expect to meet a difference or two the first time (a scope name, a field a real server sends differently); the error shown on the source card says what the service answered.
