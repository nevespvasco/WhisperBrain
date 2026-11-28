'use strict';
// The mbox importer (Google Takeout and others): splitting and mboxrd unescaping, threads, the grant (levels, filter, never-read),
// Spam/Trash, limits, and that chunk boundaries do not matter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { open } = require('../src/core/db');
const { ItemStore } = require('../src/items/store');
const { importMbox, readMbox, unescapeLine } = require('../src/importers/mbox');
const { tmpDir } = require('./helpers');

const msg = ({ id, from = 'Rui <rui@x.pt>', to = 'ana@x.pt', cc = '', subject = 'Contract terms', body = 'hello', refs = [], labels = '', thrid = '', date = 'Tue, 24 Nov 2026 10:00:00 +0000', extra = [], deliveredTo = '' } = {}) => [
  `From ${thrid || id}@xxx Tue Nov 24 10:00:00 +0000 2026`,
  ...(deliveredTo ? [`Delivered-To: ${deliveredTo}`] : []),
  `Message-ID: <${id}>`, ...(refs.length ? [`References: ${refs.map((r) => `<${r}>`).join(' ')}`, `In-Reply-To: <${refs[refs.length - 1]}>`] : []),
  ...(thrid ? [`X-GM-THRID: ${thrid}`] : []), ...(labels ? [`X-Gmail-Labels: ${labels}`] : []),
  `From: ${from}`, `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, `Date: ${date}`, 'Content-Type: text/plain; charset=utf-8', ...extra, '', body, '', ''].join('\n');
const mbox = (...ms) => ms.join('');
const stream = (s, size = 1 << 16) => Readable.from((function* () { const b = Buffer.from(s); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); })());
function setup(grant = { readLevel: 'part' }) {
  const store = new ItemStore(open(':memory:'));
  const src = store.addSource({ kind: 'mbox', name: 'Takeout', mode: 'copy', config: {}, grant });
  return { store, src, live: () => store.source(src.id), run: (o) => importMbox({ items: store, source: store.source(src.id), ...o }), titles: () => store.list({ sourceId: src.id }).map((x) => x.title).sort() };
}

test('splitting: "From " lines start messages, mboxrd escaping is undone, CRLF files and a missing final newline work', async () => {
  const a = msg({ id: 'a@x', body: 'one\n>From the start\n>>From deeper\nFrom: not a separator when no blank line before\n\nstill the same message' });
  const b = msg({ id: 'b@x', subject: 'Second' });
  for (const text of [mbox(a, b), mbox(a, b).replace(/\n/g, '\r\n'), mbox(a, b).trimEnd()]) {
    const got = [];
    for await (const m of readMbox(stream(text, 13))) got.push(m);
    assert.equal(got.length, 2);
    const first = got[0].raw.toString();
    assert.ok(first.includes('\nFrom the start') || first.includes('\r\nFrom the start'), '>From -> From');
    assert.ok(/>From deeper/.test(first) && !/>>From deeper/.test(first), '>>From -> >From');
    assert.ok(/Subject: Second/.test(got[1].raw.toString()));
    assert.ok(got[0].fromDate > 0, 'the date on the "From " line');
  }
  assert.equal(unescapeLine(Buffer.from('>From x\n')).toString(), 'From x\n');
  assert.equal(unescapeLine(Buffer.from('>quoted text\n')).toString(), '>quoted text\n');
  const one = [];
  for await (const m of readMbox(stream('Subject: just one message\n\nwith no From line\n'))) one.push(m);
  assert.equal(one.length, 1, 'a file that is a single message');
});

test('import: Takeout threads (X-GM-THRID), References, the subject fallback; people, aliases from Delivered-To, labels, attachments', async () => {
  const s = setup();
  const text = mbox(
    msg({ id: 'a1@x', thrid: '111', labels: 'Inbox,Important', cc: 'Eva <eva@y.pt>', body: 'Can you send the contract?', deliveredTo: 'ana@x.pt' }),
    msg({ id: 'a2@x', thrid: '111', labels: 'Sent', from: 'Ana <ana@x.pt>', to: 'rui@x.pt', subject: 'Re: Contract terms', body: 'Sim, envio amanhã.\n\nDe: Rui <rui@x.pt>\nEnviado: segunda\nAssunto: x\n\ntexto antigo', date: 'Tue, 24 Nov 2026 11:00:00 +0000' }),
    msg({ id: 'b1@x', subject: 'Lunch', from: 'Eva <eva@y.pt>', body: 'lunch? Please tell me.' }),
    msg({ id: 'b2@x', subject: 'Re: Lunch', from: 'Ana <ana@x.pt>', refs: ['b1@x'], labels: 'Sent', date: 'Tue, 24 Nov 2026 12:00:00 +0000', body: 'yes' }),
    msg({ id: 'c1@x', subject: 'Plan', body: 'a plan' }), msg({ id: 'c2@x', subject: 'RE: Plan', body: 'a reply that lost its headers', date: 'Tue, 24 Nov 2026 13:00:00 +0000' }),
    msg({ id: 'att@x', subject: 'Report', body: 'see attached', extra: [] }).replace('Content-Type: text/plain; charset=utf-8\n\nsee attached', 'Content-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: text/plain\n\nsee attached\n--B\nContent-Type: application/pdf; name="r.pdf"\nContent-Disposition: attachment; filename="r.pdf"\nContent-Transfer-Encoding: base64\n\nAAAAAAAAAAAAAAAA\n--B--'));
  const r = await s.run({ stream: stream(text) });
  assert.equal(r.messages, 7);
  assert.equal(r.threads, 5);
  assert.equal(r.created, 5);
  assert.deepEqual(s.titles(), ['Contract terms', 'Lunch', 'Plan', 'RE: Plan', 'Report']);
  const t1 = s.store.byExternal(s.src.id, 'thread:g:111');
  assert.equal(t1.meta.messages, 2);
  assert.ok(t1.meta.people.includes('eva@y.pt'), 'Cc');
  assert.equal(t1.meta.lastFromMe, true, 'ana@x.pt is known from Delivered-To');
  assert.ok(t1.text.includes('Sim, envio amanhã.') && !t1.text.includes('texto antigo'));
  assert.deepEqual(t1.meta.labels.sort(), ['Important', 'Inbox', 'Sent']);
  assert.equal(t1.meta.imported, 'mbox');
  assert.equal(t1.kind, 'email');
  assert.equal(t1.occurredAt, Date.parse('2026-11-24T11:00:00Z'));
  const lunch = s.store.list({ sourceId: s.src.id }).find((x) => x.title === 'Lunch');
  assert.equal(lunch.meta.messages, 2, 'References');
  assert.equal(s.store.list({ sourceId: s.src.id }).find((x) => x.title === 'Report').meta.attachments[0].name, 'r.pdf');
});

test('a re-import changes nothing; a bigger file updates the threads that grew', async () => {
  const s = setup();
  const a = msg({ id: 'a@x', thrid: '5' });
  await s.run({ stream: stream(mbox(a)) });
  const again = await s.run({ stream: stream(mbox(a)) });
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 1]);
  const grown = await s.run({ stream: stream(mbox(a, msg({ id: 'a2@x', thrid: '5', subject: 'Re: Contract terms', body: 'a second message', date: 'Tue, 24 Nov 2026 12:00:00 +0000' }))) });
  assert.deepEqual([grown.created, grown.updated], [0, 1]);
  assert.equal(s.store.byExternal(s.src.id, 'thread:g:5').meta.messages, 2);
});

test('the grant: Spam, Trash and Drafts are left out; the never-read list, a label filter and a sender filter apply; the metadata level reads no body', async () => {
  const text = mbox(
    msg({ id: 'ok@x', subject: 'Fine', labels: 'Inbox,Work', body: 'BODYSECRET fine' }),
    msg({ id: 'spam@x', subject: 'Win money', labels: 'Spam', body: 'x' }), msg({ id: 'trash@x', subject: 'Binned', labels: 'Trash', body: 'x' }),
    msg({ id: 'dr@x', subject: 'Draft', labels: 'Drafts', body: 'x' }),
    msg({ id: 'hr@x', subject: 'Offer', from: 'HR <hr@corp.pt>', labels: 'Inbox,Work', body: 'salary' }),
    msg({ id: 'lab@x', subject: 'Your lab results', labels: 'Inbox,Work', body: 'blood' }),
    msg({ id: 'med@x', subject: 'Appointment', labels: 'Medical', body: 'x' }),
    msg({ id: 'other@x', subject: 'Not work', labels: 'Inbox', body: 'x' }),
    msg({ id: 'blk@x', subject: 'From a blocked sender', from: 'Spammer <spam@z.pt>', labels: 'Inbox,Work', body: 'x' }));
  const s = setup({ readLevel: 'part', filter: { labels: ['Work'], never: { domains: ['corp.pt'], keywords: ['lab results'], labels: ['Medical'] }, excludeSenders: ['spam@z.pt'] } });
  const r = await s.run({ stream: stream(text) });
  assert.deepEqual(s.titles(), ['Fine']);
  assert.equal(r.skipped, 2, 'Spam and Trash');
  assert.ok(r.filtered >= 5);
  const m = setup({ readLevel: 'metadata' });
  await m.run({ stream: stream(msg({ id: 'ok@x', subject: 'Fine', body: 'BODYSECRET fine', extra: ['List-Unsubscribe: <mailto:u@x>'] })) });
  const it = m.store.list({ sourceId: m.src.id })[0];
  const full = m.store.item(it.id);
  assert.equal(full.text, '');
  assert.equal(full.meta.metadataOnly, true);
  assert.equal(full.meta.newsletter, true);
  assert.ok(!JSON.stringify(full).includes('BODYSECRET'));
  const n = setup({ readLevel: 'none' });
  assert.equal((await n.run({ stream: stream(text) })).skippedAll, 'nothing may be read');
  assert.equal(n.store.count(), 0);
  // the level of the call wins over the source's, and a "forgotten" address is never read
  const o = setup({ readLevel: 'all' });
  o.store.blocked = () => ['rui@x.pt'];
  assert.equal((await o.run({ stream: stream(msg({ id: 'q@x', from: 'Rui <rui@x.pt>' })) })).created, 0, 'a forgotten address is never read');
  assert.equal((await o.run({ stream: stream(msg({ id: 'p@x', from: 'Eva <eva@y.pt>' })), level: 'metadata' })).created, 1, 'the level given for the call wins over the source\'s');
  assert.equal(o.store.list({ sourceId: o.src.id }).map((x) => o.store.item(x.id))[0].meta.metadataOnly, true);
});

test('a window: after / before / days; replace tombstones what an earlier import had', async () => {
  const s = setup();
  const old = msg({ id: 'old@x', subject: 'Old', date: 'Mon, 02 Jan 2023 10:00:00 +0000' }), recent = msg({ id: 'new@x', subject: 'Recent', date: 'Tue, 24 Nov 2026 10:00:00 +0000' });
  await s.run({ stream: stream(mbox(old, recent)) });
  assert.deepEqual(s.titles(), ['Old', 'Recent']);
  const r = await s.run({ stream: stream(mbox(old, recent)), filter: { after: '2026-01-01' } });
  assert.deepEqual(s.store.list({ sourceId: s.src.id }).map((x) => x.title), ['Recent'], 'the narrower window forgets the old thread');
  assert.equal(r.removed, 1);
  const rep = await s.run({ stream: stream(mbox(old)), filter: {}, replace: true });
  assert.ok(rep.removed >= 1);
  assert.deepEqual(s.titles(), ['Old']);
});

test('limits: a file over maxBytes is refused before it is read, a stream is cut at the limit without a half message, a huge message is clipped', async (t) => {
  const s = setup();
  const dir = tmpDir('wb-mbox-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.mbox');
  fs.writeFileSync(file, mbox(msg({ id: 'a@x' }), msg({ id: 'b@x', subject: 'B' })));
  await assert.rejects(s.run({ file, maxBytes: 100 }), (e) => e.code === 'too-big' && /Split it/.test(e.message));
  assert.equal(s.store.count(), 0);
  const r = await s.run({ file });
  assert.equal(r.threads, 2, 'a file works as well as a stream');
  // a stream larger than the limit: reading stops
  const big = mbox(msg({ id: 'a@x', subject: 'A' }), msg({ id: 'b@x', subject: 'B' }), msg({ id: 'c@x', subject: 'C' }));
  const one = Buffer.byteLength(msg({ id: 'a@x', subject: 'A' }));
  const tr = setup();
  const cut = await tr.run({ stream: stream(big, 64), maxBytes: one * 2 + 5 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.threads <= 2, `a half message is not given (${cut.threads})`);
  assert.ok(!tr.titles().includes('C'));
  // an enormous message is read to maxMessageBytes only
  const c = setup();
  const huge = msg({ id: 'h@x', subject: 'Huge', body: `${'x'.repeat(5000)}\n`.repeat(40) });
  const clipped = await c.run({ stream: stream(huge), maxMessageBytes: 20_000 });
  assert.equal(clipped.clipped, 1);
  assert.equal(clipped.threads, 1);
  assert.ok(c.store.list({ sourceId: c.src.id })[0].preview.length > 0);
});

test('chunk boundaries do not matter: the same archive read in tiny and large pieces gives the same items', async () => {
  const text = mbox(msg({ id: 'a@x', thrid: '1', body: 'One\n>From x\n\nmore' }), msg({ id: 'b@x', thrid: '1', subject: 'Re: Contract terms', body: 'two' }), msg({ id: 'c@x', subject: 'Other', body: 'ação' }));
  const snapshot = async (size) => { const s = setup(); await s.run({ stream: stream(text.replace(/\n/g, '\r\n'), size) }); return s.store.list({ sourceId: s.src.id }).map((x) => [x.externalId, x.title, s.store.item(x.id).text]).sort(); };
  const small = await snapshot(1), mid = await snapshot(7), large = await snapshot(1 << 20);
  assert.deepEqual(small, large);
  assert.deepEqual(mid, large);
  assert.equal(large.length, 2);
});

test('it needs the store and a source, and a file or a stream', async () => {
  await assert.rejects(importMbox({}), /needs the item store/);
  const s = setup();
  await assert.rejects(s.run({}), /file or a stream/);
});

test('memory: each message keeps only the 12,000 characters an item uses, from the moment it is read (not after the whole file)', async (t) => {
  const M = require('../src/connectors/mail-common');
  const real = M.buildThreadItem, lengths = [];
  M.buildThreadItem = (args) => { lengths.push(...args.msgs.map((m) => m.text.length)); return real(args); };
  t.after(() => { M.buildThreadItem = real; });
  const s = setup();
  const long = `${'word '.repeat(200)}\n`.repeat(200);       // ≈ 200 KB of text in one message
  await s.run({ stream: stream(mbox(msg({ id: 'l@x', subject: 'Long', body: long }), msg({ id: 'r@x', refs: ['l@x'], subject: 'Re: Long', body: 'short' }))) });
  assert.deepEqual(lengths.sort((a, b) => a - b), [5, 12_000]);
  assert.ok(s.store.list({ sourceId: s.src.id })[0].preview.includes('word word'));
});
