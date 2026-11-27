'use strict';
// Outlook mail by access level, against a SIMULATED Microsoft Graph that follows the documented API (delta queries per folder with
// @removed, paging, 429 Retry-After, and, like the real one, it refuses body and search under Mail.ReadBasic) and a simulated sign-in
// endpoint. It proves the connector's logic; nothing here ran against a real Microsoft account.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/core/db');
const { ItemStore } = require('../src/items/store');
const outlook = require('../src/connectors/outlook');
const gmail = require('../src/connectors/gmail');
const { RateLimited } = require('../src/connectors/http');

const FOLDERS = { inbox: 'F-inbox', sentitems: 'F-sent', archive: 'F-archive', deleteditems: 'F-deleted', junkemail: 'F-junk', drafts: 'F-drafts' };
const NAMES = { 'F-inbox': 'Inbox', 'F-sent': 'Sent Items', 'F-archive': 'Archive', 'F-deleted': 'Deleted Items', 'F-junk': 'Junk Email', 'F-drafts': 'Drafts' };
const BODY_FIELDS = ['body', 'bodyPreview', 'uniqueBody', 'internetMessageHeaders'];
const addr = (s) => { const m = /^(.*?)\s*<(.+)>$/.exec(s); return { emailAddress: m ? { name: m[1], address: m[2] } : { name: '', address: s } }; };
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

