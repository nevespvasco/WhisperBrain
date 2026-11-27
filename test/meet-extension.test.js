'use strict';
// The browser extension for Google Meet: what it reads and tells (the differ, offline), and the whole thing in a real
// browser (live, skipped where there is none).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Differ } = require('../extension/meet/reader');
const { normalize } = require('../src/meet/protocol');
const { ROOT } = require('./helpers');

const st = (o = {}) => ({ inCall: true, code: 'abc-defg-hij', participants: [], speaking: [], captions: [], ...o });
const P = (name, speaking = false, self = false) => ({ name, speaking, self });

test('extension differ: the call, the people and the speaker are said once, and again when they change', () => {
  const d = new Differ();
  const a = d.diff(st({ participants: [P('Vasco', false, true), P('Ana', true), P('Bruno')], speaking: ['Ana'] }));
  assert.deepEqual(a.map((m) => m.type), ['meeting', 'roster', 'speaker']);
  assert.deepEqual(a[1].participants, [{ name: 'Vasco', self: true }, { name: 'Ana', self: false }, { name: 'Bruno', self: false }]);
  assert.deepEqual(d.diff(st({ participants: [P('Vasco', false, true), P('Ana', true), P('Bruno')], speaking: ['Ana'] })), [], 'the same again: nothing to say');
  assert.deepEqual(d.diff(st({ participants: [P('Vasco', false, true), P('Ana'), P('Bruno', true)], speaking: ['Bruno'] })).map((m) => [m.type, m.name]), [['speaker', 'Bruno']]);
  assert.deepEqual(d.diff(st({ participants: [P('Vasco', false, true), P('Ana'), P('Bruno'), P('Carla')], speaking: [] })).map((m) => m.type), ['roster', 'speaker'], 'a newcomer, and nobody speaks any more');
  assert.deepEqual(d.diff(st({ inCall: false })).map((m) => [m.type, m.inCall]), [['meeting', false]]);
});

test('extension differ: two people speaking at once say nothing; leaving the call silences the speaker', () => {
  const d = new Differ();
  d.diff(st({ participants: [P('Ana', true), P('Bruno')], speaking: ['Ana'] }));
  assert.deepEqual(d.diff(st({ participants: [P('Ana', true), P('Bruno', true)], speaking: ['Ana', 'Bruno'] })).map((m) => [m.type, m.name]), [['speaker', null]]);
  d.diff(st({ participants: [P('Ana', true), P('Bruno')], speaking: ['Ana'] }));
  assert.deepEqual(d.diff(st({ inCall: false })).map((m) => [m.type, 'name' in m ? m.name : m.inCall]), [['meeting', false], ['speaker', null]]);
});

test('extension differ: a caption is said as it grows, and said final when its block is gone', () => {
  const d = new Differ();
  const base = { participants: [P('Ana')] };
  d.diff(st(base));
  assert.deepEqual(d.diff(st({ ...base, captions: [{ name: 'Ana', text: 'hello' }] })).map((m) => [m.type, m.text, m.final]), [['caption', 'hello', false]]);
  assert.deepEqual(d.diff(st({ ...base, captions: [{ name: 'Ana', text: 'hello there' }] })).map((m) => [m.text, m.final]), [['hello there', false]]);
  assert.deepEqual(d.diff(st({ ...base, captions: [{ name: 'Ana', text: 'hello there' }] })), []);
  assert.deepEqual(d.diff(st({ ...base, captions: [] })).map((m) => [m.name, m.text, m.final]), [['Ana', 'hello there', true]]);
});

test('extension differ: everything it says is something the app accepts', () => {
  const d = new Differ();
  const msgs = [
    ...d.diff(st({ participants: [P('Vasco (You)', false, true), P('Ana', true)], speaking: ['Ana'], captions: [{ name: 'Ana', text: 'hi' }] })),
    ...d.diff(st({ inCall: false })),
  ];
  assert.ok(msgs.length >= 4);
  for (const m of msgs) assert.doesNotThrow(() => normalize(m), JSON.stringify(m));
});

test('extension: the manifest asks for no more than it needs', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/meet/manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions.sort(), ['activeTab', 'alarms', 'offscreen', 'storage', 'tabCapture'], 'tabCapture and offscreen for the call\'s tab, activeTab so it is only ever the tab the person pressed the button on');
  assert.deepEqual(m.host_permissions.sort(), ['http://127.0.0.1/*', 'http://localhost/*'], 'only this computer');
  const { PLATFORMS } = require('../src/meet/platforms');
  assert.deepEqual([...m.content_scripts[0].matches].sort(), PLATFORMS.list().flatMap((p) => p.extension?.matches || []).sort(), 'only the pages of the platforms it serves');
  assert.ok(m.content_scripts[0].matches.every((x) => /^https:\/\/[a-z.*]+\.?[a-z]+\.[a-z]+\/[a-z]+\/\*$|^https:\/\/[\w.-]+\/\*$|^https:\/\/\*\.zoom\.us\/wc\/\*$/.test(x)), 'no wide patterns: each is one site (Zoom: its web client only)');
  assert.ok(!JSON.stringify(m).includes('<all_urls>'));
  for (const f of ['background.js', 'content.js', 'reader.js', 'selectors.js', 'options.html', 'options.js', 'optionstab.js', 'offscreen.html', 'offscreen.js', 'tabaudio.js']) assert.ok(fs.existsSync(path.join(ROOT, 'extension/meet', f)), f);
});

// ---- live: a real browser, the real extension ----
const which = (c) => { try { return cp.execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// Google Chrome and Edge (the branded builds) ignore --load-extension in recent versions, so only Chromium-based builds that honour it can run this
const BROWSERS = ['brave-browser', 'chromium', 'chromium-browser'];
const browser = BROWSERS.map(which).find((p) => p && !fs.realpathSync(p).startsWith('/snap/')) || '';
const missing = process.platform !== 'linux' ? 'not Linux' : process.env.WB_SKIP_BROWSER ? 'WB_SKIP_BROWSER is set' : !which('Xvfb') ? 'no Xvfb' : !browser ? 'no Brave or Chromium that is not a snap (branded Chrome and Edge ignore --load-extension)' : '';

test('live: the extension in a real browser tells the app the call, the people, the speaker and the captions', { skip: missing || false, timeout: 90000 }, () => {
  const out = cp.spawnSync(process.execPath, [path.join(ROOT, 'test/support/extension-live.js')], { env: { ...process.env, WB_BROWSER: browser, WB_ROOT: ROOT, WB_RUN_MS: '7000' }, encoding: 'utf8', timeout: 60000 });
  const line = out.stdout.split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `the runner printed nothing: ${out.stderr.slice(-400)}`);
  const r = JSON.parse(line);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.meeting[0], [true, 'abc-defg-hij']);
  assert.deepEqual([...r.roster[0]].sort(), ['Ana Silva', 'Bruno Costa', 'Carla Dias', 'Vasco Neves*']);
  const order = r.speakers.map((n) => ['Ana Silva', 'Bruno Costa', 'Carla Dias'].indexOf(n));
  assert.ok(order.length >= 3 && order.slice(1).every((n, i) => n === (order[i] + 1) % 3), `the highlight in order: ${r.speakers.join(' → ')}`);
  assert.ok(r.captions.some((c) => c.name === 'Bruno Costa' && c.text === 'good morning to you'), `captions with names: ${JSON.stringify(r.captions)}`);
  assert.ok(r.sources.includes('extension/extension'));
  assert.ok(r.hub.some(([id, kind, state]) => id === 'extension' && kind === 'extension' && state === 'connected'));
});
