'use strict';
// A simulated Gmail (and Google token endpoint) for tests: follows the documented API, refuses `q` and full bodies under the metadata
// permission like the real one, and records what was created or changed so a test can check it.
const http = require('node:http');
const fs = require('node:fs');
const { createApp } = require('../src/server/app');
const { tmpDir } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const b64 = (s) => Buffer.from(s).toString('base64url');
const mail = (id, from, to, text, { labels = ['INBOX'], cc = '', subject = 'Contract terms', at = Date.parse('2026-11-24T10:00:00Z'), unsubscribe = false } = {}) => ({
  id, labelIds: labels, internalDate: String(at), snippet: `snippet of ${text}`,
  payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to }, ...(cc ? [{ name: 'Cc', value: cc }] : []), { name: 'Date', value: new Date(at).toUTCString() }, { name: 'Subject', value: subject }, ...(unsubscribe ? [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] : [])],
    mimeType: 'text/plain', body: { data: b64(text) } },
});

// A small Gmail. scope: 'readonly' | 'metadata' (then q and format=full are refused, as Google does).
async function fakeGmail({ scope = 'readonly' } = {}) {
  const g = { threads: {}, history: [], historyId: 100, log: [], scope, sendAs: ['ana@x.pt'], pageSize: 100, posts: [], modified: [], attachments: {}, revoked: [], refreshError: null, token: { scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', email: 'work@x.pt' }, labels: [{ id: 'Label_1', name: 'Work' }] };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    g.log.push(`${req.method} ${p}${u.search}`);
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        if (p === '/token' || p === '/revoke') {
          const f = Object.fromEntries(new URLSearchParams(raw));
          if (p === '/revoke') { g.revoked.push(f.token); return send(res, 200, {}); }
          if (f.grant_type === 'refresh_token') return g.refreshError ? send(res, 400, { error: g.refreshError }) : send(res, 200, { access_token: 'at-refreshed', expires_in: 3600 });
          return f.code === 'good' ? send(res, 200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, scope: g.token.scope, id_token: ['e30', Buffer.from(JSON.stringify({ email: g.token.email })).toString('base64url'), 'sig'].join('.') }) : send(res, 400, { error: 'invalid_grant' });
        }
        const body = raw ? JSON.parse(raw) : {};
        g.posts.push({ path: p, body });
        if (p === '/drafts') return send(res, 200, { id: `d${g.posts.length}`, message: { id: 'dm1', threadId: body.message?.threadId } });
        if (p === '/messages/send') return send(res, 200, { id: `sent${g.posts.length}`, threadId: body.threadId || 'newthread' });
        if (p === '/labels') { const l = { id: `Label_${g.labels.length + 1}`, name: body.name }; g.labels.push(l); return send(res, 200, l); }
        const m = /^\/threads\/(\w+)\/modify$/.exec(p);
        if (m) { g.modified.push({ id: m[1], ...body }); return send(res, 200, { id: m[1] }); }
        send(res, 404, { error: { message: 'no such route' } });
      });
      return;
    }
    if (p === '/labels') return send(res, 200, { labels: g.labels });
    const att = /^\/messages\/(\w+)\/attachments\/(\w+)$/.exec(p);
    if (att) return g.attachments[att[2]] ? send(res, 200, { data: g.attachments[att[2]] }) : send(res, 404, { error: { message: 'not found' } });
    if (p === '/profile') return send(res, 200, { emailAddress: 'ana@x.pt', historyId: String(g.historyId), messagesTotal: 9, threadsTotal: Object.keys(g.threads).length });
    if (p === '/settings/sendAs') return g.scope === 'metadata' ? send(res, 403, { error: { message: 'Insufficient Permission' } }) : send(res, 200, { sendAs: g.sendAs.map((e) => ({ sendAsEmail: e })) });
    if (p === '/threads') {
      if (u.searchParams.get('q') && g.scope === 'metadata') return send(res, 403, { error: { message: "Metadata scope does not support 'q' parameter" } });
      const all = Object.keys(g.threads).sort().reverse();
      const start = Number(u.searchParams.get('pageToken') || 0);
      const page = all.slice(start, start + g.pageSize);
      return send(res, 200, { threads: page.map((id) => ({ id })), ...(start + g.pageSize < all.length ? { nextPageToken: String(start + g.pageSize) } : {}) });
    }
    const t = /^\/threads\/(\w+)$/.exec(p);
    if (t) {
      const th = g.threads[t[1]];
      if (!th) return send(res, 404, { error: { message: 'Requested entity was not found.' } });
      const format = u.searchParams.get('format');
      if (format === 'full' && g.scope === 'metadata') return send(res, 403, { error: { message: 'Metadata scope doesn\'t allow format FULL' } });
      if (format === 'metadata') {
        const want = new Set(u.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase()));
        return send(res, 200, { ...th, messages: th.messages.map((m) => ({ ...m, payload: { headers: m.payload.headers.filter((h) => want.has(h.name.toLowerCase())) } })) });
      }
      return send(res, 200, th);
    }
    if (p === '/history') {
      const types = u.searchParams.getAll('historyTypes');
      const start = Number(u.searchParams.get('startHistoryId'));
      if (start < 50) return send(res, 404, { error: { message: 'Requested entity was not found.' } });
      const events = g.history.filter((h) => h.id > start && types.includes(h.type));
      const from = Number(u.searchParams.get('pageToken') || 0);
      const page = events.slice(from, from + 2);
      return send(res, 200, { historyId: String(g.historyId), history: page.map((h) => ({ id: String(h.id), [h.field]: [{ message: { threadId: h.threadId } }] })), ...(from + 2 < events.length ? { nextPageToken: String(from + 2) } : {}) });
    }
    send(res, 404, { error: { message: 'no such route' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.url = `http://127.0.0.1:${server.address().port}`;
  g.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  g.event = (type, threadId) => { g.historyId++; const field = { messageAdded: 'messagesAdded', messageDeleted: 'messagesDeleted', labelAdded: 'labelsAdded', labelRemoved: 'labelsRemoved' }[type]; g.history.push({ id: g.historyId, type, field, threadId }); };
  return g;
}
async function boot(t, g) {
  const dataDir = tmpDir('wb-gmail-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test', connectorOptions: { sleep: async () => {}, google: { gmailBase: `${g.url}/gmail/v1`, tokenUrl: `${g.url}/token`, revokeUrl: `${g.url}/revoke`, builtIn: { clientId: 'c', clientSecret: 's' } } } });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready; await app.runner.stop();
  app.settings.update({ google: { ...app.settings.get('google'), clientId: 'c', clientSecret: 's', refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 3600_000, gmail: true, email: 'ana@x.pt' } });
  return app;
}


module.exports = { fakePlatform, b64, mail, fakeGmail, boot };
