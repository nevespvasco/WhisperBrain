'use strict';
// Discord without a bot: the local RPC connection (a fake Discord app on a socket stands in for the real one).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const { tmpDir } = require('./helpers');
const path = require('node:path');
const { DiscordRpc, socketPaths, encode, Decoder, OP } = require('../src/discord/rpc');

const tmp = () => tmpDir('wb-rpc-'); // removed when this file's tests end (test/helpers.js)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(10); } throw new Error('timed out waiting'); }

// A fake Discord: speaks the framing, answers the commands this app uses, lets the test push events.
class FakeDiscord {
  constructor(dir, { n = 0, me = { id: '100', username: 'me', global_name: 'Me' }, goodToken = 'tok1', channel = null } = {}) {
    Object.assign(this, { dir, me, goodToken, channel });
    this.file = path.join(dir, `discord-ipc-${n}`);
    this.sockets = new Set();
    this.log = [];
    this.subs = new Set();
    this.server = net.createServer((s) => this.accept(s));
  }
  listen() { return new Promise((r) => this.server.listen(this.file, r)); }
  close() { for (const s of this.sockets) s.destroy(); return new Promise((r) => this.server.close(r)); }
  accept(s) {
    this.sockets.add(s);
    const dec = new Decoder();
    s.on('data', (d) => { for (const f of dec.push(d)) this.onFrame(s, f); });
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
  }
  send(s, payload, op = OP.FRAME) { s.write(encode(op, payload)); }
  push(evt, data) { for (const s of this.sockets) this.send(s, { cmd: 'DISPATCH', evt, data }); }
  onFrame(s, { op, data }) {
    this.log.push({ op, ...data });
    if (op === OP.HANDSHAKE) return this.send(s, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: this.me } });
    if (op === OP.PING) return this.send(s, data, OP.PONG);
    const reply = (d, extra = {}) => this.send(s, { cmd: data.cmd, nonce: data.nonce, data: d, ...extra });
    const fail = (code, message) => this.send(s, { cmd: data.cmd, nonce: data.nonce, evt: 'ERROR', data: { code, message } });
    switch (data.cmd) {
      case 'AUTHORIZE': return reply({ code: 'the-code' });
      case 'AUTHENTICATE': return data.args.access_token === this.goodToken ? reply({ user: this.me, scopes: ['rpc', 'rpc.voice.read'] }) : fail(4009, 'Invalid token');
      case 'GET_SELECTED_VOICE_CHANNEL': return reply(this.channel);
      case 'SUBSCRIBE': this.subs.add(`${data.evt}:${data.args?.channel_id || ''}`); return reply({ evt: data.evt });
      case 'UNSUBSCRIBE': this.subs.delete(`${data.evt}:${data.args?.channel_id || ''}`); return reply({ evt: data.evt });
      default: return fail(1000, `unknown command ${data.cmd}`);
    }
  }
}

const CHANNEL = (people) => ({ id: 'c1', guild_id: 'g1', name: 'Standup', type: 2, voice_states: people.map(([id, name, nick]) => ({ nick, user: { id, username: name.toLowerCase(), global_name: name }, voice_state: {} })) });

function rig({ tokens = { accessToken: 'tok1', refreshToken: 'ref1' }, channel = null, fetch } = {}) {
  const dir = tmp();
  const fake = new FakeDiscord(dir, { channel });
  const store = { enabled: true, clientId: 'app1', clientSecret: 'sec', ...tokens };
  const rpc = new DiscordRpc({
    getConfig: () => store, saveTokens: (t) => Object.assign(store, t),
    env: { XDG_RUNTIME_DIR: dir }, platformId: 'linux', backoff: [20, 40], fetch,
  });
  const events = [];
  for (const e of ['state', 'call', 'roster', 'speaking']) rpc.on(e, (d) => events.push([e, d]));
  return { dir, fake, store, rpc, events };
}

test('framing: a frame is an opcode, a length and JSON; frames split and glued on the wire are told apart', () => {
  const a = encode(OP.FRAME, { cmd: 'X', n: 1 }), b = encode(OP.PING, { n: 2 });
  assert.equal(a.readInt32LE(0), OP.FRAME);
  const dec = new Decoder();
  const all = Buffer.concat([a, b]);
  const got = [...dec.push(all.subarray(0, 5)), ...dec.push(all.subarray(5, a.length + 3)), ...dec.push(all.subarray(a.length + 3))];
  assert.deepEqual(got.map((f) => [f.op, f.data.n]), [[OP.FRAME, 1], [OP.PING, 2]]);
});

