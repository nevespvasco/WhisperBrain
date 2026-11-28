'use strict';
// ui/i18n.js: variables are put in as they are (no $& / $' expansion), and tHtml() escapes them for innerHTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'ui', 'i18n.js'));

test('t(): a variable is inserted literally, even when it looks like a replacement pattern', async () => {
  const { t } = await load();
  assert.equal(t('Revoke {name}', { name: 'a$&b' }), 'Revoke a$&b');
  assert.equal(t('Revoke {name}', { name: "$'$`$$" }), "Revoke $'$`$$");
  assert.equal(t('{n} of {m}', { n: 2, m: 3 }), '2 of 3');
  assert.equal(t('Revoke {name}', { name: '<b>' }), 'Revoke <b>', 't() itself does not escape: its result goes to textContent or esc()');
});

test('tHtml(): the variables are escaped, the translation is not', async () => {
  const { tHtml } = await load();
  assert.equal(tHtml('Asking {names}…', { names: '<img src=x onerror=alert(1)>, "Slack"' }), 'Asking &lt;img src=x onerror=alert(1)&gt;, &quot;Slack&quot;…');
  assert.equal(tHtml('Asking {names}…', { names: '$&' }), 'Asking $&amp;…');
  assert.equal(tHtml('{n} days', { n: 7 }), '7 days');
});
