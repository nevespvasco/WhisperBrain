'use strict';
const { PushSource } = require('../audio/source');
const { rms } = require('../audio/pcm');
const { isEcho, micSegmentIsEnergyEcho } = require('../audio/echo');
const { EnergyEnvelope } = require('../audio/envelope');
const { SpeakerTracker } = require('../speakers/cluster');
const { refineNote, describeUtterance } = require('../speakers/refine');
const { diarizeChannel, liveVoiceCount } = require('../speakers/final');
const { expectedSpeakers } = require('../speakers/hint');
const { describe } = require('../speakers/display');
const { MeetingCollector } = require('../meet/collector');
const { nameKey } = require('../meet/protocol');
const { planCorrections } = require('../meet/correct');
const { speechOf, invitedNames } = require('../meet/names');
const { Spool } = require('./spool');
const { SpeakerTestRecorder } = require('./speaker-test');
const nodePath = require('node:path');
const { LiveDiarizer, diarizeOwned } = require('../speakers/owned');
const { toTimeline } = require('../speakers/diarize');
const { LEGACY: { id: LEGACY_MODEL_ID }, sameVoiceThreshold } = require('../speakers/voice-models');
const { pickTargetApp } = require('../platform/apps');

const VOICE_MATCH = 0.65;     // similarity needed to recognise a saved voice
const CARRY_MS = 3000;        // a short utterance without a usable embedding inherits the previous speaker within this gap
const RECHECK_AT = [3, 8, 15];  // utterances of one speaker after which the saved voices are compared again while recording
const RECHECK_EVERY = 25;      // ... and every this many after that
const SYSTEM_HEARD = 0.0005;     // above this level (rms, 0..1) the computer's audio is known to reach us
const SYSTEM_SILENT_MS = 30000;  // macOS: no sound at all this long on the system channel = probably a missing permission
const DRAFT_ECHO_ACTIVE_DB = -50; // the system channel counts as speaking above this level (same as the echo check's)
const DRAFT_ECHO_WAIT_MS = 700;   // a mic draft needs this much audio before the loudness comparison can call it an echo

const SPEAKER = { mic: 'me', system: 'them' };
const REMOTE_GAP_MS = 60;        // a person on Discord is silent between sentences (nothing is sent): gaps longer than this are filled with silence so times stay true
// the call's browser tab as the system channel: a chunk may be this far from where the clock says before it is padded or trimmed,
// and the stream is lost when nothing came for TAB_LOST_MS; the computer's own audio is kept TAB_RING_MS to fill the gap
const TAB_SLACK_MS = 250, TAB_MAX_PAD_MS = 10000, TAB_LOST_MS = 3000, TAB_RING_MS = 8000;
const LEARN_MS = 10000;          // a voice is remembered from the call's names only when one name was highlighted this long over it...
const LEARN_SHARE = 0.85;        // ...and held this share of everything highlighted over it
const REMOTE_RESET_MS = 3000;    // ...and past this the channel is closed and reopened instead (an hour of silence is not fed to the recognizer)

class RecordingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Owns the one active recording: wires capture sources -> ASR engine -> transcript store, and keeps the
// timeline correct across pauses. Channels are 'mic' (speaker "me") and 'system' (speaker "them").
class RecordingManager {
  // spoolDir: where raw audio is parked for the after-recording speaker pass (omit to skip that pass).
  // vocabulary: (noteId) => terms the meeting is likely to say (attendees, glossary, speaker names) for hotword biasing.
  // diarization: { run, threshold, windowShift, tolerance } overrides for the after-recording diarization (tests, the eval harness).
  // discord: the Discord voice bot (src/discord/bot.js) or a stand-in with join()/leave()/on('audio'): when it joins the call,
  // every person arrives on a channel of their own ('dc:<user id>') and replaces the mixed system audio.
  // meet: the SignalHub (src/meet/hub.js) the meeting window's readers report to: who is speaking and who is on the call.
  constructor({ notes, engine, models, settings, platform, bus, speakers = null, spoolDir = null, vocabulary = null, diarization = {}, discord = null, meet = null, evidence = null }) {
    Object.assign(this, { notes, engine, models, settings, platform, bus, speakers, spoolDir, vocabulary, diarization, discord, meet, evidence });
    if (spoolDir) Spool.sweep(spoolDir);
    this.active = null;
    this.engine.on('segment', (s) => this.onSegment(s));
    this.engine.on('partial', (p) => this.onPartial(p));
    this.engine.on('draft-off', (e) => { if (this.active) { this.active.draft = { requested: false, on: false, reason: e.reason }; this.bus.publish('recording.warning', { message: `Live draft captions were switched off for this recording: ${e.reason}` }); } });
    this.engine.on('error', (e) => this.bus.publish('recording.warning', { message: e.message }));
    this.engine.on('exit', (e) => { if (this.active) this.bus.publish('recording.warning', { message: e.message }); });
    this.engine.on('warning', (e) => { if (this.active) this.bus.publish('recording.warning', { message: e.message }); });
    // The worker holds this recording's VAD buffers: nobody else (dictation, a settings change) may replace it while
    // the recording runs. Their options are kept and applied by the first start() after it stops.
    this.engine.holdRestart = () => !!this.active;
  }

  status() {
    const a = this.active;
    if (!a) return { active: false };
    return {
      active: true, noteId: a.noteId, paused: a.paused, finalizing: a.finalizing, stage: a.stage || null,
      micMuted: a.micMuted, micAvailable: !!a.channels.mic,
      elapsedMs: this.elapsed(a), channels: Object.keys(a.channels), needsRenderer: a.rendererChannels,
      echo: { cancellation: a.aec ? { ...a.aec } : null, dropped: { ...a.echoDropped } },
      draft: a.draft ? { on: a.draft.on, reason: a.draft.reason || null } : { on: false, reason: null },
      discord: a.discord ? { ...a.discord.info, people: [...a.remote.values()].map((r) => r.name) } : null,
      speakerTest: !!a.test,
      tab: a.tab ? { live: a.tab.live, gap: a.tab.gapStart !== null, chunks: a.tab.chunks, tabOnly: a.tab.tabOnly } : null,
    };
  }

  elapsed(a = this.active) {
    if (!a) return 0;
    return a.accMs + (a.paused || a.finalizing ? 0 : Date.now() - a.resumedAt);
  }

  async ensureEngine(role = 'live') {
    const s = this.settings.all();
    const model = this.models.resolve(s.asrModel);
    if (!model) throw new RecordingError('no-model', 'No speech model is installed. Download one in Settings → Transcription.');
    if (!this.models.vadInstalled()) throw new RecordingError('no-model', 'The voice-activity model is missing. Re-download a speech model in Settings.');
    // The voice model is loaded whenever it is installed, so the worker is the same whoever starts it; this recording
    // only decides whether embeddings are computed. Nothing is flowing yet, so it may replace a worker with other options.
    const speakerModel = this.models.speakerInstalled?.() ? this.models.speakerPath() : null;
    this.engine.configure?.({ embeddings: !!(s.speakerDetection && this.speakers) });
    await this.engine.start(model, { vadPath: this.models.vadPath(), threads: s.asrThreads, language: s.asrLanguage, speakerModel, allowRestart: true, role });
    return model;
  }

