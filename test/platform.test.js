'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture } = require('./helpers');
const linux = require('../src/platform/linux');
const darwin = require('../src/platform/darwin');
const win32 = require('../src/platform/win32');
const { createPlatform } = require('../src/platform');
const { classify, classifyWindowTitle, platformFromUrl } = require('../src/platform/apps');

test('linux: pw-dump parsing finds defaults, devices and input streams', () => {
  const d = linux.parsePwDump(fs.readFileSync(fixture('pw-dump.json'), 'utf8'));
  assert.equal(d.defaultSink, 'alsa_output.pci.analog-stereo');
  assert.equal(d.defaultSource, 'alsa_input.usb-mic.analog-stereo');
  assert.equal(d.sources.length, 2);
  assert.equal(d.sinks[0].name, 'Speakers');
  assert.equal(d.inputStreams.length, 5);
});

test('linux: mic users = running input streams, minus monitors and ourselves', () => {
  const d = linux.parsePwDump(fs.readFileSync(fixture('pw-dump.json'), 'utf8'));
  const apps = linux.micUsers(d, { selfPids: [31337] });
  assert.deepEqual(apps.map((a) => a.appId).sort(), ['browser', 'zoom']);
  assert.equal(apps.find((a) => a.appId === 'zoom').weak, false);
  assert.equal(apps.find((a) => a.appId === 'browser').weak, false, 'a Meet tab title is a confident match');
});

test('linux: session detection and a system source targets the default sink monitor', async () => {
  assert.equal(linux.sessionKind({ XDG_SESSION_TYPE: 'wayland' }), 'wayland');
  assert.equal(linux.sessionKind({ DISPLAY: ':0' }), 'x11');
  assert.equal(linux.sessionKind({}), 'none');
  const p = linux.create({ env: {} });
  const src = p.createMicSource({ device: 'alsa_input.x' });
  assert.deepEqual(src.args.slice(-3), ['--target', 'alsa_input.x', '-']);
  assert.equal(src.cmd, 'pw-record');
});

test('windows: consent store parser flags apps whose mic session has no stop time', () => {
  const sample = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
    '    Value    REG_SZ    Allow', '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe',
    '    Value    REG_SZ    Allow', '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f', '    LastUsedTimeStop    REG_QWORD    0x0', '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Windows#System32#sndrec.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f', '    LastUsedTimeStop    REG_QWORD    0x1dc5a1b2c9999999', '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f', '    LastUsedTimeStop    REG_QWORD    0x0', '',
  ].join('\r\n');
  const entries = win32.parseConsentStore(sample);
  assert.deepEqual(entries.map((e) => e.exe), ['Zoom.exe', 'MSTeams_8wekyb3d8bbwe']);
  const apps = win32.micUsers(entries);
  assert.deepEqual(apps.map((a) => a.appId), ['zoom', 'teams']);
});

test('macOS: pmset assertions parse and call apps are recognised', () => {
  const sample = [
    'Assertion status system-wide:',
    '   PreventUserIdleDisplaySleep    1',
    'Listed by owning process:',
    '   pid 612(zoom.us): [0x0000a1b2000188ad] 00:12:44 PreventUserIdleDisplaySleep named: "Zoom Meeting" ',
    '   pid 77(caffeinate): [0x0000a1b2000188ae] 00:01:00 PreventUserIdleSystemSleep named: "caffeinate command-line tool" ',
    '   pid 901(Google Chrome): [0x0000a1b2000188af] 00:03:00 PreventUserIdleDisplaySleep named: "Video Wake Lock" ',
    '   pid 902(Google Chrome): [0x0000a1b2000188b0] 00:03:00 PreventUserIdleDisplaySleep named: "WebRTC call in progress" ',
  ].join('\n');
  const parsed = darwin.parsePmsetAssertions(sample);
  assert.equal(parsed.length, 4);
  const apps = darwin.micUsersFromAssertions(parsed);
  assert.deepEqual(apps.map((a) => a.appId).sort(), ['browser', 'zoom']);
});

test('app classifier ignores recorders and speech daemons', () => {
  assert.equal(classify({ name: 'pw-record' }), null);
  assert.equal(classify({ name: 'speech-dispatcher-dummy', binary: 'sd_dummy' }), null);
  assert.equal(classify({ name: 'Microsoft Teams' }).id, 'teams');
  assert.equal(classify({ name: 'Firefox', title: 'random page' }).weak, true);
});