// A small Graph. scope: 'read' | 'basic' (then body, bodyPreview, headers, attachments and $search are refused, as Microsoft does).
async function fakeGraph({ scope = 'read', pageSize = 2, archive = true } = {}) {
  const g = { rev: 1, msgs: [], removals: [], log: [], scope, pageSize, archive, seq: 0, tokens: new Set(['tok-1']), throttle: 0, retryAfter: 1, expireDelta: false, refreshes: 0, badRefresh: false, tokenBodies: [], prefer: new Set() };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  g.add = (m) => { g.rev++; const msg = { id: `AAMk-${++g.seq}`, conversationId: 'c1', subject: 'Contract terms', from: 'Rui <rui@x.pt>', to: ['ana@x.pt'], cc: [], received: '2026-11-24T10:00:00Z', folder: 'F-inbox', categories: [], body: 'hello', headers: [], isDraft: false, attachments: [], ...m, rev: g.rev }; g.msgs.push(msg); return msg; };
  g.update = (msg, patch) => { g.rev++; Object.assign(msg, patch, { rev: g.rev }); };
  g.move = (msg, folder) => { g.rev++; g.removals.push({ folder: msg.folder, id: msg.id, rev: g.rev }); msg.id = `AAMk-${++g.seq}`; msg.folder = folder; msg.rev = g.rev; };   // Graph gives a moved message a new id
  g.remove = (msg) => { g.rev++; g.removals.push({ folder: msg.folder, id: msg.id, rev: g.rev }); g.msgs.splice(g.msgs.indexOf(msg), 1); };
  const project = (m, select) => {
    const all = { id: m.id, conversationId: m.conversationId, subject: m.subject, from: addr(m.from), toRecipients: m.to.map(addr), ccRecipients: m.cc.map(addr), receivedDateTime: m.received, isDraft: m.isDraft, categories: m.categories,
      parentFolderId: m.folder, flag: { flagStatus: 'notFlagged' }, body: { contentType: 'text', content: m.body }, bodyPreview: m.body.slice(0, 80), internetMessageHeaders: m.headers, hasAttachments: m.attachments.length > 0, webLink: `https://outlook.office.com/owa/?ItemID=${encodeURIComponent(m.id)}` };
    return Object.fromEntries(select.map((k) => [k, all[k]]));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      // sign-in endpoint (tenant in the path)
      if (u.pathname.endsWith('/oauth2/v2.0/token')) {
        const f = new URLSearchParams(raw);
        g.tokenBodies.push(Object.fromEntries(f));
        if (f.get('grant_type') === 'refresh_token') {
          g.refreshes++;
          if (g.badRefresh) return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: expired' });
          const t = `tok-${g.refreshes + 1}`; g.tokens.add(t);
          return send(res, 200, { access_token: t, expires_in: 3600, refresh_token: 'refresh-2', scope: g.scope === 'basic' ? 'https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read' : 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read' });
        }
        g.tokens.add('tok-new');
        return send(res, 200, { access_token: 'tok-new', expires_in: 3600, refresh_token: 'refresh-1', scope: 'Mail.Read User.Read openid profile email', id_token: jwt({ preferred_username: 'Ana@Outlook.com' }) });
      }
      g.log.push(`${u.pathname}${u.search}`);
      if (req.headers.prefer) g.prefer.add(req.headers.prefer);
      if (!g.tokens.has((req.headers.authorization || '').replace('Bearer ', ''))) return send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } });
      if (g.throttle > 0) { g.throttle--; return send(res, 429, { error: { code: 'TooManyRequests', message: 'Too many requests' } }, { 'Retry-After': String(g.retryAfter) }); }
      const p = u.pathname.replace(/^\/v1\.0/, '');
      const select = (u.searchParams.get('$select') || 'id').split(',');
      const refuses = g.scope === 'basic' && (select.some((s) => BODY_FIELDS.includes(s)) || (u.searchParams.get('$expand') || '').includes('attachments') || u.searchParams.has('$search'));
      if (refuses && p.startsWith('/me/messages')) return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
      if (p === '/me') return send(res, 200, { mail: 'ana@x.pt', userPrincipalName: 'ana@x.pt', otherMails: [], proxyAddresses: ['SMTP:ana@x.pt', 'smtp:ana.work@x.pt'] });
      let m = /^\/me\/mailFolders\/([^/]+)$/.exec(p);
      if (m) {
        const id = FOLDERS[m[1]] || m[1];
        if (!NAMES[id] || (id === 'F-archive' && !g.archive)) return send(res, 404, { error: { code: 'ErrorFolderNotFound', message: 'The specified folder could not be found in the store.' } });
        return send(res, 200, { id, displayName: NAMES[id], totalItemCount: g.msgs.filter((x) => x.folder === id).length });
      }
      m = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(p);
      if (m) {
        const folder = FOLDERS[m[1]];
        if (g.expireDelta && u.searchParams.has('$deltatoken')) { g.expireDelta = false; return send(res, 410, { error: { code: 'syncStateNotFound', message: 'The sync state generation is not found.' } }); }
        const tok = (u.searchParams.get('$skiptoken') || `0:${u.searchParams.get('$deltatoken') || 0}:`).split(':');
        const [off, since] = tok, sinceDate = tok.slice(2).join(':');
        const start = Number(since), after = sinceDate || (/receivedDateTime ge (\S+)/.exec(u.searchParams.get('$filter') || '')?.[1] || '');
        const changed = g.msgs.filter((x) => x.folder === folder && x.rev > start && (!after || x.received >= after)).map((x) => project(x, select));
        const gone = g.removals.filter((r) => r.folder === folder && r.rev > start && !g.msgs.some((x) => x.folder === folder && x.id === r.id)).map((r) => ({ id: r.id, '@removed': { reason: 'deleted' } }));
        const all = [...changed, ...gone];
        const page = all.slice(Number(off), Number(off) + g.pageSize);
        const base = `http://127.0.0.1:${server.address().port}/v1.0/me/mailFolders/${m[1]}/messages/delta`;
        const next = Number(off) + g.pageSize < all.length;
        return send(res, 200, { value: page, ...(g.evilNext ? { '@odata.nextLink': g.evilNext } : next ? { '@odata.nextLink': `${base}?$skiptoken=${Number(off) + g.pageSize}:${start}:${encodeURIComponent(after)}&$select=${select.join(',')}` } : { '@odata.deltaLink': `${base}?$deltatoken=${g.rev}&$select=${select.join(',')}` }) });
      }
      if (p === '/me/messages') {
        let list = g.msgs;
        const f = /conversationId eq '(.*)'/.exec(u.searchParams.get('$filter') || '');
        if (f) list = list.filter((x) => x.conversationId === f[1].replace(/''/g, "'"));
        const s = u.searchParams.get('$search');
        if (s) { if (u.searchParams.has('$filter') || u.searchParams.has('$orderby')) return send(res, 400, { error: { code: 'BadRequest', message: '$search cannot be combined with $filter or $orderby' } }); const w = s.replace(/"/g, '').toLowerCase(); list = list.filter((x) => `${x.subject} ${x.body}`.toLowerCase().includes(w)); }
        return send(res, 200, { value: list.map((x) => ({ ...project(x, select), ...((u.searchParams.get('$expand') || '').includes('attachments') ? { attachments: x.attachments } : {}) })) });
      }
      send(res, 404, { error: { code: 'ErrorItemNotFound', message: `no such route ${p}` } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.url = `http://127.0.0.1:${server.address().port}`;
  g.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return g;
}

// the settings the app keeps for the sign-in, in memory
function memorySettings(initial = {}) {
  let cfg = { clientId: 'client-1', tenant: 'common', clientSecret: '', refreshToken: 'refresh-1', accessToken: 'tok-1', expiresAt: Date.now() + 3600_000, email: 'ana@x.pt', scopes: ['Mail.Read'], needsReconnect: false, ...initial };
  return { get: () => cfg, update: (p) => { cfg = { ...cfg, ...(p.outlook || {}) }; return cfg; }, read: () => cfg };
}
function setup(g, { settings = {}, grant = { readLevel: 'part' }, config = {} } = {}) {
  const store = new ItemStore(open(':memory:'));
  const mem = memorySettings(settings);
  const auth = new outlook.OutlookAuth({ getConfig: () => mem.read(), saveConfig: (patch) => mem.update({ outlook: patch }), bases: { login: g.url, graph: `${g.url}/v1.0` }, builtIn: {} });
  const src = store.addSource({ kind: 'outlook', name: 'Mail', mode: 'copy', config: { remote: true, ...config }, grant });
  const slept = [];
  const run = (budget) => outlook.sync({ outlook: auth, sleep: async (ms) => { slept.push(ms); }, source: store.source(src.id), items: store, budget });
  return { store, mem, auth, src, run, slept, ctx: { outlook: auth, sleep: async (ms) => { slept.push(ms); }, items: store }, live: () => store.source(src.id) };
}
const ext = (s, id) => s.store.byExternal(s.src.id, `thread:${id}`);

test('permissions per level: ReadBasic for who and when, Mail.Read for a part or everything, write and send only when an action needs them', () => {
  const S = outlook.outlookScopesFor;
  assert.deepEqual(S({ level: 'metadata' }), ['Mail.ReadBasic']);
  assert.deepEqual(S({ level: 'part' }), ['Mail.Read']);
  assert.deepEqual(S({ level: 'all' }), ['Mail.Read']);
  assert.deepEqual(S({ level: 'none' }), []);
  assert.deepEqual(S({ level: 'part', actions: ['outlook.draft'] }), ['Mail.ReadWrite']);
  assert.deepEqual(S({ level: 'metadata', actions: ['outlook.archive'] }), ['Mail.ReadWrite'], 'acting needs to read what it acts on');
  assert.deepEqual(S({ level: 'part', actions: ['outlook.send'] }), ['Mail.Read', 'Mail.Send']);
  assert.deepEqual(S({ level: 'part', actions: ['outlook.draft', 'outlook.send'] }), ['Mail.ReadWrite', 'Mail.Send']);
  assert.ok(!outlook.scopeString({ level: 'metadata' }).includes('Mail.Read '), 'no more than asked');
  assert.ok(outlook.scopeString({ level: 'metadata' }).split(' ').includes('offline_access'));
  assert.equal(outlook.canReadBodies(['Mail.ReadBasic']), false);
  assert.equal(outlook.canReadBodies([]), false, 'nothing recorded is treated as the least');
  assert.equal(outlook.canReadBodies(['https://graph.microsoft.com/Mail.Read']), true, 'Microsoft may answer with the long form');
  assert.equal(outlook.canReadBodies(['Mail.ReadWrite']), true);
  assert.equal(outlook.covers(['Mail.Read'], 'Mail.ReadBasic'), true);
  assert.equal(outlook.covers(['Mail.ReadBasic'], 'Mail.Read'), false);
});

test('the filter: what a delta can take is the date; categories, senders and domains are checked here; never-read is its own list', () => {
  const f = outlook.compileFilter({ days: 30 }, { labels: ['Work'], fromDomains: ['acme.io'], excludeSenders: ['x@y.pt'], never: { domains: ['corp.pt'] } }, { now: Date.parse('2026-11-27T12:00:00Z') });
  assert.equal(f.odata, 'receivedDateTime ge 2026-10-28T12:00:00Z', 'the only thing a delta filters on');
  assert.deepEqual(f.local, { labels: ['Work'], fromDomains: ['acme.io'], excludeSenders: ['x@y.pt'] });
  assert.deepEqual(f.never, { domains: ['corp.pt'] });
  assert.deepEqual(outlook.validate({ folders: ['Sent Items', 'junkemail', 'x'], days: 99999 }), { days: 3650, folders: ['sentitems'] });
  assert.deepEqual(outlook.validate({}), { days: 90, folders: ['inbox', 'sentitems', 'archive'] });
  const m = { id: 'a', from: addr('Dr <dr@clinic.pt>'), toRecipients: [], subject: 'Your lab results', categories: ['Medical'] };
  assert.equal(outlook.neverRead([m], { domains: ['clinic.pt'] }), true);
  assert.equal(outlook.neverRead([m], { keywords: ['LAB RESULTS'] }), true);
  assert.equal(outlook.neverRead([m], { labels: ['medical'] }), true, 'a category');
  assert.equal(outlook.neverRead([m], { senders: ['other@x.pt'] }), false);
});

test('a conversation: Cc counts as people, aliases count as me, quoted Outlook blocks are cut, the item has the same meta as Gmail\'s', () => {
  const mk = (id, from, body, extra = {}) => ({ id, conversationId: 'c1', subject: 'Contract terms', from: addr(from), toRecipients: [addr('ana@x.pt')], ccRecipients: [], receivedDateTime: '2026-11-24T10:00:00Z', categories: [], parentFolderId: 'F-inbox', body: { contentType: 'text', content: body }, internetMessageHeaders: [], ...extra });
  const conv = { id: 'c1', messages: [
    mk('1', 'Rui <rui@x.pt>', 'Can you?', { ccRecipients: [addr('Eva <eva@y.pt>')], internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] }),
    mk('2', 'Ana <ana.work@x.pt>', 'Sim, envio amanhã.\n\nDe: Rui <rui@x.pt>\nEnviado: segunda-feira\nAssunto: x\n\ntexto antigo', { receivedDateTime: '2026-11-24T11:00:00Z', parentFolderId: 'F-sent' }),
    mk('3', 'Ana <ana@x.pt>', 'rascunho', { isDraft: true, receivedDateTime: '2026-11-24T12:00:00Z' }),
  ] };
  const it = outlook.threadItem(conv, new Set(['ana@x.pt', 'ana.work@x.pt']), { account: 'ana@x.pt', folderName: (id) => NAMES[id] });
  assert.ok(it.meta.people.includes('eva@y.pt'));
  assert.equal(it.meta.messages, 2, 'a draft is not part of the conversation');
  assert.equal(it.meta.lastFromMe, true, 'a reply from an alias is from me');
  assert.ok(it.text.includes('Sim, envio amanhã.') && !it.text.includes('texto antigo'));
  assert.equal(it.meta.newsletter, true);
  assert.deepEqual(it.meta.labels.sort(), ['Inbox', 'Sent Items']);
  assert.equal(it.externalId, 'thread:c1');
  const gm = gmail.threadItem({ id: 'abc', historyId: '7', messages: [{ id: '1', labelIds: ['INBOX'], internalDate: '1', payload: { headers: [{ name: 'From', value: 'a@x.pt' }, { name: 'Subject', value: 's' }], mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } } }] }, 'ana@x.pt');
  for (const k of Object.keys(gm.meta)) if (!['historyId', 'gmailThreadId'].includes(k)) assert.ok(k in it.meta, `meta.${k} is in both shapes`);
  assert.deepEqual(Object.keys(gm).sort(), Object.keys(it).sort());
});

test('metadata level: Mail.ReadBasic fields only, no body, no preview, no headers, no search; the part is chosen here by category', async (t) => {
  const g = await fakeGraph({ scope: 'basic' }); t.after(() => g.close());
  g.add({ conversationId: 'c1', body: 'BODYSECRET one', categories: ['Work'], headers: [{ name: 'List-Unsubscribe', value: 'x' }] });
  g.add({ conversationId: 'c2', subject: 'Other', from: 'Eva <eva@y.pt>', body: 'BODYSECRET two' });
  const s = setup(g, { settings: { scopes: ['Mail.ReadBasic'] }, grant: { readLevel: 'metadata', filter: { labels: ['Work'] } } });
  const r = await s.run();
  assert.equal(r.created, 1, 'only the categorised conversation');
  const it = ext(s, 'c1');
  assert.equal(it.text, '');
  assert.equal(it.title, 'Contract terms');
  assert.equal(it.meta.metadataOnly, true);
  assert.equal(it.meta.lastAsksSomething, null);
  assert.equal(it.meta.newsletter, null, 'the List-Unsubscribe header is not seen at this level');
  assert.ok(!JSON.stringify(it).includes('BODYSECRET'), 'no body anywhere');
  assert.ok(g.log.every((l) => !/body|internetMessageHeaders|\$expand|\$search/.test(decodeURIComponent(l))), 'never asks what Mail.ReadBasic forbids');
  assert.ok(g.log.some((l) => /messages\?/.test(l) && decodeURIComponent(l).includes('categories')));
  assert.equal(ext(s, 'c2'), null);
  assert.deepEqual(await outlook.searchLive({ ctx: s.ctx, source: { ...s.live(), liveSearch: true }, query: 'BODYSECRET' }), [], 'no search at the metadata level');
  assert.ok(g.log.every((l) => !l.includes('%24search') && !l.includes('$search')));
});

test('even if the grant says part, what Microsoft really granted wins: ReadBasic means no bodies', async (t) => {
  const g = await fakeGraph({ scope: 'basic' }); t.after(() => g.close());
  g.add({ body: 'BODYSECRET' });
  const s = setup(g, { settings: { scopes: ['Mail.ReadBasic'] }, grant: { readLevel: 'all' } });
  await s.run();
  assert.equal(ext(s, 'c1').text, '');
  assert.ok(g.log.every((l) => !decodeURIComponent(l).includes('body')));
});

test('part level: a conversation is one item across Inbox and Sent Items, aliases come from /me, Deleted Items and Junk are gone, the never-read list is applied here', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', body: 'Can you send the contract?', received: '2026-11-24T10:00:00Z' });
  g.add({ conversationId: 'c1', from: 'Ana <ana.work@x.pt>', to: ['rui@x.pt'], body: 'Sim, envio amanhã.', received: '2026-11-24T11:00:00Z', folder: 'F-sent' });
  g.add({ conversationId: 'c2', subject: 'Binned', body: 'in the bin', folder: 'F-deleted' });
  g.add({ conversationId: 'c3', subject: 'Offer', from: 'HR <hr@corp.pt>', body: 'salary', received: '2026-11-24T09:00:00Z' });
  g.add({ conversationId: 'c4', subject: 'Your lab results', from: 'Rui <rui@x.pt>', body: 'blood', received: '2026-11-24T08:00:00Z' });
  g.add({ conversationId: 'c5', subject: 'Lunch', from: 'Eva <eva@y.pt>', body: 'lunch?', received: '2026-11-24T07:00:00Z', categories: ['Personal'] });
  g.add({ conversationId: 'c6', subject: 'Draft', body: 'wip', isDraft: true, folder: 'F-drafts' });
  const s = setup(g, { grant: { readLevel: 'part', filter: { never: { domains: ['corp.pt'], keywords: ['lab results'] }, excludeSenders: ['spam@z.pt'] } } });
  const r = await s.run();
  assert.equal(r.errors, 0);
  const c1 = ext(s, 'c1');
  assert.equal(c1.meta.messages, 2);
  assert.equal(c1.meta.lastFromMe, true, 'the reply was sent from an alias listed by /me');
  assert.ok(c1.text.includes('Can you send the contract?') && c1.text.includes('Sim, envio amanhã.'));
  assert.ok(c1.uri.startsWith('https://outlook.office.com/'));
  assert.equal(ext(s, 'c2'), null, 'only in Deleted Items');
  assert.equal(ext(s, 'c3'), null, 'never read: a sender domain');
  assert.equal(ext(s, 'c4'), null, 'never read: a subject word');
  assert.equal(ext(s, 'c6'), null, 'a draft');
  assert.ok(ext(s, 'c5'));
  assert.ok(g.prefer.has('outlook.body-content-type="text", odata.maxpagesize=50'), 'asks for the body as text');
  assert.ok(g.log.some((l) => decodeURIComponent(l).includes('receivedDateTime ge ')), 'the date window goes to Microsoft');
  assert.ok(!g.log.some((l) => decodeURIComponent(l).includes('corp.pt')), 'the never-read list is applied here, not trusted to a filter Graph cannot do');
});

test('a category filter (any-of) and a sender-domain filter are applied after download', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', categories: ['Work'] });
  g.add({ conversationId: 'c2', from: 'Eva <eva@acme.io>', categories: ['Clients'] });
  g.add({ conversationId: 'c3', from: 'Zed <zed@z.pt>', categories: [] });
  g.add({ conversationId: 'c4', from: 'Spam <spam@z.pt>', categories: ['Work'] });
  const s = setup(g, { grant: { readLevel: 'part', filter: { labels: ['Work', 'Clients'], excludeSenders: ['spam@z.pt'] } } });
  await s.run();
  assert.ok(ext(s, 'c1') && ext(s, 'c2'));
  assert.equal(ext(s, 'c3'), null, 'no category');
  assert.equal(ext(s, 'c4'), null, 'excluded sender');
  // narrowing the filter later forgets what no longer fits (the signature changed: everything is read under the new rule)
  s.store.setGrant(s.src.id, { filter: { fromDomains: ['acme.io'] } });
  await s.run();
  assert.equal(ext(s, 'c1').deletedAt !== null, true);
  assert.equal(ext(s, 'c2').deletedAt, null);
});

