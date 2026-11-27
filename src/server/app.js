'use strict';
// Composition root: wires the stores, services and adapters together. No HTTP in here, so the same object is
// used by the Electron main process, the headless CLI and the tests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('../core/db');
const { Bus } = require('../core/events');
const { byFile: byVoiceModelFile } = require('../speakers/voice-models');
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
const { DiscordRpc } = require('../discord/rpc');
const { DiscordRpcSource } = require('../discord/rpc-source');
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
const { AiRuns } = require('../audit/ai-runs');
const { ChunkIndex } = require('../search/index');
const { LlmEmbedder } = require('../search/embedder');
const { mayReachAi } = require('../items/policy');
const { Assertions } = require('../brain/assertions');
const { extractAssertions } = require('../brain/extract');
const { Reminders } = require('../brain/reminders');
const { Briefs } = require('../brain/brief');
const { Inbox } = require('../brain/inbox');
const { Reviews } = require('../brain/review');
const { Supersession } = require('../brain/supersede');
const { Projects } = require('../brain/projects');
const { Rules } = require('../brain/rules');
const { AppLock } = require('../core/lock');
const ocrTools = require('../importers/ocr');
const { Actions, HANDLERS: ACTION_HANDLERS } = require('../brain/actions');
const { backupTo, list: listBackups } = require('../core/backup');
const gh = require('../connectors/github'), slackSvc = require('../connectors/slack'), discordSvc = require('../connectors/discord'), gmailSvc = require('../connectors/gmail'), pollSvc = require('../connectors/poll');
const { ItemStore } = require('../items/store');
const { SourceManager } = require('../connectors/manager');
const { pdfToText } = require('../importers/pdf');

