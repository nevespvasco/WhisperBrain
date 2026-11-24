'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Settings } = require('../src/core/settings');
const { Calendar } = require('../src/meetings/calendar');
const { MeetingDetector } = require('../src/meetings/detector');
const { Dictation, tidy } = require('../src/dictation/dictation');
const { PushSource } = require('../src/audio/source');
const { tmpDir } = require('./helpers');

function env() {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  return { db, bus, events, settings: new Settings(db, bus) };
}
const ICS = (start) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Planning\r\nDTSTART:${start}\r\nDURATION:PT1H\r\nLOCATION:https://meet.google.com/aaa-bbbb-ccc\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

test('calendar: file and URL sources, caching, error reporting, source validation', async () => {
  const { settings, bus } = env();
  const t0 = Date.parse('2026-11-25T10:00:00Z');
  let hits = 0;
  const fetchImpl = async (url) => { hits++; return url.includes('bad') ? { ok: false, status: 404 } : { ok: true, text: async () => ICS(stamp(t0 + 600000)) }; };
  const cal = new Calendar({ settings, bus, fetchImpl, now: () => t0 });
  assert.throws(() => cal.addSource({ kind: 'url', location: 'ftp://x' }), /https/);
  assert.throws(() => cal.addSource({ kind: 'nope', location: 'x' }), /kind/);
  const u = cal.addSource({ kind: 'url', location: 'webcal://cal.example.com/me.ics', name: 'Work' });
  assert.equal(u.location, 'https://cal.example.com/me.ics');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.ics'), ICS(stamp(t0 + 3600000 * 3)));
  cal.addSource({ kind: 'file', location: path.join(dir, 'a.ics') });
  cal.addSource({ kind: 'url', location: 'https://cal.example.com/bad.ics', name: 'Broken' });
  const { events, errors } = await cal.events({ from: t0, to: t0 + 86400000 });
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'Work');
  assert.equal(events[0].url, 'https://meet.google.com/aaa-bbbb-ccc');
  assert.deepEqual(errors.map((e) => e.source), ['Broken']);
  const before = hits;
  await cal.events({ from: t0, to: t0 + 86400000 });
  assert.equal(hits, before, 'second call served from the 5-minute cache');
  assert.equal((await cal.current({ at: t0 + 480000 })).summary, 'Planning', 'starts in 2 min => current');
  assert.equal(await cal.current({ at: t0 - 3600000 * 3 }), null);
  cal.removeSource(u.id);
  assert.equal(cal.sources().length, 2);
});

test('detector: needs consecutive confirmations, ignores weak apps and our own recording, announces once per mic session', async () => {
  const { settings, bus, events } = env();
  let apps = [{ name: 'Zoom', weak: false }];
  const platform = { micActivity: async () => ({ supported: true, active: apps.length > 0, apps }) };
  const calendar = { current: async () => ({ summary: 'Planning' }), sources: () => [], events: async () => ({ events: [] }) };
  let recording = false;
  const det = new MeetingDetector({ platform, calendar, bus, settings, recording: { status: () => ({ active: recording }) } });
  await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 0, 'one tick is not enough');
  await det.tick();
  const hit = events.filter((e) => e.type === 'meeting.detected');
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].data.apps, ['Zoom']);
  assert.equal(hit[0].data.event.summary, 'Planning');
  for (let i = 0; i < 4; i++) await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 1, 'latched while the call continues');
  apps = [];
  for (let i = 0; i < 5; i++) await det.tick();
  apps = [{ name: 'Zoom', weak: false }];
  await det.tick(); await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 2, 'a new call after the mic went idle');
  // weak apps and active recording never trigger
  events.length = 0; det.latched = false; det.streak = 0;
  apps = [{ name: 'Firefox', weak: true }];
  await det.tick(); await det.tick(); await det.tick();
  recording = true; apps = [{ name: 'Zoom', weak: false }];
  await det.tick(); await det.tick(); await det.tick();
  assert.equal(events.length, 0);
});

test('detector: announces a calendar meeting about to start exactly once', async () => {
  const { settings, bus, events } = env();
  const t = 1_800_000_000_000;
  const ev = { id: 'c:1:' + (t + 30000), start: t + 30000, allDay: false, summary: 'Sync' };
  const calendar = { sources: () => [{}], events: async () => ({ events: [ev] }), current: async () => null };
  const det = new MeetingDetector({ platform: { micActivity: async () => ({ supported: false, apps: [] }) }, calendar, bus, settings, recording: { status: () => ({ active: false }) }, now: () => t });
  await det.tick(); await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.starting').length, 1);
});