test('createPlatform picks an adapter per OS and macOS/Windows capture in the renderer', async () => {
  assert.equal(createPlatform({ platform: 'darwin' }).capture.system, 'renderer');
  assert.equal(createPlatform({ platform: 'win32' }).capture.mic, 'renderer');
  assert.equal(createPlatform({ platform: 'linux' }).capture.system, 'native');
  assert.throws(() => createPlatform({ platform: 'plan9' }), /unsupported/);
  assert.equal(await createPlatform({ platform: 'darwin' }).createSystemSource(), null);
});

test('macOS/Windows paste degrades gracefully without a clipboard', async () => {
  assert.equal((await createPlatform({ platform: 'darwin' }).paste('x')).ok, false);
  assert.equal((await createPlatform({ platform: 'win32' }).paste('x')).ok, false);
});

test('window titles: real meeting windows are recognised, landing/home pages are not', () => {
  const yes = {
    'Meet - abc-defg-hij - Google Chrome': 'meet', 'Meet – Weekly sync — Mozilla Firefox': 'meet', '(2) Meet - abc-defg-hij - Personal - Microsoft Edge': 'meet',
    'Meet - Weekly sync and 2 more pages - Work - Microsoft Edge': 'meet', 'Zoom Meeting': 'zoom', 'Zoom Webinar': 'zoom', 'Zoom Meeting 40-Minutes': 'zoom',
    'Meeting with Ana | Microsoft Teams': 'teams', 'Weekly sync meeting | Microsoft Teams': 'teams', 'Call with Rui | Microsoft Teams': 'teams',
    'Huddle with Ana - Slack': 'slack', 'Slack | Huddle: #eng | Acme': 'slack', 'Standup | Jitsi Meet': 'jitsi', 'team-room | Whereby': 'whereby',
    "Ana's Personal Room - Webex": 'webex', 'Webex Meeting': 'webex',
  };
  for (const [t, id] of Object.entries(yes)) assert.equal(classifyWindowTitle(t)?.id, id, t);
  assert.deepEqual(classifyWindowTitle('Zoom Meeting'), { id: 'zoom', name: 'Zoom' });
  const no = ['Google Meet', 'Google Meet - Google Chrome', 'Meet - Google Chrome', 'Zoom Workplace', 'Zoom Cloud Meetings', 'Zoom', 'Chat | Ana | Microsoft Teams',
    'Calendar | Microsoft Teams', 'Calls | Microsoft Teams', 'Microsoft Teams', 'Slack | general | Acme', 'Jitsi Meet', 'Jitsi Meet - Google Chrome', 'Whereby',
    'Whereby – Video meetings made easy', 'Webex', 'Cisco Webex Meetings', 'How to call a function - Stack Overflow - Google Chrome', '', null];
  for (const t of no) assert.equal(classifyWindowTitle(t), null, String(t));
});

test('meeting platform from a join link', () => {
  assert.equal(platformFromUrl('https://meet.google.com/abc-defg-hij'), 'meet');
  assert.equal(platformFromUrl('https://acme.zoom.us/j/1'), 'zoom');
  assert.equal(platformFromUrl('https://teams.microsoft.com/l/meetup-join/x'), 'teams');
  assert.equal(platformFromUrl('https://example.com'), null);
  assert.equal(platformFromUrl(null), null);
});

