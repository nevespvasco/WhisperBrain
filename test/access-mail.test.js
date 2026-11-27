'use strict';
// Several Google accounts, level-based sign-in, live search with its cache, mail linked to people, forgetting a person, the 90-day review,
// redaction and untrusted senders in Ask, and the Gmail actions with their guards: all against a SIMULATED Gmail (test/gmail-fake.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeGmail, mail, boot } = require('./gmail-fake');
const { startFakeLlm } = require('./fake-llm');
const { gmailScopesFor, READONLY, METADATA, COMPOSE, MODIFY } = require('../src/access/gmail-scopes');
const { Redactor } = require('../src/access/redact');
const { audit, argsHash } = require('../src/access/guards');
const { MASK } = require('../src/core/settings');

const OPEN = (flow) => fetch(`${flow.auth.redirectUri}?code=good&state=${new URL(flow.auth.authUrl).searchParams.get('state')}`).then((r) => r.text());
const thread = (id, from, to, text, extra = {}) => ({ id, historyId: '90', messages: [mail(`m${id}`, from, to, text, extra)] });
const remote = (url) => url.replace('127.0.0.1', '[::ffff:127.0.0.1]');

test('Google permissions follow the grant: metadata alone, read, and the right extra for each action', () => {
  assert.deepEqual(gmailScopesFor({ level: 'metadata' }), [METADATA]);
  assert.deepEqual(gmailScopesFor({ level: 'part' }), [READONLY]);
  assert.deepEqual(gmailScopesFor({ level: 'all', actions: ['gmail.draft', 'gmail.send'] }), [READONLY, COMPOSE]);
  assert.deepEqual(gmailScopesFor({ level: 'part', actions: ['gmail.label', 'gmail.draft'] }), [READONLY, MODIFY, COMPOSE]);
  assert.ok(!gmailScopesFor({ level: 'metadata', actions: ['gmail.label'] }).includes(METADATA), 'metadata cannot be combined with the others');
  assert.deepEqual(gmailScopesFor({ level: 'none' }), []);
});

test('accounts: tokens of extra mailboxes are sealed and masked, a second mailbox is its own account, and what Google granted is what counts', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  const app = await boot(t, g);
  // 1. masked in what the page sees, and written back masked they stay
  app.settings.update({ mailAccounts: [{ id: 'a1', email: 'w@x.pt', refreshToken: 'rt-secret', accessToken: 'at-secret', scopes: [READONLY] }] });
  const view = app.settings.publicView().mailAccounts[0];
  assert.deepEqual([view.refreshToken, view.accessToken], [MASK, MASK]);
  app.settings.update({ mailAccounts: [view] });
  assert.equal(app.settings.get('mailAccounts')[0].refreshToken, 'rt-secret', 'unchanged');
  // 2. add a mailbox through the sign-in flow
  g.token = { scope: `openid email ${READONLY}`, email: 'Work@X.pt' };
  const flow = await app.googleAccounts.connect({ account: 'new', scopes: [READONLY] });
  assert.match(new URL(flow.auth.authUrl).searchParams.get('scope'), new RegExp(`${READONLY}$`), 'asked for exactly this');
  assert.ok(!new URL(flow.auth.authUrl).searchParams.get('scope').includes('calendar'), 'a mailbox added for mail does not ask for the calendar');
  await OPEN(flow);
  const added = await flow.finished;
  assert.equal(added.email, 'work@x.pt');
  assert.deepEqual(app.googleAccounts.list().map((a) => [a.id === 'primary' ? 'primary' : 'extra', a.email]).filter((x) => x[1] === 'work@x.pt'), [['extra', 'work@x.pt']]);
  // signing in to the same address again updates it instead of adding a second one
  const flow2 = await app.googleAccounts.connect({ account: 'new', scopes: [READONLY] }); await OPEN(flow2); await flow2.finished;
  assert.equal(app.googleAccounts.extra().filter((a) => a.email === 'work@x.pt').length, 1);
  // 3. the person untick the mail box on Google's consent screen: the account is not "mail connected"
  g.token = { scope: 'openid email', email: 'nomail@x.pt' };
  const flow3 = await app.googleAccounts.connect({ account: 'new', scopes: [READONLY] }); await OPEN(flow3); const r3 = await flow3.finished;
  assert.deepEqual(app.googleAccounts.extra().find((a) => a.id === r3.id).scopes, [], 'no Gmail permission came back');
  assert.throws(() => app.googleAccounts.client(r3.id).gmail('/users/me/profile'), /not connected|connect Google again/i, 'and mail calls are refused');
  // 4. sign out of one account: revoked at Google and forgotten here
  await app.googleAccounts.disconnect(added.id);
  assert.ok(g.revoked.includes('rt-new'));
  assert.ok(!app.googleAccounts.list().some((a) => a.id === added.id));
});

