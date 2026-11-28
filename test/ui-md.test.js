'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'ui', 'md.js'));

test('markdown: escapes HTML and blocks javascript: links', async () => {
  const { renderMarkdown } = await load();
  const out = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **bold**');
  assert.ok(!out.includes('<img'));
  assert.ok(!/href="javascript/i.test(out));
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('see https://example.com/a?b=1 now'), /<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer">/);
});

test('markdown: headings, nested lists, task lists, tables, code', async () => {
  const { renderMarkdown } = await load();
  const md = ['## Key points', '- one', '  - nested', '- two', '', '## Action items', '- [ ] Ana: send deck', '- [x] Bob: book room', '', '1. first', '2. second', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```', '<b>raw</b>', '```', '', '> quote', '', 'inline `code <x>` here'].join('\n');
  const out = renderMarkdown(md);
  assert.match(out, /<h2>Key points<\/h2>/);
  assert.match(out, /<li>one<ul><li>nested<\/li><\/ul><\/li>/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled >Ana: send deck<\/li>/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled checked>Bob: book room<\/li>/);
  assert.match(out, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(out, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/);
  assert.match(out, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
  assert.match(out, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(out, /<code>code &lt;x&gt;<\/code>/);
});

// The anchors in a rendered string, each with its attributes as the browser would read them (name="value" pairs only)
const anchors = (html) => [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]);
const attrNames = (attrs) => [...attrs.matchAll(/\s([^\s=]+)(?:="[^"]*")?/g)].map((m) => m[1]);

test('markdown: a link cannot smuggle attributes or a second link into its href (an invisible full-window click trap)', async () => {
  const { renderMarkdown } = await load();
  const trap = '[Open](https://evil.example/(https://x/style=position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;opacity:0)';
  const out = renderMarkdown(trap);
  const a = anchors(out);
  assert.equal(a.length, 1, `exactly one link: ${out}`);
  assert.deepEqual(attrNames(a[0]), ['href', 'target', 'rel'], `no attribute but href/target/rel: ${out}`);
  assert.ok(!/style=/.test(out.replace(/href="[^"]*"/, '')), 'nothing outside the href says style');
  assert.match(out, /^<p><a href="https:\/\/evil\.example\/\(https:\/\/x\/style=position:fixed;[^"]*opacity:0" target="_blank" rel="noopener noreferrer">Open<\/a><\/p>$/);
});

test('markdown: emphasis and autolinks never run inside a link\'s href or around a link', async () => {
  const { renderMarkdown } = await load();
  for (const [src, href] of [
    ['[x](https://a.example/-*y*-)', 'https://a.example/-*y*-'],
    ['[x](https://a.example/a_b_/_c_)', 'https://a.example/a_b_/_c_'],
    ['see https://a.example/-*y*-/~~z~~ now', 'https://a.example/-*y*-/~~z~~'],
    ['https://a.example/**b**', 'https://a.example/**b**'],
  ]) {
    const out = renderMarkdown(src);
    const a = anchors(out);
    assert.equal(a.length, 1, `${src} → ${out}`);
    assert.equal(/href="([^"]*)"/.exec(a[0])[1], href, `${src}: the href is the URL as written`);
    assert.deepEqual(attrNames(a[0]), ['href', 'target', 'rel']);
    assert.ok(!/<(em|strong|del)>[^<]*"/.test(out), `${src}: no emphasis across an attribute: ${out}`);
  }
  // a URL written as a link's text stays text: no link inside a link
  const nested = renderMarkdown('[see https://b.example now](https://a.example)');
  assert.equal(anchors(nested).length, 1, nested);
  // emphasis and code in the link text still work, and emphasis may wrap a whole link
  assert.equal(renderMarkdown('[**bold** `c`](https://a.example)'), '<p><a href="https://a.example" target="_blank" rel="noopener noreferrer"><strong>bold</strong> <code>c</code></a></p>');
  assert.equal(renderMarkdown('**[x](https://a.example)**'), '<p><strong><a href="https://a.example" target="_blank" rel="noopener noreferrer">x</a></strong></p>');
});
