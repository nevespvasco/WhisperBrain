'use strict';
// Reading a meeting off a browser's accessibility tree: selectors, the reader's changes, the helper process and the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { compileSelectors, readMeeting, MeetingReader } = require('../src/meet/a11y');
const { HelperProcess } = require('../src/meet/helper');
const { A11ySource, helperSpec, loadSelectors, DEFAULT_SELECTORS } = require('../src/meet/a11y-source');
const { SignalHub } = require('../src/meet/hub');
const { fixture } = require('./helpers');

const shipped = () => compileSelectors(JSON.parse(fs.readFileSync(DEFAULT_SELECTORS, 'utf8')));
const snap = (name) => JSON.parse(fs.readFileSync(fixture(`a11y/${name}.json`), 'utf8'));
const node = (p, r, n = '', extra = {}) => ({ p, r, n, ...extra });

test('selectors: a captured page (Chromium, flattened tiles) gives the people and who is speaking', () => {
  const m = readMeeting(snap('mock-meet-speaking-carla'), shipped());
  assert.equal(m.code, 'abc-defg-hij');
  assert.deepEqual(m.participants.map((p) => [p.name, p.speaking]), [['Ana Silva', false], ['Bruno Costa', false], ['Carla Dias', true]]);
  assert.deepEqual(m.speaking, ['Carla Dias']);
  assert.equal(readMeeting(snap('mock-meet-speaking-ana'), shipped()).speaking[0], 'Ana Silva');
});

test('selectors: the shipped file is honest that it was not checked against a real call', () => {
  assert.equal(shipped().verified, false);
});

test('selectors: group modes find the speaking mark where the page puts it', () => {
  // "following": name, mark, name, mark (siblings, as Chromium flattens them)
  const flat = { window: 'x', nodes: [node(-1, 'document web'), node(0, 'list', 'People'), node(1, 'static', 'Ana'), node(1, 'section', 'Speaking'), node(1, 'static', 'Bruno'), node(1, 'section', '')] };
  const sel = (group) => compileSelectors({ version: 1, participants: { scope: { role: '^list$' }, name: { role: '^static$' }, group, speaking: { name: '^speaking$' } } });
  assert.deepEqual(readMeeting(flat, sel('following')).speaking, ['Ana']);
  // "parent": every participant is a box holding the name and the mark
  const boxed = { window: 'x', nodes: [node(-1, 'document web'), node(0, 'list', 'People'), node(1, 'list item'), node(2, 'static', 'Ana'), node(2, 'section', ''), node(1, 'list item'), node(5, 'static', 'Bruno'), node(5, 'section', 'Speaking')] };
  assert.deepEqual(readMeeting(boxed, sel('parent')).speaking, ['Bruno']);
  // "ancestor:2": the mark is a cousin
  const deep = { window: 'x', nodes: [node(-1, 'document web'), node(0, 'list', 'People'), node(1, 'list item'), node(2, 'group'), node(3, 'static', 'Ana'), node(2, 'group'), node(5, 'section', 'Speaking')] };
  assert.deepEqual(readMeeting(deep, sel('ancestor:2')).speaking, ['Ana']);
  assert.throws(() => sel('sideways'), /group/);
});

test('selectors: only the people list counts, "(You)" is the user, a person is counted once, nobody else speaking is not an error', () => {
  const page = { window: 'x - abc-defg-hij', nodes: [node(-1, 'document web'), node(0, 'static', 'Chat message from Zoe'), node(0, 'list', 'Participants'), node(2, 'static', 'Vasco (You)'), node(2, 'section', 'Speaking'), node(2, 'static', 'Ana'), node(2, 'section', ''), node(2, 'static', 'Ana'), node(2, 'static', 'Unknown')] };
  const m = readMeeting(page, shipped());
  assert.deepEqual(m.participants.map((p) => [p.name, p.self]), [['Vasco', true], ['Ana', false]]);
  assert.deepEqual(m.speaking, [], 'the user speaking is not a remote voice');
});

test('selectors: a page with no list says so, and a broken selector file is refused', () => {
  const m = readMeeting({ window: 'Meet', nodes: [node(-1, 'document web'), node(0, 'static', 'hello')] }, shipped());
  assert.equal(m.found, false);
  assert.throws(() => compileSelectors({ version: 2 }), /version/);
  assert.throws(() => compileSelectors({ version: 1, participants: { name: { role: '(' } } }));
});