  // app: the meeting application ({ name, appId, pid, binary }) when the caller knows it; the system channel then follows it
  // alone where the platform can (Linux), see resolveSystemApp. apps: the applications the person chose to record (several calls at
  // once): only their audio, and it stays so (widenSystemCapture leaves it alone). wholeOutput: the person chose everything the
  // computer plays, so no application is followed and nothing needs saying about it.
  // speakerTest: a speaker test recording (needs the Discord bot in the call): the bot's per-person streams and the computer's
  // mixed sound are both kept on disk (speaker-test.js) and only the bot's are transcribed; see eval/discord-test.js.
  async start(noteId, { mic, system, app, apps, wholeOutput, speakerTest = false } = {}) {
    if (this.active) throw new RecordingError('busy', 'A recording is already in progress.');
    const note = this.notes.get(noteId);
    if (!note) throw new RecordingError('not-found', 'Note not found.');
    const s = this.settings.all();
    const want = { mic: mic ?? s.micEnabled, system: system ?? s.systemAudioEnabled };
    if (!want.mic && !want.system) throw new RecordingError('no-channel', 'Enable the microphone or system audio.');
    // Continuing a note that already has a transcript: the new timeline starts after the old one.
    const prior = this.notes.segments(noteId).reduce((m, x) => Math.max(m, x.endMs), 0);
    // claim the slot synchronously so concurrent start() calls cannot both pass the check above
    const a = this.active = {
      noteId, chosenApps: apps?.length ? apps : null, reopen: {}, shown: '', micMuted: false, channels: {}, paused: false, finalizing: false, accMs: prior ? prior + 1000 : 0, resumedAt: Date.now(), epoch: { mic: 0, system: 0 },
      fed: { mic: 0, system: 0 }, spool: {}, base: { mic: 0, system: 0 }, refs: [], rendererChannels: [], trackers: this.makeTrackers(noteId, this.sameVoiceThreshold()), last: {}, lastLevel: 0, level: { mic: 0, system: 0 }, warnings: [],
      env: { mic: new EnergyEnvelope(), system: new EnergyEnvelope() }, aec: null, echoDropped: { text: 0, energy: 0 },
      stretches: { mic: [], system: [] }, // per channel: where each stretch of audio (start, resume) begins in the spool and on the timeline
      draft: null,                         // { requested, on, reason }: live draft captions for this recording (see applyDraft)
      drafts: { mic: null, system: null }, // the draft line on each channel right now: { startMs, text, shown, echo }. Never stored.
      acoustic: new Map(), describeQueue: [], describing: false, // utterance voice descriptions made while recording (describeSoon)
      settled: new Set(),                  // channels whose number of speakers is known (user or calendar): refine keeps it
      recentSystem: [],                    // the last few final system segments, to tell a mic draft that merely echoes them
      remote: new Map(),                   // Discord: channel ('dc:<id>') -> { userId, name, speakerId, t0, chain }, one per person heard
      discord: null,                       // { info, onAudio } while the bot is in the call
      meet: null,                          // what the meeting window shows while recording: highlights, roster, captions (src/meet/collector.js)
    };
    a.starting = true;
    let started;
    a.started = new Promise((r) => { started = r; });
    this.bus.live?.set(noteId, []); // while it runs, who spoke is shown cautiously, and numbers do not move (speakers/display.js)
    if (this.meet && s.meet.enabled) a.meet = new MeetingCollector({ hub: this.meet, elapsed: () => this.elapsed(a), paused: () => a.paused, originMs: a.accMs, useCaptions: s.meet.captions, selfNames: () => [this.settings.get('userName')] });
    // Stop can come during any of the waits below (the tray, the detector's auto-stop, a quit): it sets a.cancelled and waits for
    // a.started. Each wait is followed by this check, and whatever was opened so far (capture, echo cancellation, the bot in the
    // call) is closed by teardown below. The note only becomes 'recording' after the last check.
    const going = () => { if (a.cancelled || this.active !== a) throw new RecordingError('cancelled', 'The recording was stopped before it had started.'); };
    const cap = this.platform.capture;
    let micOpening = null; // the native microphone, opened while the vocabulary loads and the bot joins (echo cancellation takes seconds to settle)
    try {
      await this.ensureEngine();
      going();
      if (want.mic && cap.mic === 'native') micOpening = this.openMic(s).then((src) => ({ src }), (e) => ({ e }));
      await this.applyVocabulary(noteId);
      going();
      this.applyDraft(a); // loads in the worker's queue ahead of the first audio; the recording does not wait for it
      a.resumedAt = Date.now();
      const joined = await this.joinDiscord(a, s, want.mic);
      going();
      if (speakerTest) {
        if (!joined) throw new RecordingError('no-discord', 'A speaker test needs the Discord bot in your voice channel: set it up in Settings → Integrations → Discord, join a voice channel, then try again.');
        if (!this.spoolDir) throw new RecordingError('no-disk', 'A speaker test needs somewhere to keep the audio.');
        want.system = true; // the mixed sound is the thing under test; it goes to disk, not to the transcript (onPcm)
        a.test = new SpeakerTestRecorder(nodePath.join(nodePath.dirname(this.spoolDir), 'speaker-tests', `${new Date().toISOString().replace(/[:.]/g, '-')}-${noteId.slice(0, 8)}`), { selfUserId: s.discord?.userId });
      } else if (joined) want.system = false; // the bot hears everyone separately: the mixed system audio would only repeat it
      for (const ch of ['mic', 'system']) {
        if (!want[ch]) continue;
        try {
          let src;
          if (cap[ch] === 'native') {
            // how this channel's capture is opened, kept to open it again if the capture process dies (attach: 'end')
            if (ch === 'mic') { a.reopen.mic = () => this.openMic(s); const r = await micOpening; micOpening = null; if (r.e) throw r.e; src = r.src; } else {
              const o = a.chosenApps ? { apps: a.chosenApps } : wholeOutput ? { wholeOutput: true } : { app: await this.resolveSystemApp(s, app) };
              a.reopen.system = () => this.platform.createSystemSource(o);
              src = await a.reopen.system();
            }
          } else {
            src = new PushSource();
            a.rendererChannels.push(ch);
          }
          if (ch === 'mic') a.aec = src?.aec || (cap.mic === 'renderer' ? { requested: !!s.echoCancel, active: null, backend: 'chromium', reason: 'cannot be verified from here; Chromium only cancels audio it plays itself' } : null);
          if (!src) throw new Error(`${ch} capture is not available on this system`);
          this.attach(a, ch, src);
        } catch (e) {
          if (!want.mic || !want.system || Object.keys(a.channels).length) {
            a.warnings.push(`${ch}: ${e.message}`);
            this.bus.publish('recording.warning', { message: `${ch}: ${e.message}` });
          } else throw e;
        }
        going();
      }
      if (!Object.keys(a.channels).length && !a.discord) throw new RecordingError('no-source', 'No audio source could be started.');
      going();
      this.notes.update(noteId, { status: 'recording', startedAt: note.startedAt || Date.now() });
      for (const src of Object.values(a.channels)) src.start();
      this.bus.publish('recording.started', { noteId, channels: Object.keys(a.channels), needsRenderer: a.rendererChannels, echoCancellation: a.aec, systemCapture: a.channels.system?.capture || null });
      if (a.rendererChannels.length) this.bus.publish('capture.request', { noteId, channels: a.rendererChannels });
      return this.status();
    } catch (e) {
      this.teardown(a);
      micOpening?.then((r) => { try { r.src?.stop(); } catch { /* gone */ } }); // opened in parallel and never attached
      if (this.active === a) this.active = null;
      this.bus.live?.delete(noteId);
      throw e;
    } finally {
      a.starting = false;
      started();
    }
  }

