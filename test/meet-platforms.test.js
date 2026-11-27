'use strict';
// Meeting platforms as data: one registry entry per platform; everything after the sources (hub, collector, vote) is shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSignal: normalize } = require('../src/meet/protocol');
const { PlatformRegistry, DEFAULT_PLATFORM, PLATFORMS } = require('../src/meet/platforms');

// a made-up second platform: adding a platform is adding data
const FAKE = {
  id: 'fakecall', name: 'FakeCall',
  recognise: { urls: ['^https://fakecall\\.example/'], windowTitle: 'FakeCall room', code: '([0-9]{6})' },
  apps: { linux: 'fakeapp', darwin: 'FakeApp', win32: 'FakeApp' },
  selectors: null,
  lagMs: { extension: 111, a11y: 222 },
};

test('registry: Google Meet is the only shipped platform and the default', () => {
  assert.deepEqual(PLATFORMS.list().map((p) => p.id), ['meet', 'teams', 'zoom', 'discord'], 'Meet, Teams and Zoom in the browser, and Discord (by RPC and in the browser)');
  assert.equal(DEFAULT_PLATFORM, 'meet');
  const meet = PLATFORMS.get('meet');
  assert.equal(meet.name, 'Google Meet');
  assert.equal(meet.lagMs.extension, 300);
  assert.equal(meet.lagMs.a11y, 500);
});

test('registry: a platform is recognised by page address and by window title', () => {
  const r = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  assert.equal(r.fromUrl('https://meet.google.com/abc-defg-hij')?.id, 'meet');
  assert.equal(r.fromUrl('https://fakecall.example/r/123456')?.id, 'fakecall');
  assert.equal(r.fromUrl('https://example.com/'), null);
  assert.equal(r.fromWindow('Meet – abc-defg-hij - Brave')?.id, 'meet');
  assert.equal(r.fromWindow('FakeCall room 12 - FakeApp')?.id, 'fakecall');
  assert.equal(r.fromWindow('Inbox'), null);
});

test('registry: the apps the native helpers watch come from the platforms, and the defaults reproduce today\'s', () => {
  assert.equal(new PlatformRegistry([PLATFORMS.get('meet')]).watch('linux').apps, 'chrom|brave|edge|vivaldi|opera|firefox');
  assert.equal(PLATFORMS.watch('linux').apps, 'chrom|brave|edge|vivaldi|opera|firefox|zoom', 'plus the Zoom app, to measure it (see Zoom desktop below)');
  // with Google Meet alone they are what the helpers always had (Teams adds its desktop app on these two, see below)
  const meetOnly = new PlatformRegistry([PLATFORMS.get('meet')]);
  assert.equal(meetOnly.watch('darwin').apps, 'chrome|brave|edge|vivaldi|opera|chromium|thebrowser');
  assert.equal(meetOnly.watch('win32').apps, 'chrome|msedge|brave|vivaldi|opera|chromium');
  assert.equal(new PlatformRegistry([PLATFORMS.get('meet')]).watch('linux').title, 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}');
  const r = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  assert.equal(r.watch('linux').apps, 'chrom|brave|edge|vivaldi|opera|firefox|zoom|fakeapp');
  assert.equal(r.watch('linux').title, 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}|zoom|FakeCall room');
});

test('registry: the lag of a source kind is the platform\'s, with the generic one as fallback', () => {
  const r = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  assert.equal(r.lag('fakecall', 'extension'), 111);
  assert.equal(r.lag('fakecall', 'vision'), null);
  assert.equal(r.lag('nope', 'extension'), null);
});

test('protocol: every message carries a platform, and one without is read as Google Meet', () => {
  assert.equal(normalize({ type: 'speaker', name: 'Ana' }).platform, 'meet');
  assert.equal(normalize({ type: 'roster', participants: [{ name: 'Ana' }] }).platform, 'meet');
  assert.equal(normalize({ type: 'meeting', inCall: true }).platform, 'meet');
  assert.equal(normalize({ type: 'caption', name: 'Ana', text: 'hi' }).platform, 'meet');
  assert.equal(normalize({ type: 'speaker', name: 'Ana', platform: 'FakeCall' }).platform, 'fakecall');
  assert.equal(normalize({ type: 'speaker', name: 'Ana', platform: '  ' }).platform, 'meet');
  assert.equal(normalize({ type: 'speaker', name: 'Ana', platform: 'x'.repeat(80) + '!!' }).platform.length <= 24, true);
});

// ---- the whole path with a second platform: source -> hub -> collector -> vote ----
const { SignalHub } = require('../src/meet/hub');
const { MeetingCollector } = require('../src/meet/collector');

