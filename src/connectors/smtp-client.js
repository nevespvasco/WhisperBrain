'use strict';
// A small SMTP client (RFC 5321 / 4954 / 3207) with no dependencies, for sending a message the person approved: implicit TLS (port
// 465) or STARTTLS (587), AUTH PLAIN / LOGIN / XOAUTH2, MAIL FROM, RCPT TO, DATA with dot-stuffing. Nothing here decides WHETHER to
// send: only an approved action in the Inbox does (docs/access.md); this is only the wire.
//
// UNVERIFIED against real servers (Gmail, Outlook, Fastmail...): tested against a simulated server (test/imap.test.js).
const { openSocket, startTls, isLoopback } = require('./imap-client');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT = 30_000;
// an address that can go in an SMTP command: no blanks, no angle brackets, no line breaks (so a value cannot add a command of its own)
const SAFE_ADDRESS = /^[^\s<>\r\n"]+@[^\s<>\r\n"]+$/;

class SmtpClient {
  // security: 'tls' (implicit, 465) | 'starttls' (587) | 'none'; authMethod: 'plain' | 'login' | 'xoauth2'
  constructor(opts = {}) {
    this.opts = { port: 587, security: 'starttls', authMethod: 'plain', name: 'whisperbrain.local', rejectUnauthorized: true, timeoutMs: DEFAULT_TIMEOUT, ...opts };
    this.buf = '';
    this.lines = [];
    this.waiter = null;
    this.ext = new Set();
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding('latin1');
    socket.on('data', (d) => { this.buf += d; this.pump(); });
    socket.on('error', (e) => this.fail(new Error(`SMTP connection error (${e.code || e.message}).`)));
    socket.on('close', () => this.fail(Object.assign(new Error('SMTP connection closed.'), { code: 'closed' })));
  }
  fail(err) { if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.reject(err); } else this.failed = err; }
  pump() {
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      this.lines.push(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
    // a reply is complete at the line whose fourth character is a space ("250 OK"); "250-..." lines continue it
    if (this.waiter) {
      const last = this.lines.findIndex((l) => /^\d{3}( |$)/.test(l));
      if (last >= 0) {
        const taken = this.lines.splice(0, last + 1);
        const w = this.waiter; this.waiter = null; clearTimeout(w.timer);
        w.resolve({ code: Number(taken[taken.length - 1].slice(0, 3)), lines: taken.map((l) => l.slice(4)), text: taken.map((l) => l.slice(4)).join('\n') });
      }
    }
  }
  reply() {
    return new Promise((resolve, reject) => {
      if (this.failed) { const e = this.failed; this.failed = null; return reject(e); }
      const timer = setTimeout(() => { this.waiter = null; this.socket.destroy(); reject(Object.assign(new Error('SMTP server did not answer in time.'), { code: 'timeout' })); }, this.opts.timeoutMs);
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
      this.pump();
    });
  }
  async cmd(line, ok = [250]) {
    this.socket.write(`${line}${CRLF}`);
    const r = await this.reply();
    if (!ok.includes(r.code)) throw Object.assign(new Error(`SMTP ${line.split(' ')[0]}: ${r.code} ${r.text}`), { smtp: r.code, permanent: r.code >= 500 });
    return r;
  }

  async ehlo() {
    const r = await this.cmd(`EHLO ${this.opts.name}`);
    this.ext = new Set(r.lines.slice(1).map((l) => l.toUpperCase()));
    this.authMechs = [...this.ext].find((l) => l.startsWith('AUTH '))?.slice(5).split(' ') || [];
    return r;
  }

  async connect() {
    const { host, port, security, rejectUnauthorized, timeoutMs, ca } = this.opts;
    this.attach(await openSocket({ host, port, tls: security === 'tls', rejectUnauthorized, ca, timeoutMs }));
    const hello = await this.reply();
    if (hello.code !== 220) throw new Error(`SMTP server refused the connection: ${hello.code} ${hello.text}`);
    await this.ehlo();
    if (security === 'starttls') {
      if (!this.ext.has('STARTTLS')) { this.close(); throw Object.assign(new Error('This SMTP server does not offer STARTTLS: not sending the password.'), { code: 'insecure' }); }
      await this.cmd('STARTTLS', [220]);
      const plain = this.socket;
      plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error');
      this.buf = ''; this.lines = [];
      this.attach(await startTls(plain, { host, rejectUnauthorized, ca }));
      await this.ehlo();
    } else if (security === 'none' && !isLoopback(host) && !this.opts.allowPlaintext && this.opts.user) {
      this.close();
      throw Object.assign(new Error('This SMTP connection is not encrypted: not sending the password.'), { code: 'insecure' });
    }
    return this;
  }

  async login() {
    const { user, password, authMethod, accessToken } = this.opts;
    if (!user) return this;
    if (authMethod === 'xoauth2') {
      const sasl = Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
      this.socket.write(`AUTH XOAUTH2 ${sasl}${CRLF}`);
      let r = await this.reply();
      if (r.code === 334) { this.socket.write(CRLF); r = await this.reply(); }      // the server's error report: answered empty, then it says no
      if (r.code !== 235) throw Object.assign(new Error(`SMTP login failed: ${r.code} ${r.text}`), { code: 'smtp-auth', permanent: true });
    } else if (authMethod === 'login') {
      await this.cmd('AUTH LOGIN', [334]);
      await this.cmd(Buffer.from(user).toString('base64'), [334]);
      await this.cmd(Buffer.from(password || '').toString('base64'), [235]).catch((e) => { throw Object.assign(e, { code: 'smtp-auth', permanent: true }); });
    } else {
      await this.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password || ''}`).toString('base64')}`, [235]).catch((e) => { throw Object.assign(e, { code: 'smtp-auth', permanent: true }); });
    }
    return this;
  }

  // from: address; to: [addresses]; message: the whole RFC 5322 message (Buffer | string)
  // -> { accepted: [...], rejected: [{ address, reason }], response }
  async send({ from, to, message }) {
    const bad = [from, ...to].find((a) => !SAFE_ADDRESS.test(String(a)));
    if (bad !== undefined) throw Object.assign(new Error(`Not a usable mail address: ${JSON.stringify(String(bad)).slice(0, 80)}`), { code: 'bad-address' });
    await this.cmd(`MAIL FROM:<${from}>`);
    const accepted = [], rejected = [];
    for (const a of to) {
      try { await this.cmd(`RCPT TO:<${a}>`, [250, 251]); accepted.push(a); } catch (e) { if (!e.smtp) throw e; rejected.push({ address: a, reason: e.message }); }
    }
    if (!accepted.length) { await this.cmd('RSET').catch(() => {}); throw Object.assign(new Error('The server refused every recipient.'), { rejected }); }
    await this.cmd('DATA', [354]);
    // CRLF line ends, and a line that starts with a dot gets a second one (RFC 5321 4.5.2), so the message cannot end the data early
    let body = Buffer.from(message).toString('latin1').replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
    if (!body.endsWith(CRLF)) body += CRLF;
    this.socket.write(Buffer.from(`${body}.${CRLF}`, 'latin1'));
    const r = await this.reply();
    if (r.code !== 250) throw Object.assign(new Error(`SMTP DATA: ${r.code} ${r.text}`), { smtp: r.code, permanent: r.code >= 500 });
    return { accepted, rejected, response: r.text };
  }

  async quit() { try { this.socket.write(`QUIT${CRLF}`); } catch { /* gone */ } this.close(); }
  close() { try { this.socket?.destroy(); } catch { /* gone */ } }
}

module.exports = { SmtpClient, SAFE_ADDRESS };
