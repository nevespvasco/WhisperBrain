'use strict';
// Speaker test recordings: the Discord bot's per-person streams and the computer's mixed sound of the same call, kept on one
// clock (src/recording/speaker-test.js), and the alignment eval/discord-test.js does before scoring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');
const { SpeakerTestRecorder } = require('../src/recording/speaker-test');
const { envelope, activity, align } = require('../eval/discord-test');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const tone = (ms, amp = 8000) => { const n = ms * 16, b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2); return b; };
const sampleAt = (buf, sec) => buf.readInt16LE(Math.round(sec * 16000) * 2);

test('recorder: people sit on the wall clock with silence between, the mixed sound follows on and jumps over a pause', (t) => {
  const dir = path.join(tmp(t), 'st');
  let now = 1_000_000;
  const r = new SpeakerTestRecorder(dir, { now: () => now, selfUserId: '42' });
  // Ana speaks 1.0-1.5 s, Rui 2.0-2.2 s (ts = end of chunk)
  r.person('7', 'Ana', tone(500), now + 1500);
  r.person('8', 'Rui', tone(200), now + 2200);
  r.person('7', 'Ana', tone(100), now + 1550); // a late chunk is put after what she already said, never over it
  // the mixed sound: 3 s straight, then a 2 s pause, then 1 s
  for (let i = 0; i < 30; i++) r.system(tone(100, 4000), now + (i + 1) * 100);
  r.system(tone(1000, 4000), now + 6000);
  now += 7000;
  const sum = r.close();
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.selfUserId, '42');
  assert.deepEqual(meta.people.map((p) => [p.name, p.file]), [['Ana', 'person-7.pcm'], ['Rui', 'person-8.pcm']]);
  assert.equal(meta.system.gaps, 1, 'the pause is a jump, not squeezed out');
  assert.ok(Math.abs(meta.system.seconds - 6) < 0.01, `mixed sound ends at 6 s (${meta.system.seconds})`);
  assert.deepEqual(sum.people, ['Ana', 'Rui']);
  const ana = fs.readFileSync(path.join(dir, 'person-7.pcm'));
  assert.equal(sampleAt(ana, 0.5), 0, 'silence before Ana spoke');
  assert.notEqual(sampleAt(ana, 1.2), 0, 'Ana at 1.2 s');
  assert.ok(Math.abs(ana.length / 32000 - 1.6) < 0.01, 'the late chunk follows on at 1.5-1.6 s');
  const sys = fs.readFileSync(path.join(dir, 'system.pcm'));
  assert.equal(sampleAt(sys, 4), 0, 'the pause is silence in the mixed sound');
  assert.notEqual(sampleAt(sys, 5.5), 0);
  assert.equal(r.close(), sum, 'closing twice is harmless');
});

test('alignment finds how much later the computer played the call than the bot heard it', () => {
  // a speech-like on/off pattern, the mixed sound 0.37 s later and a bit noisy
  let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const parts = [];
  for (let i = 0; i < 60; i++) parts.push(rnd() < 0.5 ? tone(200 + Math.floor(rnd() * 900)) : Buffer.alloc((200 + Math.floor(rnd() * 900)) * 32));
  const bot = Buffer.concat(parts);
  const noise = Buffer.alloc(bot.length); for (let i = 0; i < noise.length / 2; i++) noise.writeInt16LE(Math.round((rnd() - 0.5) * 60), i * 2);
  const sys = Buffer.concat([Buffer.alloc(370 * 32), bot]);
  for (let i = 0; i < noise.length / 2; i++) sys.writeInt16LE(Math.max(-32768, Math.min(32767, sys.readInt16LE(i * 2) + noise.readInt16LE(i * 2))), i * 2);
  const al = align(activity(envelope(sys)), activity(envelope(bot)));
  assert.ok(Math.abs(al.lag - 37) <= 1, `lag ${al.lag} frames, wanted 37`);
  assert.ok(al.score > 0.8 && al.score - al.runnerUp > 0.1, `clear peak (${al.score.toFixed(2)} vs ${al.runnerUp.toFixed(2)})`);
});

// ---- the recording manager ----
class FakeEngine extends EventEmitter {
  constructor() { super(); this.fed = []; }
  async start() {}
  feed(ch, pcm) { this.fed.push([ch, pcm.length]); }
  async flush() {}
  reset() {}
}
class FakeBot extends EventEmitter {
  constructor(joins = { guildName: 'Friends', channelName: 'General', channelId: '1' }) { super(); this.joins = joins; this.joined = []; this.left = 0; }
  async join(opts) { this.joined.push(opts); return this.joins; }
  leave() { this.left++; }
}
function setup(t, { bot = new FakeBot(), discord = { enabled: true, token: 'tok', userId: '42' } } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ discord, echoDedupe: false, speakerDetection: false });
  const engine = new FakeEngine();
  const data = tmp(t);
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx' };
  const platform = { capture: { mic: 'renderer', system: 'renderer' } };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, speakers: new Speakers(db, bus), discord: bot, spoolDir: path.join(data, 'spool') });
  return { notes, engine, mgr, bot, events, data };
}

test('speaker test: the bot and the mixed sound are both kept; only the bot\'s people are transcribed', async (t) => {
  const { mgr, notes, engine, bot, events, data } = setup(t);
  const n = notes.create({});
  await mgr.start(n.id, { speakerTest: true });
  assert.equal(mgr.status().speakerTest, true);
  assert.deepEqual(events.find((e) => e.type === 'capture.request').data.channels.sort(), ['mic', 'system'], 'the mixed sound is captured next to the bot');
  const now = Date.now();
  mgr.onDiscordAudio(mgr.active, { userId: '7', name: 'Ana', pcm: tone(300), ts: now });
  mgr.pushPcm(n.id, 'system', tone(300, 3000));
  await Promise.all([...mgr.active.remote.values()].map((r) => r.chain));
  assert.ok(!engine.fed.some(([ch]) => ch === 'system'), 'the mixed sound is not transcribed (it would repeat the bot)');
  assert.ok(engine.fed.some(([ch]) => ch === 'dc:7'));
  await mgr.stop();
  assert.equal(bot.left, 1);
  const done = events.find((e) => e.type === 'recording.speaker-test').data;
  assert.equal(path.dirname(done.dir), path.join(data, 'speaker-tests'));
  assert.deepEqual(done.people, ['Ana']);
  const meta = JSON.parse(fs.readFileSync(path.join(done.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.selfUserId, '42');
  assert.ok(fs.statSync(path.join(done.dir, 'system.pcm')).size >= 300 * 32);
  assert.ok(fs.statSync(path.join(done.dir, 'person-7.pcm')).size >= 300 * 32);
});

test('speaker test without the bot in the call: refused with a way forward, nothing left running', async (t) => {
  const { mgr, notes } = setup(t, { discord: { enabled: false, token: '', userId: '' } });
  const n = notes.create({});
  await assert.rejects(mgr.start(n.id, { speakerTest: true }), (e) => e.code === 'no-discord' && /Settings → Integrations → Discord/.test(e.message));
  assert.equal(mgr.status().active, false);
});

test('an ordinary recording with the bot still leaves the mixed sound out', async (t) => {
  const { mgr, notes, events } = setup(t);
  const n = notes.create({});
  await mgr.start(n.id);
  assert.deepEqual(events.find((e) => e.type === 'capture.request').data.channels, ['mic']);
  assert.equal(mgr.status().speakerTest, false);
  await mgr.stop();
  assert.ok(!events.some((e) => e.type === 'recording.speaker-test'));
});
