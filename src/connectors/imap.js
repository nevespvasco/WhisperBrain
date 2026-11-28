'use strict';
// Mail from any IMAP server (Fastmail, iCloud, Zoho, a company server, Gmail or Outlook over IMAP...) as items: one per THREAD, the
// same shape as the Gmail connector's, with no library. What is read follows the source's access grant (src/access/grants.js):
// 'metadata' fetches HEADERS ONLY (no body is ever requested: BODY.PEEK[HEADER.FIELDS (...)]), 'part' / 'all' also read the text
// (BODY.PEEK, so nothing is marked read). The "never read" list is applied here after download, always.
//
// IMAP has no threads, so they are made here: a message belongs to the thread named by the oldest id it points at (the first
// Message-ID in References, else In-Reply-To, else its own); a reply that lost those headers is matched by its subject. When a
// message arrives, the whole thread is found again by searching the folders for that id and read whole.
//
// What a run keeps, per folder, in the source cursor (JSON): UIDVALIDITY, the highest UID seen (`hi`), the lowest UID of the first
// backfill (`lo`: newest mail is read first, older mail in later runs), the message count (`n`) and, where the server has CONDSTORE,
// the HIGHESTMODSEQ. A changed UIDVALIDITY means every UID we knew is meaningless: everything is read again from scratch and what
// is no longer there is tombstoned. A run reads at most `budget` messages; the rest waits for the next run: nothing is skipped.
// Gone messages: a count that no longer matches (or CONDSTORE saying something changed) makes the run list the folder's live UIDs
// and compare them with the UIDs each stored thread remembers (meta.refs).
//
// UNVERIFIED against real servers: written from the RFCs and tested against a simulated server (test/imap.test.js).
const { ImapClient, qs, uidSet, isLoopback } = require('./imap-client');
const { parseMessage } = require('../importers/mime');
const { can } = require('../access/grants');
const M = require('./mail-common');

const every = 10 * 60_000;
const MAX_MESSAGES = 400;               // messages read per run
const MAX_SEEN = 20_000;
const ARRIVALS_FLOOR = 50;              // new messages read per folder per run even when the budget is spent (new mail never starves)
const RETRY_TRIES = 3, MAX_RETRY = 200; // a thread the server refused is tried again on the next runs, then given up (counted as errors)
const FETCH_BYTES = 1_000_000;          // a message is read to this size (attachments past it are not needed: only names and sizes are kept)
const HEADER_FIELDS = 'FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE';
const SKIP_USE = new Set(['\\trash', '\\junk']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

// ---------- accounts and connecting ----------
// settings.imapAccounts: [{ id, label, host, port, tls, user, password, authMethod: 'password' | 'xoauth2', accessToken, refreshToken, expiresAt, clientId, clientSecret, tokenUrl, aliases }]
function accountFor(ctx, id) {
  const list = ctx.imapAccounts?.list?.() || ctx.settings?.get?.('imapAccounts') || [];
  if (id) return list.find((a) => a.id === id) || null;
  return list.length === 1 ? list[0] : null;
}
function saveAccount(ctx, id, patch) {
  if (ctx.imapAccounts?.save) return ctx.imapAccounts.save(id, patch);
  const list = ctx.settings?.get?.('imapAccounts') || [];
  ctx.settings?.update?.({ imapAccounts: list.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  return null;
}
// the access token of an XOAUTH2 account: the one kept while it is fresh, else a new one from its refresh token (when the account has the
// means to refresh: tokenUrl and clientId), kept for next time
// Two runs of the same account at once (a sync and a live search) share one refresh: refresh tokens are often single-use, and a
// second refresh with the old one would revoke the sign-in.
const refreshing = new Map();
async function accessTokenOf(ctx, account, { now = Date.now() } = {}) {
  if (account.accessToken && (!account.expiresAt || account.expiresAt - now > 60_000)) return account.accessToken;
  if (!account.refreshToken || !account.tokenUrl || !account.clientId) {
    if (account.accessToken) return account.accessToken;               // no way to refresh: try what there is, the server will say
    throw Object.assign(new Error('This account has no access token: sign in again.'), { permanent: true, code: 'imap-auth' });
  }
  let url;
  try { url = new URL(account.tokenUrl); } catch { url = null; }
  // the refresh token and client secret go in the body: never over plain http (a loopback address is allowed, for tests)
  if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw Object.assign(new Error('The token address of this mail account must start with https://.'), { permanent: true, code: 'imap-auth' });
  }
  const id = account.id ?? account.tokenUrl;
  if (refreshing.has(id)) return refreshing.get(id);
  const p = refreshToken(ctx, account, now).finally(() => refreshing.delete(id));
  refreshing.set(id, p);
  return p;
}
async function refreshToken(ctx, account, now) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken, client_id: account.clientId, ...(account.clientSecret ? { client_secret: account.clientSecret } : {}), ...(account.oauthScope ? { scope: account.oauthScope } : {}) });
  const res = await (ctx.fetchImpl || globalThis.fetch)(account.tokenUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw Object.assign(new Error(j.error === 'invalid_grant' ? 'This mail sign-in expired or was revoked: sign in again.' : `Token refresh failed: ${j.error_description || j.error || `HTTP ${res.status}`}`), { permanent: j.error === 'invalid_grant', code: 'imap-auth' });
  }
  const patch = { accessToken: j.access_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000, ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}) };
  saveAccount(ctx, account.id, patch);
  return patch.accessToken;
}

