'use strict';
// ui/highlight.js: glossary terms and search hits are marked on the plain text, then escaped, so neither can land inside
// the other's attributes (a term written in another term's definition used to garble the line).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'ui', 'highlight.js'));
const G = [
  { term: 'Orion', definition: 'Launch project "Orion" <b>alpha</b> with ACME', aliases: ['the launch'] },
  { term: 'ACME', definition: 'A customer, see Orion' },
  { term: 'Q', definition: 'too short to mark' },
];

test('highlight: each term once, its definition escaped in the title, nothing nested', async () => {
  const { highlight } = await load();
  const out = highlight('Orion is for ACME <now> & then the launch.', G);
  assert.equal(out, '<span class="term" title="Launch project &quot;Orion&quot; &lt;b&gt;alpha&lt;/b&gt; with ACME">Orion</span> is for <span class="term" title="A customer, see Orion">ACME</span> &lt;now&gt; &amp; then <span class="term" title="Launch project &quot;Orion&quot; &lt;b&gt;alpha&lt;/b&gt; with ACME">the launch</span>.');
  assert.equal((out.match(/<span/g) || []).length, 3);
});

test('highlight: whole words only, any case, longest term first, Unicode letters are word characters', async () => {
  const { highlight } = await load();
  assert.equal(highlight('Orions and acme and ACMEcorp', G), 'Orions and <span class="term" title="A customer, see Orion">acme</span> and ACMEcorp');
  const g2 = [{ term: 'São', definition: 'a' }, { term: 'São Paulo', definition: 'b' }];
  assert.equal(highlight('em São Paulo e São', g2), 'em <span class="term" title="b">São Paulo</span> e <span class="term" title="a">São</span>');
  assert.equal(highlight('Sãozinho', g2), 'Sãozinho');
  assert.equal(highlight('a Q b', G), 'a Q b', 'one-letter terms are not marked');
});

test('highlight: search hits are marked on the text, also inside a term, never inside an attribute', async () => {
  const { highlight } = await load();
  assert.equal(highlight('Orion for ACME', G, 'launch'), '<span class="term" title="Launch project &quot;Orion&quot; &lt;b&gt;alpha&lt;/b&gt; with ACME">Orion</span> for <span class="term" title="A customer, see Orion">ACME</span>', 'a word only in a definition is not marked');
  assert.equal(highlight('Orion for acme', G, 'ACM'), '<span class="term" title="Launch project &quot;Orion&quot; &lt;b&gt;alpha&lt;/b&gt; with ACME">Orion</span> for <span class="term" title="A customer, see Orion"><mark>acm</mark>e</span>');
  assert.equal(highlight('a <b> & b', [], 'b'), 'a &lt;<mark>b</mark>&gt; &amp; <mark>b</mark>');
  assert.equal(highlight('x.y x+y', [], '.'), 'x<mark>.</mark>y x+y', 'the query is text, not a pattern');
  assert.equal(highlight('nothing', null), 'nothing');
});

test('highlight: one matcher per glossary list, reused', async () => {
  const { termMatcher } = await load();
  assert.equal(termMatcher(G), termMatcher(G));
  assert.notEqual(termMatcher(G), termMatcher([...G]));
});
