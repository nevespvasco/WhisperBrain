'use strict';
// A small IMAP client over node:net / node:tls with no dependencies (RFC 3501, with the extensions that matter for reading mail
// safely: UIDPLUS, MOVE, CONDSTORE/MODSEQ, SASL-IR, LITERAL+, and XOAUTH2 for Microsoft/Google accounts). It does what the mail
// connector needs: connect (TLS, or plain + STARTTLS), LOGIN or AUTHENTICATE XOAUTH2, LIST, SELECT / EXAMINE, UID SEARCH, UID FETCH
// (headers only, text, or the whole message, always BODY.PEEK so nothing is marked read), UID STORE, UID COPY / MOVE, APPEND (a draft)
// and EXPUNGE. One command runs at a time; a command that does not finish in `timeoutMs` ends the connection.
//
// UNVERIFIED against real servers (Dovecot, Cyrus, Exchange, Gmail, iCloud): written from the RFCs and tested against a simulated
// server (test/imap.test.js). Read docs/access-mail.md.
const net = require('node:net');
const tls = require('node:tls');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT = 30_000;
const isLoopback = (host) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(String(host));

// ---------- sockets (also used by the SMTP client) ----------
function openSocket({ host, port, tls: secure = true, rejectUnauthorized = true, ca, timeoutMs = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized, ca })
      : net.connect({ host, port });
    const t = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error(`Cannot reach ${host}:${port} (timed out).`), { code: 'timeout' })); }, timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); socket.setNoDelay?.(true); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(t); reject(Object.assign(new Error(`Cannot reach ${host}:${port} (${e.code || e.message}).`), { code: 'unreachable' })); });
  });
}
// upgrade a connected plain socket to TLS (STARTTLS)
function startTls(socket, { host, rejectUnauthorized = true, ca }) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized, ca });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', (e) => reject(Object.assign(new Error(`TLS failed (${e.code || e.message}).`), { code: 'tls' })));
  });
}

// ---------- modified UTF-7 (mailbox names) ----------
function decodeMailbox(s) {
  return String(s).replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return '&';
    const bytes = Buffer.from(b.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}
function encodeMailbox(s) {
  let out = '', run = '';
  const flush = () => {
    if (!run) return;
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`; run = '';
  };
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) { flush(); out += ch === '&' ? '&-' : ch; } else run += ch;
  }
  flush();
  return out;
}

// ---------- building commands ----------
// a string as an IMAP argument: a quoted string when it is plain ASCII, else a literal (a Buffer, sent after the server says "+")
function qs(s) {
  const str = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(str)) return `"${str.replace(/(["\\])/g, '\\$1')}"`;
  return Buffer.from(str, 'utf8');
}
const mailboxArg = (name) => qs(encodeMailbox(name));
// [1,2,3,7] -> "1:3,7"
function uidSet(uids) {
  const u = [...new Set(uids)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < u.length;) { let j = i; while (j + 1 < u.length && u[j + 1] === u[j] + 1) j++; out.push(j > i ? `${u[i]}:${u[j]}` : String(u[i])); i = j + 1; }
  return out.join(',');
}
// "1:3,7" -> [1,2,3,7]
const parseUidSet = (s) => String(s || '').split(',').filter(Boolean).flatMap((r) => { const [a, b] = r.split(':').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; });

// ---------- reading responses ----------
// One response (a line, with the literals inside it) off the front of buf -> { segments: [string | Buffer], used } | null when not complete yet.
// segments alternate text and literal: 'FETCH (BODY[TEXT] ', <Buffer>, ')'.
function takeResponse(buf) {
  const segments = [];
  let pos = 0;
  for (;;) {
    const idx = buf.indexOf(CRLF, pos);
    if (idx < 0) return null;
    const line = buf.toString('latin1', pos, idx);
    const m = /\{(\d+)\+?\}$/.exec(line);
    if (!m) { segments.push(line); return { segments, used: idx + 2 }; }
    const need = idx + 2 + Number(m[1]);
    if (buf.length < need) return null;
    segments.push(line.slice(0, m.index), buf.subarray(idx + 2, need));
    pos = need;
  }
}