test('linux: window title parsers (wmctrl -lx, xprop) keep only meeting windows', async () => {
  const wm = [
    '0x03a00007  0 google-chrome.Google-chrome  box Meet - abc-defg-hij - Google Chrome',
    '0x01200003 -1 xfce4-panel.Xfce4-panel  box ',
    '0x04400004  1 zoom.zoom             N/A Zoom Meeting',
    '0x05000001  0 code.Code  box notes.md - whisperbrain - Visual Studio Code',
  ].join('\n');
  const parsed = linux.parseWmctrl(wm);
  assert.deepEqual(parsed.map((w) => [w.title, w.app]), [['Meet - abc-defg-hij - Google Chrome', 'Google-chrome'], ['Zoom Meeting', 'zoom'], ['notes.md - whisperbrain - Visual Studio Code', 'Code']]);
  assert.deepEqual(linux.meetingWindowsFrom(parsed).map((w) => w.platform), ['meet', 'zoom']);
  assert.deepEqual(linux.parseClientList('_NET_CLIENT_LIST(WINDOW): window id # 0x1e00003, 0x2200007, 0x3a00007'), ['0x1e00003', '0x2200007', '0x3a00007']);
  assert.deepEqual(linux.parseClientList(''), []);
  assert.deepEqual(linux.parseXpropWindow('_NET_WM_NAME(UTF8_STRING) = "Weekly \\"sync\\" meeting | Microsoft Teams"\nWM_CLASS(STRING) = "teams-for-linux", "teams-for-linux"'),
    { title: 'Weekly "sync" meeting | Microsoft Teams', app: 'teams-for-linux' });
  assert.deepEqual(linux.parseXpropWindow('_NET_WM_NAME:  not found.\nWM_CLASS:  not found.'), { title: '', app: '' });
  for (const env of [{}, { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }]) assert.deepEqual(await linux.create({ env }).meetingWindows(), []);
  assert.deepEqual(await darwin.create().meetingWindows(), []);
});

test('windows: tasklist CSV window titles', () => {
  const csv = [
    '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"',
    '"chrome.exe","1234","Console","1","200,000 K","Running","PC\\me","0:01:00","Meet - abc-defg-hij - Google Chrome"',
    '"Zoom.exe","22","Console","1","90,000 K","Running","PC\\me","0:00:10","Zoom Meeting"',
    '"svchost.exe","4","Services","0","1,000 K","Unknown","N/A","0:00:00","N/A"',
    '"notepad.exe","9","Console","1","5,000 K","Running","PC\\me","0:00:00","say ""hi"", ok - Notepad"',
  ].join('\r\n');
  const rows = win32.parseTasklistCsv(csv);
  assert.deepEqual(rows, [{ app: 'chrome', title: 'Meet - abc-defg-hij - Google Chrome' }, { app: 'Zoom', title: 'Zoom Meeting' }, { app: 'notepad', title: 'say "hi", ok - Notepad' }]);
  assert.deepEqual(win32.meetingWindowsFrom(rows).map((w) => w.platform), ['meet', 'zoom']);
});

test('macOS: the accessibility helper\'s window list tells which browser windows are a call', () => {
  const { meetingWindowsFromHelper, create } = require('../src/platform/darwin');
  const out = [
    '{"event":"hello","helper":"ax","version":1}',
    '{"event":"permission","trusted":true}',
    JSON.stringify({ event: 'windows', windows: [{ app: 'Google Chrome', title: 'Meet - abc-defg-hij - Google Chrome', pid: 11 }, { app: 'Google Chrome', title: 'Inbox - Gmail - Google Chrome', pid: 11 }, { app: 'Brave Browser', title: 'Weekly sync - Zoom', pid: 12 }] }),
  ].join('\n');
  const w = meetingWindowsFromHelper(out);
  assert.ok(w.length >= 1 && w.every((x) => x.platform && x.title && x.app), 'only the calls are kept');
  assert.ok(!w.some((x) => /Gmail/.test(x.title)));
  assert.deepEqual(meetingWindowsFromHelper(''), []);
  assert.deepEqual(meetingWindowsFromHelper('not json\n{"event":"permission","trusted":false}\n{"event":"windows","windows":[]}'), [], 'no permission: an empty list');
  // without the helper nothing is claimed
  return create({}).meetingWindows().then((r) => assert.deepEqual(r, []));
});

// ---- per-app capture (Linux): which playback stream belongs to the meeting app ----
const PW = () => linux.parsePwDump(fs.readFileSync(fixture('pw-dump.json'), 'utf8'));

test('linux: pw-dump lists playback streams with the ids pw-record can target', () => {
  const d = PW();
  const zoom = d.outputStreams.find((s) => s.pid === 4242);
  assert.deepEqual({ serial: zoom.serial, nodeName: zoom.nodeName, running: zoom.running, binary: zoom.binary }, { serial: 701, nodeName: 'zoom-playback', running: true, binary: 'zoom' });
  assert.equal(d.outputStreams.length, 6, 'mpv (no ids) and every Stream/Output/Audio node');
  assert.equal(d.outputStreams.find((s) => s.name === 'mpv').serial, null);
  assert.equal(d.outputStreams.find((s) => s.serial === 704).running, false);
});

