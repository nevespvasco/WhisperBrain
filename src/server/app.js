'use strict';
// Composition root: wires the stores, services and adapters together. No HTTP in here, so the same object is
// used by the Electron main process, the headless CLI and the tests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('../core/db');
const { Bus } = require('../core/events');
const { Notes } = require('../core/notes');
const { Settings } = require('../core/settings');
const { Templates } = require('../core/templates');
const { Models, recommend } = require('../asr/models');
const { AsrEngine } = require('../asr/engine');
const { termsForNote } = require('../asr/vocabulary');
const { RecordingManager } = require('../recording/manager');
const { LlmClient } = require('../llm/client');
const { AiService } = require('../llm/service');
const { Calendar } = require('../meetings/calendar');
const { MeetingDetector } = require('../meetings/detector');
const { Dictation } = require('../dictation/dictation');
const { createPlatform } = require('../platform');
const { Speakers } = require('../speakers/store');
const { Account } = require('../core/account');
const { Knowledge } = require('../knowledge/store');
const { toMeeting } = require('../knowledge/meeting');
const { Importer } = require('../knowledge/importer');
const { Integrations } = require('../integrations/service');
const { GoogleCalendar } = require('../meetings/google');
const { DiscordVoice } = require('../discord/bot');
const { MeetService } = require('../meet/service');
const { Evidence } = require('../meet/evidence');
const { nameFromTranscript, isLocalServer, LiveNames } = require('../speakers/transcript-names');
const { Translator } = require('../llm/translate');
const { LlmScheduler } = require('../llm/scheduler');
const { Briefings } = require('../knowledge/briefings');
const { AssistantService } = require('../assistant/service');

const NAMES_TIMEOUT_MS = 90000;   // names from the conversation must not hold the notes back if the AI hangs
const { loadPolicy } = require('../core/policy');
const { buildSetup, which } = require('../platform/setup');
const { TranscriptService } = require('../transcripts/service');
const { SemanticIndex, HashEmbedder } = require('../search/semantic');
const { JobQueue } = require('../jobs/queue');
const { JobRunner } = require('../jobs/runner');