// a reader over the segments: atoms, quoted strings, literals, NIL, (lists)
class Reader {
  constructor(segments) { this.seg = segments; this.i = 0; this.p = 0; }
  get text() { return typeof this.seg[this.i] === 'string' ? this.seg[this.i] : ''; }
  atEnd() { return this.i >= this.seg.length - 1 && this.p >= this.text.length; }
  skip() { while (this.p < this.text.length && this.text[this.p] === ' ') this.p++; }
  peek() { this.skip(); return this.text[this.p]; }
  // the text left on the current segment, as is
  rest() { const r = this.text.slice(this.p); this.p = this.text.length; return r; }
  next() {
    this.skip();
    const t = this.text;
    if (this.p >= t.length) {                                                 // the text of this segment is used up: a literal may follow
      const lit = this.seg[this.i + 1];
      if (Buffer.isBuffer(lit)) { this.i += 2; this.p = 0; return lit; }
      return undefined;
    }
    const c = t[this.p];
    if (c === '(') { this.p++; const list = []; for (;;) { const ch = this.peek(); if (ch === ')') { this.p++; return list; } if (ch === undefined && !Buffer.isBuffer(this.seg[this.i + 1])) return list; list.push(this.next()); } }
    if (c === '"') {
      let out = ''; this.p++;
      while (this.p < t.length && t[this.p] !== '"') { if (t[this.p] === '\\') this.p++; out += t[this.p++]; }
      this.p++;
      return out;
    }
    let start = this.p, depth = 0, quote = false;
    while (this.p < t.length) {
      const ch = t[this.p];
      if (quote) { if (ch === '"') quote = false; this.p++; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
      else if (depth && ch === '"') { quote = true; this.p++; continue; }
      else if (!depth && (ch === ' ' || ch === '(' || ch === ')')) break;
      this.p++;
    }
    const atom = t.slice(start, this.p);
    return atom.toUpperCase() === 'NIL' ? null : atom;
  }
}

// "[UIDVALIDITY 3]" at the start of text -> { code: { name, value, args }, text }
function parseCode(text) {
  const m = /^\s*\[([^\]]*)\]\s*(.*)$/s.exec(text || '');
  if (!m) return { code: null, text: String(text || '').trim() };
  const [name, ...args] = m[1].split(' ');
  return { code: { name: name.toUpperCase(), args, value: args[0] !== undefined && /^\d+$/.test(args[0]) ? Number(args[0]) : args[0] }, text: m[2].trim() };
}

function parseResponse(segments) {
  const r = new Reader(segments);
  const first = r.next();
  if (first === '+') return { tag: '+', text: r.rest().trim() };
  if (first === '*') {
    let kind = r.next(), num = null;
    if (/^\d+$/.test(String(kind))) { num = Number(kind); kind = r.next(); }
    kind = String(kind || '').toUpperCase();
    if (['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'].includes(kind)) return { tag: '*', kind, ...parseCode(r.rest()) };
    return { tag: '*', kind, num, reader: r };
  }
  const status = String(r.next() || '').toUpperCase();
  return { tag: first, status, ...parseCode(r.rest()) };
}

