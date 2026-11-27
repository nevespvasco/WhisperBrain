'use strict';
// The IMAP client, the SMTP client and the IMAP connector, against SIMULATED servers (test/imap-fakes.js) that speak enough of the
// protocols: literals, UIDVALIDITY, CONDSTORE, MOVE, UIDPLUS, XOAUTH2, STARTTLS. They prove the code's logic; real servers differ.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { ItemStore } = require('../src/items/store');
const imap = require('../src/connectors/imap');
const { ImapClient, qs, uidSet, parseUidSet, encodeMailbox, decodeMailbox, takeResponse, parseResponse } = require('../src/connectors/imap-client');
const { SmtpClient } = require('../src/connectors/smtp-client');
const { parseMessage, composeMessage } = require('../src/importers/mime');
const { fakeImap, fakeSmtp, mail, selfSigned } = require('./imap-fakes');

const HOUR = 3600_000;
const ago = (h) => Date.now() - h * HOUR;
const dateHeader = (ms) => new Date(ms).toUTCString().replace('GMT', '+0000');
// deliver a message that arrived `h` hours ago (the Date header and the server's internal date agree)
const put = (g, box, spec, h = 1, flags = []) => g.deliver(box, mail({ ...spec, date: dateHeader(ago(h)) }), { flags, date: ago(h) });

const client = async (g, opts = {}) => { const c = new ImapClient({ host: '127.0.0.1', port: g.port, tls: false, user: g.user, password: g.pass, ...opts }); await c.connect(); await c.login(); return c; };

// ---------- the client ----------
test('helpers: quoted strings or literals, uid sets, modified UTF-7 mailbox names', () => {
  assert.equal(qs('INBOX'), '"INBOX"');
  assert.equal(qs('a"b\\c'), '"a\\"b\\\\c"');
  assert.ok(Buffer.isBuffer(qs('Caixa de entrada: ação')), 'non-ASCII goes as a literal');
  assert.equal(uidSet([5, 1, 2, 3, 9, 10]), '1:3,5,9:10');
  assert.deepEqual(parseUidSet('1:3,5'), [1, 2, 3, 5]);
  assert.equal(encodeMailbox('Enviados & Arquivo'), 'Enviados &- Arquivo');
  assert.equal(encodeMailbox('Caixa de Saída'), 'Caixa de Sa&AO0-da');
  assert.equal(decodeMailbox('Caixa de Sa&AO0-da'), 'Caixa de Saída');
  assert.equal(decodeMailbox(encodeMailbox('日本語/メール')), '日本語/メール');
});

test('responses: a literal inside a response, lists, quoted strings, NIL and bracketed sections are read', () => {
  const buf = Buffer.from('* 3 FETCH (UID 7 FLAGS (\\Seen $x) INTERNALDATE "24-Nov-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM TO)] {11}\r\nFrom: a@b\r\n BODY[TEXT] NIL)\r\nA1 OK done\r\n', 'latin1');
  const r = takeResponse(buf);
  assert.ok(r && r.used < buf.length, 'one response off the front');
  const p = parseResponse(r.segments);
  assert.equal(p.kind, 'FETCH'); assert.equal(p.num, 3);
  const list = p.reader.next();
  assert.deepEqual(list.slice(0, 4), ['UID', '7', 'FLAGS', ['\\Seen', '$x']]);
  assert.equal(list[4], 'INTERNALDATE'); assert.equal(list[5], '24-Nov-2026 10:00:00 +0000');
  assert.equal(list[6], 'BODY[HEADER.FIELDS (FROM TO)]');
  assert.equal(list[7].toString(), 'From: a@b\r\n');
  assert.equal(list[9], null);
  assert.equal(takeResponse(buf.subarray(0, 40)), null, 'incomplete: waits');
  const tagged = parseResponse(takeResponse(Buffer.from('A5 NO [AUTHENTICATIONFAILED] bad\r\n')).segments);
  assert.deepEqual([tagged.tag, tagged.status, tagged.code.name, tagged.text], ['A5', 'NO', 'AUTHENTICATIONFAILED', 'bad']);
});