test('delta: changes, moves and removals reach the copy, and the cursor is the folders\' deltaLinks', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', body: 'first' });
  const b = g.add({ conversationId: 'c2', subject: 'Second', body: 'second' });
  const c = g.add({ conversationId: 'c3', subject: 'Third', body: 'third' });
  const s = setup(g);
  await s.run();
  const cur = outlook.readCursor(s.live().cursor);
  assert.ok(cur.f.inbox.d.includes('$deltatoken='), 'a deltaLink per folder');
  assert.ok(cur.f.sentitems.d && cur.f.archive.d);
  assert.equal(cur.resync, false);
  assert.equal(s.store.count(), 3);
  // nothing changed: nothing read but the delta pages
  const before = g.log.length;
  const r0 = await s.run();
  assert.equal(r0.created + r0.updated, 0);
  assert.ok(g.log.slice(before).every((l) => l.includes('/delta') || l.startsWith('/v1.0/me') ));
  // a reply, a move to Archive, a move to Deleted Items, a delete for good
  g.add({ conversationId: 'c1', from: 'Ana <ana@x.pt>', to: ['rui@x.pt'], body: 'reply here', received: '2026-11-25T10:00:00Z', folder: 'F-sent' });
  g.move(b, 'F-archive');
  g.move(c, 'F-deleted');
  g.add({ conversationId: 'c9', subject: 'Goner', body: 'x' });
  await s.run();
  assert.equal(ext(s, 'c1').meta.messages, 2, 'a reply in Sent Items joins the conversation');
  assert.equal(ext(s, 'c2').deletedAt, null, 'moved to Archive: still there');
  assert.ok(ext(s, 'c2').meta.labels.includes('Archive'));
  assert.ok(ext(s, 'c3').deletedAt, 'moved to Deleted Items: gone (found by the removed message id)');
  const goner = g.msgs.find((m) => m.conversationId === 'c9');
  assert.equal(ext(s, 'c9').deletedAt, null);
  g.remove(goner);
  await s.run();
  assert.ok(ext(s, 'c9').deletedAt, 'deleted for good: @removed tombstones it');
});

