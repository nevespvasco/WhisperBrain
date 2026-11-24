'use strict';
// Watches for "a call app is using the microphone" (helped by meeting window titles) and for calendar meetings
// about to start. Emits 'meeting.detected' / 'meeting.autostarted' / 'meeting.ended' / 'meeting.starting', and can
// start/stop a recording on its own (settings.autoRecord / autoStop). Pure state machine; `tick()` is timer-driven.
const { BROWSERS, classify, classifyWindowTitle, platformFromUrl, appName } = require('../platform/apps');

const AUTO_MODES = ['off', 'ask', 'always'];
const isBrowser = (a) => a.appId === 'browser' || (!a.appId && BROWSERS.test(a.name || ''));
const appId = (a) => a.appId || classify({ name: a.name })?.id || 'other';

class MeetingDetector {
  constructor({ platform, calendar, bus, settings, recording, notes = null, now = Date.now, confirmTicks = 2, idleTicks = 5 }) {
    Object.assign(this, { platform, calendar, bus, settings, recording, notes, now, confirmTicks, idleTicks });
    this.streak = 0;
    this.idle = 0;
    this.latched = false;   // already announced for this mic session
    this.announced = new Set(); // calendar event ids announced as "starting"
    this.timer = null;
    this.last = { active: false, apps: [] };
    this.session = null;    // meeting in progress: { apps, platform, title, event, since, lastSeen, announced, autoNoteId }
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
    return { active: !!s, apps: s?.apps || [], platform: s?.platform || null, title: s?.title || '', since: s?.since || null, autoNoteId: s?.autoNoteId || null };
  }

  async tick() {
    if (!this.settings.get('detectMeetings') && !this.settings.get('notifyUpcoming')) return;
    if (this.settings.get('detectMeetings')) await this.checkMic();
    if (this.settings.get('notifyUpcoming')) await this.checkCalendar();
  }

  async checkMic() {
    const activity = await this.platform.micActivity();
    this.last = activity;
    const users = activity.supported ? activity.apps || [] : [];
    // Window titles only matter when something holds the mic; a meeting window alone is never enough.
    const windows = users.length && this.platform.meetingWindows ? await this.platform.meetingWindows().catch(() => []) : [];
    const meetWins = windows.map((w) => ({ ...w, cls: classifyWindowTitle(w.title) })).filter((w) => w.cls);
    const apps = users.filter((a) => !a.weak || (isBrowser(a) && meetWins.length));
    if (!apps.length) {
      this.idle++;
      if (this.idle >= this.idleTicks) {
        if (this.session) await this.end();
        this.latched = false; this.streak = 0;
      }
      return;
    }
    this.idle = 0;
    if (this.session) { this.session.lastSeen = this.now(); return; }
    if (this.recording.status().active) return; // while the user records, the mic is ours
    this.streak++;
    if (this.streak >= this.confirmTicks && !this.latched) {
      this.latched = true;
      await this.detected(apps, meetWins);
    }
  }

  // Native call apps name the platform; a browser borrows it from the meeting window title.
  pickPlatform(apps, meetWins) {
    const native = apps.map(appId).find((id) => id !== 'browser' && id !== 'other');
    if (native) return { platform: native, win: meetWins.find((w) => w.cls.id === native) };
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
    const names = apps.map((a) => a.name);
    const event = await this.matchEvent(platform, at);
    const s = this.session = { apps: names, platform, title: win?.title || '', event, since: at, lastSeen: at, announced: mode !== 'off', autoNoteId: null };
    if (mode === 'off') return;
    this.bus.publish('meeting.detected', { apps: names, platform, title: s.title, event, at });
    if (mode !== 'always' || !this.notes || this.recording.status().active) return;
    const label = (['browser', 'other'].includes(platform) ? names[0] : appName(platform) || names[0]) || 'Call';
    try {
      const note = this.notes.create({
        title: event?.summary || `${label} meeting`, eventUid: event?.uid || null, eventStart: event?.start || null,
        attendees: event?.attendees || [], source: 'recorded', platform,
      });
      await this.recording.start(note.id);
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