test('socket paths: the documented places on each system, the numbered sockets 0-9', () => {
  const lin = socketPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/t', TMP: '/t', TEMP: '/e' });
  assert.equal(lin[0], '/run/user/1000/discord-ipc-0');
  for (const p of ['/run/user/1000/app/com.discordapp.Discord/discord-ipc-0', '/run/user/1000/snap.discord/discord-ipc-0', '/t/discord-ipc-0', '/e/discord-ipc-0', '/tmp/discord-ipc-0', '/tmp/discord-ipc-9']) assert.ok(lin.includes(p), p);
  assert.equal(new Set(lin).size, lin.length, 'no place twice');
  assert.equal(socketPaths('darwin', { TMPDIR: '/var/folders/x/T/' })[0], '/var/folders/x/T/discord-ipc-0');
  assert.deepEqual(socketPaths('win32', {}).slice(0, 2), ['\\\\?\\pipe\\discord-ipc-0', '\\\\?\\pipe\\discord-ipc-1']);
});

test('connect: handshake, authenticate with the saved token, and say connected; the person is known', async (t) => {
  const { fake, rpc, events } = rig();
  await fake.listen(); t.after(() => { rpc.stop(); return fake.close(); });
  rpc.start();
  await until(() => rpc.status().state === 'connected');
  assert.deepEqual(fake.log.find((f) => f.op === OP.HANDSHAKE), { op: OP.HANDSHAKE, v: 1, client_id: 'app1' });
  assert.equal(rpc.status().user.id, '100');
  assert.ok(fake.subs.has('VOICE_CHANNEL_SELECT:'));
  assert.deepEqual(events.filter((e) => e[0] === 'state').map((e) => e[1].state).slice(-2), ['connecting', 'connected']);
});

test('the call: only the selected voice channel counts, with the people in it and who they are', async (t) => {
  const { fake, rpc, events } = rig({ channel: CHANNEL([['100', 'Me'], ['200', 'Ana', 'Ana (nick)'], ['300', 'Bruno']]) });
  await fake.listen(); t.after(() => { rpc.stop(); return fake.close(); });
  rpc.start();
  await until(() => rpc.status().state === 'in-call');
  const st = rpc.status();
  assert.deepEqual([st.call.id, st.call.name, st.call.people.length], ['c1', 'Standup', 3]);
  assert.deepEqual(st.call.people.map((p) => [p.id, p.name, p.self]), [['100', 'Me', true], ['200', 'Ana (nick)', false], ['300', 'Bruno', false]], 'the nickname the call shows wins; the person is marked');
  for (const e of ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP']) assert.ok(fake.subs.has(`${e}:c1`), e);
  // somebody joins, somebody leaves, somebody speaks
  fake.push('VOICE_STATE_CREATE', { user: { id: '400', username: 'carla', global_name: 'Carla' }, nick: null, voice_state: {} });
  await until(() => rpc.status().call.people.length === 4);
  fake.push('VOICE_STATE_DELETE', { user: { id: '300' } });
  await until(() => rpc.status().call.people.length === 3);
  fake.push('SPEAKING_START', { user_id: '200', channel_id: 'c1' });
  fake.push('SPEAKING_STOP', { user_id: '200', channel_id: 'c1' });
  await until(() => events.filter((e) => e[0] === 'speaking').length === 2);
  assert.deepEqual(events.filter((e) => e[0] === 'speaking').map((e) => [e[1].userId, e[1].speaking]), [['200', true], ['200', false]]);
});

test('the call: choosing another channel, or leaving, moves the subscriptions and says the call is over', async (t) => {
  const { fake, rpc, events } = rig({ channel: CHANNEL([['100', 'Me'], ['200', 'Ana']]) });
  await fake.listen(); t.after(() => { rpc.stop(); return fake.close(); });
  rpc.start();
  await until(() => rpc.status().state === 'in-call');
  // the person moves to another channel
  fake.channel = { ...CHANNEL([['100', 'Me'], ['500', 'Dora']]), id: 'c2', name: 'Other' };
  fake.push('VOICE_CHANNEL_SELECT', { channel_id: 'c2', guild_id: 'g1' });
  await until(() => rpc.status().call?.id === 'c2');
  assert.ok(!fake.subs.has('SPEAKING_START:c1') && fake.subs.has('SPEAKING_START:c2'), 'follows only the call the person is in');
  assert.deepEqual(rpc.status().call.people.map((p) => p.name), ['Me', 'Dora']);
  // events of a channel that is not the call are ignored
  fake.push('SPEAKING_START', { user_id: '200', channel_id: 'c1' });
  await wait(30);
  assert.equal(events.filter((e) => e[0] === 'speaking').length, 0);
  // leaves
  fake.channel = null;
  fake.push('VOICE_CHANNEL_SELECT', { channel_id: null, guild_id: null });
  await until(() => rpc.status().state === 'connected');
  assert.equal(rpc.status().call, null);
  assert.deepEqual(events.filter((e) => e[0] === 'call').map((e) => e[1] && e[1].id), ['c1', 'c2', null]);
});

test('not authorised: no token says so; authorising asks Discord, trades the code for a token, saves it and connects', async (t) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: String(init.body) }); return { ok: true, json: async () => ({ access_token: 'tok1', refresh_token: 'ref2' }) }; };
  const { fake, rpc, store } = rig({ tokens: {}, fetch });
  await fake.listen(); t.after(() => { rpc.stop(); return fake.close(); });
  rpc.start();
  await until(() => rpc.status().state === 'not-authorised');
  assert.match(rpc.status().detail, /authoris/i);
  await rpc.authorise();
  assert.equal(rpc.status().state, 'connected');
  assert.equal(store.accessToken, 'tok1');
  assert.equal(store.refreshToken, 'ref2');
  const sent = fake.log.find((f) => f.cmd === 'AUTHORIZE');
  assert.deepEqual([sent.args.client_id, sent.args.scopes], ['app1', ['rpc', 'rpc.voice.read']]);
  assert.match(calls[0].url, /discord\.com\/api\/oauth2\/token$/);
  const form = new URLSearchParams(calls[0].body);
  assert.deepEqual([form.get('grant_type'), form.get('code'), form.get('client_id'), form.get('client_secret')], ['authorization_code', 'the-code', 'app1', 'sec']);
});

