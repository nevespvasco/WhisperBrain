'use strict';
// Outlook, IMAP and .mbox are registered in the app and reachable through the API: their routes, the Access page's view of them,
// revoking, and the mbox grant. (The connectors themselves are tested in outlook.test.js, imap.test.js and mbox.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../src/server/http');
const { boot, fakeGmail } = require('./gmail-fake');
const { MASK } = require('../src/core/settings');
const { ROOT, tmpDir } = require('./helpers');

const serve = async (t, app) => {
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(() => srv.close());
  return async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
};
const mailText = (id, from, subject, body) => `From ${id}@x Tue Nov 24 10:00:00 +0000 2026\nMessage-ID: <${id}@x>\nFrom: ${from}\nTo: ana@x.pt\nSubject: ${subject}\nDate: Tue, 24 Nov 2026 10:00:00 +0000\nContent-Type: text/plain; charset=utf-8\n\n${body}\n\n`;

test('the app knows Outlook and IMAP as services, and an IMAP password is sealed and masked', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  const app = await boot(t, g);
  const call = await serve(t, app);
  const services = (await call('GET', '/api/services')).body.map((s) => s.kind);
  for (const k of ['gmail', 'outlook', 'imap']) assert.ok(services.includes(k), k);
  app.settings.update({ imapAccounts: [{ id: 'a1', label: 'Me', host: 'imap.example.com', port: 993, tls: true, user: 'me@example.com', password: 'hunter2', authMethod: 'password' }] });
  const view = (await call('GET', '/api/settings')).body.imapAccounts[0];
  assert.equal(view.password, MASK);
  assert.equal(app.settings.get('imapAccounts')[0].password, 'hunter2');
  const ov = (await call('GET', '/api/access')).body;
  assert.deepEqual(ov.others.map((o) => [o.kind, o.email]), [['imap', 'me@example.com']]);
  assert.ok(!JSON.stringify(ov).includes('hunter2'), 'the password never reaches the page');
  // Outlook sign-in needs the app id first
  assert.equal((await call('POST', '/api/outlook/connect', {})).status, 400);
  assert.deepEqual((await call('GET', '/api/outlook/status')).body, { configured: false, connected: false, email: '', needsReconnect: false, scopes: [] });
});

test('an .mbox file on this computer becomes a source with the access chosen; a missing file is refused; revoking an IMAP source forgets the password', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  const app = await boot(t, g);
  const call = await serve(t, app);
  const dir = tmpDir('wb-mbox-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Takeout.mbox');
  fs.writeFileSync(file, mailText('1', 'Rui <rui@x.pt>', 'Contract terms', 'the budget is SECRETBODY') + mailText('2', 'HR <hr@corp.pt>', 'Salary', 'private'));
  assert.equal((await call('POST', '/api/sources/mbox', { path: path.join(dir, 'nope.mbox') })).status, 400);
  const r = await call('POST', '/api/sources/mbox', { path: file, grant: { readLevel: 'metadata', filter: { never: { domains: ['corp.pt'] } } } });
  assert.equal(r.status, 200);
  const src = app.items.source(r.body.source);
  assert.equal(src.kind, 'mbox');
  const items = app.items.list({ sourceId: src.id });
  assert.deepEqual(items.map((i) => i.title), ['Contract terms'], 'the never-read sender is left out');
  assert.equal(app.items.item(items[0].id).text, '', 'metadata level: no text');
  assert.ok(!JSON.stringify(app.items.item(items[0].id)).includes('SECRETBODY'));
  // IMAP source + account: revoking with "forget the password" removes the account
  app.settings.update({ imapAccounts: [{ id: 'a1', label: 'Me', host: 'imap.example.com', port: 993, tls: true, user: 'me@example.com', password: 'hunter2', authMethod: 'password' }] });
  const imapSrc = app.items.addSource({ kind: 'imap', name: 'Mail me', mode: 'copy', sensitivity: 'private', config: { remote: true, account: 'a1' }, grant: { readLevel: 'part' } });
  const out = await app.accessCenter.revoke(imapSrc.id, { signOut: true });
  assert.equal(out.signedOut, true);
  assert.deepEqual(app.settings.get('imapAccounts'), []);
});