test('a big mailbox is read across runs, page by page, and nothing is skipped', async (t) => {
  const g = await fakeGraph({ pageSize: 2 }); t.after(() => g.close());
  for (let i = 1; i <= 7; i++) g.add({ conversationId: `c${i}`, subject: `Subject ${i}`, body: `hello ${i}` });
  const s = setup(g);
  await s.run(2);
  let cur = outlook.readCursor(s.live().cursor);
  assert.ok(cur.f.inbox.n && !cur.f.inbox.d, 'stopped at a page: the next run continues it');
  assert.equal(cur.resync, true);
  assert.equal(s.store.count(), 2);
  await s.run(2); assert.equal(s.store.count(), 4);
  await s.run(2); assert.equal(s.store.count(), 6);
  await s.run(2);
  assert.equal(s.store.count(), 7, 'all seven, none skipped');
  cur = outlook.readCursor(s.live().cursor);
  assert.ok(cur.f.inbox.d && !cur.f.inbox.n);
  assert.equal(cur.resync, false);
  assert.ok(new Set(Array.from({ length: 7 }, (_, i) => ext(s, `c${i + 1}`)?.title)).size === 7);
});

test('a run that stops on an error keeps the pages it finished', async (t) => {
  const g = await fakeGraph({ pageSize: 2 }); t.after(() => g.close());
  for (let i = 1; i <= 4; i++) g.add({ conversationId: `c${i}`, body: `hello ${i}` });
  const s = setup(g);
  await s.run(2);                                   // page 1 done
  assert.equal(s.store.count(), 2);
  g.throttle = 5; g.retryAfter = 120;               // asked to wait two minutes: too long to wait here
  await assert.rejects(s.run(10), (e) => e instanceof RateLimited || e.code === 'rate-limited');
  const cur = outlook.readCursor(s.live().cursor);
  assert.ok(cur.f.inbox.n, 'the cursor still points at the page to continue');
  g.throttle = 0;
  await s.run(10);
  assert.equal(s.store.count(), 4);
});

