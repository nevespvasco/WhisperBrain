'use strict';
// A small RFC 5322 / MIME reader (and a writer for plain replies), with no dependencies. It is used by the IMAP connector and the
// mbox importer, which both receive raw messages. It aims to read real-world mail, not to validate it: folded headers, RFC 2047
// encoded words ("=?utf-8?B?...?="), RFC 2231 parameters, multipart (nested), quoted-printable, base64, utf-8 / latin1 / other
// charsets the runtime knows, text/plain preferred over text/html, and attachments as a name and a size only (their content is
// never decoded or kept).
//
// Nothing here throws on odd input: a broken header or a truncated message gives the part that could be read.

const CRLF = '\r\n';

// ---------- charsets ----------
const ALIASES = { 'us-ascii': 'utf-8', ascii: 'utf-8', latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', 'iso8859-1': 'windows-1252', 'latin-1': 'windows-1252', utf8: 'utf-8', 'x-unknown': 'utf-8', unknown: 'utf-8' };

// bytes -> string in the given charset; an unknown charset falls back to utf-8 (replacement characters, never an error)
function decodeCharset(buf, charset = 'utf-8') {
  const name = String(charset || 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  const label = ALIASES[name] || name;
  try { return new TextDecoder(label).decode(buf); } catch { /* unknown label */ }
  return new TextDecoder('utf-8').decode(buf);
}

// ---------- transfer encodings ----------
function decodeQuotedPrintable(input) {
  const s = String(input).replace(/[ \t]+(?=\r?\n)/g, '').replace(/=\r?\n/g, '');   // soft line breaks (and the blanks before them)
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else if (c < 0x80) out.push(c);
    else out.push(...Buffer.from(s[i], 'utf8'));
  }
  return Buffer.from(out);
}
const decodeBase64 = (input) => Buffer.from(String(input).replace(/[^A-Za-z0-9+/_-]/g, ''), 'base64');
// the size a base64 body decodes to, without decoding it (an attachment's size)
function base64Size(input) {
  const clean = String(input).replace(/[^A-Za-z0-9+/=_-]/g, '');
  const pad = /=+$/.exec(clean)?.[0].length || 0;
  return Math.max(0, Math.floor(((clean.length - pad) * 3) / 4));
}

// the bytes of a body after its Content-Transfer-Encoding
function decodeTransfer(raw, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  if (enc === 'base64') return decodeBase64(text);
  if (enc === 'quoted-printable') return decodeQuotedPrintable(text);
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'latin1');
}

// ---------- RFC 2047 encoded words ----------
function decodeWords(value) {
  const s = String(value ?? '');
  if (!s.includes('=?')) return s;
  // an encoded word is =?charset?B|Q?text?=; blanks between two encoded words are dropped, and the bytes of neighbouring words in the
  // same charset are decoded together (a multi-byte character may be split across two words)
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(s))) {
    const between = s.slice(last, m.index);
    if (between && !(parts.length && !parts[parts.length - 1].text && /^\s*$/.test(between))) parts.push({ text: between });
    const charset = m[1].replace(/\*[\w-]*$/, '');   // RFC 2231 language suffix: =?utf-8*en?...
    const bytes = m[2].toUpperCase() === 'B' ? decodeBase64(m[3]) : decodeQuotedPrintable(m[3].replace(/_/g, ' '));
    const prev = parts[parts.length - 1];
    if (prev && prev.charset === charset.toLowerCase()) prev.bytes = Buffer.concat([prev.bytes, bytes]);
    else parts.push({ charset: charset.toLowerCase(), bytes });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts.map((p) => (p.text !== undefined ? p.text : decodeCharset(p.bytes, p.charset))).join('');
}

