'use strict';
// The Discord bot: each person in the call arrives on a channel of their own and is named from the start.
// Discord itself is replaced by small stand-ins; what is checked is our side of the wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');
const { DiscordVoice } = require('../src/discord/bot');
const { toMono16k, Coalescer, OpusDecoder } = require('../src/discord/audio');

// ---- audio ----
test('toMono16k: 48 kHz stereo becomes 16 kHz mono, averaging the channels', () => {
  const frames = 960; // 20 ms
  const src = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) { src.writeInt16LE(1000, i * 4); src.writeInt16LE(3000, i * 4 + 2); }
  const out = toMono16k(src);
  assert.equal(out.length, 320 * 2, '20 ms at 16 kHz');
  assert.equal(out.readInt16LE(0), 2000);
  assert.equal(out.readInt16LE(out.length - 2), 2000);
});

test('Coalescer joins small chunks and flushes the rest', () => {
  const got = [];
  const c = new Coalescer(100, (b) => got.push(b.length));
  for (let i = 0; i < 5; i++) c.push(Buffer.alloc(640)); // 20 ms each
  c.push(Buffer.alloc(640));
  assert.deepEqual(got, [3200]);
  c.flush();
  assert.deepEqual(got, [3200, 640]);
});

test('OpusDecoder skips a damaged packet instead of throwing', () => {
  const dec = new OpusDecoder(class { static get Application() { return { AUDIO: 1 }; } decode() { throw new Error('corrupt'); } delete() {} });
  assert.equal(dec.decode(Buffer.from([1, 2, 3])), null);
});

// ---- the recording manager with a stand-in bot ----
class FakeEngine extends EventEmitter {
  constructor() { super(); this.fed = []; this.flushed = []; this.resets = []; }
  async start() {}
  feed(ch, pcm) { this.fed.push([ch, pcm.length]); }
  async flush(ch) { this.flushed.push(ch); }
  reset(ch) { this.resets.push(ch); }
}
class FakeBot extends EventEmitter {
  constructor({ joins = { guildName: 'Friends', channelName: 'General', channelId: '1' } } = {}) { super(); this.joins = joins; this.joined = []; this.left = 0; }
  async join(opts) { this.joined.push(opts); if (this.joins instanceof Error) throw this.joins; return this.joins; }
  leave() { this.left++; }
}

function setup({ bot = new FakeBot(), discord = { enabled: true, token: 'tok', userId: '42' } } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ discord, echoDedupe: false, speakerDetection: false });
  const speakers = new Speakers(db, bus);
  const engine = new FakeEngine();
  const created = [];
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx' };
  const platform = { capture: { mic: 'renderer', system: 'renderer' }, createMicSource: () => new PushSource(), createSystemSource: async () => { const s = new PushSource(); created.push(s); return s; } };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, speakers, discord: bot, evidence: new (require('../src/meet/evidence').Evidence)(db) });
  return { db, bus, events, notes, settings, speakers, engine, mgr, bot, created };
}
const chunk = (ms) => Buffer.alloc(ms * 16 * 2);
const say = (mgr, userId, name, ms, ts) => mgr.onDiscordAudio(mgr.active, { userId, name, pcm: chunk(ms), ts });
const settleAll = (mgr) => Promise.all([...mgr.active.remote.values()].map((r) => r.chain));

test('with the bot in the call every person is a channel of their own and the system audio is not captured', async () => {
  const { mgr, notes, bot, engine, events } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  assert.equal(bot.joined.length, 1);
  assert.deepEqual(bot.joined[0].skipUserIds, ['42'], 'you are the microphone channel: the bot must not transcribe you twice');
  assert.deepEqual(events.find((e) => e.type === 'capture.request').data.channels, ['mic'], 'no system capture next to the bot');
  const t = Date.now();
  say(mgr, '7', 'Ana', 200, t);
  say(mgr, '8', 'Rui', 200, t + 10);
  await settleAll(mgr);
  assert.deepEqual(engine.fed.map((f) => f[0]).sort(), ['dc:7', 'dc:8'], 'each person is fed to the engine on their own channel');
  assert.equal(mgr.status().discord.channelName, 'General');
  assert.deepEqual(mgr.status().discord.people, ['Ana', 'Rui']);
  await mgr.stop();
  assert.equal(bot.left, 1, 'the bot leaves the call when the recording stops');
});

