# What each source may give (access grants)

When you connect a service or add a folder, WhisperBrain asks what it may do with it. You can change it at any time; narrowing it
forgets what is no longer allowed straight away.

| You choose | What happens |
|---|---|
| **Nothing** | Nothing is read. What was read before is deleted (the source stays, so you can open it up again). |
| **Only who and when** (metadata) | Sender, recipients, date and subject. No body, and not Gmail's preview snippet either. Still enough for people, "last contact" and "No reply yet". |
| **A part** | What your filter allows: labels, senders or domains, a date window, channels, repositories. |
| **Everything** | The whole mailbox, workspace or folder. |
| **Read + actions** | Any of the above, plus actions you tick (for mail: draft a reply, label/archive, send). **Every action waits for your approval** in the Inbox, with its exact text. |

**Never read.** A list of senders, domains, labels or subject words (HR, legal, medical…). What Gmail can filter is left out at Google;
everything is checked again here before anything is stored.

**Who may see it.**
- *Only an AI on this computer* (the default for mail and chat).
- *Ask me each time*.
- *Any AI server I chose*.

One thread can be kept on this computer even when its source may go further.

**MCP.** Other tools (Claude Desktop, Cursor…) can read a source over MCP only when you switch that on for it, and never while the
app is locked.

**Records.** Settings › Activity shows each AI call, where it went, and which sources it carried. The access log keeps grant changes
(and, as they arrive, live searches and actions run). Neither keeps any content.

## Gmail by level

| Level | Google permission asked |
|---|---|
| Only who and when | `gmail.metadata` (Google then refuses searches and bodies, so the part is chosen here, by label) |
| A part / everything | `gmail.readonly` |
| Drafts, send | `gmail.compose` |
| Label, archive, mark read | `gmail.modify` (Google's consent screen describes it as read, compose and send) |

Changing level means signing in to Google again: Google cannot take back one permission alone, and the metadata permission cannot
be combined with the others.

## What is and is not done yet

- **Done:**
  - grants on every source, and one rule used by every AI path, MCP and actions;
  - immediate forgetting when narrowed;
  - atomic approvals and expiring proposals;
  - full "Delete everything";
  - Gmail metadata and part levels, with the never-read list, a resumable sync and Trash/Spam/delete propagation.
- **Next:**
  - the sheet in the app;
  - several Google accounts;
  - live search with a cache;
  - mail linked to people and meetings;
  - Gmail actions;
  - the same levels for Slack, GitHub, Discord, Notion, Linear and Calendar;
  - Outlook/Microsoft 365 and IMAP.
- **Not done:**
  - encryption of the database on disk (use disk encryption);
  - deleting backups you saved to a folder of your own (they are listed, you decide).