// Fakes for the join-detection tests. Settings overrides cover keys (autoRecord/autoStop) owned by the settings module.
function detRig({ apps = [], windows = [], supported = true, cands = [], current = null, over = {}, notes = true } = {}) {
  const e = env();
  const settings = { get: (k) => (k in over ? over[k] : e.settings.get(k)) };
  const state = { apps, windows, supported, recordingNote: null, started: [], startOpts: [], stopped: 0, created: [] };
  const platform = { micActivity: async () => ({ supported: state.supported, active: state.apps.length > 0, apps: state.apps }), meetingWindows: async () => state.windows };
  const calendar = { sources: () => [], events: async () => ({ events: [] }), candidates: async () => cands, current: async () => current };
  const recording = {
    status: () => (state.recordingNote ? { active: true, noteId: state.recordingNote } : { active: false }),
    start: async (id, opts) => { state.started.push(id); state.startOpts.push(opts); state.recordingNote = id; },
    stop: async () => { state.stopped++; state.recordingNote = null; },
  };
  const notesApi = notes && { create: (input) => { const n = { id: `n${state.created.length + 1}`, ...input }; state.created.push(n); return n; } };
  let clock = 1_800_000_000_000;
  const det = new MeetingDetector({ platform, calendar, bus: e.bus, settings, recording, notes: notesApi, now: () => clock, confirmTicks: 2, idleTicks: 3 });
  const ticks = async (n, ms = 4000) => { for (let i = 0; i < n; i++) { clock += ms; await det.tick(); } };
  const of = (type) => e.events.filter((x) => x.type === type).map((x) => x.data);
  return { ...e, det, state, ticks, of };
}
const chrome = (weak = true) => ({ name: 'Google Chrome', appId: 'browser', weak });

test('detector: a weak browser mic user counts only with a meeting window title', async () => {
  const a = detRig({ apps: [chrome()] });
  await a.ticks(4);
  assert.equal(a.of('meeting.detected').length, 0, 'weak browser alone is not a meeting');
  a.state.windows = [{ title: 'Inbox - Gmail - Google Chrome', app: 'Google-chrome' }];
  await a.ticks(3);
  assert.equal(a.of('meeting.detected').length, 0, 'non-meeting titles do not help');
  a.state.windows = [{ title: 'Meet - abc-defg-hij - Google Chrome', app: 'Google-chrome' }];
  await a.ticks(2);
  const [d] = a.of('meeting.detected');
  assert.deepEqual(d.apps, ['Google Chrome']);
  assert.equal(d.platform, 'meet');
  assert.equal(d.title, 'Meet - abc-defg-hij - Google Chrome');
  assert.equal(d.event, null);
  assert.equal(typeof d.at, 'number');
  assert.deepEqual(a.det.status(), { active: true, apps: ['Google Chrome'], platform: 'meet', title: d.title, since: d.at, autoNoteId: null });
  // no mic data at all: a meeting window alone is never enough
  const b = detRig({ supported: false, windows: [{ title: 'Zoom Meeting', app: 'zoom' }] });
  await b.ticks(5);
  assert.equal(b.of('meeting.detected').length, 0);
  assert.equal(b.det.status().active, false);
});

test('detector: the calendar event on the detected platform wins over the closest one', async () => {
  const t = 1_800_000_000_000;
  const near = { uid: 'near', summary: 'Interview', start: t, url: 'https://meet.google.com/aaa-bbbb-ccc' };
  const zoom = { uid: 'z', summary: 'Customer call', start: t - 600000, url: 'https://acme.zoom.us/j/1' };
  const a = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }], cands: [near, zoom] });
  await a.ticks(2);
  assert.equal(a.of('meeting.detected')[0].event.uid, 'z');
  assert.equal(a.of('meeting.detected')[0].platform, 'zoom');
  const b = detRig({ apps: [{ name: 'Slack', appId: 'slack', weak: false }], cands: [near, zoom] });
  await b.ticks(2);
  assert.equal(b.of('meeting.detected')[0].event.uid, 'near', 'no platform match => closest in time');
});