test('client: login, list with special-use, select with UIDVALIDITY/MODSEQ, search, fetch headers and bodies with literals', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  g.deliver('INBOX', mail({ id: 'a@x', body: 'line one\n.\nline three\n{5}' }));
  g.deliver('INBOX', mail({ id: 'b@x', subject: 'Second', from: 'Eva <eva@y.pt>' }), { flags: ['\\Seen'] });
  const c = await client(g); t.after(() => c.close());
  assert.ok(c.caps.has('CONDSTORE') && c.caps.has('UIDPLUS'));
  const boxes = await c.list();
  assert.deepEqual(boxes.find((b) => b.name === 'Sent').specialUse, '\\Sent');
  const info = await c.select('INBOX', { readOnly: true });
  assert.deepEqual([info.exists, info.uidValidity, info.uidNext, info.highestModSeq], [2, 1, 3, 3]);
  assert.deepEqual(await c.search(['ALL']), [1, 2]);
  assert.deepEqual(await c.search(['UID', '2:*']), [2]);
  assert.deepEqual(await c.search(['HEADER', 'Message-ID', qs('b@x')]), [2]);
  const msgs = await c.fetch('1:2', 'UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)] BODY.PEEK[TEXT]');
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[1].flags, ['\\Seen']);
  assert.equal(msgs[1].headers.toString().includes('Subject: Second'), true);
  assert.equal(msgs[1].headers.toString().includes('Message-ID'), false, 'only the fields asked for');
  assert.ok(msgs[0].text.toString().includes('line one\r\n.\r\nline three\r\n{5}'), 'a body that looks like a protocol line is still just body');
  assert.ok(msgs[0].internalDate > 0 && msgs[0].size > 50);
  const part = await c.fetch('1', 'UID BODY.PEEK[]<0.60>');
  assert.equal(part[0].raw.length, 60, 'a partial fetch');
  assert.ok(!g.log.some((l) => /BODY\[/.test(l) && !/PEEK/.test(l)), 'always BODY.PEEK: nothing is marked read');
  assert.equal([...g.boxes.get('INBOX').msgs[0].flags].includes('\\Seen'), false);
});

test('client: a wrong password is an authentication error that is not retried blindly; a plain connection to a remote host is refused', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  const c = new ImapClient({ host: '127.0.0.1', port: g.port, tls: false, user: g.user, password: 'nope' });
  await c.connect();
  await assert.rejects(c.login(), (e) => e.code === 'imap-auth' && /Invalid credentials/.test(e.message));
  c.close();
  const { isLoopback } = require('../src/connectors/imap-client');
  assert.equal(isLoopback('127.0.0.1') && isLoopback('localhost') && isLoopback('::1'), true);
  assert.equal(isLoopback('mail.example.com'), false, 'the password would cross the network in clear: refused unless STARTTLS');
});

test('client: XOAUTH2 with SASL-IR, without it, and the server\'s error report answered empty', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  let c = await client(g, { authMethod: 'xoauth2', accessToken: g.token, password: undefined });
  assert.ok(c.caps.size); c.close();
  const g2 = await fakeImap({ caps: ['IMAP4rev1', 'UIDPLUS'] }); t.after(() => g2.close());
  c = await client(g2, { authMethod: 'xoauth2', accessToken: g2.token }); c.close();
  assert.ok(g2.log.some((l) => /^AUTHENTICATE/.test(l)));
  const c3 = new ImapClient({ host: '127.0.0.1', port: g.port, tls: false, user: g.user, authMethod: 'xoauth2', accessToken: 'expired' });
  await c3.connect();
  await assert.rejects(c3.login(), (e) => e.code === 'imap-auth');
  c3.close();
});

test('client: flags, copy, move (with MOVE, and without it), and a draft appended with a literal', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  for (let i = 1; i <= 3; i++) g.deliver('INBOX', mail({ id: `m${i}@x` }));
  const c = await client(g); t.after(() => c.close());
  await c.select('INBOX');
  await c.store('1:2', '+FLAGS', ['\\Seen', '$Label1']);
  assert.deepEqual([...g.boxes.get('INBOX').msgs[0].flags].sort(), ['$Label1', '\\Seen']);
  await c.store('1', '-FLAGS', ['\\Seen']);
  assert.equal(g.boxes.get('INBOX').msgs[0].flags.has('\\Seen'), false);
  const cp = await c.copy('3', 'Archive');
  assert.equal(cp.to, '1');
  assert.equal(g.boxes.get('Archive').msgs.length, 1);
  assert.equal(g.boxes.get('INBOX').msgs.length, 3, 'copy keeps it');
  assert.deepEqual(await c.move('1', 'Archive'), { expunged: true });
  assert.equal(g.boxes.get('INBOX').msgs.length, 2);
  assert.ok(g.log.some((l) => l.startsWith('UID MOVE')));
  // a server without MOVE: copy, flag, expunge exactly those uids (UIDPLUS) - or leave them flagged
  const g2 = await fakeImap({ caps: ['IMAP4rev1', 'UIDPLUS'] }); t.after(() => g2.close());
  for (let i = 1; i <= 2; i++) g2.deliver('INBOX', mail({ id: `n${i}@x` }));
  g2.flag('INBOX', 2, ['\\Deleted']);                       // someone else's pending deletion: must not be expunged by our move
  const c2 = await client(g2); t.after(() => c2.close());
  await c2.select('INBOX');
  assert.deepEqual(await c2.move('1', 'Archive'), { expunged: true });
  assert.deepEqual(g2.boxes.get('INBOX').msgs.map((m) => m.uid), [2], 'only the moved uid went; the other deleted one was not expunged');
  const g3 = await fakeImap({ caps: ['IMAP4rev1'] }); t.after(() => g3.close());
  g3.deliver('INBOX', mail({ id: 'z@x' }));
  const c3 = await client(g3); t.after(() => c3.close());
  await c3.select('INBOX');
  assert.deepEqual(await c3.move('1', 'Archive'), { expunged: false }, 'no UIDPLUS: left flagged, never a blanket EXPUNGE');
  assert.ok(g3.boxes.get('INBOX').msgs[0].flags.has('\\Deleted'));
  // a draft with accents: a literal, with the \Draft flag
  const draft = composeMessage({ from: { name: 'Ana', address: 'ana@x.pt' }, to: [{ name: 'Rui', address: 'rui@x.pt' }], subject: 'Re: Contrato', text: 'Olá Rui,\nenvio amanhã.', inReplyTo: '<a@x>', references: ['<a@x>'] });
  const r = await c.append('Drafts', draft, { flags: ['\\Draft'] });
  assert.deepEqual(r, { uidValidity: 1, uid: 1 });
  const stored = g.appended[0];
  assert.deepEqual(stored.flags, ['\\Draft']);
  const back = parseMessage(stored.raw);
  assert.equal(back.text, 'Olá Rui,\nenvio amanhã.');
  assert.equal(back.subject, 'Re: Contrato');
  assert.deepEqual(back.references, ['a@x']);
});