// a connected, logged-in client for an account (ctx.imapConnect lets a test hand one in)
async function connectFor(ctx, account) {
  if (ctx.imapConnect) return ctx.imapConnect(account);
  const xoauth = account.authMethod === 'xoauth2';
  const client = new ImapClient({
    host: account.host, port: Number(account.port) || (account.tls === false ? 143 : 993), tls: account.tls !== false, user: account.user, password: account.password,
    authMethod: xoauth ? 'xoauth2' : 'password', accessToken: xoauth ? await accessTokenOf(ctx, account) : undefined,
    rejectUnauthorized: account.rejectUnauthorized !== false, allowPlaintext: !!account.allowPlaintext, ca: account.ca,
  });
  try { await client.connect(); await client.login(); } catch (e) { client.close(); throw e.code === 'imap-auth' ? Object.assign(e, { permanent: true }) : e; }
  return client;
}

// ---------- config ----------
function validate(config = {}) {
  const days = Math.max(1, Math.min(3650, Math.round(Number(config.days) || 90)));
  const folders = M.list(config.folders, 10);
  return { account: String(config.account || '').slice(0, 60), days, folders: folders.length ? folders : ['INBOX', '\\Sent'], aliases: M.list(config.aliases, 10).map((a) => a.toLowerCase()) };
}
const ready = (ctx, config = {}) => { const a = accountFor(ctx, config.account); return !!a && !!a.host && !!a.user && (a.authMethod === 'xoauth2' ? !!(a.accessToken || a.refreshToken) : !!a.password); };

// What an IMAP server can do with the grant's filter: its date window (SINCE) and the folders. Labels, senders and domains are checked
// here after download (an IMAP SEARCH could do some, but servers differ), and the never-read list always is.
function compileFilter(config = {}, filter = {}, { now = Date.now() } = {}) {
  const { days, folders } = validate(config);
  const { never = {}, ...local } = filter || {};
  return { since: imapDate(now - days * 86_400_000), folders, local, never };
}

// the folders to read, as real mailbox names: names as given, or a special-use flag like \Sent; Trash and Junk are never read
async function resolveFolders(client, wanted) {
  const boxes = await client.list();
  const out = [];
  const seen = new Set();
  const add = (b) => { if (b && !seen.has(b.name) && !SKIP_USE.has(b.specialUse.toLowerCase()) && !b.flags.some((f) => /^\\noselect$/i.test(f))) { seen.add(b.name); out.push({ name: b.name, label: b.name.split(b.delimiter || '/').pop() }); } };
  for (const w of wanted) {
    if (w.startsWith('\\')) add(boxes.find((b) => b.specialUse.toLowerCase() === w.toLowerCase()));
    else add(boxes.find((b) => b.name === w) || boxes.find((b) => b.name.toLowerCase() === w.toLowerCase()));
  }
  return out;
}

