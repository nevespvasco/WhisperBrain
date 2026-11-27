'use strict';
// Discord over local RPC as a source of meeting signals: the call becomes a meeting, and the detector trusts it over the sound.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SignalHub } = require('../src/meet/hub');
const { PLATFORMS } = require('../src/meet/platforms');
const { DiscordRpcSource } = require('../src/discord/rpc-source');
const { MeetingDetector } = require('../src/meetings/detector');
const { Settings } = require('../src/core/settings');
const { Bus } = require('../src/core/events');
const { open } = require('../src/core/db');

// a stand-in for DiscordRpc: the test sets what Discord says
class FakeRpc extends EventEmitter {
  constructor() { super(); this.st = { state: 'off', detail: '', user: null, call: null }; }
  status() { return this.st; }
  go(state, extra = {}) { Object.assign(this.st, { state, ...extra }); this.emit('state', { state, detail: this.st.detail }); }
  join(call) { this.st.call = call; this.st.state = 'in-call'; this.emit('state', { state: 'in-call', detail: '' }); this.emit('call', call); }
  leave() { this.st.call = null; this.st.state = 'connected'; this.emit('state', { state: 'connected', detail: '' }); this.emit('call', null); }
}
const CALL = { id: 'c1', name: 'Standup', guildId: 'g1', people: [] };

test('discord is a platform of its own, served by a local RPC connection, with no window or page to read', () => {
  const d = PLATFORMS.get('discord');
  assert.equal(d.name, 'Discord');
  assert.equal(d.rpc, true);
  assert.equal(d.selectors, null);
  assert.equal(PLATFORMS.fromWindow('Discord | #general'), null, 'no accessibility reader');
  assert.equal(PLATFORMS.watch('linux').apps.includes('discord'), false, 'the helpers do not look for it');
  assert.equal(PLATFORMS.lag('discord', 'rpc') > 0, true);
});

test('source: joining and leaving a Discord voice call are meeting messages of platform discord, and its state is on the hub', () => {
  const hub = new SignalHub();
  const rpc = new FakeRpc();
  const seen = [];
  hub.on('signal', (s) => seen.push([s.msg.type, s.msg.platform, s.msg.inCall, s.msg.code, s.msg.title, s.kind]));
  const src = new DiscordRpcSource({ hub, rpc });
  src.start();
  rpc.go('closed', { detail: 'The Discord app is not running' });
  assert.deepEqual([hub.sources.get('discord-rpc').state, hub.sources.get('discord-rpc').detail], ['waiting', 'The Discord app is not running']);
  rpc.go('not-authorised', { detail: 'Authorise' });
  assert.equal(hub.sources.get('discord-rpc').state, 'needs-setup');
  rpc.go('connected', { detail: '' });
  assert.equal(hub.sources.get('discord-rpc').state, 'connected');
  rpc.join(CALL);
  rpc.leave();
  assert.deepEqual(seen, [['meeting', 'discord', true, 'c1', 'Standup', 'rpc'], ['meeting', 'discord', false, '', '', 'rpc']]);
  assert.equal(hub.status().meeting.platform, 'discord');
  src.stop();
  assert.equal(hub.sources.get('discord-rpc').state, 'off');
});

test('source: while a call goes on it says so now and then, so the hub keeps believing it (and says when it stops)', () => {
  let t = 0;
  const hub = new SignalHub({ now: () => t });
  const rpc = new FakeRpc();
  const beats = [];
  hub.on('signal', (s) => { if (s.msg.type === 'meeting') beats.push(s.msg.inCall); });
  const timers = [];
  const src = new DiscordRpcSource({ hub, rpc, every: (fn) => { timers.push(fn); return { stop() { timers.length = 0; } }; } });
  src.start();
  rpc.go('connected');
  rpc.join(CALL);
  timers[0](); timers[0]();
  assert.deepEqual(beats, [true, true, true]);
  rpc.leave();
  assert.equal(timers.length, 0, 'no heartbeat outside a call');
});