// ---------- the connector ----------
function setup(g, { grant = { readLevel: 'part' }, config = {}, account = {} } = {}) {
  const store = new ItemStore(open(':memory:'));
  const acct = { id: 'a1', label: 'Work', host: '127.0.0.1', port: g.port, tls: false, user: g.user, password: g.pass, authMethod: 'password', ...account };
  const accounts = [acct];
  const src = store.addSource({ kind: 'imap', name: 'Mail', mode: 'copy', config: { remote: true, account: 'a1', ...config }, grant });
  const ctx = { settings: { get: (k) => (k === 'imapAccounts' ? accounts : undefined), update: (p) => { if (p.imapAccounts) accounts.splice(0, accounts.length, ...p.imapAccounts); } }, items: store };
  const live = () => store.source(src.id);
  const run = (budget) => imap.sync({ ...ctx, source: live(), items: store, budget });
  return { store, src, ctx, live, run, accounts, key: (rootId) => `thread:m:${Buffer.from(rootId).toString('base64url')}` };
}

test('metadata level: only header fields are ever requested; the body does not leave the server', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  put(g, 'INBOX', { id: 'a@x', body: 'BODYSECRET one', extra: ['List-Unsubscribe: <mailto:u@x>'] });
  put(g, 'INBOX', { id: 'b@x', subject: 'Other', from: 'Eva <eva@y.pt>', body: 'BODYSECRET two' });
  const s = setup(g, { grant: { readLevel: 'metadata', filter: { never: { domains: ['y.pt'] } } } });
  const r = await s.run();
  assert.equal(r.created, 1, 'the never-read domain is kept out');
  const it = s.store.byExternal(s.src.id, s.key('a@x'));
  assert.equal(it.text, '');
  assert.equal(it.title, 'Contract terms');
  assert.equal(it.meta.metadataOnly, true);
  assert.equal(it.meta.lastAsksSomething, null);
  assert.equal(it.meta.newsletter, true, 'List-Unsubscribe is a header: known at this level');
  assert.ok(!JSON.stringify(it).includes('BODYSECRET'));
  assert.ok(g.log.every((l) => !/BODY\.PEEK\[\]|BODY\.PEEK\[TEXT\]/.test(l)), 'no body or whole message was requested');
  assert.ok(g.log.some((l) => l.includes('HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE)')));
  assert.deepEqual(await imap.searchLive({ ctx: s.ctx, source: { ...s.live(), liveSearch: true }, query: 'BODYSECRET' }), []);
});