// ---------- messages ----------
const bracket = (id) => (id ? `<${id}>` : '');
// a fetched message -> the normalised message (src/connectors/mail-common.js) and its thread key
function toMessage(f, { metadataOnly, folder }) {
  const parsed = parseMessage(f.raw || f.headers || Buffer.alloc(0), { headersOnly: metadataOnly || !f.raw });
  const at = parsed.date || f.internalDate || 0;
  const text = metadataOnly || !f.raw ? '' : M.cutQuote(parsed.text);
  const tk = M.threadKeyOf({ messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references, subject: parsed.subject });
  return {
    key: tk.key, uid: f.uid, folder,
    msg: {
      from: parsed.from, to: parsed.to.map((a) => a.address), cc: parsed.cc.map((a) => a.address), subject: parsed.subject, at, text,
      labels: [folder.label, ...f.flags.filter((x) => !x.startsWith('\\'))], unsubscribe: parsed.listUnsubscribe, attachments: metadataOnly ? [] : parsed.attachments,
      draft: f.flags.some((x) => x.toLowerCase() === '\\draft'), messageId: bracket(parsed.messageId), references: parsed.references.map(bracket),
    },
  };
}
const FETCH_HEAD = `UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`;
const FETCH_FULL = `UID FLAGS INTERNALDATE BODY.PEEK[]<0.${FETCH_BYTES}>`;

// fetch in chunks so one command never carries an enormous uid list
async function fetchChunks(client, uids, items, chunk = 50) {
  const out = [];
  for (let i = 0; i < uids.length; i += chunk) out.push(...await client.fetch(uidSet(uids.slice(i, i + chunk)), items));
  return out;
}

// the uids in the selected folder that belong to a thread key (before the local check that makes it exact)
// Control characters are left out of the search (a CR/LF or NUL in a crafted Message-ID makes servers refuse the command); the
// search only finds candidates, the exact key is checked locally after fetching.
async function memberUids(client, key) {
  const k = M.parseKey(key);
  const value = k?.value?.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!value) return [];
  if (k.kind === 'm') return client.search(['NOT', 'DELETED', 'OR', 'OR', 'HEADER', 'Message-ID', qs(value), 'HEADER', 'References', qs(value), 'HEADER', 'In-Reply-To', qs(value)]);
  return client.search(['NOT', 'DELETED', 'SUBJECT', qs(value)]);
}

// A command the server answered NO or BAD: about this thread or message only, the connection still works. A dropped connection
// or a timeout is not this, and stops the run.
const refused = (e) => e?.code === 'imap';

// fetchChunks, but a chunk the server refuses is fetched again one message at a time; uids that still fail go to onRefused
async function fetchIsolated(client, uids, items, onRefused, chunk = 50) {
  const out = [];
  for (let i = 0; i < uids.length; i += chunk) {
    const part = uids.slice(i, i + chunk);
    try { out.push(...await client.fetch(uidSet(part), items)); continue; } catch (e) { if (!refused(e)) throw e; }
    for (const u of part) {
      if (part.length === 1) { onRefused(u); break; }
      try { out.push(...await client.fetch(uidSet([u]), items)); } catch (e) { if (!refused(e)) throw e; onRefused(u); }
    }
  }
  return out;
}

