'use strict';
// Where every source of meeting signals meets (see protocol.js). Sources call ingest(); the recording in progress
// listens. The hub also keeps a short-lived picture of each source (connected, last heard, what it needs) for Settings,
// and of whether a call is going on, which the meeting detector can use.
const { EventEmitter } = require('node:events');
const { normalize } = require('./protocol');

const LAG_MS = { extension: 300, a11y: 500, vision: 1500, captions: 0 };  // how long after a voice starts the source shows it
const STALE_MS = 20000;                                                     // a source not heard from for this long is not "connected"

class SignalHub extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.sources = new Map();  // id -> { id, kind, state, detail, lastAt, messages }
    this.meeting = null;       // { inCall, code, title, source, at } the latest word about a call
  }

  // kind: 'extension' | 'a11y' | 'vision' | 'captions' (sets the default lag). state: 'connected' | 'waiting' | 'off' | 'error' | 'denied'
  report(id, { kind = id, state, detail = '' } = {}) {
    const s = this.sources.get(id) || { id, kind, state: 'off', detail: '', lastAt: 0, messages: 0 };
    const changed = !this.sources.has(id) || (state && state !== s.state) || detail !== s.detail || kind !== s.kind;
    s.kind = kind;
    if (state) s.state = state;
    s.detail = detail;
    this.sources.set(id, s);
    if (changed) this.emit('source', { ...s });
    return s;
  }

  // msg: a protocol message (a plain object); throws SignalError for nonsense.
  ingest(msg, { source = 'extension', kind = null, lagMs = null } = {}) {
    const m = normalize(msg);
    const k = kind || this.sources.get(source)?.kind || source;
    const s = this.sources.get(source) || this.report(source, { kind: k, state: 'connected' });
    s.lastAt = this.now();
    s.messages++;
    if (s.state !== 'connected') this.report(source, { kind: s.kind, state: 'connected' });
    if (m.type === 'meeting') {
      this.meeting = { inCall: m.inCall, code: m.code, title: m.title, source, at: s.lastAt };
      this.emit('meeting', { ...this.meeting });
    }
    this.emit('signal', { msg: m, source, kind: k, lagMs: lagMs ?? LAG_MS[k] ?? 500, at: s.lastAt });
    return m;
  }

  // The sources as Settings shows them. A source that has gone quiet is "waiting", not "connected".
  status() {
    const t = this.now();
    return {
      sources: [...this.sources.values()].map((s) => ({ ...s, state: s.state === 'connected' && t - s.lastAt > STALE_MS ? 'waiting' : s.state })),
      meeting: this.meeting && t - this.meeting.at <= STALE_MS * 3 ? { ...this.meeting } : null,
    };
  }

  // true when some source has been heard from lately: other, weaker sources (the screen reader) should stay idle
  anyConnected(except = []) {
    const t = this.now();
    return [...this.sources.values()].some((s) => !except.includes(s.id) && s.state === 'connected' && t - s.lastAt <= STALE_MS);
  }
}

module.exports = { SignalHub, LAG_MS };