test('hub: a source that knows the call exactly (rpc) makes its platform authoritative, and its calls are listed', () => {
  const hub = new SignalHub();
  assert.deepEqual(hub.status().authoritative, []);
  hub.report('discord-rpc', { kind: 'rpc', state: 'connected', platform: 'discord' });
  assert.deepEqual(hub.status().authoritative, ['discord']);
  assert.deepEqual(hub.status().calls, []);
  hub.ingest({ type: 'meeting', inCall: true, code: 'c1', title: 'Standup', platform: 'discord' }, { source: 'discord-rpc', kind: 'rpc' });
  hub.ingest({ type: 'meeting', inCall: true, code: 'abc-defg-hij' }, { source: 'extension', kind: 'extension' });
  assert.deepEqual(hub.status().calls.map((c) => [c.platform, c.title, !!c.exact]), [['discord', 'Standup', true], ['meet', '', false]]);
  hub.ingest({ type: 'meeting', inCall: false, platform: 'discord' }, { source: 'discord-rpc', kind: 'rpc' });
  assert.deepEqual(hub.status().calls.map((c) => c.platform), ['meet']);
  // a source gone quiet is no authority
  let t = 0;
  const quiet = new SignalHub({ now: () => t });
  quiet.report('discord-rpc', { kind: 'rpc', state: 'waiting', platform: 'discord' });
  assert.deepEqual(quiet.status().authoritative, [], 'only a connected source');
});

// ---- the meeting detector ----
function detectorRig({ users = [], hub = new SignalHub() } = {}) {
  const db = open(':memory:'), bus = new Bus(), events = [];
  bus.subscribe((e) => events.push(e));
  const settings = new Settings(db, bus);
  const calendar = { current: async () => null, sources: () => [], events: async () => ({ events: [] }) };
  const platform = { micActivity: async () => ({ supported: true, active: users.length > 0, apps: users }), meetingWindows: async () => [] };
  let now = 1_000_000;
  const det = new MeetingDetector({ platform, calendar, bus, settings, recording: { status: () => ({ active: false }) }, signals: hub, idleTicks: 3, now: () => now });
  return { det, events, hub, advance: (ms) => { now += ms; } };
}
const discordPlaying = { name: 'Discord', appId: 'discord', weak: true, via: 'playback' };

test('detector: an exact Discord call from RPC is a meeting at once, and it ends when the call does', async () => {
  const { det, events, hub } = detectorRig();
  hub.report('discord-rpc', { kind: 'rpc', state: 'connected', platform: 'discord' });
  hub.ingest({ type: 'meeting', inCall: true, code: 'c1', title: 'Standup', platform: 'discord' }, { source: 'discord-rpc', kind: 'rpc' });
  await det.tick(); await det.tick();
  const hit = events.filter((e) => e.type === 'meeting.detected');
  assert.equal(hit.length, 1);
  assert.deepEqual([hit[0].data.platform, hit[0].data.apps, hit[0].data.title], ['discord', ['Discord'], 'Standup']);
  hub.ingest({ type: 'meeting', inCall: false, platform: 'discord' }, { source: 'discord-rpc', kind: 'rpc' });
  for (let i = 0; i < 3; i++) await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.ended').length, 1);
});

test('detector: while RPC is connected Discord\'s sound proves nothing, in a call or not; without RPC the old guess still applies', async () => {
  // RPC connected, nobody is in a call, Discord plays notification sounds: no meeting
  const a = detectorRig({ users: [discordPlaying] });
  a.hub.report('discord-rpc', { kind: 'rpc', state: 'connected', platform: 'discord' });
  for (let i = 0; i < 6; i++) { await a.det.tick(); a.advance(4000); }
  assert.equal(a.events.filter((e) => e.type === 'meeting.detected').length, 0);
  assert.equal(a.det.status().active, false);
  // beside another call, Discord's playing sound does not make a second call either
  const zoom = { name: 'Zoom', appId: 'zoom', weak: false };
  const b = detectorRig({ users: [zoom, discordPlaying] });
  b.hub.report('discord-rpc', { kind: 'rpc', state: 'connected', platform: 'discord' });
  for (let i = 0; i < 6; i++) { await b.det.tick(); b.advance(4000); }
  assert.deepEqual(b.det.status().platforms, ['zoom']);
  // RPC not connected: nothing changes (Discord beside a confirmed Zoom call is a second call after 3 hearings)
  const c = detectorRig({ users: [zoom, discordPlaying] });
  for (let i = 0; i < 6; i++) { await c.det.tick(); c.advance(4000); }
  assert.deepEqual(c.det.status().platforms.sort(), ['discord', 'zoom']);
});