test('429 with a short Retry-After is waited out once; the wait is the one Microsoft asked for', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1' });
  const s = setup(g);
  g.throttle = 1; g.retryAfter = 3;
  await s.run();
  assert.deepEqual(s.slept, [3000]);
  assert.ok(ext(s, 'c1'));
});

test('the delta state expires (410): every folder is read again and what is no longer there is tombstoned', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', body: 'stays' });
  g.add({ conversationId: 'c2', subject: 'Goes', body: 'goes' });
  const s = setup(g);
  await s.run();
  assert.equal(s.store.count(), 2);
  g.msgs.splice(g.msgs.findIndex((m) => m.conversationId === 'c2'), 1);       // vanished while the state was lost: no @removed was ever sent
  g.expireDelta = true;
  const r = await s.run();
  assert.ok(ext(s, 'c2').deletedAt, 'not in the new listing: gone');
  assert.equal(ext(s, 'c1').deletedAt, null);
  assert.equal(r.removed, 1);
  assert.equal(outlook.readCursor(s.live().cursor).resync, false);
});

test('tokens: an expired access token is refreshed, a 401 refreshes once more, the scopes Microsoft says it granted are kept', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1' });
  const s = setup(g, { settings: { accessToken: 'stale', expiresAt: Date.now() - 1000, scopes: [] } });
  await s.run();
  assert.equal(g.refreshes >= 1, true);
  assert.deepEqual(s.mem.read().scopes, ['Mail.Read'], 'parsed from the token response, long form or short');
  assert.equal(s.mem.read().refreshToken, 'refresh-2');
  assert.deepEqual(g.tokenBodies[0], { client_id: 'client-1', refresh_token: 'refresh-1', grant_type: 'refresh_token' });
  // the server stops accepting the token (revoked session) although it has not expired by the clock: one refresh and retry
  const n = g.refreshes;
  g.tokens.clear();
  const s2 = setup(g, { settings: { accessToken: 'tok-1', expiresAt: Date.now() + 3600_000 } });
  await s2.run();
  assert.equal(g.refreshes, n + 1);
  assert.ok(ext(s2, 'c1'));
});

