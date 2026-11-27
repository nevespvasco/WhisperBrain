'use strict';
// Outlook / Microsoft 365 / outlook.com mail through Microsoft Graph, as items: one per conversation (conversationId), the same shape
// as the Gmail connector's so everything downstream treats them alike. What is read follows the source's access grant
// (src/access/grants.js): 'metadata' asks Microsoft for Mail.ReadBasic and selects only from, to, cc, subject, received date,
// conversation, categories and folder (never body, bodyPreview or headers); 'part' / 'all' ask for Mail.Read and read the body as text.
// The "never read" list is ALWAYS applied here, after download, whatever Graph could filter.
//
// Sync: Graph delta queries, one per folder (Inbox, Sent Items, Archive), each folder's deltaLink kept in the source cursor (JSON).
// A delta only says WHICH messages changed, so the conversations they belong to are read whole (a conversation spans folders: the
// question and the sent reply). A run reads at most `budget` conversations; when there is more, the cursor remembers the page it
// stopped at and the next run goes on from there, so nothing is skipped. Messages that disappear (@removed) or that are in Deleted
// Items / Junk make their conversation shrink, or be tombstoned when nothing is left. Microsoft's delta state can expire (410): the
// folder is read again from the start and what is no longer there is tombstoned.
//
// UNVERIFIED against a real Microsoft account: written from Microsoft's documentation and tested against a simulated Graph
// (test/outlook.test.js). Read docs/access-mail.md before trusting it.
const crypto = require('node:crypto');
const { request } = require('./http');
const { PkceClient } = require('../transcripts/oauth');
const { builtInClient } = require('../core/oauth-clients');
const { can } = require('../access/grants');
const M = require('./mail-common');
const { htmlToText } = require('../importers/mime');

const every = 10 * 60_000;
const MAX_THREADS = 400;                 // conversations read per run (the rest waits for the next run, from the saved cursor)
const MAX_SEEN = 20_000;                 // a restart remembers what it saw to tombstone the rest; beyond this it keeps everything (safe side)
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const PAGE = 50;
const SYNCED = ['inbox', 'sentitems', 'archive'];            // well-known folders read by default
const GONE = ['deleteditems', 'junkemail'];                  // a conversation only found there is gone
const FOLDER_NAMES = { inbox: 'Inbox', sentitems: 'Sent Items', archive: 'Archive', deleteditems: 'Deleted Items', junkemail: 'Junk Email' };

// ---------- permissions ----------
// Microsoft asks for permissions by name. A grant maps to exactly these, nothing more (docs/access-mail.md):
//   metadata -> Mail.ReadBasic (Microsoft then withholds body, bodyPreview and attachments itself)
//   part / all -> Mail.Read;   actions: draft, label, archive, mark read -> Mail.ReadWrite;  send -> Mail.Send (asked only when an action needs it)
const BASE_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'User.Read'];
const ACTION_SCOPE = { 'outlook.draft': 'Mail.ReadWrite', 'outlook.label': 'Mail.ReadWrite', 'outlook.archive': 'Mail.ReadWrite', 'outlook.markRead': 'Mail.ReadWrite', 'outlook.send': 'Mail.Send' };
const MAIL_SCOPES = new Set(['Mail.ReadBasic', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send']);

// level: none | metadata | part | all; actions: ['outlook.draft', ...] -> the Graph permissions to ask for (without the sign-in basics)
function outlookScopesFor({ level = 'part', actions = [] } = {}) {
  if (level === 'none' && !actions.length) return [];
  const extra = new Set(actions.map((a) => ACTION_SCOPE[a]).filter(Boolean));
  const out = new Set();
  if (extra.has('Mail.ReadWrite')) out.add('Mail.ReadWrite');                 // writing covers reading what is acted on (and metadata + actions cannot be)
  else out.add(level === 'metadata' ? 'Mail.ReadBasic' : 'Mail.Read');
  if (extra.has('Mail.Send')) out.add('Mail.Send');
  return [...out];
}
const scopeString = (opts) => [...BASE_SCOPES, ...outlookScopesFor(opts)].join(' ');

// what the token response said was granted, as short names ("https://graph.microsoft.com/Mail.Read" and "Mail.Read" are the same thing)
const shortScopes = (s) => String(Array.isArray(s) ? s.join(' ') : s || '').split(/\s+/).map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, '')).filter(Boolean);
const mailScopes = (s) => shortScopes(s).filter((x) => MAIL_SCOPES.has(x));
const covers = (granted, need) => { const g = shortScopes(granted); return g.includes(need) || (need === 'Mail.Read' && g.includes('Mail.ReadWrite')) || (need === 'Mail.ReadBasic' && (g.includes('Mail.Read') || g.includes('Mail.ReadWrite'))); };
// can bodies be read / searched? Not under Mail.ReadBasic alone. An unknown list (nothing recorded) is treated as the least: metadata.
const canReadBodies = (granted) => covers(granted, 'Mail.Read');
const hasMail = (granted) => mailScopes(granted).some((s) => s !== 'Mail.Send');

