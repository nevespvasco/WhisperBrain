'use strict';
const fs = require('node:fs');
const { parseIcs, expand } = require('./ics');
const { newId } = require('../core/ids');

const TTL_MS = 5 * 60 * 1000;

const GOOGLE = 'Google Calendar';

// Calendar sources are ICS feeds (a secret iCal URL from Google, Outlook, iCloud, Fastmail... or a local .ics file)
// plus, optionally, a connected Google account (`google`, a GoogleCalendar).
class Calendar {
  constructor({ settings, bus, fetchImpl = globalThis.fetch, now = Date.now, google = null }) {
    Object.assign(this, { settings, bus, now, google });
    this.fetch = fetchImpl;
    this.cache = new Map(); // source id -> { at, events, error }
  }

  sources() { return this.settings.get('calendar').sources; }

  hasSources() { return this.sources().length > 0 || !!this.google?.connected(); }

  // Drop cached Google events (after connecting, disconnecting or changing the calendar selection).
  invalidate() { this.cache.delete('google'); }

  addSource({ name, kind, location }) {
    if (!['url', 'file'].includes(kind)) throw new Error('kind must be url or file');
    if (!location?.trim()) throw new Error('location is required');
    const loc = location.trim().replace(/^webcal:/i, 'https:');
    if (kind === 'url' && !/^https?:\/\//i.test(loc)) throw new Error('a calendar URL must start with https:// or webcal://');
    const src = { id: newId(), name: (name || '').trim() || (kind === 'url' ? new URL(loc).hostname : loc.split(/[\\/]/).pop()), kind, location: loc };
    this.settings.update({ calendar: { sources: [...this.sources(), src] } });
    this.cache.delete(src.id);
    return src;
  }

  removeSource(id) {
    this.settings.update({ calendar: { sources: this.sources().filter((s) => s.id !== id) } });
    this.cache.delete(id);
  }

  async load(src, { force = false } = {}) {
    const hit = this.cache.get(src.id);
    if (!force && hit && this.now() - hit.at < TTL_MS) return hit;
    let entry;
    try {
      let text;
      if (src.kind === 'file') text = fs.readFileSync(src.location, 'utf8');
      else {
        const res = await this.fetch(src.location, { signal: AbortSignal.timeout(15000), headers: { Accept: 'text/calendar' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('the URL did not return an iCalendar feed');
      }
      entry = { at: this.now(), events: parseIcs(text), error: null };
    } catch (e) {
      entry = { at: this.now(), events: hit?.events || [], error: e.message };
    }
    this.cache.set(src.id, entry);
    return entry;
  }

  // Google events are fetched per time range; one fetch covers a wide window around now so the usual
  // queries (agenda, current meeting) are served from the same cache entry.
  async loadGoogle(from, to, { force = false } = {}) {
    const sel = JSON.stringify((this.google.config?.().calendars || []).filter((c) => c.selected).map((c) => c.id));
    const hit = this.cache.get('google');
    const fresh = hit && hit.sel === sel && this.now() - hit.at < TTL_MS && hit.from <= from && hit.to >= to;
    if (!force && fresh) return hit;
    const t = this.now();
    const win = { from: Math.min(from, t - 86400000), to: Math.max(to, t + 8 * 86400000) };
    let entry;
    try {
      entry = { at: t, sel, ...win, events: await this.google.events(win), error: null };
    } catch (e) {
      entry = { at: t, sel, from: hit?.from ?? 0, to: hit?.to ?? 0, events: hit?.events || [], error: e.message, code: e.code };
    }
    this.cache.set('google', entry);
    return entry;
  }

  // Events between from and to across all sources. `errors` lists sources that failed to load.
  async events({ from = this.now() - 3600000, to = this.now() + 7 * 86400000, force = false } = {}) {
    const out = [];
    const errors = [];
    for (const src of this.sources()) {
      const e = await this.load(src, { force });
      if (e.error) errors.push({ source: src.name, error: e.error });
      for (const o of expand(e.events, from, to)) out.push({ ...o, id: `${src.id}:${o.uid}:${o.start}`, source: src.name, provider: 'ics' });
    }
    if (this.google?.connected()) {
      const g = await this.loadGoogle(from, to, { force });
      if (g.error) errors.push({ source: GOOGLE, error: g.error, ...(g.code && { code: g.code }) });
      for (const o of g.events) {
        if (o.end > from && o.start < to) out.push({ ...o, id: `google:${o.calendarId || 'primary'}:${o.uid}:${o.start}`, source: GOOGLE, provider: 'google' });
      }
    }
    out.sort((a, b) => a.start - b.start);
    return { events: out, errors };
  }

  // Meetings the user may be in/about to join (starting within 5 minutes, or not yet over), closest start first.
  async candidates({ at = this.now() } = {}) {
    const { events } = await this.events({ from: at - 6 * 3600000, to: at + 3600000 });
    const cands = events.filter((e) => !e.allDay && at >= e.start - 5 * 60000 && at < Math.max(e.end, e.start + 60000));
    return cands.sort((a, b) => Math.abs(at - a.start) - Math.abs(at - b.start));
  }

  // The event the user is most likely in/about to join.
  async current({ at = this.now() } = {}) { return (await this.candidates({ at }))[0] || null; }
}

module.exports = { Calendar, TTL_MS };