const SCRIPT = [['s1', 0, 6000], ['s2', 6500, 12000], ['s3', 12500, 20000], ['s1', 20500, 26000], ['s2', 26500, 31000], ['s3', 31500, 36000]];
const WHO = { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' };
const utterances = SCRIPT.map(([id, a, b]) => ({ speaker: 'them', speakerId: id, startMs: a, endMs: b, words: Array.from({ length: Math.floor((b - a) / 500) }, (_, k) => ['w', k * 500, k * 500 + 400]) }));

function call({ platform, kind = 'a11y', lagMs = undefined, registry }) {
  let now = 0;
  const hub = new SignalHub({ platforms: registry });
  const col = new MeetingCollector({ hub, elapsed: () => now });
  const lags = [];
  hub.on('signal', (s) => lags.push(s.lagMs));
  hub.ingest({ type: 'meeting', inCall: true, code: '123456', platform }, { source: kind, kind });
  hub.ingest({ type: 'roster', participants: Object.values(WHO).map((name) => ({ name })), platform }, { source: kind, kind });
  const lag = registry.lag(platform || 'meet', kind) ?? 500;
  for (const [id, a, b] of SCRIPT) {
    now = a + lag; hub.ingest({ type: 'speaker', name: WHO[id], platform }, { source: kind, kind, lagMs });
    now = b + lag; hub.ingest({ type: 'speaker', name: null, platform }, { source: kind, kind, lagMs });
  }
  return { hub, col, lags };
}

test('whole path: a second platform\'s source is voted exactly like Google Meet\'s, with no change to hub, collector or vote', () => {
  const registry = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  for (const platform of ['meet', 'fakecall', undefined]) {
    const { col } = call({ platform, registry });
    const res = col.vote(utterances, { endMs: 40000 });
    assert.deepEqual(res.named.map((n) => [n.speakerId, n.name]).sort(), [['s1', 'Ana Silva'], ['s2', 'Bruno Costa'], ['s3', 'Carla Dias']], `platform ${platform}`);
  }
});

test('hub: a source\'s default lag is the platform\'s (a message without a platform is Google Meet\'s); an explicit lag still wins', () => {
  const registry = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  assert.equal(call({ platform: 'fakecall', registry }).lags.at(-1), 222);
  assert.equal(call({ platform: 'meet', registry }).lags.at(-1), 500);
  assert.equal(call({ platform: undefined, registry }).lags.at(-1), 500);
  assert.equal(call({ platform: 'fakecall', kind: 'extension', registry }).lags.at(-1), 111);
  assert.equal(call({ platform: 'fakecall', lagMs: 900, registry }).lags.at(-1), 900);
  // a platform nobody registered, or one without a lag for this kind: the generic lag of the kind
  assert.equal(call({ platform: 'fakecall', kind: 'vision', registry }).lags.at(-1), 1500);
});

test('hub: messages say which platform they are about, and the hub keeps it with the call and with the source', () => {
  const registry = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  const { hub } = call({ platform: 'fakecall', registry });
  assert.equal(hub.status().meeting.platform, 'fakecall');
  assert.deepEqual(hub.sources.get('a11y').platforms, { fakecall: 14 });
  const seen = [];
  hub.on('signal', (s) => seen.push(s.platform));
  hub.ingest({ type: 'speaker', name: 'Ana' }, { source: 'a11y', kind: 'a11y' });
  assert.deepEqual(seen, ['meet']);
});

// ---- the meeting detector names the call from the platform the source reported ----
const { Settings } = require('../src/core/settings');
const { Bus } = require('../src/core/events');
const { open } = require('../src/core/db');
const { MeetingDetector } = require('../src/meetings/detector');

test('detector: the call is named after the platform the source reported, not assumed to be Google Meet', async () => {
  const registry = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  const db = open(':memory:'), bus = new Bus(), events = [];
  bus.subscribe((e) => events.push(e));
  const settings = new Settings(db, bus);
  const calendar = { current: async () => null, sources: () => [], events: async () => ({ events: [] }) };
  const platform = { micActivity: async () => ({ supported: false, active: false, apps: [] }), meetingWindows: async () => [] };
  for (const [reported, id, name] of [['fakecall', 'fakecall', 'FakeCall'], [undefined, 'meet', 'Google Meet']]) {
    events.length = 0;
    const hub = new SignalHub({ platforms: registry });
    const det = new MeetingDetector({ platform, calendar, bus, settings, recording: { status: () => ({ active: false }) }, signals: hub, platforms: registry });
    hub.ingest({ type: 'meeting', inCall: true, code: '123456', title: 'Weekly', platform: reported }, { source: 'extension', kind: 'extension' });
    await det.tick(); await det.tick();
    const hit = events.filter((e) => e.type === 'meeting.detected');
    assert.equal(hit.length, 1, `${id}: announced`);
    assert.equal(hit[0].data.platform, id);
    assert.deepEqual(hit[0].data.apps, [name]);
    assert.equal(det.status().platform, id);
  }
});

// ---- the accessibility reader and the native helpers ----
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { A11ySource, helperSpec, loadPlatformSelectors } = require('../src/meet/a11y-source');

const FAKE_SELECTORS = { version: 1, verified: true, window: { title: 'FakeCall room', code: '([0-9]{6})' }, participants: { scope: { role: '^list$', name: 'people' }, name: { role: '^static$', name: '\\S' }, group: 'following', speaking: { name: '^speaking$' } } };
const fakeTree = (window, speaker) => ({ event: 'snapshot', platform: 'linux', app: 'FakeApp', window, nodes: [
  { p: -1, r: 'document web', n: 'x' }, { p: 0, r: 'list', n: 'People' },
  { p: 1, r: 'static', n: 'Ana' }, { p: 1, r: 'section', n: speaker === 'Ana' ? 'Speaking' : '' },
  { p: 1, r: 'static', n: 'Bruno' }, { p: 1, r: 'section', n: speaker === 'Bruno' ? 'Speaking' : '' },
] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plat-'));
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args) => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; calls.push({ command, args }); setImmediate(() => script(c)); return c; };
  return { spawn, calls };
}
const line = (o) => `${JSON.stringify(o)}\n`;
const withFake = (dir) => {
  const file = path.join(dir, 'fakecall.json');
  fs.writeFileSync(file, JSON.stringify(FAKE_SELECTORS));
  return new PlatformRegistry([...PLATFORMS.list(), { ...FAKE, selectors: file, extension: { matches: ['https://fakecall.example/*'] } }]);
};

