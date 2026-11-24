'use strict';
const { PushSource } = require('../audio/source');
const { rms } = require('../audio/pcm');
const { isEcho, micSegmentIsEnergyEcho } = require('../audio/echo');
const { EnergyEnvelope } = require('../audio/envelope');
const { SpeakerTracker } = require('../speakers/cluster');
const { refineNote } = require('../speakers/refine');
const { diarizeChannel } = require('../speakers/final');
const { expectedSpeakers } = require('../speakers/hint');
const { Spool } = require('./spool');

const VOICE_MATCH = 0.65;     // similarity needed to recognise a saved voice
const CARRY_MS = 3000;        // a short utterance without a usable embedding inherits the previous speaker within this gap
const DRAFT_ECHO_ACTIVE_DB = -50; // the system channel counts as speaking above this level (same as the echo check's)
const DRAFT_ECHO_WAIT_MS = 700;   // a mic draft needs this much audio before the loudness comparison can call it an echo

const SPEAKER = { mic: 'me', system: 'them' };

class RecordingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Owns the one active recording: wires capture sources -> ASR engine -> transcript store, and keeps the
// timeline correct across pauses. Channels are 'mic' (speaker "me") and 'system' (speaker "them").
class RecordingManager {
  // spoolDir: where raw audio is parked for the after-recording speaker pass (omit to skip that pass).
  // vocabulary: (noteId) => terms the meeting is likely to say (attendees, glossary, speaker names) for hotword biasing.
  // diarization: { run, threshold, windowShift, tolerance } overrides for the after-recording diarization (tests, the eval harness).
  constructor({ notes, engine, models, settings, platform, bus, speakers = null, spoolDir = null, vocabulary = null, diarization = {} }) {
    Object.assign(this, { notes, engine, models, settings, platform, bus, speakers, spoolDir, vocabulary, diarization });
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
      elapsedMs: this.elapsed(a), channels: Object.keys(a.channels), needsRenderer: a.rendererChannels,
      echo: { cancellation: a.aec ? { ...a.aec } : null, dropped: { ...a.echoDropped } },
      draft: a.draft ? { on: a.draft.on, reason: a.draft.reason || null } : { on: false, reason: null },
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
      env: { mic: new EnergyEnvelope(), system: new EnergyEnvelope() }, aec: null, echoDropped: { text: 0, energy: 0 },
      stretches: { mic: [], system: [] }, // per channel: where each stretch of audio (start, resume) begins in the spool and on the timeline
      draft: null,                         // { requested, on, reason }: live draft captions for this recording (see applyDraft)
      drafts: { mic: null, system: null }, // the draft line on each channel right now: { startMs, text, shown, echo }. Never stored.
      settled: new Set(),                  // channels whose number of speakers is known (user or calendar): refine keeps it
      recentSystem: [],                    // the last few final system segments, to tell a mic draft that merely echoes them
    };
    try {
      await this.ensureEngine();
      await this.applyVocabulary(noteId);
      this.applyDraft(a); // loads in the worker's queue ahead of the first audio; the recording does not wait for it
      a.resumedAt = Date.now();
      const cap = this.platform.capture;
      for (const ch of ['mic', 'system']) {
        if (!want[ch]) continue;
        try {
          let src;
          if (cap[ch] === 'native') {
            src = ch === 'mic' ? await this.openMic(s) : await this.platform.createSystemSource();
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
      }
      if (!Object.keys(a.channels).length) throw new RecordingError('no-source', 'No audio source could be started.');
      this.notes.update(noteId, { status: 'recording', startedAt: note.startedAt || Date.now() });
      for (const src of Object.values(a.channels)) src.start();
      this.bus.publish('recording.started', { noteId, channels: Object.keys(a.channels), needsRenderer: a.rendererChannels, echoCancellation: a.aec });
      if (a.rendererChannels.length) this.bus.publish('capture.request', { noteId, channels: a.rendererChannels });
      return this.status();
    } catch (e) {
      this.teardown(a);
      this.active = null;
      throw e;
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
    const r = tr.assign(embedding);
    const sp = tr.speakers.find((x) => x.id === r.id);
    this.speakers.save(a.noteId, { speakerId: r.id, channel: ch, centroid: sp.centroid, count: sp.count });
    // recognise saved voices as soon as a speaker appears, and again once we have heard them a bit more
    if (r.isNew || sp.count === 3 || sp.count === 8) this.speakers.autoMatch(a.noteId);
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
    if (this.spoolDir && this.speakers && s.speakerDetection && (s.speakerDiarize || s.speakerRefine)) {
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
      a.stretches[ch].push({ at: a.base[ch], ms: a.epoch[ch] });
      a.env[ch].begin(a.epoch[ch]);
    }
    a.env[ch].push(buf);
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

  // The final text of an utterance: whatever happens to it (saved, dropped as an echo), its draft line is over.
  onSegment(seg) {
    const a = this.active;
    if (!a) return;
    try { this.saveSegment(a, seg); } finally { this.clearDraft(a, seg.ch); }
  }

  saveSegment(a, { ch, startMs, endMs, text, embedding, words, logProbMean, logProbMin }) {
    const speaker = SPEAKER[ch] || ch;
    const seg = { speaker, startMs: Math.max(0, a.epoch[ch] + startMs), endMs: Math.max(0, a.epoch[ch] + endMs), text };
    if (this.settings.get('echoDedupe')) {
      if (ch === 'mic') {
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
    seg.speakerId = this.identify(a, ch, seg, embedding);
    if (seg.speakerId) a.last[ch] = { id: seg.speakerId, endMs: seg.endMs };
    const [saved] = this.notes.addSegments(a.noteId, [{ ...seg, embedding, words, logProbMean, logProbMin }]);
    const spool = a.spool[ch];
    if (spool && !spool.broken) a.refs.push({ segId: saved.id, ch, from: a.base[ch] + Math.round(startMs * 16), to: a.base[ch] + Math.round(endMs * 16) });
    const label = seg.speakerId ? this.speakers.label(a.noteId, seg.speakerId, speaker) : (speaker === 'me' ? 'Me' : 'Them');
    if (ch === 'system') a.recentSystem = [...a.recentSystem.filter((x) => x.endMs > seg.endMs - 15000), { startMs: seg.startMs, endMs: seg.endMs, text }].slice(-8);
    this.bus.publish('transcript.segment', { noteId: a.noteId, segment: { id: saved.id, speaker, speakerId: seg.speakerId, label, startMs: seg.startMs, endMs: seg.endMs, text } });
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
      const s = this.settings.all();
      const threshold = s.speakerThreshold;
      let diarized = [];
      // The capture is over, so the heavy listening happens now: who spoke when over the whole meeting, word by word.
      if (a.refs.length) {
        a.stage = 'speakers';
        this.bus.publish('recording.finalizing', { noteId: a.noteId, stage: a.stage });
        if (s.speakerDiarize) diarized = await this.diarize(a, s);
        if (s.speakerRefine) { // acoustic second look (pitch, timbre): merges speakers the clustering over-split, see eval/README.md
          try { await refineNote({ speakers: this.speakers, noteId: a.noteId, refs: a.refs, read: (ch, from, to) => a.spool[ch]?.read(from, to) ?? null, threshold, settled: [...a.settled] }); } catch (e) { this.bus.publish('recording.warning', { message: `speaker analysis: ${e.message}` }); }
        }
      }
      try { this.speakers.consolidate(a.noteId, threshold, { channels: ['mic', 'system'].filter((ch) => !diarized.includes(ch)) }); this.speakers.autoMatch(a.noteId); } catch (e) { this.bus.publish('recording.warning', { message: `speaker identification: ${e.message}` }); }
    }
    this.closeSpools(a);
    this.active = null;
    Promise.resolve(this.engine.releaseHotwords?.()).catch(() => {}); // the next recording brings its own words
    Promise.resolve(this.engine.setDraft?.(null)).catch(() => {}); // and its own drafts: nothing streams between recordings
    const note = this.notes.update(a.noteId, { status: 'done', endedAt: Date.now() });
    this.notes.reindex(a.noteId);
    this.bus.publish('recording.stopped', { noteId: a.noteId, durationMs: a.accMs });
    return { noteId: a.noteId, durationMs: a.accMs, note };
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
    for (const ch of Object.keys(a.spool)) {
      const spool = a.spool[ch];
      if (!spool || spool.broken || !spool.samples) continue;
      const refs = a.refs.filter((r) => r.ch === ch);
      // the number of others on the call the user gave is forced on the system audio; the calendar is only a hint
      const told = ch === 'system' && note?.speakerCount ? { numSpeakers: note.speakerCount } : null;
      const expected = told ? null : expectedSpeakers({ attendees, channel: ch });
      if (told || expected) a.settled.add(ch); // the head count is known: the acoustic pass must not change how many speakers there are
      try {
        const out = await diarizeChannel({
          diarize: this.diarization.run, notes: this.notes, speakers: this.speakers, noteId: a.noteId, channel: ch,
          source: { file: spool.file }, stretches: a.stretches[ch], segIds: refs.map((r) => r.segId),
          segmentation: m.segmentationPath(), embedding: m.speakerPath(), threads: s.asrThreads, options: { ...(expected ? { expected } : {}), ...told, ...this.diarization },
        });
        // utterances that were cut keep pointing at their own audio, for the acoustic pass that may follow
        for (const [id, parts] of out?.splits || []) {
          const ref = refs.find((r) => r.segId === id);
          const origin = ref && parts[0].startMs;
          if (!ref) continue;
          a.refs = a.refs.filter((r) => r !== ref).concat(parts.map((p) => ({ segId: p.id, ch, from: ref.from + Math.round((p.startMs - origin) * 16), to: ref.from + Math.round((p.endMs - origin) * 16) })));
        }
        if (out) done.push(ch);
      } catch (e) { this.bus.publish('recording.warning', { message: `speaker diarization (${ch}): ${e.message}` }); }
    }
    return done;
  }

  closeSpools(a) { for (const sp of Object.values(a.spool)) { try { sp?.close(); } catch { /* best effort */ } } }

  teardown(a) { for (const src of Object.values(a.channels)) { try { src.stop(); } catch { /* ignore */ } } this.closeSpools(a); }
}

module.exports = { RecordingManager, RecordingError };