// threads, from every folder: { got: key -> [{ msg, ref: { f, v, u } }], failed: Set of keys }. Folders are read one after the
// other (one SELECT each). A thread whose search or messages the server refuses is `failed`: it is incomplete, so it must be
// neither stored nor tombstoned, and the other threads go on.
async function gatherThreads(client, folders, keys, { metadataOnly, uvOf }) {
  const out = new Map(keys.map((k) => [k, []])), failed = new Set();
  for (const f of folders) {
    const info = await client.select(f.name, { readOnly: true });
    uvOf?.(f, info);
    const found = new Map();                                    // uid -> keys it may belong to
    for (const key of keys) {
      if (failed.has(key)) continue;
      let uids;
      try { uids = await memberUids(client, key); } catch (e) { if (!refused(e)) throw e; failed.add(key); continue; }
      for (const u of uids) (found.get(u) || found.set(u, new Set()).get(u)).add(key);
    }
    const lost = (u) => { for (const k of found.get(u) || []) failed.add(k); };
    const msgs = await fetchIsolated(client, [...found.keys()], metadataOnly ? FETCH_HEAD : FETCH_FULL, lost);
    for (const m of msgs) {
      if (m.flags.some((x) => x.toLowerCase() === '\\deleted')) continue;
      let r;
      try { r = toMessage(m, { metadataOnly, folder: f }); } catch { lost(m.uid); continue; }
      if (found.get(m.uid)?.has(r.key)) out.get(r.key).push({ msg: r.msg, ref: { f: f.name, v: info.uidValidity, u: m.uid } });
    }
  }
  return { got: out, failed };
}

const addressesOf = (ctx, account, cfg) => new Set([account.user, account.email, ...(Array.isArray(account.aliases) ? account.aliases : M.list(account.aliases)), ...cfg.aliases].filter((a) => a && String(a).includes('@')).map((a) => String(a).toLowerCase()));

function itemFor(key, members, me, metadataOnly) {
  return M.buildThreadItem({ externalId: `thread:${key}`, uri: '', msgs: members.map((m) => m.msg), me, metadataOnly, extraMeta: { threadKey: key, refs: members.map((m) => m.ref).slice(0, 200) } });
}