test('helpers: they are told which apps and window titles to watch; without any, today\'s arguments are unchanged', () => {
  const have = (p) => true;
  const apps = 'a|b', title = 't';
  const lin = helperSpec('linux', { roots: ['/b'], exists: have });
  assert.equal(lin.os, 'linux');
  assert.deepEqual(lin.args('watch', { intervalMs: 700 }), ['--interval-ms', '700']);
  assert.deepEqual(lin.args('watch', { intervalMs: 700, apps, title }), ['--interval-ms', '700', '--apps', apps, '--title', title]);
  const mac = helperSpec('darwin', { roots: ['/r'], exists: have });
  assert.deepEqual(mac.args('watch', { apps, title }), ['watch', '--interval-ms', '500', '--apps', apps, '--title', title]);
  const win = helperSpec('win32', { roots: ['/r'], exists: have });
  assert.deepEqual(win.args('watch', { apps, title }).slice(-4), ['-Apps', apps, '-Title', title]);
});

test('source: the helper is started with the apps and titles of every platform with a reader (the defaults are today\'s)', async () => {
  const hub = new SignalHub();
  const a = fakeSpawn(() => {});
  const meetOnly = new PlatformRegistry([PLATFORMS.get('meet')]);
  const src = new A11ySource({ hub, platforms: meetOnly, spec: { ...helperSpec('linux', { roots: ['/b'], exists: () => true }) }, spawn: a.spawn });
  src.start(); src.stop();
  assert.deepEqual(a.calls[0].args, ['--interval-ms', '500', '--apps', 'chrom|brave|edge|vivaldi|opera|firefox', '--title', 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}']);

  const dir = tmp();
  const reg = withFake(dir);
  const b = fakeSpawn(() => {});
  const two = new A11ySource({ hub: new SignalHub({ platforms: reg }), platforms: reg, spec: helperSpec('linux', { roots: ['/b'], exists: () => true }), spawn: b.spawn });
  two.start(); two.stop();
  assert.ok(b.calls[0].args.includes('chrom|brave|edge|vivaldi|opera|firefox|zoom|fakeapp'));
  assert.ok(b.calls[0].args.includes('meet|[a-z]{3}-[a-z]{4}-[a-z]{3}|zoom|FakeCall room'));
});

test('source: each window is read with the selectors of its platform, and its messages say which platform that is', async () => {
  const dir = tmp();
  const reg = withFake(dir);
  const hub = new SignalHub({ platforms: reg });
  const seen = [];
  hub.on('signal', (s) => seen.push([s.msg.platform, s.msg.type, s.msg.type === 'speaker' ? s.msg.name : s.msg.type === 'roster' ? s.msg.participants.length : s.msg.code, s.lagMs]));
  const { spawn } = fakeSpawn((c) => {
    c.stdout.write(line(fakeTree('FakeCall room 123456 - FakeApp', 'Bruno')));
    c.stdout.write(line({ event: 'snapshot', ...JSON.parse(fs.readFileSync(require('../test/helpers').fixture('a11y/mock-meet-speaking-carla.json'), 'utf8')) }));
  });
  const src = new A11ySource({ hub, platforms: reg, spec: { command: 'h', args: () => [], os: 'linux' }, spawn });
  src.start();
  await new Promise((r) => setTimeout(r, 30));
  src.stop();
  assert.deepEqual(seen.filter((s) => s[0] === 'fakecall'), [['fakecall', 'meeting', '123456', 222], ['fakecall', 'roster', 2, 222], ['fakecall', 'speaker', 'Bruno', 222], ['fakecall', 'speaker', null, 222]]);  // the last: stopping says nobody speaks
  assert.deepEqual(seen.filter((s) => s[0] === 'meet').slice(0, 3).map((s) => s.slice(0, 3)), [['meet', 'meeting', 'abc-defg-hij'], ['meet', 'roster', 3], ['meet', 'speaker', 'Carla Dias']]);
});

test('selectors: your own file overrides a platform\'s, and the file you already have is the one of Google Meet', () => {
  const dir = tmp();
  const reg = withFake(dir);
  fs.writeFileSync(path.join(dir, 'fakecall-selectors.json'), JSON.stringify({ ...FAKE_SELECTORS, verified: false, window: { title: 'MINE' } }));
  const mine = loadPlatformSelectors('fakecall', { dataDir: dir, platforms: reg });
  assert.equal(mine.file, path.join(dir, 'fakecall-selectors.json'));
  assert.equal(mine.sel.verified, false);
  assert.equal(loadPlatformSelectors('fakecall', { dataDir: tmp(), platforms: reg }).sel.verified, true, 'no file of your own: the shipped one');
  fs.writeFileSync(path.join(dir, 'meet-selectors.json'), JSON.stringify({ version: 1, verified: true, participants: {} }));
  assert.equal(loadPlatformSelectors('meet', { dataDir: dir, platforms: reg }).file, path.join(dir, 'meet-selectors.json'));
  assert.throws(() => loadPlatformSelectors('nope', { dataDir: dir, platforms: reg }), /platform/);
});

// ---- the redacted tree dump takes a platform ----
const { redactSnapshot } = require('../src/meet/redact');

test('redact: the meeting code is hidden with the platform\'s own pattern, and the title keeps only the platform\'s short name', () => {
  const reg = new PlatformRegistry([...PLATFORMS.list(), { ...FAKE, short: 'Fake' }]);
  const snap = { window: 'FakeCall room 123456 - FakeApp', nodes: [{ p: -1, r: 'document web', n: 'Ana Silva' }] };
  const r = redactSnapshot(snap, { platform: 'fakecall', platforms: reg });
  assert.equal(r.window, 'Fake «code»');
  assert.equal(r.nodes[0].n, '«9»');
  assert.equal(redactSnapshot({ window: 'Meet - abc-defg-hij - Brave', nodes: [] }).window, 'Meet «code»', 'Google Meet as before');
  assert.equal(redactSnapshot({ window: 'Meet - abc-defg-hij - Brave', nodes: [] }, { platform: 'meet' }).window, 'Meet «code»');
});

// ---- Settings → Names from the meeting window lists the sources per platform ----
const { MeetService } = require('../src/meet/service');

test('status: the sources are listed per platform, with the messages each platform got, and Meet\'s old fields are still there', () => {
  const dir = tmp();
  const reg = withFake(dir);
  const store = { meet: { enabled: true, a11y: true, extension: false, vision: false, port: 0, token: 'x' } };
  const settings = { get: (k) => store[k], update: () => {} };
  const svc = new MeetService({ settings, bus: { subscribe() {} }, platformId: 'linux', roots: ['/b'], dataDir: dir, platforms: reg });
  svc.hub.report('extension', { kind: 'extension', state: 'connected' });
  svc.hub.ingest({ type: 'speaker', name: 'Ana', platform: 'fakecall' }, { source: 'extension', kind: 'extension' });
  svc.hub.ingest({ type: 'speaker', name: 'Ana' }, { source: 'extension', kind: 'extension' });
  svc.hub.ingest({ type: 'speaker', name: 'Bruno' }, { source: 'extension', kind: 'extension' });
  const st = svc.status();
  assert.deepEqual(st.platforms.map((p) => p.id), ['meet', 'teams', 'zoom', 'discord', 'fakecall']);
  const meet = st.platforms[0], fake = st.platforms.at(-1);
  assert.equal(meet.name, 'Google Meet');
  assert.equal(meet.verified, false, 'the shipped Meet selectors are still a guess');
  assert.equal(fake.verified, true);
  assert.equal(meet.sources.find((s) => s.kind === 'extension').messages, 2);
  assert.equal(fake.sources.find((s) => s.kind === 'extension').messages, 1);
  assert.equal(meet.sources.find((s) => s.kind === 'extension').state, 'connected');
  assert.deepEqual(fake.sources.map((s) => s.kind), ['a11y', 'extension', 'vision']);
  const noExt = new MeetService({ settings, bus: { subscribe() {} }, platformId: 'linux', roots: ['/b'], dataDir: dir, platforms: new PlatformRegistry([{ ...FAKE, selectors: path.join(dir, 'fakecall.json') }]) });
  assert.deepEqual(noExt.status().platforms[0].sources.map((s) => s.kind), ['a11y', 'vision'], 'a platform the extension does not serve lists no extension');
  assert.equal(st.a11y.selectorsVerified, false, 'the fields that were there before are unchanged');
  assert.equal(st.a11y.ownSelectors, path.join(dir, 'meet-selectors.json'));
  assert.ok(Array.isArray(st.sources) && 'meeting' in st);
});

// ---- the browser extension serves the platforms that say so ----
test('extension: it runs on the pages the registry lists, knows each platform\'s selectors, and tells which platform a message is about', () => {
  const vm = require('node:vm');
  const root = path.join(__dirname, '..', 'extension', 'meet');
  const ctx = { self: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'selectors.js'), 'utf8'), ctx);
  const served = PLATFORMS.list().filter((p) => p.extension);
  assert.deepEqual([...Object.keys(ctx.self.WB_PLATFORMS)].sort(), served.map((p) => p.id).sort());
  for (const p of served) {
    const e = ctx.self.WB_PLATFORMS[p.id];
    assert.ok(e.selectors && (Array.isArray(e.selectors.tile) || typeof e.selectors.tile === 'string'), `${p.id} has selectors`);
    assert.deepEqual([...e.matches], p.extension.matches, `${p.id}: the extension and the registry say the same pages`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].matches.sort(), served.flatMap((p) => p.extension.matches).sort());
  assert.match(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), /platform/, 'the content script says the platform');
  assert.equal(ctx.self.WB_MEET_SELECTORS, ctx.self.WB_PLATFORMS.meet.selectors, 'the old name still works');
});