test('linux: pickOutputStream finds the meeting app\'s stream by pid, then binary, then what the stream is called', () => {
  const d = PW();
  const pick = (app, opts) => linux.pickOutputStream(d, app, opts);
  assert.equal(pick({ pid: 4242, appId: 'zoom' }).stream.serial, 701, 'same process');
  // Chrome: the microphone is held by pid 5000 but the audio plays from its audio service (pid 5002); the stream titled as
  // the call wins over the YouTube tab
  assert.equal(pick({ pid: 5000, binary: 'chrome', appId: 'browser' }).stream.serial, 702);
  assert.equal(pick({ appId: 'zoom', name: 'Zoom' }).stream.serial, 701, 'no pid: the app itself');
  assert.equal(pick({ appId: 'other', name: 'ZOOM' }).stream.serial, 701, 'a native PipeWire client has no pid on its stream: the name does');
});

test('linux: pickOutputStream says why it did not pick, and never picks the wrong thing', () => {
  const d = PW();
  const none = (app, opts) => { const r = linux.pickOutputStream(d, app, opts); assert.equal(r.stream, null); return r.reason; };
  assert.match(none(null), /no application/i);
  assert.match(none({ pid: 4300, appId: 'slack' }), /not playing/i, 'an idle stream is not the call');
  assert.match(none({ pid: 1, appId: 'teams' }), /no playback stream/i);
  assert.match(none({ pid: 999, appId: 'other' }, { selfPids: [999] }), /no playback stream/i, 'never our own capture or playback');
  // two Chrome streams and nothing says which one is the call: stay with the whole output rather than guess
  const two = { ...d, outputStreams: d.outputStreams.filter((s) => s.serial !== 702) .concat([{ ...d.outputStreams.find((s) => s.serial === 703), serial: 799, title: 'Another tab' }]) };
  const r = linux.pickOutputStream(two, { pid: 5000, binary: 'chrome', appId: 'browser' });
  assert.equal(r.stream, null);
  assert.match(r.reason, /several/i);
  // one Chrome stream is the call, whatever it is called
  const one = { ...d, outputStreams: d.outputStreams.filter((s) => s.serial !== 702) };
  assert.equal(linux.pickOutputStream(one, { pid: 5000, binary: 'chrome', appId: 'browser' }).stream.serial, 703);
});

const { EventEmitter } = require('node:events');
// A stand-in for pw-record: remembers how it was started and lets a test play audio / end it.
function fakeRecorder() {
  const made = [];
  const record = (args, label) => {
    const src = Object.assign(new EventEmitter(), { args, label, started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; this.emit('end'); } });
    made.push(src);
    return src;
  };
  return { record, made };
}
const dumpOf = (d) => async () => d;

test('linux: a known meeting app is captured on its own, by the id of its playback stream', async () => {
  const { record, made } = fakeRecorder();
  const p = linux.create({ env: {}, pwDump: dumpOf(PW()), record });
  const src = await p.createSystemSource({ app: { pid: 4242, appId: 'zoom' } });
  assert.deepEqual(made[0].args.slice(-3), ['--target', '701', '-']);
  assert.ok(!made[0].args.includes('stream.capture.sink=true'), 'this is the stream, not the output device');
  assert.deepEqual([src.capture.mode, src.capture.app], ['app', 'zoom']);
});

test('linux: without an app, or when none can be found, the whole output is captured as before and it says why', async () => {
  for (const [label, deps, app, reason] of [
    ['no app', {}, undefined, /whole output/i],
    ['no stream', {}, { pid: 1, appId: 'teams' }, /no playback stream/i],
    ['PipeWire cannot be asked', { pwDump: async () => null }, { pid: 4242, appId: 'zoom' }, /pipewire/i],
  ]) {
    const { record, made } = fakeRecorder();
    const p = linux.create({ env: {}, pwDump: deps.pwDump || dumpOf(PW()), record });
    // (no app and a dump that has no default sink would throw: give the default one a name)
    const src = await p.createSystemSource({ app, sink: 'alsa_output.pci.analog-stereo' });
    assert.deepEqual(made[0].args.slice(-5), ['-P', 'stream.capture.sink=true', '--target', 'alsa_output.pci.analog-stereo', '-'], label);
    assert.equal(src.capture.mode, 'output', label);
    assert.match(src.capture.reason, reason, label);
  }
});