// ---------- the cursor ----------
// { k: signature, f: { folder: { uv, hi, lo, n, ms } }, resync, seen: [digests] }
function readCursor(s) { if (!s) return {}; try { const c = JSON.parse(s); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch { return {}; } }
const writeCursor = (c) => JSON.stringify(c);

// which stored threads remember one of these uids in this folder? -> Set of thread keys
function threadsWith(items, sourceId, folderName, uv, test) {
  const out = new Set();
  for (const it of items.list({ sourceId, limit: 1_000_000 })) {
    if ((it.meta?.refs || []).some((r) => r.f === folderName && r.v === uv && test(r.u))) out.add(it.externalId.replace(/^thread:/, ''));
  }
  return out;
}
const keywordsOf = (flags) => flags.filter((f) => !f.startsWith('\\'));

async function check(ctx, source = null) {
  const account = accountFor(ctx, source?.config?.account);
  if (!account) throw Object.assign(new Error('No such mail account.'), { permanent: true });
  const client = await connectFor(ctx, account);
  try {
    const boxes = await client.list();
    return { ok: true, email: account.user, host: account.host, folders: boxes.map((b) => b.name), capabilities: { condstore: client.caps.has('CONDSTORE'), move: client.caps.has('MOVE'), uidplus: client.caps.has('UIDPLUS'), gmail: client.caps.has('X-GM-EXT-1') } };
  } finally { await client.logout(); }
}

const READ_PER_SECOND = 20, TEXT_KB_PER_THREAD = 6, MESSAGES_PER_THREAD = 2.5;
async function estimate(ctx, source = null) {
  const account = accountFor(ctx, source?.config?.account);
  const client = await connectFor(ctx, account);
  try {
    const cfg = validate(source?.config || {});
    let messages = 0;
    for (const f of await resolveFolders(client, cfg.folders)) messages += (await client.select(f.name, { readOnly: true })).exists;
    const threads = Math.round(messages / MESSAGES_PER_THREAD);
    return { email: account.user, threads, messages, megabytes: Math.round((threads * TEXT_KB_PER_THREAD * 2) / 1024), hours: Math.round((threads / READ_PER_SECOND / 3600) * 10) / 10 };
  } finally { await client.logout(); }
}

async function sync({ source, items, budget = MAX_MESSAGES, ...ctx }) {
  const cfg = validate(source.config);
  const account = accountFor(ctx, cfg.account);
  if (!account || !ready(ctx, source.config)) throw Object.assign(new Error('Add the mail account (server, user, password) first.'), { permanent: true, code: 'imap-auth' });
  const level = source.readLevel || 'part';
  if (level === 'none') return { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0, skipped: 'nothing may be read' };
  const metadataOnly = level === 'metadata';
  const filter = M.effectiveFilter(source, items);
  const { never, ...local } = filter;
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const me = addressesOf(ctx, account, cfg);
  const client = await connectFor(ctx, account);
  try {
    const folders = await resolveFolders(client, cfg.folders);
    const sig = M.digest(JSON.stringify([cfg, metadataOnly, source.filter || {}, folders.map((f) => f.name)]));
    let c = readCursor(source.cursor);
    if (c.k !== sig || !c.f) c = { k: sig, f: {}, resync: true, seen: [] };
    const seen = new Set(c.seen || []);
    const since = imapDate(Date.now() - cfg.days * 86_400_000);
    const RESTART = Symbol('restart');
    const persist = () => { c.seen = c.resync ? [...seen].slice(0, MAX_SEEN) : []; items.updateSource(source.id, { cursor: writeCursor(c) }); };

    // A thread the server refused (or whose mail our parser could not read) is remembered in c.retry and tried again on the next
    // runs, then given up; it never stops the folder's state from moving on. Each failure counts in out.errors.
    const retryLater = (key) => {
      out.errors++;
      seen.add(M.digest(`thread:${key}`));    // unread is not gone: a resync must not tombstone it
      const tries = ((c.retry ||= {})[key] || 0) + 1;
      delete c.retry[key];
      if (tries < RETRY_TRIES) c.retry[key] = tries;
      const keys = Object.keys(c.retry);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RETRY))) delete c.retry[k];
    };

    const run = async () => {
      let remaining = budget;
      const done = new Set();                 // threads stored (or found gone) in this run: never read twice
      const pending = new Set(Object.keys(c.retry || {}));
      // ---- 2. read threads whole, from every folder; 3. store them
      const storeThreads = async (keys) => {
        keys = keys.filter((k) => !done.has(k));
        if (!keys.length) return;
        const { got, failed } = await gatherThreads(client, folders, keys, { metadataOnly });
        for (const key of keys) {
          if (failed.has(key)) { done.add(key); retryLater(key); continue; }
          const members = got.get(key) || [];
          const externalId = `thread:${key}`;
          let item = null, keep = false;
          if (members.length) {
            try {
              const msgs = members.map((m) => m.msg);
              keep = !M.neverRead(msgs, never) && M.passesFilter(msgs, local);
              if (keep) item = itemFor(key, members, me, metadataOnly);
            } catch { done.add(key); retryLater(key); continue; }
          }
          done.add(key); if (c.retry) delete c.retry[key];
          if (!item) { if (items.tombstone(source.id, externalId)) out.removed++; continue; }
          const r = items.upsert(source.id, item);
          out[r.action === 'revived' ? 'updated' : r.action]++;
          seen.add(M.digest(externalId));
        }
      };
      // ---- 1. which threads changed? per folder: new mail, older mail (newest first), mail that went away. Each folder's threads
      // are stored, and its new state saved, before the next folder: a later failure keeps that progress.
      const readFolder = async (f) => {
        const touched = new Set(pending); pending.clear();
        const st = { ...(c.f[f.name] || {}) };
        const info = await client.select(f.name, { readOnly: true });
        if (st.uv != null && st.uv !== info.uidValidity) {
          // every UID we knew is meaningless now: start again from scratch; what is no longer there is tombstoned at the end
          c = { k: sig, f: {}, resync: true, seen: [], retry: c.retry || {} }; seen.clear();
          throw RESTART;
        }
        st.uv = info.uidValidity;
        const fresh = st.hi == null;
        if (fresh) {
          if (!info.uidNext) info.uidNext = ((await client.search(['ALL'])).pop() || 0) + 1;     // a server that does not say its next uid: the highest one plus one
          Object.assign(st, { hi: info.uidNext - 1, lo: info.uidNext });
        }
        const keysOf = async (uids) => {
          // a message whose headers the server will not give is skipped (there is no thread to retry without them)
          for (const m of await fetchIsolated(client, uids, FETCH_HEAD, () => { out.errors++; }, 100)) {
            if (m.flags.some((x) => x.toLowerCase() === '\\deleted')) continue;
            try { touched.add(toMessage(m, { metadataOnly: true, folder: f }).key); } catch { out.errors++; }
          }
        };
        // new mail first, oldest first, within the budget (at least ARRIVALS_FLOOR per folder); the rest waits for the next run
        const allNew = fresh ? [] : (await client.search(['UID', `${st.hi + 1}:*`])).filter((u) => u > st.hi);
        const arrivals = allNew.slice(0, Math.max(remaining, Math.min(ARRIVALS_FLOOR, budget)));
        if (arrivals.length) { await keysOf(arrivals); st.hi = arrivals[arrivals.length - 1]; remaining -= arrivals.length; }   // search answers are sorted
        // mail that went away or changed
        if (!fresh) {
          let checkGone = info.exists !== (st.n ?? info.exists) + allNew.length;
          const changed = [];
          if (info.highestModSeq != null && st.ms != null) {
            if (info.highestModSeq > st.ms) {
              for (const m of await client.fetch('1:*', 'UID FLAGS', { changedSince: st.ms })) {
                if (m.flags.some((x) => x.toLowerCase() === '\\deleted')) checkGone = true; else if (keywordsOf(m.flags).length) changed.push(m.uid);   // \Seen and the like do not change a thread
              }
            }
          } else if ((await client.search(['DELETED'])).length) checkGone = true;     // no MODSEQ: a message flagged for deletion shows only here
          if (checkGone || changed.length) {
            const live = checkGone ? new Set(await client.search(['NOT', 'DELETED'])) : null;
            for (const key of threadsWith(items, source.id, f.name, info.uidValidity, (u) => (live && !live.has(u)) || changed.includes(u))) touched.add(key);
          }
        }
        // older mail, newest first, as much as the budget allows
        if (st.lo > 1 && remaining > 0) {
          const older = (await client.search(['UID', `1:${st.lo - 1}`, 'SINCE', since])).filter((u) => u < st.lo);
          const take = older.slice(-remaining);
          if (take.length) { await keysOf(take); remaining -= take.length; }
          st.lo = take.length === older.length ? 0 : take[0];
        } else if (st.lo > 1 && remaining <= 0) { /* later */ } else st.lo = 0;
        // new mail left for the next run: the count compared next time must not include it
        st.n = info.exists - (allNew.length - arrivals.length); st.ms = info.highestModSeq;
        await storeThreads([...touched]);
        // the stored thread refs changed with it; the new state of the folder is only kept now that its threads are stored
        c.f[f.name] = st;
        persist();
      };
      for (const f of folders) {
        try { await readFolder(f); } catch (e) {
          if (e === RESTART || !refused(e)) throw e;
          out.errors++;                       // the server refused something about this whole folder: its state stays, the others go on
        }
      }
    };
    try {
      try { await run(); } catch (e) {
        if (e !== RESTART) throw e;
        try { await run(); } catch (e2) { throw e2 === RESTART ? new Error('The mail server keeps changing its folder numbers (UIDVALIDITY); trying again later.') : e2; }
      }
      if (c.resync && folders.every((f) => c.f[f.name] && !c.f[f.name].lo)) {
        if (seen.size < MAX_SEEN) {
          for (const it of items.list({ sourceId: source.id, limit: 1_000_000 })) if (!seen.has(M.digest(it.externalId)) && items.tombstone(source.id, it.externalId)) out.removed++;
        }
        c.resync = false; seen.clear();
      }
    } finally { persist(); }
  } finally { await client.logout(); }
  return out;
}

