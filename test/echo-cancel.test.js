'use strict';
// Echo cancellation: PipeWire is faked (spawn, pw-dump, the filesystem layout), so these run anywhere.
// The real thing is exercised in test/live-aec.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings, DEFAULTS } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { AudioSource, PushSource } = require('../src/audio/source');
const { detectEchoCancel, buildConfig, EchoCanceller, EchoCancelledSource, WATCHDOG } = require('../src/platform/pw-echo-cancel');
const linux = require('../src/platform/linux');
const { enhancement } = require('../src/audio/capture-options');
const { speech, echoOf, bytes } = require('./echo-synth');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fakes ----
class FakeChild extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(sig) { this.signals.push(sig); setImmediate(() => this.emit('close', null, sig)); return true; }
  die(code, err) { if (err) this.stderr.emit('data', err); this.emit('close', code, null); }
}
// spawn() hands out FakeChilds and remembers how it was called
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => { const child = new FakeChild(); calls.push({ cmd, args, opts, child, conf: fs.existsSync(args[3]) ? fs.readFileSync(args[3], 'utf8') : null }); return child; };
  fn.calls = calls;
  return fn;
}
const dumpWith = (...names) => async () => ({ sources: names.map((id) => ({ id, name: id })), sinks: [], inputStreams: [], defaultSink: 'speakers', defaultSource: 'mic' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-aec-test-'));
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('whisperbrain-aec-'));

// ---- detection ----
test('detection: needs the module, the WebRTC plugin, monitor mode and the pipewire binary', async () => {
  const files = new Map();
  const exists = (p) => files.has(p);
  const readFile = (p) => files.get(p);
  const args = { env: {}, exists, readFile, readdir: () => ['x86_64-linux-gnu'], hasCommand: async () => true };
  const mod = '/usr/lib/x86_64-linux-gnu/pipewire-0.3/libpipewire-module-echo-cancel.so';
  const plug = '/usr/lib/x86_64-linux-gnu/spa-0.2/aec/libspa-aec-webrtc.so';

  let r = await detectEchoCancel(args);
  assert.equal(r.available, false);
  assert.match(r.reason, /echo-cancel module is not installed/);

  files.set(mod, Buffer.from('capture.props monitor.mode'));
  r = await detectEchoCancel(args);
  assert.equal(r.available, false);
  assert.match(r.reason, /WebRTC echo-cancel plugin is missing/);

  files.set(plug, Buffer.from('x'));
  files.set(mod, Buffer.from('capture.props only'));
  r = await detectEchoCancel(args);
  assert.equal(r.available, false);
  assert.match(r.reason, /too old/);

  files.set(mod, Buffer.from('capture.props monitor.mode'));
  r = await detectEchoCancel({ ...args, hasCommand: async () => false });
  assert.equal(r.available, false);
  assert.match(r.reason, /pipewire program/);

  r = await detectEchoCancel(args);
  assert.deepEqual([r.available, r.reason, r.modulePath, r.pluginPath], [true, '', mod, plug]);

  // PIPEWIRE_MODULE_DIR / SPA_PLUGIN_DIR win over the system directories
  files.clear();
  files.set('/opt/pw/libpipewire-module-echo-cancel.so', Buffer.from('monitor.mode'));
  files.set('/opt/spa/aec/libspa-aec-webrtc.so', Buffer.from('x'));
  r = await detectEchoCancel({ ...args, env: { PIPEWIRE_MODULE_DIR: '/opt/pw', SPA_PLUGIN_DIR: '/opt/spa' } });
  assert.equal(r.available, true);
});

test('detection: on this machine it answers without throwing', async () => {
  const r = await detectEchoCancel();
  assert.equal(typeof r.available, 'boolean');
  if (!r.available) assert.ok(r.reason.length > 10);
});

// ---- config ----
test('config: reference is the output monitor, nothing global is touched, quoting is safe', () => {
  const c = buildConfig({ name: 'wb-x', mic: 'alsa_input.usb "evil" \\ mic', sink: 'alsa_output.speakers', noiseSuppression: false, autoGain: true });
  assert.match(c, /libpipewire-module-echo-cancel/);
  assert.match(c, /library\.name = aec\/libspa-aec-webrtc/);
  assert.match(c, /monitor\.mode = true/);
  assert.match(c, /webrtc\.noise_suppression = false/);
  assert.match(c, /webrtc\.gain_control = true/);
  assert.match(c, /source\.props = \{ node\.name = "wb-x" /);
  assert.match(c, /sink\.props = \{ node\.name = "wb-x\.reference" node\.target = "alsa_output\.speakers" \}/);
  assert.match(c, /node\.target = "alsa_input\.usb \\"evil\\" \\\\ mic"/, 'quotes and backslashes in device names are escaped');
  assert.doesNotMatch(c, /protocol-native.*server/s, 'a client config: it never becomes a second PipeWire server');
  const bare = buildConfig({ name: 'wb-y' });
  assert.doesNotMatch(bare, /node\.target/, 'with no device named, PipeWire follows the defaults');
  assert.match(bare, /webrtc\.noise_suppression = false/);
  assert.match(bare, /webrtc\.gain_control = false/);
});

test('enhancement settings: auto keeps the platform default, on/off override it', () => {
  assert.equal(enhancement('auto', false), false);
  assert.equal(enhancement('auto', true), true);
  assert.equal(enhancement('on', false), true);
  assert.equal(enhancement('off', true), false);
});

// ---- the helper process ----
test('canceller: starts a private helper, waits for the source, and removes every trace on stop', async () => {
  const dir = tmp();
  const spawnFn = fakeSpawn();
  let polls = 0;
  const dump = async () => (++polls < 3 ? { sources: [] } : { sources: [{ id: 'wb-aec-1' }] });
  const c = new EchoCanceller({ dump, spawnFn, tmpdir: dir, pid: 4242, pollMs: 5 });
  const name = await c.start({ mic: 'mic1', sink: 'sink1', name: 'wb-aec-1' });
  assert.equal(name, 'wb-aec-1');
  assert.ok(polls >= 3, 'waited for PipeWire to list the node');
  const call = spawnFn.calls[0];
  assert.equal(call.cmd, 'sh');
  assert.deepEqual(call.args.slice(0, 3), ['-c', WATCHDOG, 'whisperbrain-aec']);
  assert.equal(call.args[4], '4242', 'the helper watches our pid');
  assert.match(call.args[3], /echo-cancel\.conf$/);
  assert.ok(path.resolve(call.args[3]).startsWith(dir), 'the config lives in a private temp dir, not in ~/.config/pipewire');
  assert.match(call.conf, /node\.target = "mic1"/);
  assert.equal((fs.statSync(call.args[3]).mode & 0o077), 0, 'config is private');
  assert.equal(leftovers(dir).length, 1);
  await c.stop();
  assert.deepEqual(call.child.signals, ['SIGTERM']);
  assert.equal(leftovers(dir).length, 0, 'temp config removed');
  await c.stop(); // idempotent
  fs.rmSync(dir, { recursive: true });
});

test('canceller: an immediate exit rejects with what the helper said, and cleans up', async () => {
  const dir = tmp();
  const spawnFn = fakeSpawn();
  const c = new EchoCanceller({ dump: dumpWith(), spawnFn, tmpdir: dir, pollMs: 5 });
  const p = c.start({ mic: 'm', sink: 's' });
  await wait(10);
  spawnFn.calls[0].child.die(1, 'can\'t load module echo-cancel');
  await assert.rejects(p, /exited \(1\).*can't load module/);
  assert.equal(leftovers(dir).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('canceller: a source that never appears times out, kills the helper and cleans up', async () => {
  const dir = tmp();
  const spawnFn = fakeSpawn();
  const c = new EchoCanceller({ dump: dumpWith('something-else'), spawnFn, tmpdir: dir, pollMs: 5, readyTimeoutMs: 60 });
  await assert.rejects(c.start({ mic: 'm', sink: 's' }), /did not offer the echo-cancelled microphone/);
  assert.deepEqual(spawnFn.calls[0].child.signals, ['SIGTERM']);
  assert.equal(leftovers(dir).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('canceller: a helper that dies mid-recording is reported as lost', async () => {
  const dir = tmp();
  const spawnFn = fakeSpawn();
  const c = new EchoCanceller({ dump: dumpWith('n'), spawnFn, tmpdir: dir, pollMs: 5 });
  await c.start({ mic: 'm', sink: 's', name: 'n' });
  const lost = new Promise((r) => c.once('lost', r));
  spawnFn.calls[0].child.die(0, 'pipewire: connection lost');
  assert.match((await lost).message, /exited unexpectedly: pipewire: connection lost/);
  assert.equal(leftovers(dir).length, 0);
  fs.rmSync(dir, { recursive: true });
});

// ---- the source the recording reads ----
class FakeMic extends AudioSource {
  constructor(label) { super(); this.label = label; this.started = false; this.stopped = false; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
function cancelledSource({ firstAudioMs = 5000 } = {}) {
  const canceller = Object.assign(new EventEmitter(), { stops: 0, stop() { this.stops++; return Promise.resolve(); } });
  const made = { cancelled: [], raw: [] };
  const aec = { requested: true, active: true, backend: 'pipewire-webrtc', reason: '' };
  const src = new EchoCancelledSource({
    canceller, aec, firstAudioMs,
    makeCancelled: () => { const m = new FakeMic('cancelled'); made.cancelled.push(m); return m; },
    makeRaw: () => { const m = new FakeMic('raw'); made.raw.push(m); return m; },
  });
  const events = [];
  src.on('error', (e) => events.push(['error', e.message]));
  src.on('end', () => events.push(['end']));
  return { src, canceller, made, aec, events };
}

test('source: reads the echo-cancelled mic and stops both ends', () => {
  const { src, canceller, made, aec } = cancelledSource();
  const got = [];
  src.on('pcm', (b) => got.push(b.length));
  src.start();
  made.cancelled[0].emit('pcm', Buffer.alloc(640));
  assert.deepEqual(got, [640]);
  assert.equal(aec.active, true);
  src.stop();
  assert.equal(made.cancelled[0].stopped, true);
  assert.equal(canceller.stops, 1);
  assert.deepEqual(made.raw, []);
});

test('source: if the canceller dies, the recording keeps going on the raw microphone', () => {
  const { src, canceller, made, aec, events } = cancelledSource();
  const got = [];
  src.on('pcm', (b) => got.push(b.length));
  src.start();
  made.cancelled[0].emit('pcm', Buffer.alloc(320));
  canceller.emit('lost', new Error('the echo canceller exited unexpectedly'));
  assert.equal(made.cancelled[0].stopped, true);
  assert.equal(made.raw.length, 1);
  assert.equal(made.raw[0].started, true);
  assert.equal(aec.active, false);
  assert.match(aec.reason, /raw microphone/);
  assert.match(events[0][1], /echo cancellation stopped .*raw microphone/, 'surfaced as a warning');
  made.cancelled[0].emit('pcm', Buffer.alloc(999)); // a straggler from the old source is ignored
  made.cancelled[0].emit('end');
  made.raw[0].emit('pcm', Buffer.alloc(640));
  assert.deepEqual(got, [320, 640]);
  assert.ok(!events.some((e) => e[0] === 'end'), 'the swap is not an end of capture');
  src.stop();
  assert.equal(made.raw[0].stopped, true);
});

test('source: a canceller that delivers no audio is abandoned for the raw microphone', async () => {
  const { src, made, aec, events } = cancelledSource({ firstAudioMs: 30 });
  src.start();
  await wait(80);
  assert.equal(made.raw.length, 1);
  assert.equal(aec.active, false);
  assert.match(aec.reason, /no audio/);
  assert.equal(events.length, 1);
  src.stop();
});

// ---- the Linux adapter ----
const parsed = { defaultSink: 'speakers', defaultSource: 'mic', sources: [{ id: 'mic', name: 'Mic' }], sinks: [], inputStreams: [] };
function fakeCanceller({ fail = null } = {}) {
  const c = Object.assign(new EventEmitter(), { started: null, stops: 0, async start(o) { if (fail) throw new Error(fail); c.started = o; return 'wb-fake-aec'; }, stop() { c.stops++; return Promise.resolve(); } });
  return c;
}
function adapter({ available = true, reason = '', fail, dump = async () => parsed } = {}) {
  const cancellers = [];
  const p = linux.create({ env: {}, pwDump: dump, aec: { detect: async () => ({ available, reason }), createCanceller: () => { const c = fakeCanceller({ fail }); cancellers.push(c); return c; } } });
  return { p, cancellers };
}

test('linux: with echo cancellation on and available, the mic is the echo-cancelled source and the reference is the default sink', async () => {
  const { p, cancellers } = adapter();
  const src = await p.openMicSource({ echoCancel: true, noiseSuppression: 'auto', autoGain: 'on' });
  assert.ok(src instanceof EchoCancelledSource);
  assert.equal(src.aec.active, true);
  assert.equal(src.aec.backend, 'pipewire-webrtc');
  assert.equal(src.aec.reference, 'speakers');
  assert.deepEqual(cancellers[0].started, { mic: 'mic', sink: 'speakers', noiseSuppression: false, autoGain: true });
  // it records from the cancelled node, not from the raw mic
  src.on('error', () => {}); // pw-record may not exist where the tests run: its spawn error is not what this test is about
  src.start();
  assert.deepEqual(src.inner.args.slice(-3), ['--target', 'wb-fake-aec', '-']);
  src.stop();
  assert.equal(cancellers[0].stops, 1);
});

test('linux: a chosen microphone is the one that gets cancelled', async () => {
  const { p, cancellers } = adapter();
  await p.openMicSource({ device: 'alsa_input.usb-x', echoCancel: true });
  assert.equal(cancellers[0].started.mic, 'alsa_input.usb-x');
});

test('linux: setting off, module missing, no output device and helper failure all fall back to the raw mic, with a reason', async () => {
  const cases = [
    [adapter(), { echoCancel: false }, /turned off/, false],
    [adapter({ available: false, reason: 'PipeWire\'s echo-cancel module is not installed' }), { echoCancel: true }, /not installed/, true],
    [adapter({ dump: async () => ({ ...parsed, defaultSink: null }) }), { echoCancel: true }, /no output device/, true],
    [adapter({ dump: async () => null }), { echoCancel: true }, /no output device/, true],
    [adapter({ fail: 'did not offer the source' }), { echoCancel: true }, /could not start: did not offer the source/, true],
  ];
  for (const [{ p, cancellers }, opts, reason, requested] of cases) {
    const src = await p.openMicSource({ device: 'my-mic', ...opts });
    assert.equal(src.cmd, 'pw-record', String(reason));
    assert.deepEqual(src.args.slice(-3), ['--target', 'my-mic', '-'], 'plain capture of the chosen mic');
    assert.equal(src.aec.active, false);
    assert.equal(src.aec.requested, requested);
    assert.match(src.aec.reason, reason);
    if (cancellers.length) assert.equal(cancellers[0].stops, 0 + (cancellers[0].started ? 1 : 0), 'a helper that never started is not left behind');
  }
});

test('linux: createMicSource is still the raw microphone, and capabilities say whether echo cancellation could work', async () => {
  const { p } = adapter({ available: false, reason: 'because' });
  const raw = p.createMicSource({ device: 'x' });
  assert.equal(raw.aec, undefined);
  assert.deepEqual(raw.args.slice(-3), ['--target', 'x', '-']);
  const caps = await p.capabilities();
  if (caps.mic) assert.deepEqual(caps.echoCancel, { available: false, reason: 'because' });
  else assert.equal(caps.echoCancel.available, false);
});

// ---- recordings ----
class FakeEngine extends EventEmitter {
  constructor() { super(); this.fed = []; }
  async start() {}
  configure() {}
  feed(ch, pcm) { this.fed.push([ch, pcm.length]); }
  async flush() {}
  reset() {}
}
function recorder({ micFactory, settings: patch = {} } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  if (Object.keys(patch).length) settings.update(patch);
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx' };
  const sources = { mic: null, system: null, micOpts: null };
  const platform = {
    capture: { mic: 'native', system: 'native' },
    ...micFactory({ sources }),
    createSystemSource: async () => (sources.system = new PushSource()),
  };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus });
  return { mgr, notes, engine, events, sources, settings };
}

test('recording: with AEC active the status says so and the settings reach the platform', async () => {
  const { mgr, notes, events, sources } = recorder({
    settings: { echoCancel: true, micNoiseSuppression: 'off', micAutoGain: 'on', micDevice: 'usb-mic' },
    micFactory: ({ sources }) => ({ openMicSource: async (o) => { sources.micOpts = o; const s = new PushSource(); s.aec = { requested: true, active: true, backend: 'pipewire-webrtc', reason: '' }; return (sources.mic = s); } }),
  });
  const n = notes.create({});
  const st = await mgr.start(n.id);
  assert.deepEqual(sources.micOpts, { device: 'usb-mic', echoCancel: true, noiseSuppression: 'off', autoGain: 'on' });
  assert.equal(st.echo.cancellation.active, true);
  assert.equal(events.find((e) => e.type === 'recording.started').data.echoCancellation.backend, 'pipewire-webrtc');
  await mgr.stop();
});

test('recording: without AEC (platform has none, or it could not start) the recording still works end to end', async () => {
  for (const micFactory of [
    ({ sources }) => ({ createMicSource: () => (sources.mic = new PushSource()) }),                                           // no openMicSource at all
    ({ sources }) => ({ openMicSource: async () => { const s = new PushSource(); s.aec = { requested: true, active: false, backend: null, reason: 'module not installed' }; return (sources.mic = s); } }),
  ]) {
    const { mgr, notes, engine, sources } = recorder({ micFactory });
    const n = notes.create({});
    const st = await mgr.start(n.id);
    sources.mic.push(Buffer.alloc(3200));
    sources.system.push(Buffer.alloc(3200));
    assert.deepEqual(engine.fed.map((f) => f[0]).sort(), ['mic', 'system']);
    assert.ok(st.echo.cancellation === null || st.echo.cancellation.active === false);
    engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 800, text: 'still transcribed' });
    assert.equal(notes.segments(n.id).length, 1);
    const done = await mgr.stop();
    assert.equal(done.note.status, 'done');
  }
});

test('recording: a mic that cannot be opened at all is still a failed start, and releases the slot (unchanged behaviour)', async () => {
  const { mgr, notes } = recorder({ micFactory: () => ({ openMicSource: async () => { throw new Error('no such device'); } }) });
  const n = notes.create({});
  await assert.rejects(mgr.start(n.id), /no such device/);
  assert.equal(mgr.status().active, false);
  const st = await mgr.start(n.id, { mic: false });
  assert.deepEqual(st.channels, ['system'], 'system-only recording does not touch the mic');
  await mgr.stop();
});

test('recording: a source that falls back mid-recording is reported as a warning and keeps feeding the engine', async () => {
  let raw;
  const { mgr, notes, engine, events } = recorder({
    micFactory: () => ({
      openMicSource: async () => {
        const canceller = Object.assign(new EventEmitter(), { stop() { return Promise.resolve(); } });
        const cancelled = new FakeMic('c');
        return new EchoCancelledSource({ canceller, aec: { requested: true, active: true, backend: 'pipewire-webrtc', reason: '' }, makeCancelled: () => cancelled, makeRaw: () => (raw = new FakeMic('r')) });
      },
    }),
  });
  const n = notes.create({});
  await mgr.start(n.id);
  const src = mgr.active.channels.mic;
  src.inner.emit('pcm', Buffer.alloc(640));
  src.canceller.emit('lost', new Error('the echo canceller exited unexpectedly'));
  raw.emit('pcm', Buffer.alloc(640));
  assert.deepEqual(engine.fed.filter((f) => f[0] === 'mic').length, 2);
  assert.ok(events.some((e) => e.type === 'recording.warning' && /echo cancellation stopped/.test(e.data.message)));
  assert.equal(mgr.status().echo.cancellation.active, false);
  await mgr.stop();
});

test('recording: on a browser-captured mic (macOS/Windows) the status says it cannot be verified', async () => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const platform = { capture: { mic: 'renderer', system: 'renderer' } };
  const mgr = new RecordingManager({ notes, engine: new FakeEngine(), models: { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '' }, settings, platform, bus });
  const n = notes.create({});
  const st = await mgr.start(n.id);
  assert.equal(st.echo.cancellation.backend, 'chromium');
  assert.equal(st.echo.cancellation.active, null);
  await mgr.stop();
});

test('recording: the loudness backstop drops a short echo the words do not catch, and keeps the user\'s own speech', async () => {
  const sys = speech(2500, 31);
  const echo = echoOf(sys, { delayMs: 130, gain: 0.3 });
  const mine = speech(2500, 77);
  const run = async (patch, micAudio, mic) => {
    const { mgr, notes, engine, sources } = recorder({ settings: patch, micFactory: ({ sources }) => ({ createMicSource: () => (sources.mic = new PushSource()) }) });
    const n = notes.create({});
    await mgr.start(n.id);
    for (let off = 0; off < sys.length; off += 640) {
      sources.system.push(bytes(sys.subarray(off, off + 640)));
      sources.mic.push(bytes(micAudio.subarray(off, off + 640)));
    }
    engine.emit('segment', { ch: 'system', startMs: 100, endMs: 2400, text: 'we need the numbers by thursday' });
    engine.emit('segment', { ch: 'mic', startMs: 200, endMs: 2300, text: mic }); // too few words for the text match
    const kept = notes.segments(n.id).filter((x) => x.speaker === 'me').length;
    const dropped = mgr.status().echo.dropped;
    await mgr.stop();
    return { kept, dropped };
  };
  assert.deepEqual(await run({}, echo, 'thursday'), { kept: 0, dropped: { text: 0, energy: 1 } }, 'the echo is dropped by loudness');
  assert.deepEqual(await run({}, mine, 'sure thing'), { kept: 1, dropped: { text: 0, energy: 0 } }, 'the user talking over the call is kept');
  assert.equal((await run({ echoDedupe: false }, echo, 'thursday')).kept, 1, 'echo removal off keeps everything');
});

// ---- settings and the browser path ----
test('settings: echo cancellation defaults on; noise suppression and gain default to automatic and reject nonsense', () => {
  assert.equal(DEFAULTS.echoCancel, true);
  assert.equal(DEFAULTS.micNoiseSuppression, 'auto');
  assert.equal(DEFAULTS.micAutoGain, 'auto');
  const s = new Settings(open(':memory:'), new Bus());
  assert.equal(s.update({ micNoiseSuppression: 'off', micAutoGain: 'on', echoCancel: false }).micNoiseSuppression, 'off');
  assert.throws(() => s.update({ micNoiseSuppression: 'maybe' }), /auto, on or off/);
  assert.throws(() => s.update({ echoCancel: 'yes' }), /boolean/);
});

test('browser capture: constraints follow the settings; automatic keeps Chromium\'s defaults', async () => {
  const { micConstraints } = await import('../ui/capture.js');
  assert.deepEqual(micConstraints({}), { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 'no settings = what shipped before');
  assert.deepEqual(micConstraints({ echoCancel: true, micNoiseSuppression: 'auto', micAutoGain: 'auto' }), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepEqual(micConstraints({ echoCancel: false, micNoiseSuppression: 'off', micAutoGain: 'off' }), { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  assert.deepEqual(micConstraints({ echoCancel: true, micNoiseSuppression: 'off', micAutoGain: 'on' }), { echoCancellation: true, noiseSuppression: false, autoGainControl: true });
});