  // Native mic capture. Platforms that can cancel echo before the speech model offer openMicSource(); otherwise it is the raw mic.
  async openMic(s) {
    const opts = { device: s.micDevice, echoCancel: s.echoCancel, noiseSuppression: s.micNoiseSuppression, autoGain: s.micAutoGain };
    return this.platform.openMicSource ? this.platform.openMicSource(opts) : this.platform.createMicSource(opts);
  }

  // Bias the live recognizer towards this meeting's words before any audio flows. Best effort: a failure here must
  // never stop a recording.
  async applyVocabulary(noteId) {
    try { await this.engine.setHotwords?.(this.vocabulary && this.settings.get('asrHotwords') ? this.vocabulary(noteId) : []); } catch (e) { this.bus.publish('recording.warning', { message: `vocabulary: ${e.message}` }); }
  }

  // Live draft captions: draft words from a streaming model while people speak, replaced by the final text of the
  // segment. Needs the `liveDraft` setting and the optional streaming model; the engine skips them on a computer that is
  // too small. Best effort: a failure here never stops a recording and drafts are never saved.
  applyDraft(a) {
    const s = this.settings.all();
    const model = s.liveDraft ? this.models.draftModel?.() : null;
    a.draft = { requested: !!model, on: false, reason: s.liveDraft ? (model ? null : 'the streaming model is not installed') : 'turned off in settings' };
    if (!model || !this.engine.setDraft) { Promise.resolve(this.engine.setDraft?.(null)).catch(() => {}); return Promise.resolve(); }
    return Promise.resolve(this.engine.setDraft(model, { language: s.asrLanguage })).then((r) => {
      if (this.active !== a) return;
      a.draft = { requested: r.enabled, on: r.enabled, reason: r.reason || null };
      if (!r.enabled && r.reason && /load/.test(r.reason)) this.bus.publish('recording.warning', { message: `Live draft captions: ${r.reason}` });
    }).catch((e) => { if (this.active === a) { a.draft = { requested: false, on: false, reason: e.message }; this.bus.publish('recording.warning', { message: `Live draft captions: ${e.message}` }); } });
  }

  // Raw cosine from which two utterances are the same voice: the user's setting, else the one of the voice model in use.
  sameVoiceThreshold() {
    return sameVoiceThreshold(this.settings.get('speakerThreshold'), this.models?.speakerInstalled?.() ? this.models.speakerPath() : null);
  }

  // One online voice clusterer per channel, seeded with the speakers this note already has.
  makeTrackers(noteId, threshold) {
    const existing = this.speakers ? this.speakers.forNote(noteId).filter((x) => x.centroid) : [];
    const mk = (channel, prefix) => new SpeakerTracker({ threshold, prefix, speakers: existing.filter((x) => x.channel === channel).map((x) => ({ id: x.speakerId, centroid: x.centroid, count: x.count })) });
    return { mic: mk('mic', 'm'), system: mk('system', 's') };
  }

  identify(a, ch, seg, embedding) {
    if (!this.speakers || !a.trackers[ch]) return null;
    if (!embedding) {
      const prev = a.last[ch];
      return prev && seg.startMs - prev.endMs <= CARRY_MS ? prev.id : null;
    }
    const tr = a.trackers[ch];
    if (ch === 'system') tr.max = this.notes.get(a.noteId)?.speakerCount || 0; // the user may set it while recording
    const r = tr.assign(embedding, { seconds: (seg.endMs - seg.startMs) / 1000 });
    if (!r.id) return null; // too short to say it is somebody new, and nobody it sounds like: unlabelled until the passes after Stop
    const sp = tr.speakers.find((x) => x.id === r.id);
    this.speakers.save(a.noteId, { speakerId: r.id, channel: ch, centroid: sp.centroid, count: sp.count });
    // recognise saved voices as soon as a speaker appears, and again as their print firms up: a print of a few lines often scores
    // below the threshold (a real call: 0.55 live, 0.88 on the whole meeting), so it is judged again every so often while they talk
    if (r.isNew || RECHECK_AT.includes(sp.count) || sp.count % RECHECK_EVERY === 0) this.speakers.autoMatch(a.noteId);
    if (r.isNew) this.bus.publish('speakers.updated', { noteId: a.noteId });
    return r.id;
  }

  // The people invited to the meeting, kept as evidence (a prior for the names; see names.js canonicalizer). Replaced, not added to.
  recordInvitation(a) {
    try {
      const rows = (this.notes.get(a.noteId)?.attendees || []).map((p) => ({ ...p, name: p.name || invitedNames([p])[0] || '' })).filter((p) => p.name)
        .map((p) => ({ kind: 'calendar', source: 'calendar', key: nameKey(p.name), name: p.name, weight: 1, meta: { email: p.email || '' } }));
      this.evidence?.replace(a.noteId, ['calendar'], rows);
    } catch { /* a record, never a reason to fail the stop */ }
  }

  // The application the system channel should follow: the one named, else the single confident meeting app using the
  // microphone right now; none (the whole output) when per-app capture is off or nothing is certain.
  async resolveSystemApp(s, hint) {
    if (!s.perAppCapture) return undefined;
    if (hint) return hint;
    try { return pickTargetApp((await this.platform.micActivity?.())?.apps) || undefined; } catch { return undefined; }
  }

  // The system channel follows one application's stream; when a second call turns up (Zoom and Discord at once) that would
  // lose the other call, so it moves to the whole output. Idempotent; false when nothing needed (or could be) changed, and always
  // false when the person chose which applications to record.
  widenSystemCapture(reason) {
    const a = this.active;
    return !!(a && !a.finalizing && !a.chosenApps && a.channels.system?.widen?.(reason));
  }

  attach(a, ch, src) {
    a.channels[ch] = src;
    // a source that can change what it captures (the application's stream went away) says so; the person is told
    src.on('capture', (c) => {
      this.bus.publish('recording.system-capture', { noteId: a.noteId, ...c });
      if (c.reason) { a.warnings.push(`${ch}: ${c.reason}`); this.bus.publish('recording.warning', { message: `${ch}: ${c.reason}` }); }
    });
    src.on('pcm', (buf) => this.onSourcePcm(a, ch, buf));
    src.on('error', (e) => {
      this.bus.publish('recording.warning', { message: `${ch}: ${e.message}` });
    });
    src.on('end', () => {
      if (this.active !== a || a.finalizing || a.channels[ch] !== src || src instanceof PushSource) return;
      // Where the platform can also capture in the renderer (macOS, Windows), the channel moves there rather than go silent
      if (this.platform.renderer?.[ch]) {
        const push = new PushSource();
        a.channels[ch] = push;
        this.attach(a, ch, push);
        push.start();
        if (!a.rendererChannels.includes(ch)) a.rendererChannels.push(ch);
        this.bus.publish('recording.warning', { message: `${ch}: the native capture stopped, so the audio is now captured by the window instead` });
        this.bus.publish('capture.request', { noteId: a.noteId, channels: [ch] });
        return;
      }
      this.bus.publish('recording.warning', { message: `${ch} capture ended unexpectedly` });
    });
  }