test('part level: a thread is one item across folders (References), a reply without headers joins by subject, the rest of the grant applies', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  put(g, 'INBOX', { id: 'root@x', from: 'Rui <rui@x.pt>', cc: 'Eva <eva@y.pt>', body: 'Can you send the contract?' }, 5);
  put(g, 'Sent', { id: 'r1@x', from: 'Ana Work <ana.work@x.pt>', to: 'rui@x.pt', subject: 'Re: Contract terms', refs: ['root@x'], inReplyTo: 'root@x', body: 'Sim, envio amanhã.\n\nDe: Rui <rui@x.pt>\nEnviado: segunda\nAssunto: x\n\ntexto antigo' }, 4);
  put(g, 'INBOX', { id: 'r2@x', from: 'Rui <rui@x.pt>', subject: 'Re: Contract terms', refs: ['root@x', 'r1@x'], inReplyTo: 'r1@x', body: 'Thanks! Do you need anything?\n> quoted' }, 3);
  put(g, 'INBOX', { id: 'solo@x', subject: 'Lunch', from: 'Eva <eva@y.pt>', body: 'lunch?' }, 6);
  put(g, 'INBOX', { id: 'lost@x', subject: 'RE: Lunch', from: 'Eva <eva@y.pt>', body: 'a reply that lost its References' }, 2);
  put(g, 'INBOX', { id: 'hr@x', subject: 'Offer', from: 'HR <hr@corp.pt>', body: 'salary' }, 7);
  put(g, 'INBOX', { id: 'lab@x', subject: 'Your lab results', from: 'Rui <rui@x.pt>', body: 'blood' }, 8);
  put(g, 'INBOX', { id: 'del@x', subject: 'Deleted one', body: 'x' }, 9, ['\\Deleted']);
  put(g, 'INBOX', { id: 'dr@x', subject: 'Draft one', body: 'x' }, 9, ['\\Draft']);
  put(g, 'Trash', { id: 'trash@x', subject: 'In trash', body: 'x' }, 9);
  const s = setup(g, { account: { aliases: ['ana.work@x.pt'] }, grant: { readLevel: 'part', filter: { never: { domains: ['corp.pt'], keywords: ['lab results'] } } } });
  const r = await s.run();
  assert.equal(r.errors, 0);
  const t1 = s.store.byExternal(s.src.id, s.key('root@x'));
  assert.equal(t1.meta.messages, 3, 'the question, the reply from Sent, the answer');
  assert.equal(t1.meta.lastFromMe, false);
  assert.ok(t1.meta.people.includes('eva@y.pt'), 'Cc counts');
  assert.ok(t1.text.includes('Sim, envio amanhã.') && !t1.text.includes('texto antigo') && !t1.text.includes('quoted'), 'quoted history is cut, also Outlook\'s De:/Enviado:');
  assert.equal(t1.meta.lastAsksSomething, true);
  assert.deepEqual(t1.meta.references, ['<root@x>', '<r1@x>']);
  assert.equal(t1.meta.lastMessageId, '<r2@x>');
  assert.equal(t1.meta.subject, 'Contract terms');
  assert.ok(t1.meta.labels.includes('INBOX') && t1.meta.labels.includes('Sent'));
  assert.equal(s.store.byExternal(s.src.id, s.key('solo@x')).meta.messages, 1);
  const lost = s.store.list({ sourceId: s.src.id }).find((x) => x.title === 'RE: Lunch');
  assert.ok(lost && lost.externalId.startsWith('thread:s:'), 'a "RE:" without headers is matched by subject');
  const titles = s.store.list({ sourceId: s.src.id }).map((x) => x.title).sort();
  assert.deepEqual(titles, ['Contract terms', 'Lunch', 'RE: Lunch']);
  assert.ok(!g.log.some((l) => /SELECT.*Trash|EXAMINE.*Trash/.test(l)), 'Trash is never opened');
  // an alias in the sender: "from me"
  put(g, 'Sent', { id: 'r3@x', from: 'Ana Work <ana.work@x.pt>', subject: 'Re: Contract terms', refs: ['root@x', 'r1@x', 'r2@x'], body: 'ok' }, 1);
  await s.run();
  const t2 = s.store.byExternal(s.src.id, s.key('root@x'));
  assert.equal(t2.meta.messages, 4);
  assert.equal(t2.meta.lastFromMe, true, 'an alias is from me');
});

test('the never-read list is checked here on every thread (a sensitive first message keeps the later replies out too)', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  put(g, 'INBOX', { id: 'hr1@x', subject: 'Offer', from: 'HR <hr@corp.pt>', body: 'salary' }, 5);
  put(g, 'INBOX', { id: 'hr2@x', subject: 'Re: Offer', from: 'Rui <rui@x.pt>', refs: ['hr1@x'], body: 'a colleague replied' }, 4);
  const s = setup(g, { grant: { readLevel: 'part', filter: { never: { senders: ['hr@corp.pt'] } } } });
  await s.run();
  assert.equal(s.store.count(), 0);
  put(g, 'INBOX', { id: 'hr3@x', subject: 'Re: Offer', from: 'Eva <eva@y.pt>', refs: ['hr1@x', 'hr2@x'], body: 'another reply, later' }, 1);
  await s.run();
  assert.equal(s.store.count(), 0, 'the thread is read whole every time, so the root is found again');
});

test('a big mailbox is read newest first across runs, new mail is always read first, nothing is skipped', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  for (let i = 1; i <= 7; i++) put(g, 'INBOX', { id: `m${i}@x`, subject: `Subject ${i}`, body: `hello ${i}` }, 100 - i);
  const s = setup(g, { config: { folders: ['INBOX'] } });
  await s.run(3);
  assert.deepEqual(s.store.list({ sourceId: s.src.id }).map((x) => x.title).sort(), ['Subject 5', 'Subject 6', 'Subject 7'], 'the three newest');
  let cur = imap.readCursor(s.live().cursor);
  assert.ok(cur.resync && cur.f.INBOX.lo === 5 && cur.f.INBOX.hi === 7);
  put(g, 'INBOX', { id: 'new@x', subject: 'Brand new', body: 'just arrived' }, 0.1);
  await s.run(3);                                         // the new one first, then two older ones
  assert.ok(s.store.list({ sourceId: s.src.id }).some((x) => x.title === 'Brand new'));
  assert.equal(s.store.count(), 6);
  await s.run(3);
  assert.equal(s.store.count(), 8, 'all of them, none skipped');
  cur = imap.readCursor(s.live().cursor);
  assert.equal(cur.f.INBOX.lo, 0);
  assert.equal(cur.resync, false);
  assert.equal(cur.f.INBOX.uv, 1);
});

