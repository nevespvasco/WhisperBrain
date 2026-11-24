'use strict';
// A Discord bot that sits in the voice channel you are in and hears every person on their own audio stream.
//
// Why: what the computer plays back is one mixed stream, so overlapping voices cannot be separated. Discord hands a bot
// each speaker separately (and says who it is), which gives the transcript exact speakers and clean overlaps.
//
// Calls are end-to-end encrypted (DAVE). @discordjs/voice negotiates it and decrypts what it receives, using @snazzah/davey;
// status().dave reports the protocol version once the call is encrypted, and a probe() that hears nobody says so.
const { EventEmitter } = require('node:events');
const { OpusDecoder, Coalescer } = require('./audio');

const CHUNK_MS = 100;        // audio is handed on in chunks of about this size
const SILENCE_MS = 1200;     // a person's stream ends after this much silence; it is opened again when they speak
const JOIN_TIMEOUT_MS = 20000;
const INVITE_PERMISSIONS = 1049600; // View Channel (1 << 10) + Connect (1 << 20)

const DEFAULT_LIBS = () => ({ discord: require('discord.js'), voice: require('@discordjs/voice'), OpusScript: require('opusscript') });

const err = (message, code) => Object.assign(new Error(message), { code });

// Emits 'audio' { userId, name, pcm (16 kHz mono s16le), ts (ms epoch of the end of the chunk) } and 'state' { state }.
class DiscordVoice extends EventEmitter {
  // getConfig: () => { enabled, token, userId, guildId, channelId }. libs: injectable for tests.
  constructor({ getConfig, libs = null } = {}) {
    super();
    this.getConfig = getConfig;
    this.loadLibs = libs ? () => libs : DEFAULT_LIBS;
    this.client = null;
    this.clientToken = null;
    this.session = null; // { connection, guild, channel, streams: Map, names: Map, packets, heard: Set }
  }