function createApp({ connectorOptions = {}, dataDir, platform, modelsDir, clipboard, version = '0.0.0', detect = false, openExternal = null, renderPdf = null, discordLibs = null, captureWindow = null, secretBox = null, policy = loadPolicy(), permissions = () => ({}) } = {}) {
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
  // the store tags and judges voice prints by the model that makes them: follow what is installed (and what a download changes)
  const syncVoiceModel = () => { const vm = byVoiceModelFile(models.speakerPath()); if (vm) speakers.useModel(vm); };
  syncVoiceModel();
  bus.subscribe((e) => { if (e.type === 'model.installed') syncVoiceModel(); });
  const engine = new AsrEngine({ speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
  const plat = platform || createPlatform({ clipboard });
  const llm = new LlmClient(() => settings.get('llm'));
  // One queue in front of the AI server for every feature: the live assistant first, then chat, summaries, translation, background work
  const aiRuns = new AiRuns(conn);
  const scheduler = new LlmScheduler(llm, { onRun: (r) => aiRuns.record(r) });   // every AI call is noted (never its text): the egress log
  const knowledge = new Knowledge({ db: conn, notes, settings, bus });
  const briefings = new Briefings({ db: conn, bus });
  const ai = new AiService({ notes, templates, settings, llm: scheduler.client('chat'), bus, knowledge });
  const translator = new Translator({ notes, settings, llm: scheduler.client('translation'), bus });
  translator.attach();   // live translation while recording, and the catch-up after Stop
  const discord = new DiscordVoice({ getConfig: () => settings.get('discord'), libs: discordLibs });
  const meet = new MeetService({ settings, bus, version, llm: scheduler.client('background'), captureWindow, isRecording: () => recording.status().active, onTabAudio: (c) => recording.acceptTabAudio(c), platformId: plat.id === 'fake' ? process.platform : plat.id, dataDir, roots: [path.join(__dirname, '..', '..', 'build'), path.join(__dirname, '..', '..', 'native'), process.resourcesPath ? path.join(process.resourcesPath, '') : ''].filter(Boolean) });
  // Discord's local RPC: which call the person is in, who is in it and who speaks (no bot). Its saved tokens come back through settings.
  const discordRpc = new DiscordRpc({ getConfig: () => settings.get('discordRpc'), saveTokens: (tk) => settings.update({ discordRpc: { ...settings.get('discordRpc'), ...tk } }) });
  const discordRpcSource = new DiscordRpcSource({ hub: meet.hub, rpc: discordRpc });
  const recording = new RecordingManager({ notes, engine, models, settings, platform: plat, bus, speakers, discord, meet: meet.hub, evidence, spoolDir: path.join(dataDir, 'spool'), vocabulary: (id) => termsForNote({ notes, speakers, knowledge, settings, briefings }, id) });
  const assistant = new AssistantService({ db: conn, notes, settings, bus, llm: scheduler, knowledge, briefings });
  assistant.attach();   // live help while recording (off until switched on in Settings → Assistant)
  const google = new GoogleCalendar({ getConfig: () => settings.get('google'), saveConfig: (p) => settings.update({ google: { ...settings.get('google'), ...p } }), ...(connectorOptions.google || {}) });
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
  runner.register('note.insights', async ({ noteId, local }, { enqueue }) => {
    if (!notes.get(noteId)) return { skipped: 'deleted' };
    await analyze(noteId, { local: !!local });
    if (settings.get('autoAssertions') && ai.configured()) enqueue('note.assertions', { noteId }, { key: noteId, maxAttempts: 2 });
    return null;
  });
  bus.subscribe((e) => {
    if (e.type !== 'recording.stopped') return;
    if (!notes.get(e.data.noteId)) return;
    runner.enqueue('note.names', { noteId: e.data.noteId }, { key: e.data.noteId });
  });

  // Decisions, commitments, reminders, the brief before a meeting and the Inbox (src/brain). The AI only ever SUGGESTS: each finding
  // carries the exact words it rests on, checked in code against the transcript, and waits for a person.
  const reminders = new Reminders({ db: conn, bus });
  const assertions = new Assertions({ db: conn, notes, entities: knowledge.entities, settings, reminders, bus });
  runner.register('note.assertions', async ({ noteId }) => {
    if (!notes.get(noteId)) return { skipped: 'deleted' };
    if (!ai.configured()) return { skipped: 'no AI server' };
    return extractAssertions({ notes, knowledge, llm: scheduler.client('background'), assertions, settings }, noteId);
  });
  // Items and sources (src/items, src/connectors): every meeting is also an item, and folders/vaults are sources. Their work runs
  // in its own lane, so a big vault being read never holds up the summary of a meeting.
  const items = new ItemStore(conn, { bus });
  const connectorCtx = { settings, get google() { return google; }, get integrations() { return integrations; }, get app() { return self; }, fetchImpl: connectorOptions.fetchImpl, bases: connectorOptions.bases || {}, sleep: connectorOptions.sleep };
  // OCR for scanned PDFs, only where pdftoppm and tesseract are installed (checked once, the first time a PDF has no text)
  let ocrReady = null;
  const ocr = async (buf) => { ocrReady ??= (connectorOptions.ocrExec ? { available: true } : await ocrTools.available()); if (!ocrReady.available) throw new Error(ocrReady.reason); return ocrTools.ocrPdf(buf, { lang: settings.get('ocrLanguages'), exec: connectorOptions.ocrExec }); };
  const sources = new SourceManager({ items, runner, bus, pdfToText: (buf) => pdfToText(buf), ocr, watch: detect, services: { github: gh, slack: slackSvc, discord: discordSvc, gmail: gmailSvc, notion: pollSvc.notion, linear: pollSvc.linear }, ctx: connectorCtx });
  const tick = () => new Promise((r) => setImmediate(r));

  // The search index over meetings and items (src/search/index.js): words always, meaning when an embedding model is set.
  const embedder = new LlmEmbedder({ getConfig: () => settings.get('llm'), getModel: () => settings.get('embeddingModel') });
  const chunkIndex = new ChunkIndex({ db: conn, notes, items, embedder });
  // what may be shown to the AI server in use: a private source only to a server on this computer
  const mayShare = (kind, id) => {
    if (kind !== 'item') return true;
    const it = items.item(id);
    return !!it && mayReachAi(items.source(it.sourceId), settings.get('llm'));
  };
  ai.index = chunkIndex; ai.mayShare = mayShare;
  const briefs = new Briefs({ notes, entities: knowledge.entities, assertions, index: chunkIndex, mayShare });
  const projects = new Projects({ db: conn, notes, items, assertions });
  const supersession = new Supersession({ db: conn, assertions });
  const actions = new Actions({ db: conn, bus, handlers: ACTION_HANDLERS, deps: { settings, get integrations() { return integrations; } } });
  const rules = new Rules({ db: conn, assertions, actions, reminders, notes, bus });
  rules.attach();
  const inbox = new Inbox({ notes, assertions, entities: knowledge.entities, reminders, items, db: conn, actions, supersession, projects });
  const reviews = new Reviews({ db: conn, notes, assertions, entities: knowledge.entities, items, inbox });
  runner.register('index.sync', async () => {
    let total = 0;
    for (;;) { const r = chunkIndex.syncBatch(40); total += r.done; if (!r.done || !r.left) break; await tick(); }
    let embedded = 0;
    for (let i = 0; i < 500; i++) { const r = await chunkIndex.embedPending({ batch: 16, mayEmbed: mayShare }); embedded += r.embedded; if (!r.embedded || r.left <= 0) break; await tick(); }
    return { indexed: total, embedded };
  }, { lane: 'sources' });
  // Housekeeping, once a day while the app runs: old finished jobs and AI-call records go, people who may be the same are looked for, the
  // database statistics are refreshed. Nothing here changes what you see except by removing what is long finished.
  runner.register('maintenance', async () => {
    const out = { jobs: jobs.prune(), aiRuns: aiRuns.prune(), pruned: 0 };
    knowledge.entities.proposeMerges();
    try { conn.exec('PRAGMA optimize'); } catch { /* busy: next time */ }
    return out;
  }, { lane: 'sources' });
  const maintenanceTimer = detect ? setInterval(() => runner.enqueue('maintenance', {}, { key: 'daily', maxAttempts: 1 }), 86400000) : null;
  maintenanceTimer?.unref();
  const wantIndex = () => { try { runner.enqueue('index.sync', {}, { key: 'all', runAfter: 1500, maxAttempts: 2 }); } catch { /* closing */ } };
  bus.subscribe((e) => {
    if (['sources.changed', 'note.insights', 'note.updated', 'speakers.updated', 'recording.stopped', 'transcript.removed', 'import.done'].includes(e.type)) wantIndex();
    if (e.type === 'settings' && (e.data.keys.includes('embeddingModel') || e.data.keys.includes('llm'))) wantIndex();
  });
  runner.register('items.backfill', async () => { let n = 0, c; while ((c = items.backfillNotes(200))) { n += c; await tick(); } return { notes: n }; }, { lane: 'sources' });
  runner.register('entities.backfill', async ({ after = 0 }) => { let cur = after; for (;;) { const next = knowledge.entities.backfillBatch(cur, 100); if (next == null) break; cur = next; await tick(); } return {}; }, { lane: 'sources' });
  bus.subscribe((e) => {
    if (e.type !== 'note.created' && e.type !== 'note.updated') return;
    try { items.syncNote(e.data.id); } catch { /* the meeting is gone already */ }
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
  const lock = new AppLock({ db: conn, bus });
  const ready = settings.init();
  // Work that reads secrets (the extension's pairing token, the Discord token) starts once they are opened.
  // Meetings older than the retention limit (set by an organisation's policy) are deleted at start and then every day
  const sweep = () => { try { account.applyRetention({ days: settings.get('retentionDays') }); } catch (e) { bus.publish('account.error', { message: `retention: ${e.message}` }); } };
  ready.then(sweep).catch(() => {});
  ready.then(() => {   // after the secrets are open: the steps may call the AI server
    runner.start();
    runner.enqueue('items.backfill', {}, { key: 'once', maxAttempts: 2 });       // meetings made before items existed
    runner.enqueue('entities.backfill', {}, { key: 'once', maxAttempts: 2 });    // people from speakers, attendees and voice prints
    sources.start();
    wantIndex();
    reminders.start();
    runner.enqueue('maintenance', {}, { key: 'daily', runAfter: 60_000, maxAttempts: 1 });
  }).catch(() => {});
  // Search by meaning is opt-in: the index is only built, and the extension only loaded, when it is on
  const wantSemantic = () => settings.get('semanticSearch') && !semantic.available && semantic.init().catch(() => {});
  ready.then(wantSemantic).catch(() => {});
  bus.subscribe((e) => {
    if (e.type === 'settings' && e.data.keys.includes('semanticSearch')) wantSemantic();
    if (e.type === 'note.insights' && semantic.available && settings.get('semanticSearch')) semantic.indexNote(e.data.id).catch(() => {});
  });
  const retentionTimer = detect ? setInterval(sweep, 86400000) : null;
  // a copy of the database every day, once a folder is chosen (and a first one when the app starts, if the last is older than a day)
  const backupNow = () => backupTo(conn, settings.get('backupDir'));
  const backupIfDue = () => { const dir = settings.get('backupDir'); if (!dir) return; try { const last = listBackups(dir)[0]; if (!last || Date.now() - last.at > 86400000) { backupNow(); bus.publish('backup.done', {}); } } catch (e) { bus.publish('backup.failed', { message: e.message }); } };
  const backupTimer = detect ? setInterval(backupIfDue, 3600000) : null;
  backupTimer?.unref();
  if (detect) ready.then(() => setTimeout(backupIfDue, 20000).unref()).catch(() => {});
  retentionTimer?.unref();
  // the RPC connection restarts only when the application or the switch changes: saving a token is a settings change too
  const rpcKey = () => { const c = settings.get('discordRpc'); return `${c.enabled}|${c.clientId}|${c.clientSecret}`; };
  let rpcSeen = '';
  const syncRpc = () => { if (rpcKey() === rpcSeen) return; rpcSeen = rpcKey(); discordRpc.start(); };
  if (detect) ready.then(() => { detector.start(); warmDiscord(); meet.sync(); meet.watch(bus); discordRpcSource.start(); syncRpc(); }).catch(() => {});
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('discordRpc')) syncRpc(); });
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('meet')) meet.sync(); });
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('discord')) warmDiscord(); });

  const app = Object.assign(self, {
    version, dataDir, importer, integrations, google, bus, db: conn, jobs, runner, backupNow, listBackups: () => listBackups(settings.get('backupDir')), items, sources, aiRuns, chunkIndex, mayShare, assertions, reminders, briefs, inbox, actions, reviews, supersession, projects, rules, lock, entities: knowledge.entities, notes, speakers, evidence, semantic, settings, templates, models, engine, platform: plat, llm, scheduler, ai, translator, briefings, assistant, recording, calendar, detector, dictation, account,
    knowledge, analyze, openExternal, renderPdf, discord, discordRpc, meet,
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
        speakerModelMB: (models.speakerUpToDate() ? 0 : models.speaker.sizeMB) + (models.segmentationInstalled() ? 0 : models.segmentation.sizeMB),
        speakerModelUpgrade: models.speakerInstalled() && !models.speakerUpToDate(),   // only the voice model before the current one is installed
        llmConfigured: !!settings.get('llm').baseUrl,
        stats: { ...notes.stats(), ...knowledge.stats(), documents: items.count(), inbox: inbox.counts().total },
        sources: notes.sourceCounts(),
        detector: typeof detector.status === 'function' ? detector.status() : null,
        pdf: !!renderPdf,
        secrets: settings.secretStatus(),
        policy: { managed: settings.publicView().managed, problems: policy.problems, file: policy.file },
      };
    },
    close() {
      self.pendingGoogleAuth?.cancel?.();
      sources.stop();
      reminders.stop();
      clearInterval(backupTimer);
      clearInterval(maintenanceTimer);
      runner.stop();   // takes no new job; one cut short by the closing database runs again at the next start
      detector.stop();
      assistant.close();
      clearInterval(retentionTimer);
      meet.close().catch(() => {});
      discord.logout().catch(() => {});
      discordRpc.stop(); discordRpcSource.stop();
      engine.stop();
      const closeDb = () => { try { conn.close(); } catch { /* already closed */ } };
      self.settled = settings.box ? settings.flush().then(closeDb) : (closeDb(), Promise.resolve());   // a sealed write may still be queued
    },
  });
  app.transcripts = new TranscriptService({ app });   // the platforms' own transcripts (src/transcripts)
  return app;
}

module.exports = { createApp };