test('words of each person are saved as "them", labelled with their Discord name, overlapping in time', async () => {
  const { mgr, notes, engine, speakers } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  const t = Date.now();
  say(mgr, '7', 'Ana', 200, t);
  say(mgr, '8', 'Rui', 200, t);
  await settleAll(mgr);
  engine.emit('segment', { ch: 'dc:7', startMs: 0, endMs: 1500, text: 'I think we should ship it' });
  engine.emit('segment', { ch: 'dc:8', startMs: 500, endMs: 1800, text: 'no wait, the tests fail' });
  const segs = notes.segments(n.id);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => [s.speaker, s.speakerId, s.label]), [['them', 'd7', 'Ana'], ['them', 'd8', 'Rui']]);
  assert.ok(segs[1].startMs < segs[0].endMs, 'overlapped speech keeps both lines, which a mixed stream would lose');
  await mgr.stop();
  const people = speakers.publicForNote(n.id);
  assert.deepEqual(people.map((p) => p.label).sort(), ['Ana', 'Rui']);
  assert.equal(speakers.forNote(n.id).length, 2, 'no voice guessing: the after-recording passes leave them alone');
});

test('each Discord person keeps their own channel on the saved line, instead of collapsing into "system"', async () => {
  const { mgr, notes, engine } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  const t = Date.now();
  say(mgr, '7', 'Ana', 200, t);
  say(mgr, '8', 'Rui', 200, t);
  await settleAll(mgr);
  engine.emit('segment', { ch: 'dc:7', startMs: 0, endMs: 1500, text: 'I think we should ship it' });
  engine.emit('segment', { ch: 'dc:8', startMs: 500, endMs: 1800, text: 'no wait, the tests fail' });
  await mgr.stop();
  assert.deepEqual(notes.segments(n.id).map((s) => [s.speaker, s.channel]), [['them', 'dc:7'], ['them', 'dc:8']]);
});

test('a Discord person is evidence in their own right: kept as kind "stream", and the speaker says so', async () => {
  const { mgr, notes, db, speakers } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  say(mgr, '7', 'Ana', 200, Date.now());
  await settleAll(mgr);
  await mgr.stop();
  const rows = new (require('../src/meet/evidence').Evidence)(db).forNote(n.id, { kind: 'stream' });
  assert.deepEqual(rows.map((r) => [r.name, r.source, r.key, r.meta.userId, r.meta.speakerId]), [['Ana', 'discord', 'ana', '7', 'd7']]);
  assert.equal(speakers.forNote(n.id).find((s) => s.speakerId === 'd7').nameSource, 'stream');
});

test('a person who renamed a speaker keeps the new name', async () => {
  const { mgr, notes, speakers } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  say(mgr, '7', 'ana_99', 100, Date.now());
  await settleAll(mgr);
  speakers.rename(n.id, 'd7', 'Ana Silva');
  say(mgr, '7', 'ana_99', 100, Date.now() + 200); // same person speaks again: the name must not be reset
  speakers.ensureNamed(n.id, 'd7', 'ana_99');
  assert.equal(speakers.forNote(n.id)[0].name, 'Ana Silva');
  await mgr.stop();
});

test('silence between sentences is filled so times stay true; a long silence closes the channel', async () => {
  const { mgr, notes, engine } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  const t = Date.now();
  say(mgr, '7', 'Ana', 100, t);        // chunks carry the time they END at: this one is audio up to t
  say(mgr, '7', 'Ana', 100, t + 500);  // audio from t+400 to t+500: 400 ms of silence before it
  await settleAll(mgr);
  const ana = engine.fed.filter((f) => f[0] === 'dc:7').reduce((sum, f) => sum + f[1] / 32, 0);
  assert.ok(Math.abs(ana - 600) <= 2, `the 400 ms gap is padded (fed ${ana} ms)`);
  say(mgr, '7', 'Ana', 100, t + 500 + 10000); // 10 s later: new stretch, not 10 s of zeros
  await settleAll(mgr);
  const after = engine.fed.filter((f) => f[0] === 'dc:7').reduce((sum, f) => sum + f[1] / 32, 0);
  assert.ok(after < 800, `a long silence is not fed (total ${after} ms)`);
  assert.ok(engine.resets.includes('dc:7'), 'the channel was reset for the new stretch');
  await mgr.stop();
});