  // What a capture source hands over. While the call's browser tab is streaming (see acceptTabAudio) the system source is NOT the
  // "Them" channel: what it hears is kept for a few seconds and goes in only if the tab stream is lost.
  onSourcePcm(a, ch, buf) {
    if (ch === 'system' && a.tab?.live) {
      a.tab.ring.push({ buf, endWall: Date.now() });
      let ms = 0, i = a.tab.ring.length;
      while (i-- > 0) { ms += a.tab.ring[i].buf.length / 32; if (ms > TAB_RING_MS) break; }
      if (i > 0) a.tab.ring.splice(0, i);
      return;
    }
    this.onPcm(a, ch, buf);
  }

  // ---- the call's browser tab as the "Them" channel (extension/meet/tabaudio.js → src/meet/intake.js → here) ----
  // chunk: { pcm: 16 kHz mono s16le, endMs: when it ended, ms since the epoch (this computer's clock, the extension's too) }.
  // -> { ok } | { ok: false, reason }. While the stream lasts it is the system channel; if it stops (tab closed, extension reloaded)
  // the computer's own capture, which was kept running, takes over without losing a second, and the gap is marked.
  acceptTabAudio({ pcm, endMs }) {
    const a = this.active;
    if (!a || a.finalizing) return { ok: false, reason: 'not recording' };
    if (!pcm?.length || pcm.length % 2) return { ok: false, reason: 'not audio' };
    if (a.paused) return { ok: true, paused: true };
    const tab = a.tab ||= { live: false, lastAt: 0, ring: [], gapStart: null, chunks: 0, timer: null, tabOnly: false };
    if (!tab.live) this.tabStart(a, tab);
    tab.lastAt = Date.now();
    tab.chunks++;
    this.feedAligned(a, this.timelineAt(a, endMs - pcm.length / 32), pcm);
    return { ok: true };
  }

  timelineAt(a, wallMs) { return a.accMs + (wallMs - a.resumedAt); }

  tabStart(a, tab) {
    const back = tab.gapStart !== null;
    if (!a.channels.system) {      // no system capture in this recording: the tab stream makes the channel
      const push = new PushSource();
      this.attach(a, 'system', push);
      push.start();
      tab.tabOnly = true;
    }
    tab.live = true;
    tab.ring = [];
    if (back) { this.tabGapEnds(a, tab); this.bus.publish('recording.tab-audio', { noteId: a.noteId, state: 'back' }); }
    else this.bus.publish('recording.tab-audio', { noteId: a.noteId, state: 'on' });
    if (!tab.timer) { tab.timer = setInterval(() => this.tabWatch(a), 1000); tab.timer.unref?.(); }
  }

  // Audio for the system channel that starts at startMs of the timeline: silence fills what was not heard, what was already heard
  // is not heard twice, so the channel always follows the clock the microphone and the meeting window follow.
  feedAligned(a, startMs, pcm) {
    const ch = 'system';
    const expected = a.fed[ch] > 0 ? a.epoch[ch] + a.fed[ch] / 16 : startMs;
    const d = startMs - expected;
    if (d > TAB_SLACK_MS) this.onPcm(a, ch, Buffer.alloc(Math.round(Math.min(d, TAB_MAX_PAD_MS) * 16) * 2));
    else if (d < -TAB_SLACK_MS) {
      const cut = Math.round(-d * 16) * 2;
      if (cut >= pcm.length) return;
      pcm = pcm.subarray(cut);
    }
    this.onPcm(a, ch, pcm);
  }

  // every second: has the stream stopped?
  tabWatch(a) {
    const tab = a?.tab;
    if (!tab?.live || this.active !== a) return;
    if (a.paused) { tab.lastAt = Date.now(); return; }
    if (Date.now() - tab.lastAt < TAB_LOST_MS) return;
    tab.live = false;
    tab.gapStart = this.elapsed(a) - (Date.now() - tab.lastAt);
    for (const { buf, endWall } of tab.ring) this.feedAligned(a, this.timelineAt(a, endWall - buf.length / 32), buf);   // what the computer heard meanwhile
    tab.ring = [];
    const message = tab.tabOnly ? 'The call\'s tab stopped sending audio: nothing is recorded as "Them" until it does.' : 'The call\'s tab stopped sending audio: recording everything this computer plays instead.';
    a.warnings.push(`system: ${message}`);
    this.bus.publish('recording.tab-audio', { noteId: a.noteId, state: 'lost', message });
    this.bus.publish('recording.warning', { message });
  }

  // the stretch of the timeline the tab stream did not cover is a record of the note (evidence), so it can be told later
  tabGapEnds(a, tab) {
    const t0 = Math.max(0, tab.gapStart), t1 = Math.max(t0, this.elapsed(a));
    tab.gapStart = null;
    try { this.evidence?.add(a.noteId, [{ kind: 'stream', source: 'tab', key: 'tab-gap', name: '', t0, t1, weight: 0, meta: { reason: 'the call\'s tab stopped sending audio; the computer\'s own capture covered it' } }]); } catch { /* a record, never a reason to lose audio */ }
  }

  // Audio arriving from the renderer capture bridge (macOS/Windows).
  pushPcm(noteId, ch, buf) {
    const a = this.active;
    if (!a || a.noteId !== noteId) return false;
    const src = a.channels[ch];
    if (!(src instanceof PushSource)) return false;
    src.push(buf);
    return true;
  }

  // The spool for a channel, created on first audio; null when the after-recording speaker pass is off or unavailable.
  spoolFor(a, ch) {
    if (a.spool[ch] !== undefined) return a.spool[ch];
    a.spool[ch] = null;
    const s = this.settings.all();
    if (this.spoolDir && this.speakers && s.speakerDetection && (s.speakerDiarize || s.speakerRefine)) {
      try { a.spool[ch] = new Spool(this.spoolDir, a.noteId, ch); } catch { /* no disk: embeddings alone still work */ }
    }
    if (a.spool[ch] && s.speakerDiarize && s.speakerPipeline === 'owned' && !this.diarization.run) this.followSpool(a, ch, s); // an injected diarizer (tests, eval) is the one used
    return a.spool[ch];
  }

  // The owned diarization pipeline follows the spool while recording (a niced worker, one thread): each 10 s window is
  // segmented and embedded as soon as it is complete, so Stop only clusters; a window with two people at once is
  // reported right away (recording.overlap).
  followSpool(a, ch, s) {
    const m = this.models;
    if (!['mic', 'system'].includes(ch) || !m.segmentationInstalled?.() || !m.speakerInstalled?.()) return;
    try {
      a.live = a.live || {};
      a.live[ch] = new LiveDiarizer({
        file: a.spool[ch].file, segmentation: m.segmentationPath(), embedding: m.speakerPath(), threads: 1, finishThreads: s.asrThreads,
        onOverlap: (o) => this.onLiveOverlap(a, ch, o),
        onWarning: (msg) => this.bus.publish('recording.warning', { message: `live speaker analysis (${ch}): ${msg}` }),
      });
    } catch (e) { a.live[ch] = null; this.bus.publish('recording.warning', { message: `live speaker analysis: ${e.message}` }); }
  }

  // Two or more people at once on a channel (seconds of spool) -> on the note timeline, for the live view.
  onLiveOverlap(a, ch, { start, end }) {
    if (this.active !== a) return;
    for (const t of toTimeline([{ start, end, speaker: 0 }], a.stretches[ch] || [])) {
      a.overlaps = a.overlaps || [];
      a.overlaps.push({ channel: ch, startMs: t.startMs, endMs: t.endMs });
      this.bus.publish('recording.overlap', { noteId: a.noteId, channel: ch, startMs: t.startMs, endMs: t.endMs });
    }
  }