// ---------- headers ----------
// raw: Buffer | string (a header block, or a whole message: reading stops at the first blank line)
// -> { list: [[name, value]] (names as written, values unfolded and NOT decoded), get(name), all(name), text(name) (decoded) }
function parseHeaders(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const end = /\r?\n\r?\n/.exec(str);
  const block = end ? str.slice(0, end.index) : str.replace(/(\r?\n)+$/, '');
  const list = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && list.length) { list[list.length - 1][1] += ` ${line.trim()}`; continue; }   // folded: part of the previous header
    const i = line.indexOf(':');
    if (i > 0 && !/\s/.test(line.slice(0, i))) list.push([line.slice(0, i), line.slice(i + 1).trim()]);
  }
  const lower = (n) => String(n).toLowerCase();
  const all = (name) => list.filter(([k]) => lower(k) === lower(name)).map(([, v]) => v);
  return {
    list,
    get: (name) => all(name)[0] ?? '',
    all,
    // headers carry 8-bit text in practice (a raw utf-8 subject): `get` returns it as the bytes were read, `text` repairs that
    text: (name) => decodeWords(fixUtf8(all(name)[0] ?? '')),
  };
}

// a header read as latin1 that is really utf-8 bytes: decode it again as utf-8 when that is valid, else keep it
function fixUtf8(s) {
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1')); } catch { return s; }
}