test('a source reads the account it was made for; an expired access flags it for one-click reconnect and keeps the data', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'Rui <rui@x.pt>', 'work@x.pt', 'hello');
  const app = await boot(t, g);
  app.settings.update({ mailAccounts: [{ id: 'w1', email: 'work@x.pt', refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3600_000, scopes: [READONLY] }] });
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Work mail', config: { account: 'w1', query: 'newer_than:30d' } });
  assert.equal(src.config.account, 'w1');
  assert.equal((await app.sources.sync(src.id)).created, 1);
  g.refreshError = 'invalid_grant';
  app.settings.update({ mailAccounts: [{ ...app.settings.get('mailAccounts')[0], expiresAt: 1, accessToken: '' }] });
  await assert.rejects(app.sources.sync(src.id), (e) => e.code === 'google-auth' && e.permanent);
  assert.equal(app.items.source(src.id).config.needsReconnect, true);
  assert.equal(app.googleAccounts.list().find((a) => a.id === 'w1').needsReconnect, true);
  assert.ok(app.items.byExternal(src.id, 'thread:t1') && !app.items.byExternal(src.id, 'thread:t1').deletedAt, 'what was read stays');
  assert.equal(app.accessCenter.overview().sources.find((s) => s.id === src.id).needsReconnect, true);
});

test('estimate before everything: threads, space and time from the mailbox\'s own counts', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  for (let i = 0; i < 8; i++) g.threads[`t${i}`] = thread(`t${i}`, 'Rui <rui@x.pt>', 'ana@x.pt', 'x');
  const app = await boot(t, g);
  const e = await app.sources.services.gmail.estimate(app.sources.ctx, { config: {} });
  assert.deepEqual([e.threads, e.messages], [8, 9]);
  assert.ok(e.megabytes >= 0 && e.hours >= 0);
});

test('live search: only sources that allow it, with their part, cached by grant, opened bodies expire unless kept', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'Rui <rui@x.pt>', 'ana@x.pt', 'the budget numbers');
  g.threads.t2 = thread('t2', 'HR <hr@corp.pt>', 'ana@x.pt', 'salary review', { subject: 'Salary' });
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:1d' }, grant: { liveSearch: false, filter: { never: { domains: ['corp.pt'] } } } });
  assert.deepEqual((await app.liveSearch.search('budget')).searched, [], 'live search is off for this source');
  app.items.setGrant(src.id, { liveSearch: true });
  const r1 = await app.liveSearch.search('budget');
  assert.deepEqual(r1.results.map((r) => r.externalId), ['thread:t1'], 'the never-read sender is not even listed');
  assert.ok(g.log.some((l) => decodeURIComponent(l).includes('-from:corp.pt')), 'the part went to Gmail with the question');
  const calls = g.log.filter((l) => l.includes('/threads?')).length;
  const r2 = await app.liveSearch.search('budget');
  assert.equal(r2.searched[0].cached, true);
  assert.equal(g.log.filter((l) => l.includes('/threads?')).length, calls, 'the second ask came from the cache');
  app.items.setGrant(src.id, { filter: { never: { domains: ['other.pt'] } } });
  assert.equal((await app.liveSearch.search('budget')).searched[0].cached, false, 'a changed grant never serves the old cache');
  assert.ok(app.accessLog.list({ sourceId: src.id }).some((l) => l.op === 'live.search'));
  assert.ok(!JSON.stringify(app.accessLog.list()).includes('budget'), 'the log says that a question went out, not what it was');
  // open: kept as a live item that expires
  const it = await app.liveSearch.open(src.id, 'thread:t1');
  assert.equal(it.origin, 'live');
  assert.match(it.text, /budget numbers/);
  assert.ok(it.expiresAt > Date.now());
  app.db.prepare('UPDATE items SET expires_at = 1 WHERE id = ?').run(it.id);
  assert.equal(app.liveSearch.purge().items, 1);
  assert.equal(app.items.item(it.id), null, 'gone for good');
  const again = await app.liveSearch.open(src.id, 'thread:t1');
  app.items.pin(again.id);
  app.db.prepare('UPDATE items SET expires_at = 1 WHERE id = ?').run(again.id);
  assert.equal(app.liveSearch.purge().items, 0, 'a kept one stays');
  // metadata level: no live search (Google refuses q under that permission)
  app.items.setGrant(src.id, { readLevel: 'metadata' });
  assert.deepEqual((await app.liveSearch.search('budget', { force: true })).searched, []);
});

