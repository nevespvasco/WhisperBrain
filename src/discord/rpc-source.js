'use strict';
// Discord's local RPC (rpc.js) as a source of meeting signals (src/meet/protocol.js), platform 'discord'. Nobody joins the call.
// Here: its state, and the call as a `meeting` message, so the meeting detector knows exactly when a Discord call starts and
// ends instead of guessing it from the app's sound. It also tells who is in the call (roster) and who speaks (speaker), in the
// protocol of the other sources, so the name vote after Stop is the one every platform uses. One person speaking is named; nobody,
// only the person themself (their voice is the microphone's) or several at once name nobody, so a highlight never merges two voices.
// When the bot is in the same call it steps aside (the bot hears each person on their own stream, which is strictly better): the
// call is still told, the names and speaking are not.
const SOURCE = 'discord-rpc';
const PLATFORM = 'discord';
const HEARTBEAT_MS = 10000;   // while a call goes on the hub is told again now and then, as the other sources do

const defaultEvery = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return { stop: () => clearInterval(t) }; };

const STATE = { closed: 'waiting', connecting: 'waiting', 'not-authorised': 'needs-setup', 'not-set-up': 'needs-setup', connected: 'connected', 'in-call': 'connected', off: 'off' };

class DiscordRpcSource {
  // rpc: a DiscordRpc (or a stand-in). bot() -> { joined, channelId } | null says where the Discord bot is (src/discord/bot.js).
  // every(fn, ms) -> { stop() } is replaceable for tests.
  constructor({ hub, rpc, bot = () => null, every = defaultEvery }) {
    Object.assign(this, { hub, rpc, bot, every });
    this.beat = null;
    this.call = null;
    this.speaking = new Set();   // Discord user ids speaking now
    this.names = new Map();      // user id -> the name the call shows
    this.who = undefined;        // the last speaker told (a name, or null for nobody)
    this.on = { state: (s) => this.onState(s), call: (c) => this.onCall(c), roster: (r) => this.onRoster(r), speaking: (e) => this.onSpeaking(e) };
  }

  report(state, detail = '') { this.hub.report(SOURCE, { kind: 'rpc', platform: PLATFORM, state, detail }); }

  start() {
    this.rpc.on('state', this.on.state);
    this.rpc.on('call', this.on.call);
    this.rpc.on('roster', this.on.roster);
    this.rpc.on('speaking', this.on.speaking);
    this.onState(this.rpc.status());
  }

  stop() {
    this.rpc.off('state', this.on.state);
    this.rpc.off('call', this.on.call);
    this.rpc.off('roster', this.on.roster);
    this.rpc.off('speaking', this.on.speaking);
    if (this.call) this.onCall(null);
    this.report('off');
  }

  onState({ state, detail }) {
    const call = this.rpc.status().call;
    this.report(STATE[state] || 'waiting', state === 'in-call' && call ? `In the call “${call.name || 'voice channel'}”` : detail || '');
  }

  tell(m) { try { this.hub.ingest({ ...m, platform: PLATFORM }, { source: SOURCE, kind: 'rpc' }); } catch { /* the hub refuses nonsense; this is none */ } }

  // the bot is in this very call: it hears every person on their own stream, which is strictly better than a highlight
  aside() { const b = this.bot(); return !!(b && b.joined && this.call && b.channelId === this.call.id); }

  onRoster(people) {
    if (!this.call) return;
    this.names = new Map(people.map((p) => [p.id, p.name]));
    // somebody who left the call, or muted, is not speaking, whether or not Discord sent the SPEAKING_STOP: one stale id kept
    // "two people at once" true for the rest of a call, and nobody was named after its first 23 seconds
    const here = new Set(people.filter((p) => !p.muted).map((p) => p.id));
    const before = this.speaking.size;
    for (const id of this.speaking) if (!here.has(id)) this.speaking.delete(id);
    if (this.aside()) return;
    this.tell({ type: 'roster', participants: people.map((p) => ({ name: p.name, id: p.id, self: !!p.self })) });
    if (this.speaking.size !== before) this.retell();
  }

  onSpeaking({ userId, speaking }) {
    if (!this.call) return;
    if (speaking) this.speaking.add(userId); else this.speaking.delete(userId);
    if (this.aside()) return;
    this.retell();
  }

  // tell who speaks now, when it changed: one other person, or nobody
  retell() {
    const me = this.rpc.status().user?.id;
    const others = [...this.speaking].filter((id) => id !== me);
    const id = others.length === 1 ? others[0] : null;
    const name = id ? this.names.get(id) || null : null;
    if (name === this.who || (this.who === undefined && !name)) return;
    this.who = name;
    this.tell({ type: 'speaker', name, id: name ? id : '' });
  }

  say(inCall, call) {
    const m = inCall ? { type: 'meeting', inCall: true, code: call.id, title: call.name || '' } : { type: 'meeting', inCall: false, code: '', title: '' };
    this.tell(m);
  }

  onCall(call) {
    this.beat?.stop(); this.beat = null;
    if (this.who && !this.aside()) this.tell({ type: 'speaker', name: null });
    this.speaking.clear(); this.names.clear(); this.who = undefined;
    this.call = call;
    if (call) {
      this.say(true, call);
      this.beat = this.every(() => { if (this.call) this.say(true, this.call); }, HEARTBEAT_MS);
    } else this.say(false);
  }
}

module.exports = { DiscordRpcSource, SOURCE, PLATFORM };