// ---------- sign-in and tokens ----------
const authError = (message) => Object.assign(new Error(message), { code: 'outlook-auth', permanent: true });
// the address in the sign-in's id_token (it came straight from the token endpoint over TLS, so it is trusted without a signature check)
function idTokenEmail(idToken) {
  try { const j = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); return String(j.email || j.preferred_username || '').toLowerCase(); } catch { return ''; }
}

// The Microsoft sign-in: authorization code + PKCE on a loopback address (the person's own app registration, as for Teams transcripts;
// a public client needs no secret). Tokens are kept through saveConfig({ ... }) into settings.outlook (sealed like other secrets).
// getConfig/saveConfig/fetchImpl/bases are injected so a test can point it at a fake server.
class OutlookAuth extends PkceClient {
  constructor({ getConfig, saveConfig, fetchImpl = globalThis.fetch, bases = {}, now = Date.now, authTimeoutMs, builtIn = builtInClient('microsoft') } = {}) {
    super({ name: 'Microsoft', authUrl: '', tokenUrl: '', scope: '', extraAuthParams: { prompt: 'select_account' }, getConfig, saveConfig, fetchImpl, now, authTimeoutMs });
    this.bases = { login: bases.login || LOGIN, graph: bases.graph || GRAPH };
    this.builtIn = builtIn;
    // the tenant can change in Settings: the endpoints follow it
    Object.defineProperty(this, 'authUrl', { configurable: true, enumerable: true, get: () => `${this.bases.login}/${this.config().tenant}/oauth2/v2.0/authorize` });
    Object.defineProperty(this, 'tokenUrl', { configurable: true, enumerable: true, get: () => `${this.bases.login}/${this.config().tenant}/oauth2/v2.0/token` });
  }

  config() {
    const c = { clientId: '', tenant: 'common', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, email: '', scopes: [], needsReconnect: false, ...(this.getConfig() || {}) };
    if (!c.clientId && this.builtIn?.clientId) { c.clientId = this.builtIn.clientId; c.clientSecret = this.builtIn.clientSecret || ''; }
    if (!c.tenant) c.tenant = 'common';
    return c;
  }

  grantedScopes() { return mailScopes(this.config().scopes); }
  get graphBase() { return this.bases.graph; }

  // level / actions: what the grant needs (the permissions are asked for fresh each time: Microsoft cannot take one back alone)
  async beginAuth({ openExternal, level = 'part', actions = [] } = {}) {
    this.scope = scopeString({ level, actions });
    return super.beginAuth({ openExternal });
  }

  saveTokens(j) {
    const patch = { accessToken: j.access_token || '', expiresAt: this.now() + (Number(j.expires_in) || 3600) * 1000, needsReconnect: false };
    if (j.refresh_token) patch.refreshToken = j.refresh_token;
    if (j.scope) patch.scopes = mailScopes(j.scope);                          // what Microsoft REALLY granted (the person may untick boxes)
    const email = idTokenEmail(j.id_token);
    if (email) patch.email = email;
    this.saveConfig(patch);
    return patch;
  }