test('mail is linked to the people in it (only people already known), a person\'s timeline and a meeting\'s related mail follow, and forgetting a person deletes their one-to-one mail and blocks the address', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'Rui Costa <rui@x.pt>', 'ana@x.pt', 'about the contract');
  g.threads.t2 = thread('t2', 'Shop <news@shop.com>', 'ana@x.pt', 'sale', { unsubscribe: true });
  g.threads.t3 = { id: 't3', historyId: '91', messages: [mail('m3', 'Rui Costa <rui@x.pt>', 'ana@x.pt, eva@y.pt', 'three of us', { subject: 'Group' })] };
  const app = await boot(t, g);
  const meeting = app.notes.create({ title: 'Contract sync', status: 'done', attendees: [{ name: 'Rui Costa', email: 'rui@x.pt' }], body: 'contract' });
  app.entities.syncNote(meeting.id);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' } });
  await app.sources.sync(src.id);
  const linked = app.db.prepare('SELECT COUNT(DISTINCT item_id) AS n FROM item_mentions').get().n;
  for (const it of app.items.list({ sourceId: src.id })) app.entities.syncItem(it.id);
  const rui = app.entities.find('rui costa');
  const names = app.entities.itemsOf(rui).map((i) => i.title);
  assert.deepEqual(names.sort(), ['Contract terms', 'Group'], 'Rui\'s two threads; the newsletter belongs to nobody known');
  assert.equal(app.entities.list().some((p) => p.name.includes('shop')), false, 'a newsletter sender never makes a person');
  assert.ok(linked >= 0);
  const tl = app.timeline.person(rui);
  assert.deepEqual(tl.entries.map((e) => e.type).sort(), ['mail', 'mail', 'meeting']);
  assert.equal(tl.mail, 2);
  const rel = await app.timeline.related(meeting.id);
  assert.ok(rel.length >= 2 && rel.every((r) => r.sourceName === 'Mail'));
  app.timeline.setLink(meeting.id, rel[0].id, 'unlinked');
  assert.ok(!(await app.timeline.related(meeting.id)).some((r) => r.id === rel[0].id), 'unlinked by the person');
  // the brief shows the mail of the people coming
  const brief = await app.briefs.build({ title: 'Contract sync 2', attendees: [{ name: 'Rui Costa', email: 'rui@x.pt' }] });
  assert.ok(brief.mail.length >= 1 && !brief.empty);
  // forget Rui: the one-to-one thread goes, the group thread (two others) stays, the address is blocked and not read again
  const out = app.entities.forget(rui, { items: app.items });
  assert.equal(out.items, 1);
  assert.equal(app.items.byExternal(src.id, 'thread:t1'), null);
  assert.ok(app.items.byExternal(src.id, 'thread:t3'), 'a thread with others stays');
  assert.ok(app.items.blocked().includes('rui@x.pt'));
  g.threads.t4 = thread('t4', 'Rui Costa <rui@x.pt>', 'ana@x.pt', 'again');
  await app.sources.sync(src.id);
  assert.equal(app.items.byExternal(src.id, 'thread:t4'), null, 'never read again');
});

