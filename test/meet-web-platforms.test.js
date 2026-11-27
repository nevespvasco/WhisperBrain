'use strict';
// Teams, Zoom and Discord in the browser, through the extension's own reader and selectors, against SIMULATED pages
// (test/fixtures/pages). The simulated pages follow what the selectors expect of the real ones: this shows the reading, the
// differ, the roster being partial, the call view and the ids work; it does NOT show the selectors match the real sites, which
// is why they are marked unverified (extension/meet/selectors.js) until someone runs a real call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPages, browser } = require('./support/read-pages');
const { normalizeSignal } = require('../src/meet/protocol');
const { SignalHub } = require('../src/meet/hub');
const { MeetingCollector } = require('../src/meet/collector');
const { PLATFORMS } = require('../src/meet/platforms');

const page = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'pages', f), 'utf8');
const CASES = [
  ['teams-work', 'teams', 'https://teams.microsoft.com/v2/?meetingjoin=true'],
  ['teams-work-nopanel', 'teams', 'https://teams.microsoft.com/v2/'],
  ['teams-personal', 'teams', 'https://teams.live.com/meet/9381234567'],
  ['teams-lobby', 'teams', 'https://teams.live.com/'],
  ['zoom-gallery', 'zoom', 'https://app.zoom.us/wc/123456789/start'],
  ['zoom-speaker', 'zoom', 'https://app.zoom.us/wc/123456789/join'],
  ['zoom-nopanel', 'zoom', 'https://app.zoom.us/wc/123456789/start'],
  ['discord-server', 'discord', 'https://discord.com/channels/111/222222'],
  ['discord-dm', 'discord', 'https://discord.com/channels/@me/333333'],
  ['discord-home', 'discord', 'https://discord.com/channels/@me'],
].map(([name, platform, url]) => ({ name, platform, url, html: page(`${name}.html`) }));

const skip = browser() ? false : 'no browser to read the pages with (Brave, Chromium or Chrome that is not a snap)';
// the browser is started once for all the pages (see test/support/read-pages.js); each test waits for the same answer
let reading = null;
const get = async (name) => { reading ??= readPages(CASES); return (await reading)[name]; };
const names = (st) => st.participants.map((p) => p.name + (p.self ? '*' : '') + (p.speaking ? '!' : ''));
const roster = (r) => r.msgs.find((m) => m.type === 'roster');

test('Teams, work or school: the roster from the People panel, who speaks, the captions with a name, and a call that is on', { skip }, async () => {
  const r = await get('teams-work');
  assert.equal(r.st.inCall, true);
  assert.deepEqual([...r.st.participants.map((p) => p.name)].sort(), ['Ana Silva', 'Bruno Costa', 'Carla Dias', 'Vasco Neves']);
  assert.deepEqual(r.st.speaking, ['Ana Silva']);
  assert.equal(r.st.participants.find((p) => p.name === 'Vasco Neves').self, true);
  assert.equal(r.st.partial, false, 'the panel is open: this is everybody');
  assert.deepEqual(r.st.captions, [{ name: 'Ana Silva', text: 'shall we begin the meeting' }]);
  assert.equal(roster(r).partial, undefined);
  assert.ok(r.msgs.some((m) => m.type === 'speaker' && m.name === 'Ana Silva'));
});

test('Teams: with the People panel closed only the tiles are known, and the roster says so', { skip }, async () => {
  const r = await get('teams-work-nopanel');
  assert.deepEqual([...r.st.participants.map((p) => p.name)].sort(), ['Ana Silva', 'Vasco Neves']);
  assert.equal(r.st.partial, true);
  assert.equal(roster(r).partial, true);
});

test('Teams, personal (teams.live.com): another layout, read through the alternatives of the same selectors', { skip }, async () => {
  const r = await get('teams-personal');
  assert.equal(r.st.inCall, true);
  assert.deepEqual([...names(r.st)].sort(), ['Bruno Costa!', 'Carla Dias', 'Vasco Neves*']);
  assert.deepEqual(r.st.captions, [], 'no captions on the page: none, not an error');
  assert.equal(r.st.partial, false);
});

test('Teams before the call: nothing is a call, nobody is reported, nothing throws', { skip }, async () => {
  const r = await get('teams-lobby');
  assert.deepEqual([r.st.inCall, r.st.participants.length], [false, 0]);
  assert.ok(!r.msgs.some((m) => m.type === 'roster'));
});

test('Zoom web client, gallery view: the people panel is the roster, the outlined frame is who speaks', { skip }, async () => {
  const r = await get('zoom-gallery');
  assert.equal(r.st.code, '123456789');
  assert.equal(r.st.inCall, true);
  assert.deepEqual([...r.st.participants.map((p) => p.name)].sort(), ['Ana Silva', 'Bruno Costa', 'Carla Dias', 'Vasco Neves']);
  assert.deepEqual(r.st.speaking, ['Ana Silva']);
  assert.equal(r.st.partial, false);
  assert.equal(r.st.participants.find((p) => p.name === 'Vasco Neves').self, true, '"(Me)" is you');
});