test('linux: if the app\'s stream goes away mid-call the capture carries on with the whole output instead of going silent', async () => {
  const { record, made } = fakeRecorder();
  const p = linux.create({ env: {}, pwDump: dumpOf(PW()), record });
  const src = await p.createSystemSource({ app: { pid: 4242, appId: 'zoom' }, sink: 'alsa_output.pci.analog-stereo' });
  const heard = [], events = [];
  src.on('pcm', (b) => heard.push(b.toString()));
  src.on('capture', (c) => events.push(c.mode));
  src.start();
  made[0].emit('pcm', Buffer.from('app'));
  made[0].emit('end');                                    // the stream is gone
  assert.equal(made.length, 2, 'the output capture was started');
  assert.ok(made[1].started);
  made[1].emit('pcm', Buffer.from('all'));
  assert.deepEqual(heard, ['app', 'all']);
  assert.deepEqual(events, ['output']);
  assert.equal(src.capture.mode, 'output');
  src.stop();
  assert.ok(made[1].stopped);
});

test('linux: stopping a per-app capture on purpose does not start the fallback', async () => {
  const { record, made } = fakeRecorder();
  const p = linux.create({ env: {}, pwDump: dumpOf(PW()), record });
  const src = await p.createSystemSource({ app: { pid: 4242, appId: 'zoom' }, sink: 'x' });
  let ended = 0; src.on('end', () => { ended++; });
  src.start(); src.stop();
  assert.equal(made.length, 1);
  assert.equal(ended, 1);
});

test('linux: pickOutputStream never settles for another stream when the call\'s own is only quiet', () => {
  const d = PW();
  const withState = (serial, running) => ({ ...d, outputStreams: d.outputStreams.map((s) => (s.serial === serial ? { ...s, running } : s)) });
  // the Meet tab is quiet (nobody is talking), a YouTube tab of the same browser is playing: not the YouTube tab
  const quietCall = linux.pickOutputStream(withState(702, false), { pid: 5000, binary: 'chrome', appId: 'browser' });
  assert.equal(quietCall.stream, null);
  assert.match(quietCall.reason, /not playing/i);
  // the app's own process is quiet, a second process of the same program is playing a notification sound
  const sibling = { ...d, outputStreams: [...withState(701, false).outputStreams, { serial: 11, nodeName: 'n', running: true, name: 'zoom', binary: 'zoom', pid: 4243, title: 'Notification' }] };
  const r = linux.pickOutputStream(sibling, { pid: 4242, binary: 'zoom', appId: 'zoom' });
  assert.equal(r.stream, null);
  assert.match(r.reason, /not playing/i);
});

test('linux: if the whole output cannot be captured as the fallback either, the source ends with an error instead of crashing', async () => {
  const { record, made } = fakeRecorder();
  const noSink = { ...PW(), defaultSink: null };
  const p = linux.create({ env: {}, pwDump: dumpOf(noSink), record });
  const src = await p.createSystemSource({ app: { pid: 4242, appId: 'zoom' } });
  const errors = [], ended = [];
  src.on('error', (e) => errors.push(e.message));
  src.on('end', () => ended.push(1));
  src.start();
  made[0].emit('end');                                   // the stream is gone and there is no output to fall back to
  assert.equal(errors.length, 1);
  assert.match(errors[0], /output/i);
  assert.equal(ended.length, 1);
});