test('mail that goes away: an expunged message shrinks its thread, the last one tombstones it; a deleted flag counts too (with CONDSTORE and without)', async (t) => {
  for (const caps of [['IMAP4rev1', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'SASL-IR'], ['IMAP4rev1', 'UIDPLUS']]) {
    const g = await fakeImap({ caps }); t.after(() => g.close());
    put(g, 'INBOX', { id: 'a@x', subject: 'Plan', body: 'first' }, 5);
    put(g, 'INBOX', { id: 'b@x', subject: 'Re: Plan', refs: ['a@x'], body: 'second' }, 4);
    put(g, 'INBOX', { id: 'c@x', subject: 'Other', body: 'other' }, 3);
    put(g, 'INBOX', { id: 'd@x', subject: 'Third', body: 'third' }, 2);
    const s = setup(g, { config: { folders: ['INBOX'] } });
    await s.run();
    assert.equal(s.store.count(), 3);
    g.expunge('INBOX', 2);                                           // one message of the thread is deleted for good
    await s.run();
    assert.equal(s.store.byExternal(s.src.id, s.key('a@x')).meta.messages, 1);
    g.flag('INBOX', 3, ['\\Deleted']);                               // flagged for deletion, not yet expunged
    await s.run();
    assert.ok(s.store.byExternal(s.src.id, s.key('c@x')).deletedAt, `deleted flag noticed (${caps.includes('CONDSTORE') ? 'CONDSTORE' : 'DELETED search'})`);
    g.expunge('INBOX', 1);
    await s.run();
    assert.ok(s.store.byExternal(s.src.id, s.key('a@x')).deletedAt, 'nothing left of the thread');
    assert.equal(s.store.byExternal(s.src.id, s.key('d@x')).deletedAt, null);
    const before = g.log.length;
    await s.run();
    const idle = g.log.slice(before).filter((l) => /^UID (FETCH|SEARCH)/.test(l));
    assert.ok(idle.length <= 3, `an idle run asks little (${idle.length} lookups)`);
  }
});

test('UIDVALIDITY changed: every uid is meaningless, everything is read again and what is gone is tombstoned', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  put(g, 'INBOX', { id: 'a@x', subject: 'Stays', body: 'stays' }, 5);
  put(g, 'INBOX', { id: 'b@x', subject: 'Goes', body: 'goes' }, 4);
  const s = setup(g, { config: { folders: ['INBOX'] } });
  await s.run();
  assert.equal(s.store.count(), 2);
  g.resetBox('INBOX');                                               // the server rebuilt the mailbox: new UIDVALIDITY, uids from 1 again
  put(g, 'INBOX', { id: 'a@x', subject: 'Stays', body: 'stays' }, 5);
  put(g, 'INBOX', { id: 'n@x', subject: 'New', body: 'new' }, 1);
  const r = await s.run();
  assert.equal(s.store.byExternal(s.src.id, s.key('b@x')).deletedAt !== null, true, 'not in the new mailbox');
  assert.equal(s.store.byExternal(s.src.id, s.key('a@x')).deletedAt, null);
  assert.ok(s.store.byExternal(s.src.id, s.key('n@x')));
  assert.equal(r.removed, 1);
  const cur = imap.readCursor(s.live().cursor);
  assert.equal(cur.f.INBOX.uv, 2);
  assert.equal(cur.resync, false);
  assert.deepEqual(s.store.byExternal(s.src.id, s.key('a@x')).meta.refs, [{ f: 'INBOX', v: 2, u: 1 }], 'the thread now remembers the new uids');
});

test('a changed grant filter or level starts a fresh read under the new rules', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  put(g, 'INBOX', { id: 'a@x', subject: 'Mine', from: 'Rui <rui@x.pt>', body: 'a' }, 3);
  put(g, 'INBOX', { id: 'b@x', subject: 'Theirs', from: 'Eva <eva@y.pt>', body: 'b' }, 2);
  const s = setup(g, { config: { folders: ['INBOX'] } });
  await s.run();
  assert.equal(s.store.count(), 2);
  s.store.setGrant(s.src.id, { filter: { fromDomains: ['x.pt'] } });
  await s.run();
  assert.equal(s.store.byExternal(s.src.id, s.key('b@x')).deletedAt !== null, true);
  assert.equal(s.store.byExternal(s.src.id, s.key('a@x')).deletedAt, null);
});