// ---------- live search and opening ----------
const isGmail = (client, account) => client.caps.has('X-GM-EXT-1') || /(^|\.)(gmail|googlemail)\.com$/i.test(account.host || '');

// A search sent to the server now. Not for the metadata level. -> [{ externalId, title, snippet, uri, at, from }] (newest first), the
// grant's filter and the never-read list applied after download. Gmail's own search syntax (X-GM-RAW) is used when the server is Gmail.
async function searchLive({ ctx = {}, source, query, limit = 10 } = {}) {
  const text = String(query || '').trim();
  if (!text || !source) return [];
  if (source.readLevel === 'metadata' || !can(source, 'search.live')) return [];
  const cfg = validate(source.config);
  const account = accountFor(ctx, cfg.account);
  if (!account) return [];
  const { never, ...local } = M.effectiveFilter(source, ctx.items || null);
  const wanted = Math.max(1, Math.min(50, Math.round(Number(limit) || 10)));
  const client = await connectFor(ctx, account);
  try {
    const found = [];
    for (const f of await resolveFolders(client, cfg.folders)) {
      await client.select(f.name, { readOnly: true });
      const criteria = isGmail(client, account) ? ['NOT', 'DELETED', 'X-GM-RAW', qs(text)] : ['NOT', 'DELETED', 'OR', 'OR', 'TEXT', qs(text), 'FROM', qs(text), 'SUBJECT', qs(text)];
      const uids = (await client.search(criteria)).slice(-wanted * 3);
      for (const m of await fetchChunks(client, uids, `UID FLAGS INTERNALDATE BODY.PEEK[]<0.4096>`)) {
        if (m.flags.some((x) => x.toLowerCase() === '\\deleted')) continue;
        found.push(toMessage(m, { metadataOnly: false, folder: f }));
      }
    }
    const best = new Map();
    for (const r of found.sort((a, b) => b.msg.at - a.msg.at)) {
      if (r.msg.draft || M.neverRead([r.msg], never) || !M.passesFilter([r.msg], local)) continue;
      if (!best.has(r.key)) best.set(r.key, r);
    }
    return [...best.values()].slice(0, wanted).map((r) => ({ externalId: `thread:${r.key}`, title: r.msg.subject || '(no subject)', snippet: r.msg.text.replace(/\s+/g, ' ').trim().slice(0, 240), uri: '', at: r.msg.at, from: M.addressString(r.msg.from) }));
  } finally { await client.logout(); }
}

