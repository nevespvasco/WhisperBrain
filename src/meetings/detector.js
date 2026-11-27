'use strict';
// Watches for "a call app is using the microphone" (helped by meeting window titles) and for calendar meetings
// about to start. Emits 'meeting.detected' / 'meeting.autostarted' / 'meeting.ended' / 'meeting.starting', and
// 'meeting.apps-changed' when the calls that are live change during a meeting (Zoom and Discord at once, one leaving), and can
// start/stop a recording on its own (settings.autoRecord / autoStop). Pure state machine; `tick()` is timer-driven.
const { PLATFORMS } = require('../meet/platforms');
const { BROWSERS, classify, classifyWindowTitle, platformFromUrl, appName, pickTargetApp } = require('../platform/apps');

const AUTO_MODES = ['off', 'ask', 'always'];
const isBrowser = (a) => a.appId === 'browser' || (!a.appId && BROWSERS.test(a.name || ''));
const appId = (a) => a.appId || classify({ name: a.name })?.id || 'other';
const unique = (xs) => [...new Set(xs)];

// A chat app (Discord, Slack...) that only plays sound is no call: notifications play too. Its voice stream also exists only
// while somebody is speaking (measured: Discord's is running a few seconds at a time, idle, then gone), so "playing for N ticks
// in a row" never happens. Next to a call that is already confirmed, one heard in this many ticks within the window (a
// notification is one blip) is a second call, and it stays one through the silences until it has not been heard for the hold.
const CHAT_HEARD = 3, CHAT_WINDOW_MS = 90_000, CHAT_HOLD_MS = 180_000;

class MeetingDetector {
  // signals: the hub of what the meeting window shows (src/meet/hub.js); platforms: the registry that names the call it reports. A call it sees (the browser extension or the
  // accessibility reader says "in a call") counts as a meeting even where the microphone cannot be watched (macOS).
  constructor({ platform, calendar, bus, settings, recording, notes = null, signals = null, platforms = PLATFORMS, now = Date.now, confirmTicks = 2, idleTicks = 5 }) {
    Object.assign(this, { platform, calendar, bus, settings, recording, notes, signals, platforms, now, confirmTicks, idleTicks });
    this.streak = 0;
    this.idle = 0;
    this.latched = false;   // already announced for this mic session
    this.announced = new Set(); // calendar event ids announced as "starting"
    this.timer = null;
    this.liveNow = [];        // the calls live at the last look: [{ id, name, apps }]
    this.chat = new Map();    // appId -> { heard: [times it was playing without holding the microphone], live, app }
    this.last = { active: false, apps: [] };
    this.session = null;    // meeting in progress: { apps, platform, platforms, title, event, since, lastSeen, announced, autoNoteId }
  }

