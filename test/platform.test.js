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