  onPcm(a, ch, buf) {
    if (this.active !== a || a.paused || a.finalizing) return;
    if (a.test && ch === 'system') { a.test.system(buf); return; } // a speaker test: the mixed sound only goes to disk
    if (ch === 'mic' && a.micMuted) buf = Buffer.alloc(buf.length);   // muted: what the microphone hears goes no further; the timeline carries on in silence
    const spool = this.spoolFor(a, ch);
    if (a.fed[ch] === 0) {
      a.epoch[ch] = Math.max(0, this.elapsed(a) - Math.round((buf.length / 2 / 16000) * 1000));
      a.base[ch] = spool ? spool.samples : 0; // where this stretch of audio starts in the spool
      a.stretches[ch].push({ at: a.base[ch], ms: a.epoch[ch] });
      a.env[ch].begin(a.epoch[ch]);
    }
    a.env[ch].push(buf);
    a.fed[ch] += buf.length / 2;
    this.engine.feed(ch, buf);
    spool?.write(buf); // after the engine: capturing and transcribing always come first
    const lk = ch === 'mic' ? 'mic' : 'system'; // a person on Discord counts towards the "them" level
    const level = rms(buf);
    a.level[lk] = Math.max(a.level[lk], level);
    if (lk === 'system') this.watchSystemSilence(a, level);
    const now = Date.now();
    if (now - a.lastLevel >= 120) {
      a.lastLevel = now;
      this.bus.publish('recording.level', { noteId: a.noteId, mic: a.level.mic, system: a.level.system, elapsedMs: this.elapsed(a) });
      a.level = { mic: 0, system: 0 };
    }
  }

  // macOS hands a tap that has no permission nothing but silence, without an error: the recording looks healthy and only the
  // microphone is transcribed. If the computer's own audio has not made a sound for a while, say what to check, once.
  watchSystemSilence(a, level) {
    if (a.sysWarned || this.platform.id !== 'darwin') return;
    const now = Date.now();
    a.sysSince ??= now;
    if (level > SYSTEM_HEARD) { a.sysWarned = true; return; }   // it works
    if (now - a.sysSince < SYSTEM_SILENT_MS) return;
    a.sysWarned = true;
    const message = 'Nothing has played on this computer for 30 seconds, so the other people on the call are not being transcribed. If they are talking, macOS is blocking the capture: System Settings → Privacy & Security → Screen & System Audio Recording → under "System Audio Recording Only" switch WhisperBrain on (press + to add it if it is not listed), then quit and reopen WhisperBrain.';
    a.warnings.push(`system: ${message}`);
    this.bus.publish('recording.warning', { message });
  }

  // The final text of an utterance: whatever happens to it (saved, dropped as an echo), its draft line is over.
  onSegment(seg) {
    const a = this.active;
    if (!a) return;
    try { this.saveSegment(a, seg); } finally { this.clearDraft(a, seg.ch); }
  }

  saveSegment(a, { ch, startMs, endMs, text, embedding, words, logProbMean, logProbMin }) {
    const remote = a.remote.get(ch);
    const kind = remote ? 'system' : ch; // a person on Discord is "them", handled like the system channel
    const speaker = remote ? 'them' : (SPEAKER[ch] || ch);
    const seg = { speaker, startMs: Math.max(0, a.epoch[ch] + startMs), endMs: Math.max(0, a.epoch[ch] + endMs), text };
    if (this.settings.get('echoDedupe')) {
      if (kind === 'mic') {
        const sys = this.notes.segments(a.noteId).filter((x) => x.speaker === 'them');
        if (sys.some((x) => isEcho(seg, x))) { a.echoDropped.text++; return; }
        if (micSegmentIsEnergyEcho(a.env.mic, a.env.system, seg)) { a.echoDropped.energy++; return; }
      } else {
        const echoes = this.notes.segments(a.noteId).filter((x) => x.speaker === 'me' && isEcho(x, seg));
        if (echoes.length) {
          this.notes.removeSegments(a.noteId, echoes.map((x) => x.id));
          this.bus.publish('transcript.removed', { noteId: a.noteId, ids: echoes.map((x) => x.id) });
        }
      }
    }
    seg.speakerId = remote ? remote.speakerId : this.identify(a, ch, seg, embedding);
    if (seg.speakerId && !remote) a.last[ch] = { id: seg.speakerId, endMs: seg.endMs };
    else if (embedding && !remote) a.last[ch] = null; // a voice nobody matched: the next line without a print must not be handed to the speaker before it
    const [saved] = this.notes.addSegments(a.noteId, [{ ...seg, channel: ch, embedding, words, logProbMean, logProbMin }]);
    const spool = a.spool[ch];
    if (spool && !spool.broken) {
      const ref = { segId: saved.id, ch, from: a.base[ch] + Math.round(startMs * 16), to: a.base[ch] + Math.round(endMs * 16) };
      a.refs.push(ref);
      if (this.settings.get('speakerRefine')) this.describeSoon(a, ref);
    }
    const d = this.lineLabel(a, seg.speakerId, speaker);
    if (kind === 'system') a.recentSystem = [...a.recentSystem.filter((x) => x.endMs > seg.endMs - 15000), { startMs: seg.startMs, endMs: seg.endMs, text }].slice(-8);
    this.bus.publish('transcript.segment', { noteId: a.noteId, segment: { id: saved.id, speaker, speakerId: seg.speakerId, label: d.label, labelKind: d.kind, displayNo: d.n, speakerName: d.kind === 'name' ? d.label : '', startMs: seg.startMs, endMs: seg.endMs, text } });
  }

  // What a line is called on screen right now (speakers/display.js). When that brings a voice on show, the lines already drawn
  // are told to rename themselves. Without a speaker store a line is just Me or Them.
  lineLabel(a, speakerId, speaker) {
    if (!this.speakers) return describe(new Map(), { speaker });
    const shown = this.speakers.display(a.noteId, this.settings.get('userName'));
    if (shown.shown !== a.shown) { a.shown = shown.shown; this.bus.publish('speakers.updated', { noteId: a.noteId }); }
    return shown.of(speakerId, speaker);
  }

  // Describe an utterance's voice (pitch, timbre: about 25 ms of work) in the gaps while recording, one at a time with
  // a pause between, so that Stop has less left to do. Same function, same audio, same result as describing it at Stop.
  describeSoon(a, ref) {
    a.describeQueue.push(ref);
    if (a.describing) return;
    a.describing = true;
    const step = () => {
      const r = a.describeQueue.shift();
      if (!r || this.active !== a || a.finalizing) { a.describing = false; return; }
      try {
        const f = describeUtterance((ch, from, to) => a.spool[ch]?.read(from, to) ?? null, r);
        if (f) a.acoustic.set(r.segId, f);
      } catch { /* Stop describes it */ }
      setTimeout(step, 20); // capture and the screen come first
    };
    setTimeout(step, 50);
  }