test('live search: Gmail\'s own syntax on a Gmail server, TEXT/FROM/SUBJECT elsewhere; only when allowed; hits are filtered; opening gives an item', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  put(g, 'INBOX', { id: 'a@x', subject: 'Budget 2027', body: 'the budget plan' }, 5);
  put(g, 'Sent', { id: 'b@x', subject: 'Re: Budget 2027', from: 'Ana <ana@x.pt>', to: 'rui@x.pt', refs: ['a@x'], body: 'budget ok' }, 4);
  put(g, 'INBOX', { id: 'hr@x', subject: 'Budget for HR', from: 'HR <hr@corp.pt>', body: 'budget salary' }, 3);
  put(g, 'INBOX', { id: 'e@x', subject: 'Budget lunch', from: 'Eva <eva@y.pt>', body: 'budget lunch' }, 2);
  put(g, 'INBOX', { id: 'other@x', subject: 'Nothing', body: 'unrelated' }, 2);
  const s = setup(g, { grant: { readLevel: 'part', liveSearch: true, filter: { never: { domains: ['corp.pt'] } } } });
  const hits = await imap.searchLive({ ctx: s.ctx, source: s.live(), query: 'budget', limit: 10 });
  assert.deepEqual(hits.map((h) => h.title), ['Budget lunch', 'Re: Budget 2027'], 'newest first, one per thread, never-read left out');
  assert.deepEqual(Object.keys(hits[0]).sort(), ['at', 'externalId', 'from', 'snippet', 'title', 'uri']);
  assert.ok(hits[0].snippet.includes('budget lunch'));
  assert.ok(g.log.some((l) => /OR OR TEXT "budget" FROM "budget" SUBJECT "budget"/.test(l)), 'TEXT, FROM, SUBJECT');
  assert.ok(!g.log.some((l) => /X-GM-RAW/.test(l)));
  // the thread the hit names can be opened (read whole)
  const item = await imap.openLive({ ctx: s.ctx, source: s.live(), externalId: hits[1].externalId });
  assert.equal(item.meta.messages, 2);
  assert.ok(item.text.includes('the budget plan') && item.text.includes('budget ok'));
  assert.equal(s.store.upsert(s.src.id, item).action, 'created');
  // not allowed: nothing is sent
  s.store.setGrant(s.src.id, { liveSearch: false });
  const n = g.log.length;
  assert.deepEqual(await imap.searchLive({ ctx: s.ctx, source: s.live(), query: 'budget' }), []);
  assert.equal(g.log.length, n);
  // a Gmail server
  const gm = await fakeImap({ caps: ['IMAP4rev1', 'UIDPLUS', 'X-GM-EXT-1'] }); t.after(() => gm.close());
  put(gm, 'INBOX', { id: 'a@x', subject: 'Budget', body: 'budget' }, 1);
  const s2 = setup(gm, { grant: { readLevel: 'part', liveSearch: true }, config: { folders: ['INBOX'] } });
  assert.equal((await imap.searchLive({ ctx: s2.ctx, source: s2.live(), query: 'from:rui budget' })).length, 0, 'the fake only does substring: but the criteria is Gmail\'s');
  assert.ok(gm.log.some((l) => /X-GM-RAW "from:rui budget"/.test(l)));
});

test('an XOAUTH2 account refreshes its access token (kept for next time); an expired sign-in is permanent', async () => {
  const saved = [];
  const ctx = { settings: { get: () => [], update: (p) => saved.push(p) }, imapAccounts: { save: (id, patch) => saved.push({ id, patch }) }, fetchImpl: async (url, init) => ({ ok: true, status: 200, json: async () => ({ access_token: 'fresh', expires_in: 3600, refresh_token: 'r2', echo: String(init.body) }) }) };
  const account = { id: 'a1', authMethod: 'xoauth2', accessToken: 'old', expiresAt: Date.now() - 1000, refreshToken: 'r1', tokenUrl: 'https://login.example/token', clientId: 'cid', oauthScope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access' };
  assert.equal(await imap.accessTokenOf(ctx, account), 'fresh');
  assert.equal(saved[0].patch.accessToken, 'fresh');
  assert.equal(saved[0].patch.refreshToken, 'r2');
  assert.equal(await imap.accessTokenOf(ctx, { ...account, accessToken: 'still-good', expiresAt: Date.now() + 3600_000 }), 'still-good');
  const bad = { ...ctx, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }) };
  await assert.rejects(imap.accessTokenOf(bad, account), (e) => e.permanent === true && /sign in again/.test(e.message));
});

test('validate, ready, filters', () => {
  assert.deepEqual(imap.validate({}), { account: '', days: 90, folders: ['INBOX', '\\Sent'], aliases: [] });
  assert.equal(imap.validate({ days: 99999 }).days, 3650);
  const f = imap.compileFilter({ days: 30 }, { labels: ['x'], never: { domains: ['corp.pt'] } }, { now: Date.parse('2026-11-27T12:00:00Z') });
  assert.equal(f.since, '28-Oct-2026');
  assert.deepEqual(f.never, { domains: ['corp.pt'] });
  const ctx = { settings: { get: () => [{ id: 'a', host: 'h', user: 'u', password: 'p' }, { id: 'b', host: 'h', user: 'u', authMethod: 'xoauth2' }] } };
  assert.equal(imap.ready(ctx, { account: 'a' }), true);
  assert.equal(imap.ready(ctx, { account: 'b' }), false, 'no token yet');
  assert.equal(imap.ready(ctx, { account: 'zzz' }), false);
  assert.equal(imap.ready(ctx, {}), false, 'two accounts: which one?');
});

test('check and estimate', async (t) => {
  const g = await fakeImap(); t.after(() => g.close());
  for (let i = 0; i < 5; i++) put(g, 'INBOX', { id: `m${i}@x`, subject: `s${i}` }, i + 1);
  const s = setup(g);
  const c = await imap.check(s.ctx, s.live());
  assert.equal(c.ok, true);
  assert.deepEqual(c.capabilities, { condstore: true, move: true, uidplus: true, gmail: false });
  assert.ok(c.folders.includes('INBOX'));
  const e = await imap.estimate(s.ctx, s.live());
  assert.equal(e.messages, 5);
  assert.ok('megabytes' in e && 'hours' in e && e.threads === 2);
});

