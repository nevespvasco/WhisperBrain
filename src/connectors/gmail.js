'use strict';
// Gmail threads as items, through the same Google sign-in as the calendar (connect it again with mail switched on).
// One item per thread: who wrote, the plain text of each message, newest last. What is read follows the source's access grant
// (src/access/grants.js): 'metadata' keeps who/when/subject and no body (and drops Gmail's `snippet`, which IS body text); 'part'
// reads what the filter allows; 'all' reads the mailbox. The "never read" list is applied before anything is stored.
//
// Incremental by Gmail's historyId. The first run lists the threads (newest first) and keeps the mailbox's historyId from BEFORE it
// started; later runs ask what changed since: messages added or deleted, labels added or removed (so archiving, trashing or deleting at
// Google reaches the copy here). A run reads at most a budget of threads; when there is more, the cursor remembers where it stopped
// (the history page, or the listing page) and the next run continues from there: nothing is skipped. If Google says the history is too
// old (404), the listing starts again from scratch and anything no longer in it is tombstoned. Threads that are only in Trash or Spam
// are tombstoned too. Mail is private by default: only an AI on this computer may read it.
const every = 10 * 60_000;
const MAX_THREADS = 400;          // threads read per run (the rest waits for the next run, from the saved cursor)
const MAX_TEXT = 40_000;
const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe'];
const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];
const GONE_LABELS = new Set(['TRASH', 'SPAM']);
const CATEGORIES = ['promotions', 'social', 'updates', 'forums'];

const list = (v, n = 20) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, n);
const quoteLabel = (l) => (/^[\w-]+$/.test(l) ? l : `"${l.replace(/"/g, '')}"`);

function validate(config) {
  const query = String(config.query || 'newer_than:90d').trim().slice(0, 200);
  return { query: query || 'newer_than:90d', labels: list(config.labels, 10) };
}
const ready = ({ google }) => !!google?.config().gmail && google.connected();

// The Gmail search for a source: its own query, its labels as ANY-of (Gmail's labelIds would mean ALL-of), and the grant's filter:
//   filter = { labels:[], excludeLabels:[], fromDomains:[], excludeSenders:[], skipCategories:bool, never:{ senders, domains, labels, keywords } }
// What Gmail can express goes into q; the "never read" list is ALSO checked here after download (neverRead), so a rule Gmail could not
// apply still keeps the thread out.
function compileQuery(config = {}, filter = {}) {
  const parts = [String(config.query || '').trim()];
  const labels = [...list(config.labels, 10), ...list(filter.labels, 10)];
  if (labels.length) parts.push(labels.length === 1 ? `label:${quoteLabel(labels[0])}` : `{${labels.map((l) => `label:${quoteLabel(l)}`).join(' ')}}`);
  for (const l of [...list(filter.excludeLabels), ...list(filter.never?.labels)]) parts.push(`-label:${quoteLabel(l)}`);
  const domains = list(filter.fromDomains);
  if (domains.length) parts.push(domains.length === 1 ? `from:${domains[0]}` : `{${domains.map((d) => `from:${d}`).join(' ')}}`);
  for (const s of [...list(filter.excludeSenders), ...list(filter.never?.senders), ...list(filter.never?.domains)]) parts.push(`-from:${s}`);
  if (filter.skipCategories) for (const c of CATEGORIES) parts.push(`-category:${c}`);
  return parts.filter(Boolean).join(' ').slice(0, 1500);
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || '';
const b64 = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');
const stripHtml = (h) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

// The readable text of a message: the text/plain part, else the text/html part without its tags; the quoted earlier mail is cut
// (Gmail's "On … wrote:", the Portuguese "Em … escreveu:", Outlook's "From:/De: … Sent:/Enviado:" block, "-----Original Message", "> ").
const QUOTE = /\n(?:On .{5,120} wrote:|Em .{5,120} escreveu:|-{2,}\s*(?:Original Message|Mensagem original)|_{8,}\s*\n(?:From|De):|(?:From|De):[^\n]{1,200}\n(?:Sent|Enviad[oa]|Date|Data):|>{1}\s)/;
function bodyOf(part) {
  const parts = [];
  const walk = (p) => { if (p.parts?.length) p.parts.forEach(walk); else parts.push(p); };
  walk(part || {});
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data), html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  const raw = plain ? b64(plain.body.data) : html ? stripHtml(b64(html.body.data)) : '';
  return raw.replace(/\r/g, '').split(QUOTE)[0].replace(/\n{3,}/g, '\n\n').trim();
}

