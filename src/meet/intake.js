'use strict';
// A small server for the browser extension. It is not the app's API: it listens on a port of its own (the extension has
// to know where to find it, and the app's main port changes on every start), and its token opens only this door:
// "here is what the meeting window shows". The app's own token is never given to an extension.
const http = require('node:http');
const crypto = require('node:crypto');
const { SignalError } = require('./protocol');

const DEFAULT_PORT = 47631;
const MAX_BODY = 256 * 1024;
const MAX_MESSAGES = 200;
const MAX_AUDIO = 128 * 1024;   // one chunk of the tab's audio: a few hundred ms of 16 kHz mono, not a file
// Only extensions may call, never a web page: a page knowing the token is not enough.
const EXTENSION_ORIGIN = /^(?:chrome|moz|ms-browser)-extension:\/\/[\w-]+$/;

const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// getToken(): the pairing secret ('' = refuse everything). info(): { version, recording } for the hello reply.
// onAudio({ pcm, endMs }) -> { ok, reason? }: the call's browser tab streaming its audio (16 kHz mono s16le) for the recording in progress.
function createIntake({ hub, getToken, info = () => ({}), onAudio = null }) {
  let port = 0;
  const hostOk = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;

  function cors(req, res) {
    const o = req.headers.origin;
    if (o && EXTENSION_ORIGIN.test(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-wb-signal-token, x-wb-source, x-wb-end');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
    }
  }

  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 }); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  async function raw(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_AUDIO) throw Object.assign(new Error('audio chunk too large'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  async function handle(req, res) {
    try {
      if (!hostOk(req.headers.host)) return send(res, 403, { error: 'bad host' });
      const origin = req.headers.origin;
      if (origin && !EXTENSION_ORIGIN.test(origin)) return send(res, 403, { error: 'only a browser extension may call this' });
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const token = getToken();
      const given = req.headers['x-wb-signal-token'] || /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
      const paired = !!token && !!given && safeEqual(given, token);
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/meet/hello') return send(res, 200, { app: 'whisperbrain', paired, ...(paired ? info() : {}) });
      if (!paired) return send(res, 401, { error: 'not paired' });
      if (req.method === 'POST' && url.pathname === '/meet/signals') {
        const b = await body(req);
        const list = Array.isArray(b.messages) ? b.messages : [b];
        if (list.length > MAX_MESSAGES) return send(res, 413, { error: 'too many messages' });
        const source = String(req.headers['x-wb-source'] || 'extension').replace(/[^\w-]/g, '').slice(0, 24) || 'extension';
        let accepted = 0, rejected = 0;
        for (const m of list) { try { hub.ingest(m, { source, kind: 'extension' }); accepted++; } catch (e) { if (e instanceof SignalError) rejected++; else throw e; } }
        return send(res, 200, { accepted, rejected, ...info() });
      }
      if (req.method === 'POST' && url.pathname === '/meet/audio') {
        if (!onAudio) return send(res, 404, { error: 'not found' });
        if (!info().recording) return send(res, 409, { error: 'no recording is on' });
        const pcm = await raw(req);
        if (!pcm.length || pcm.length % 2) return send(res, 400, { error: 'audio is 16-bit samples' });
        const endMs = Number(req.headers['x-wb-end']);
        const r = onAudio({ pcm, endMs: Number.isFinite(endMs) && endMs > 0 ? endMs : Date.now() }) || { ok: false, reason: 'refused' };
        return send(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: r.reason === 'not recording' ? 'no recording is on' : r.reason });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return {
    server,
    get port() { return port; },
    // Tries the wanted port, then the next few: another program may hold it. -> the port, or throws
    async listen(wanted = DEFAULT_PORT, tries = 8) {
      for (let i = 0; i < tries; i++) {
        const p = wanted === 0 ? 0 : wanted + i;
        try {
          await new Promise((resolve, reject) => { const onErr = (e) => { server.off('listening', onOk); reject(e); }; const onOk = () => { server.off('error', onErr); resolve(); }; server.once('error', onErr); server.once('listening', onOk); server.listen(p, '127.0.0.1'); });
          port = server.address().port;
          return port;
        } catch (e) { if (e.code !== 'EADDRINUSE' || wanted === 0) throw e; }
      }
      throw new Error(`no free port from ${wanted}`);
    },
    close() { return new Promise((r) => { if (!server.listening) return r(); server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}

module.exports = { createIntake, DEFAULT_PORT, EXTENSION_ORIGIN };
