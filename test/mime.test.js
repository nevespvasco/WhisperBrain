'use strict';
// The small MIME reader (src/importers/mime.js) on the kinds of mail real clients write.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/importers/mime');

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

test('headers: folding, repeated headers, a header with no value, and 8-bit text read as UTF-8', () => {
  const h = M.parseHeaders(crlf('Subject: a very long\n subject that is\n\tfolded\nX-Two: 1\nX-Two: 2\nX-Empty:\nbad line without colon\nFrom: =?utf-8?B?Sm/Do28=?= <j@x.pt>\n\nBody: not a header'));
  assert.equal(h.get('subject'), 'a very long subject that is folded');
  assert.deepEqual(h.all('x-two'), ['1', '2']);
  assert.equal(h.get('x-empty'), '');
  assert.equal(h.get('body'), '', 'the body is not read as headers');
  assert.equal(h.text('from'), 'João <j@x.pt>');
  const raw = M.parseHeaders(Buffer.from('Subject: Olá, amanhã\r\n\r\n', 'utf8'));
  assert.equal(raw.text('subject'), 'Olá, amanhã');
});

test('RFC 2047 encoded words: B and Q, charsets, adjacent words joined, a multi-byte character split across two words', () => {
  assert.equal(M.decodeWords('=?UTF-8?Q?Ol=C3=A1_mundo?='), 'Olá mundo');
  assert.equal(M.decodeWords('=?iso-8859-1?Q?Jos=E9?= Silva'), 'José Silva');
  assert.equal(M.decodeWords('=?utf-8?B?5pel5pys?= =?utf-8?B?6Kqe?='), '日本語');
  const euro = Buffer.from('€');                                   // 3 bytes, split over two words
  const a = euro.subarray(0, 1).toString('base64'), b = euro.subarray(1).toString('base64');
  assert.equal(M.decodeWords(`=?utf-8?B?${a}?= =?utf-8?B?${b}?=`), '€');
  assert.equal(M.decodeWords('plain =?utf-8?Q?x?= and =?utf-8?Q?y?='), 'plain x and y');
  assert.equal(M.decodeWords('=?x-unknown-charset?Q?abc?='), 'abc', 'an unknown charset does not throw');
  assert.equal(M.decodeWords('=?utf-8*pt?Q?ol=C3=A1?='), 'olá', 'RFC 2231 language suffix');
  assert.equal(M.decodeWords('no words here'), 'no words here');
});

test('parameters: quotes, RFC 2231 continuations and encodings', () => {
  const p = M.parseParams('multipart/mixed; boundary="a;b"; charset=utf-8');
  assert.deepEqual([p.value, p.params.boundary, p.params.charset], ['multipart/mixed', 'a;b', 'utf-8']);
  const c = M.parseParams("attachment; filename*0*=utf-8''rela; filename*1*=t%C3%B3rio; filename*2=.pdf");
  assert.equal(c.params.filename, 'relatório.pdf');
  assert.equal(M.parseParams("attachment; filename*=UTF-8''caf%C3%A9.txt").params.filename, 'café.txt');
  assert.equal(M.parseParams('attachment; filename="=?utf-8?Q?caf=C3=A9.txt?="').params.filename, 'café.txt');
});

test('addresses: names with commas, quotes, comments, groups, bare addresses, encoded names; case folded', () => {
  assert.deepEqual(M.parseAddressList('"Costa, Rui" <Rui@Y.pt>, plain@z.pt, Ana (work) <ana@x.pt>'), [
    { name: 'Costa, Rui', address: 'rui@y.pt' }, { name: '', address: 'plain@z.pt' }, { name: 'Ana (work)', address: 'ana@x.pt' }]);
  assert.deepEqual(M.parseAddressList('Team: a@b.pt, c@d.pt;').map((a) => a.address), ['a@b.pt', 'c@d.pt']);
  assert.deepEqual(M.parseAddressList('=?utf-8?Q?Jo=C3=A3o?= <j@x.pt>'), [{ name: 'João', address: 'j@x.pt' }]);
  assert.deepEqual(M.parseAddressList('undisclosed-recipients:;'), []);
  assert.deepEqual(M.parseAddressList(''), []);
  assert.deepEqual(M.parseAddressList('not an address'), []);
  assert.equal(M.parseDate('Tue, 24 Nov 2026 10:00:00 +0000 (UTC)'), Date.parse('2026-11-24T10:00:00Z'));
  assert.equal(M.parseDate('garbage'), null);
});