  // Draft words of the utterance in progress on one channel (a 'partial' from the engine). They are published for the
  // screen only: nothing here touches the database, the voice clusterers or the after-recording speaker pass, and the
  // line carries no speaker identity beyond the channel (Me / Them). text '' means the draft is over.
  onPartial({ ch, text, startMs }) {
    const a = this.active;
    const speaker = SPEAKER[ch];
    if (!a || !speaker || !a.draft?.requested) return;
    if (!text) { this.clearDraft(a, ch); return; }
    if (a.paused || a.finalizing || !this.settings.get('liveDraft')) return;
    const abs = Math.max(0, a.epoch[ch] + startMs);
    let d = a.drafts[ch];
    if (!d || d.startMs !== abs) d = a.drafts[ch] = { startMs: abs, text: '', shown: false, echo: false };
    d.text = text;
    if (ch === 'mic' && !d.echo && this.settings.get('echoDedupe')) {
      const verdict = this.judgeMicDraft(a, d);
      if (verdict === 'echo') d.echo = true; // sticky: the rest of this utterance is the same sound
      else if (verdict === 'wait') return;
    }
    if (d.echo) { if (d.shown) { d.shown = false; this.bus.publish('transcript.partial', { noteId: a.noteId, ch, speaker, startMs: abs, text: '' }); } return; }
    d.shown = true;
    this.bus.publish('transcript.partial', { noteId: a.noteId, ch, speaker, startMs: abs, text });
  }

  clearDraft(a, ch) {
    const d = a.drafts?.[ch];
    if (!d) return;
    a.drafts[ch] = null;
    if (d.shown) this.bus.publish('transcript.partial', { noteId: a.noteId, ch, speaker: SPEAKER[ch], startMs: d.startMs, text: '' });
  }

  // Would this mic draft be dropped as an echo of the system audio once it is final? 'echo' (hide it), 'ok' (show it) or
  // 'wait' (the system channel is speaking but there is not enough mic audio yet to compare the two loudness contours).
  // Uses the same two tests as the final segment: words repeated from what the system channel just said (its recent
  // final segments and its own draft), and a mic loudness contour that follows the system audio's.
  judgeMicDraft(a, d) {
    const now = this.elapsed(a);
    const mic = { startMs: d.startMs, endMs: now, text: d.text };
    const sys = a.drafts.system ? [...a.recentSystem, { startMs: a.drafts.system.startMs, endMs: now, text: a.drafts.system.text }] : a.recentSystem;
    if (sys.some((x) => isEcho(mic, x))) return 'echo';
    const from = Math.max(d.startMs + 400, now - 8000); // the draft starts ~0.4 s before the speech does (pre-roll)
    const to = now - 250;                               // the comparison also looks 200 ms past the end
    if (micSegmentIsEnergyEcho(a.env.mic, a.env.system, { startMs: from, endMs: to })) return 'echo';
    if (to - from < DRAFT_ECHO_WAIT_MS && a.env.system.window(now - 1000, now).some((db) => db > DRAFT_ECHO_ACTIVE_DB)) return 'wait';
    return 'ok';
  }

  // Decode what each channel still holds and close it, so the next audio starts a new stretch. Resume and Stop wait for a
  // settle in progress (a.settling): audio fed into a channel that is about to be reset would be lost, and its times wrong.
  settle(a) {
    if (a.settling) return a.settling;
    a.settling = (async () => {
      await Promise.all([...a.remote.values()].map((r) => r.chain)).catch(() => {}); // audio from Discord that is still queued goes in first
      await Promise.all([...Object.keys(a.channels), ...a.remote.keys()].map(async (ch) => {
        try { await this.engine.flush(ch); } catch (e) { this.bus.publish('recording.warning', { message: e.message }); }
        this.engine.reset(ch);
        a.fed[ch] = 0;
      }));
    })().finally(() => { a.settling = null; });
    return a.settling;
  }

  // Stop recording what the user says, and start again, without stopping the meeting: the microphone's audio is replaced by silence
  // before the recognizer, the speaker pass or the audio kept for it ever see it. The other side goes on as ever. A new recording
  // starts unmuted. Asking for the state it already has changes nothing and says nothing. -> the status
  setMicMuted(muted) {
    const a = this.active;
    if (!a) throw new RecordingError('idle', 'No recording in progress.');
    if (!a.channels.mic) throw new RecordingError('no-mic', 'The microphone is not part of this recording.');
    if (a.finalizing || a.micMuted === !!muted) return this.status();
    a.micMuted = !!muted;
    this.bus.publish('recording.mic-muted', { noteId: a.noteId, muted: a.micMuted });
    return this.status();
  }

  async pause() {
    const a = this.active;
    if (!a || a.paused || a.finalizing || a.starting) return this.status();
    a.accMs += Date.now() - a.resumedAt;
    a.paused = true;
    await this.settle(a);
    this.bus.publish('recording.paused', { noteId: a.noteId });
    return this.status();
  }

  // Synchronous unless a pause is still flushing: then it waits for that first (see settle).
  async resume() {
    const a = this.active;
    if (!a || !a.paused) return this.status();
    if (a.settling) {
      await a.settling;
      if (this.active !== a || !a.paused || a.finalizing) return this.status();
    }
    a.paused = false;
    a.resumedAt = Date.now();
    this.bus.publish('recording.resumed', { noteId: a.noteId });
    return this.status();
  }

  async stop() {
    const a = this.active;
    if (!a) throw new RecordingError('idle', 'No recording in progress.');
    if (a.starting) { // still starting: cancel it (start() closes what it opened) and wait until it has
      a.cancelled = true;
      await a.started;
      if (this.active !== a) return { noteId: a.noteId, durationMs: 0, cancelled: true, note: this.notes.get(a.noteId) };
    }
    if (a.finalizing) return this.status();
    if (!a.paused) a.accMs += Date.now() - a.resumedAt;
    a.finalizing = true;
    a.stage = 'transcribing';
    this.bus.publish('recording.finalizing', { noteId: a.noteId, stage: a.stage });
    for (const src of Object.values(a.channels)) src.stop();
    this.closeTab(a);
    this.leaveDiscord(a);
    if (a.test) { try { const t = a.test.close(); this.bus.publish('recording.speaker-test', { noteId: a.noteId, ...t }); } catch (e) { this.bus.publish('recording.warning', { message: `speaker test: ${e.message}` }); } }
    a.meet?.detach(); // nothing the meeting window shows after Stop belongs to this recording
    try { await a.settling; await this.settle(a); } catch (e) { this.bus.publish('recording.warning', { message: e.message }); }
    if (this.speakers) {
      const s = this.settings.all();
      const threshold = this.sameVoiceThreshold();
      let diarized = [];
      // The capture is over, so the heavy listening happens now: who spoke when over the whole meeting, word by word.
      if (a.refs.length) {
        a.stage = 'speakers';
        this.bus.publish('recording.finalizing', { noteId: a.noteId, stage: a.stage });
        if (s.speakerDiarize) diarized = await this.diarize(a, s);
        // the owned pipeline does not over-split like sherpa's clustering, which the acoustic pass is there to repair; on AMI IS1009a it
        // joined two real people (WDER 17.3 -> 31.4, eval/README.md), so it is skipped for channels the owned pipeline diarized
        if (s.speakerRefine && !(s.speakerPipeline === 'owned' && diarized.length)) { // acoustic second look (pitch, timbre): merges speakers the clustering over-split, see eval/README.md
          try { await refineNote({ speakers: this.speakers, noteId: a.noteId, refs: a.refs, read: (ch, from, to) => a.spool[ch]?.read(from, to) ?? null, threshold, settled: [...a.settled], described: a.acoustic }); } catch (e) { this.bus.publish('recording.warning', { message: `speaker analysis: ${e.message}` }); }
        }
      }
      try { const open = ['mic', 'system'].filter((ch) => !diarized.includes(ch)); this.speakers.consolidate(a.noteId, threshold, { channels: open }); this.speakers.placeUnlabelled(a.noteId, threshold, { channels: [...open, ...(a.keptLive || [])] }); this.speakers.autoMatch(a.noteId); } catch (e) { this.bus.publish('recording.warning', { message: `speaker identification: ${e.message}` }); }
      if (a.meet) this.nameFromMeeting(a, s); // last: it must not overrule a saved voice the speaker was just matched to
    }
    this.closeSpools(a);
    this.active = null;
    this.bus.live?.delete(a.noteId); // the voices are final now: all of them are shown
    Promise.resolve(this.engine.releaseHotwords?.()).catch(() => {}); // the next recording brings its own words
    Promise.resolve(this.engine.setDraft?.(null)).catch(() => {}); // and its own drafts: nothing streams between recordings
    const note = this.notes.update(a.noteId, { status: 'done', endedAt: Date.now() });
    this.notes.reindex(a.noteId);
    const call = a.meet?.call();
    if (call) this.bus.publish('recording.call', { noteId: a.noteId, ...call });   // which platform the call was on, for what is fetched from it afterwards
    this.bus.publish('recording.stopped', { noteId: a.noteId, durationMs: a.accMs });
    return { noteId: a.noteId, durationMs: a.accMs, note };
  }

