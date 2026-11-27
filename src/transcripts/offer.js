'use strict';
// After recording a Teams, Zoom or Google Meet call the note offers to fetch the platform's own transcript, which names every line
// (so the voices are named without reading any window). What already exists is used as it is: attaching a transcript (src/meet/attach.js)
// and the fetch code of each platform (src/transcripts/providers.js, written from the vendors' docs and never run against a real account).
// This module is the flow around them:
//   - the call the recording was about (platform and meeting code, from the meeting windows) is put on the note, with its meeting link,
//     because the platforms are asked about a meeting by its link;
//   - the offer (GET) says what can be done and why not; starting it (POST, or automatically with the setting `platformTranscript`) is a
//     durable job that retries with a growing pause for a bounded time, because platforms publish the transcript minutes after the call;
//   - every way it can end has a reason in words, and the file drop (the existing attach) is always the way out.
const { TranscriptError } = require('./providers');

const PLATFORMS = ['teams', 'zoom', 'meet'];
const ATTEMPTS = 6;                       // with the queue's pauses (5 s, 30 s, 2 min, 10 min, 10 min): about 23 minutes
const FIRST_DELAY_MS = 30_000;            // the first try after an automatic start: the platform needs a moment after the call ends
const PERMANENT = new Set(['unknown', 'not-connected', 'no-link', 'auth', 'forbidden', 'disabled', 'no-names', 'no-match', 'deleted']);
const HINT = 'You can also drop the transcript file you export from the platform (.vtt, .srt or .docx) on the note.';

// the meeting link a platform is asked about, from the code its window showed (src/transcripts/providers.js meetingRef reads these)
const JOIN = { meet: (c) => (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(c) ? `https://meet.google.com/${c.toLowerCase()}` : ''), zoom: (c) => (/^\d{9,12}$/.test(c) ? `https://zoom.us/j/${c}` : ''), teams: (c) => (/^\d{9,15}$/.test(c) ? `https://teams.live.com/meet/${c}` : '') };

// What went wrong, in words a person can act on. -> { code, message, hint }
function reasonFor(provider, code, label, detail = '') {
  const m = {
    'not-connected': `${label} is not connected: connect it in Settings first.`,
    'no-link': `This meeting has no ${label} meeting link, so it cannot be looked up there.`,
    auth: `The ${label} sign-in is no longer valid: connect again in Settings.`,
    forbidden: `${label} refused the request: the account may not be allowed to read this meeting's transcript, or the permission was not granted.`,
    disabled: `The meeting organiser's ${label} policy does not allow the transcript to be read through the API.`,
    'no-names': `${label} will not say who spoke in this transcript (a policy hides the speakers' names), so it cannot name anyone.`,
    'no-match': detail || 'The transcript does not match this recording.',
    deleted: 'The note was deleted.',
    'not-found': {
      zoom: 'Zoom has no cloud transcript for this meeting. It needs a paid account, the host recording to the cloud, and audio transcript switched on.',
      meet: 'Google Meet has no transcript for this meeting: transcription was off, or it is gone (Meet keeps transcripts for 30 days).',
      teams: 'Teams has no transcript for this meeting: transcription was not switched on, or you are not the organiser.',
    }[provider] || `${label} has no transcript for this meeting.`,
  }[code] || detail || `${label} could not be asked: ${code}.`;
  return { code, message: m, hint: HINT };
}

class PlatformTranscripts {
  constructor({ app, firstDelayMs = FIRST_DELAY_MS }) { this.app = app; this.firstDelayMs = firstDelayMs; }

  attach(bus = this.app.bus) {
    return bus.subscribe((e) => {
      try {
        if (e.type === 'recording.call') this.noteCall(e.data);
        else if (e.type === 'recording.stopped' && this.mode() === 'auto') this.autoStart(e.data.noteId);
      } catch (err) { bus.publish('recording.warning', { message: `platform transcript: ${err.message}` }); }
    });
  }

  mode() { const m = this.app.settings.get('platformTranscript'); return ['ask', 'auto', 'off'].includes(m) ? m : 'ask'; }

  // The call's platform goes on the note (when it has none yet), and its meeting link too, so the platform can be asked about it.
  noteCall({ noteId, platform, code }) {
    const { notes, knowledge } = this.app;
    const note = notes.get(noteId);
    if (!note || !platform) return;
    if (!note.platform) notes.update(noteId, { platform });
    const url = JOIN[platform]?.(String(code || ''));
    if (url && !knowledge.links(noteId).some((l) => l.url && l.url.startsWith(url.replace(/\/\d+$/, '/')) && l.url.includes(String(code)))) knowledge.addLink(noteId, { kind: 'url', url, title: `${this.label(platform)} meeting` });
  }

