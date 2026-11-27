'use strict';
// Gmail by access level, against a SIMULATED Gmail that follows the documented API (and, like the real one, refuses a search under the
// metadata scope). It proves the connector's logic; the real Gmail needs the person's own account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileQuery, neverRead, readCursor, writeCursor, threadItem } = require('../src/connectors/gmail');

const { fakePlatform, b64, mail, fakeGmail, boot } = require('./gmail-fake');

test('the Gmail search for a part: labels are any-of, exclusions and the never-read list go in, categories can be skipped', () => {
  assert.equal(compileQuery({ query: 'newer_than:30d' }), 'newer_than:30d');
  assert.equal(compileQuery({ query: 'newer_than:30d', labels: ['Work'] }), 'newer_than:30d label:Work');
  assert.equal(compileQuery({ query: '', labels: ['Work', 'Clients 2026'] }), '{label:Work label:"Clients 2026"}', 'labelIds would mean ALL of them');
  assert.equal(compileQuery({ query: 'in:anywhere' }, { excludeLabels: ['HR'], fromDomains: ['acme.io', 'b.pt'], never: { senders: ['boss@x.pt'], labels: ['Medical'] }, skipCategories: true }),
    'in:anywhere -label:HR -label:Medical {from:acme.io from:b.pt} -from:boss@x.pt -category:promotions -category:social -category:updates -category:forums');
  const m = mail('m', 'Doctor <dr@clinic.pt>', 'ana@x.pt', 'Results', { subject: 'Your lab results' });
  assert.equal(neverRead([m], { domains: ['clinic.pt'] }), true);
  assert.equal(neverRead([m], { keywords: ['LAB RESULTS'] }), true);
  assert.equal(neverRead([m], { senders: ['other@x.pt'] }), false);
  assert.deepEqual(readCursor('42'), { h: '42' }, 'an old cursor is read as before');
  assert.equal(writeCursor({ h: '42' }), '42');
  assert.deepEqual(readCursor(writeCursor({ h: '42', hp: '2' })), { h: '42', hp: '2' });
});

test('a thread: Cc counts as people, aliases count as me, the link opens the right account, quoted Outlook/pt-PT text is cut', () => {
  const t = { id: 'abc', historyId: '7', messages: [
    mail('1', 'Rui <rui@x.pt>', 'ana@x.pt', 'Can you?', { cc: 'Eva <eva@y.pt>' }),
    mail('2', 'Ana <ana.work@x.pt>', 'rui@x.pt', 'Sim, envio amanhã.\n\nDe: Rui <rui@x.pt>\nEnviado: segunda-feira\nAssunto: x\n\ntexto antigo'),
  ] };
  const it = threadItem(t, new Set(['ana@x.pt', 'ana.work@x.pt']), { account: 'ana@x.pt' });
  assert.ok(it.meta.people.includes('eva@y.pt'));
  assert.equal(it.meta.lastFromMe, true, 'a reply from an alias is from me');
  assert.match(it.uri, /authuser=ana%40x\.pt#all\/abc$/);
  assert.ok(it.text.includes('Sim, envio amanhã.') && !it.text.includes('texto antigo'));
});

test('metadata level: no search, no body, no snippet; the part is chosen by label here', async (t) => {
  const g = await fakeGmail({ scope: 'metadata' }); t.after(() => g.close());
  g.threads.t1 = { id: 't1', historyId: '90', messages: [mail('m1', 'Rui <rui@x.pt>', 'ana@x.pt', 'BODYSECRET one', { labels: ['INBOX', 'Label_work'] })] };
  g.threads.t2 = { id: 't2', historyId: '91', messages: [mail('m2', 'Eva <eva@y.pt>', 'ana@x.pt', 'BODYSECRET two', { labels: ['INBOX'] })] };
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' }, grant: { readLevel: 'metadata', filter: { labels: ['Label_work'] } } });
  const r = await app.sources.sync(src.id);
  assert.equal(r.created, 1, 'only the labelled thread');
  const it = app.items.byExternal(src.id, 'thread:t1');
  assert.equal(it.text, '');
  assert.equal(it.title, 'Contract terms');
  assert.ok(!JSON.stringify(it).includes('BODYSECRET') && !JSON.stringify(it).includes('snippet'), 'neither the body nor Gmail\'s snippet');
  assert.ok(g.log.every((l) => !l.includes('q=') && !l.includes('format=full')), 'never asks what the metadata scope forbids');
  assert.ok(g.log.some((l) => l.includes('metadataHeaders=From') && l.includes('metadataHeaders=Subject')));
});

test('history: every change type is asked for, a long history is read across runs without skipping, Trash and Spam are gone', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  for (const id of ['t1', 't2', 't3', 't4']) g.threads[id] = { id, historyId: '90', messages: [mail(`m${id}`, 'Rui <rui@x.pt>', 'ana@x.pt', `hello ${id}`)] };
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' } });
  await app.sources.sync(src.id);
  assert.equal(app.items.source(src.id).cursor, '100');
  // four changes; Gmail returns two per page; this run may read one page (budget 2)
  g.threads.t1.messages[0].labelIds = ['TRASH'];                      // trashed
  g.threads.t2.messages.push(mail('m2b', 'Ana <ana@x.pt>', 'rui@x.pt', 'reply'));
  g.threads.t3.messages[0].labelIds = ['SPAM'];
  delete g.threads.t4;                                                 // deleted for good
  g.event('labelAdded', 't1'); g.event('messageAdded', 't2'); g.event('labelAdded', 't3'); g.event('messageDeleted', 't4');
  const svc = app.sources.services.gmail;
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  const mid = app.items.source(src.id).cursor;
  assert.deepEqual(readCursor(mid), { h: '100', hp: '2' }, 'stopped at a page: the next run continues it, same start');
  assert.ok(g.log.some((l) => /historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved/.test(l)));
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  assert.equal(app.items.source(src.id).cursor, '104', 'only now fully read up to the newest history id');
  assert.ok(app.items.byExternal(src.id, 'thread:t1').deletedAt, 'trashed');
  assert.ok(app.items.byExternal(src.id, 'thread:t3').deletedAt, 'spam');
  assert.ok(app.items.byExternal(src.id, 'thread:t4').deletedAt, 'deleted');
  assert.equal(app.items.byExternal(src.id, 'thread:t2').meta.messages, 2);
});