test('reader: changes only: the call, the people, the speaker; two people speaking at once say nothing', () => {
  const r = new MeetingReader(shipped());
  const first = r.feed(snap('mock-meet-speaking-carla'));
  assert.deepEqual(first.map((m) => m.type), ['meeting', 'roster', 'speaker']);
  assert.equal(first[0].code, 'abc-defg-hij');
  assert.equal(first[2].name, 'Carla Dias');
  assert.deepEqual(r.feed(snap('mock-meet-speaking-carla')), [], 'the same page again: nothing to say');
  assert.deepEqual(r.feed(snap('mock-meet-speaking-ana')).map((m) => [m.type, m.name]), [['speaker', 'Ana Silva']]);
  const both = snap('mock-meet-speaking-ana');
  both.nodes[7].n = 'Speaking';
  assert.deepEqual(r.feed(both).map((m) => [m.type, m.name]), [['speaker', null]]);
  const gone = { window: 'Meet', nodes: [node(-1, 'document web')] };
  assert.deepEqual(r.feed(gone).map((m) => [m.type, m.inCall ?? m.name]), [['meeting', false]]);
});

test('selectors file: yours wins over the shipped one, a broken one is ignored with a note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sel-'));
  try {
    const good = path.join(dir, 'a.json');
    fs.writeFileSync(good, JSON.stringify({ version: 1, verified: true, participants: { name: { role: '^static$' }, speaking: { name: '^x$' } } }));
    assert.equal(loadSelectors(good).sel.verified, true);
    const bad = path.join(dir, 'b.json');
    fs.writeFileSync(bad, '{nope');
    const l = loadSelectors(bad);
    assert.equal(l.file, DEFAULT_SELECTORS);
    assert.match(l.note, /ignored/);
    assert.equal(loadSelectors(path.join(dir, 'missing.json')).note, '', 'no file of your own is normal');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the helper process ----
function fakeSpawn(script) {
  const children = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); };
    c.args = args;
    children.push(c);
    setImmediate(() => script(c, children.length));
    return c;
  };
  return { spawn, children };
}

test('helper process: lines become messages, noise is ignored, and a stop kills it', async () => {
  const { spawn, children } = fakeSpawn((c) => { c.stdout.write('{"event":"hello"}\nnot json\n{"event":"x","n":1}\n'); });
  const p = new HelperProcess({ command: 'h', spawn });
  const got = [];
  p.on('message', (m) => got.push(m));
  p.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(got, [{ event: 'hello' }, { event: 'x', n: 1 }]);
  p.stop();
  assert.equal(children[0].killed, true);
});

test('helper process: a helper that dies is started again, with a growing pause; a helper that is missing is given up', async () => {
  const { spawn, children } = fakeSpawn((c, n) => { c.emit('exit', 1, null); });
  const p = new HelperProcess({ command: 'h', spawn, backoff: [5, 10, 20] });
  const waits = [];
  p.on('restart', (r) => waits.push(r.inMs));
  p.start();
  await new Promise((r) => setTimeout(r, 120));
  p.stop();
  assert.deepEqual(waits.slice(0, 4), [5, 10, 20, 20]);
  assert.ok(children.length >= 4);
  const missing = new HelperProcess({ command: 'nope', spawn: () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; setImmediate(() => c.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }))); return c; } });
  let unavailable = null;
  missing.on('unavailable', (e) => { unavailable = e; });
  missing.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(unavailable.message, /ENOENT/);
  assert.equal(missing.running, false);
});

// ---- the source ----
const line = (o) => `${JSON.stringify(o)}\n`;

test('source: helper snapshots become signals on the hub, and its problems become a status', async () => {
  const hub = new SignalHub();
  const seen = [];
  hub.on('signal', (s) => seen.push([s.msg.type, 'name' in s.msg ? s.msg.name : s.msg.type === 'meeting' ? s.msg.inCall : s.msg.participants.length, s.kind]));
  const { spawn, children } = fakeSpawn((c) => {
    c.stdout.write(line({ event: 'hello' }));
    c.stdout.write(line({ event: 'status', state: 'no-web-tree', app: 'Brave', window: 'Meet - abc-defg-hij' }));
    c.stdout.write(line({ event: 'snapshot', ...snap('mock-meet-speaking-carla') }));
  });
  const src = new A11ySource({ hub, spec: { command: 'h', args: () => ['x'] }, spawn });
  assert.equal(src.start(), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [['meeting', true, 'a11y'], ['roster', 3, 'a11y'], ['speaker', 'Carla Dias', 'a11y']]);
  assert.equal(hub.status().sources.find((s) => s.id === 'a11y').state, 'connected');
  src.stop();
  assert.equal(children[0].killed, true);
  assert.deepEqual(seen.at(-1), ['speaker', null, 'a11y'], 'stopping says nobody is speaking any more');
  assert.equal(hub.status().sources.find((s) => s.id === 'a11y').state, 'off');
});

