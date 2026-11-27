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
  assert.deepEqual(PLATFORMS.list().map((p) => p.id), ['meet', 'discord'], 'Meet, and Discord (served by RPC, not by a page)');
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
  assert.equal(PLATFORMS.watch('linux').apps, 'chrom|brave|edge|vivaldi|opera|firefox');
  assert.equal(PLATFORMS.watch('darwin').apps, 'chrome|brave|edge|vivaldi|opera|chromium|thebrowser');
  assert.equal(PLATFORMS.watch('win32').apps, 'chrome|msedge|brave|vivaldi|opera|chromium');
  assert.equal(PLATFORMS.watch('linux').title, 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}');
  const r = new PlatformRegistry([...PLATFORMS.list(), FAKE]);
  assert.equal(r.watch('linux').apps, 'chrom|brave|edge|vivaldi|opera|firefox|fakeapp');
  assert.equal(r.watch('linux').title, 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}|FakeCall room');
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
  const src = new A11ySource({ hub, spec: { ...helperSpec('linux', { roots: ['/b'], exists: () => true }) }, spawn: a.spawn });
  src.start(); src.stop();
  assert.deepEqual(a.calls[0].args, ['--interval-ms', '500', '--apps', 'chrom|brave|edge|vivaldi|opera|firefox', '--title', 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}']);

  const dir = tmp();
  const reg = withFake(dir);
  const b = fakeSpawn(() => {});
  const two = new A11ySource({ hub: new SignalHub({ platforms: reg }), platforms: reg, spec: helperSpec('linux', { roots: ['/b'], exists: () => true }), spawn: b.spawn });
  two.start(); two.stop();
  assert.ok(b.calls[0].args.includes('chrom|brave|edge|vivaldi|opera|firefox|fakeapp'));
  assert.ok(b.calls[0].args.includes('meet|[a-z]{3}-[a-z]{4}-[a-z]{3}|FakeCall room'));
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
  assert.deepEqual(st.platforms.map((p) => p.id), ['meet', 'discord', 'fakecall']);
  const [meet, , fake] = st.platforms;
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
    assert.ok(e.selectors && Array.isArray(e.selectors.tile), `${p.id} has selectors`);
    assert.deepEqual([...e.matches], p.extension.matches, `${p.id}: the extension and the registry say the same pages`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].matches.sort(), served.flatMap((p) => p.extension.matches).sort());
  assert.match(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), /platform/, 'the content script says the platform');
  assert.equal(ctx.self.WB_MEET_SELECTORS, ctx.self.WB_PLATFORMS.meet.selectors, 'the old name still works');
});