test('invalid_grant: the reconnect flag is kept (with the address and what was granted), what was read stays, the sync says what to do', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1' });
  const s = setup(g);
  await s.run();
  g.badRefresh = true;
  s.mem.update({ outlook: { accessToken: 'old', expiresAt: 0 } });
  await assert.rejects(s.run(), (e) => e.permanent === true && e.code === 'outlook-auth' && /reconnect/i.test(e.message));
  const c = s.mem.read();
  assert.equal(c.needsReconnect, true);
  assert.equal(c.refreshToken, '');
  assert.equal(c.email, 'ana@x.pt');
  assert.deepEqual(c.scopes, ['Mail.Read']);
  assert.ok(ext(s, 'c1'), 'what was read stays');
  assert.equal(outlook.ready(s.ctx), false);
  await assert.rejects(s.run(), /reconnect|connect/i);
});

test('the sign-in: loopback + PKCE, the tenant is common by default, the permissions asked are the grant\'s, the granted ones and the address are saved', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  const mem = memorySettings({ refreshToken: '', accessToken: '', expiresAt: 0, scopes: [], email: '' });
  const auth = new outlook.OutlookAuth({ getConfig: () => mem.read(), saveConfig: (p) => mem.update({ outlook: p }), bases: { login: g.url, graph: `${g.url}/v1.0` }, builtIn: {} });
  let seen;
  const flow = await auth.beginAuth({ level: 'metadata', openExternal: async (url) => { seen = new URL(url); } });
  assert.equal(seen.pathname, '/common/oauth2/v2.0/authorize');
  const asked = seen.searchParams.get('scope').split(' ');
  assert.ok(asked.includes('Mail.ReadBasic') && asked.includes('offline_access') && !asked.includes('Mail.Read') && !asked.includes('Mail.Send'));
  assert.equal(seen.searchParams.get('code_challenge_method'), 'S256');
  // the browser comes back
  const back = await fetch(`${flow.redirectUri}?code=abc&state=${seen.searchParams.get('state')}`);
  assert.equal(back.status, 200);
  await flow.done;
  assert.equal(g.tokenBodies.at(-1).code_verifier.length >= 43, true);
  assert.equal(g.tokenBodies.at(-1).grant_type, 'authorization_code');
  assert.equal(mem.read().refreshToken, 'refresh-1');
  assert.equal(mem.read().email, 'ana@outlook.com');
  assert.deepEqual(mem.read().scopes, ['Mail.Read'], 'only mail permissions are listed, the answer decides');
  assert.equal(mem.read().needsReconnect, false);
  // another tenant changes the endpoints
  mem.update({ outlook: { tenant: 'contoso.onmicrosoft.com' } });
  assert.ok(auth.tokenUrl.includes('/contoso.onmicrosoft.com/oauth2/v2.0/token'));
});

