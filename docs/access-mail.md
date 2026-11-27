# Mail from Outlook, any IMAP server, and mbox files

Gmail is in `docs/access.md`. This page is the same idea for the other ways to bring mail in: **Outlook / Microsoft 365 /
outlook.com** (through Microsoft Graph), **any IMAP server**, and **an mbox file** (Google Takeout and others).

> **Honest status: none of this has been run against a real Outlook account or a real IMAP server.** It was written from
> Microsoft's and the IETF's documentation and tested only against simulated servers (`test/outlook.test.js`, `test/imap.test.js`,
> `test/mbox.test.js`). Those tests prove the logic (levels, never-read, resuming, tombstones); they cannot prove that a real server
> answers the way the simulation does. Try each one on a real mailbox before relying on it, and expect small fixes.

## What each one needs

| Source | You provide | Kept in |
|---|---|---|
| **Outlook** | An app registered in Microsoft Entra (Azure) as a *public client* ("Mobile and desktop applications"), its client ID, and a sign-in in the browser. No secret is needed. | `settings.outlook` (tokens sealed like other secrets) |
| **IMAP** | Server, port, user, and a password (usually an **app password**) or an OAuth token (XOAUTH2). | `settings.imapAccounts` (password and tokens sealed) |
| **mbox** | The file. Nothing else; it is read once and not kept. | nothing (the items it makes are the copy) |

## Outlook (Microsoft Graph)