test('pause drops Discord audio and resumes cleanly', async () => {
  const { mgr, notes, engine } = setup();
  const n = notes.create({});
  await mgr.start(n.id);
  say(mgr, '7', 'Ana', 100, Date.now());
  await settleAll(mgr);
  await mgr.pause();
  const before = engine.fed.length;
  say(mgr, '7', 'Ana', 100, Date.now());
  assert.equal(engine.fed.length, before, 'nothing is fed while paused');
  mgr.resume();
  say(mgr, '7', 'Ana', 100, Date.now() + 5000);
  await settleAll(mgr);
  assert.equal(engine.fed.length, before + 1, 'audio flows again; no padding for the paused minutes');
  await mgr.stop();
});

test('when you are not in a voice channel the recording falls back to the system audio, quietly', async () => {
  const { mgr, notes, events } = setup({ bot: new FakeBot({ joins: null }) });
  const n = notes.create({});
  await mgr.start(n.id);
  assert.deepEqual(events.find((e) => e.type === 'capture.request').data.channels, ['mic', 'system']);
  assert.equal(mgr.status().discord, null);
  assert.ok(!events.some((e) => e.type === 'recording.warning'), 'not being in a call is not a problem');
  await mgr.stop();
});

test('when the bot cannot join, say why and fall back to the system audio', async () => {
  const { mgr, notes, events } = setup({ bot: new FakeBot({ joins: new Error('Discord rejected the bot token') }) });
  const n = notes.create({});
  await mgr.start(n.id);
  assert.deepEqual(events.find((e) => e.type === 'capture.request').data.channels, ['mic', 'system']);
  assert.match(events.find((e) => e.type === 'recording.warning').data.message, /rejected the bot token/);
  await mgr.stop();
});

test('switched off, the bot is never asked', async () => {
  const { mgr, notes, bot } = setup({ discord: { enabled: false, token: 'tok', userId: '42' } });
  const n = notes.create({});
  await mgr.start(n.id);
  assert.equal(bot.joined.length, 0);
  await mgr.stop();
});

test('with no microphone the bot hears you too', async () => {
  const { mgr, notes, bot } = setup();
  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  assert.deepEqual(bot.joined[0].skipUserIds, []);
  await mgr.stop();
});

test('the bot token is masked in the public settings and kept when the mask is written back', () => {
  const db = open(':memory:');
  const settings = new Settings(db, new Bus());
  settings.update({ discord: { token: 'secret-token', userId: '42', enabled: true } });
  const view = settings.publicView();
  assert.equal(view.discord.token, '********');
  settings.update({ discord: { token: view.discord.token, enabled: false } });
  assert.equal(settings.get('discord').token, 'secret-token');
  assert.equal(settings.get('discord').enabled, false);
});

// ---- the bot against a stand-in Discord ----
function fakeDiscord({ inChannel = true, members = { 7: { name: 'Ana', bot: false }, 8: { name: 'Rui', bot: false }, 9: { name: 'Jukebox', bot: true } }, daveVersion = 1 } = {}) {
  const state = { joins: [], destroyed: 0, subscriptions: [] };
  const channel = { id: 'C1', name: 'General', isVoiceBased: () => true };
  const guild = {
    id: 'G1', name: 'Friends', voiceAdapterCreator: {},
    voiceStates: { cache: new Map(inChannel ? [['42', { channelId: 'C1' }]] : []) },
    channels: { cache: new Map([['C1', channel]]) },
    members: { fetch: async (id) => { const m = members[id]; if (!m) throw new Error('unknown member'); return { displayName: m.name, user: { bot: m.bot, username: m.name } }; } },
  };
  channel.guild = guild;
  class Client extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.user = { id: 'BOT', username: 'WhisperBrain' }; this.guilds = { cache: new Map([['G1', guild]]) }; this.channels = { cache: new Map([['C1', channel]]) }; this.users = { fetch: async (id) => { const m = members[id]; if (!m) throw new Error('nope'); return { username: m.name, bot: m.bot }; } }; }
    async login(token) { if (token !== 'good') throw new Error('An invalid token was provided.'); setImmediate(() => this.emit('clientReady')); }
    async destroy() { state.destroyed++; }
  }
  const receiver = { speaking: new EventEmitter(), subscribe(userId, opts) { const s = new PassThrough({ objectMode: true }); state.subscriptions.push({ userId, opts, stream: s }); return s; } };
  const voice = {
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting' },
    EndBehaviorType: { AfterSilence: 1 },
    joinVoiceChannel(opts) { const c = new EventEmitter(); c.receiver = receiver; c.destroy = () => { state.left = true; }; c.state = { networking: { state: { dave: { protocolVersion: daveVersion } } } }; state.joins.push(opts); return c; },
    entersState: async () => {},
  };
  class OpusScript { static get Application() { return { AUDIO: 1 }; } decode() { const b = Buffer.alloc(960 * 4); for (let i = 0; i < 960; i++) { b.writeInt16LE(900, i * 4); b.writeInt16LE(900, i * 4 + 2); } return b; } delete() {} }
  return { libs: { discord: { Client, GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 } }, voice, OpusScript }, state, receiver };
}
const bot = (fake, cfg = {}) => new DiscordVoice({ getConfig: () => ({ enabled: true, token: 'good', userId: '42', guildId: '', channelId: '', ...cfg }), libs: fake.libs });