test('source: a browser that does not expose its page is reported as needing setup', async () => {
  const hub = new SignalHub();
  const { spawn } = fakeSpawn((c) => { c.stdout.write(line({ event: 'status', state: 'no-web-tree', app: 'Brave', window: 'Meet' })); });
  const src = new A11ySource({ hub, spec: { command: 'h', args: () => [] }, spawn });
  src.start();
  await new Promise((r) => setTimeout(r, 20));
  const s = hub.status().sources.find((x) => x.id === 'a11y');
  assert.equal(s.state, 'needs-setup');
  assert.match(s.detail, /accessibility/i);
  src.stop();
});

test('source: a denied permission and a missing helper are reported, not thrown', async () => {
  const hub = new SignalHub();
  const { spawn } = fakeSpawn((c) => { c.stdout.write(line({ event: 'permission', trusted: false })); });
  const src = new A11ySource({ hub, spec: { command: 'h', args: () => [] }, spawn });
  src.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hub.status().sources.find((x) => x.id === 'a11y').state, 'denied');
  src.stop();
  const none = new A11ySource({ hub: new SignalHub(), spec: null });
  assert.equal(none.start(), false);
  assert.equal(none.hub.status().sources[0].state, 'off');
});

test('helper spec: each system has its own helper and way to call it', () => {
  const have = (...files) => (p) => files.some((f) => p.endsWith(f));
  const lin = helperSpec('linux', { roots: ['/b'], exists: have('atspi/whisperbrain-atspi') });
  assert.equal(lin.command, path.join('/b', 'atspi/whisperbrain-atspi'));
  assert.deepEqual(lin.args('watch', { intervalMs: 700 }), ['--interval-ms', '700']);
  assert.ok(lin.args('dump').includes('--dump'));
  const mac = helperSpec('darwin', { roots: ['/r'], exists: have('bin/whisperbrain-ax') });
  assert.deepEqual(mac.args('watch'), ['watch', '--interval-ms', '500']);
  assert.equal(mac.args('windows')[0], 'windows');
  const win = helperSpec('win32', { roots: ['/r'], exists: have('bin/whisperbrain-uia.ps1') });
  assert.equal(win.command, 'powershell.exe');
  assert.deepEqual(win.args('watch').slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.ok(win.args('watch').includes('-IntervalMs'));
  assert.equal(helperSpec('linux', { roots: ['/x'], exists: () => false }), null, 'not built: no helper');
  assert.equal(helperSpec('plan9'), null);
});

test('roles: the same selectors read a macOS tree (AX roles) and a Windows tree (UI Automation control types)', () => {
  const { role } = require('../src/meet/roles');
  const mac = { platform: 'darwin', window: 'Meet - abc-defg-hij', nodes: [node(-1, 'AXWebArea', 'Meet'), node(0, 'AXGroup', ''), node(1, 'AXList', 'Participants'), node(2, 'AXStaticText', 'Ana'), node(2, 'AXGroup', 'Speaking'), node(2, 'AXStaticText', 'Bruno'), node(2, 'AXGroup', '')] };
  const win = { platform: 'win32', window: 'Meet - abc-defg-hij', nodes: [node(-1, 'Document', 'Meet'), node(0, 'Pane', ''), node(1, 'List', 'Participants'), node(2, 'Text', 'Ana'), node(2, 'Group', 'Speaking'), node(2, 'Text', 'Bruno'), node(2, 'Group', '')] };
  for (const snapshot of [mac, win]) {
    const m = readMeeting(snapshot, shipped());
    assert.deepEqual(m.participants.map((p) => [p.name, p.speaking]), [['Ana', true], ['Bruno', false]], snapshot.platform);
    assert.equal(m.code, 'abc-defg-hij');
  }
  assert.equal(role('darwin', { r: 'AXGroup', a: { subrole: 'AXListItem' } }), 'list item');
  assert.equal(role('darwin', { r: 'AXSomethingNew' }), 'something new', 'unknown roles are still readable');
  assert.equal(role('win32', { r: 'ControlType.Text' }), 'static');
  assert.equal(role('linux', { r: 'static' }), 'static');
});
