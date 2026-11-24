'use strict';
// What one recording learns from the meeting window: who was highlighted when, who is on the call, the captions.
// Created when a recording starts, asked at the end (names for the voices, how many voices to expect).
const { nameKey } = require('./protocol');
const { activeIntervals, speechOf, nameSpeakers, remoteHeadCount } = require('./names');
const { alignCaptions, mergeIntervals } = require('./captions');

const MAX_EVENTS = 20000;   // an hour of a lively call is a few thousand highlights

class MeetingCollector {
  // hub: SignalHub. elapsed(): the recording's timeline now, ms. paused(): true while the recording is paused.
  // selfNames(): names that are the user (settings, calendar).
  // useCaptions: also match the meeting's live captions with the transcript (see captions.js)
  constructor({ hub, elapsed, paused = () => false, selfNames = () => [], originMs = 0, useCaptions = true }) {
    Object.assign(this, { hub, elapsed, paused, selfNames, originMs, useCaptions });
    this.events = new Map();     // source -> [{ t, name, lagMs }]
    this.rosters = new Map();    // source -> { t, participants }
    this.captions = [];          // [{ t, name, text, final, lagMs }]
    this.selfKeys = new Set();   // names the sources marked as the user
    this.listener = (s) => this.on(s);
    hub.on('signal', this.listener);
  }

  detach() { this.hub.off('signal', this.listener); }

  on({ msg, source, lagMs }) {
    if (this.paused()) return;
    const t = this.elapsed();
    if (msg.type === 'speaker') {
      if (msg.self && msg.name) this.selfKeys.add(nameKey(msg.name));
      const list = this.events.get(source) || [];
      if (list.length < MAX_EVENTS) { list.push({ t, name: msg.self ? null : msg.name, lagMs }); this.events.set(source, list); }
    } else if (msg.type === 'roster') {
      for (const p of msg.participants) if (p.self && p.name) this.selfKeys.add(nameKey(p.name));
      this.rosters.set(source, { t, participants: msg.participants });
    } else if (msg.type === 'caption') {
      if (msg.self && msg.name) this.selfKeys.add(nameKey(msg.name));
      if (this.captions.length < MAX_EVENTS) this.captions.push({ t, name: msg.self ? null : msg.name, text: msg.text, final: msg.final, lagMs });
    }
  }

  get userKeys() {
    return [...new Set([...this.selfKeys, ...this.selfNames().map(nameKey).filter(Boolean)])];
  }

  // the people on the call, from the source that reported last
  roster() {
    let best = null;
    for (const r of this.rosters.values()) if (!best || r.t > best.t) best = r;
    return best?.participants || null;
  }

  // How many other voices to expect on the system audio, or null (no roster, or a call too big to say). See names.js.
  expectedVoices({ max = 6 } = {}) {
    return remoteHeadCount(this.roster(), { max, selfKeys: this.userKeys });
  }

  // The highlight intervals of the source that was highlighting longest (the sources are not mixed: their clocks and
  // lags differ, and when two are connected they say the same thing).
  intervals(endMs) {
    let best = [], bestMs = 0;
    for (const [, list] of this.events) {
      const lag = list.find((e) => e.lagMs != null)?.lagMs;
      const iv = activeIntervals(list, { lagMs: lag ?? 500, endMs });
      const ms = iv.reduce((n, x) => n + x.endMs - x.startMs, 0);
      if (ms > bestMs) { best = iv; bestMs = ms; }
    }
    return best;
  }

  // The utterances of this recording's system audio (the part of the note after earlier recordings of it)
  mine(utterances) { return utterances.filter((u) => u.speaker === 'them' && u.speakerId && u.endMs > this.originMs); }

  // Names for the voices of the system audio. utterances: this note's segments with words (notes.segmentWords).
  // -> { named, unresolved, active, matrix, display } (see names.js); nothing is written here.
  vote(utterances, { endMs, options } = {}) {
    const mine = this.mine(utterances);
    const highlight = this.intervals(endMs);
    // the captions name the stretches whose words they match; where they do, they outrank the highlight
    const named = this.useCaptions && this.captions.length ? alignCaptions({ captions: this.captions.map((c) => ({ t: c.t, name: c.name, text: c.text })), utterances: mine }) : [];
    this.captionNamed = named.length;
    const active = named.length ? mergeIntervals(named, highlight) : highlight;
    const roster = this.roster();
    const remotes = roster ? roster.filter((p) => !p.self).map((p) => p.name) : null;
    const res = nameSpeakers({ speech: speechOf(mine), active, remotes, selfKeys: this.userKeys, options });
    return { ...res, active, captionNamed: named.length };
  }

  summary() {
    const events = [...this.events.values()].reduce((n, l) => n + l.length, 0);
    return { events, roster: this.roster()?.length ?? null, captions: this.captions.length, captionNamed: this.captionNamed || 0, sources: [...new Set([...this.events.keys(), ...this.rosters.keys()])] };
  }
}

module.exports = { MeetingCollector };