// One thread read now, as an item payload for items.upsert; null when the grant or the never-read list says it must not be kept.
async function openLive({ ctx = {}, source, externalId } = {}) {
  if (!source || source.readLevel === 'none') return null;
  const key = String(externalId || '').replace(/^thread:/, '');
  if (!M.parseKey(key)) return null;
  const cfg = validate(source.config);
  const account = accountFor(ctx, cfg.account);
  if (!account) return null;
  const metadataOnly = source.readLevel === 'metadata';
  const { never, ...local } = M.effectiveFilter(source, ctx.items || null);
  const client = await connectFor(ctx, account);
  try {
    const folders = await resolveFolders(client, cfg.folders);
    const { got, failed } = await gatherThreads(client, folders, [key], { metadataOnly });
    if (failed.has(key)) throw Object.assign(new Error('The mail server refused to read this thread.'), { code: 'imap' });
    const members = got.get(key) || [];
    if (!members.length) return null;
    const msgs = members.map((m) => m.msg);
    if (M.neverRead(msgs, never) || !M.passesFilter(msgs, local)) return null;
    return itemFor(key, members, addressesOf(ctx, account, cfg), metadataOnly);
  } finally { await client.logout(); }
}

module.exports = {
  kind: 'imap', every, validate, ready, check, estimate, sync, searchLive, openLive, compileFilter,
  accountFor, connectFor, accessTokenOf, resolveFolders, toMessage, readCursor, writeCursor, neverRead: M.neverRead, HEADER_FIELDS,
};