test('Zoom web client, speaker view: the big frame and the strip are all read, and the big frame speaks', { skip }, async () => {
  const r = await get('zoom-speaker');
  assert.deepEqual([...names(r.st)].sort(), ['Ana Silva', 'Bruno Costa!', 'Vasco Neves*']);
  assert.deepEqual(r.st.speaking, ['Bruno Costa']);
});

test('Zoom web client with the participants panel closed: the roster is the visible tiles, and says so', { skip }, async () => {
  const r = await get('zoom-nopanel');
  assert.deepEqual([...r.st.participants.map((p) => p.name)].sort(), ['Ana Silva', 'Vasco Neves']);
  assert.equal(r.st.partial, true);
  assert.equal(roster(r).partial, true);
});

test('Discord in the browser: only the call view is read; the sidebar people of other channels are never reported', { skip }, async () => {
  for (const name of ['discord-server', 'discord-dm']) {
    const r = await get(name);
    const all = JSON.stringify(r);
    for (const outsider of ['Elsewhere Person', 'Other Channel Person', 'A Friend In A Server', '999000999', '777000777']) assert.ok(!all.includes(outsider), `${name}: ${outsider}`);
  }
  const s = await get('discord-server');
  assert.deepEqual([...names(s.st)].sort(), ['Ana Silva!', 'Bruno Costa', 'Vasco Neves*']);
  assert.equal(s.st.inCall, true);
  const d = await get('discord-dm');
  assert.deepEqual([...names(d.st)].sort(), ['Dora Reis!', 'Vasco Neves*'], 'a private call: names from the labels');
});

test('Discord in the browser: each person\'s Discord user id comes from their avatar address and is sent with the roster and the speaker', { skip }, async () => {
  const s = await get('discord-server');
  assert.deepEqual(Object.fromEntries(s.st.participants.map((p) => [p.name, p.id])), { 'Vasco Neves': '100100100', 'Ana Silva': '200200200', 'Bruno Costa': '300300300' });
  assert.deepEqual(roster(s).participants.find((p) => p.name === 'Ana Silva'), { name: 'Ana Silva', self: false, id: '200200200' });
  assert.deepEqual(s.msgs.find((m) => m.type === 'speaker'), { type: 'speaker', name: 'Ana Silva', id: '200200200' });
  assert.equal((await get('discord-dm')).st.participants.find((p) => p.name === 'Dora Reis').id, '400400400');
});

test('Discord in the browser: not in a call (the sidebar only) is no call and no people', { skip }, async () => {
  const r = await get('discord-home');
  assert.deepEqual([r.st.inCall, r.st.participants.length], [false, 0]);
});

test('everything the extension says about these pages is something the app accepts, with the platform it is about', { skip }, async () => {
  for (const [name, platform] of CASES.map((c) => [c.name, c.platform])) {
    for (const m of (await get(name)).msgs) assert.doesNotThrow(() => normalizeSignal({ ...m, platform }), `${name} ${JSON.stringify(m)}`);
  }
});

test('whole path: a Discord page names the voices by account (discord:<id>) like the RPC and the bot, and steps aside when the RPC is connected', { skip }, async () => {
  const server = await get('discord-server');
  const run = (rpcOn) => {
    const hub = new SignalHub();
    if (rpcOn) hub.report('discord-rpc', { kind: 'rpc', state: 'connected', platform: 'discord' });
    const col = new MeetingCollector({ hub, elapsed: () => 1000 });
    for (const m of server.msgs) hub.ingest({ ...m, platform: 'discord' }, { source: 'extension', kind: 'extension' });
    return col;
  };
  const on = run(false);
  assert.deepEqual([...on.accounts().values()].sort(), ['discord:200200200', 'discord:300300300']);
  assert.equal(on.expectedVoices(), 2);
  const off = run(true);
  assert.equal(off.roster(), null, 'the Discord app speaks for this call: the page says nothing');
});

test('the platforms the extension serves are the ones the registry lists with pages, and each says it is not verified yet', () => {
  const vm = require('node:vm');
  const ctx = { self: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'meet', 'selectors.js'), 'utf8'), ctx);
  assert.deepEqual([...Object.keys(ctx.self.WB_PLATFORMS)].sort(), PLATFORMS.list().filter((p) => p.extension).map((p) => p.id).sort());
  for (const [id, p] of Object.entries(ctx.self.WB_PLATFORMS)) assert.equal(p.selectors.verified, false, `${id}: until a real call checks it`);
});
