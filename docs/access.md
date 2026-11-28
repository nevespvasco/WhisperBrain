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

## More than one mailbox

Each Google account is its own **source** with its own access (a work and a personal mailbox can be set differently). The first
sign-in is also the calendar. Accounts live in **Settings › Access & privacy**: reconnect, sign out, add another. If Google
withdraws access (a token that expired, a password change), syncing pauses, what was read stays, and the card shows **Reconnect**.

## Searching

- **What is kept here** is searched as before (⌘K, the Library, Ask).
- **Live search** asks the service itself, so older mail is found too. Only sources whose access allows it are asked, only with the
  filter of that source added, and the answers are checked against it again. In ⌘K choose *Search … for “…”*; Ask does it by itself
  when the kept copy has little to say (Settings › `askLiveSearch`) and says so (“Searched Gmail for …”). A result you open is kept for
  the number of days you set (1, 7 or 30) unless you keep it.
- Answers are cached for 15 minutes, keyed by the question **and** the source's access, so changing the access never serves what the
  old one allowed. The access log records that a question went out, never what it was.
- Not possible: Gmail under “only who and when” (Google refuses searches there), Discord (it has no search), Slack without a user
  token (`search:read`), Notion beyond titles.

## Linking mail to people and meetings

Mail and messages are tied to the people in them **only when they are people you already know** (met in a meeting, or merged by an
e-mail address). A newsletter or no-reply sender never creates a person. That gives:
- a **timeline** on each person's page (meetings, mail and messages in one line) and on each project;
- **recent mail** with the people coming to a meeting in its brief (with “Look in my mail now” for a live look), and for the live
  assistant during a call, only when its AI server may see that source;
- **related mail and messages** on a meeting page, which you can unlink. The invitation mail of the very event is tied to it too.

## Leak prevention

- **An AI server that is not on this computer** gets nothing from a source kept “only on this computer”, on any path: Ask and its
  re-ranking, summaries, titles, translation, decision extraction, the brief's wording, retrieval for tools, MCP. *This computer*
  means `localhost`, `127.x.x.x` or `::1` only: a server elsewhere on your network (`192.168.x.x`, `10.x.x.x`, `*.lan`, `*.local`)
  is another computer, is redacted like any remote server, and counts in the activity log as text that left
  (`isThisComputer`, `src/core/policy.js`). An organisation's `requireLocalLlm` still accepts a server on its own network.
- With **“any AI server”** (and `redactRemote`, on by default) e-mail addresses, phone numbers, IBAN and card numbers, keys, one-time
  codes and secret links are replaced by placeholders (`<email_1>`) before the text leaves, and put back in the answer here.
- **Mail is data, not instructions.** Excerpts from a sender you have never dealt with are marked *(unverified sender)*; the AI is told
  that what they say is a claim, and the answer shows a badge on that source.
- **Actions are checked before you see them**: a recipient who is not in the thread and was not typed by you, a link that was not in
  the conversation, material from another source going to an outside address. The last two kinds need a second, separate yes. A
  sent message is the approved message itself (no draft in between that could be edited), and the proposal refuses to run if its
  arguments changed after they were shown. Proposals expire after 7 days.
- **Forget a person** deletes the mail that is only between you and them, blocks their addresses from being read again and removes
  what links them to mail; meetings they were in stay.

## Actions

For Gmail (each one waits in the Inbox with its exact text; nothing is sent or changed before you approve): write a draft, send,
add/remove labels, archive, mark as read; many threads at once are one proposal. They come from the *Reply…* button (Ask, the
Inbox's “No reply yet”, a thread), “Email the recap…” on a meeting, and **rules on mail** (“label newsletters”): a rule proposes
**one** action for all the threads it finds, never one card each. Slack, GitHub, Discord, Notion and Linear have their own actions
(post, comment, open an issue, create a page) under the same approval.

## Other services

The same five choices apply to Slack, GitHub, Discord, Notion, Linear, folders and vaults, the calendar (*everything* or *only when
I am busy*) and, in `docs/access-mail.md`, Outlook / Microsoft 365, any IMAP mailbox and a Google Takeout `.mbox`. The Teams, Meet and
Zoom transcripts have their cards under Integrations.

## What is and is not done

- **Done and tested against simulated services:** everything above. A simulated Gmail refuses searches and bodies under the metadata
  permission like the real one.
- **Not tried against the real services** (Gmail, Slack, GitHub, Discord, Notion, Linear, Outlook, IMAP servers, the platforms'
  transcript APIs): that needs your own accounts. Expect a difference or two the first time; the card of a source says what the
  service answered.
- **Google's rules:** the Gmail permissions (`metadata`, `readonly`, `compose`, `modify`) are “restricted”. A client left in
  Google's “Testing” mode makes tokens expire after 7 days; publish it (“In production”), and without Google's security review the
  app is unverified and capped at 100 users. That is why you may bring your own client.
- **Outlook, IMAP and `.mbox` are read-only for now:** their access sheet offers the read levels, live search and the never-read list, but no
  actions (drafts, send, labels): only Gmail has those. The wire code for them exists (`imap-client.js`, `smtp-client.js`, the Graph permission helpers).
- **Not done:** encryption of the database on disk (use disk encryption); deleting backups you saved to a folder of your own (they
  are listed, you decide); reading attachments other than PDF and text.
