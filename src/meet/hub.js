'use strict';
// Where every source of meeting signals meets (see protocol.js). Sources call ingest(); the recording in progress
// listens. The hub also keeps a short-lived picture of each source (connected, last heard, what it needs) for Settings,
// and of whether a call is going on, which the meeting detector can use.
const { EventEmitter } = require('node:events');
const { normalizeSignal } = require('./protocol');
const { PLATFORMS } = require('./platforms');

// how long after a voice starts the source shows it: the generic lag of each kind; a platform's own (platforms.js) wins
const LAG_MS = { extension: 300, a11y: 500, vision: 1500, captions: 0, rpc: 150 };
const STALE_MS = 20000;                                                     // a source not heard from for this long is not "connected"

class SignalHub extends EventEmitter {
  constructor({ now = () => Date.now(), platforms = PLATFORMS } = {}) {
    super();
    this.now = now;
    this.platforms = platforms;
    this.sources = new Map();  // id -> { id, kind, state, detail, lastAt, messages, platforms: { platform: messages } }
    this.calls = new Map();    // platform -> the call it says is going on: { inCall, code, title, source, kind, platform, at, exact }
    this.meeting = null;       // { inCall, code, title, source, platform, at } the latest word about a call
  }

  // kind: 'extension' | 'a11y' | 'vision' | 'captions' | 'rpc' (sets the default lag). platform: the one a source serves alone (rpc). state: 'connected' | 'waiting' | 'off' | 'error' | 'denied'
  report(id, { kind = id, state, detail = '', platform = undefined } = {}) {
    const s = this.sources.get(id) || { id, kind, state: 'off', detail: '', lastAt: 0, messages: 0, platforms: {} };
    const changed = !this.sources.has(id) || (state && state !== s.state) || detail !== s.detail || kind !== s.kind;
    s.kind = kind;
    if (platform !== undefined) s.platform = platform;
    if (state) s.state = state;
    s.detail = detail;
    this.sources.set(id, s);
    if (changed) this.emit('source', { ...s });
    return s;
  }

  // msg: a protocol message (a plain object); throws SignalError for nonsense.
  ingest(msg, { source = 'extension', kind = null, lagMs = null } = {}) {
    const m = normalizeSignal(msg);
    const k = kind || this.sources.get(source)?.kind || source;
    const s = this.sources.get(source) || this.report(source, { kind: k, state: 'connected' });
    s.lastAt = this.now();
    s.messages++;
    s.platforms[m.platform] = (s.platforms[m.platform] || 0) + 1;
    if (s.state !== 'connected') this.report(source, { kind: s.kind, state: 'connected' });
    if (m.type === 'meeting') {
      this.meeting = { inCall: m.inCall, code: m.code, title: m.title, source, platform: m.platform, at: s.lastAt };
      if (m.inCall) this.calls.set(m.platform, { ...this.meeting, kind: k, exact: k === 'rpc' }); else this.calls.delete(m.platform);
      this.emit('meeting', { ...this.meeting });
    }
    this.emit('signal', { msg: m, source, kind: k, platform: m.platform, lagMs: lagMs ?? this.platforms.lag(m.platform, k) ?? LAG_MS[k] ?? 500, at: s.lastAt });
    return m;
  }

  // The sources as Settings shows them. A source that has gone quiet is "waiting", not "connected".
  status() {
    const t = this.now();
    const fresh = (x) => t - x.at <= STALE_MS * 3;
    const sources = [...this.sources.values()];
    return {
      // a source that only reports changes (rpc) is never "quiet"; the others are, when they stop sending
      sources: sources.map((s) => ({ ...s, state: s.state === 'connected' && s.kind !== 'rpc' && t - s.lastAt > STALE_MS ? 'waiting' : s.state })),
      meeting: this.meeting && fresh(this.meeting) ? { ...this.meeting } : null,
      // every call some source says is going on (one per platform)
      calls: [...this.calls.values()].filter(fresh).map((c) => ({ ...c })),
      // platforms whose own app says exactly what is going on: what other sources only guess is not believed for them
      authoritative: [...new Set(sources.filter((s) => s.kind === 'rpc' && s.state === 'connected' && s.platform).map((s) => s.platform))],
    };
  }

  // true when some source has been heard from lately: other, weaker sources (the screen reader) should stay idle
  anyConnected(except = []) {
    const t = this.now();
    return [...this.sources.values()].some((s) => !except.includes(s.id) && s.state === 'connected' && t - s.lastAt <= STALE_MS);
  }
}

module.exports = { SignalHub, LAG_MS };