  label(platform) { return (this.app.transcripts?.providers?.[platform] || {}).label || { teams: 'Microsoft Teams', zoom: 'Zoom', meet: 'Google Meet' }[platform] || platform; }

  lastJob(noteId) {
    const row = this.app.db.prepare("SELECT id FROM jobs WHERE kind = 'transcript.fetch' AND key = ? ORDER BY id DESC LIMIT 1").get(`transcript:${noteId}`);
    return row ? this.app.jobs.get(row.id) : null;
  }

  // -> { platform, label, state, ... }: 'none' (nothing to offer) | 'blocked' (needs a connection or a link) | 'ready' | 'working' | 'done' | 'failed'
  offer(noteId) {
    const { notes, transcripts } = this.app;
    const note = notes.get(noteId);
    const platform = note?.platform;
    if (!note || !PLATFORMS.includes(platform) || this.mode() === 'off' || !notes.segments(noteId).length) return { state: 'none', platform: PLATFORMS.includes(platform) ? platform : null };
    const label = this.label(platform);
    const connected = !!transcripts?.client(platform)?.connected();
    const hasLink = !!transcripts?.refFor(noteId, platform);
    const base = { platform, label, auto: this.mode() === 'auto', connected, hasLink, fallback: 'file' };
    const job = this.lastJob(noteId);
    if (job && (job.state === 'queued' || job.state === 'running')) return { ...base, state: 'working', attempt: Math.max(1, job.attempts), of: job.maxAttempts, retryAt: job.state === 'queued' && job.runAfter > Date.now() ? job.runAfter : null };
    if (job?.state === 'done' && job.result?.ok) return { ...base, state: 'done', result: job.result };
    if (job?.state === 'done' && job.result) return { ...base, state: 'failed', reason: reasonFor(platform, job.result.code, label, job.result.message) };
    if (job?.state === 'failed') return { ...base, state: 'failed', reason: reasonFor(platform, 'failed', label, job.error) };
    if (!connected) return { ...base, state: 'blocked', needs: 'connect', reason: reasonFor(platform, 'not-connected', label) };
    if (!hasLink) return { ...base, state: 'blocked', needs: 'link', reason: reasonFor(platform, 'no-link', label) };
    return { ...base, state: 'ready' };
  }

  // Starts the job (one per note at a time). -> the offer now
  start(noteId, { delayMs = 0 } = {}) {
    const o = this.offer(noteId);
    if (o.state === 'none') throw Object.assign(new Error(this.mode() === 'off' ? 'Fetching platform transcripts is switched off in Settings.' : 'There is no platform transcript to fetch for this note.'), { status: 409 });
    if (o.state === 'blocked') throw Object.assign(new Error(o.reason.message), { status: 409, code: o.reason.code });
    if (o.state !== 'working') this.app.runner.enqueue('transcript.fetch', { noteId, provider: o.platform }, { key: `transcript:${noteId}`, maxAttempts: ATTEMPTS, runAfter: delayMs });
    return this.offer(noteId);
  }

  autoStart(noteId) {
    const o = this.offer(noteId);
    if (o.state === 'ready') this.start(noteId, { delayMs: this.firstDelayMs });
  }

  // The job. Not there yet (the platform has not published) throws, so the queue waits and tries again; a refusal that waiting cannot
  // change, or the last try, ends it with a reason (a normal result, not an error, so it is read back as it is).
  async run({ noteId, provider }, { job }) {
    if (!this.app.notes.get(noteId)) return { ok: false, code: 'deleted' };
    try {
      const r = await this.app.transcripts.fetchForNote(noteId, provider);
      return { ok: true, matched: r.matched, named: r.named?.length ?? 0 };
    } catch (e) {
      const code = e instanceof TranscriptError || e.code ? e.code : e.status ? 'no-match' : 'failed';
      const last = job.attempts >= job.maxAttempts;
      if (!PERMANENT.has(code) && !last) throw e;
      return { ok: false, code, message: e.status ? e.message : '' };
    }
  }
}

module.exports = { PlatformTranscripts, reasonFor, PLATFORMS, ATTEMPTS };