// the attributes of one untagged FETCH (the list after the message number) -> a message
function fetchResult(reader, seq) {
  const list = reader.next();
  const out = { seq, uid: null, flags: [], internalDate: null, size: null, modseq: null, sections: new Map() };
  for (let i = 0; Array.isArray(list) && i < list.length; i += 2) {
    const key = String(list[i]).toUpperCase(), val = list[i + 1];
    if (key === 'UID') out.uid = Number(val);
    else if (key === 'FLAGS') out.flags = (val || []).map(String);
    else if (key === 'INTERNALDATE') out.internalDate = Date.parse(String(val).replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$1 $2 $3')) || null;
    else if (key === 'RFC822.SIZE') out.size = Number(val);
    else if (key === 'MODSEQ') out.modseq = Number(Array.isArray(val) ? val[0] : val);
    else if (key.startsWith('BODY[')) out.sections.set(key.replace(/<\d+>$/, ''), Buffer.isBuffer(val) ? val : Buffer.from(String(val ?? ''), 'latin1'));
  }
  // the common ones by name
  for (const [k, v] of out.sections) { if (k.startsWith('BODY[HEADER')) out.headers = v; else if (k === 'BODY[TEXT]') out.text = v; else if (k === 'BODY[]') out.raw = v; }
  return out;
}

class ImapClient {
  // host, port (993), tls (true: implicit TLS; false: plain, then STARTTLS when the server offers it), user, password,
  // authMethod: 'password' | 'xoauth2' (with accessToken), starttls: 'auto' | 'never', rejectUnauthorized, allowPlaintext: true to
  // send the password over a connection that is neither TLS nor loopback (not recommended)
  constructor(opts = {}) {
    this.opts = { port: 993, tls: true, authMethod: 'password', starttls: 'auto', rejectUnauthorized: true, timeoutMs: DEFAULT_TIMEOUT, ...opts };
    this.caps = new Set();
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.cur = null;
    this.chain = Promise.resolve();
    this.selected = null;
    this.closed = false;
  }

  // ---- connection ----
  attach(socket) {
    this.socket = socket;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    socket.on('error', (e) => this.fail(Object.assign(new Error(`IMAP connection error (${e.code || e.message}).`), { code: 'unreachable' })));
    socket.on('close', () => { this.closed = true; this.fail(Object.assign(new Error('IMAP connection closed.'), { code: 'closed' })); });
  }
  fail(err) { const c = this.cur; if (c) { this.cur = null; clearTimeout(c.timer); c.reject(err); } this.pendingGreeting?.reject(err); }
  pump() {
    for (;;) {
      const r = takeResponse(this.buf);
      if (!r) return;
      this.buf = this.buf.subarray(r.used);
      let resp;
      try { resp = parseResponse(r.segments); } catch (e) { this.fail(e); return; }
      this.dispatch(resp);
    }
  }
  dispatch(resp) {
    if (this.pendingGreeting) { const g = this.pendingGreeting; this.pendingGreeting = null; g.resolve(resp); return; }
    const c = this.cur;
    if (!c) { if (resp.kind === 'BYE') this.closed = true; return; }
    if (resp.tag === '+') { c.onContinue(resp.text); return; }
    if (resp.tag === '*') { c.untagged.push(resp); return; }
    if (resp.tag === c.tag) {
      this.cur = null; clearTimeout(c.timer);
      if (resp.status === 'OK') return c.resolve({ ...resp, untagged: c.untagged });
      c.reject(Object.assign(new Error(`IMAP ${c.name}: ${resp.text || resp.status}`), { imap: { status: resp.status, code: resp.code?.name }, code: /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(`${resp.code?.name} ${resp.text}`) && ['LOGIN', 'AUTHENTICATE'].includes(c.name) ? 'imap-auth' : 'imap' }));
    }
  }

  async connect() {
    const { host, port, rejectUnauthorized, timeoutMs, ca } = this.opts;
    const socket = await openSocket({ host, port, tls: this.opts.tls, rejectUnauthorized, ca, timeoutMs });
    const greeting = new Promise((resolve, reject) => { this.pendingGreeting = { resolve, reject }; setTimeout(() => reject(new Error('IMAP server did not greet in time.')), timeoutMs).unref?.(); });
    this.attach(socket);
    const g = await greeting;
    if (g.kind === 'BYE' || g.kind === 'NO') throw new Error(`IMAP server refused the connection: ${g.text}`);
    if (g.code?.name === 'CAPABILITY') this.caps = new Set(g.code.args.map((a) => a.toUpperCase()));
    this.preauth = g.kind === 'PREAUTH';
    if (!this.caps.size) await this.capability();
    if (!this.opts.tls) {
      if (this.caps.has('STARTTLS') && this.opts.starttls !== 'never') {
        await this.command('STARTTLS');
        const plain = this.socket;
        plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error');
        const secure = await startTls(plain, { host, rejectUnauthorized, ca });
        this.attach(secure);
        this.caps = new Set();
        await this.capability();
        this.tlsActive = true;
      } else if (!isLoopback(host) && !this.opts.allowPlaintext) {
        this.close();
        throw Object.assign(new Error('This IMAP server offers no encryption (no TLS, no STARTTLS): not sending the password.'), { code: 'insecure' });
      }
    } else this.tlsActive = true;
    return this;
  }

  // ---- commands ----
  // parts: strings and Buffers (a Buffer is sent as a literal). cont: answers a server challenge that is not a literal request.
  command(name, parts = [], { cont, timeoutMs = this.opts.timeoutMs } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (this.closed || !this.socket || this.socket.destroyed) return reject(Object.assign(new Error('IMAP connection closed.'), { code: 'closed' }));
      const tag = `A${++this.n}`;
      const chunks = [];                         // what to send, in order: text, and a Buffer where a literal goes (the text before it ends in {n})
      let line = `${tag} ${name}`;
      for (const p of parts) {
        if (Buffer.isBuffer(p)) { chunks.push(`${line} {${p.length}}${CRLF}`, p); line = null; } else line = line === null ? ` ${p}` : `${line} ${p}`;
      }
      chunks.push(`${line ?? ''}${CRLF}`);
      let at = 0;
      // send until a literal is next: it waits for the server's "+" (LITERAL+ servers would not need to, but waiting is always allowed)
      const step = () => {
        while (at < chunks.length) {
          const chunk = chunks[at++];
          this.socket.write(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk);
          if (typeof chunk === 'string' && Buffer.isBuffer(chunks[at])) return;
        }
      };
      const c = { tag, name: name.split(' ')[0], untagged: [], resolve, reject, onContinue: null, timer: null };
      c.onContinue = (text) => {
        if (Buffer.isBuffer(chunks[at])) { step(); return; }
        const answer = cont ? cont(text) : null;
        this.socket.write(Buffer.from(`${answer ?? ''}${CRLF}`, 'latin1'));
      };
      c.timer = setTimeout(() => { this.cur = null; this.socket.destroy(); reject(Object.assign(new Error(`IMAP ${c.name} timed out.`), { code: 'timeout' })); }, timeoutMs);
      c.timer.unref?.();
      this.cur = c;
      step();
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async capability() {
    const r = await this.command('CAPABILITY');
    const u = r.untagged.find((x) => x.kind === 'CAPABILITY');
    if (u) { const out = []; for (let a = u.reader.next(); a !== undefined; a = u.reader.next()) out.push(String(a).toUpperCase()); this.caps = new Set(out); }
    return this.caps;
  }

  // LOGIN, or AUTHENTICATE XOAUTH2 with an access token
  async login() {
    if (this.preauth) return;
    const { user, password, authMethod, accessToken } = this.opts;
    if (authMethod === 'xoauth2') {
      const sasl = Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
      const ir = this.caps.has('SASL-IR');
      await this.command('AUTHENTICATE', ir ? ['XOAUTH2', sasl] : ['XOAUTH2'], { cont: (t) => (t ? '' : sasl) });   // a challenge with text is the error report: answer it empty
    } else {
      if (this.caps.has('LOGINDISABLED')) throw Object.assign(new Error('This IMAP server does not allow a password login over this connection.'), { code: 'imap-auth' });
      await this.command('LOGIN', [qs(user), qs(password)]);
    }
    await this.capability();
    return this;
  }

  async list(pattern = '*') {
    const r = await this.command('LIST', [qs(''), qs(pattern)]);
    return r.untagged.filter((x) => x.kind === 'LIST').map((x) => {
      const flags = (x.reader.next() || []).map((f) => String(f));
      const delimiter = x.reader.next();
      const raw = x.reader.next();
      const name = decodeMailbox(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      const specialUse = flags.find((f) => /^\\(Sent|Drafts|Trash|Junk|Archive|All|Flagged)$/i.test(f)) || '';
      return { name, delimiter, flags, specialUse };
    });
  }

  // SELECT (or EXAMINE when readOnly) -> { name, exists, uidValidity, uidNext, highestModSeq }
  async select(mailbox, { readOnly = false } = {}) {
    const cs = this.caps.has('CONDSTORE') ? ['(CONDSTORE)'] : [];
    const r = await this.command(readOnly ? 'EXAMINE' : 'SELECT', [mailboxArg(mailbox), ...cs]);
    const info = { name: mailbox, exists: 0, uidValidity: null, uidNext: null, highestModSeq: null, readOnly };
    for (const u of [...r.untagged, r]) {
      if (u.kind === 'EXISTS') info.exists = u.num;
      if (u.code?.name === 'UIDVALIDITY') info.uidValidity = u.code.value;
      if (u.code?.name === 'UIDNEXT') info.uidNext = u.code.value;
      if (u.code?.name === 'HIGHESTMODSEQ') info.highestModSeq = u.code.value;
    }
    this.selected = info;
    return info;
  }

  // UID SEARCH with criteria pieces (strings, or Buffers from qs()) -> sorted uids
  async search(criteria = ['ALL']) {
    const utf = criteria.some((c) => Buffer.isBuffer(c));
    const r = await this.command('UID SEARCH', [...(utf ? ['CHARSET', 'UTF-8'] : []), ...criteria]);
    const out = [];
    for (const u of r.untagged) if (u.kind === 'SEARCH') for (let a = u.reader.next(); a !== undefined; a = u.reader.next()) if (/^\d+$/.test(String(a))) out.push(Number(a));
    return out.sort((a, b) => a - b);
  }

  // UID FETCH set (items) [(CHANGEDSINCE n)] -> [{ seq, uid, flags, internalDate, size, modseq, sections, headers?, text?, raw? }]
  async fetch(set, items, { changedSince } = {}) {
    if (!set) return [];
    const r = await this.command('UID FETCH', [set, `(${items})`, ...(changedSince != null && this.caps.has('CONDSTORE') ? [`(CHANGEDSINCE ${changedSince})`] : [])]);
    return r.untagged.filter((x) => x.kind === 'FETCH').map((x) => fetchResult(x.reader, x.num)).filter((m) => m.uid != null);
  }

  // UID STORE set +FLAGS.SILENT (\Seen): mode '+FLAGS' | '-FLAGS' | 'FLAGS'
  async store(set, mode, flags) {
    await this.command('UID STORE', [set, `${mode}.SILENT`, `(${flags.join(' ')})`]);
  }
  async copy(set, mailbox) { const r = await this.command('UID COPY', [set, mailboxArg(mailbox)]); return r.code?.name === 'COPYUID' ? { uidValidity: Number(r.code.args[0]), from: r.code.args[1], to: r.code.args[2] } : {}; }
  // MOVE when the server has it; else copy and flag \Deleted (and expunge exactly those uids when UIDPLUS allows, never everything)
  async move(set, mailbox) {
    if (this.caps.has('MOVE')) { await this.command('UID MOVE', [set, mailboxArg(mailbox)]); return { expunged: true }; }
    await this.copy(set, mailbox);
    await this.store(set, '+FLAGS', ['\\Deleted']);
    if (this.caps.has('UIDPLUS')) { await this.command('UID EXPUNGE', [set]); return { expunged: true }; }
    return { expunged: false };                    // left flagged: expunging without UIDPLUS could remove other messages
  }
  async expunge() { await this.command('EXPUNGE'); }

  // APPEND a message (a draft: flags ['\\Draft']) -> { uid, uidValidity } when the server says (UIDPLUS)
  async append(mailbox, message, { flags = [], date } = {}) {
    const raw = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
    const parts = [mailboxArg(mailbox), ...(flags.length ? [`(${flags.join(' ')})`] : []), ...(date ? [`"${new Date(date).toUTCString().slice(5, 16).replace(/ /g, '-')} ${new Date(date).toISOString().slice(11, 19)} +0000"`] : []), raw];
    const r = await this.command('APPEND', parts);
    return r.code?.name === 'APPENDUID' ? { uidValidity: Number(r.code.args[0]), uid: Number(r.code.args[1]) } : {};
  }

  async noop() { await this.command('NOOP'); }
  async logout() { try { await this.command('LOGOUT', [], { timeoutMs: 3000 }); } catch { /* the server hangs up */ } this.close(); }
  close() { this.closed = true; try { this.socket?.destroy(); } catch { /* already gone */ } }
}

module.exports = { ImapClient, openSocket, startTls, qs, uidSet, parseUidSet, encodeMailbox, decodeMailbox, mailboxArg, takeResponse, parseResponse, isLoopback };