test('a big first listing is read across runs, newest first, and the never-read list keeps threads out', async (t) => {
  const g = await fakeGmail(); t.after(() => g.close());
  g.pageSize = 2;
  for (let i = 1; i <= 5; i++) g.threads[`t${i}`] = { id: `t${i}`, historyId: '90', messages: [mail(`m${i}`, i === 3 ? 'HR <hr@corp.pt>' : 'Rui <rui@x.pt>', 'ana@x.pt', `hello ${i}`)] };
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: { query: 'newer_than:30d' }, grant: { filter: { never: { domains: ['corp.pt'] } } } });
  const svc = app.sources.services.gmail;
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  assert.deepEqual(readCursor(app.items.source(src.id).cursor), { lp: '2', lh: '100' });
  assert.ok(app.items.byExternal(src.id, 'thread:t5') && !app.items.byExternal(src.id, 'thread:t1'), 'newest first');
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  await svc.sync({ ...app.sources.ctx, source: app.items.source(src.id), items: app.items, budget: 2 });
  assert.equal(app.items.source(src.id).cursor, '100', 'listing done: history from before it started');
  assert.equal(app.items.byExternal(src.id, 'thread:t3'), null, 'never stored');
  assert.equal(app.items.list({ sourceId: src.id }).length, 4);
  assert.ok(g.log.some((l) => decodeURIComponent(l.replace(/\+/g, ' ')).includes('-from:corp.pt')), 'and asked Gmail to leave it out too');
});

test('a calendar invite in a mail carries its event id; old mail keeps less text; attachment text is read only when the source says so', async (t) => {
  const pdfBytes = Buffer.from('%PDF fake');
  const g = await fakeGmail(); t.after(() => g.close());
  const long = 'word '.repeat(4000);                                  // 20 000 characters
  const invite = { ...mail('mi', 'Rui <rui@x.pt>', 'ana@x.pt', 'Invitation: Kickoff'), payload: { headers: mail('mi', 'Rui <rui@x.pt>', 'ana@x.pt', 'x').payload.headers, mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64('Invitation: Kickoff') } }, { mimeType: 'text/calendar', body: { data: b64('BEGIN:VEVENT\nUID:evt-123@google.com\nSUMMARY:Kickoff\nEND:VEVENT') } }] } };
  g.threads.t1 = { id: 't1', historyId: '90', messages: [invite] };
  g.threads.t2 = { id: 't2', historyId: '91', messages: [mail('m2', 'Old <o@x.pt>', 'ana@x.pt', long, { at: Date.now() - 400 * 86_400_000, subject: 'Old' })] };
  g.threads.t3 = { id: 't3', historyId: '92', messages: [{ ...mail('m3', 'Rui <rui@x.pt>', 'ana@x.pt', 'See attached.', { subject: 'Contract' }), payload: { headers: mail('m3', 'Rui <rui@x.pt>', 'ana@x.pt', 'x', { subject: 'Contract' }).payload.headers, mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64('See attached.') } }, { mimeType: 'application/pdf', filename: 'terms.pdf', body: { attachmentId: 'att1', size: 9 } }] } }] };
  g.attachments.att1 = pdfBytes.toString('base64url');
  const app = await boot(t, g);
  const src = app.sources.addRemote({ kind: 'gmail', name: 'Mail', config: {} });
  await app.sources.sync(src.id);
  assert.deepEqual(app.items.byExternal(src.id, 'thread:t1').meta.invite, { uid: 'evt-123@google.com', summary: 'Kickoff' });
  const meeting = app.notes.create({ title: 'Kickoff', status: 'done', eventUid: 'evt-123@google.com' });
  const rel = await app.timeline.related(meeting.id);
  assert.ok(rel.some((r) => r.why === 'invite'), 'the invitation mail is tied to the event');
  assert.ok(app.items.byExternal(src.id, 'thread:t2').text.length <= 8000, 'old mail keeps a smaller text');
  assert.ok(app.items.byExternal(src.id, 'thread:t3').text.length < 200 && !app.items.byExternal(src.id, 'thread:t3').text.includes('terms.pdf'), 'attachments are names only by default');
  assert.deepEqual(app.items.byExternal(src.id, 'thread:t3').meta.attachments.map((a) => a.name), ['terms.pdf']);
  app.items.setGrant(src.id, { filter: { attachmentText: true } });
  g.event('messageAdded', 't3');
  await app.sources.services.gmail.sync({ ...app.sources.ctx, pdfToText: async () => 'The payment term is 30 days.', source: app.items.source(src.id), items: app.items, budget: 10 });
  assert.match(app.items.byExternal(src.id, 'thread:t3').text, /Attachment terms\.pdf:\nThe payment term is 30 days\./);
});