  start(intervalMs = 4000) {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  autoRecord() { const m = this.settings.get('autoRecord'); return AUTO_MODES.includes(m) ? m : 'ask'; }
  autoStop() { return this.settings.get('autoStop') !== false; }

  status() {
    const s = this.session;
    return { active: !!s, apps: s?.apps || [], platform: s?.platform || null, platforms: s?.platforms || [], title: s?.title || '', since: s?.since || null, autoNoteId: s?.autoNoteId || null };
  }

  async tick() {
    if (!this.settings.get('detectMeetings') && !this.settings.get('notifyUpcoming')) return;
    if (this.settings.get('detectMeetings')) await this.checkMic();
    if (this.settings.get('notifyUpcoming')) await this.checkCalendar();
  }

  async checkMic() {
    const activity = await this.platform.micActivity();
    this.last = activity;
    // what the meeting windows and the platforms' own apps say: a platform whose own app is connected (Discord over RPC) is
    // believed over the sound of its app, which proves little (notification sounds, a stream that exists only while someone talks)
    const sig = this.signals?.status();
    const exact = new Set(sig?.authoritative || []);
    const users = (activity.supported ? activity.apps || [] : []).filter((a) => !exact.has(appId(a)));
    // Window titles only matter when something holds the mic; a meeting window alone is never enough.
    const windows = users.length && this.platform.meetingWindows ? await this.platform.meetingWindows().catch(() => []) : [];
    const meetWins = windows.map((w) => ({ ...w, cls: classifyWindowTitle(w.title) })).filter((w) => w.cls);
    let apps = users.filter((a) => !a.weak || (isBrowser(a) && meetWins.length));
    apps = apps.concat(this.sustainedPlayback(users, apps));
    // a call the meeting window itself shows is a call, whatever the microphone says; it does not need a window title either
    const seen = sig?.meeting;
    for (const c of sig?.calls || []) if (c.exact && !apps.some((a) => appId(a) === c.platform)) apps.push({ name: this.platforms.name(c.platform), appId: c.platform, weak: false, title: c.title });
    if (!apps.length && seen?.inCall) apps = [{ name: this.platforms.name(seen.platform), appId: seen.platform, weak: false, title: seen.title }];
    if (!apps.length) {
      this.liveNow = [];
      this.idle++;
      if (this.idle >= this.idleTicks) {
        if (this.session) await this.end();
        this.latched = false; this.streak = 0;
      }
      return;
    }
    this.idle = 0;
    this.follow(apps, meetWins);
    if (this.session) { this.session.lastSeen = this.now(); return; }
    if (this.recording.status().active) return; // while the user records, the mic is ours
    this.streak++;
    if (this.streak >= this.confirmTicks && !this.latched) {
      this.latched = true;
      await this.detected(apps, meetWins);
    }
  }

  // Chat apps that are playing without holding the microphone, counted as live calls once heard often enough (CHAT_HEARD ticks in
  // CHAT_WINDOW_MS) and until not heard for CHAT_HOLD_MS; but only beside a call that is already certain (alone, a chat app
  // playing sound proves nothing). What was heard is recorded every tick, whatever else is going on.
  sustainedPlayback(users, confident) {
    const t = this.now();
    for (const a of users) {
      if (!a.weak || a.via !== 'playback') continue;
      const c = this.chat.get(appId(a)) || { heard: [], live: false };
      c.heard.push(t); c.app = a;
      this.chat.set(appId(a), c);
    }
    for (const [id, c] of this.chat) {
      c.heard = c.heard.filter((x) => t - x <= CHAT_HOLD_MS);
      if (!c.heard.length) { this.chat.delete(id); continue; }
      if (c.heard.filter((x) => t - x <= CHAT_WINDOW_MS).length >= CHAT_HEARD) c.live = true;
    }
    if (!confident.length) return [];
    return [...this.chat.values()].filter((c) => c.live).map((c) => ({ ...c.app, weak: false }));
  }

  // The distinct calls behind the live applications -> [{ id, name }]. A browser is no call of its own: it is the platform its
  // meeting window says, and only while it is live itself (an open Meet tab alone does not count while Zoom is the call).
  liveCalls(apps, meetWins) {
    const out = new Map();
    const add = (id, name, a) => { const c = out.get(id) || { id, name, apps: [] }; if (!c.apps.includes(a)) c.apps.push(a); out.set(id, c); };
    for (const a of apps) { const id = appId(a); if (id !== 'browser') add(id, a.name, a); }
    const browsers = apps.filter((a) => appId(a) === 'browser');
    for (const w of meetWins) if (browsers.length && !out.has(w.cls.id)) for (const b of browsers) add(w.cls.id, appName(w.cls.id) || w.cls.name, b);
    if (!out.size && apps.length) add(appId(apps[0]), apps[0].name, apps[0]);
    return [...out.values()];
  }

  // The applications behind the calls with these ids, as they were at the last look (what a recording follows when the person
  // chose some of the calls).
  appsFor(ids) { return [...new Set(this.liveNow.filter((c) => ids.includes(c.id)).flatMap((c) => c.apps))]; }

  // Keeps the meeting up to date with the calls that are live right now: one that joins or leaves is announced, and when more
  // than one is live a recording that follows a single application's audio goes back to the whole output (it would lose the rest).
  follow(apps, meetWins) {
    const calls = this.liveNow = this.liveCalls(apps, meetWins);
    const names = unique(apps.map((a) => a.name));
    const s = this.session;
    if (s) {
      const ids = calls.map((c) => c.id);
      if (ids.length !== s.platforms.length || !ids.every((id) => s.platforms.includes(id))) {
        const kept = s.platforms.filter((id) => ids.includes(id)); // keep the order they were seen in; the first is the main one
        s.platforms = [...kept, ...ids.filter((id) => !kept.includes(id))];
        s.apps = names;
        if (!s.platforms.includes(s.platform)) s.platform = s.platforms[0];
        if (s.announced) this.bus.publish('meeting.apps-changed', { apps: names, platform: s.platform, platforms: s.platforms, at: this.now() });
      }
    }
    if (calls.length > 1 && this.recording.status().active) {
      this.recording.widenSystemCapture?.(`${calls.map((c) => c.name).join(' and ')} are both live: capturing the whole output`);
    }
  }

  // Native call apps name the platform; a browser borrows it from the meeting window title.
  pickPlatform(apps, meetWins) {
    const native = apps.map(appId).find((id) => id !== 'browser' && id !== 'other');
    // a title the meeting window itself gave (the extension, the accessibility reader) stands in for a listed window
    if (native) return { platform: native, win: meetWins.find((w) => w.cls.id === native) || (apps.find((a) => a.title) ? { title: apps.find((a) => a.title).title } : undefined) };
    if (meetWins.length) return { platform: meetWins[0].cls.id, win: meetWins[0] };
    return { platform: appId(apps[0]), win: null };
  }

  // Prefer a current calendar event whose join link is on the detected platform; else the closest in time.
  async matchEvent(platform, at) {
    try {
      if (!this.calendar.candidates) return (await this.calendar.current({ at })) || null;
      const cands = await this.calendar.candidates({ at });
      return cands.find((e) => e.url && platformFromUrl(e.url) === platform) || cands[0] || null;
    } catch { return null; }
  }

  async detected(apps, meetWins) {
    const at = this.now();
    const mode = this.autoRecord();
    const { platform, win } = this.pickPlatform(apps, meetWins);
    const names = unique(apps.map((a) => a.name));
    const platforms = unique([platform, ...this.liveCalls(apps, meetWins).map((c) => c.id)]);
    const event = await this.matchEvent(platform, at);
    const s = this.session = { apps: names, platform, platforms, title: win?.title || '', event, since: at, lastSeen: at, announced: mode !== 'off', autoNoteId: null };
    if (mode === 'off') return;
    this.bus.publish('meeting.detected', { apps: names, platform, platforms, title: s.title, event, at });
    if (mode !== 'always' || !this.notes || this.recording.status().active) return;
    const label = (['browser', 'other'].includes(platform) ? names[0] : appName(platform) || names[0]) || 'Call';
    try {
      const note = this.notes.create({
        title: event?.summary || `${label} meeting`, eventUid: event?.uid || null, eventStart: event?.start || null,
        attendees: event?.attendees || [], source: 'recorded', platform,
      });
      // the recording is told which application the call is, so that its system audio can follow it alone where possible
      const app = pickTargetApp(apps);
      await this.recording.start(note.id, app ? { app } : undefined);
      s.autoNoteId = note.id;
      this.bus.publish('meeting.autostarted', { noteId: note.id, platform });
    } catch (e) {
      this.bus.publish('meeting.autostart-failed', { platform, message: e.message });
    }
  }

  async end() {
    const s = this.session;
    this.session = null;
    if (s.announced) this.bus.publish('meeting.ended', { apps: s.apps, at: this.now(), durationMs: Math.max(0, s.lastSeen - s.since) });
    if (!s.autoNoteId || !this.autoStop()) return;
    const st = this.recording.status();
    if (st.active && st.noteId === s.autoNoteId) await this.recording.stop().catch(() => {}); // only the recording we started
  }

  async checkCalendar() {
    const has = this.calendar.hasSources ? this.calendar.hasSources() : this.calendar.sources().length > 0;
    if (!has) return;
    const t = this.now();
    const { events } = await this.calendar.events({ from: t - 60000, to: t + 3 * 60000 });
    for (const e of events) {
      if (e.allDay || this.announced.has(e.id)) continue;
      if (e.start - t <= 60000 && e.start - t > -60000) {
        this.announced.add(e.id);
        this.bus.publish('meeting.starting', { event: e });
      }
    }
    if (this.announced.size > 500) this.announced.clear();
  }
}

module.exports = { MeetingDetector };
