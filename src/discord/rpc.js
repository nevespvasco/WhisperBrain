'use strict';
// Discord without a bot: the local RPC of the Discord desktop app.
//
// The app listens on a socket only this computer can reach (discord-ipc-0..9). An application the person authorises (their own,
// made in the developer portal) can ask it which voice call the person is in, who is in that call, and when each of them starts and
// stops speaking. Nobody joins the call and nobody else sees anything. It gives NO audio per person.
//
// Limits (also said in Settings and in docs/discord-rpc.md): until Discord approves an application only its testers (up to 50)
// can use it, and the person is a tester of their own; Discord recommends its Social SDK for new projects and RPC over IPC is not
// guaranteed to last; RPC over WebSocket is deprecated and is NOT used here.
// Not built, on purpose: using the person's own account token (a selfbot), client mods, reading the Discord window.
//
// Emits 'state' { state, detail, retryMs? }, 'call' { id, name, ... } | null, 'roster' [person], 'speaking' { userId, speaking }.
const { EventEmitter } = require('node:events');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const SCOPES = ['rpc', 'rpc.voice.read'];
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REDIRECT = 'http://localhost';   // what the person registers under OAuth2 → Redirects in their application
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const REQUEST_MS = 10000;
const AUTHORISE_MS = 120000;           // the person has to press a button in Discord

const encode = (op, payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0); head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

// Turns the bytes of a socket into frames { op, data }, whatever the way they were cut.
class Decoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0), len = this.buf.readInt32LE(4);
      if (len < 0 || len > 1 << 20) { this.buf = Buffer.alloc(0); throw new Error('bad frame from Discord'); }
      if (this.buf.length < 8 + len) break;
      let data = null;
      try { data = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch { /* a frame that is not JSON says nothing */ }
      this.buf = this.buf.subarray(8 + len);
      out.push({ op, data });
    }
    return out;
  }
}

