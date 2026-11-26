'use strict';
// The doors navigation (ui/nav.js): every page stays reachable, the menu is fully translated, and the start page setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../src/core/db');
const { Settings } = require('../src/core/settings');
const { Bus } = require('../src/core/events');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(path.join(ROOT, rel));

test('every page the router knows lives behind a door', async () => {
  const { DOORS, doorOf } = await load('ui/nav.js');
  const app = fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8');
  const routes = app.match(/const ROUTES = \{([\s\S]*?)\};/)[1];
  const names = [...routes.matchAll(/(?:^|[\s,])'?([a-z]*)'?\s*[:,]/g)].map((m) => m[1]).map((n) => n || 'home');
  assert.ok(names.length >= 15, `ROUTES parsed: ${names}`);
  const owned = new Set(DOORS.flatMap((d) => d.sections.flatMap((s) => (s.links || []).flatMap((l) => l.views))));
  for (const n of names) assert.ok(owned.has(n), `the page "${n}" is not behind any door: nobody could find it from the menu`);
  assert.equal(doorOf('note'), 'library', 'a meeting opens inside the Library');
  assert.equal(doorOf('settings'), 'setup');
  assert.equal(doorOf('nowhere'), 'today');
});

test('everything the old sidebar linked to is still one click from a door', async () => {
  const { DOORS } = await load('ui/nav.js');
  const hrefs = new Set(DOORS.flatMap((d) => d.sections.flatMap((s) => (s.links || []).map((l) => l.href))));
  const before = ['#/', '#/meetings', '#/calendar', '#/actions', '#/chat', '#/topics', '#/glossary', '#/people', '#/briefings',
    '#/meetings?source=local', '#/meetings?source=imported', '#/meetings?external=1', '#/integrations', '#/settings/account'];
  for (const h of before) assert.ok(hrefs.has(h), `${h} is no longer in the menu`);
  const specials = DOORS.flatMap((d) => d.sections.map((s) => s.special)).filter(Boolean);
  assert.deepEqual(specials.sort(), ['spaces', 'tags'], 'spaces and tags (with their + buttons) are still in the menu');
});

test('the link on screen is marked, filters included', async () => {
  const { DOORS, isCurrent } = await load('ui/nav.js');
  const links = DOORS.flatMap((d) => d.sections.flatMap((s) => s.links || []));
  const by = (href) => links.find((l) => l.href === href);
  const view = (name, qs = '', parts = [name]) => ({ name, parts, params: new URLSearchParams(qs) });
  assert.equal(isCurrent(by('#/meetings'), view('meetings')), true);
  assert.equal(isCurrent(by('#/meetings'), view('meetings', 'source=local')), false, 'a filtered list is not "All meetings"');
  assert.equal(isCurrent(by('#/meetings?source=local'), view('meetings', 'source=local')), true);
  assert.equal(isCurrent(by('#/meetings'), view('note', '', ['note', 'abc'])), true, 'a meeting page keeps "All meetings" marked');
  assert.equal(isCurrent(by('#/settings/account'), view('settings', '', ['settings'])), true, 'Settings opens on Account');
  assert.equal(isCurrent(by('#/settings/audio'), view('settings', '', ['settings', 'audio'])), true);
  assert.equal(isCurrent(by('#/settings/account'), view('settings', '', ['settings', 'audio'])), false);
});

test('every word in the menu has a Portuguese translation', async () => {
  const { DOORS } = await load('ui/nav.js');
  const { PT } = await load('ui/i18n-pt.js');
  const words = DOORS.flatMap((d) => [d.label, d.hint, ...d.sections.flatMap((s) => [s.label, s.note, ...(s.links || []).flatMap((l) => [l.label, l.title])])]).filter(Boolean);
  const missing = [...new Set(words)].filter((w) => !PT[w]);
  assert.deepEqual(missing, []);
});

test('startPage: "home" by default, "meetings" allowed, nothing else', () => {
  const s = new Settings(open(':memory:'), new Bus());
  assert.equal(s.get('startPage'), 'home');
  assert.equal(s.update({ startPage: 'meetings' }).startPage, 'meetings');
  assert.throws(() => s.update({ startPage: 'calendar' }), /home or meetings/);
});