| Level | Microsoft permission asked | What is read |
|---|---|---|
| Only who and when | `Mail.ReadBasic` | from, to, cc, subject, received date, conversation, categories, folder. Never the body, the preview or the headers. |
| A part / everything | `Mail.Read` | the above plus the body as text (quoted history cut, also Outlook's "From:/De: … Sent:/Enviado:" blocks), attachment names and sizes, the `List-Unsubscribe` header |
| Draft, label, archive, mark read | `Mail.ReadWrite` (instead of the above) | asked only when the grant lists such an action |
| Send | `Mail.Send` (in addition) | asked only when the grant lists "send" |

Sign-in basics (`offline_access`, `User.Read`, `openid`, `email`, `profile`) are always asked. Changing level means signing in
again (Microsoft cannot take back one permission alone). What Microsoft **really** granted is kept (`settings.outlook.scopes`) and
wins over the grant: with only `Mail.ReadBasic` nothing reads a body even if the grant says "everything".

- **Tenant** is `common` by default, so work, school and personal (outlook.com, hotmail, live) accounts can all sign in. Set a
  tenant id to restrict it.
- **Redirect.** The sign-in uses a loopback address (`http://127.0.0.1:<port>/callback`) with PKCE, like the other sign-ins here.
  Microsoft's portal prefers `http://localhost` for desktop apps; if `127.0.0.1` is refused, register it through the app manifest.
  *Not verified.*
- **Sync** uses Graph *delta queries*, one per folder (Inbox, Sent Items, Archive; the Archive folder is skipped if the mailbox has
  none). A delta says *which* messages changed; their whole conversation is then read (a conversation spans folders). Messages in
  Deleted Items or Junk do not count; a conversation with nothing else left is tombstoned. `@removed` messages are matched to their
  conversation through a short digest of each message id kept in the item (Graph gives a message a **new id** when it moves).
- **Resuming.** A run reads at most 400 conversations; the cursor (JSON in the source) keeps each folder's page link, so the next
  run continues exactly there. If Microsoft expires the delta state (HTTP 410), every folder is read again and what is no longer
  there is tombstoned. Changing the level, the date window, the folders or the grant's filter also reads everything again.
- **Limits you will notice.**
  - Graph `$search` (live search) **cannot be combined with `$filter` or `$orderby`** and returns at most about 250 hits, so the
    grant's filter and the never-read list are applied to the hits *after* they arrive; a narrow filter can leave fewer results than
    asked for. Live search is not offered at the metadata level.
  - A delta accepts `$filter` only on the received date, so labels (categories), sender domains and excluded senders are also applied
    after download. The **never-read list is always applied here**, whatever Graph could filter.
  - At the metadata level the `List-Unsubscribe` header is not read, so `newsletter` is `null` (unknown), not `false`.
  - Throttling (HTTP 429): a short `Retry-After` is waited out once; a long one stops the run, keeps the pages already done, and
    says when to try again.
  - Work and school tenants can require an administrator to approve `Mail.Read`; that is Microsoft's policy, not ours.

## IMAP

- **Passwords.** Gmail, iCloud, Fastmail, Yahoo and most others want an **app password** (made in the account's security page), not
  the normal password. A server that offers neither TLS nor STARTTLS is refused unless it is on this computer: the password is not
  sent in clear across a network. A certificate that is not trusted is refused (there is no switch to accept it yet).
- **Microsoft accounts over IMAP** need **XOAUTH2** (Exchange Online has retired password logins): an access token for the scope
  `https://outlook.office.com/IMAP.AccessAsUser.All offline_access`. An account may carry `refreshToken`, `tokenUrl`, `clientId`
  (and `oauthScope`) so the token is renewed and saved; without them the token simply expires. For Microsoft mail, the **Outlook
  (Graph) source above is the better choice**; IMAP is the fallback. *Not verified.*
- **What is read.** Folders default to `INBOX` and the one the server marks `\Sent`; Trash and Junk are never read. The metadata level
  fetches **headers only** (`BODY.PEEK[HEADER.FIELDS (…)]`): no body is ever requested. Part/everything also read the text with
  `BODY.PEEK`, so nothing is marked read. A message is read to 1 MB; attachment sizes beyond that are lower bounds.
- **Threads** are made here (IMAP has none): the oldest message id a message points at (`References`, else `In-Reply-To`, else its
  own) names the thread; a reply that lost those headers is joined by its normalised subject. When mail arrives, the whole thread is
  found again by searching the folders for that id.
- **Resuming and changes.** Per folder the cursor keeps `UIDVALIDITY`, the highest UID seen, where the first backfill got to (newest
  mail first), the message count and, where the server has CONDSTORE, `HIGHESTMODSEQ`. New mail is always read first. A count that no
  longer matches (or a changed mod-sequence) makes the run compare the folder's live UIDs with the UIDs each thread remembers, so
  deleted or moved mail shrinks or tombstones its thread. A changed `UIDVALIDITY` means every UID is meaningless: everything is read
  again from the date window and what is no longer there is tombstoned.
  - Without CONDSTORE a message flagged `\Deleted` is noticed by a `SEARCH DELETED` each run; changes to custom keywords are not.
  - With CONDSTORE only `\Deleted` and custom keywords count as a change; `\Seen` toggles do not re-read anything.
- **Live search** uses `X-GM-RAW` when the server is Gmail (so Gmail's own syntax works) and `TEXT`/`FROM`/`SUBJECT` elsewhere.
- **For later** (the wire is built and tested, nothing uses it yet): `UID STORE` flags, `UID MOVE` (or `COPY` + `\Deleted` + `UID
  EXPUNGE`; never a blanket `EXPUNGE`), `APPEND` to Drafts, and an SMTP client (TLS or STARTTLS, `AUTH PLAIN` / `LOGIN` /
  `XOAUTH2`, dot-stuffing, addresses checked so a value cannot add a command). Every send still waits for approval in the Inbox.

## mbox files

- Google Takeout: *Mail* gives `All mail Including Spam and Trash.mbox`. Threads use Gmail's own `X-GM-THRID`; labels come from
  `X-Gmail-Labels` and can be used in the grant's filter. **Spam and Trash are left out; drafts are not part of a thread.**
- Read as a stream (never loaded whole), split on `From ` lines that follow a blank line, `>From` escaping undone (mboxrd).
- **Limits.** A file bigger than `maxBytes` (8 GiB by default) is refused before anything is read; a stream is cut at the limit and
  the message being read is dropped (`truncated: true`). A single message is read to 25 MB. Memory is roughly what each thread keeps
  (up to 40 000 characters) while the file is read, so import a very large archive one year at a time (`filter.after` / `before`).
- Importing again changes nothing that did not change. `replace: true` also tombstones threads an earlier import had and this file
  does not.
- Who "me" is comes from `Delivered-To` headers, messages labelled Sent, and `source.config.me`.

## The never-read list and the levels, everywhere

Every mail source applies the same rules to what it keeps: the **never-read list** (senders, domains, labels/categories/folders,
subject words) is checked on every thread after download; the **metadata level** keeps who, when and subject and no text; a level or
filter change forgets what is no longer allowed. All three produce the same item as Gmail's, so people, "last contact" and "No reply
yet" work the same.

## What was not tested against real services

- Any call to Microsoft Graph or to Microsoft's sign-in (field availability under `Mail.ReadBasic`, the `proxyAddresses` alias list
  on `/me`, `$expand=attachments`, the `127.0.0.1` redirect, throttling behaviour, delta expiry).
- Any real IMAP server (Dovecot, Cyrus, Exchange, Gmail, iCloud, Fastmail…): header-search support, `CONDSTORE` details, quirks in
  `UID n:*`, modified-UTF-7 folder names, very large mailboxes.
- Any real SMTP server, and TLS against a certificate chain that is not the throwaway one the tests make (they do check that an
  untrusted certificate is refused).
- A real Google Takeout file (the format is from its documentation and from common exports).