test('the bot joins the channel you are in, with DAVE on, deafened off and muted', async () => {
  const fake = fakeDiscord();
  const b = bot(fake);
  const info = await b.join();
  assert.deepEqual(info, { guildName: 'Friends', channelName: 'General', channelId: 'C1' });
  assert.equal(fake.state.joins[0].daveEncryption, true);
  assert.equal(fake.state.joins[0].selfDeaf, false, 'a deafened bot hears nothing');
  assert.equal(fake.state.joins[0].selfMute, true);
  assert.equal(b.status().dave, 1);
  b.leave();
  assert.equal(fake.state.left, true);
});

test('not in a voice channel: join returns null', async () => {
  const b = bot(fakeDiscord({ inChannel: false }));
  assert.equal(await b.join(), null);
});

test('a wrong token says so in plain words', async () => {
  const b = bot(fakeDiscord(), { token: 'bad' });
  await assert.rejects(b.join(), (e) => e.code === 'bad-token' && /Reset Token/.test(e.message));
});

test('audio from a person arrives named, 16 kHz mono; you and bots are left out', async () => {
  const fake = fakeDiscord();
  const b = bot(fake);
  const got = [];
  b.on('audio', (a) => got.push(a));
  await b.join({ skipUserIds: ['42'] });
  for (const id of ['7', '42', '9', 'BOT']) fake.receiver.speaking.emit('start', id);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fake.state.subscriptions.map((s) => s.userId), ['7'], 'you, the other bot and the bot itself are not listened to');
  assert.equal(fake.state.subscriptions[0].opts.end.duration, 1200);
  const { stream } = fake.state.subscriptions[0];
  for (let i = 0; i < 10; i++) stream.write(Buffer.from([1, 2, 3])); // ten 20 ms packets
  stream.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.length >= 2 && got.every((a) => a.userId === '7' && a.name === 'Ana'));
  assert.equal(got.reduce((n, a) => n + a.pcm.length, 0), 10 * 320 * 2, '10 x 20 ms of 16 kHz s16 mono, none lost at the end of the stream');
  assert.equal(got[0].pcm.readInt16LE(0), 900);
  assert.equal(b.status().packets, 10);
  assert.deepEqual(b.status().heard, [{ id: '7', name: 'Ana' }]);
});

test('probe: tells the user the call works, with the invite link when no server has the bot', async () => {
  const fake = fakeDiscord();
  const b = bot(fake);
  setTimeout(() => { fake.receiver.speaking.emit('start', '7'); setTimeout(() => { const s = fake.state.subscriptions[0]; if (s) for (let i = 0; i < 5; i++) s.stream.write(Buffer.from([1])); }, 5); }, 5);
  const r = await b.probe({ seconds: 0.1 });
  assert.equal(r.ok, true);
  assert.equal(r.bot.name, 'WhisperBrain');
  assert.match(r.inviteUrl, /client_id=BOT&scope=bot&permissions=1049600/);
  assert.equal(r.call.channel, 'General');
  assert.equal(r.call.dave, 1);
  assert.deepEqual(r.call.heard, ['Ana']);
  assert.match(r.verdict, /works/);
  assert.equal(b.status().joined, false, 'the test leaves the call');
});

test('probe: joined but nobody spoke says that, not "works"', async () => {
  const r = await bot(fakeDiscord()).probe({ seconds: 0.05 });
  assert.match(r.verdict, /no audio arrived/);
});

test('probe: not in a call tells you to join one', async () => {
  const r = await bot(fakeDiscord({ inChannel: false })).probe({ seconds: 0.05 });
  assert.equal(r.call, null);
  assert.match(r.note, /not in a voice channel/);
});