test('detector: meeting.ended once the call apps release the mic for idleTicks', async () => {
  const a = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }], windows: [{ title: 'Zoom Meeting', app: 'zoom' }] });
  await a.ticks(2);
  assert.equal(a.of('meeting.detected')[0].title, 'Zoom Meeting');
  const since = a.det.status().since;
  await a.ticks(3);
  a.state.apps = [];
  await a.ticks(2);
  assert.equal(a.of('meeting.ended').length, 0, 'not before idleTicks');
  await a.ticks(1);
  const ended = a.of('meeting.ended');
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0].apps, ['Zoom']);
  assert.equal(ended[0].durationMs, 3 * 4000, 'until the mic was last seen in use');
  assert.ok(ended[0].at > since);
  assert.equal(a.det.status().active, false);
  await a.ticks(5);
  assert.equal(a.of('meeting.ended').length, 1, 'only once');
});

test('detector: autoRecord always starts a note+recording and autoStop stops only its own recording', async () => {
  const ev = { uid: 'e9', summary: 'Weekly sync', start: 1_800_000_000_000, attendees: [{ name: 'Ana', email: 'a@x' }], url: 'https://teams.microsoft.com/l/meetup-join/1' };
  const a = detRig({ apps: [{ name: 'Microsoft Teams', appId: 'teams', weak: false }], cands: [ev], over: { autoRecord: 'always' } });
  await a.ticks(2);
  assert.equal(a.state.created.length, 1);
  assert.deepEqual(a.state.created[0], { id: 'n1', title: 'Weekly sync', eventUid: 'e9', eventStart: ev.start, attendees: ev.attendees, source: 'recorded', platform: 'teams' });
  assert.deepEqual(a.state.started, ['n1']);
  assert.deepEqual(a.state.startOpts, [{ app: { name: 'Microsoft Teams', appId: 'teams', weak: false } }], 'the recording is told which application the call is');
  assert.deepEqual(a.of('meeting.autostarted'), [{ noteId: 'n1', platform: 'teams' }]);
  assert.equal(a.of('meeting.detected').length, 1);
  assert.equal(a.det.status().autoNoteId, 'n1');
  a.state.apps = [];
  await a.ticks(3);
  assert.equal(a.state.stopped, 1, 'auto-started recording stopped when the meeting ends');

  // the user swapped to their own recording meanwhile: leave it alone
  const b = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }], over: { autoRecord: 'always' } });
  await b.ticks(2);
  assert.equal(b.state.created[0].title, 'Zoom meeting');
  b.state.recordingNote = 'mine';
  b.state.apps = [];
  await b.ticks(3);
  assert.equal(b.state.stopped, 0);
  assert.equal(b.of('meeting.ended').length, 1);

  // autoStop false keeps recording; an already-running recording blocks detection and auto-start
  const c = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }], over: { autoRecord: 'always', autoStop: false } });
  await c.ticks(2); c.state.apps = []; await c.ticks(3);
  assert.equal(c.state.stopped, 0);
  const d = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }], over: { autoRecord: 'always' } });
  d.state.recordingNote = 'busy';
  await d.ticks(3);
  assert.equal(d.state.created.length, 0);
  // 'ask' (the default) only announces
  const e = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }] });
  await e.ticks(2);
  assert.equal(e.of('meeting.detected').length, 1);
  assert.equal(e.state.created.length, 0);
});

test('detector: autoRecord off publishes nothing', async () => {
  const a = detRig({ apps: [{ name: 'Zoom', appId: 'zoom', weak: false }], over: { autoRecord: 'off' } });
  await a.ticks(3);
  a.state.apps = [];
  await a.ticks(4);
  assert.deepEqual(a.events.filter((x) => x.type.startsWith('meeting.')), []);
  assert.equal(a.state.created.length, 0);
});

class FakeEngine extends EventEmitter {
  constructor(text = 'hello world') { super(); this.text = text; this.got = null; }
  async start() {}
  async transcribe(pcm) { this.got = pcm.length; return this.text; }
}

function dictationRig({ capture = { mic: 'renderer' }, text } = {}) {
  const e = env();
  const pasted = [];
  const platform = { capture, createMicSource: () => new PushSource(), paste: async (t) => { pasted.push(t); return { ok: true, method: 'fake' }; }, clipboard: { write: async (t) => { pasted.push('clip:' + t); } } };
  const models = { resolve: () => ({ id: 'm' }), vadPath: () => '/v' };
  let clock = 1000;
  const d = new Dictation({ platform, engine: new FakeEngine(text), models, settings: e.settings, bus: e.bus, now: () => clock });
  return { ...e, d, pasted, advance: (ms) => { clock += ms; } };
}