// ---------- SMTP ----------
test('smtp: AUTH PLAIN, LOGIN and XOAUTH2, dot-stuffing, a refused recipient, and values that could add a command are refused', async (t) => {
  const g = await fakeSmtp(); t.after(() => g.close());
  const msg = composeMessage({ from: { name: 'Ana', address: 'ana@x.pt' }, to: [{ address: 'rui@x.pt' }, { address: 'refused@x.pt' }], subject: 'Hello', text: 'one\n.\n..two\nthree' });
  for (const [authMethod, extra] of [['plain', {}], ['login', {}], ['xoauth2', { password: undefined, accessToken: 'tok-1' }]]) {
    const c = new SmtpClient({ host: '127.0.0.1', port: g.port, security: 'none', user: 'ana@x.pt', password: 'secret', authMethod, ...extra });
    await c.connect(); await c.login();
    const r = await c.send({ from: 'ana@x.pt', to: ['rui@x.pt', 'refused@x.pt'], message: msg });
    assert.deepEqual(r.accepted, ['rui@x.pt']);
    assert.equal(r.rejected.length, 1);
    await c.quit();
  }
  assert.equal(g.mails.length, 3);
  const m = g.mails[0];
  assert.ok(m.data.includes('one\r\n.\r\n..two\r\nthree'), 'the body arrives exactly as written');
  assert.ok(m.rawStuffed.includes('one\r\n..\r\n...two'), 'dots were doubled on the wire');
  assert.ok(g.log.some((l) => l === 'AUTH PLAIN') && g.log.some((l) => l === 'AUTH LOGIN') && g.log.some((l) => l === 'AUTH XOAUTH2'));
  const c = new SmtpClient({ host: '127.0.0.1', port: g.port, security: 'none', user: 'ana@x.pt', password: 'secret' });
  await c.connect(); await c.login();
  await assert.rejects(c.send({ from: 'ana@x.pt\r\nRCPT TO:<evil@x.pt>', to: ['rui@x.pt'], message: 'x' }), (e) => e.code === 'bad-address');
  await assert.rejects(c.send({ from: 'ana@x.pt', to: ['refused@x.pt'], message: 'x' }), /refused every recipient/);
  c.close();
  const bad = new SmtpClient({ host: '127.0.0.1', port: g.port, security: 'none', user: 'ana@x.pt', password: 'wrong' });
  await bad.connect();
  await assert.rejects(bad.login(), (e) => e.code === 'smtp-auth');
  bad.close();
  const badTok = new SmtpClient({ host: '127.0.0.1', port: g.port, security: 'none', user: 'ana@x.pt', authMethod: 'xoauth2', accessToken: 'expired' });
  await badTok.connect();
  await assert.rejects(badTok.login(), (e) => e.code === 'smtp-auth');
  badTok.close();
});

test('composeMessage: accents, header injection, Message-ID and threading headers', () => {
  const raw = composeMessage({ from: { name: 'Ana "A" Costa', address: 'ana@x.pt' }, to: [{ name: 'João', address: 'joao@x.pt' }], subject: 'Olá\r\nBcc: evil@x.pt', text: 'corpo', inReplyTo: '<a@x>' }).toString('latin1');
  assert.ok(!/^Bcc:/m.test(raw), 'a subject cannot add a header');
  const p = parseMessage(raw);
  assert.equal(p.to[0].name, 'João');
  assert.equal(p.from.name, 'Ana "A" Costa');
  assert.ok(p.subject.startsWith('Olá'));
  assert.ok(/^Message-ID: <[0-9a-f]+@whisperbrain\.local>$/m.test(raw));
  assert.equal(p.inReplyTo, 'a@x');
});