  static inviteUrl(clientId) { return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${INVITE_PERMISSIONS}`; }

  libs() {
    if (!this._libs) {
      try { this._libs = this.loadLibs(); } catch (e) { throw err(`The Discord libraries are not installed (${e.message}). Run npm install.`, 'no-libs'); }
    }
    return this._libs;
  }

  get configured() { const c = this.getConfig(); return !!(c.enabled && c.token); }

  // The logged-in client, reused while the token stays the same.
  async login() {
    const { token } = this.getConfig();
    if (!token) throw err('Add the bot token first (Integrations → Discord).', 'not-configured');
    if (this.client && this.clientToken === token) return this.client;
    await this.logout();
    const { discord } = this.libs();
    const { Client, GatewayIntentBits } = discord;
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] }); // neither is a privileged intent
    client.on('error', (e) => this.emit('warning', { message: `Discord: ${e.message}` }));
    try {
      await Promise.race([
        new Promise((resolve, reject) => { client.once('clientReady', resolve); client.once('ready', resolve); client.login(token).catch(reject); }),
        new Promise((_, reject) => setTimeout(() => reject(err('Discord did not answer in time.', 'timeout')), JOIN_TIMEOUT_MS)),
      ]);
    } catch (e) {
      try { await client.destroy(); } catch { /* never connected */ }
      if (/token|invalid|disallowed/i.test(e.message)) throw err('Discord rejected the bot token. Copy it again from the Developer Portal (Bot → Reset Token).', 'bad-token');
      throw e;
    }
    this.client = client;
    this.clientToken = token;
    return client;
  }

  async logout() {
    this.leave();
    const c = this.client;
    this.client = null;
    this.clientToken = null;
    if (c) { try { await c.destroy(); } catch { /* gone */ } }
  }

  // Where the bot would go: the channel set in settings, else the voice channel `userId` is in right now.
  findChannel(client) {
    const cfg = this.getConfig();
    if (cfg.channelId) {
      const ch = client.channels.cache.get(cfg.channelId);
      if (!ch?.isVoiceBased?.()) throw err('The voice channel set in Integrations → Discord is not visible to the bot. Is it on a server the bot was added to?', 'no-channel');
      return ch;
    }
    if (!cfg.userId) throw err('Add your Discord user ID so the bot can find the call you are in (Integrations → Discord).', 'no-user');
    const guilds = cfg.guildId ? [client.guilds.cache.get(cfg.guildId)].filter(Boolean) : [...client.guilds.cache.values()];
    for (const g of guilds) {
      const id = g.voiceStates.cache.get(cfg.userId)?.channelId;
      const ch = id && g.channels.cache.get(id);
      if (ch) return ch;
    }
    return null;
  }

  // Joins the call. -> { guild, channel } or null when you are not in a voice channel on a server the bot is in.
  async join({ skipUserIds = [], timeoutMs = JOIN_TIMEOUT_MS } = {}) {
    const client = await this.login();
    const channel = this.findChannel(client);
    if (!channel) return null;
    if (this.session?.channel.id === channel.id) { this.session.skip = new Set(skipUserIds); return this.info(); }
    this.leave();
    const { voice } = this.libs();
    const connection = voice.joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: true, daveEncryption: true });
    const s = this.session = { connection, guild: channel.guild, channel, streams: new Map(), names: new Map(), packets: 0, dropped: 0, heard: new Set(), skip: new Set(skipUserIds), debug: [], left: false };
    connection.on('debug', (m) => { s.debug = [...s.debug.slice(-19), String(m)]; });
    try {
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, timeoutMs);
    } catch {
      this.leave();
      throw err(`The bot could not join "${channel.name}". Check that it has the View Channel and Connect permissions there.`, 'join-failed');
    }
    // a dropped connection tries to resume by itself; if it cannot, the call is over for us
    connection.on(voice.VoiceConnectionStatus.Disconnected, async () => {
      try { await Promise.race([voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5000), voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5000)]); }
      catch { if (this.session === s) { this.emit('state', { state: 'left' }); this.leave(); } }
    });
    connection.receiver.speaking.on('start', (userId) => this.listen(s, userId));
    this.emit('state', { state: 'joined', ...this.info() });
    return this.info();
  }

  info() {
    const s = this.session;
    return s ? { guildName: s.guild.name, channelName: s.channel.name, channelId: s.channel.id } : null;
  }

  // Everything worth showing about the call right now.
  status() {
    const s = this.session;
    if (!s) return { joined: false };
    return { joined: true, ...this.info(), dave: this.daveVersion(s), packets: s.packets, dropped: s.dropped, heard: [...s.heard].map((id) => ({ id, name: s.names.get(id)?.name || null })) };
  }

  // DAVE protocol version in use (0 = the call is not end-to-end encrypted). Reads the library's internals, hence best effort.
  daveVersion(s = this.session) {
    try { return s?.connection?.state?.networking?.state?.dave?.protocolVersion ?? null; } catch { return null; }
  }

  // -> { name, bot }. A person we cannot look up (left already, no access) still gets a usable label.
  async nameOf(s, userId) {
    if (s.names.has(userId)) return s.names.get(userId);
    let who = null;
    try { const m = await s.guild.members.fetch(userId); who = { name: m.displayName || m.user.globalName || m.user.username, bot: !!m.user.bot }; } catch { /* left already, or no access */ }
    if (!who) { try { const u = await this.client.users.fetch(userId); who = { name: u.globalName || u.username, bot: !!u.bot }; } catch { /* unknown */ } }
    who = who || { name: `Discord user ${String(userId).slice(-4)}`, bot: false };
    s.names.set(userId, who);
    return who;
  }

  async listen(s, userId) {
    if (this.session !== s || s.streams.has(userId) || s.skip.has(userId) || userId === this.client?.user?.id) return;
    s.streams.set(userId, null); // claim the slot before the name lookup
    const who = await this.nameOf(s, userId);
    if (this.session !== s) return;
    if (who.bot) return; // music bots and the like are not transcribed (the slot stays claimed so they are not looked up again)
    const { voice, OpusScript } = this.libs();
    const stream = s.connection.receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    const decoder = new OpusDecoder(OpusScript);
    const out = new Coalescer(CHUNK_MS, (pcm) => this.emit('audio', { userId, name: who.name, pcm, ts: Date.now() }));
    s.streams.set(userId, stream);
    const finish = () => { out.flush(); decoder.destroy(); if (s.streams.get(userId) === stream) s.streams.delete(userId); };
    stream.on('data', (packet) => {
      s.packets++;
      s.heard.add(userId);
      const pcm = decoder.decode(packet);
      if (pcm) out.push(pcm); else s.dropped++;
    });
    stream.once('end', finish);
    stream.once('error', (e) => { this.emit('warning', { message: `Discord audio from ${who.name}: ${e.message}` }); finish(); });
  }

  leave() {
    const s = this.session;
    this.session = null;
    if (!s) return;
    s.left = true;
    for (const st of s.streams.values()) { try { st?.destroy(); } catch { /* ended */ } }
    try { s.connection.destroy(); } catch { /* already gone */ }
  }

  // Settings → "Test": log in, report who the bot is and where it would join, then listen for a few seconds so that the
  // user can speak and see that audio really arrives (this is the DAVE check on a live call).
  async probe({ seconds = 8 } = {}) {
    if (this.session) throw err('The bot is already in a call (a recording is running).', 'busy');
    const client = await this.login();
    const me = client.user;
    const out = { ok: true, bot: { id: me.id, name: me.username }, inviteUrl: DiscordVoice.inviteUrl(me.id), servers: [...client.guilds.cache.values()].map((g) => g.name), call: null };
    const channel = this.findChannel(client);
    if (!channel) { out.note = client.guilds.cache.size ? 'You are not in a voice channel on a server the bot is in. Join a voice channel and test again.' : 'The bot is not on any server yet. Open the invite link to add it.'; return out; }
    const own = this.getConfig().userId;
    const info = await this.join();
    out.call = { server: info.guildName, channel: info.channelName };
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const st = this.status();
    out.call = { ...out.call, dave: st.dave, packets: st.packets, dropped: st.dropped, heard: st.heard.map((h) => h.name || h.id), you: !!own && st.heard.some((h) => h.id === own) };
    this.leave();
    out.verdict = !st.packets ? 'Joined, but no audio arrived. Ask someone (or yourself) to talk during the test.'
      : st.dropped > st.packets / 2 ? 'Audio arrives but most of it could not be decoded.' : 'Audio arrives and decodes: the bot works on this call.';
    return out;
  }
}

module.exports = { DiscordVoice, INVITE_PERMISSIONS };
