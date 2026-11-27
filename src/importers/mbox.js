'use strict';
// Import a mail archive in mbox format (Google Takeout's "All mail Including Spam and Trash.mbox", Thunderbird, Apple Mail exports,
// anything that writes mbox) as items of a source of kind 'mbox': one item per THREAD, the same shape as the Gmail connector's.
//
// The file is read as a STREAM and split on "From " lines (a message starts at a "From " line that follows a blank line; inside a
// message a body line that starts with "From " is stored as ">From ", and ">>From " as ">>>From " (mboxrd), which is undone here).
// Each message is read with the small MIME reader (src/importers/mime.js); threads are Gmail's own X-GM-THRID when the file has it
// (Takeout does), else the same References / subject grouping the IMAP connector uses. What is kept follows the grant, as for every
// source: 'metadata' keeps who/when/subject and reads no body at all (only the top of each message is even kept in memory), the
// grant's filter and the "never read" list are applied, Spam and Trash (Takeout's X-Gmail-Labels) are left out, and `maxBytes` stops a
// file that is far bigger than expected before it fills the disk or the memory.
//
// Memory: the text of a thread is cut to what an item keeps (40 000 characters, 12 000 per message), so a mailbox costs roughly that
// per thread while it is read; a very large archive is better imported one year at a time.
const fs = require('node:fs');
const { parseMessage } = require('./mime');
const M = require('../connectors/mail-common');
const { grantOf } = require('../access/grants');

const DEFAULT_MAX_BYTES = 8 * 1024 ** 3;           // a file bigger than this is refused (8 GiB)
const DEFAULT_MAX_MESSAGE = 25 * 1024 ** 2;        // one message is read to this size (the rest is attachments: only their sizes are not exact)
const HEADER_ONLY_BYTES = 64 * 1024;               // at the metadata level only the top of each message is kept
const LEFT_OUT = new Set(['spam', 'trash']);        // Takeout includes them; the Gmail connector leaves them out too

const isBlank = (l) => (l.length === 1 && l[0] === 10) || (l.length === 2 && l[0] === 13 && l[1] === 10);
// "From 1743281977583333633@xxx Mon Nov 24 10:00:00 +0000 2026" / "From ana@x.pt Mon Nov 24 10:00:00 2026"
const isFromLine = (l) => l.length > 6 && l[0] === 0x46 && l.toString('latin1', 0, 5) === 'From ' && l[5] !== 0x20 && l[5] !== 10 && l[5] !== 13;
const fromLineDate = (l) => { const m = /^From \S+\s+(.*?)\s*$/.exec(l.toString('latin1')); const t = m ? Date.parse(m[1].replace(/^(\w{3}) (\w{3}) (\d+) ([\d:]+) ([+-]\d{4}) (\d{4})$/, '$1, $3 $2 $6 $4 $5')) : NaN; return Number.isFinite(t) ? t : null; };
// ">From x" -> "From x", ">>From x" -> ">From x" (mboxrd)
function unescapeLine(l) {
  if (l[0] !== 0x3e) return l;
  let i = 0;
  while (l[i] === 0x3e) i++;
  return l.toString('latin1', i, i + 5) === 'From ' ? l.subarray(1) : l;
}

// Read an mbox stream: yields { raw: Buffer, fromDate } for each message. Options: maxBytes (stop there: `stats.truncated`),
// maxMessageBytes (a longer message is read up to this), keepBytes (keep only this much of each message: for header-only reads).
// `stats` is filled as it goes: { bytes, messages, truncated, clipped }.
async function* readMbox(stream, { maxBytes = DEFAULT_MAX_BYTES, maxMessageBytes = DEFAULT_MAX_MESSAGE, keepBytes = maxMessageBytes, stats = {} } = {}) {
  Object.assign(stats, { bytes: 0, messages: 0, truncated: false, clipped: 0 });
  const cap = Math.min(keepBytes, maxMessageBytes);
  let parts = [], size = 0, clipped = false, fromDate = null, prevBlank = true, started = false;
  let carry = Buffer.alloc(0);
  const finish = () => {
    if (!started) return null;
    if (parts.length && isBlank(parts[parts.length - 1])) parts.pop();             // the blank line mbox writes before the next "From "
    const out = { raw: Buffer.concat(parts), fromDate };
    if (clipped && keepBytes >= maxMessageBytes) stats.clipped++;        // (the header-only read clips on purpose: not worth counting)
    parts = []; size = 0; clipped = false; started = false;
    stats.messages++;
    return out;
  };
  const line = function* (l) {
    if (isFromLine(l) && prevBlank) {
      const done = finish();
      if (done) yield done;
      started = true; fromDate = fromLineDate(l); prevBlank = false;
      return;
    }
    if (!started) { started = true; fromDate = null; }                              // a file that is just a message, with no "From " line
    prevBlank = isBlank(l);
    if (size >= cap) { clipped = true; return; }
    const u = unescapeLine(l);
    parts.push(u); size += u.length;
  };
  for await (const chunk of stream) {
    if (stats.bytes + chunk.length > maxBytes) { stats.truncated = true; break; }
    stats.bytes += chunk.length;
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let at = 0;
    for (let nl = buf.indexOf(10, at); nl >= 0; nl = buf.indexOf(10, at)) { yield* line(buf.subarray(at, nl + 1)); at = nl + 1; }
    carry = buf.subarray(at);
    if (carry.length > maxMessageBytes) carry = carry.subarray(0, maxMessageBytes);    // one enormous line with no break: not a mail archive
  }
  if (!stats.truncated) {
    if (carry.length) yield* line(carry);
    const last = finish();
    if (last) yield last;
  }
  // a truncated file: the message that was being read is incomplete and is not given
}

