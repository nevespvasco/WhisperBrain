'use strict';
// The shared HTML → text pass (src/core/html-text.js) behind mail bodies (.eml/IMAP/mbox/Outlook via mime.js, Gmail) and
// imported .html files: same text as before for ordinary HTML, and linear time on hostile HTML (it used to take seconds).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/core/html-text');
const M = require('../src/importers/mime');
const P = require('../src/importers/parsers');
const { bodyOf } = require('../src/connectors/gmail');

const b64 = (s) => Buffer.from(s).toString('base64url');
const gmailHtml = (h) => bodyOf({ mimeType: 'text/html', body: { data: b64(h) } });
const ms = (f) => { const t = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t) / 1e6; };

const PAGE = '<!DOCTYPE html><html><head><title>T &amp; x</title><meta charset="utf-8"></head><body><h1>Big   news</h1><p>Hello <b>Ana</b>,</p>\n'
  + '<p>See <a href="https://x.y/?a=1&amp;b=2">the link</a>.</p><ul><li>one</li><li>two &mdash; 2</li></ul><table><tr><td>a</td><td>b</td></tr>'
  + '<tr><th>c</th><td>d</td></tr></table><blockquote>quoted<br/>line</blockquote><div>caf&eacute; &#233; &#xE9; &lt;tag&gt; &quot;q&quot; &#39;s&#39;</div></body></html>';

test('mail text: breaks at <br> and block ends, tags become spaces, head/style/script/comments go, entities decoded once', () => {
  assert.equal(M.htmlToText('<html><head><style>p{}</style></head><body><p>One &amp; two</p><br>three&nbsp;four<script>x()</script></body></html>'), ' One & two\n\nthree four ');
  assert.equal(M.htmlToText(PAGE), ' Big news\nHello Ana ,\n\nSee the link .\none\ntwo — 2\na b\nc d\nquoted\nline\ncafé é é <tag> "q" \'s\'\n');
  assert.equal(M.htmlToText('<div dir="ltr">Hi team,<div><br></div><div>Notes attached.</div><div><br></div>-- <br><div class="gmail_signature">Ana<br>CEO</div></div>\r\n'),
    ' Hi team,\n\nNotes attached.\n\n\n--\nAna\nCEO\n\n\r\n');
  assert.equal(M.htmlToText('<p>Line one<br>Line two</p>\n\n\n<p>   spaced    words   </p>\t<p>\ttabbed</p>'), ' Line one\nLine two\n\n\n\nspaced words\ntabbed\n');
  assert.equal(M.htmlToText('<SCRIPT type="text/javascript">var a = "</p>";</SCRIPT><STYLE>.a{}</STYLE><P>Upper</P><BR><DIV>case</DIV>'), ' Upper\n\ncase\n');
  assert.equal(M.htmlToText('<p>a < b and c > d</p><p>5 &gt; 3</p>'), ' a d\n5 > 3\n', 'a lone "<…>" is still read as a tag, as before');
  assert.equal(M.htmlToText('<p>Text</p><!--[if mso]><p>MSO only</p><![endif]--><p>a &amp;lt; b</p>'), ' Text\na &lt; b\n', "Outlook's conditional block is a comment; &amp;lt; is not decoded twice");
  assert.equal(M.htmlToText('Plain text no tags &amp; entity'), 'Plain text no tags & entity');
  assert.equal(M.htmlToText('<html><head><title>t</title><body><p>hi</p>'), ' hi\n', 'a <head> without </head> ends where <body> starts');
  assert.equal(M.htmlToText('<p>kept</p><head>text'), ' kept\ntext', 'a stray <head> with nothing to end it does not swallow the mail');
  assert.equal(M.htmlToText('<p>before</p><style>a{}'), ' before\n', 'an unclosed <style> drops the rest, as a browser does');
});

test('Gmail html bodies use the same pass: the <title> no longer leaks into the text and spaces are tidy', () => {
  assert.equal(gmailHtml(PAGE), 'Big news\nHello Ana ,\n\nSee the link .\none\ntwo — 2\na b\nc d\nquoted\nline\ncafé é é <tag> "q" \'s\'');
  assert.equal(gmailHtml('<p>Hello <b>Ana</b></p><style>x{}</style>'), 'Hello Ana');
});

test('imported .html: Markdown headings, lists and paragraphs as before; title read from <title>', () => {
  assert.deepEqual(P.htmlToText(PAGE), { text: '# Big news\n\nHello Ana,\n\nSee the link.\n\n- one\n- two — 2\n\na b\n\nc d\n\nquoted\nline\n\ncafé é é <tag> "q" \'s\'', title: 'T & x' });
  assert.deepEqual(P.htmlToText('<html><body><!-- a comment --><p>Text</p><!--[if mso]><p>MSO only</p><![endif]--><h2 class="x">Sub</h2><section><p>In section</p></section><pre>code  here</pre><svg><text>svgtext</text></svg><noscript>enable js</noscript></body></html>'),
    { text: 'Text\n\n## Sub\n\nIn section\n\ncode here', title: '' });
  assert.deepEqual(P.htmlToText('<div dir="ltr">Hi team,<div><br></div><div>Notes attached.</div><div><br></div>-- <br><div class="gmail_signature">Ana<br>CEO</div></div>\r\n'),
    { text: 'Hi team,\n\nNotes attached.\n\n--\n\nAna\nCEO', title: '' });
  assert.deepEqual(P.htmlToText('<table><tr><td>Name</td><td>Value</td></tr></table><hr><dl><dt>t</dt><dd>d</dd></dl><img src="x.png" alt="pic"><span>inline</span>   <em>em</em>'),
    { text: 'Name Value\n\nt\n\nd\n\ninline em', title: '' });
});

test('hostile HTML is linear: unclosed blocks, a sea of "<", repeated <head>/<title>, long runs of spaces (each took seconds)', () => {
  const big = {
    style: '<style>'.repeat(80000),                     // ≈ 560 KB: 6.9 s in parseMessage before
    lt: '<'.repeat(600000),
    head: '<head><body>'.repeat(40000) + '</head>',
    title: '<title>'.repeat(80000),
    spaces: `<p>${' '.repeat(500000)}x</p>\n`,
    pTags: '<p'.repeat(250000) + '>',
  };
  for (const [name, h] of Object.entries(big)) {
    const eml = `Content-Type: text/html; charset=utf-8\r\n\r\n${h}`;
    const t = ms(() => { M.parseMessage(eml); gmailHtml(h); P.htmlToText(h); H.stripTags(h); });
    assert.ok(t < 400, `${name}: ${t.toFixed(0)} ms`);
  }
});

test('mail bodies are cut to 256 KB of HTML before stripping, without leaving half a tag', () => {
  const h = `<p>${'a'.repeat(H.MAIL_MAX)}</p><p>after the cap</p>`;
  const t = M.htmlToText(h);
  assert.ok(!t.includes('after the cap') && t.length <= H.MAIL_MAX);
  assert.equal(H.cap('abc<di', 5), 'abc', 'a tag cut in half is dropped');
  assert.equal(H.cap('abc', Infinity), 'abc');
});
