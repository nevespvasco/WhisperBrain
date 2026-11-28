'use strict';
// Record only the call's browser tab as the "Them" channel: the extension streams the tab's audio (16 kHz mono) to the app over the
// paired door; for that recording it is the system channel. The browser side (tabCapture, the offscreen document) needs a person
// to press the button in a real browser and is not run here: what is tested is the door, the channel, the clock, the fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { tmpDir } = require('./helpers');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { Evidence } = require('../src/meet/evidence');
const { RecordingManager } = require('../src/recording/manager');
const { SignalHub } = require('../src/meet/hub');
const { createIntake } = require('../src/meet/intake');
const { speech, echoOf, bytes } = require('./echo-synth');

const TOKEN = 'tab-token-0123456789abcdef';
const SECOND = 32000;                       // bytes of 16 kHz 16-bit mono
const tone = (ms, amp = 8000) => { const b = Buffer.alloc((ms * 32) | 0); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 7) * amp), i * 2); return b; };

// ---- the door ----
function post(port, { path: p = '/meet/audio', token = TOKEN, body, end = Date.now(), origin = 'chrome-extension://abcdefabcdefabcdefabcdefabcdefab' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'content-type': 'application/octet-stream', 'content-length': body.length, 'x-wb-end': String(end), ...(token ? { 'x-wb-signal-token': token } : {}), ...(origin ? { origin } : {}) } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return null; } })() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('the door: tab audio is accepted only from the paired extension, and only while a recording is on', async (t) => {
  const got = [];
  let recording = false;
  const intake = createIntake({ hub: new SignalHub(), getToken: () => TOKEN, info: () => ({ recording }), onAudio: (c) => { got.push(c); return { ok: true }; } });
  const port = await intake.listen(0);
  t.after(() => intake.close());
  const pcm = tone(500);
  assert.equal((await post(port, { body: pcm, token: null })).status, 401, 'not paired');
  assert.equal((await post(port, { body: pcm, token: 'wrong-token-0000000000' })).status, 401);
  assert.equal((await post(port, { body: pcm, origin: 'https://evil.example' })).status, 403, 'a web page is never the extension');
  const idle = await post(port, { body: pcm });
  assert.equal(idle.status, 409, 'no recording on');
  assert.match(idle.json.error, /recording/i);
  assert.equal(got.length, 0);
  recording = true;
  const ok = await post(port, { body: pcm, end: 123456 });
  assert.equal(ok.status, 200);
  assert.deepEqual([got.length, got[0].endMs, got[0].pcm.length], [1, 123456, pcm.length]);
  assert.equal((await post(port, { body: Buffer.alloc(3) })).status, 400, 'a half sample is no audio');
  assert.equal((await post(port, { body: Buffer.alloc(0) })).status, 400);
  assert.equal((await post(port, { body: Buffer.alloc(200 * 1024) })).status, 413, 'a chunk is a few hundred ms, not a file');
});

// ---- the recording ----
function rig(t, { settings = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  class FakeEngine extends EventEmitter { constructor() { super(); this.fed = []; } async start() {} feed(ch, buf) { this.fed.push([ch, buf]); } async flush() {} reset() {} }
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), sets = new Settings(db, bus), speakers = new Speakers(db, bus), evidence = new Evidence(db);
  sets.update({ speakerRefine: false, echoDedupe: true, speakerDiarize: false, speakerDetection: false, ...settings });
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => true, speakerPath: () => '/spk', segmentationInstalled: () => true, segmentationPath: () => '/seg' };
  const mgr = new RecordingManager({ notes, engine, models, settings: sets, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, evidence, spoolDir: tmpDir('wb-tab-', t), meet: new SignalHub() });
  const events = [];
  bus.subscribe((e) => events.push(e));
  const n = notes.create({});
  const tick = (ms) => t.mock.timers.tick(ms);
  const systemBytes = () => engine.fed.filter(([ch]) => ch === 'system').reduce((s, [, b]) => s + b.length, 0);
  return { mgr, engine, notes, evidence, events, n, tick, systemBytes, bus };
}
// the extension sends 500 ms chunks, each stamped with the moment it ends
const chunk = (r, ms, amp, at = Date.now()) => r.mgr.acceptTabAudio({ pcm: tone(ms, amp), endMs: at });

test('the tab is the system channel: its audio is what the engine hears as "Them", and other audio on the computer is not', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: true });
  // before the tab: the computer's own sound is the system channel
  r.mgr.pushPcm(r.n.id, 'system', tone(500, 3000));
  r.tick(500);
  assert.equal(r.systemBytes(), SECOND / 2);
  // the person starts the tab capture; from now on the music playing in another tab (the system source) stays out
  for (let i = 0; i < 4; i++) { r.tick(500); chunk(r, 500, 9000); r.mgr.pushPcm(r.n.id, 'system', tone(500, 1234)); }
  const heard = r.engine.fed.filter(([ch]) => ch === 'system').slice(1).map(([, b]) => b);
  assert.ok(heard.length >= 4);
  assert.ok(heard.every((b) => Math.max(...new Int16Array(b.buffer, b.byteOffset, b.length / 2)) > 8000), 'only the tab: nothing at the amplitude of the other audio');
  assert.ok(r.events.some((e) => e.type === 'recording.tab-audio' && e.data.state === 'on'));
  assert.equal(r.mgr.status().tab?.live, true);
  await r.mgr.stop();
});

test('with no system capture at all, the tab stream still makes the system channel', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: false });
  r.tick(500); assert.equal(chunk(r, 500, 9000).ok, true);
  r.tick(500); chunk(r, 500, 9000);
  assert.equal(r.systemBytes(), SECOND, 'a second of "Them"');
  await r.mgr.stop();
});

