'use strict';
// What every mail source other than Gmail shares: the Outlook (Microsoft Graph), IMAP and mbox sources all reduce a message to the
// same small shape, group messages into threads, apply the person's grant (the part they chose and the "never read" list) and make
// the same item as the Gmail connector does, so everything downstream (people, "No reply yet", search, the AI paths) treats them alike.
//
// A normalised message:
//   { from: { name, address } | null, to: [address], cc: [address], subject, at (ms), text (body, '' at the metadata level), messageId, references,
//     labels: [string], unsubscribe: bool, attachments: [{ name, size, type }], draft: bool }
const crypto = require('node:crypto');

const MAX_TEXT = 40_000;          // text kept per thread (as the Gmail connector does)
const MAX_MESSAGE_TEXT = 12_000;  // and per message, so one long message does not push the others out

const list = (v, n = 20) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, n);
const emailOf = (from) => (/<([^>]+)>/.exec(String(from || ''))?.[1] || String(from || '')).trim().toLowerCase();
const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const domainOf = (address) => String(address || '').split('@')[1] || '';

// ---------- the text of a message ----------
// The earlier mail a reply quotes is cut: Gmail/English "On … wrote:", Portuguese "Em … escreveu:", Outlook's "From:/De: … Sent:/Enviado:"
// block (also in German, French, Italian), "-----Original Message", the underscore line Outlook draws, and "> " quoted lines.
const FROM = '(?:From|De|Von|Da|Van|Från|Fra)\\s?', SENT = '(?:Sent|Enviad[oa]|Date|Data|Gesendet|Datum|Envoy[ée]|Inviato|Skickat)\\s?';
const QUOTE = new RegExp(`\\n(?:On .{5,120} wrote:|Em .{5,120} escreveu:|Le .{5,120} a [ée]crit\\s?:|Am .{5,120} schrieb .{0,80}:|-{2,}\\s*(?:Original Message|Mensagem original|Urspr[uü]ngliche Nachricht|Message d'origine)|_{8,}\\s*\\n${FROM}:|${FROM}:[^\\n]{1,200}\\n${SENT}:|>\\s)`);
const cutQuote = (text) => `\n${String(text || '').replace(/\r/g, '')}`.split(QUOTE)[0].replace(/^\n/, '').replace(/\n{3,}/g, '\n\n').trim();