test('dictation: listen -> transcribe -> paste, emitting state events', async () => {
  const { d, pasted, events, advance } = dictationRig({ text: '  hello   world ' });
  await d.toggle();
  assert.equal(d.state, 'listening');
  assert.ok(events.some((x) => x.type === 'capture.request' && x.data.dictation));
  d.pushPcm(Buffer.alloc(16000 * 2));
  advance(1000);
  const r = await d.toggle();
  assert.equal(r.text, 'hello world');
  assert.deepEqual(pasted, ['hello world']);
  assert.equal(d.state, 'idle');
  assert.deepEqual(events.filter((x) => x.type === 'dictation.state').map((x) => x.data.state), ['listening', 'transcribing', 'idle']);
});

test('dictation: autoPaste off copies to the clipboard; too-short takes are skipped; errors reset state', async () => {
  const a = dictationRig();
  a.settings.update({ dictation: { autoPaste: false } });
  await a.d.toggle(); a.d.pushPcm(Buffer.alloc(32000)); a.advance(900); await a.d.toggle();
  assert.deepEqual(a.pasted, ['clip:hello world']);
  const b = dictationRig();
  await b.d.toggle(); b.advance(100);
  assert.equal((await b.d.toggle()).skipped, 'too short');
  assert.equal(b.d.state, 'idle');
  const c = dictationRig();
  c.d.engine.transcribe = async () => { throw new Error('boom'); };
  await c.d.toggle(); c.d.pushPcm(Buffer.alloc(32000)); c.advance(900);
  await assert.rejects(c.d.toggle(), /boom/);
  assert.equal(c.d.state, 'idle');
  assert.equal(tidy(' a\n b  '), 'a b');
});

test('detector: a call the meeting window shows is a meeting where the microphone cannot be watched (macOS), and it ends when the call does', async () => {
  const { SignalHub } = require('../src/meet/hub');
  const { settings, bus, events } = env();
  const hub = new SignalHub();
  const calendar = { current: async () => null, sources: () => [], events: async () => ({ events: [] }) };
  // macOS-like: the microphone use is not known and no window title is listed
  const platform = { micActivity: async () => ({ supported: false, active: false, apps: [] }), meetingWindows: async () => [] };
  const det = new MeetingDetector({ platform, calendar, bus, settings, recording: { status: () => ({ active: false }) }, signals: hub, idleTicks: 3 });
  await det.tick(); await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 0, 'nothing is seen: nothing is detected');
  hub.ingest({ type: 'meeting', inCall: true, code: 'abc-defg-hij', title: 'Weekly sync' }, { source: 'extension', kind: 'extension' });
  await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 0, 'one tick is not enough');
  await det.tick();
  const hit = events.filter((e) => e.type === 'meeting.detected');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].data.platform, 'meet');
  assert.equal(hit[0].data.title, 'Weekly sync');
  for (let i = 0; i < 3; i++) await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 1, 'announced once for the call');
  hub.ingest({ type: 'meeting', inCall: false, code: '' }, { source: 'extension', kind: 'extension' });
  for (let i = 0; i < 3; i++) await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.ended').length, 1, 'the call is over: so is the meeting');
});

test('detector: with no signals source nothing changes, and a stale call is not a meeting', async () => {
  const { SignalHub } = require('../src/meet/hub');
  let t = 1_000_000;
  const hub = new SignalHub({ now: () => t });
  const { settings, bus, events } = env();
  const calendar = { current: async () => null, sources: () => [], events: async () => ({ events: [] }) };
  const platform = { micActivity: async () => ({ supported: false, active: false, apps: [] }), meetingWindows: async () => [] };
  hub.ingest({ type: 'meeting', inCall: true }, { source: 'extension', kind: 'extension' });
  t += 120000; // two minutes with no word from the extension (the browser was closed)
  const det = new MeetingDetector({ platform, calendar, bus, settings, recording: { status: () => ({ active: false }) }, signals: hub });
  await det.tick(); await det.tick(); await det.tick();
  assert.equal(events.filter((e) => e.type === 'meeting.detected').length, 0);
  const none = new MeetingDetector({ platform, calendar, bus, settings, recording: { status: () => ({ active: false }) } });
  await none.tick(); await none.tick();
  assert.equal(events.length, 0);
});