test('a plain message: utf-8 body, quoted-printable with soft breaks, base64 latin1', () => {
  const qp = M.parseMessage(crlf('From: a@x.pt\nSubject: t\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nOl=C3=A1 mun=\ndo =E2=82=AC\nline two  \n'));
  assert.equal(qp.text, 'Olá mundo €\nline two');
  const b64 = M.parseMessage(crlf(`From: a@x.pt\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: base64\n\n${Buffer.from('Jos\xe9 chegou', 'latin1').toString('base64')}\n`));
  assert.equal(b64.text, 'José chegou');
  const raw8 = M.parseMessage(Buffer.concat([Buffer.from('From: a@x.pt\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'), Buffer.from('Olá 8-bit', 'utf8')]));
  assert.equal(raw8.text, 'Olá 8-bit');
  const noType = M.parseMessage('Subject: x\n\njust text\nwith lines');
  assert.equal(noType.text, 'just text\nwith lines');
  const ids = M.parseMessage('Message-ID: <a@x>\nIn-Reply-To: <b@x>\nReferences: <c@x>\n <b@x>\nSubject: s\n\nx');
  assert.deepEqual([ids.messageId, ids.inReplyTo, ids.references], ['a@x', 'b@x', ['c@x', 'b@x']]);
  assert.equal(M.parseMessage('List-Unsubscribe: <mailto:u@x>\n\nx').listUnsubscribe, true);
});

test('multipart: alternative gives the plain part, html alone is stripped, mixed joins the texts, nested parts, attachments are names and sizes only', () => {
  const alt = crlf(`From: a@x.pt
Subject: s
Content-Type: multipart/mixed; boundary="OUTER"

--OUTER
Content-Type: multipart/alternative; boundary="INNER"

--INNER
Content-Type: text/html; charset=utf-8

<p>HTML <b>version</b></p>
--INNER
Content-Type: text/plain; charset=utf-8

Plain version
--INNER--
--OUTER
Content-Type: application/pdf; name="relatório.pdf"
Content-Disposition: attachment; filename*=UTF-8''relat%C3%B3rio.pdf
Content-Transfer-Encoding: base64

${Buffer.alloc(300, 7).toString('base64').replace(/(.{76})/g, '$1\n')}
--OUTER
Content-Type: text/plain; charset=utf-8

Second text part
--OUTER--
`);
  const m = M.parseMessage(alt);
  assert.equal(m.text, 'Plain version\n\nSecond text part');
  assert.deepEqual(m.attachments, [{ name: 'relatório.pdf', size: 300, type: 'application/pdf' }]);
  const html = M.parseMessage(crlf('Content-Type: text/html; charset=utf-8\n\n<html><head><style>p{}</style></head><body><p>One &amp; two</p><br>three&nbsp;four<script>x()</script></body></html>'));
  assert.ok(html.text.includes('One & two') && html.text.includes('three four') && !html.text.includes('x()') && !html.text.includes('p{}'));
  const fwd = M.parseMessage(crlf('Content-Type: multipart/mixed; boundary=B\n\n--B\nContent-Type: text/plain\n\nsee below\n--B\nContent-Type: message/rfc822\n\nFrom: z@z\nSubject: forwarded\n\ninner\n--B--\n'));
  assert.equal(fwd.text, 'see below', 'a forwarded message is an attachment, not text');
  assert.equal(fwd.attachments[0].type, 'message/rfc822');
});

test('damaged input never throws: a missing closing boundary, a missing boundary, binary junk, an empty message', () => {
  const cut = M.parseMessage(crlf('Content-Type: multipart/mixed; boundary=B\n\n--B\nContent-Type: text/plain\n\nthe text before the cut'));
  assert.equal(cut.text, 'the text before the cut');
  assert.equal(M.parseMessage(crlf('Content-Type: multipart/mixed\n\nno boundary given')).text, '');
  for (const junk of ['', '\r\n\r\n', Buffer.from([0, 1, 2, 255, 254, 10, 10, 0]), 'Subject', ':::', 'From: <<<>>>']) assert.doesNotThrow(() => M.parseMessage(junk));
  const deep = `${'Content-Type: multipart/mixed; boundary=B\n\n--B\n'.repeat(30)}x`;
  assert.doesNotThrow(() => M.parseMessage(crlf(deep)), 'nesting is bounded');
});

test('headersOnly never reads the body', () => {
  const m = M.parseMessage(crlf('From: a@x.pt\nSubject: s\nContent-Type: text/plain\n\nSECRET BODY'), { headersOnly: true });
  assert.equal(m.text, '');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.subject, 's');
  assert.equal(m.from.address, 'a@x.pt');
});

test('decoders: quoted-printable edge cases, base64 sizes, charsets', () => {
  assert.equal(M.decodeQuotedPrintable('a=3Db =\r\nc =ZZ').toString(), 'a=b c =ZZ', 'a broken escape stays as written');
  assert.equal(M.base64Size(Buffer.alloc(10).toString('base64')), 10);
  assert.equal(M.base64Size(''), 0);
  assert.equal(M.decodeCharset(Buffer.from([0xe9]), 'latin1'), 'é');
  assert.equal(M.decodeCharset(Buffer.from([0x80]), 'windows-1252'), '€');
  assert.equal(M.decodeCharset(Buffer.from('é'), 'no-such-charset'), 'é');
});