test('a link inside a response that points to another host is not followed or saved (the token must not go there)', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1' });
  g.evilNext = 'http://127.0.0.1:1/steal';
  const s = setup(g);
  await assert.rejects(s.run(), /another host/);
  assert.ok(!(s.live().cursor || '').includes('steal'), 'a poisoned cursor would fail forever');
});

test('live search: only when the grant allows it, never at the metadata level, $search without $filter, the never-read list and filter applied to hits', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', subject: 'Budget 2027', body: 'the budget plan', received: '2026-11-24T10:00:00Z' });
  g.add({ conversationId: 'c1', subject: 'Re: Budget 2027', from: 'Ana <ana@x.pt>', body: 'budget ok', received: '2026-11-25T10:00:00Z', folder: 'F-sent' });
  g.add({ conversationId: 'c2', subject: 'Budget for HR', from: 'HR <hr@corp.pt>', body: 'budget salary' });
  g.add({ conversationId: 'c3', subject: 'Budget binned', body: 'budget', folder: 'F-deleted' });
  g.add({ conversationId: 'c4', subject: 'Budget lunch', from: 'Eva <eva@y.pt>', body: 'budget lunch', categories: ['Personal'] });
  const s = setup(g, { grant: { readLevel: 'part', liveSearch: true, filter: { never: { domains: ['corp.pt'] } } } });
  const hits = await outlook.searchLive({ ctx: s.ctx, source: s.live(), query: 'budget', limit: 10 });
  assert.deepEqual(hits.map((h) => h.externalId).sort(), ['thread:c1', 'thread:c4']);
  const h = hits.find((x) => x.externalId === 'thread:c1');
  assert.deepEqual(Object.keys(h).sort(), ['at', 'externalId', 'from', 'snippet', 'title', 'uri']);
  assert.equal(h.title, 'Re: Budget 2027', 'the newest message of the conversation');
  assert.ok(h.snippet.includes('budget') && h.from.includes('ana@x.pt'));
  const searchCall = g.log.find((l) => l.includes('search'));
  assert.ok(searchCall && !/filter|orderby/.test(searchCall), 'Graph cannot combine $search with $filter or $orderby');
  // the grant's own filter narrows the hits
  s.store.setGrant(s.src.id, { filter: { labels: ['Personal'], never: { domains: ['corp.pt'] } } });
  assert.deepEqual((await outlook.searchLive({ ctx: s.ctx, source: s.live(), query: 'budget' })).map((x) => x.externalId), ['thread:c4']);
  // not allowed to search: nothing is sent
  s.store.setGrant(s.src.id, { liveSearch: false });
  const n = g.log.length;
  assert.deepEqual(await outlook.searchLive({ ctx: s.ctx, source: s.live(), query: 'budget' }), []);
  assert.equal(g.log.length, n);
});