function createApp({ dataDir, platform, modelsDir, clipboard, version = '0.0.0', detect = false, openExternal = null, renderPdf = null, discordLibs = null, captureWindow = null, secretBox = null, policy = loadPolicy(), permissions = () => ({}) } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true });
  const bus = new Bus();
  const conn = db.open(path.join(dataDir, 'whisperbrain.sqlite'), { allowExtension: true });   // only so that sqlite-vec can be loaded once, on purpose
  const notes = new Notes(conn, bus);
  const settings = new Settings(conn, bus, secretBox, policy);
  const templates = new Templates(conn);
  const speakers = new Speakers(conn, bus);
  const evidence = new Evidence(conn);
  speakers.enabled = () => settings.get('voiceprints');
  const semantic = new SemanticIndex({ db: conn, notes, embedder: new HashEmbedder() });
  semantic.enabled = () => settings.get('semanticSearch');
  const models = new Models(modelsDir || path.join(dataDir, 'models'), { bus });
  const engine = new AsrEngine({ speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
  const plat = platform || createPlatform({ clipboard });
  const llm = new LlmClient(() => settings.get('llm'));
  // One queue in front of the AI server for every feature: the live assistant first, then chat, summaries, translation, background work
  const scheduler = new LlmScheduler(llm);
  const knowledge = new Knowledge({ db: conn, notes, settings, bus });
  const briefings = new Briefings({ db: conn, bus });
  const ai = new AiService({ notes, templates, settings, llm: scheduler.client('chat'), bus, knowledge });
  const translator = new Translator({ notes, settings, llm: scheduler.client('translation'), bus });
  translator.attach();   // live translation while recording, and the catch-up after Stop
  const discord = new DiscordVoice({ getConfig: () => settings.get('discord'), libs: discordLibs });
  const meet = new MeetService({ settings, bus, version, llm: scheduler.client('background'), captureWindow, isRecording: () => recording.status().active, platformId: plat.id === 'fake' ? process.platform : plat.id, dataDir, roots: [path.join(__dirname, '..', '..', 'build'), path.join(__dirname, '..', '..', 'native'), process.resourcesPath ? path.join(process.resourcesPath, '') : ''].filter(Boolean) });
  const recording = new RecordingManager({ notes, engine, models, settings, platform: plat, bus, speakers, discord, meet: meet.hub, evidence, spoolDir: path.join(dataDir, 'spool'), vocabulary: (id) => termsForNote({ notes, speakers, knowledge, settings, briefings }, id) });
  const assistant = new AssistantService({ db: conn, notes, settings, bus, llm: scheduler, knowledge, briefings });
  assistant.attach();   // live help while recording (off until switched on in Settings → Assistant)
  const google = new GoogleCalendar({ getConfig: () => settings.get('google'), saveConfig: (p) => settings.update({ google: { ...settings.get('google'), ...p } }) });
  const calendar = new Calendar({ settings, bus, google });
  const detector = new MeetingDetector({ platform: plat, calendar, bus, settings, recording, notes, signals: meet.hub });
  const dictation = new Dictation({ platform: plat, engine, models, settings, bus });
  const account = new Account({ db: conn, notes, settings, speakers, models, dataDir, bus, knowledge, semantic });

  // May the AI read a transcript to name voices? (the setting, and for 'auto' an AI server on this computer)
  const namesFromTranscriptAllowed = () => ai.configured() && (settings.get('speakerNamesFromTranscript') === 'on' || (settings.get('speakerNamesFromTranscript') === 'auto' && isLocalServer(settings.get('llm').baseUrl)));
  // ...and the same while the meeting is still going, for the voices that have no name yet
  new LiveNames({ notes, speakers, evidence, llm: scheduler.client('background'), bus, allowed: () => settings.get('speakerDetection') && namesFromTranscriptAllowed(), userName: () => settings.get('userName') }).attach();

  // Background work lives in the jobs table (src/jobs), so quitting midway loses nothing: what was running is run again at the
  // next start. When a recording ends: names from the conversation → the summary (if auto-enhance is on) → topics, glossary
  // and action items. Each step is its own job and queues the next one; each is safe to run twice. Failures are reported as
  // before (a warning or a "failed" event) and the chain goes on, exactly like the in-memory version it replaces.
  const jobs = new JobQueue(conn, { bus });
  const runner = new JobRunner({ queue: jobs, onError: (job, err) => bus.publish('job.error', { id: job?.id ?? null, kind: job?.kind ?? null, message: err.message }) });
  const NEXT = { 'note.names': 'note.summarize', 'note.summarize': 'note.insights' };
  const chain = (step, noteId, payload, enqueue) => { if (NEXT[step]) enqueue(NEXT[step], { noteId, ...payload }, { key: noteId }); };
  runner.register('note.names', async ({ noteId }, { enqueue }) => {
    if (!notes.get(noteId)) return { skipped: 'deleted' };
    // first, so the notes already say who is who: names from what people said (never replaces one somebody typed)
    if (namesFromTranscriptAllowed()) {
      try { const r = await nameFromTranscript({ notes, speakers, evidence, llm: scheduler.client('background'), userName: settings.get('userName'), signal: AbortSignal.timeout(NAMES_TIMEOUT_MS) }, noteId); if (r.named.length) notes.reindex(noteId); } catch (err) { bus.publish('recording.warning', { message: `names from the conversation: ${err.message}` }); }
    }
    chain('note.names', noteId, {}, enqueue);
    return null;
  });
  runner.register('note.summarize', async ({ noteId }, { enqueue }) => {
    if (!notes.get(noteId)) return { skipped: 'deleted' };
    if (settings.get('autoSummarize')) {
      try {
        bus.publish('note.summarizing', { id: noteId });
        await ai.summarize(noteId);
      } catch (err) {
        bus.publish('note.summarize-failed', { id: noteId, message: err.message });
      }
    }
    chain('note.summarize', noteId, { local: !settings.get('autoSummarize') || !ai.configured() }, enqueue);
    return null;
  });
  runner.register('note.insights', async ({ noteId, local }) => {
    if (!notes.get(noteId)) return { skipped: 'deleted' };
    await analyze(noteId, { local: !!local });
    return null;
  });
  bus.subscribe((e) => {
    if (e.type !== 'recording.stopped') return;
    if (!notes.get(e.data.noteId)) return;
    runner.enqueue('note.names', { noteId: e.data.noteId }, { key: e.data.noteId });
  });

  // Topics/glossary/action items for a note; never throws (it is background work).
  async function analyze(id, { local = false } = {}) {
    if (!settings.get('autoInsights') && !local) return null;
    try { return await ai.insights(id, { local }); } catch (err) { bus.publish('note.insights-failed', { id, message: err.message }); return null; }
  }

  const self = {};
  const importer = new Importer(self);
  const integrations = new Integrations({ app: self });

  // Enhanced notes → push to the tools set to receive them automatically.
  bus.subscribe((e) => { if (e.type === 'note.insights' && e.data.mode === 'llm') integrations.autoExport(e.data.id).catch(() => {}); });

  // Calendar meetings marked "capture" (or all of them) start recording by themselves when they begin.
  bus.subscribe(async (e) => {
    if (e.type !== 'meeting.starting') return;
    const mode = settings.get('captureCalendar');
    const ev = e.data.event;
    if (mode === 'off' || recording.status().active) return;
    if (mode === 'selected' && !knowledge.eventPrefs()[ev.id]) return;
    try {
      const n = notes.create({ title: ev.summary || '', eventUid: ev.uid, eventStart: ev.start, attendees: (ev.attendees || []).map((a) => ({ name: a.name, email: a.email })), source: 'recorded', templateId: settings.get('defaultTemplate') });
      if (ev.url) knowledge.addLink(n.id, { kind: 'calendar', url: ev.url, title: 'Meeting link' });
      await recording.start(n.id);
      bus.publish('meeting.autostarted', { noteId: n.id, platform: null, event: ev });
    } catch (err) { bus.publish('meeting.autostart-failed', { message: err.message }); }
  });

  // Keep the bot logged in while it is switched on, so that joining a call at the start of a recording is quick; sign it
  // out when it is switched off or the token changes. Real Discord only: skipped when a test supplies stand-in libraries.
  const warmDiscord = () => {
    const c = settings.get('discord');
    if (c.enabled && c.token) discord.login().catch((e) => bus.publish('discord.error', { message: e.message }));
    else if (discord.client && !recording.status().active) discord.logout().catch(() => {});
  };
  const ready = settings.init();
  // Work that reads secrets (the extension's pairing token, the Discord token) starts once they are opened.
  // Meetings older than the retention limit (set by an organisation's policy) are deleted at start and then every day
  const sweep = () => { try { account.applyRetention({ days: settings.get('retentionDays') }); } catch (e) { bus.publish('account.error', { message: `retention: ${e.message}` }); } };
  ready.then(sweep).catch(() => {});
  ready.then(() => runner.start()).catch(() => {});   // after the secrets are open: the steps may call the AI server
  // Search by meaning is opt-in: the index is only built, and the extension only loaded, when it is on
  const wantSemantic = () => settings.get('semanticSearch') && !semantic.available && semantic.init().catch(() => {});
  ready.then(wantSemantic).catch(() => {});
  bus.subscribe((e) => {
    if (e.type === 'settings' && e.data.keys.includes('semanticSearch')) wantSemantic();
    if (e.type === 'note.insights' && semantic.available && settings.get('semanticSearch')) semantic.indexNote(e.data.id).catch(() => {});
  });
  const retentionTimer = detect ? setInterval(sweep, 86400000) : null;
  retentionTimer?.unref();
  if (detect) ready.then(() => { detector.start(); warmDiscord(); meet.sync(); meet.watch(bus); }).catch(() => {});
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('meet')) meet.sync(); });
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('discord')) warmDiscord(); });

  const app = Object.assign(self, {
    version, dataDir, importer, integrations, google, bus, db: conn, jobs, runner, notes, speakers, evidence, semantic, settings, templates, models, engine, platform: plat, llm, scheduler, ai, translator, briefings, assistant, recording, calendar, detector, dictation, account,
    knowledge, analyze, openExternal, renderPdf, discord, meet,
    ready,                       // resolves when the secrets are opened: await it before anything reads an API key
    settled: Promise.resolve(),  // after close(): resolves once the last sealed write is on disk
    meeting: (id, opts) => toMeeting({ notes, knowledge, speakers, settings, translator }, id, opts),
    // What this computer still needs before recording works as it should (src/platform/setup.js); `permissions` comes from the host app
    async setup() {
      const probeLlm = async () => {
        const cfg = settings.get('llm');
        const out = { baseUrl: cfg.baseUrl, model: cfg.model, reachable: false, models: [] };
        if (!cfg.baseUrl) return out;
        let timer;
        try {
          out.models = await Promise.race([llm.listModels(), new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), 2500); })]);
          out.reachable = true;
        } catch { /* nothing answers there */ } finally { clearTimeout(timer); }
        return out;
      };
      const [caps, perms] = await Promise.all([plat.capabilities(), Promise.resolve().then(() => permissions()).catch(() => ({}))]);
      return buildSetup({
        platform: plat.id, caps, perms, has: (cmd) => which(cmd, process.platform), osRelease: os.release(),
        models: { speech: !!models.resolve(settings.get('asrModel')), vad: models.vadInstalled(), speaker: models.speakerInstalled() && models.segmentationInstalled() },
        llm: await probeLlm(),
      });
    },
    async state() {
      const caps = await plat.capabilities();
      const model = models.resolve(settings.get('asrModel'));
      return {
        version, platform: plat.id, capture: plat.capture, capabilities: caps,
        recording: recording.status(), dictation: dictation.status(),
        model: model ? { id: model.id } : null,
        modelAdvice: recommend({ language: settings.get('asrLanguage') === 'auto' ? settings.get('language') : settings.get('asrLanguage') }),
        vadInstalled: models.vadInstalled(), speakerModel: models.speakerInstalled() && models.segmentationInstalled(),
        speakerModelMB: (models.speakerInstalled() ? 0 : models.speaker.sizeMB) + (models.segmentationInstalled() ? 0 : models.segmentation.sizeMB),
        llmConfigured: !!settings.get('llm').baseUrl,
        stats: { ...notes.stats(), ...knowledge.stats() },
        sources: notes.sourceCounts(),
        detector: typeof detector.status === 'function' ? detector.status() : null,
        pdf: !!renderPdf,
        secrets: settings.secretStatus(),
        policy: { managed: settings.publicView().managed, problems: policy.problems, file: policy.file },
      };
    },
    close() {
      self.pendingGoogleAuth?.cancel?.();
      runner.stop();   // takes no new job; one cut short by the closing database runs again at the next start
      detector.stop();
      assistant.close();
      clearInterval(retentionTimer);
      meet.close().catch(() => {});
      discord.logout().catch(() => {});
      engine.stop();
      const closeDb = () => { try { conn.close(); } catch { /* already closed */ } };
      self.settled = settings.box ? settings.flush().then(closeDb) : (closeDb(), Promise.resolve());   // a sealed write may still be queued
    },
  });
  app.transcripts = new TranscriptService({ app });   // the platforms' own transcripts (src/transcripts)
  return app;
}

module.exports = { createApp };