// "text/plain; charset=utf-8; name*0=..." -> { value: 'text/plain', params: { charset: 'utf-8', name: '...' } } (RFC 2231 continuations and encodings)
function parseParams(header) {
  const s = String(header || '');
  const parts = [];
  let cur = '', quote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && quote) { cur += s[++i] ?? ''; continue; }
    if (ch === '"') { quote = !quote; cur += ch; continue; }
    if (ch === ';' && !quote) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const value = parts.shift().trim().toLowerCase();
  const raw = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    raw[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"([\s\S]*)"$/, '$1');
  }
  const params = {};
  const pieces = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(k);
    if (!m) { params[k] = decodeWords(v); continue; }
    (pieces[m[1]] ||= []).push({ n: Number(m[2] || 0), encoded: !!m[3] || (!m[2] && k.endsWith('*')), v });
  }
  for (const [name, list] of Object.entries(pieces)) {
    list.sort((a, b) => a.n - b.n);
    let charset = 'utf-8', joined = '';
    list.forEach((p, i) => {
      let v = p.v;
      if (i === 0 && p.encoded) { const mm = /^([^']*)'[^']*'([\s\S]*)$/.exec(v); if (mm) { charset = mm[1] || 'utf-8'; v = mm[2]; } }
      joined += p.encoded ? v : v.replace(/%/g, '%25');
    });
    try { params[name] = decodeCharset(Buffer.from(joined.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'), charset); } catch { params[name] = joined; }
  }
  return { value, params };
}

// ---------- addresses ----------
// "Ana <ana@x.pt>, \"Costa, Rui\" <rui@y.pt>, plain@z.pt, Group: a@b.c, d@e.f;" -> [{ name, address }]
function parseAddressList(value) {
  const s = decodeWords(fixUtf8(String(value || '')));
  const out = [];
  const items = [];
  let cur = '', quote = false, angle = false, paren = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && quote) { cur += ch + (s[++i] ?? ''); continue; }
    if (ch === '"' && !paren) quote = !quote;
    else if (!quote) {
      if (ch === '(') paren++; else if (ch === ')' && paren) paren--;
      else if (!paren && ch === '<') angle = true; else if (!paren && ch === '>') angle = false;
      else if (!paren && !angle && (ch === ',' || ch === ';')) { items.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  items.push(cur);
  for (let it of items) {
    it = it.trim();
    if (!it) continue;
    const group = /^[^<>"@:]+:\s*(\S[\s\S]*)$/.exec(it);            // "Team: a@b.c" (a group's name before its first member)
    if (group && group[1].includes('@')) it = group[1];
    const angled = /<([^<>]*)>/.exec(it);
    let address, name;
    if (angled) {
      address = angled[1].trim();
      name = it.slice(0, angled.index).trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\(.)/g, '$1').trim();
    } else {
      const bare = /([^\s<>(),;:"]+@[^\s<>(),;:"]+)/.exec(it);
      if (!bare) continue;
      address = bare[1];
      name = (/\(([^)]*)\)/.exec(it)?.[1] || '').trim();
    }
    if (address.includes('@')) out.push({ name, address: address.toLowerCase() });
  }
  return out;
}

// "Name <a@b>" for display
const formatAddress = (a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || '');

// "Mon, 24 Nov 2026 10:00:00 +0000 (UTC)" -> ms, or null
function parseDate(value) {
  const s = String(value || '').replace(/\([^)]*\)/g, '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// ---------- html ----------
function htmlToText(h) {
  return String(h)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ');
}

// ---------- structure ----------
function splitBlock(buf) {
  // header block and body: the first blank line, CRLF or LF
  const s = buf.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: '' };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

function splitMultipart(body, boundary) {
  const parts = [];
  const delim = `--${boundary}`;
  const lines = body.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (line === delim || line.startsWith(`${delim} `) || line.startsWith(`${delim}\t`)) { if (cur) parts.push(cur.join('\n')); cur = []; continue; }
    if (line === `${delim}--` || line.startsWith(`${delim}--`)) { if (cur) parts.push(cur.join('\n')); cur = null; break; }
    if (cur) cur.push(line);
  }
  if (cur) parts.push(cur.join('\n'));     // a truncated message: the last part has no closing boundary
  return parts;
}

const MAX_DEPTH = 8;
// A part (text of the part including its own headers) -> collected { texts: [{ type, text }], attachments: [...] }
function walk(partText, out, depth = 0) {
  const { head, body } = splitBlock(Buffer.from(partText, 'latin1'));
  const h = parseHeaders(head);
  const ct = parseParams(h.get('content-type') || 'text/plain');
  const type = ct.value || 'text/plain';
  const cd = parseParams(h.get('content-disposition'));
  const encoding = h.get('content-transfer-encoding');
  if (type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    const alt = type === 'multipart/alternative';
    const group = [];
    for (const sub of splitMultipart(body, ct.params.boundary)) {
      const inner = { texts: [], attachments: [] };
      walk(sub, inner, depth + 1);
      out.attachments.push(...inner.attachments);
      group.push(inner.texts);
    }
    // alternative: the best single rendering (plain, else html); mixed/related: every text part, in order
    if (alt) {
      const flat = group.flat();
      const plain = flat.filter((t) => t.type === 'text/plain'), html = flat.filter((t) => t.type === 'text/html');
      out.texts.push(...(plain.length ? plain : html.length ? html : flat));
    } else out.texts.push(...group.flat());
    return;
  }
  const filename = cd.params.filename || ct.params.name || '';
  // anything that is not text is an attachment (a pdf, an image, a forwarded message); text is one only when it says so
  const isAttachment = cd.value === 'attachment' || type === 'message/rfc822' || !type.startsWith('text/');
  if (isAttachment) {
    const size = String(encoding).trim().toLowerCase() === 'base64' ? base64Size(body) : String(encoding).trim().toLowerCase() === 'quoted-printable' ? decodeQuotedPrintable(body).length : Buffer.byteLength(body, 'latin1');
    out.attachments.push({ name: filename || (type === 'message/rfc822' ? 'message.eml' : 'attachment'), size, type });
    return;
  }
  if (type === 'text/plain' || type === 'text/html') {
    const text = decodeCharset(decodeTransfer(body, encoding), ct.params.charset);
    out.texts.push({ type, text: type === 'text/html' ? htmlToText(text) : text.replace(/\r/g, '') });
  }
}

// ids like "<a@b> <c@d>" -> ['a@b', 'c@d']
const messageIds = (v) => [...String(v || '').matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);

// raw: Buffer | string -> a parsed message. { headersOnly: true } skips the body (the metadata level never reads one).
//   -> { messageId, inReplyTo, references, from:{name,address}|null, to, cc, replyTo, subject, date, listUnsubscribe, text, attachments, headers }
function parseMessage(raw, { headersOnly = false } = {}) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const { head, body } = headersOnly ? { head: buf.toString('latin1').split(/\r?\n\r?\n/)[0], body: '' } : splitBlock(buf);
  const h = parseHeaders(head);
  const base = {
    messageId: messageIds(h.get('message-id'))[0] || '',
    inReplyTo: messageIds(h.get('in-reply-to'))[0] || '',
    references: messageIds(h.get('references')),
    from: parseAddressList(h.get('from'))[0] || null,
    to: parseAddressList(h.all('to').join(',')), cc: parseAddressList(h.all('cc').join(',')), replyTo: parseAddressList(h.get('reply-to')),
    subject: h.text('subject').trim(), date: parseDate(h.get('date')),
    listUnsubscribe: !!h.get('list-unsubscribe'),
    headers: h,
    text: '', attachments: [],
  };
  if (headersOnly) return base;
  const out = { texts: [], attachments: [] };
  // the whole message is a part too: its headers are the top-level part's
  walk(`${head}\n\n${body}`, out);
  base.text = out.texts.map((t) => t.text.trim()).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  base.attachments = out.attachments;
  return base;
}

// ---------- writing a plain message (a draft, a reply) ----------
const needsWord = (s) => /[^\x09\x0a\x0d\x20-\x7e]/.test(s);       // anything that is not plain ASCII (a line break is fine)
const encodeWord = (s) => (needsWord(s) ? `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s);
const cleanHeader = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();     // a header value can never carry a line break (header injection)
const addr = (a) => (typeof a === 'string' ? a : a.name ? `${encodeWord(cleanHeader(a.name)).includes('=?') ? encodeWord(cleanHeader(a.name)) : `"${cleanHeader(a.name).replace(/(["\\])/g, '\\$1')}"`} <${cleanHeader(a.address)}>` : cleanHeader(a.address));

// { from, to, cc, subject, text, inReplyTo, references, messageId, date, headers } -> Buffer (CRLF, ASCII headers, utf-8 body)
function composeMessage({ from, to = [], cc = [], subject = '', text = '', inReplyTo = '', references = [], messageId, date = new Date(), headers = {} } = {}) {
  const id = messageId || `<${require('node:crypto').randomBytes(12).toString('hex')}@whisperbrain.local>`;
  const lines = [
    `From: ${addr(from)}`,
    to.length ? `To: ${to.map(addr).join(', ')}` : null,
    cc.length ? `Cc: ${cc.map(addr).join(', ')}` : null,
    `Subject: ${encodeWord(cleanHeader(subject))}`,
    `Date: ${new Date(date).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    inReplyTo ? `In-Reply-To: ${cleanHeader(inReplyTo)}` : null,
    (references.length ? `References: ${references.map(cleanHeader).join(' ')}` : null),
    'MIME-Version: 1.0',
    ...Object.entries(headers).map(([k, v]) => `${cleanHeader(k)}: ${encodeWord(cleanHeader(v))}`),
  ].filter(Boolean);
  const body = String(text).replace(/\r?\n/g, '\n').split('\n').join(CRLF);
  const plain = !needsWord(body) && body.split(CRLF).every((l) => l.length <= 900);
  lines.push('Content-Type: text/plain; charset=utf-8');
  if (plain) { lines.push('Content-Transfer-Encoding: 7bit', '', body); return Buffer.from(lines.join(CRLF), 'latin1'); }
  lines.push('Content-Transfer-Encoding: base64', '', (Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g) || []).join(CRLF));
  return Buffer.from(lines.join(CRLF), 'latin1');
}

module.exports = {
  parseMessage, parseHeaders, parseParams, parseAddressList, formatAddress, parseDate, decodeWords, decodeCharset, decodeQuotedPrintable, decodeBase64,
  decodeTransfer, htmlToText, messageIds, composeMessage, base64Size,
};