test('opening a found conversation gives an item payload; never-read and the metadata level are honoured', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', body: 'full text here' });
  g.add({ conversationId: 'c2', from: 'HR <hr@corp.pt>', body: 'salary' });
  const s = setup(g, { grant: { readLevel: 'part', liveSearch: true, filter: { never: { domains: ['corp.pt'] } } } });
  const item = await outlook.openLive({ ctx: s.ctx, source: s.live(), externalId: 'thread:c1' });
  assert.equal(item.externalId, 'thread:c1');
  assert.ok(item.text.includes('full text here'));
  assert.equal(s.store.upsert(s.src.id, item).action, 'created', 'a payload ItemStore.upsert takes');
  assert.equal(await outlook.openLive({ ctx: s.ctx, source: s.live(), externalId: 'thread:c2' }), null, 'never read');
  assert.equal(await outlook.openLive({ ctx: s.ctx, source: s.live(), externalId: 'thread:nope' }), null);
  s.store.setGrant(s.src.id, { readLevel: 'metadata' });
  const meta = await outlook.openLive({ ctx: s.ctx, source: s.live(), externalId: 'c1' });
  assert.equal(meta.text, '');
  assert.equal(meta.meta.metadataOnly, true);
});

test('check and estimate: who is connected, and how big "everything" is', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  for (let i = 0; i < 5; i++) g.add({ conversationId: `c${i}` });
  const s = setup(g);
  const c = await outlook.check(s.ctx, s.live());
  assert.deepEqual(c, { ok: true, email: 'ana@x.pt' });
  const e = await outlook.estimate(s.ctx, s.live());
  assert.equal(e.messages, 5);
  assert.equal(e.threads, 2);
  assert.ok('megabytes' in e && 'hours' in e);
});

test('through the app\'s settings: the sync builds its sign-in from settings.outlook (tokens saved back there) and the fake base addresses', async (t) => {
  const g = await fakeGraph(); t.after(() => g.close());
  g.add({ conversationId: 'c1', body: 'via settings' });
  let cfg = { clientId: 'client-1', tenant: 'common', refreshToken: 'refresh-1', accessToken: 'stale', expiresAt: 0, email: 'ana@x.pt', scopes: ['Mail.Read'], needsReconnect: false };
  const settings = { get: (k) => (k === 'outlook' ? cfg : undefined), update: (p) => { cfg = { ...cfg, ...p.outlook }; } };
  const store = new ItemStore(open(':memory:'));
  const src = store.addSource({ kind: 'outlook', name: 'Mail', mode: 'copy', config: { remote: true }, grant: { readLevel: 'part' } });
  const ctx = { settings, bases: { outlook: { login: g.url, graph: `${g.url}/v1.0` } }, sleep: async () => {} };
  assert.equal(outlook.ready(ctx, {}), true);
  await outlook.sync({ ...ctx, source: store.source(src.id), items: store });
  assert.equal(store.byExternal(src.id, 'thread:c1').text.includes('via settings'), true);
  assert.equal(cfg.refreshToken, 'refresh-2', 'the rotated refresh token was saved back to the settings');
  assert.equal(outlook.authFor(ctx), outlook.authFor({ ...ctx }), 'one sign-in per settings object (two syncs at once share one refresh)');
  assert.equal(outlook.ready({ settings: { get: () => ({ ...cfg, refreshToken: '', needsReconnect: true }) } }, {}), false);
  assert.equal(outlook.ready({}, {}), false);
});