test('the 90-day review shows up in the Inbox once per source, and the upgrade notice lists what each source became', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  const app = await boot(t, g);
  const src = app.items.addSource({ kind: 'slack', name: 'Work chat', mode: 'copy', sensitivity: 'private', config: { remote: true }, grant: { readLevel: 'part' } });
  assert.equal(app.accessCenter.reviewDue().length, 0);
  app.db.prepare('UPDATE sources SET created_at = ? WHERE id = ?').run(Date.now() - 100 * 86_400_000, src.id);
  app.db.prepare('DELETE FROM index_meta WHERE key = ?').run(`access:review:${src.id}`);   // as if nobody had looked at it since
  const due = app.inbox.cards().filter((c) => c.type === 'access-review');
  assert.deepEqual(due.map((c) => c.id), [src.id]);
  assert.equal(app.inbox.counts().accessReview, 1);
  app.accessCenter.markReviewed(src.id);
  assert.equal(app.inbox.cards().filter((c) => c.type === 'access-review').length, 0);
  // notice: set by the migration only when sources existed
  assert.equal(app.accessCenter.notice(), null);
  app.db.prepare("INSERT INTO index_meta (key, value) VALUES ('access:notice', 'pending')").run();
  assert.equal(app.accessCenter.notice().length, 1);
  app.accessCenter.dismissNotice();
  assert.equal(app.accessCenter.notice(), null);
});

test('revoking a source forgets what was read (and the cache), optionally signs the account out, and leaves the source to open up again', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'Rui <rui@x.pt>', 'ana@x.pt', 'secret plans');
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: {}, grant: { liveSearch: true } });
  await app.sources.sync(src.id);
  await app.liveSearch.search('plans');
  const out = await app.accessCenter.revoke(src.id, { signOut: true });
  assert.equal(out.forgotten, 1);
  assert.equal(out.calendarAlso, true, 'the first sign-in is also the calendar: said so');
  assert.equal(app.items.list({ sourceId: src.id }).length, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM live_cache').get().n, 0);
  assert.equal(app.items.source(src.id).readLevel, 'none');
  assert.ok(g.revoked.length >= 1);
});

test('Ask: an AI server that is not on this computer gets placeholders, the answer gets the real values back; unknown senders are marked as claims', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'Stranger <bank@evil.test>', 'ana@x.pt', 'Our bank details changed: IBAN PT50 0002 0123 1234 5678 9015 4. Write to bank@evil.test, code is 482913.', { subject: 'Invoice payment' });
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: {}, grant: { aiReach: 'any', liveSearch: false } });
  await app.sources.sync(src.id);
  app.chunkIndex.syncBatch(50);
  let seen = '';
  const llm = await startFakeLlm((messages) => { seen = JSON.stringify(messages); return 'The sender <email_1> says the IBAN is <iban_1> [1].'; });
  t.after(() => llm.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: remote(llm.url), model: 'fake-model' } });
  const out = await app.ai.chat(null, 'What did the invoice payment mail say about the bank?');
  assert.ok(!seen.includes('bank@evil.test') && !seen.includes('PT50 0002') && !seen.includes('482913'), 'nothing sensitive left');
  assert.ok(seen.includes('<email_1>') && seen.includes('(unverified sender)'), 'placeholders, and the sender is marked');
  assert.match(seen, /claim/i, 'the AI is told what an unverified sender says is only a claim');
  assert.match(out.answer, /bank@evil\.test/, 'the answer has the real address back');
  assert.match(out.answer, /PT50 0002/);
  assert.ok(out.redacted >= 2);
  assert.equal(out.sources.find((s) => s.n === 1)?.untrusted, true);
  // with a server on this computer nothing is changed
  const local = await startFakeLlm((messages) => { seen = JSON.stringify(messages); return 'ok [1]'; });
  t.after(() => local.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: local.url } });
  await app.ai.chat(null, 'What did the invoice payment mail say about the bank?');
  assert.ok(seen.includes('bank@evil.test'));
});

