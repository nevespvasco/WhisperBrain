'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { redactSnapshot, redactName } = require('../src/meet/redact');
const { readMeeting, compileSelectors } = require('../src/meet/a11y');
const { fixture } = require('./helpers');

test('redact: people and words are replaced by their length; the page\'s own words and the self mark stay', () => {
  assert.equal(redactName('Ana Silva'), '«9»');
  assert.equal(redactName('Speaking'), 'Speaking');
  assert.equal(redactName('Vasco Neves (You)'), '«11» (You)');
  assert.equal(redactName('hello there, this is secret'), '«27»');
  assert.equal(redactName('Bruno', /^bruno$/i), 'Bruno', 'unless you say to keep it');
  assert.equal(redactName(''), '');
});

test('redact: the shape survives, the meeting code and the personal attributes do not', () => {
  const snap = JSON.parse(fs.readFileSync(fixture('a11y/mock-meet-speaking-carla.json'), 'utf8'));
  const r = redactSnapshot(snap);
  assert.equal(r.nodes.length, snap.nodes.length);
  assert.deepEqual(r.nodes.map((n) => [n.p, n.r]), snap.nodes.map((n) => [n.p, n.r]));
  assert.ok(!JSON.stringify(r).includes('Ana'), 'no name');
  assert.ok(!JSON.stringify(r).includes('abc-defg-hij'), 'no meeting code');
  assert.ok(r.nodes.some((n) => n.n === 'Speaking'), 'the page\'s own word stays, so a selector can be checked');
  assert.ok(r.nodes.some((n) => n.a?.class === 'ind'), 'class names stay: they are what selectors use');
  const withId = redactSnapshot({ window: 'x', nodes: [{ p: -1, r: 'section', n: '', a: { id: 'user-1234', class: 'tile', 'data-x': 'secret' } }] }).nodes[0].a;
  assert.deepEqual([withId.id, withId.class, withId['data-x']], ['«9»', 'tile', '«6»']);
});

test('redact: the redacted page still reads the same way where it matters (who is speaking is a state, not a name)', () => {
  const snap = JSON.parse(fs.readFileSync(fixture('a11y/mock-meet-speaking-carla.json'), 'utf8'));
  const sel = compileSelectors({ version: 1, participants: { scope: { role: '^list$' }, name: { role: '^static$', name: '.' }, group: 'following', speaking: { name: '^speaking$' } } });
  const real = readMeeting(snap, sel), red = readMeeting(redactSnapshot(snap), sel);
  assert.deepEqual(red.participants.map((p) => p.speaking), real.participants.map((p) => p.speaking));
});