// the attachments of a message: names and sizes only (their content is never read here)
function attachmentsOf(part) {
  const out = [];
  const walk = (p) => { if (p.parts?.length) p.parts.forEach(walk); else if (p.filename) out.push({ name: p.filename, size: p.body?.size || 0, type: p.mimeType || '' }); };
  walk(part || {});
  return out;
}

const emailOf = (from) => (/<([^>]+)>/.exec(from)?.[1] || from).trim().toLowerCase();
const addresses = (v) => String(v || '').split(',').map(emailOf).filter((e) => e.includes('@'));

// Should this thread never be stored? The "never read" list: senders (addresses), domains, labels, keywords in the subject.
function neverRead(msgs, never = {}) {
  if (!never || !msgs.length) return false;
  const senders = new Set(list(never.senders, 200).map((s) => s.toLowerCase()));
  const domains = list(never.domains, 200).map((d) => d.toLowerCase().replace(/^@/, ''));
  const labels = new Set(list(never.labels, 50));
  const words = list(never.keywords, 50).map((k) => k.toLowerCase());
  for (const m of msgs) {
    const from = emailOf(header(m, 'from'));
    if (senders.has(from) || domains.some((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`))) return true;
    if ((m.labelIds || []).some((l) => labels.has(l))) return true;
    const subject = header(m, 'subject').toLowerCase();
    if (words.some((w) => subject.includes(w))) return true;
  }
  return false;
}

// me: the account's addresses (the address and its send-as aliases); account: the address, for links that open the right mailbox.
function threadItem(thread, me, { metadataOnly = false, account = '' } = {}) {
  const mine = me instanceof Set ? me : new Set([me].filter(Boolean));
  const msgs = (thread.messages || []).filter((m) => !(m.labelIds || []).includes('DRAFT'));
  if (!msgs.length) return null;
  const first = msgs[0], last = msgs[msgs.length - 1];
  const subject = header(first, 'subject') || '(no subject)';
  const text = metadataOnly ? '' : msgs.map((m) => `From: ${header(m, 'from')}\nDate: ${header(m, 'date')}\n\n${bodyOf(m.payload)}`).join('\n\n———\n\n').slice(0, MAX_TEXT);
  const lastFrom = emailOf(header(last, 'from'));
  const lastBody = metadataOnly ? '' : bodyOf(last.payload);
  const people = [...new Set(msgs.flatMap((m) => [header(m, 'from'), header(m, 'to'), header(m, 'cc')].flatMap(addresses)))].slice(0, 30);
  const attachments = metadataOnly ? [] : msgs.flatMap((m) => attachmentsOf(m.payload)).slice(0, 30);
  const link = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : 'u/0/'}#all/${thread.id}`;
  return {
    metaInHash: true, externalId: `thread:${thread.id}`, kind: 'email', title: subject, text, uri: link, occurredAt: Number(last.internalDate) || Date.now(),
    meta: {
      messages: msgs.length, people, lastFrom, lastFromMe: mine.has(lastFrom), lastAt: Number(last.internalDate) || 0,
      lastAsksSomething: metadataOnly ? null : /\?\s*($|\n)/.test(lastBody.slice(0, 600)),
      labels: [...new Set(msgs.flatMap((m) => m.labelIds || []))].slice(0, 10), historyId: thread.historyId,
      newsletter: msgs.some((m) => !!header(m, 'list-unsubscribe')), metadataOnly, ...(attachments.length ? { attachments } : {}),
    },
  };
}

// a thread whose every message is in Trash or Spam is gone as far as the person is concerned
const gone = (thread) => { const msgs = thread.messages || []; return msgs.length > 0 && msgs.every((m) => (m.labelIds || []).some((l) => GONE_LABELS.has(l))); };

async function check({ google }) {
  const p = await google.gmail('/users/me/profile');
  return { ok: true, email: p.emailAddress, messages: p.messagesTotal, threads: p.threadsTotal };
}

async function fetchThread(google, id, metadataOnly) {
  const params = metadataOnly ? { format: 'metadata', metadataHeaders: META_HEADERS } : { format: 'full' };
  try { return await google.gmail(`/users/me/threads/${id}`, params); } catch (e) { if (e.message?.includes('HTTP 404') || /not found/i.test(e.message)) return null; throw e; }
}

// The cursor: the plain historyId when nothing is half done (as before), else JSON with where the run stopped:
//   { h: historyId fully read up to, hp: the history page to continue (same startHistoryId), lp: the listing page to continue, lh: the historyId from before the listing }
function readCursor(s) {
  if (!s) return {};
  if (/^\d+$/.test(s)) return { h: s };
  try { const c = JSON.parse(s); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}
const writeCursor = (c) => (c.h && !c.hp && !c.lp && !c.lh ? String(c.h) : JSON.stringify(c));

// the account's own addresses: the address and its send-as aliases (a reply sent from an alias is still "from me")
async function myAddresses(google, email) {
  const out = new Set([email].filter(Boolean));
  try { for (const a of (await google.gmail('/users/me/settings/sendAs')).sendAs || []) if (a.sendAsEmail) out.add(String(a.sendAsEmail).toLowerCase()); } catch { /* not allowed at this level: the address alone */ }
  return out;
}

async function sync({ source, items, google, budget = MAX_THREADS }) {
  if (!ready({ google })) throw Object.assign(new Error('Connect Google with mail switched on first.'), { permanent: true });
  const level = source.readLevel || 'part';
  if (level === 'none') return { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0, skipped: 'nothing may be read' };
  const metadataOnly = level === 'metadata';
  const filter = source.filter || {};
  const profile = await google.gmail('/users/me/profile');
  const account = String(profile.emailAddress || '').toLowerCase();
  const me = await myAddresses(google, account);
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const save = (item) => { if (!item) return; const r = items.upsert(source.id, item); out[r.action === 'revived' ? 'updated' : r.action]++; };
  let c = readCursor(source.cursor);
  const ids = new Set();
  let listing = !c.h || !!c.lp, listingDone = false;

  if (!listing) {
    try {
      let page = c.hp, last = c.h;
      do {
        const j = await google.gmail('/users/me/history', { startHistoryId: c.h, historyTypes: HISTORY_TYPES, maxResults: 500, pageToken: page });
        for (const h of j.history || []) for (const m of [...(h.messagesAdded || []), ...(h.messagesDeleted || []), ...(h.labelsAdded || []), ...(h.labelsRemoved || [])]) if (m.message?.threadId) ids.add(m.message.threadId);
        page = j.nextPageToken;
        if (j.historyId) last = String(j.historyId);
      } while (page && ids.size < budget);
      c = page ? { h: c.h, hp: page } : { h: last };                           // stopped early: the next run reads the next page
    } catch (e) {
      if (!/HTTP 404|not found/i.test(e.message)) throw e;
      c = {}; listing = true;                                                   // the history is too old: list again from scratch
    }
  }
  const seen = new Set();
  let wholeListing = false;
  if (listing) {
    const lh = c.lh || String(profile.historyId || '');
    let page = c.lp;
    wholeListing = !c.lp;                                                       // started at the top: a complete listing may tombstone
    do {
      const j = await google.gmail('/users/me/threads', { q: metadataOnly ? undefined : compileQuery(source.config, filter), maxResults: 100, pageToken: page });
      for (const t of j.threads || []) ids.add(t.id);
      page = j.nextPageToken;
    } while (page && ids.size < budget);
    listingDone = !page;
    if (!listingDone) wholeListing = false;
    c = listingDone ? { h: lh } : { lp: page, lh };
  }
  for (const id of ids) {
    const t = await fetchThread(google, id, metadataOnly);
    if (!t || gone(t)) { if (items.tombstone(source.id, `thread:${id}`)) out.removed++; continue; }
    if (neverRead(t.messages || [], filter.never)) { if (items.tombstone(source.id, `thread:${id}`)) out.removed++; continue; }
    if (metadataOnly && filter.labels?.length && !(t.messages || []).some((m) => (m.labelIds || []).some((l) => filter.labels.includes(l)))) continue;   // metadata: Gmail cannot search, so the part is chosen here
    save(threadItem(t, me, { metadataOnly, account }));
    seen.add(`thread:${id}`);
  }
  if (listing && wholeListing && listingDone) out.removed += items.tombstoneMissing(source.id, seen);   // a complete listing: what fell out of it is gone
  items.updateSource(source.id, { cursor: writeCursor(c) });
  return out;
}

module.exports = { kind: 'gmail', every, validate, ready, check, sync, bodyOf, threadItem, compileQuery, neverRead, readCursor, writeCursor, HISTORY_TYPES };