// ---- a call you only listen to: the microphone is muted or unused, but the app is playing the other people ----
test('linux: a meeting app playing audio counts as a call even when it holds no microphone (Zoom with the mic muted, in a Flatpak)', () => {
  const only = (streams) => ({ defaultSink: 'x', defaultSource: 'y', sources: [], sinks: [], inputStreams: [], outputStreams: streams });
  const out = (o) => ({ serial: 1, nodeName: '', running: true, name: '', binary: '', pid: null, title: '', ...o });
  // the real thing: a Flatpak shows its own pid namespace (4), and Zoom's playback stream is called "ZOOM VoiceEngine"
  const zoom = linux.callUsers(only([out({ name: 'ZOOM VoiceEngine', binary: 'zoom', pid: 4, title: 'playStream' })]), { selfPids: [] });
  assert.deepEqual(zoom.map((a) => [a.appId, a.weak, a.via]), [['zoom', false, 'playback']]);
  assert.deepEqual(linux.callUsers(only([out({ name: 'ZOOM VoiceEngine', binary: 'zoom', running: false })]), { selfPids: [] }), [], 'not playing: not a call');
  assert.deepEqual(linux.callUsers(only([out({ name: 'Spotify', title: 'Spotify' }), out({ name: 'mpv' })]), { selfPids: [] }), [], 'music and video are not calls');
  assert.deepEqual(linux.callUsers(only([out({ name: 'Google Chrome', binary: 'chrome', title: 'Lo-fi beats - YouTube' })]), { selfPids: [] }), [], 'a browser playing is not a call without a title that says so');
  // chat apps make sounds without a call: a weak sign, so nothing starts recording by itself because of it
  assert.equal(linux.callUsers(only([out({ name: 'Discord', binary: 'discord' })]), { selfPids: [] })[0].weak, true);
  // ourselves are never the call
  assert.deepEqual(linux.callUsers(only([out({ name: 'zoom', binary: 'zoom', pid: 77 })]), { selfPids: [77] }), []);
});

test('linux: microphone users and playing apps are one list, each application once', () => {
  const apps = linux.callUsers(PW(), { selfPids: [31337] });
  assert.deepEqual(apps.map((a) => a.appId).sort(), ['browser', 'zoom']);
  assert.equal(apps.find((a) => a.appId === 'zoom').via, undefined, 'Zoom holds the microphone here: that is the stronger evidence');
});

test('linux: micActivity reports a muted Zoom call', async () => {
  const dump = { defaultSink: 'x', defaultSource: 'y', sources: [], sinks: [], inputStreams: [], outputStreams: [{ serial: 9, nodeName: '', running: true, name: 'ZOOM VoiceEngine', binary: 'zoom', pid: 4, title: 'playStream' }] };
  const p = linux.create({ env: {}, pwDump: async () => dump });
  const r = await p.micActivity();
  assert.deepEqual([r.supported, r.active, r.apps.map((a) => a.appId)], [true, true, ['zoom']]);
});

test('audio: a source that follows one application can be widened to the whole output, once, and never after stop', async () => {
  const { EventEmitter } = require('node:events');
  const { FallbackSource } = require('../src/audio/source');
  const fake = (name) => Object.assign(new EventEmitter(), { name, started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; setImmediate(() => this.emit('end')); } });
  const make = () => {
    const primary = fake('app'), fallback = fake('output');
    const src = new FallbackSource({ primary, makeFallback: () => fallback, capture: { mode: 'app' }, fallbackCapture: { mode: 'output', reason: 'x' } });
    const seen = []; src.on('capture', (c) => seen.push(c));
    return { src, primary, fallback, seen };
  };
  const a = make();
  a.src.start();
  assert.equal(a.src.widen('two calls'), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.primary.stopped, 1);
  assert.equal(a.fallback.started, 1);
  assert.deepEqual(a.seen, [{ mode: 'output', reason: 'two calls' }]);
  assert.equal(a.src.widen('again'), false, 'already on the whole output');
  const b = make();
  assert.equal(b.src.widen('before start'), false);
  b.src.start(); b.src.stop();
  assert.equal(b.src.widen('after stop'), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.fallback.started, 0, 'stopping on purpose never starts the fallback');
});