// ---- the web platforms: Teams, Zoom, Discord in the browser ----
test('registry: Teams, Zoom and Discord in the browser are entries with their pages, default lags and nothing else to change', () => {
  const teams = PLATFORMS.get('teams'), zoom = PLATFORMS.get('zoom'), discord = PLATFORMS.get('discord');
  assert.equal(teams.name, 'Microsoft Teams');
  assert.equal(PLATFORMS.fromUrl('https://teams.microsoft.com/v2/')?.id, 'teams', 'work or school');
  assert.equal(PLATFORMS.fromUrl('https://teams.live.com/v2/')?.id, 'teams', 'personal');
  assert.equal(PLATFORMS.fromUrl('https://app.zoom.us/wc/123456789/start')?.id, 'zoom');
  assert.equal(PLATFORMS.fromUrl('https://discord.com/channels/1/2')?.id, 'discord');
  assert.equal(PLATFORMS.fromUrl('https://meet.google.com/abc-defg-hij')?.id, 'meet');
  for (const p of [teams, zoom, discord]) assert.ok(p.extension.matches.length >= 1, p.id);
  assert.ok(teams.lagMs.extension > 0 && zoom.lagMs.extension > 0 && discord.lagMs.extension > 0);
  assert.equal(discord.rpc, true, 'Discord is still served by RPC too');
});