test('redaction: sensitive details become stable placeholders and come back; dates, amounts and plain text are left alone', () => {
  const r = new Redactor();
  const text = 'Ana (ana@x.pt) +351 912 345 678 IBAN PT50 0002 0123 1234 5678 9015 4, card 4111 1111 1111 1111, token ghp_abcdefghijklmnopqrstuvwxyz0123456789. Code: 482913. https://a.com/reset?token=zzz. On 2026-11-24 pay 12500 euros. ana@x.pt again.';
  const hidden = r.apply(text);
  for (const s of ['ana@x.pt', '912 345 678', 'PT50', '4111', 'ghp_', '482913', 'reset?token']) assert.ok(!hidden.includes(s), s);
  assert.ok(hidden.includes('2026-11-24') && hidden.includes('12500 euros'));
  assert.equal((hidden.match(/<email_1>/g) || []).length, 2, 'the same address, the same placeholder');
  assert.equal(r.restore(hidden), text);
});

test('guards: a recipient who is not in the thread, a link that was not there, material from another source', () => {
  const flags = audit({ outbound: { recipients: ['rui@x.pt', 'new@z.com'], text: 'see https://a.com/ok and https://new.test/x' }, context: { people: ['rui@x.pt'], text: 'earlier https://a.com/ok', typed: [], provenance: ['srcA'], sourceId: 'srcB' } });
  assert.deepEqual(flags.map((f) => f.code).sort(), ['foreign-material', 'new-recipient', 'new-url']);
  assert.deepEqual(audit({ outbound: { recipients: ['new@z.com'], text: 'hi' }, context: { people: [], typed: ['new@z.com'] } }), [], 'an address the person typed is theirs');
  assert.equal(argsHash({ a: 1, b: [1, { c: 2 }] }), argsHash({ b: [1, { c: 2 }], a: 1 }));
});