test('not recording, or stopping: the audio is refused, with the reason', async (t) => {
  const r = rig(t);
  assert.deepEqual(chunk(r, 500), { ok: false, reason: 'not recording' });
  await r.mgr.start(r.n.id, { mic: true, system: true });
  assert.equal(chunk(r, 500).ok, true);
  await r.mgr.stop();
  assert.equal(chunk(r, 500).ok, false);
});

test('the clock: a chunk that arrives late is placed where it was heard, with silence before it; one that overlaps is trimmed', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: false });
  r.tick(500); chunk(r, 500);                        // 0.0 - 0.5 s
  r.tick(1500); chunk(r, 500);                       // heard 1.5 - 2.0 s: 1 s of silence in between
  assert.equal(r.systemBytes(), SECOND * 2, 'positions 0 to 2 s are all there');
  r.tick(500); chunk(r, 1000);                       // a chunk 500 ms longer than the time that passed: its first 500 ms are already there
  assert.ok(Math.abs(r.systemBytes() - SECOND * 2.5) <= 640, `no audio twice (${r.systemBytes()})`);
  r.tick(500); chunk(r, 600);                        // 100 ms of jitter is no reason to cut or pad
  assert.ok(Math.abs(r.systemBytes() - SECOND * 3.1) <= 640, `jitter is kept as it is (${r.systemBytes()})`);
  await r.mgr.stop();
});

test('stream lost: the computer\'s own capture takes over with nothing missing, the gap is marked, and it goes back to the tab when it returns', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: true });
  for (let i = 0; i < 4; i++) { r.tick(500); chunk(r, 500, 9000); r.mgr.pushPcm(r.n.id, 'system', tone(500, 2000)); }
  // the tab closes (or the extension reloads): no chunks, the system capture goes on
  for (let i = 0; i < 8; i++) { r.tick(500); r.mgr.pushPcm(r.n.id, 'system', tone(500, 2000)); r.mgr.tabWatch(r.mgr.active); }
  const lost = r.events.find((e) => e.type === 'recording.tab-audio' && e.data.state === 'lost');
  assert.ok(lost, 'the person is told');
  assert.equal(r.mgr.status().tab.live, false);
  // 2 s of tab, then 4 s the computer's own capture heard: every second of the 6 s is in the channel
  assert.ok(Math.abs(r.systemBytes() - 6 * SECOND) <= SECOND / 2, `nothing lost (${r.systemBytes() / SECOND} s of 6)`);
  r.tick(500); chunk(r, 500, 9000);
  assert.equal(r.mgr.status().tab.live, true, 'back to the tab');
  assert.ok(r.events.some((e) => e.type === 'recording.tab-audio' && e.data.state === 'back'));
  await r.mgr.stop();
  const gap = r.evidence.forNote(r.n.id, { kind: 'stream' }).find((e) => e.key === 'tab-gap');
  assert.ok(gap && gap.t1 > gap.t0, 'the gap is marked on the note\'s timeline');
});

test('echo: the tab stream is a clean reference, so the microphone\'s echo of it is still dropped', async (t) => {
  const r = rig(t);
  await r.mgr.start(r.n.id, { mic: true, system: false });
  const far = speech(6000, 3);                     // test/echo-synth.js: speech-like loudness, 6 s
  const echo = echoOf(far, { delayMs: 120, gain: 0.5 });
  const pcmFar = bytes(far), pcmEcho = bytes(echo);
  for (let off = 0; off < pcmFar.length; off += SECOND / 2) {
    r.tick(500);
    r.mgr.acceptTabAudio({ pcm: pcmFar.subarray(off, off + SECOND / 2), endMs: Date.now() });
    r.mgr.pushPcm(r.n.id, 'mic', pcmEcho.subarray(off, off + SECOND / 2));
  }
  r.engine.emit('segment', { ch: 'mic', startMs: 100, endMs: 2500, text: 'the far end talking again through the speakers', words: [] });
  assert.equal(r.mgr.active.echoDropped.energy, 1, 'dropped as an echo of the tab stream');
  r.engine.emit('segment', { ch: 'mic', startMs: 2600, endMs: 2900, text: 'a quiet answer', words: [] });
  await r.mgr.stop();
});

// ---- the extension side that can be tested without a browser ----
test('extension: 48 kHz audio from the tab becomes 16 kHz 16-bit mono in chunks of about half a second', () => {
  const { Downsampler } = require('../extension/meet/tabaudio');
  const out = [];
  const d = new Downsampler({ inRate: 48000, chunkMs: 500, onChunk: (c) => out.push(c) });
  const block = new Float32Array(128);
  for (let n = 0; n < 48000 / 128 * 2; n++) { for (let i = 0; i < block.length; i++) block[i] = Math.sin(((n * 128 + i) / 48000) * 2 * Math.PI * 440) * 0.5; d.push(block); }
  assert.ok(out.length >= 3 && out.length <= 4, `${out.length} chunks in 2 s`);
  assert.ok(out.every((c) => c.length === SECOND / 2 || c.length === SECOND / 2 - 2 || c.length === SECOND / 2 + 2), 'half a second at 16 kHz is 16000 bytes');
  const s = new Int16Array(out[1].buffer, out[1].byteOffset, out[1].length / 2);
  assert.ok(Math.max(...s) > 14000 && Math.max(...s) < 17000, 'a 0.5 sine is about 16384');
  const mono = new Downsampler({ inRate: 16000, chunkMs: 500, onChunk: (c) => out.push(c) });
  assert.doesNotThrow(() => mono.push(new Float32Array(160)), 'a tab already at 16 kHz is fine');
});