test('roster: one made only of the people whose tile is on the screen says so, and is never a head count', () => {
  const partial = normalize({ type: 'roster', participants: [{ name: 'Ana' }], partial: true });
  assert.equal(partial.partial, true);
  assert.equal('partial' in normalize({ type: 'roster', participants: [{ name: 'Ana' }] }), false, 'a full roster says nothing more than before');
  let now = 0;
  const hub = new SignalHub();
  const col = new MeetingCollector({ hub, elapsed: () => now });
  hub.ingest({ type: 'roster', participants: [{ name: 'Vasco', self: true }, { name: 'Ana' }, { name: 'Bruno' }], partial: true, platform: 'zoom' }, { source: 'extension', kind: 'extension' });
  assert.equal(col.expectedVoices(), null, 'not everybody is on the screen: the head count is not known');
  assert.deepEqual(col.roster().map((p) => p.name), ['Vasco', 'Ana', 'Bruno'], 'the names still help the vote');
  now = 1000;
  hub.ingest({ type: 'roster', participants: [{ name: 'Vasco', self: true }, { name: 'Ana' }, { name: 'Bruno' }, { name: 'Carla' }], platform: 'zoom' }, { source: 'extension', kind: 'extension' });
  assert.equal(col.expectedVoices(), 3, 'the panel is open: now it is a head count');
});

