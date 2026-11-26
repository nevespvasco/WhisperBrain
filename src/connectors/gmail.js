'use strict';
// Gmail threads as items, read-only (gmail.readonly), through the same Google sign-in as the calendar (connect it again with mail switched on).
// One item per thread: who wrote, the plain text of each message, newest last. Incremental by Gmail's historyId: the first run reads the last
// 90 days (or your own search) and keeps the mailbox's historyId from BEFORE it started; later runs ask what changed since. If Google says the
// history is too old (404), the run starts again from scratch (a full resync) and anything that is no longer in the window is tombstoned.
// Mail is private by default: only an AI on this computer may read it.
const { day } = require('./chat');

const every = 10 * 60_000;
const MAX_THREADS = 400;
const MAX_TEXT = 40_000;

function validate(config) {
  const query = String(config.query || 'newer_than:90d').trim().slice(0, 200);
  return { query: query || 'newer_than:90d', labels: (Array.isArray(config.labels) ? config.labels : []).map(String).slice(0, 10) };
}
const ready = ({ google }) => !!google?.config().gmail && google.connected();

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || '';
const b64 = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');
const stripHtml = (h) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

// The readable text of a message: the text/plain part, else the text/html part without its tags; the quoted earlier mail is cut.
function bodyOf(part) {
  const parts = [];
  const walk = (p) => { if (p.parts?.length) p.parts.forEach(walk); else parts.push(p); };
  walk(part || {});
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data), html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  const raw = plain ? b64(plain.body.data) : html ? stripHtml(b64(html.body.data)) : '';
  return raw.replace(/\r/g, '').split(/\n(?:On .{5,80} wrote:|Em .{5,80} escreveu:|-{2,}\s*Original Message|>{1}\s)/)[0].replace(/\n{3,}/g, '\n\n').trim();
}

const emailOf = (from) => (/<([^>]+)>/.exec(from)?.[1] || from).trim().toLowerCase();

function threadItem(thread, me) {
  const msgs = (thread.messages || []).filter((m) => !(m.labelIds || []).includes('DRAFT'));
  if (!msgs.length) return null;
  const first = msgs[0], last = msgs[msgs.length - 1];
  const subject = header(first, 'subject') || '(no subject)';
  const text = msgs.map((m) => `From: ${header(m, 'from')}\nDate: ${header(m, 'date')}\n\n${bodyOf(m.payload)}`).join('\n\n———\n\n').slice(0, MAX_TEXT);
  const lastFrom = emailOf(header(last, 'from'));
  const lastBody = bodyOf(last.payload);
  const people = [...new Set(msgs.flatMap((m) => [header(m, 'from'), header(m, 'to')]).join(',').split(',').map(emailOf).filter((e) => e.includes('@')))].slice(0, 20);
  return {
    metaInHash: true, externalId: `thread:${thread.id}`, kind: 'email', title: subject, text, uri: `https://mail.google.com/mail/u/0/#all/${thread.id}`, occurredAt: Number(last.internalDate) || Date.now(),
    meta: { messages: msgs.length, people, lastFrom, lastFromMe: !!me && lastFrom === me, lastAt: Number(last.internalDate) || 0, lastAsksSomething: /\?\s*($|\n)/.test(lastBody.slice(0, 600)), labels: [...new Set(msgs.flatMap((m) => m.labelIds || []))].slice(0, 10), historyId: thread.historyId },
  };
}

async function check({ google }) {
  const p = await google.gmail('/users/me/profile');
  return { ok: true, email: p.emailAddress, messages: p.messagesTotal };
}

async function fetchThread(google, id) {
  try { return await google.gmail(`/users/me/threads/${id}`, { format: 'full' }); } catch (e) { if (e.message?.includes('HTTP 404') || /not found/i.test(e.message)) return null; throw e; }
}

async function sync({ source, items, google }) {
  if (!ready({ google })) throw Object.assign(new Error('Connect Google with mail switched on first.'), { permanent: true });
  const profile = await google.gmail('/users/me/profile');
  const me = String(profile.emailAddress || '').toLowerCase();
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const save = (item) => { if (!item) return; const r = items.upsert(source.id, item); out[r.action === 'revived' ? 'updated' : r.action]++; };
  let ids = null, full = !source.cursor;
  if (source.cursor) {
    ids = new Set();
    try {
      let page;
      do {
        const j = await google.gmail('/users/me/history', { startHistoryId: source.cursor, historyTypes: 'messageAdded', maxResults: 500, pageToken: page });
        for (const h of j.history || []) for (const m of [...(h.messagesAdded || []), ...(h.messagesDeleted || [])]) ids.add(m.message.threadId);
        page = j.nextPageToken;
        if (j.historyId) profile.historyId = j.historyId;
      } while (page && ids.size < MAX_THREADS);
    } catch (e) {
      if (!/HTTP 404|not found/i.test(e.message)) throw e;
      ids = null; full = true;                                              // the history is too old: start again from scratch
    }
  }
  const seen = new Set();
  if (full) {
    ids = new Set();
    let page;
    const q = source.config.query || 'newer_than:90d';
    do {
      const j = await google.gmail('/users/me/threads', { q, maxResults: 100, pageToken: page, labelIds: undefined });
      for (const t of j.threads || []) ids.add(t.id);
      page = j.nextPageToken;
    } while (page && ids.size < MAX_THREADS);
  }
  for (const id of ids) {
    const t = await fetchThread(google, id);
    if (!t) { items.tombstone(source.id, `thread:${id}`); out.removed++; continue; }
    save(threadItem(t, me));
    seen.add(`thread:${id}`);
  }
  if (full && ids.size < MAX_THREADS) out.removed += items.tombstoneMissing(source.id, seen);   // a complete listing: what fell out of it is gone
  items.updateSource(source.id, { cursor: String(profile.historyId || source.cursor || '') });
  return out;
}

module.exports = { kind: 'gmail', every, validate, ready, check, sync, bodyOf, threadItem };