  // A valid access token, refreshed when missing or about to expire. A refresh token Microsoft refuses (invalid_grant) means the person
  // must sign in again: the flag is kept (with the address and the permissions), and what was read stays.
  async accessToken({ force = false } = {}) {
    const c = this.config();
    if (!force && c.accessToken && c.expiresAt - this.now() > 60000) return c.accessToken;
    if (!c.refreshToken) throw authError(c.needsReconnect ? 'Microsoft access expired or was revoked: reconnect it (Access).' : 'Microsoft is not connected.');
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const r = await this.postForm({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' });
        if (!r.ok || !r.json.access_token) {
          if (r.json.error === 'invalid_grant' || r.json.error === 'interaction_required') {
            this.saveConfig({ refreshToken: '', accessToken: '', expiresAt: 0, needsReconnect: true });
            throw authError('Microsoft access expired or was revoked: reconnect it (Access).');
          }
          throw new Error(`Microsoft token refresh failed: ${r.json.error_description || r.json.error || `HTTP ${r.status}`}`);
        }
        return this.saveTokens(r.json).accessToken;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async disconnect() { this.saveConfig({ refreshToken: '', accessToken: '', expiresAt: 0, email: '', scopes: [], needsReconnect: false }); }
}

// the auth a sync uses: the one the app injected (ctx.outlook), else one made from the settings (kept per settings object)
const made = new WeakMap();
function authFor(ctx) {
  if (ctx.outlook) return ctx.outlook;
  if (!ctx.settings) return null;
  if (!made.has(ctx.settings)) {
    made.set(ctx.settings, new OutlookAuth({ getConfig: () => ctx.settings.get('outlook'), saveConfig: (patch) => ctx.settings.update({ outlook: patch }), fetchImpl: ctx.fetchImpl, bases: ctx.bases?.outlook || ctx.bases || {} }));
  }
  return made.get(ctx.settings);
}

// ---------- Graph requests ----------
// a link inside a response is followed only on the same host: the token must not be sent anywhere else
function sameHost(auth, link) {
  if (new URL(link).origin !== new URL(auth.graphBase).origin) throw new Error('Microsoft Graph sent a link to another host; not followed.');
  return link;
}
const q = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const PREFER = (n) => `outlook.body-content-type="text", odata.maxpagesize=${n}`;

// GET one Graph URL (a path, or a nextLink/deltaLink Graph gave) with the token, a refresh-and-retry on 401, and the rate limit rules.
async function graph(ctx, auth, pathOrUrl, params = {}) {
  const base = auth.graphBase;
  let url;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    url = sameHost(auth, pathOrUrl);
  } else { const qs = q(params); url = `${base}${pathOrUrl}${qs ? `?${qs}` : ''}`; }
  for (let attempt = 0; ; attempt++) {
    const token = await auth.accessToken({ force: attempt > 0 });
    try {
      return (await request(url, { service: 'Microsoft Graph', headers: { Authorization: `Bearer ${token}`, Prefer: PREFER(PAGE) }, fetchImpl: auth.fetch, sleep: ctx.sleep })).json || {};
    } catch (e) {
      if (e.status === 401 && attempt === 0) continue;
      throw e;
    }
  }
}

// ---------- config and filters ----------
function validate(config = {}) {
  const days = Math.max(1, Math.min(3650, Math.round(Number(config.days) || 90)));
  const folders = M.list(config.folders, 5).map((f) => f.toLowerCase().replace(/\s+/g, '')).filter((f) => SYNCED.includes(f));
  return { days, folders: folders.length ? [...new Set(folders)] : SYNCED.slice() };
}
const ready = (ctx, config = {}) => { const a = authFor(ctx); return !!a && a.connected() && hasMail(a.grantedScopes()); };

// What Graph can do with the grant's filter, and what is left for here. Delta accepts $filter on the received date only and $search
// cannot be combined with $filter or $orderby, so the labels (categories), senders and domains are applied locally after download.
//   -> { odata: the $filter for a delta, since: ISO date, local: the filter to check here, never: the never-read list (always local) }
function compileFilter(config = {}, filter = {}, { now = Date.now() } = {}) {
  const { days } = validate(config);
  const since = new Date(now - days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const { never = {}, ...local } = filter || {};
  return { odata: `receivedDateTime ge ${since}`, since, local, never };
}

// ---------- messages ----------
const SELECT_BASIC = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isDraft,categories,parentFolderId,flag';
const SELECT_FULL = `${SELECT_BASIC},body,internetMessageHeaders,internetMessageId,hasAttachments,webLink`;

// { emailAddress: { name, address } } -> { name, address }; Exchange's internal addresses (no @) are not mail addresses and are left out
function parseAddress(r) {
  const a = r?.emailAddress;
  if (!a?.address || !String(a.address).includes('@')) return null;
  const address = String(a.address).toLowerCase();
  return { name: a.name && String(a.name).toLowerCase() !== address ? String(a.name) : '', address };
}
const hostFor = (email) => (/@(outlook|hotmail|live|msn)\./i.test(email || '') ? 'https://outlook.live.com/mail/0' : 'https://outlook.office.com/mail');

// A Graph message -> the normalised message (src/connectors/mail-common.js). folderName(id) -> the folder's name.
function normalizeMessage(g, { metadataOnly = false, folderName = () => '' } = {}) {
  const who = parseAddress;
  const folder = folderName(g.parentFolderId);
  const body = metadataOnly || !g.body ? '' : (String(g.body.contentType).toLowerCase() === 'html' ? htmlToText(g.body.content || '') : String(g.body.content || ''));
  return {
    id: g.id, conversationId: g.conversationId, from: who(g.from), to: (g.toRecipients || []).map(who).filter(Boolean).map((a) => a.address), cc: (g.ccRecipients || []).map(who).filter(Boolean).map((a) => a.address),
    subject: g.subject || '', at: Date.parse(g.receivedDateTime) || 0, text: M.cutQuote(body),
    labels: [...(g.categories || []), ...(folder ? [folder] : [])],
    // the List-Unsubscribe header is a message header: it is only asked for (and only seen) when bodies may be read
    unsubscribe: metadataOnly || !g.internetMessageHeaders ? null : g.internetMessageHeaders.some((h) => String(h.name).toLowerCase() === 'list-unsubscribe'),
    attachments: metadataOnly ? [] : (g.attachments || []).map((a) => ({ name: a.name || 'attachment', size: Number(a.size) || 0, type: a.contentType || '' })),
    messageId: g.internetMessageId || '',
    references: String((g.internetMessageHeaders || []).find((h) => String(h.name).toLowerCase() === 'references')?.value || '').split(/\s+/).filter(Boolean),
    draft: !!g.isDraft, parentFolderId: g.parentFolderId, webLink: g.webLink || '',
  };
}

// me: the account's addresses (the address and its aliases); the conversation's messages as Graph returned them.
function threadItem(conversation, me, { metadataOnly = false, folderName = () => '', account = '', goneFolders = new Set() } = {}) {
  const msgs = (conversation.messages || []).filter((m) => !goneFolders.has(m.parentFolderId)).map((m) => normalizeMessage(m, { metadataOnly, folderName }));
  if (!msgs.length) return null;
  const last = [...msgs].sort((a, b) => a.at - b.at).filter((m) => !m.draft).pop();
  if (!last) return null;
  const uri = last.webLink || `${hostFor(account)}/inbox/id/${encodeURIComponent(last.id)}`;
  return M.buildThreadItem({ externalId: `thread:${conversation.id}`, uri, msgs, me, metadataOnly, extraMeta: { conversationId: conversation.id, msgHashes: msgs.map((m) => M.digest(m.id).slice(0, 10)).slice(0, 100) } });
}

// the never-read list against Graph messages as downloaded (the same check as Gmail's neverRead, for tests and callers that hold raw messages)
const neverRead = (graphMessages, never = {}, folderName = () => '') => M.neverRead(graphMessages.map((g) => normalizeMessage(g, { metadataOnly: true, folderName })), never);

// ---------- the cursor ----------
// { k: signature of what is read (days, folders, level, filter), f: { folder: { d: deltaLink | n: nextLink to continue } }, resync, seen: [digests] }
function readCursor(s) {
  if (!s) return {};
  try { const c = JSON.parse(s); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch { return {}; }
}
const writeCursor = (c) => JSON.stringify(c);

const need = (ctx) => { const a = authFor(ctx); if (!a || !a.connected()) throw Object.assign(new Error('Connect Microsoft first.'), { permanent: true, code: 'outlook-auth' }); return a; };
async function check(ctx, source = null) {
  const auth = need(ctx);
  const me = await graph(ctx, auth, '/me', { $select: 'mail,userPrincipalName' });
  return { ok: true, email: String(me.mail || me.userPrincipalName || auth.config().email || '').toLowerCase() };
}

// An estimate of how much "everything" is, from the folders' own counts, said as an estimate.
const READ_PER_SECOND = 3, TEXT_KB_PER_THREAD = 6, MESSAGES_PER_THREAD = 2.5;
async function estimate(ctx, source = null) {
  const auth = need(ctx);
  const cfg = validate(source?.config || {});
  let messages = 0;
  for (const f of cfg.folders) { try { messages += Number((await graph(ctx, auth, `/me/mailFolders/${f}`, { $select: 'totalItemCount' })).totalItemCount) || 0; } catch (e) { if (e.status !== 404) throw e; } }
  const threads = Math.round(messages / MESSAGES_PER_THREAD);
  return { email: auth.config().email, threads, messages, megabytes: Math.round((threads * TEXT_KB_PER_THREAD * 2) / 1024), hours: Math.round((threads / READ_PER_SECOND / 3600) * 10) / 10 };
}

// the account's own addresses: the sign-in address and what Graph lists on /me (aliases), so a reply sent from an alias is "from me"
async function myAddresses(ctx, auth) {
  const out = new Set([auth.config().email].filter(Boolean).map((e) => e.toLowerCase()));
  let me;
  try { me = await graph(ctx, auth, '/me', { $select: 'mail,userPrincipalName,otherMails,proxyAddresses' }); } catch (e) { if (e.code === 'rate-limited') throw e; try { me = await graph(ctx, auth, '/me'); } catch { me = {}; } }
  for (const a of [me.mail, me.userPrincipalName, ...(me.otherMails || []), ...(me.proxyAddresses || []).map((p) => String(p).replace(/^smtp:/i, ''))]) if (a && String(a).includes('@')) out.add(String(a).toLowerCase());
  return out;
}

// the well-known folders: their ids (to tell where a message is) and names (the label)
async function resolveFolders(ctx, auth, names) {
  const byId = new Map(), byName = new Map();
  for (const name of [...new Set([...names, ...GONE])]) {
    try {
      const f = await graph(ctx, auth, `/me/mailFolders/${name}`, { $select: 'id,displayName' });
      if (f.id) { byId.set(f.id, f.displayName || FOLDER_NAMES[name]); byName.set(name, f.id); }
    } catch (e) { if (e.status !== 404) throw e; }              // a mailbox without an Archive folder: nothing to read there
  }
  return { byId, byName, gone: new Set(GONE.map((n) => byName.get(n)).filter(Boolean)) };
}

// a message id as Graph gives it in @removed -> the conversation it was in, from what was stored (ids are long: only a short digest is kept)
function conversationsOf(items, sourceId, messageIds) {
  const want = new Set(messageIds.map((id) => M.digest(id).slice(0, 10)));
  const out = new Set();
  for (const it of items.list({ sourceId, limit: 1_000_000 })) if ((it.meta?.msgHashes || []).some((h) => want.has(h))) out.add(it.externalId.replace(/^thread:/, ''));
  return out;
}

async function fetchConversation(ctx, auth, id, metadataOnly) {
  const msgs = [];
  let url = '/me/messages', params = { $filter: `conversationId eq '${String(id).replace(/'/g, "''")}'`, $select: metadataOnly ? SELECT_BASIC : SELECT_FULL, ...(metadataOnly ? {} : { $expand: 'attachments($select=name,size,contentType)' }), $top: PAGE };
  for (let i = 0; i < 4 && url; i++) {
    const j = await graph(ctx, auth, url, params);
    msgs.push(...(j.value || []));
    url = j['@odata.nextLink'] || null; params = {};
  }
  return msgs;
}

// a lookup of folder names, filling the ones it does not know from Graph (a custom folder)
function folderNamer(ctx, auth, known) {
  const names = new Map(known);
  return { name: (id) => names.get(id) || '', async learn(msgs) {
    for (const id of new Set(msgs.map((m) => m.parentFolderId).filter((x) => x && !names.has(x)))) {
      try { names.set(id, (await graph(ctx, auth, `/me/mailFolders/${encodeURIComponent(id)}`, { $select: 'displayName' })).displayName || ''); } catch (e) { if (e.code === 'rate-limited') throw e; names.set(id, ''); }
    }
  } };
}

const initialDelta = (folder) => `/me/mailFolders/${folder}/messages/delta`;
const initialParams = (odata) => ({ $select: 'id,conversationId,parentFolderId,isDraft', $filter: odata });

async function sync({ source, items, budget = MAX_THREADS, ...ctx }) {
  const auth = authFor(ctx);
  if (auth?.connected()) await auth.accessToken();             // a refresh also brings up to date what was granted (and says when the sign-in is no longer valid)
  if (!auth || !auth.connected() || !hasMail(auth.grantedScopes())) {
    throw Object.assign(new Error(auth?.config().needsReconnect ? 'Microsoft access expired or was revoked: reconnect it (Access).' : 'Connect Microsoft with mail switched on first.'), { permanent: true, code: 'outlook-auth' });
  }
  const level = source.readLevel || 'part';
  if (level === 'none') return { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0, skipped: 'nothing may be read' };
  // what Microsoft really granted limits what can be read, whatever the grant says: under Mail.ReadBasic there are no bodies
  const metadataOnly = level === 'metadata' || !canReadBodies(auth.grantedScopes());
  const cfg = validate(source.config);
  const filter = M.effectiveFilter(source, items);
  const compiled = compileFilter(source.config, filter);
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const account = auth.config().email;
  const me = await myAddresses(ctx, auth);
  const { byId, byName, gone } = await resolveFolders(ctx, auth, cfg.folders);
  const names = folderNamer(ctx, auth, byId);

  // what is read changed (days, folders, level, the grant's filter): read it all again under the new rules
  const sig = M.digest(JSON.stringify([cfg, metadataOnly, source.filter || {}]));
  let c = readCursor(source.cursor);
  if (c.k !== sig || !c.f) c = { k: sig, f: {}, resync: true, seen: [] };
  const seen = new Set(c.seen || []);
  const persist = () => { c.seen = c.resync ? [...seen].slice(0, MAX_SEEN) : []; items.updateSource(source.id, { cursor: writeCursor(c) }); };
  let remaining = budget;

  const apply = async (convId) => {
    const raw = await fetchConversation(ctx, auth, convId, metadataOnly);
    await names.learn(raw);
    const live = raw.filter((m) => !gone.has(m.parentFolderId) && !m.isDraft);
    const externalId = `thread:${convId}`;
    if (!live.length) { if (items.tombstone(source.id, externalId)) out.removed++; return; }
    const msgs = live.map((m) => normalizeMessage(m, { metadataOnly, folderName: names.name }));
    // never read: checked here every time, whatever Graph could filter; the rest of the grant's filter likewise
    if (M.neverRead(msgs, compiled.never) || !M.passesFilter(msgs, compiled.local)) { if (items.tombstone(source.id, externalId)) out.removed++; return; }
    const item = threadItem({ id: convId, messages: raw }, me, { metadataOnly, folderName: names.name, account, goneFolders: gone });
    if (!item) { if (items.tombstone(source.id, externalId)) out.removed++; return; }
    const r = items.upsert(source.id, item);
    out[r.action === 'revived' ? 'updated' : r.action]++;
    seen.add(M.digest(externalId));
  };

  const RESTART = Symbol('restart');
  const readFolders = async () => {
    for (const folder of cfg.folders) {
      if (!byName.has(folder)) continue;
      if (remaining <= 0) break;
      let st = c.f[folder] || {};
      let url = st.n || st.d || initialDelta(folder), params = st.n || st.d ? {} : initialParams(compiled.odata);
      while (url && remaining > 0) {
        let j;
        try { j = await graph(ctx, auth, url, params); } catch (e) {
          // the delta state expired: every folder is read again from the start (a conversation spans folders), and what is not seen is tombstoned
          if (e.status === 410 || /syncStateNotFound|resyncRequired/i.test(e.message)) { c = { k: sig, f: {}, resync: true, seen: [] }; seen.clear(); throw RESTART; }
          throw e;
        }
        params = {};
        const touched = new Set(), removed = [];
        for (const m of j.value || []) { if (m['@removed']) removed.push(m.id); else if (m.conversationId) touched.add(m.conversationId); }
        if (removed.length) for (const conv of conversationsOf(items, source.id, removed)) touched.add(conv);
        for (const conv of touched) await apply(conv);
        remaining -= touched.size;
        const next = j['@odata.nextLink'], delta = j['@odata.deltaLink'];
        for (const l of [next, delta]) if (l) sameHost(auth, l);       // a link saved in the cursor is followed next run: check it now
        if (next) { st = { n: next }; url = next; } else if (delta) { st = { d: delta }; url = null; } else { st = {}; url = null; }
        c.f[folder] = st;
        persist();
      }
    }
  };
  try {
    try { await readFolders(); } catch (e) {
      if (e !== RESTART) throw e;
      try { await readFolders(); } catch (e2) { throw e2 === RESTART ? new Error('Microsoft keeps expiring the sync state; trying again later.') : e2; }
    }
    // every folder read up to its deltaLink after a restart: what was not seen in it is gone
    if (c.resync && cfg.folders.filter((f) => byName.has(f)).every((f) => c.f[f]?.d && !c.f[f]?.n)) {
      if (seen.size < MAX_SEEN) {
        for (const it of items.list({ sourceId: source.id, limit: 1_000_000 })) if (!seen.has(M.digest(it.externalId)) && items.tombstone(source.id, it.externalId)) out.removed++;
      }
      c.resync = false; seen.clear();
    }
  } finally {
    persist();                                                  // whatever page was finished stays finished, also when the run stops on an error
  }
  return out;
}

// ---------- live search and opening ----------
const quoteSearch = (text) => `"${String(text).replace(/["\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250)}"`;

// A search sent to Microsoft now ($search: Graph cannot combine it with $filter or $orderby, and returns at most 250 hits), for the
// Ask / live search path. Not for the metadata level (no body, no snippet: nothing to search in, so nothing is sent).
// -> [{ externalId, title, snippet, uri, at, from }], the grant's filter and the never-read list applied after download.
async function searchLive({ ctx = {}, source, query, limit = 10 } = {}) {
  const text = String(query || '').trim();
  if (!text || !source) return [];
  const auth = authFor(ctx);
  if (!auth || !auth.connected()) return [];
  if (source.readLevel === 'metadata' || !canReadBodies(auth.grantedScopes()) || !can(source, 'search.live')) return [];
  const filter = M.effectiveFilter(source, ctx.items || null);
  const wanted = Math.max(1, Math.min(50, Math.round(Number(limit) || 10)));
  const known = await resolveFolders(ctx, auth, validate(source.config).folders);
  const names = folderNamer(ctx, auth, known.byId);
  const j = await graph(ctx, auth, '/me/messages', { $search: quoteSearch(text), $top: Math.min(250, wanted * 4), $select: 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isDraft,categories,parentFolderId,bodyPreview,webLink' });
  await names.learn(j.value || []);
  const out = [], done = new Set();
  const { never, ...local } = filter;
  for (const g of (j.value || []).sort((a, b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime))) {
    if (g.isDraft || known.gone.has(g.parentFolderId) || !g.conversationId || done.has(g.conversationId)) continue;
    const m = normalizeMessage(g, { metadataOnly: true, folderName: names.name });
    if (M.neverRead([m], never) || !M.passesFilter([m], local)) continue;
    done.add(g.conversationId);
    out.push({ externalId: `thread:${g.conversationId}`, title: g.subject || '(no subject)', snippet: String(g.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 240), uri: g.webLink || `${hostFor(auth.config().email)}/inbox/id/${encodeURIComponent(g.id)}`, at: m.at, from: M.addressString(m.from) });
    if (out.length >= wanted) break;
  }
  return out;
}

// One conversation read now, as an item payload for items.upsert (what a live search found, kept when the person opens it).
// null when the grant or the never-read list says it must not be kept. externalId: 'thread:<conversationId>' (or the bare id).
async function openLive({ ctx = {}, source, externalId } = {}) {
  const auth = authFor(ctx);
  if (!auth || !auth.connected() || !source || source.readLevel === 'none') return null;
  const convId = String(externalId || '').replace(/^thread:/, '');
  if (!convId) return null;
  const metadataOnly = source.readLevel === 'metadata' || !canReadBodies(auth.grantedScopes());
  const filter = M.effectiveFilter(source, ctx.items || null);
  const { never, ...local } = filter;
  const known = await resolveFolders(ctx, auth, validate(source.config).folders);
  const names = folderNamer(ctx, auth, known.byId);
  const raw = await fetchConversation(ctx, auth, convId, metadataOnly);
  await names.learn(raw);
  const live = raw.filter((m) => !known.gone.has(m.parentFolderId) && !m.isDraft);
  if (!live.length) return null;
  const msgs = live.map((m) => normalizeMessage(m, { metadataOnly, folderName: names.name }));
  if (M.neverRead(msgs, never) || !M.passesFilter(msgs, local)) return null;
  const me = await myAddresses(ctx, auth);
  return threadItem({ id: convId, messages: raw }, me, { metadataOnly, folderName: names.name, account: auth.config().email, goneFolders: known.gone });
}

module.exports = {
  kind: 'outlook', every, validate, ready, check, estimate, sync, searchLive, openLive, compileFilter,
  OutlookAuth, outlookScopesFor, scopeString, covers, canReadBodies, hasMail, ACTION_SCOPE, MAIL_SCOPES, shortScopes, mailScopes,
  threadItem, normalizeMessage, neverRead, readCursor, writeCursor, authFor, idTokenEmail,
};