test('Gmail actions: draft, send exactly what was shown, bulk label/archive; a second yes for what could leak; changed arguments, missing permission and a narrowed grant stop it', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = { id: 't1', historyId: '90', messages: [{ ...mail('m1', 'Rui <rui@x.pt>', 'ana@x.pt', 'Can you send the contract?'), payload: { ...mail('m1', 'Rui <rui@x.pt>', 'ana@x.pt', 'Can you send the contract?').payload, headers: [{ name: 'From', value: 'Rui <rui@x.pt>' }, { name: 'To', value: 'ana@x.pt' }, { name: 'Subject', value: 'Contract terms' }, { name: 'Date', value: 'Tue, 24 Nov 2026 10:00:00 +0000' }, { name: 'Message-ID', value: '<m1@x.pt>' }] } }] };
  g.threads.t2 = thread('t2', 'News <n@s.com>', 'ana@x.pt', 'digest', { subject: 'Digest' });
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: {}, grant: { actions: ['gmail.draft', 'gmail.send', 'gmail.label', 'gmail.archive'] } });
  await app.sources.sync(src.id);
  const t1 = app.items.byExternal(src.id, 'thread:t1'), t2 = app.items.byExternal(src.id, 'thread:t2');
  // not granted by Google yet: refused with what to do
  assert.throws(() => app.actions.propose('gmail.draft', { itemId: t1.id, body: 'On it.' }), (e) => e.status === 412 && /reconnect/i.test(e.message));
  app.settings.update({ google: { ...app.settings.get('google'), scopes: [READONLY, COMPOSE, MODIFY] } });
  // a draft in the thread
  const p = app.actions.propose('gmail.draft', { itemId: t1.id, body: 'On it, sending Friday.' });
  assert.deepEqual(p.args.to, ['rui@x.pt']);
  assert.match(p.args.subject, /^Re: Contract terms/);
  assert.deepEqual(p.flags, [], 'to someone in the thread: nothing to warn about');
  assert.equal(g.posts.length, 0, 'proposing changes nothing');
  const done = await app.actions.approve(p.id);
  assert.equal(done.state, 'done');
  const posted = g.posts.find((x) => x.path === '/drafts');
  assert.equal(posted.body.message.threadId, 't1');
  const raw = Buffer.from(posted.body.message.raw, 'base64url').toString('utf8');
  assert.match(raw, /^In-Reply-To: <m1@x\.pt>$/m);
  assert.match(raw, /^To: rui@x\.pt$/m);
  // a new recipient is flagged and needs a second yes
  const risky = app.actions.propose('gmail.send', { itemId: t1.id, to: ['rui@x.pt', 'stranger@evil.test'], body: 'See https://evil.test/pay' });
  assert.deepEqual(risky.flags.map((f) => f.code).sort(), ['new-recipient', 'new-url']);
  assert.equal(risky.needsSecondYes, true);
  await assert.rejects(app.actions.approve(risky.id), (e) => e.code === 'confirm-needed');
  assert.equal(app.actions.get(risky.id).state, 'pending');
  app.actions.reject(risky.id);
  // typed by the person: not flagged. The send is exactly the approved message
  const send = app.actions.propose('gmail.send', { itemId: t1.id, to: ['rui@x.pt', 'boss@x.pt'], body: 'Contract attached next week.', typedRecipients: ['boss@x.pt'] });
  assert.deepEqual(send.flags, []);
  app.db.prepare('UPDATE actions SET args = ? WHERE id = ?').run(JSON.stringify({ ...send.args, to: ['attacker@evil.test'] }), send.id);
  await assert.rejects(app.actions.approve(send.id), (e) => /changed after it was shown/.test(e.message));
  const send2 = app.actions.propose('gmail.send', { itemId: t1.id, body: 'Friday, promise.' });
  await app.actions.approve(send2.id);
  const sent = g.posts.find((x) => x.path === '/messages/send');
  assert.equal(sent.body.threadId, 't1');
  assert.match(Buffer.from(sent.body.raw, 'base64url').toString('utf8'), /^To: rui@x\.pt$/m);
  // bulk: one proposal for many threads, labels by name, a missing label is only made when asked
  const bulk = app.actions.propose('gmail.label', { itemIds: [t1.id, t2.id], add: ['Work'], remove: ['INBOX'] });
  assert.match(bulk.title, /2 threads/);
  await app.actions.approve(bulk.id);
  assert.deepEqual(g.modified.map((m) => [m.id, m.addLabelIds, m.removeLabelIds]), [['t1', ['Label_1'], ['INBOX']], ['t2', ['Label_1'], ['INBOX']]]);
  const missing = app.actions.propose('gmail.label', { itemIds: [t2.id], add: ['Clients'] });
  assert.equal((await app.actions.approve(missing.id)).state, 'failed');
  const made = app.actions.propose('gmail.label', { itemIds: [t2.id], add: ['Clients'], create: true });
  assert.equal((await app.actions.approve(made.id)).state, 'done');
  assert.ok(g.labels.some((l) => l.name === 'Clients'));
  const arch = app.actions.propose('gmail.archive', { itemIds: [t2.id] });
  await app.actions.approve(arch.id);
  assert.deepEqual(g.modified.at(-1).removeLabelIds, ['INBOX']);
  // narrowing the grant stops what is waiting, and what was run is in the access log
  const waiting = app.actions.propose('gmail.draft', { itemId: t1.id, body: 'later' });
  app.items.setGrant(src.id, { actions: [] });
  await assert.rejects(app.actions.approve(waiting.id), (e) => e.status === 403);
  assert.throws(() => app.actions.propose('gmail.draft', { itemId: t1.id, body: 'x' }), (e) => e.status === 403);
  assert.ok(app.accessLog.list({ sourceId: src.id }).filter((l) => l.op === 'action.run').length >= 4);
});

