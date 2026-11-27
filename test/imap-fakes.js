'use strict';
// Simulated IMAP and SMTP servers for the mail tests: they speak enough of the protocols (as the RFCs describe them) for the clients and
// the IMAP connector to run against: literals both ways, tagged/untagged responses, UIDVALIDITY, CONDSTORE/MODSEQ, MOVE, UIDPLUS, XOAUTH2
// (with and without SASL-IR), STARTTLS (when given a certificate). They prove the code's logic; real servers differ in many details.
const net = require('node:net');
const tls = require('node:tls');

class Lit { constructor(b) { this.b = b; } toString() { return this.b.toString('utf8'); } }
const CRLF = '\r\n';

// "a.pt <x>" style raw message builder
function mail({ id, from = 'Rui <rui@x.pt>', to = 'ana@x.pt', cc = '', subject = 'Contract terms', body = 'hello', refs = [], inReplyTo = '', date = 'Tue, 24 Nov 2026 10:00:00 +0000', extra = [] } = {}) {
  return [
    `From: ${from}`, `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, `Date: ${date}`, `Message-ID: <${id}>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []), ...(refs.length ? [`References: ${refs.map((r) => `<${r}>`).join(' ')}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', ...extra, '', body, '',
  ].join('\n');
}

// ---------- IMAP ----------
function tokenize(parts) {
  const root = []; const stack = [root];
  const push = (t) => stack[stack.length - 1].push(t);
  for (const part of parts) {
    if (Buffer.isBuffer(part)) { push(new Lit(part)); continue; }
    let i = 0;
    while (i < part.length) {
      const c = part[i];
      if (c === ' ') { i++; continue; }
      if (c === '(') { const l = []; push(l); stack.push(l); i++; continue; }
      if (c === ')') { stack.pop(); i++; continue; }
      if (c === '"') { let s = ''; i++; while (part[i] !== '"') { if (part[i] === '\\') i++; s += part[i++]; } i++; push(s); continue; }
      let s = '', depth = 0;
      while (i < part.length && (depth || (part[i] !== ' ' && part[i] !== '(' && part[i] !== ')'))) { if (part[i] === '[') depth++; if (part[i] === ']') depth--; s += part[i++]; }
      push(s);
    }
  }
  return root;
}
const inSet = (set, uid, max) => String(set).split(',').some((r) => { const [a, b] = r.split(':'); const lo = a === '*' ? max : Number(a), hi = b === undefined ? lo : (b === '*' ? max : Number(b)); return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi); });
const headerBlock = (raw) => { const s = raw.toString('latin1'); const i = s.indexOf('\r\n\r\n'); return i < 0 ? s : s.slice(0, i); };
const bodyOf = (raw) => { const s = raw.toString('latin1'); const i = s.indexOf('\r\n\r\n'); return i < 0 ? '' : s.slice(i + 4); };

async function fakeImap({ caps = ['IMAP4rev1', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'SASL-IR', 'ENABLE'], tlsOptions = null, starttls = false } = {}) {
  const g = { user: 'ana@x.pt', pass: 'secret', token: 'tok-1', log: [], boxes: new Map(), caps, appended: [], authFail: 0 };
  const addBox = (name, use = '') => g.boxes.set(name, { name, use, uv: 1, next: 1, modseq: 1, msgs: [] });
  addBox('INBOX'); addBox('Sent', '\\Sent'); addBox('Drafts', '\\Drafts'); addBox('Trash', '\\Trash'); addBox('Archive', '\\Archive');
  g.deliver = (box, raw, { flags = [], date = Date.parse('2026-11-24T10:00:00Z') } = {}) => { const b = g.boxes.get(box); const uid = b.next++; b.msgs.push({ uid, flags: new Set(flags), date, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, CRLF), 'utf8'), modseq: ++b.modseq }); return uid; };
  g.expunge = (box, uid) => { const b = g.boxes.get(box); b.msgs = b.msgs.filter((m) => m.uid !== uid); b.modseq++; };
  g.flag = (box, uid, flags) => { const b = g.boxes.get(box); const m = b.msgs.find((x) => x.uid === uid); flags.forEach((f) => m.flags.add(f)); m.modseq = ++b.modseq; };
  g.resetBox = (box) => { const b = g.boxes.get(box); b.uv++; b.next = 1; b.msgs = []; b.modseq = 1; };   // UIDVALIDITY changes, the uids start again
  g.count = (re) => g.log.filter((l) => re.test(l)).length;

  const handle = (socket) => {
    const st = { buf: Buffer.alloc(0), cmd: null, need: null, authed: false, sel: null, authWait: null };
    const w = (s) => socket.write(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'));
    const box = () => g.boxes.get(st.sel);
    const ok = (tag, text = 'done', code = '') => w(`${tag} OK ${code ? `[${code}] ` : ''}${text}${CRLF}`);

    // ---- searching ----
    const parseCrit = (t, i, b) => {
      const k = String(t[i]).toUpperCase();
      const max = Math.max(0, ...b.msgs.map((m) => m.uid));
      const headersLower = (m) => headerBlock(m.raw).toLowerCase();
      const text = (m) => m.raw.toString('latin1').toLowerCase();
      switch (k) {
        case 'ALL': return [() => true, i + 1];
        case 'DELETED': return [(m) => m.flags.has('\\Deleted'), i + 1];
        case 'UNDELETED': return [(m) => !m.flags.has('\\Deleted'), i + 1];
        case 'NOT': { const [p, n] = parseCrit(t, i + 1, b); return [(m) => !p(m), n]; }
        case 'OR': { const [p, n] = parseCrit(t, i + 1, b); const [q, n2] = parseCrit(t, n, b); return [(m) => p(m) || q(m), n2]; }
        case 'UID': return [(m) => inSet(String(t[i + 1]), m.uid, max), i + 2];
        case 'SINCE': { const d = Date.parse(String(t[i + 1]).replace(/-/g, ' ') + ' UTC'); return [(m) => m.date >= d, i + 2]; }
        case 'HEADER': { const name = String(t[i + 1]).toLowerCase(), v = String(t[i + 2]).toLowerCase(); return [(m) => headerBlock(m.raw).toLowerCase().split('\r\n').some((l) => l.startsWith(`${name}:`) && l.includes(v)), i + 3]; }
        case 'TEXT': case 'X-GM-RAW': { const v = String(t[i + 1]).toLowerCase(); return [(m) => text(m).includes(v), i + 2]; }
        case 'FROM': { const v = String(t[i + 1]).toLowerCase(); return [(m) => headersLower(m).split('\r\n').some((l) => l.startsWith('from:') && l.includes(v)), i + 2]; }
        case 'SUBJECT': { const v = String(t[i + 1]).toLowerCase(); return [(m) => headersLower(m).split('\r\n').some((l) => l.startsWith('subject:') && l.includes(v)), i + 2]; }
        case 'CHARSET': return parseCrit(t, i + 2, b);
        default: throw new Error(`fake IMAP: unsupported search key ${k}`);
      }
    };
    const search = (t, b) => { const preds = []; let i = 0; while (i < t.length) { const [p, n] = parseCrit(t, i, b); preds.push(p); i = n; } return b.msgs.filter((m) => preds.every((p) => p(m))).map((m) => m.uid); };

    // ---- fetching ----
    const section = (m, atom, extra) => {
      const mm = /^BODY(?:\.PEEK)?\[(.*)\](?:<(\d+)\.(\d+)>)?$/i.exec(atom);
      const sec = mm[1].trim().toUpperCase();
      let data;
      if (sec === '') data = m.raw;
      else if (sec === 'TEXT') data = Buffer.from(bodyOf(m.raw), 'latin1');
      else if (sec === 'HEADER') data = Buffer.from(`${headerBlock(m.raw)}\r\n\r\n`, 'latin1');
      else {
        const want = sec.replace(/^HEADER\.FIELDS\s*\(|\)$/g, '').split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
        const lines = []; let keep = false;
        for (const l of headerBlock(m.raw).split('\r\n')) { if (/^[ \t]/.test(l)) { if (keep) lines.push(l); } else { keep = want.includes(l.split(':')[0].toLowerCase()); if (keep) lines.push(l); } }
        data = Buffer.from(`${lines.join(CRLF)}\r\n\r\n`, 'latin1');
      }
      let key = `BODY[${mm[1].trim().toUpperCase()}]`;
      if (mm[2] !== undefined) { data = data.subarray(Number(mm[2]), Number(mm[2]) + Number(mm[3])); key += `<${mm[2]}>`; }
      void extra;
      return { key, data };
    };
    const doFetch = (tag, set, items, changedSince) => {
      const b = box(); const max = Math.max(0, ...b.msgs.map((m) => m.uid));
      const want = items.map((x) => String(x));
      b.msgs.forEach((m, idx) => {
        if (!inSet(set, m.uid, max)) return;
        if (changedSince != null && !(m.modseq > changedSince)) return;
        const out = [Buffer.from(`* ${idx + 1} FETCH (UID ${m.uid}`)];
        for (const it of want) {
          const U = it.toUpperCase();
          if (U === 'FLAGS') out.push(Buffer.from(` FLAGS (${[...m.flags].join(' ')})`));
          else if (U === 'INTERNALDATE') out.push(Buffer.from(` INTERNALDATE "${new Date(m.date).toUTCString().slice(5, 16).replace(/ /g, '-')} ${new Date(m.date).toISOString().slice(11, 19)} +0000"`));
          else if (U === 'RFC822.SIZE') out.push(Buffer.from(` RFC822.SIZE ${m.raw.length}`));
          else if (U.startsWith('BODY')) { const { key, data } = section(m, it); out.push(Buffer.from(` ${key} {${data.length}}${CRLF}`), data); }
        }
        if (changedSince != null) out.push(Buffer.from(` MODSEQ (${m.modseq})`));
        out.push(Buffer.from(`)${CRLF}`));
        w(Buffer.concat(out));
      });
      ok(tag, 'FETCH completed');
    };

    const authSasl = (tag, b64) => {
      const [u, a] = Buffer.from(b64 || '', 'base64').toString().split('\x01');
      if (u === `user=${g.user}` && a === `auth=Bearer ${g.token}`) { st.authed = true; return ok(tag, 'Authenticated', 'CAPABILITY IMAP4rev1 UIDPLUS MOVE CONDSTORE'); }
      st.authWait = tag;
      w(`+ ${Buffer.from(JSON.stringify({ status: '401', schemes: 'Bearer', scope: 'x' })).toString('base64')}${CRLF}`);
    };

    const run = (cmd) => {
      const t = tokenize(cmd.parts);
      const tag = t[0]; let name = String(t[1]).toUpperCase(); let args = t.slice(2);
      g.log.push(cmd.parts.map((p) => (Buffer.isBuffer(p) ? `<${p.length} bytes>` : p)).join('').replace(/^A\d+ /, '').slice(0, 300));
      if (name === 'UID') { name = `UID ${String(args[0]).toUpperCase()}`; args = args.slice(1); }
      if (name === 'LOGIN') {
        if (String(args[0]) === g.user && String(args[1]) === g.pass) { st.authed = true; return ok(tag, 'Logged in'); }
        g.authFail++;
        return w(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${CRLF}`);
      }
      if (name === 'CAPABILITY') { w(`* CAPABILITY ${g.caps.join(' ')}${starttls && !st.tls ? ' STARTTLS' : ''}${CRLF}`); return ok(tag, 'CAPABILITY completed'); }
      if (name === 'STARTTLS') {
        ok(tag, 'Begin TLS negotiation now');
        const upgraded = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(tlsOptions) });
        socket.removeAllListeners('data');
        st.tls = true; st.buf = Buffer.alloc(0);
        upgraded.on('data', (d) => { st.buf = Buffer.concat([st.buf, d]); feed(); });
        upgraded.on('error', () => {});
        st.out = upgraded;
        return;
      }
      if (name === 'AUTHENTICATE') {
        if (String(args[0]).toUpperCase() !== 'XOAUTH2' || !g.caps.includes('AUTH=XOAUTH2')) { /* still allowed in the fake */ }
        if (args[1] !== undefined) return authSasl(tag, String(args[1]));
        st.saslTag = tag; w(`+ ${CRLF}`); st.authWait = 'sasl'; return;
      }
      if (name === 'NOOP') return ok(tag, 'NOOP completed');
      if (name === 'LOGOUT') { w(`* BYE bye${CRLF}`); ok(tag, 'LOGOUT completed'); return socket.end(); }
      if (!st.authed) return w(`${tag} BAD not authenticated${CRLF}`);
      if (name === 'LIST') { for (const b of g.boxes.values()) w(`* LIST (${b.use ? `${b.use} ` : ''}\\HasNoChildren) "/" "${b.name}"${CRLF}`); return ok(tag, 'LIST completed'); }
      if (name === 'SELECT' || name === 'EXAMINE') {
        const b = g.boxes.get(String(args[0]));
        if (!b) return w(`${tag} NO [NONEXISTENT] Unknown Mailbox${CRLF}`);
        st.sel = b.name;
        w(`* ${b.msgs.length} EXISTS${CRLF}* OK [UIDVALIDITY ${b.uv}] UIDs valid${CRLF}* OK [UIDNEXT ${b.next}] Predicted next UID${CRLF}`);
        if (g.caps.includes('CONDSTORE')) w(`* OK [HIGHESTMODSEQ ${b.modseq}] Highest${CRLF}`); else w(`* OK [NOMODSEQ] no modseq${CRLF}`);
        return ok(tag, `${name} completed`, name === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY');
      }
      if (!st.sel && name !== 'APPEND') return w(`${tag} BAD no mailbox selected${CRLF}`);
      if (name === 'UID SEARCH') { const ids = search(args, box()); w(`* SEARCH${ids.map((u) => ` ${u}`).join('')}${CRLF}`); return ok(tag, 'SEARCH completed'); }
      if (name === 'UID FETCH') {
        const items = Array.isArray(args[1]) ? args[1] : [args[1]];
        const cs = Array.isArray(args[2]) && String(args[2][0]).toUpperCase() === 'CHANGEDSINCE' ? Number(args[2][1]) : null;
        return doFetch(tag, String(args[0]), items, cs);
      }
      if (name === 'UID STORE') {
        const b = box(); const max = Math.max(0, ...b.msgs.map((m) => m.uid));
        const mode = String(args[1]).toUpperCase(); const flags = (Array.isArray(args[2]) ? args[2] : [args[2]]).map(String);
        for (const m of b.msgs) if (inSet(String(args[0]), m.uid, max)) {
          if (mode.startsWith('+')) flags.forEach((f) => m.flags.add(f)); else if (mode.startsWith('-')) flags.forEach((f) => m.flags.delete(f)); else m.flags = new Set(flags);
          m.modseq = ++b.modseq;
        }
        return ok(tag, 'STORE completed');
      }
      if (name === 'UID COPY' || name === 'UID MOVE') {
        const b = box(); const dest = g.boxes.get(String(args[1]));
        if (!dest) return w(`${tag} NO [TRYCREATE] no such mailbox${CRLF}`);
        if (name === 'UID MOVE' && !g.caps.includes('MOVE')) return w(`${tag} BAD MOVE not supported${CRLF}`);
        const max = Math.max(0, ...b.msgs.map((m) => m.uid)); const from = [], to = [];
        for (const m of [...b.msgs]) if (inSet(String(args[0]), m.uid, max)) { from.push(m.uid); to.push(g.deliver(dest.name, m.raw, { flags: [...m.flags], date: m.date })); if (name === 'UID MOVE') g.expunge(b.name, m.uid); }
        return ok(tag, `${name === 'UID MOVE' ? 'MOVE' : 'COPY'} completed`, `COPYUID ${dest.uv} ${from.join(',')} ${to.join(',')}`);
      }
      if (name === 'UID EXPUNGE' || name === 'EXPUNGE') {
        const b = box(); const max = Math.max(0, ...b.msgs.map((m) => m.uid));
        for (const m of [...b.msgs]) if (m.flags.has('\\Deleted') && (name === 'EXPUNGE' || inSet(String(args[0]), m.uid, max))) g.expunge(b.name, m.uid);
        return ok(tag, 'EXPUNGE completed');
      }
      if (name === 'APPEND') {
        const b = g.boxes.get(String(args[0]));
        if (!b) return w(`${tag} NO [TRYCREATE] no such mailbox${CRLF}`);
        const lit = args[args.length - 1];
        const flags = Array.isArray(args[1]) ? args[1].map(String) : [];
        const uid = g.deliver(b.name, lit.b, { flags });
        g.appended.push({ box: b.name, flags, raw: lit.b });
        return ok(tag, 'APPEND completed', `APPENDUID ${b.uv} ${uid}`);
      }
      w(`${tag} BAD unknown command ${name}${CRLF}`);
    };

    function feed() {
      for (;;) {
        if (st.need != null) { if (st.buf.length < st.need) return; st.cmd.parts.push(st.buf.subarray(0, st.need)); st.buf = st.buf.subarray(st.need); st.need = null; }
        const idx = st.buf.indexOf(CRLF);
        if (idx < 0) return;
        const line = st.buf.toString('latin1', 0, idx);
        st.buf = st.buf.subarray(idx + 2);
        if (st.authWait) {
          const wait = st.authWait; st.authWait = null;
          if (wait === 'sasl') { authSasl(st.saslTag, line); continue; }
          g.authFail++; w(`${wait} NO [AUTHENTICATIONFAILED] Invalid credentials${CRLF}`); continue;
        }
        st.cmd ||= { parts: [] };
        const m = /\{(\d+)(\+)?\}$/.exec(line);
        if (m) { st.cmd.parts.push(line.slice(0, m.index)); st.need = Number(m[1]); if (!m[2]) w(`+ Ready for literal data${CRLF}`); continue; }
        st.cmd.parts.push(line);
        const cmd = st.cmd; st.cmd = null;
        try { run(cmd); } catch (e) { w(`${String(cmd.parts[0]).split(' ')[0]} BAD ${e.message}${CRLF}`); }
      }
    }
    const write0 = socket.write.bind(socket);
    // after STARTTLS, replies go out on the TLS socket
    socket.write = (d) => (st.out ? st.out.write(d) : write0(d));
    socket.on('data', (d) => { st.buf = Buffer.concat([st.buf, d]); feed(); });
    socket.on('error', () => {});
    w(`* OK [CAPABILITY ${g.caps.join(' ')}${starttls ? ' STARTTLS' : ''}] fake IMAP ready${CRLF}`);
  };

  const server = tlsOptions && !starttls ? tls.createServer(tlsOptions, handle) : net.createServer(handle);
  g.sockets = new Set();
  server.on('connection', (s) => { g.sockets.add(s); s.on('close', () => g.sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.port = server.address().port;
  g.close = () => new Promise((r) => { for (const s of g.sockets) s.destroy(); server.close(r); });
  return g;
}

// ---------- SMTP ----------
async function fakeSmtp({ user = 'ana@x.pt', pass = 'secret', token = 'tok-1', tlsOptions = null, starttls = false, auth = ['PLAIN', 'LOGIN', 'XOAUTH2'] } = {}) {
  const g = { mails: [], log: [], authFail: 0 };
  const handle = (socket) => {
    const st = { buf: '', data: null, authed: false, from: '', to: [], tls: false, step: null };
    let out = socket;
    const w = (s) => out.write(`${s}${CRLF}`);
    const onData = (d) => { st.buf += d.toString('latin1'); loop(); };
    const loop = () => {
      for (;;) {
        if (st.data !== null) {
          const end = st.buf.indexOf(`${CRLF}.${CRLF}`);
          if (end < 0) return;
          const raw = `${st.buf.slice(0, end)}${CRLF}`;
          st.buf = st.buf.slice(end + 5);
          g.mails.push({ from: st.from, to: st.to, data: raw.replace(/^\.\./gm, '.'), rawStuffed: raw });
          st.data = null; st.from = ''; st.to = [];
          w('250 2.0.0 queued as FAKE1'); continue;
        }
        const i = st.buf.indexOf(CRLF);
        if (i < 0) return;
        const line = st.buf.slice(0, i); st.buf = st.buf.slice(i + 2);
        g.log.push(line.startsWith('AUTH') ? line.split(' ').slice(0, 2).join(' ') : line);
        if (st.step === 'login-user') { st.step = 'login-pass'; w('334 UGFzc3dvcmQ6'); continue; }
        if (st.step === 'login-pass') { st.step = null; st.authed = Buffer.from(line, 'base64').toString() === pass; if (!st.authed) g.authFail++; w(st.authed ? '235 2.7.0 ok' : '535 5.7.8 bad credentials'); continue; }
        if (st.step === 'xoauth-err') { st.step = null; g.authFail++; w('535 5.7.8 token rejected'); continue; }
        const [cmd, ...rest] = line.split(' ');
        const C = cmd.toUpperCase();
        if (C === 'EHLO') { w('250-fake.smtp'); if (starttls && !st.tls) w('250-STARTTLS'); w(`250-AUTH ${auth.join(' ')}`); w('250 SIZE 10485760'); }
        else if (C === 'STARTTLS') {
          w('220 go ahead');
          const up = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(tlsOptions) });
          socket.removeAllListeners('data'); up.on('data', onData); up.on('error', () => {}); out = up; st.tls = true; st.buf = '';
        } else if (C === 'AUTH') {
          const mech = (rest[0] || '').toUpperCase();
          if (mech === 'PLAIN') { st.authed = Buffer.from(rest[1] || '', 'base64').toString() === `\0${user}\0${pass}`; if (!st.authed) g.authFail++; w(st.authed ? '235 2.7.0 ok' : '535 5.7.8 bad credentials'); }
          else if (mech === 'LOGIN') { st.step = 'login-user'; w('334 VXNlcm5hbWU6'); }
          else if (mech === 'XOAUTH2') {
            const [u, a] = Buffer.from(rest[1] || '', 'base64').toString().split('\x01');
            if (u === `user=${user}` && a === `auth=Bearer ${token}`) { st.authed = true; w('235 2.7.0 ok'); } else { st.step = 'xoauth-err'; w(`334 ${Buffer.from('{"status":"401"}').toString('base64')}`); }
          } else w('504 unknown mechanism');
        } else if (C === 'MAIL') { st.from = /<([^>]*)>/.exec(line)?.[1] || ''; w('250 ok'); }
        else if (C === 'RCPT') { const a = /<([^>]*)>/.exec(line)?.[1] || ''; if (a.includes('refused')) w('550 5.1.1 no such user'); else { st.to.push(a); w('250 ok'); } }
        else if (C === 'DATA') { if (!st.authed && user) { w('530 5.7.0 authentication required'); continue; } st.data = ''; w('354 end with <CRLF>.<CRLF>'); }
        else if (C === 'RSET') w('250 ok');
        else if (C === 'QUIT') { w('221 bye'); socket.end(); }
        else w(`500 unknown ${cmd}`);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    w('220 fake.smtp ESMTP');
  };
  const server = tlsOptions && !starttls ? tls.createServer(tlsOptions, handle) : net.createServer(handle);
  g.sockets = new Set();
  server.on('connection', (s) => { g.sockets.add(s); s.on('close', () => g.sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.port = server.address().port;
  g.close = () => new Promise((r) => { for (const s of g.sockets) s.destroy(); server.close(r); });
  return g;
}

// a throwaway self-signed certificate (needs the openssl command; the TLS tests are skipped without it)
function selfSigned() {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { fakeImap, fakeSmtp, mail, selfSigned };