// ---------- TLS (needs the openssl command for a throwaway certificate) ----------
const cert = selfSigned();
test('TLS: a certificate that is not trusted is refused by default; with its authority it is accepted; STARTTLS upgrades before any password', { skip: !cert && 'openssl not available' }, async (t) => {
  const g = await fakeImap({ tlsOptions: cert }); t.after(() => g.close());
  const refused = new ImapClient({ host: '127.0.0.1', port: g.port, tls: true, user: g.user, password: g.pass });
  await assert.rejects(refused.connect(), /Cannot reach|certificate|TLS/i);
  refused.close();
  const trusted = new ImapClient({ host: '127.0.0.1', port: g.port, tls: true, user: g.user, password: g.pass, ca: cert.cert });
  await trusted.connect(); await trusted.login();
  assert.ok((await trusted.list()).length > 0);
  trusted.close();
  // STARTTLS
  const s = await fakeImap({ tlsOptions: cert, starttls: true }); t.after(() => s.close());
  const up = new ImapClient({ host: '127.0.0.1', port: s.port, tls: false, user: s.user, password: s.pass, ca: cert.cert });
  await up.connect(); await up.login();
  assert.equal(up.tlsActive, true);
  assert.ok((await up.list()).length > 0);
  up.close();
  // SMTP: implicit TLS and STARTTLS
  const m = await fakeSmtp({ tlsOptions: cert }); t.after(() => m.close());
  const c1 = new SmtpClient({ host: '127.0.0.1', port: m.port, security: 'tls', user: 'ana@x.pt', password: 'secret' });
  await assert.rejects(c1.connect(), /Cannot reach|certificate|TLS/i);
  c1.close();
  const c2 = new SmtpClient({ host: '127.0.0.1', port: m.port, security: 'tls', user: 'ana@x.pt', password: 'secret', ca: cert.cert });
  await c2.connect(); await c2.login();
  assert.deepEqual((await c2.send({ from: 'ana@x.pt', to: ['rui@x.pt'], message: 'Subject: x\r\n\r\nhi' })).accepted, ['rui@x.pt']);
  c2.close();
  const m2 = await fakeSmtp({ tlsOptions: cert, starttls: true }); t.after(() => m2.close());
  const c3 = new SmtpClient({ host: '127.0.0.1', port: m2.port, security: 'starttls', user: 'ana@x.pt', password: 'secret' });
  await assert.rejects(c3.connect(), /certificate|TLS/i, 'STARTTLS with an untrusted certificate is refused too');
  c3.close();
  const c4 = new SmtpClient({ host: '127.0.0.1', port: m2.port, security: 'starttls', user: 'ana@x.pt', password: 'secret', ca: cert.cert });
  await c4.connect(); await c4.login();
  assert.equal(m2.log.includes('STARTTLS'), true);
  assert.deepEqual((await c4.send({ from: 'ana@x.pt', to: ['rui@x.pt'], message: 'Subject: x\r\n\r\nhi' })).accepted, ['rui@x.pt']);
  c4.close();
});

// ---------- the settings that hold the accounts ----------
test('settings: IMAP passwords and Outlook tokens are sealed secrets, masked in the public view, and a masked value written back means unchanged', async () => {
  const { Settings, MASK } = require('../src/core/settings');
  const { SecretBox } = require('../src/core/secret-box');
  const box = new SecretBox({ kind: 'fake', strength: 'strong', encrypt: async (s) => Buffer.from(`#${Buffer.from(s).reverse().toString('latin1')}`, 'latin1'), decrypt: async (b) => Buffer.from(b.toString('latin1').slice(1), 'latin1').reverse().toString() });
  const db = open(':memory:');
  const s = new Settings(db, null, box);
  await s.init();
  s.update({ outlook: { clientId: 'c', refreshToken: 'rt-secret', accessToken: 'at-secret', scopes: ['Mail.Read'], email: 'a@x.pt' },
    imapAccounts: [{ id: 'a1', label: 'Work', host: 'IMAP.Example.com', port: '993', user: 'ana', password: 'pw-secret', aliases: ['Ana.Work@X.pt'], smtp: { host: 'smtp.example.com', security: 'tls', port: 465 } },
      { id: 'a2', host: 'outlook.office365.com', user: 'ana@x.pt', authMethod: 'xoauth2', accessToken: 'imap-at', refreshToken: 'imap-rt' }] });
  await s.queue;                                                // the sealed writes
  const stored = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  for (const secret of ['rt-secret', 'at-secret', 'pw-secret', 'imap-at', 'imap-rt']) assert.ok(!Object.values(stored).some((v) => v.includes(secret)), `${secret} is not on disk in the clear`);
  const view = s.publicView();
  assert.equal(view.outlook.refreshToken, MASK); assert.equal(view.outlook.email, 'a@x.pt'); assert.deepEqual(view.outlook.scopes, ['Mail.Read']);
  assert.equal(view.imapAccounts[0].password, MASK); assert.equal(view.imapAccounts[1].accessToken, MASK); assert.equal(view.imapAccounts[1].password, '');
  assert.equal(view.imapAccounts[0].host, 'imap.example.com');
  assert.deepEqual(view.imapAccounts[0].aliases, ['ana.work@x.pt']);
  s.update({ outlook: view.outlook, imapAccounts: view.imapAccounts });          // the page sends back what it was given
  assert.equal(s.get('outlook').refreshToken, 'rt-secret');
  assert.equal(s.get('imapAccounts')[0].password, 'pw-secret');
  assert.equal(s.get('imapAccounts')[1].refreshToken, 'imap-rt');
  s.update({ imapAccounts: [{ ...view.imapAccounts[0], password: 'new-pw' }] });
  assert.equal(s.get('imapAccounts')[0].password, 'new-pw');
  assert.equal(s.get('imapAccounts').length, 1);
  assert.equal(s.get('outlook').tenant, 'common', 'personal accounts can sign in by default');
  assert.throws(() => s.update({ imapAccounts: 'nope' }), /imapAccounts must be a/);
  // a new start reads them back through the keystore
  await s.queue;
  const again = new Settings(db, null, box); await again.init();
  assert.equal(again.get('imapAccounts')[0].password, 'new-pw');
  assert.equal(again.get('outlook').accessToken, 'at-secret');
});