test('the AI writes a reply only for mail it may see; the meeting recap becomes a draft to the people who were there', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'Rui <rui@x.pt>', 'ana@x.pt', 'Can you send the contract? Reply by Friday.');
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: {}, grant: { actions: ['gmail.draft'] } });
  await app.sources.sync(src.id);
  const it = app.items.byExternal(src.id, 'thread:t1');
  let seen = '';
  const llm = await startFakeLlm((m) => { seen = JSON.stringify(m); return 'Sure, Friday works.'; });
  t.after(() => llm.close());
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: remote(llm.url), model: 'fake-model' } });
  await assert.rejects(app.ai.draftReply(it.id), (e) => e.code === 'local-only', 'mail kept on this computer is not sent to a server elsewhere');
  assert.equal(seen, '');
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url } });
  assert.equal((await app.ai.draftReply(it.id, 'say yes')).text, 'Sure, Friday works.');
  assert.match(seen, /Can you send the contract/);
  app.settings.update({ google: { ...app.settings.get('google'), scopes: [READONLY, COMPOSE] } });
  const n = app.notes.create({ title: 'Kickoff', status: 'done', summary: 'We agreed to ship on Friday.' });
  const p = app.actions.propose('gmail.draft', { sourceId: src.id, to: ['rui@x.pt'], subject: 'Recap: Kickoff', body: n.summary, typedRecipients: ['rui@x.pt'] });
  assert.equal(p.flags.length, 0);
  assert.equal(p.args.threadId, undefined, 'a new message, not a reply');
});

test('rules on mail: a fixed structure, one bulk proposal per run for every thread that matches, never repeated, and only what the grant allows', async (t) => {
  const { validateSpec } = require('../src/brain/rules');
  assert.throws(() => validateSpec({ when: 'mail.received', if: {}, then: { action: 'propose.gmail.archive' } }), /at least one condition/);
  assert.throws(() => validateSpec({ when: 'mail.received', if: { newsletter: true }, then: { action: 'propose.linear.issue' } }), /only propose labelling/);
  assert.throws(() => validateSpec({ when: 'promise.accepted', if: {}, then: { action: 'propose.gmail.archive' } }), /for rules on mail/);
  assert.throws(() => validateSpec({ when: 'mail.received', if: { newsletter: true }, then: { action: 'propose.gmail.label', labels: [] } }), /Which label/);
  const g = await fakeGmail(); t.after(() => g.close());
  g.threads.t1 = thread('t1', 'News <n@shop.com>', 'ana@x.pt', 'sale', { subject: 'Weekly deals', unsubscribe: true });
  g.threads.t2 = thread('t2', 'Promo <p@shop.com>', 'ana@x.pt', 'more', { subject: 'More deals', unsubscribe: true });
  g.threads.t3 = thread('t3', 'Rui <rui@x.pt>', 'ana@x.pt', 'real mail', { subject: 'Contract' });
  const app = await boot(t, g);
  app.settings.update({ google: { ...app.settings.get('google'), scopes: [READONLY, MODIFY] } });
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: {}, grant: { actions: ['gmail.label'] } });
  const rule = app.rules.create('label newsletters', { when: 'mail.received', if: { newsletter: true }, then: { action: 'propose.gmail.label', labels: ['Newsletters'] } });
  assert.match(rule.explain, /newsletter/);
  await app.sources.sync(src.id);
  const pending = app.actions.pending().filter((a) => a.kind === 'gmail.label');
  assert.equal(pending.length, 1, 'one proposal for both newsletters, not one each');
  assert.deepEqual(pending[0].args.threads.map((x) => x.id).sort(), ['t1', 't2']);
  assert.equal(pending[0].origin, 'rule');
  app.rules.runMail();
  assert.equal(app.actions.pending().filter((a) => a.kind === 'gmail.label').length, 1, 'not proposed again');
  assert.equal(app.rules.preview(rule.spec).count, 2);
  // a source whose grant does not allow it: skipped, not proposed
  app.items.setGrant(src.id, { actions: [] });
  g.threads.t4 = thread('t4', 'News <n@shop.com>', 'ana@x.pt', 'again', { subject: 'Deals 3', unsubscribe: true });
  g.event('messageAdded', 't4');
  await app.sources.sync(src.id);
  assert.equal(app.actions.pending().filter((a) => a.kind === 'gmail.label').length, 1);
  assert.ok(app.db.prepare("SELECT outcome FROM rule_runs WHERE outcome LIKE 'skipped%'").get());
});