  // The voice model before the current one, when saved voices made with it exist and it is still installed: the speakers' prints are
  // then also made with it, so those voices are recognised, and gain a print of the current model when remembered again.
  // -> { path, id } or null
  altVoiceModel() {
    const m = this.models;
    if (!this.speakers?.hasPrintsOf || !m.legacySpeakerInstalled?.() || m.speakerPath() === m.legacySpeakerPath()) return null;
    return this.speakers.hasPrintsOf(LEGACY_MODEL_ID) ? { path: m.legacySpeakerPath(), id: LEGACY_MODEL_ID } : null;
  }

  // Diarize each channel's spool on its own (mic and system audio are never clustered together) and relabel this
  // recording's words. Needs the segmentation and voice models; without them the live labels stand.
  // -> the channels that were diarized
  async diarize(a, s) {
    const m = this.models;
    const done = [];
    if (!m.segmentationInstalled?.() || !m.speakerInstalled?.()) return done;
    const note = this.notes.get(a.noteId);
    const attendees = s.speakerCountHint ? note?.attendees : null;
    const alt = this.altVoiceModel();
    for (const ch of Object.keys(a.spool)) {
      const spool = a.spool[ch];
      if (!spool || spool.broken || !spool.samples) continue;
      const refs = a.refs.filter((r) => r.ch === ch);
      // the number of others on the call the user gave is forced on the system audio; the calendar is only a hint
      const told = ch === 'system' && note?.speakerCount ? { numSpeakers: note.speakerCount } : null;
      // ...then the call's own list of people, which is better than the invitation: it says who actually joined
      const joined = !told && ch === 'system' && s.meet.headcount ? a.meet?.expectedVoices() : null;
      const expected = told ? null : (joined || expectedSpeakers({ attendees, channel: ch }));
      if (told || expected) a.settled.add(ch); // the head count is known: the acoustic pass must not change how many speakers there are
      // how many voices the live labels heard on the system audio (never more than the call's list of people): if the clustering
      // collapses to one voice it cuts for this many instead, and if it still finds one the live labels stand (final.js)
      const fallback = ch === 'system' && !told ? this.liveVoices(a, refs, ch) : 0;
      try {
        const live = a.live?.[ch]?.failed ? null : a.live?.[ch]; // a follower that failed to start: the one-shot below does the whole spool
        const run = live ? (o) => live.finish({ samples: spool.samples, numSpeakers: o.numSpeakers || 0, fallbackSpeakers: o.fallbackSpeakers || 0, altEmbedding: o.altEmbedding || null })
          : s.speakerPipeline === 'owned' && !this.diarization.run ? diarizeOwned : this.diarization.run;
        const out = await diarizeChannel({
          diarize: run, notes: this.notes, speakers: this.speakers, noteId: a.noteId, channel: ch,
          source: { file: spool.file }, stretches: a.stretches[ch], segIds: refs.map((r) => r.segId),
          segmentation: m.segmentationPath(), embedding: m.speakerPath(), altEmbedding: alt?.path, altModel: alt?.id, threads: s.asrThreads, options: { ...(expected ? { expected } : {}), ...(fallback >= 2 ? { fallbackSpeakers: fallback } : {}), ...told, ...this.diarization },
        });
        // utterances that were cut keep pointing at their own audio, for the acoustic pass that may follow
        for (const [id, parts] of out?.splits || []) {
          const ref = refs.find((r) => r.segId === id);
          const origin = ref && parts[0].startMs;
          if (!ref) continue;
          a.refs = a.refs.filter((r) => r !== ref).concat(parts.map((p) => ({ segId: p.id, ch, from: ref.from + Math.round((p.startMs - origin) * 16), to: ref.from + Math.round((p.endMs - origin) * 16) })));
        }
        if (out?.collapsed) {
          a.keptLive = [...(a.keptLive || []), ch];
          this.bus.publish('recording.warning', { message: `Speaker analysis heard a single voice where the recording had ${out.expected}: the voices told apart while recording are kept.` });
        }
        if (out) done.push(ch);
      } catch (e) { this.bus.publish('recording.warning', { message: `speaker diarization (${ch}): ${e.message}` }); }
    }
    return done;
  }

  // How many voices with real speech the live labels gave this recording's utterances on a channel (final.js liveVoiceCount),
  // capped by the call's list of people when it has one: the people in a channel bound who can have spoken. 0 when under two.
  liveVoices(a, refs, ch) {
    const ids = new Set(refs.map((r) => r.segId));
    const mine = this.notes.segmentWords(a.noteId).filter((s) => ids.has(s.id) && s.speaker === (ch === 'mic' ? 'me' : 'them'));
    let n = Math.min(liveVoiceCount(mine), 10);
    const heads = a.meet?.expectedVoices?.({ max: 100 });
    if (heads) n = Math.min(n, heads);
    return n >= 2 ? n : 0;
  }