test('hub: while the platform\'s own app is connected over RPC, a browser page of the same platform says nothing the vote would hear', () => {
  const hub = new SignalHub();
  const heard = [];
  hub.on('signal', (s) => heard.push([s.msg.platform, s.msg.type, s.kind]));
  hub.ingest({ type: 'speaker', name: 'Ana', platform: 'discord' }, { source: 'extension', kind: 'extension' });
  hub.report('discord-rpc', { kind: 'rpc', state: 'connected', platform: 'discord' });
  hub.ingest({ type: 'speaker', name: 'Bruno', platform: 'discord' }, { source: 'extension', kind: 'extension' });
  hub.ingest({ type: 'speaker', name: 'Carla', platform: 'meet' }, { source: 'extension', kind: 'extension' });
  hub.ingest({ type: 'speaker', name: 'Dora', platform: 'discord' }, { source: 'discord-rpc', kind: 'rpc' });
  assert.deepEqual(heard, [['discord', 'speaker', 'extension'], ['meet', 'speaker', 'extension'], ['discord', 'speaker', 'rpc']]);
  assert.equal(hub.sources.get('extension').ignored, 1);
  hub.report('discord-rpc', { kind: 'rpc', state: 'waiting', platform: 'discord' });
  hub.ingest({ type: 'speaker', name: 'Eva', platform: 'discord' }, { source: 'extension', kind: 'extension' });
  assert.equal(heard.length, 4, 'RPC gone: the page speaks again');
});

// ---- Teams desktop (Windows, macOS) through the accessibility tree ----
const { readMeeting, compileSelectors: compileSel } = require('../src/meet/a11y');
const simTree = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'a11y', `${n}.json`), 'utf8'));
const teamsSel = () => compileSel(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'meet', 'selectors', 'teams.json'), 'utf8')));

test('Teams desktop: the helpers watch the Teams app (by name or bundle id) on Windows and macOS, and nothing new on Linux, where Teams is web only', () => {
  const t = PLATFORMS.get('teams');
  assert.match(t.apps.win32, /ms-teams/);
  assert.match(t.apps.darwin, /Microsoft Teams|com\.microsoft\.teams2/);
  assert.equal(t.apps.linux, undefined);
  for (const os of ['win32', 'darwin']) { const w = PLATFORMS.watch(os); assert.match(w.apps, /teams/i); assert.match(w.title, /teams/i, `${os}: the title filter lets the Teams window through`); }
  assert.doesNotMatch(PLATFORMS.watch('linux').apps + PLATFORMS.watch('linux').title, /teams/i, 'Linux: Teams is read by the extension');
  assert.equal(PLATFORMS.fromWindow('Weekly sync | Microsoft Teams')?.id, 'teams');
  assert.equal(PLATFORMS.fromWindow('Meeting notes - Google Docs'), null, '"Meeting" is not Meet');
  assert.equal(PLATFORMS.fromWindow('Meet - abc-defg-hij')?.id, 'meet');
  assert.ok(PLATFORMS.readable('win32').some((p) => p.id === 'teams') && PLATFORMS.readable('darwin').some((p) => p.id === 'teams'));
  assert.ok(!PLATFORMS.readable('linux').some((p) => p.id === 'teams'));
});

test('Teams desktop: the same selectors read the Windows (UI Automation) and macOS (AX) trees: people, who speaks, you', () => {
  for (const name of ['sim-teams-win', 'sim-teams-mac']) {
    const m = readMeeting(simTree(name), teamsSel());
    assert.deepEqual(m.participants.map((p) => [p.name, p.self, p.speaking]), [['Vasco Neves', true, false], ['Ana Silva', false, true], ['Bruno Costa', false, false], ['Carla Dias', false, false]], name);
    assert.deepEqual(m.speaking, ['Ana Silva']);
    assert.ok(m.participants.every((p) => !/muted|organi[sz]er|speaking/i.test(p.name)), 'the labels of a row are not people');
  }
});