// ---------- the grant ----------
// "Should this thread never be stored?": the never-read list = senders (addresses), domains, labels / categories / folders, subject words.
function neverRead(msgs, never = {}) {
  if (!never || !msgs.length) return false;
  const senders = new Set(list(never.senders, 500).map((s) => s.toLowerCase()));
  const domains = list(never.domains, 200).map((d) => d.toLowerCase().replace(/^@/, ''));
  const labels = new Set(list(never.labels, 50).map((l) => l.toLowerCase()));
  const words = list(never.keywords, 50).map((k) => k.toLowerCase());
  for (const m of msgs) {
    const from = m.from?.address || '';
    if (from && (senders.has(from) || domains.some((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`)))) return true;
    if ((m.labels || []).some((l) => labels.has(String(l).toLowerCase()))) return true;
    const subject = String(m.subject || '').toLowerCase();
    if (words.some((w) => subject.includes(w))) return true;
  }
  return false;
}

// The part of the grant's filter a service could not apply itself, checked here after download (a thread passes when it matches).
//   filter = { labels: [any-of], excludeLabels: [], fromDomains: [], excludeSenders: [] }
function passesFilter(msgs, filter = {}) {
  const labels = list(filter.labels, 20).map((l) => l.toLowerCase());
  if (labels.length && !msgs.some((m) => (m.labels || []).some((l) => labels.includes(String(l).toLowerCase())))) return false;
  const ex = list(filter.excludeLabels, 50).map((l) => l.toLowerCase());
  if (ex.length && msgs.some((m) => (m.labels || []).some((l) => ex.includes(String(l).toLowerCase())))) return false;
  const domains = list(filter.fromDomains, 50).map((d) => d.toLowerCase().replace(/^@/, ''));
  if (domains.length && !msgs.some((m) => m.from?.address && domains.some((d) => m.from.address.endsWith(`@${d}`) || m.from.address.endsWith(`.${d}`)))) return false;
  const senders = list(filter.excludeSenders, 200).map((s) => s.toLowerCase().replace(/^@/, ''));
  if (senders.length && msgs.some((m) => m.from?.address && senders.some((s) => m.from.address === s || m.from.address.endsWith(`@${s}`)))) return false;
  return true;
}

// the grant's filter with the addresses the person asked to forget added to the never-read senders (as the Gmail connector does)
function effectiveFilter(source, items) {
  const filter = { ...(source.filter || {}) };
  filter.never = { ...(filter.never || {}), senders: [...list(filter.never?.senders, 500), ...(items?.blocked?.() || [])] };
  return filter;
}

// ---------- threads ----------
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|res|rv|enc|tr|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;
const normalizeSubject = (s) => String(s || '').replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Which thread does a message belong to? { messageId, inReplyTo, references: [ids], subject } -> { key, root, subject }
// The oldest id a message points at (the first of References, else In-Reply-To) names the thread, so every reply finds the same one;
// a message that points at nothing starts a thread of its own, unless its subject says it is a reply or a forward (a client that
// dropped the headers): then the subject names the thread.
function threadKeyOf({ messageId = '', inReplyTo = '', references = [], subject = '' } = {}) {
  const root = references[0] || inReplyTo || '';
  if (root) return { key: `m:${b64url(root)}`, root };
  if (!messageId || REPLY_PREFIX.test(subject)) return { key: `s:${b64url(normalizeSubject(subject))}`, root: '', subject: normalizeSubject(subject) };
  return { key: `m:${b64url(messageId)}`, root: messageId };
}
// the other way round, for a live search that must find a thread again: -> { kind: 'm' | 's', value }
function parseKey(key) {
  const m = /^(m|s):(.+)$/.exec(String(key || ''));
  return m ? { kind: m[1], value: unb64url(m[2]) } : null;
}

// ---------- the item ----------
const addressString = (a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || '');
const asks = (text) => /\?\s*($|\n)/.test(String(text).slice(0, 600));

// msgs: oldest first. me: Set of the account's own addresses (aliases included).
// -> an item for ItemStore.upsert, with the same meta as the Gmail connector's (people include Cc, lastFromMe counts aliases...)
function buildThreadItem({ externalId, uri = '', msgs, me, metadataOnly = false, extraMeta = {}, subjectOverride }) {
  const live = msgs.filter((m) => !m.draft).sort((a, b) => a.at - b.at);
  if (!live.length) return null;
  const mine = me instanceof Set ? me : new Set([me].filter(Boolean));
  const first = live[0], last = live[live.length - 1];
  const title = subjectOverride || first.subject || '(no subject)';
  let budget = MAX_TEXT;
  const text = metadataOnly ? '' : live.map((m) => {
    const body = String(m.text || '').slice(0, MAX_MESSAGE_TEXT);
    const block = `From: ${addressString(m.from)}\nDate: ${new Date(m.at).toUTCString()}\n\n${body}`;
    budget -= block.length;
    return budget >= 0 ? block : '';
  }).filter(Boolean).join('\n\n———\n\n').slice(0, MAX_TEXT);
  const lastFrom = last.from?.address || '';
  const everyone = (m) => [m.from?.address, ...(m.to || []), ...(m.cc || [])].filter(Boolean);
  const people = [...new Set(live.flatMap(everyone))].slice(0, 30);
  const senders = [...new Set(live.map((m) => m.from?.address).filter(Boolean))].slice(0, 20);
  const recipients = [...new Set(live.flatMap((m) => [...(m.to || []), ...(m.cc || [])]))].slice(0, 30);
  const attachments = metadataOnly ? [] : live.flatMap((m) => m.attachments || []).slice(0, 30);
  const when = last.at || Date.now();
  return {
    metaInHash: true, externalId, kind: 'email', title, text, uri, occurredAt: when,
    meta: {
      messages: live.length, people, senders, recipients, lastFrom, lastFromMe: mine.has(lastFrom), lastAt: last.at || 0,
      lastAsksSomething: metadataOnly ? null : asks(last.text),
      labels: [...new Set(live.flatMap((m) => m.labels || []))].slice(0, 10),
      newsletter: live.some((m) => m.unsubscribe === true) ? true : live.every((m) => m.unsubscribe == null) ? null : false,   // null: the service gave no headers at this level
      // what a reply needs to join the thread (the same fields the Gmail connector keeps)
      lastMessageId: last.messageId || '', references: (last.references || []).slice(-10), subject: first.subject || '',
      metadataOnly, ...(attachments.length ? { attachments } : {}), ...extraMeta,
    },
  };
}

// a stable short digest for things that need an id but must not carry the text
const digest = sha;

module.exports = {
  MAX_TEXT, MAX_MESSAGE_TEXT, list, emailOf, domainOf, b64url, unb64url, cutQuote, neverRead, passesFilter, effectiveFilter, normalizeSubject, threadKeyOf, parseKey,
  buildThreadItem, addressString, REPLY_PREFIX, digest,
};