// Where Discord's sockets may be, in order. Linux/macOS: the runtime or temp folders (and where a Flatpak or a snap puts it);
// Windows: a named pipe.
function socketPaths(platformId, env = process.env) {
  const out = [];
  if (platformId === 'win32') {
    for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return out;
  }
  const xdg = env.XDG_RUNTIME_DIR;
  const dirs = [xdg, xdg && platformId === 'linux' && path.join(xdg, 'app/com.discordapp.Discord'), xdg && platformId === 'linux' && path.join(xdg, 'snap.discord'), env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean);
  for (const d of [...new Set(dirs)]) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

// vs: the person's voice state ({ mute, self_mute, suppress, ... }): muted people cannot be speaking (rpc-source.js drops them)
const person = (u, nick, vs) => ({ id: String(u.id), name: nick || u.global_name || u.username || String(u.id), username: u.username || '', muted: !!(vs && (vs.self_mute || vs.mute || vs.suppress)) });

class DiscordRpc extends EventEmitter {
  // getConfig() -> { enabled, clientId, clientSecret, accessToken, refreshToken }. saveTokens({ accessToken, refreshToken }).
  // connect(path) -> net.Socket is replaceable for tests; env/platformId say where to look; backoff: the pauses between tries.
  constructor({ getConfig, saveTokens = () => {}, env = process.env, platformId = process.platform, backoff = BACKOFF_MS, fetch = globalThis.fetch, requestMs = REQUEST_MS } = {}) {
    super();
    Object.assign(this, { getConfig, saveTokens, env, platformId, backoff, fetch, requestMs });
    this.running = false;
    this.sock = null;
    this.pending = new Map();
    this.timer = null;
    this.failures = 0;
    this.s = { state: 'off', detail: '', call: null, user: null };
    this.people = new Map();
    this.subscribed = new Set();
  }

  status() {
    const c = this.s.call;
    return { state: this.s.state, detail: this.s.detail, user: this.s.user, call: c ? { ...c, people: this.roster() } : null, ready: this.ready };
  }

  get ready() { const c = this.getConfig(); return !!(c.clientId && c.clientSecret); }

  set(state, detail = '', extra = {}) {
    this.s.state = state; this.s.detail = detail;
    this.emit('state', { state, detail, ...extra });
  }

  // ---- lifecycle ----
  start() {
    this.stop(true);
    const c = this.getConfig();
    if (!c.enabled) return this.set('off', '');
    if (!this.ready) return this.set('not-set-up', 'Add the client id and secret of your Discord application first.');
    this.running = true;
    this.failures = 0;
    this.open();
  }

  stop(quiet = false) {
    this.running = false;
    clearTimeout(this.timer); this.timer = null;
    this.drop();
    if (!quiet) this.set('off', '');
  }

  // closes the socket and forgets the call, telling the others it is over
  drop() {
    const s = this.sock;
    this.sock = null;
    if (s) { s.removeAllListeners('close'); s.removeAllListeners('data'); try { s.destroy(); } catch { /* gone */ } }
    for (const [, p] of this.pending) p.reject(new Error('Discord closed the connection'));
    this.pending.clear();
    this.leaveCall();
    this.subscribed.clear();
    this.s.user = null;
  }

  retry(state, detail) {
    this.drop();
    if (!this.running) return;
    const wait = this.backoff[Math.min(this.failures, this.backoff.length - 1)];
    this.failures++;
    this.set(state, detail, { retryMs: wait });
    this.timer = setTimeout(() => { this.timer = null; this.open(); }, wait);
    this.timer.unref?.();
  }

  // ---- the socket ----
  async findSocket() {
    for (const p of socketPaths(this.platformId, this.env)) {
      const s = await new Promise((resolve) => {
        const c = net.connect(p);
        c.once('connect', () => { c.removeAllListeners('error'); resolve(c); });
        c.once('error', () => { c.destroy(); resolve(null); });
      });
      if (s) return s;
    }
    return null;
  }

  async open() {
    if (!this.running) return;
    this.set('connecting', 'Looking for the Discord app…');
    const sock = await this.findSocket();
    if (!this.running) { sock?.destroy(); return; }
    if (!sock) return this.retry('closed', 'The Discord app is not running (or its local connection is not available).');
    this.sock = sock;
    const dec = new Decoder();
    sock.on('data', (d) => { try { for (const f of dec.push(d)) this.onFrame(f); } catch (e) { this.retry('closed', e.message); } });
    sock.on('error', () => {});
    sock.on('close', () => { if (this.sock === sock && this.running) this.retry('closed', 'Discord closed the connection.'); });
    try {
      const ready = await this.handshake();
      this.failures = 0;
      this.s.user = ready?.user ? person(ready.user) : null;
      await this.authenticateSaved();
    } catch (e) {
      if (this.sock === sock && this.running) this.retry('closed', e.message);
    }
  }

  handshake() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Discord did not answer.')), this.requestMs);
      this.pending.set('READY', { resolve: (d) => { clearTimeout(timer); resolve(d); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.getConfig().clientId }));
    });
  }

  request(cmd, args = {}, evt, ms = this.requestMs) {
    if (!this.sock) return Promise.reject(new Error('not connected to Discord'));
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(nonce); reject(new Error(`Discord did not answer ${cmd}.`)); }, ms);
      this.pending.set(nonce, { resolve: (d) => { clearTimeout(timer); resolve(d); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sock.write(encode(OP.FRAME, { cmd, args, nonce, ...(evt ? { evt } : {}) }));
    });
  }

  onFrame({ op, data }) {
    if (op === OP.PING) return void this.sock?.write(encode(OP.PONG, data));
    if (op === OP.CLOSE) return this.retry('closed', `Discord closed the connection${data?.message ? `: ${data.message}` : '.'}`);
    if (!data) return;
    if (data.cmd === 'DISPATCH') {
      if (data.evt === 'READY') { const p = this.pending.get('READY'); if (p) { this.pending.delete('READY'); p.resolve(data.data); } return; }
      return this.onEvent(data.evt, data.data);
    }
    const p = this.pending.get(data.nonce);
    if (!p) return;
    this.pending.delete(data.nonce);
    if (data.evt === 'ERROR') p.reject(Object.assign(new Error(data.data?.message || 'Discord refused'), { code: data.data?.code }));
    else p.resolve(data.data);
  }

  // ---- authorisation ----
  async tokenCall(params) {
    const c = this.getConfig();
    const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params });
    const r = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `Discord refused the token request (${r.status})`);
    this.saveTokens({ accessToken: j.access_token, refreshToken: j.refresh_token || '' });
    return j.access_token;
  }

  async authenticate(token) {
    const r = await this.request('AUTHENTICATE', { access_token: token });
    if (r?.user) this.s.user = person(r.user);
    this.failures = 0;
    this.set('connected', '');
    await this.follow();
  }

  // The token the person saved, refreshed once when it is no good; else they have to authorise again.
  async authenticateSaved() {
    const c = this.getConfig();
    if (c.accessToken) {
      try { return await this.authenticate(c.accessToken); } catch (e) { if (!/token|authent|401|4009/i.test(`${e.message} ${e.code}`)) throw e; }
      if (c.refreshToken) {
        try { return await this.authenticate(await this.tokenCall({ grant_type: 'refresh_token', refresh_token: c.refreshToken })); } catch { /* the refresh did not work either */ }
      }
      this.saveTokens({ accessToken: '', refreshToken: '' });
    }
    this.set('not-authorised', 'Authorise WhisperBrain in the Discord app (Settings → Integrations → Discord).');
  }

  // The person presses "Authorise" in Settings; Discord shows a prompt in its own window, and answers when they accept.
  async authorise() {
    if (!this.sock || this.s.state === 'closed' || this.s.state === 'connecting') throw new Error('The Discord app is not running.');
    const c = this.getConfig();
    this.set('not-authorised', 'Waiting for you to accept in the Discord app…');
    const r = await this.request('AUTHORIZE', { client_id: c.clientId, scopes: SCOPES }, undefined, AUTHORISE_MS);
    const token = await this.tokenCall({ grant_type: 'authorization_code', code: r.code, redirect_uri: REDIRECT });
    await this.authenticate(token);
  }

  // ---- the call ----
  sub(evt, args) { const k = `${evt}:${args?.channel_id || ''}`; if (this.subscribed.has(k)) return Promise.resolve(); this.subscribed.add(k); return this.request('SUBSCRIBE', args || {}, evt).catch(() => this.subscribed.delete(k)); }
  unsub(evt, args) { const k = `${evt}:${args?.channel_id || ''}`; if (!this.subscribed.delete(k)) return Promise.resolve(); return this.request('UNSUBSCRIBE', args || {}, evt).catch(() => {}); }

  async follow() {
    await this.sub('VOICE_CHANNEL_SELECT');
    this.enter(await this.request('GET_SELECTED_VOICE_CHANNEL'));
  }

  // channel: what GET_SELECTED_VOICE_CHANNEL says (null: not in a voice call)
  async enter(channel) {
    const id = channel?.id ? String(channel.id) : null;
    if (id === (this.s.call?.id || null)) return;
    const old = this.s.call?.id;
    if (old) for (const e of ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP']) await this.unsub(e, { channel_id: old });
    this.people.clear();
    if (!id) { this.leaveCall(); this.set('connected', ''); return; }
    this.s.call = { id, name: channel.name || '', guildId: channel.guild_id ? String(channel.guild_id) : null, type: channel.type ?? null };
    for (const vs of channel.voice_states || []) if (vs?.user) this.people.set(String(vs.user.id), person(vs.user, vs.nick, vs.voice_state));
    for (const e of ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP']) await this.sub(e, { channel_id: id });
    this.set('in-call', '');
    this.emit('call', { ...this.s.call });
    this.emitRoster();
  }

  leaveCall() {
    if (!this.s.call) return;
    this.s.call = null;
    this.people.clear();
    this.emit('call', null);
  }

  // the people in the call; the person themself (the authorised account) is marked: their voice is the microphone's
  roster() { return [...this.people.values()].map((p) => ({ ...p, self: p.id === this.s.user?.id })); }
  emitRoster() { this.emit('roster', this.roster()); }

  onEvent(evt, d = {}) {
    if (evt === 'VOICE_CHANNEL_SELECT') {
      // the call is whatever the person selected now; ask, so the people come with it
      return void this.request('GET_SELECTED_VOICE_CHANNEL').then((c) => this.enter(c)).catch(() => {});
    }
    const call = this.s.call;
    if (!call) return;
    if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE') {
      if (d.user) { this.people.set(String(d.user.id), person(d.user, d.nick, d.voice_state)); this.emitRoster(); }
    } else if (evt === 'VOICE_STATE_DELETE') {
      if (d.user && this.people.delete(String(d.user.id))) this.emitRoster();
    } else if (evt === 'SPEAKING_START' || evt === 'SPEAKING_STOP') {
      if (d.channel_id && String(d.channel_id) !== call.id) return; // another channel's speakers never count
      this.emit('speaking', { userId: String(d.user_id), speaking: evt === 'SPEAKING_START', self: String(d.user_id) === this.s.user?.id });
    }
  }
}

module.exports = { DiscordRpc, socketPaths, encode, Decoder, OP, SCOPES, TOKEN_URL, REDIRECT };