  // Names for the voices of the system audio from who the meeting window highlighted while each spoke. Best effort and
  // never over a name the user typed or a saved voice a speaker matched. Runs after the speaker passes, so it names the
  // voices the recording ended with. The names first fix the voices (one person heard as two, two heard as one), then
  // name them, then teach the saved voices the ones that were named beyond doubt.
  nameFromMeeting(a, s) {
    try {
      const m = s.meet;
      const startedAt = Date.now();
      const invited = invitedNames(this.notes.get(a.noteId)?.attendees);
      const run = () => a.meet.vote(this.notes.segmentWords(a.noteId), { endMs: a.accMs, candidates: invited });
      let res = run();
      const fixed = m.refine ? this.fixVoicesFromMeeting(a, res) : { merged: 0, moved: 0 };
      if (fixed.merged || fixed.moved) res = run();
      const named = [], conflicts = [];
      const accounts = a.meet.accounts();   // who the platform says each name is, where its ids are accounts
      for (const n of res.named) {
        const source = n.via === 'sole' ? 'meeting:roster' : n.from === 'caption' ? 'meeting:caption' : 'meeting:highlight';
        const r = this.speakers.nameFromMeeting(a.noteId, n.speakerId, n.name, { source, confidence: n.score ?? n.share });
        if (r === 'named' || r === 'agrees') { named.push(n); const acct = accounts.get(nameKey(n.name)); if (acct) this.speakers.setAccount(a.noteId, n.speakerId, acct); } else if (r === 'conflict') conflicts.push(n.speakerId);
      }
      let learned = 0;
      if (m.learnVoices) for (const n of named) if (n.via === 'vote' && n.ms >= LEARN_MS && n.share >= LEARN_SHARE && this.speakers.learnFromMeeting(a.noteId, n.speakerId, { consent: true })) learned++;
      try {
        // this recording's highlights and captions are new; the roster is the latest one, and replaces the earlier
        const rows = a.meet.toEvidence({ endMs: a.accMs });
        this.evidence?.add(a.noteId, rows.filter((r) => r.kind === 'highlight' || r.kind === 'caption'));
        this.evidence?.replace(a.noteId, ['roster'], rows.filter((r) => r.kind === 'roster'));
      } catch { /* a record, never a reason to fail the stop */ }
      this.recordInvitation(a);
      a.meetResult = { ...a.meet.summary(), named: named.map((n) => ({ speakerId: n.speakerId, name: n.name, via: n.via })), unresolved: res.unresolved.length, conflicts, learned, lagMs: res.lagMs, tookMs: Date.now() - startedAt, ...fixed };
      if (named.length || a.meetResult.events || a.meetResult.roster) this.bus.publish('recording.meet-names', { noteId: a.noteId, ...a.meetResult });
    } catch (e) { this.bus.publish('recording.warning', { message: `meeting names: ${e.message}` }); }
  }

  // Join voices that are one person and split voices that are two, where the call's names say so strongly.
  fixVoicesFromMeeting(a, res) {
    const out = { merged: 0, moved: 0 };
    const mine = a.meet.mine(this.notes.segmentWords(a.noteId));
    const plan = planCorrections({ speech: speechOf(mine), utterances: mine, active: res.active, vote: res });
    for (const mg of plan.merges) if (this.speakers.mergeSpeakers(a.noteId, mg.from, mg.into)) out.merged++;
    const fresh = new Map(); // a name that no voice has yet -> the new voice made for it
    for (const mv of plan.moves) {
      if (!this.speakers.forNote(a.noteId).some((x) => x.speakerId === mv.from)) continue;
      let to = mv.to;
      if (!to) { to = fresh.get(mv.name); if (!to) { to = this.speakers.freeSpeakerId(a.noteId, 'system'); fresh.set(mv.name, to); } }
      if (this.speakers.reassignSegment(a.noteId, mv.id, to)) out.moved++;
    }
    return out;
  }

  // ---- Discord ----
  // Joins the voice channel you are in, if the bot is set up and you are in one. Never stops a recording: when it cannot
  // join, the ordinary system audio carries the call as before. -> true when the bot is in the call.
  async joinDiscord(a, s, micWanted) {
    if (!this.discord || !s.discord?.enabled || !s.discord.token) return false;
    try {
      // your own voice is the microphone channel; the bot would only hear it a second time
      const info = await this.discord.join({ skipUserIds: micWanted && s.discord.userId ? [s.discord.userId] : [], timeoutMs: 8000 });
      if (!info) return false;
      const onAudio = (ev) => this.onDiscordAudio(a, ev);
      this.discord.on('audio', onAudio);
      const onWarning = (w) => this.bus.publish('recording.warning', { message: w.message });
      this.discord.on('warning', onWarning);
      a.discord = { info, onAudio, onWarning };
      this.bus.publish('recording.discord', { noteId: a.noteId, ...info });
      return true;
    } catch (e) {
      this.bus.publish('recording.warning', { message: `Discord: ${e.message}. Recording the computer's audio instead.` });
      return false;
    }
  }

  leaveDiscord(a) {
    const d = a.discord;
    if (!d) return;
    a.discord = null;
    this.discord.off('audio', d.onAudio);
    this.discord.off('warning', d.onWarning);
    try { this.discord.leave(); } catch { /* already out */ }
  }

  // One chunk of one person's voice. Each person is an ordinary channel for the engine ('dc:<id>': its own voice-activity
  // detector), and a speaker named from the start, so no voice guessing is needed. Chunks of one person are handled in order.
  onDiscordAudio(a, { userId, name, pcm, ts }) {
    if (this.active !== a || a.paused || a.finalizing) return;
    try { a.test?.person(userId, name, pcm, ts); } catch (e) { this.bus.publish('recording.warning', { message: `speaker test: ${e.message}` }); }
    const ch = `dc:${userId}`;
    let r = a.remote.get(ch);
    if (!r) {
      r = { userId, name, speakerId: `d${userId}`, t0: null, chain: Promise.resolve() };
      a.remote.set(ch, r);
      a.spool[ch] = null; // no raw audio is kept for these: each person is already known, so there is nothing for the after-recording speaker pass to do
      a.fed[ch] = 0; a.epoch[ch] = 0; a.base[ch] = 0; a.stretches[ch] = []; a.env[ch] = new EnergyEnvelope();
      try { this.speakers?.ensureNamed(a.noteId, r.speakerId, name, 'system', { account: `discord:${userId}` }); } catch { /* the label falls back to the id */ }
      try {
        const key = nameKey(name);
        if (!this.evidence?.forNote(a.noteId, { kind: 'stream' }).some((e) => e.key === key && e.meta?.userId === String(userId))) this.evidence?.add(a.noteId, [{ kind: 'stream', source: 'discord', key, name, t0: this.elapsed(a), weight: 1, meta: { userId: String(userId), speakerId: r.speakerId } }]);
      } catch { /* evidence is a record, never a reason to lose audio */ }
    }
    r.chain = r.chain.then(() => this.feedDiscord(a, ch, r, pcm, ts)).catch((e) => this.bus.publish('recording.warning', { message: `Discord audio: ${e.message}` }));
  }

  async feedDiscord(a, ch, r, pcm, ts) {
    if (this.active !== a || a.paused || a.finalizing) return;
    const ms = pcm.length / 32;
    if (a.fed[ch] === 0 || r.t0 === null) r.t0 = ts - ms; // the first audio of a stretch fixes where it sits on the clock
    else {
      const gap = (ts - ms - r.t0) - a.fed[ch] / 16;     // how long this person was silent since the last chunk
      if (gap > REMOTE_RESET_MS) {
        await this.engine.flush(ch);
        this.engine.reset(ch);
        a.fed[ch] = 0;
        r.t0 = ts - ms;
      } else if (gap > REMOTE_GAP_MS) {
        for (let left = Math.round(gap * 16); left > 0; left -= 16000) this.onPcm(a, ch, Buffer.alloc(Math.min(left, 16000) * 2));
      }
    }
    this.onPcm(a, ch, pcm);
  }

  closeSpools(a) {
    for (const l of Object.values(a.live || {})) { try { l?.stop(); } catch { /* gone */ } }
    for (const sp of Object.values(a.spool)) { try { sp?.close(); } catch { /* best effort */ } }
  }

  closeTab(a) {
    const tab = a.tab;
    if (!tab) return;
    clearInterval(tab.timer); tab.timer = null;
    if (tab.gapStart !== null) this.tabGapEnds(a, tab);
    tab.live = false;
  }

  teardown(a) { this.closeTab(a); for (const src of Object.values(a.channels)) { try { src.stop(); } catch { /* ignore */ } } this.leaveDiscord(a); try { a.test?.close(); } catch { /* best effort */ } a.meet?.detach(); this.closeSpools(a); }
}

module.exports = { RecordingManager, RecordingError };