test('Teams desktop: the reader sends platform teams messages from the Teams window, and the Teams window feeds meeting detection (macOS: the only call signal)', async () => {
  const { MeetingDetector: Detector } = require('../src/meetings/detector');
  const hub = new SignalHub();
  const seen = [];
  hub.on('signal', (s) => seen.push([s.msg.platform, s.msg.type]));
  const { spawn } = fakeSpawn((c) => { c.stdout.write(line(simTree('sim-teams-mac'))); });
  const src = new A11ySource({ hub, spec: helperSpec('darwin', { roots: ['/r'], exists: () => true }), spawn });
  src.start();
  await new Promise((r) => setTimeout(r, 30));
  src.stop();
  assert.deepEqual([...new Set(seen.map((s) => s[0]))], ['teams']);
  assert.deepEqual(seen.slice(0, 3).map((s) => s[1]), ['meeting', 'roster', 'speaker']);
  // a fresh hub, as it was while the call went on: macOS cannot watch the microphone, so this is how the call is known
  const live = new SignalHub();
  const { spawn: spawn2 } = fakeSpawn((c) => { c.stdout.write(line(simTree('sim-teams-mac'))); });
  const src2 = new A11ySource({ hub: live, spec: helperSpec('darwin', { roots: ['/r'], exists: () => true }), spawn: spawn2 });
  src2.start();
  await new Promise((r) => setTimeout(r, 30));
  const db = open(':memory:'), bus = new Bus(), events = [];
  bus.subscribe((e) => events.push(e));
  const det = new Detector({ platform: { micActivity: async () => ({ supported: false, active: false, apps: [] }), meetingWindows: async () => [] }, calendar: { current: async () => null, sources: () => [], events: async () => ({ events: [] }) }, bus, settings: new Settings(db, bus), recording: { status: () => ({ active: false }) }, signals: live });
  await det.tick(); await det.tick();
  src2.stop();
  const hit = events.filter((e) => e.type === 'meeting.detected');
  assert.equal(hit.length, 1);
  assert.deepEqual([hit[0].data.platform, hit[0].data.apps], ['teams', ['Microsoft Teams']]);
});

test('Teams desktop: the helper is told Teams\' app and window title (macOS, Windows), and the one for Linux is not', () => {
  const have = () => true;
  const win = helperSpec('win32', { roots: ['/r'], exists: have });
  const args = win.args('watch', { ...PLATFORMS.watch('win32') });
  assert.match(args[args.indexOf('-Apps') + 1], /ms-teams/);
  const mac = helperSpec('darwin', { roots: ['/r'], exists: have });
  assert.match(mac.args('watch', { ...PLATFORMS.watch('darwin') }).join(' '), /--apps .*Microsoft Teams/);
});

test('Teams desktop: not verified, and Settings says so', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'meet', 'selectors', 'teams.json'), 'utf8')).verified, false);
  const dir = tmp();
  const store = { meet: { enabled: true, a11y: true, extension: false, vision: false, port: 0, token: 'x' } };
  const svc = new MeetService({ settings: { get: (k) => store[k], update() {} }, bus: { subscribe() {} }, platformId: 'win32', roots: ['/b'], dataDir: dir });
  const teams = svc.status().platforms.find((p) => p.id === 'teams');
  assert.equal(teams.verified, false);
  assert.ok(teams.sources.some((s) => s.kind === 'a11y'), 'on Windows the accessibility reader serves Teams');
  assert.ok(!new MeetService({ settings: { get: (k) => store[k], update() {} }, bus: { subscribe() {} }, platformId: 'linux', roots: ['/b'], dataDir: dir }).status().platforms.find((p) => p.id === 'teams').sources.some((s) => s.kind === 'a11y'), 'on Linux it does not');
});

// ---- Zoom desktop (macOS, Windows; Linux to be measured) through the accessibility tree ----
const zoomSel = () => compileSel(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'meet', 'selectors', 'zoom.json'), 'utf8')));
const launcher = require('../src/meet/launcher');

test('Zoom desktop: the helpers watch the Zoom app on every system (Linux: so it can be measured), only meeting windows count', () => {
  const z = PLATFORMS.get('zoom');
  assert.match(z.apps.win32, /zoom/i); assert.match(z.apps.darwin, /zoom\\\.us/);   // a regex source: zoom\.us, and the bundle id us.zoom.xos
  assert.match(z.apps.darwin, /us\\\.zoom\\\.xos/); assert.match(z.apps.linux, /zoom/i);
  for (const os of ['win32', 'darwin', 'linux']) assert.match(PLATFORMS.watch(os).apps, /zoom/i, os);
  assert.equal(PLATFORMS.fromWindow('Zoom Meeting')?.id, 'zoom');
  assert.equal(PLATFORMS.fromWindow('Zoom Workplace'), null, 'the home window is no call');
  assert.equal(PLATFORMS.fromWindow('Zoom Webinar')?.id, 'zoom');
  assert.ok(PLATFORMS.readable('linux').some((p) => p.id === 'zoom'));
  assert.equal(zoomSel().verified, false);
});