test('an expired token is refreshed once; if that does not work either, the person has to authorise again', async (t) => {
  const fetch = async (url, init) => ({ ok: true, json: async () => ({ access_token: 'tok1', refresh_token: 'ref9' }), body: String(init.body) });
  const a = rig({ tokens: { accessToken: 'stale', refreshToken: 'ref1' }, fetch });
  await a.fake.listen(); t.after(() => { a.rpc.stop(); return a.fake.close(); });
  a.rpc.start();
  await until(() => a.rpc.status().state === 'connected');
  assert.equal(a.store.refreshToken, 'ref9');
  const b = rig({ tokens: { accessToken: 'stale', refreshToken: 'ref1' }, fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }) });
  await b.fake.listen(); t.after(() => { b.rpc.stop(); return b.fake.close(); });
  b.rpc.start();
  await until(() => b.rpc.status().state === 'not-authorised');
  assert.equal(b.store.accessToken, '', 'the dead token is forgotten');
});

test('Discord closed or missing: a clear state, and it tries again with a growing pause until Discord appears', async (t) => {
  const { dir, rpc, events } = rig();
  t.after(() => rpc.stop());
  rpc.start();
  await until(() => rpc.status().state === 'closed');
  assert.match(rpc.status().detail, /not running|Discord/i);
  const waits = events.filter((e) => e[0] === 'state' && e[1].retryMs).map((e) => e[1].retryMs);
  await until(() => events.filter((e) => e[0] === 'state' && e[1].retryMs).length >= 3);
  const retries = events.filter((e) => e[0] === 'state' && e[1].retryMs).map((e) => e[1].retryMs);
  assert.deepEqual(retries.slice(0, 3), [20, 40, 40]);
  // Discord starts
  const fake = new FakeDiscord(dir);
  await fake.listen(); t.after(() => fake.close());
  await until(() => rpc.status().state === 'connected');
});

test('Discord quits while connected: it says so and reconnects by itself; stopping and turning it off say nothing is connected', async (t) => {
  const { fake, rpc } = rig({ channel: CHANNEL([['100', 'Me'], ['200', 'Ana']]) });
  await fake.listen(); t.after(() => { rpc.stop(); return fake.close(); });
  rpc.start();
  await until(() => rpc.status().state === 'in-call');
  for (const s of fake.sockets) s.destroy();
  await until(() => rpc.status().state === 'closed');
  assert.equal(rpc.status().call, null);
  await until(() => rpc.status().state === 'in-call');
  rpc.stop();
  assert.equal(rpc.status().state, 'off');
});

test('not set up: without a client id and secret nothing is tried; switched off, nothing is tried', async (t) => {
  const store = { enabled: true, clientId: '', clientSecret: '' };
  const rpc = new DiscordRpc({ getConfig: () => store, saveTokens() {}, env: { XDG_RUNTIME_DIR: tmp() }, platformId: 'linux', backoff: [10] });
  t.after(() => rpc.stop());
  rpc.start();
  assert.equal(rpc.status().state, 'not-set-up');
  store.clientId = 'x'; store.clientSecret = 'y'; store.enabled = false;
  rpc.start();
  assert.equal(rpc.status().state, 'off');
});
