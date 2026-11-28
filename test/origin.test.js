'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sameOrigin } = require('../electron/origin');

const ORIGIN = 'http://127.0.0.1:4100';

test('sameOrigin: our own UI and its pages are ours', () => {
  assert.equal(sameOrigin('http://127.0.0.1:4100', ORIGIN), true, 'a permission check passes the bare origin');
  assert.equal(sameOrigin('http://127.0.0.1:4100/', ORIGIN), true);
  assert.equal(sameOrigin('http://127.0.0.1:4100/widget.html?token=abc#x', ORIGIN), true);
});

test('sameOrigin: look-alikes a string prefix would have let through are refused', () => {
  assert.equal(sameOrigin('http://127.0.0.1:4100@evil.example/', ORIGIN), false, 'user-info trick: the host is evil.example');
  assert.equal(sameOrigin('http://127.0.0.1:41001/', ORIGIN), false, 'another port that starts with ours');
  assert.equal(sameOrigin('http://127.0.0.1:4100.evil.example/', ORIGIN), false);
  assert.equal(sameOrigin('https://127.0.0.1:4100/', ORIGIN), false, 'other scheme');
  assert.equal(sameOrigin('http://localhost:4100/', ORIGIN), false, 'other host name');
});

test('sameOrigin: anything that is not a URL, or no origin yet, is refused', () => {
  for (const u of ['', 'not a url', null, undefined, 42, {}, 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) assert.equal(sameOrigin(u, ORIGIN), false, String(u));
  assert.equal(sameOrigin('http://127.0.0.1:4100/', ''), false, 'before the server listens there is no origin');
  assert.equal(sameOrigin('http://127.0.0.1:4100/', undefined), false);
  assert.equal(sameOrigin('file:///a', 'file:///b'), false, "an opaque origin ('null') is never ours");
});