test('Zoom desktop: the same selectors read the Windows and macOS trees: the participants list and who is talking', () => {
  for (const name of ['sim-zoom-win', 'sim-zoom-mac']) {
    const m = readMeeting(simTree(name), zoomSel());
    assert.deepEqual(m.participants.map((p) => [p.name, p.self, p.speaking]), [['Vasco Neves', true, false], ['Ana Silva', false, true], ['Bruno Costa', false, false], ['Carla Dias', false, false]], name);
    assert.deepEqual(m.speaking, ['Ana Silva']);
    assert.equal(m.partial, false);
    assert.equal(m.code, '');
  }
});

test('Zoom desktop: with the participants panel closed the "Talking:" label still says who speaks, and the roster says it is partial', () => {
  const m = readMeeting(simTree('sim-zoom-closed'), zoomSel());
  assert.deepEqual(m.participants.map((p) => [p.name, p.speaking]), [['Bruno Costa', true]]);
  assert.deepEqual(m.speaking, ['Bruno Costa']);
  assert.equal(m.partial, true);
  const { MeetingReader } = require('../src/meet/a11y');
  const msgs = new MeetingReader(zoomSel()).feed(simTree('sim-zoom-closed'));
  assert.deepEqual(msgs.map((x) => [x.type, x.partial ?? x.name ?? x.inCall]), [['meeting', true], ['roster', true], ['speaker', 'Bruno Costa']]);
  const home = readMeeting(simTree('sim-zoom-home'), zoomSel());
  assert.deepEqual([home.found, home.participants.length, home.speaking.length], [false, 0, 0], 'the home window is nobody\'s call');
});

test('Zoom desktop: the window is read with Zoom\'s selectors, its messages say zoom, and the call feeds meeting detection', async () => {
  const hub = new SignalHub();
  const seen = [];
  hub.on('signal', (s) => seen.push([s.msg.platform, s.msg.type]));
  const { spawn } = fakeSpawn((c) => { c.stdout.write(line(simTree('sim-zoom-win'))); });
  const src = new A11ySource({ hub, spec: helperSpec('win32', { roots: ['/r'], exists: () => true }), spawn });
  src.start();
  await new Promise((r) => setTimeout(r, 30));
  src.stop();
  assert.deepEqual([...new Set(seen.map((s) => s[0]))], ['zoom']);
  assert.ok(seen.some((s) => s[1] === 'speaker'));
});

test('Zoom desktop on Linux: a Qt app shows its tree only when its accessibility is switched on, which a launcher of your own does and can undo', () => {
  const files = {
    '/usr/share/applications/Zoom.desktop': '[Desktop Entry]\nName=Zoom\nExec=/opt/zoom/ZoomLauncher %U\nType=Application\nCategories=Network;\n',
    '/usr/share/applications/brave-browser.desktop': '[Desktop Entry]\nName=Brave\nExec=/usr/bin/brave-browser-stable %U\nType=Application\n',
  };
  const written = {};
  const io = { home: '/home/u', env: { XDG_DATA_DIRS: '/usr/share' }, extra: false, read: (f) => written[f] ?? files[f] ?? (() => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); })(), list: (d) => (d === '/usr/share/applications' ? Object.keys(files).map((f) => path.basename(f)) : (() => { throw new Error('no'); })()) };
  const all = launcher.browsers(io);
  const zoom = all.find((b) => b.file === 'Zoom.desktop');
  assert.ok(zoom, 'the Zoom launcher is listed beside the browsers');
  assert.equal(zoom.state, 'off');
  assert.equal(zoom.app, 'zoom');
  const r = launcher.enable('Zoom.desktop', { ...io, write: (f, t) => { written[f] = t; }, mkdir() {} });
  assert.equal(r.state, 'on');
  const text = written['/home/u/.local/share/applications/Zoom.desktop'];
  assert.match(text, /^Exec=env QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 QT_ACCESSIBILITY=1 \/opt\/zoom\/ZoomLauncher %U$/m);
  assert.match(text, /X-WhisperBrain-Accessibility=true/);
  assert.doesNotMatch(text, /force-renderer-accessibility/, 'the browser flag is for browsers');
  assert.equal(launcher.browsers(io).find((b) => b.file === 'Zoom.desktop').state, 'on');
  let removed = null;
  assert.equal(launcher.disable('Zoom.desktop', { ...io, remove: (f) => { removed = f; } }), true);
  assert.equal(removed, '/home/u/.local/share/applications/Zoom.desktop');
  // the browser entry still gets the browser flag, unchanged
  assert.match((launcher.enable('brave-browser.desktop', { ...io, write: (f, t) => { written[f] = t; }, mkdir() {} }), written['/home/u/.local/share/applications/brave-browser.desktop']), /--force-renderer-accessibility/);
});