test('linux: streamsOfApps gives the playing streams of the chosen applications only, several apps at once', () => {
  const d = PW();
  const keys = (apps) => linux.streamsOfApps(d, apps, { selfPids: [] }).map((s) => s.serial).sort();
  assert.deepEqual(keys([{ pid: 4242, appId: 'zoom', name: 'Zoom' }]), [701], 'one application');
  assert.deepEqual(keys([{ pid: 4242, appId: 'zoom', name: 'Zoom' }, { pid: 5000, binary: 'chrome', appId: 'browser', name: 'Chrome' }]), [701, 702], 'Zoom and the call in Chrome, not the YouTube tab');
  assert.deepEqual(keys([{ pid: 5000, binary: 'chrome', appId: 'browser', name: 'Chrome' }]), [702], 'a browser: only the stream marked as the call');
  assert.deepEqual(keys([{ appId: 'discord', name: 'Discord', binary: 'Discord' }]), [], 'nothing playing for it now: nothing, not "everything"');
  const quiet = { ...d, outputStreams: d.outputStreams.map((s) => (s.serial === 701 ? { ...s, running: false } : s)) };
  assert.deepEqual(linux.streamsOfApps(quiet, [{ pid: 4242, appId: 'zoom', name: 'Zoom' }], { selfPids: [] }), [], 'a stream that is not playing is not followed yet');
  // a program with two streams (call + notification sound) gives both
  const two = { ...d, outputStreams: [...d.outputStreams, { serial: 990, name: 'discord', binary: 'Discord', pid: 61, running: true, title: 'Playback' }, { serial: 991, name: 'discord', binary: 'Discord', pid: 61, running: true, title: 'Playback' }] };
  assert.deepEqual(linux.streamsOfApps(two, [{ appId: 'discord', name: 'Discord', binary: 'Discord', pid: 61 }], { selfPids: [] }).map((s) => s.serial).sort(), [990, 991]);
});

test('audio: AppStreamsSource follows streams as they come and go, mixes them on the clock and fills the gaps with silence', async () => {
  const { EventEmitter } = require('node:events');
  const { AppStreamsSource } = require('../src/audio/app-streams');
  const tone = (n, v) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(v, i * 2); return b; };
  let clock = 0;
  const live = new Map();       // key -> fake source
  const opened = [];
  const fake = (key) => Object.assign(new EventEmitter(), { key, started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; this.emit('end'); } });
  let listed = [];
  const src = new AppStreamsSource({
    list: async () => listed, now: () => clock, pollMs: 1e9, frameMs: 1e9,   // driven by hand below
    open: (s) => { const f = fake(s.key); live.set(s.key, f); opened.push(s.key); return f; },
    capture: { mode: 'apps', app: 'A + B', reason: '' },
  });
  const out = [];
  src.on('pcm', (b) => out.push(b));
  const total = () => Buffer.concat(out);
  const samples = () => { const b = total(); return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2)); };
  src.start();                                    // the timers are huge: refresh() once, flush() by hand
  await new Promise((r) => setImmediate(r));
  clock += 100; src.flush();                      // 100 ms with no stream: 1600 samples of silence
  assert.equal(total().length, 3200);
  assert.ok(samples().every((v) => v === 0));
  listed = [{ key: 1, name: 'Zoom' }];
  await src.refresh();
  assert.deepEqual(opened, [1]);
  live.get(1).emit('pcm', tone(1600, 1000));
  clock += 100; src.flush();
  assert.equal(samples().slice(1600, 3200).every((v) => v === 1000), true, 'one stream passes through');
  listed = [{ key: 1, name: 'Zoom' }, { key: 2, name: 'Discord' }];
  await src.refresh();
  assert.deepEqual(opened, [1, 2], 'a stream already followed is not opened again');
  live.get(1).emit('pcm', tone(1600, 1000)); live.get(2).emit('pcm', tone(1600, 500));
  clock += 100; src.flush();
  assert.equal(samples().slice(3200, 4800).every((v) => v === 1500), true, 'two streams are summed');
  live.get(1).emit('pcm', tone(1600, 30000)); live.get(2).emit('pcm', tone(1600, 30000));
  clock += 100; src.flush();
  assert.equal(samples().slice(4800, 6400).every((v) => v === 32767), true, 'and never wrap around');
  // a stream ends: its last audio is still sent, then it is forgotten; the clock keeps the channel going
  live.get(2).emit('pcm', tone(800, 500)); live.get(2).emit('end');
  clock += 100; src.flush();
  assert.equal(samples()[6400], 500);
  assert.equal(samples()[6400 + 900], 0, 'half a frame of it, then silence from the other, which sent nothing');
  clock += 1000; src.flush();
  assert.equal(total().length / 2, 16000 * 1.5, 'the channel runs at the clock: 16 000 samples per second, no more, no less');
  // late catch-up after a stall still delivers what is due
  clock += 250; src.flush();
  assert.equal(total().length / 2, 16000 * (clock / 1000));
  src.stop();
  assert.equal(live.get(1).stopped, 1, 'stopping stops what is followed');
  clock += 100; src.flush();
  assert.equal(total().length / 2, 16000 * ((clock - 100) / 1000), 'nothing after stop');
});