const labelsOf = (h) => String(h.text('x-gmail-labels') || '').split(',').map((l) => l.trim()).filter(Boolean);
const toMsg = (parsed, h, labels, fallbackAt, metadataOnly) => ({
  from: parsed.from, to: parsed.to.map((a) => a.address), cc: parsed.cc.map((a) => a.address), subject: parsed.subject, at: parsed.date || fallbackAt || 0,
  text: metadataOnly ? '' : M.cutQuote(parsed.text), labels, unsubscribe: parsed.listUnsubscribe, attachments: metadataOnly ? [] : parsed.attachments,
  draft: labels.some((l) => l.toLowerCase() === 'drafts'), messageId: parsed.messageId ? `<${parsed.messageId}>` : '', references: parsed.references.map((r) => `<${r}>`),
});
const toTime = (v) => { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

// importMbox({ items, source, file | stream, filter, level, maxBytes, maxMessageBytes, replace, me, onProgress })
//   source: a source row of kind 'mbox' (its grant is the default for `filter` and `level`)
//   filter: { labels, excludeLabels, fromDomains, excludeSenders, never: { senders, domains, labels, keywords }, after, before, days } (labels are Gmail's X-Gmail-Labels)
//   level:  none | metadata | part | all (default: the source's)
//   replace: threads of an earlier import that are not in this file are tombstoned (default: an import only adds and updates)
// -> { messages, threads, created, updated, unchanged, removed, skipped, filtered, clipped, truncated, bytes }
async function importMbox({ items, source, file, stream, filter, level, maxBytes = DEFAULT_MAX_BYTES, maxMessageBytes = DEFAULT_MAX_MESSAGE, replace = false, me = [], onProgress } = {}) {
  if (!items || !source) throw new Error('importMbox needs the item store and the source.');
  const grant = grantOf(source);
  const lvl = level || grant.readLevel;
  const out = { messages: 0, threads: 0, created: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, filtered: 0, clipped: 0, truncated: false, bytes: 0 };
  if (lvl === 'none') return { ...out, skippedAll: 'nothing may be read' };
  const metadataOnly = lvl === 'metadata';
  const base = filter ?? grant.filter ?? {};
  const eff = { ...base, never: { ...(base.never || {}), senders: [...M.list(base.never?.senders, 500), ...(items.blocked?.() || [])] } };
  const { never, after, before, days, ...local } = eff;
  const afterAt = toTime(after) ?? (days ? Date.now() - Number(days) * 86_400_000 : null), beforeAt = toTime(before);

  let input = stream;
  if (!input) {
    if (!file) throw new Error('importMbox needs a file or a stream.');
    const st = fs.statSync(file);
    if (st.size > maxBytes) throw Object.assign(new Error(`This file is ${Math.round(st.size / 1024 ** 2)} MB, more than the limit of ${Math.round(maxBytes / 1024 ** 2)} MB. Split it (by year) or raise the limit.`), { code: 'too-big', status: 413 });
    input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  }

  const threads = new Map();                       // key -> messages
  const mine = new Set(M.list(me, 20).concat(M.list(source.config?.me, 20)).map((a) => a.toLowerCase()));
  const stats = {};
  for await (const m of readMbox(input, { maxBytes, maxMessageBytes, keepBytes: metadataOnly ? HEADER_ONLY_BYTES : maxMessageBytes, stats })) {
    let parsed;
    try { parsed = parseMessage(m.raw, { headersOnly: metadataOnly }); } catch { out.skipped++; continue; }
    const h = parsed.headers;
    const labels = labelsOf(h);
    if (labels.some((l) => LEFT_OUT.has(l.toLowerCase()))) { out.skipped++; continue; }
    for (const a of h.all('delivered-to')) { const addr = M.emailOf(a); if (addr.includes('@')) mine.add(addr); }
    if (labels.some((l) => l.toLowerCase() === 'sent') && parsed.from?.address) mine.add(parsed.from.address);
    const thrid = String(h.get('x-gm-thrid') || '').trim();
    const key = /^\d+$/.test(thrid) ? `g:${thrid}` : M.threadKeyOf({ messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references, subject: parsed.subject }).key;
    (threads.get(key) || threads.set(key, []).get(key)).push(toMsg(parsed, h, labels, m.fromDate, metadataOnly));
    out.messages++;
    if (onProgress && out.messages % 500 === 0) onProgress({ messages: out.messages, bytes: stats.bytes });
  }
  Object.assign(out, { truncated: stats.truncated, bytes: stats.bytes, clipped: stats.clipped });

  const seen = new Set();
  for (const [key, msgs] of threads) {
    const externalId = `thread:${key}`;
    const live = msgs.filter((x) => !x.draft);
    const lastAt = Math.max(0, ...live.map((x) => x.at));
    const outside = (afterAt != null && lastAt < afterAt) || (beforeAt != null && lastAt > beforeAt);
    if (!live.length || outside || M.neverRead(msgs, never) || !M.passesFilter(msgs, local)) {
      out.filtered++;
      if (items.tombstone(source.id, externalId)) out.removed++;                // a thread kept by an earlier, wider import
      continue;
    }
    const item = M.buildThreadItem({ externalId, uri: '', msgs, me: mine, metadataOnly, extraMeta: { threadKey: key, imported: 'mbox' } });
    if (!item) { out.filtered++; continue; }
    const r = items.upsert(source.id, item);
    out[r.action === 'revived' ? 'updated' : r.action]++;
    out.threads++;
    seen.add(externalId);
  }
  if (replace && !stats.truncated) out.removed += items.tombstoneMissing(source.id, seen);
  return out;
}

module.exports = { importMbox, readMbox, unescapeLine, isFromLine, DEFAULT_MAX_BYTES };
