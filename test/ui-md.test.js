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
