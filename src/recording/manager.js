'use strict';
const { PushSource } = require('../audio/source');
const { rms } = require('../audio/pcm');
const { isEcho } = require('../audio/echo');
const { SpeakerTracker } = require('../speakers/cluster');
const { refineNote } = require('../speakers/refine');
const { Spool } = require('./spool');

const VOICE_MATCH = 0.65;     // similarity needed to recognise a saved voice
const CARRY_MS = 3000;        // a short utterance without a usable embedding inherits the previous speaker within this gap

const SPEAKER = { mic: 'me', system: 'them' };

class RecordingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Owns the one active recording: wires capture sources -> ASR engine -> transcript store, and keeps the
// timeline correct across pauses. Channels are 'mic' (speaker "me") and 'system' (speaker "them").
class RecordingManager {
  // spoolDir: where raw audio is parked for the after-recording speaker pass (omit to skip that pass).
  constructor({ notes, engine, models, settings, platform, bus, speakers = null, spoolDir = null }) {
    Object.assign(this, { notes, engine, models, settings, platform, bus, speakers, spoolDir });
    if (spoolDir) Spool.sweep(spoolDir);
    this.active = null;
    this.engine.on('segment', (s) => this.onSegment(s));
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
      elapsedMs: this.elapsed(a), channels: Object.keys(a.channels), needsRenderer: a.rendererChannels,
    };
  }

  elapsed(a = this.active) {
    if (!a) return 0;
    return a.accMs + (a.paused || a.finalizing ? 0 : Date.now() - a.resumedAt);
  }

  async ensureEngine() {
    const s = this.settings.all();
    const model = this.models.resolve(s.asrModel);
    if (!model) throw new RecordingError('no-model', 'No speech model is installed. Download one in Settings → Transcription.');
    if (!this.models.vadInstalled()) throw new RecordingError('no-model', 'The voice-activity model is missing. Re-download a speech model in Settings.');
    // The voice model is loaded whenever it is installed, so the worker is the same whoever starts it; this recording
    // only decides whether embeddings are computed. Nothing is flowing yet, so it may replace a worker with other options.
    const speakerModel = this.models.speakerInstalled?.() ? this.models.speakerPath() : null;
    this.engine.configure?.({ embeddings: !!(s.speakerDetection && this.speakers) });
    await this.engine.start(model, { vadPath: this.models.vadPath(), threads: s.asrThreads, language: s.asrLanguage, speakerModel, allowRestart: true });
    return model;
  }

  async start(noteId, { mic, system } = {}) {
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
      noteId, channels: {}, paused: false, finalizing: false, accMs: prior ? prior + 1000 : 0, resumedAt: Date.now(), epoch: { mic: 0, system: 0 },
      fed: { mic: 0, system: 0 }, spool: {}, base: { mic: 0, system: 0 }, refs: [], rendererChannels: [], trackers: this.makeTrackers(noteId, s.speakerThreshold), last: {}, lastLevel: 0, level: { mic: 0, system: 0 }, warnings: [],
    };
    try {
      await this.ensureEngine();
      a.resumedAt = Date.now();
      const cap = this.platform.capture;
      for (const ch of ['mic', 'system']) {
        if (!want[ch]) continue;
        try {
          let src;
          if (cap[ch] === 'native') {
            src = ch === 'mic' ? this.platform.createMicSource({ device: s.micDevice }) : await this.platform.createSystemSource();
          } else {
            src = new PushSource();
            a.rendererChannels.push(ch);
          }
          if (!src) throw new Error(`${ch} capture is not available on this system`);
          this.attach(a, ch, src);
        } catch (e) {
          if (!want.mic || !want.system || Object.keys(a.channels).length) {
            a.warnings.push(`${ch}: ${e.message}`);
            this.bus.publish('recording.warning', { message: `${ch}: ${e.message}` });
          } else throw e;
        }
      }
      if (!Object.keys(a.channels).length) throw new RecordingError('no-source', 'No audio source could be started.');
      this.notes.update(noteId, { status: 'recording', startedAt: note.startedAt || Date.now() });
      for (const src of Object.values(a.channels)) src.start();
      this.bus.publish('recording.started', { noteId, channels: Object.keys(a.channels), needsRenderer: a.rendererChannels });
      if (a.rendererChannels.length) this.bus.publish('capture.request', { noteId, channels: a.rendererChannels });
      return this.status();
    } catch (e) {
      this.teardown(a);
      this.active = null;
      throw e;
    }
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
    const r = tr.assign(embedding);
    const sp = tr.speakers.find((x) => x.id === r.id);
    this.speakers.save(a.noteId, { speakerId: r.id, channel: ch, centroid: sp.centroid, count: sp.count });
    // recognise saved voices as soon as a speaker appears, and again once we have heard them a bit more
    if (r.isNew || sp.count === 3 || sp.count === 8) this.speakers.autoMatch(a.noteId, VOICE_MATCH);
    if (r.isNew) this.bus.publish('speakers.updated', { noteId: a.noteId });
    return r.id;
  }

  attach(a, ch, src) {
    a.channels[ch] = src;
    src.on('pcm', (buf) => this.onPcm(a, ch, buf));
    src.on('error', (e) => {
      this.bus.publish('recording.warning', { message: `${ch}: ${e.message}` });
    });
    src.on('end', () => {
      if (this.active === a && !a.finalizing && !(src instanceof PushSource)) {
        this.bus.publish('recording.warning', { message: `${ch} capture ended unexpectedly` });
      }
    });
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
    if (this.spoolDir && this.speakers && s.speakerDetection && s.speakerRefine) {
      try { a.spool[ch] = new Spool(this.spoolDir, a.noteId, ch); } catch { /* no disk: embeddings alone still work */ }
    }
    return a.spool[ch];
  }

  onPcm(a, ch, buf) {
    if (this.active !== a || a.paused || a.finalizing) return;
    const spool = this.spoolFor(a, ch);
    if (a.fed[ch] === 0) {
      a.epoch[ch] = Math.max(0, this.elapsed(a) - Math.round((buf.length / 2 / 16000) * 1000));
      a.base[ch] = spool ? spool.samples : 0; // where this stretch of audio starts in the spool
    }
    a.fed[ch] += buf.length / 2;
    this.engine.feed(ch, buf);
    spool?.write(buf); // after the engine: capturing and transcribing always come first
    a.level[ch] = Math.max(a.level[ch], rms(buf));
    const now = Date.now();
    if (now - a.lastLevel >= 120) {
      a.lastLevel = now;
      this.bus.publish('recording.level', { noteId: a.noteId, mic: a.level.mic, system: a.level.system, elapsedMs: this.elapsed(a) });
      a.level = { mic: 0, system: 0 };
    }
  }

  onSegment({ ch, startMs, endMs, text, embedding, words, logProbMean, logProbMin }) {
    const a = this.active;
    if (!a) return;
    const speaker = SPEAKER[ch] || ch;
    const seg = { speaker, startMs: Math.max(0, a.epoch[ch] + startMs), endMs: Math.max(0, a.epoch[ch] + endMs), text };
    if (this.settings.get('echoDedupe')) {
      if (ch === 'mic') {
        const sys = this.notes.segments(a.noteId).filter((x) => x.speaker === 'them');
        if (sys.some((x) => isEcho(seg, x))) return;
      } else {
        const echoes = this.notes.segments(a.noteId).filter((x) => x.speaker === 'me' && isEcho(x, seg));
        if (echoes.length) {
          this.notes.removeSegments(a.noteId, echoes.map((x) => x.id));
          this.bus.publish('transcript.removed', { noteId: a.noteId, ids: echoes.map((x) => x.id) });
        }
      }
    }
    seg.speakerId = this.identify(a, ch, seg, embedding);
    if (seg.speakerId) a.last[ch] = { id: seg.speakerId, endMs: seg.endMs };
    const [saved] = this.notes.addSegments(a.noteId, [{ ...seg, embedding, words, logProbMean, logProbMin }]);
    const spool = a.spool[ch];
    if (spool && !spool.broken) a.refs.push({ segId: saved.id, ch, from: a.base[ch] + Math.round(startMs * 16), to: a.base[ch] + Math.round(endMs * 16) });
    const label = seg.speakerId ? this.speakers.label(a.noteId, seg.speakerId, speaker) : (speaker === 'me' ? 'Me' : 'Them');
    this.bus.publish('transcript.segment', { noteId: a.noteId, segment: { id: saved.id, speaker, speakerId: seg.speakerId, label, startMs: seg.startMs, endMs: seg.endMs, text } });
  }

  async settle(a) {
    await Promise.all(Object.keys(a.channels).map(async (ch) => {
      await this.engine.flush(ch);
      this.engine.reset(ch);
      a.fed[ch] = 0;
    }));
  }

  async pause() {
    const a = this.active;
    if (!a || a.paused || a.finalizing) return this.status();
    a.accMs += Date.now() - a.resumedAt;
    a.paused = true;
    await this.settle(a);
    this.bus.publish('recording.paused', { noteId: a.noteId });
    return this.status();
  }

  resume() {
    const a = this.active;
    if (!a || !a.paused) return this.status();
    a.paused = false;
    a.resumedAt = Date.now();
    this.bus.publish('recording.resumed', { noteId: a.noteId });
    return this.status();
  }

  async stop() {
    const a = this.active;
    if (!a) throw new RecordingError('idle', 'No recording in progress.');
    if (a.finalizing) return this.status();
    if (!a.paused) a.accMs += Date.now() - a.resumedAt;
    a.finalizing = true;
    a.stage = 'transcribing';
    this.bus.publish('recording.finalizing', { noteId: a.noteId, stage: a.stage });
    for (const src of Object.values(a.channels)) src.stop();
    try { await this.settle(a); } catch (e) { this.bus.publish('recording.warning', { message: e.message }); }
    if (this.speakers) {
      const threshold = this.settings.get('speakerThreshold');
      try {
        // The capture is over, so the heavy listening happens now: pitch and timbre of every utterance, on top of the voice model.
        if (a.refs.length) {
          a.stage = 'speakers';
          this.bus.publish('recording.finalizing', { noteId: a.noteId, stage: a.stage });
          await refineNote({ speakers: this.speakers, noteId: a.noteId, refs: a.refs, read: (ch, from, to) => a.spool[ch]?.read(from, to) ?? null, threshold });
        }
      } catch (e) { this.bus.publish('recording.warning', { message: `speaker analysis: ${e.message}` }); }
      try { this.speakers.consolidate(a.noteId, threshold); this.speakers.autoMatch(a.noteId, VOICE_MATCH); } catch (e) { this.bus.publish('recording.warning', { message: `speaker identification: ${e.message}` }); }
    }
    this.closeSpools(a);
    this.active = null;
    const note = this.notes.update(a.noteId, { status: 'done', endedAt: Date.now() });
    this.notes.reindex(a.noteId);
    this.bus.publish('recording.stopped', { noteId: a.noteId, durationMs: a.accMs });
    return { noteId: a.noteId, durationMs: a.accMs, note };
  }

  closeSpools(a) { for (const sp of Object.values(a.spool)) { try { sp?.close(); } catch { /* best effort */ } } }

  teardown(a) { for (const src of Object.values(a.channels)) { try { src.stop(); } catch { /* ignore */ } } this.closeSpools(a); }
}

module.exports = { RecordingManager, RecordingError };
