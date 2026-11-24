'use strict';
// Composition root: wires the stores, services and adapters together. No HTTP in here, so the same object is
// used by the Electron main process, the headless CLI and the tests.
const fs = require('node:fs');
const path = require('node:path');
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
const { loadPolicy } = require('../core/policy');

function createApp({ dataDir, platform, modelsDir, clipboard, version = '0.0.0', detect = false, openExternal = null, renderPdf = null, discordLibs = null, captureWindow = null, secretBox = null, policy = loadPolicy() } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true });
  const bus = new Bus();
  const conn = db.open(path.join(dataDir, 'whisperbrain.sqlite'));
  const notes = new Notes(conn, bus);
  const settings = new Settings(conn, bus, secretBox, policy);
  const templates = new Templates(conn);
  const speakers = new Speakers(conn, bus);
  const evidence = new Evidence(conn);
  speakers.enabled = () => settings.get('voiceprints');
  const models = new Models(modelsDir || path.join(dataDir, 'models'), { bus });
  const engine = new AsrEngine({ speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
  const plat = platform || createPlatform({ clipboard });
  const llm = new LlmClient(() => settings.get('llm'));
  const knowledge = new Knowledge({ db: conn, notes, settings, bus });
  const ai = new AiService({ notes, templates, settings, llm, bus, knowledge });
  const discord = new DiscordVoice({ getConfig: () => settings.get('discord'), libs: discordLibs });
  const meet = new MeetService({ settings, bus, version, llm, captureWindow, isRecording: () => recording.status().active, platformId: plat.id === 'fake' ? process.platform : plat.id, dataDir, roots: [path.join(__dirname, '..', '..', 'build'), path.join(__dirname, '..', '..', 'native'), process.resourcesPath ? path.join(process.resourcesPath, '') : ''].filter(Boolean) });
  const recording = new RecordingManager({ notes, engine, models, settings, platform: plat, bus, speakers, discord, meet: meet.hub, evidence, spoolDir: path.join(dataDir, 'spool'), vocabulary: (id) => termsForNote({ notes, speakers, knowledge, settings }, id) });
  const google = new GoogleCalendar({ getConfig: () => settings.get('google'), saveConfig: (p) => settings.update({ google: { ...settings.get('google'), ...p } }) });
  const calendar = new Calendar({ settings, bus, google });
  const detector = new MeetingDetector({ platform: plat, calendar, bus, settings, recording, notes, signals: meet.hub });
  const dictation = new Dictation({ platform: plat, engine, models, settings, bus });
  const account = new Account({ db: conn, notes, settings, speakers, models, dataDir, bus, knowledge });

  // When a recording ends: enhance automatically if asked, then fill the knowledge layer (topics, glossary,
  // action items). Without auto-enhance, offline topics are still extracted so search and topics work.
  bus.subscribe(async (e) => {
    if (e.type !== 'recording.stopped') return;
    const id = e.data.noteId;
    if (!notes.get(id)) return;
    if (settings.get('autoSummarize')) {
      try {
        bus.publish('note.summarizing', { id });
        await ai.summarize(id);
      } catch (err) {
        bus.publish('note.summarize-failed', { id, message: err.message });
      }
    }
    await analyze(id, { local: !settings.get('autoSummarize') || !ai.configured() });
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
  const retentionTimer = detect ? setInterval(sweep, 86400000) : null;
  retentionTimer?.unref();
  if (detect) ready.then(() => { detector.start(); warmDiscord(); meet.sync(); meet.watch(bus); }).catch(() => {});
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('meet')) meet.sync(); });
  bus.subscribe((e) => { if (detect && e.type === 'settings' && e.data.keys.includes('discord')) warmDiscord(); });

  return Object.assign(self, {
    version, dataDir, importer, integrations, google, bus, db: conn, notes, speakers, evidence, settings, templates, models, engine, platform: plat, llm, ai, recording, calendar, detector, dictation, account,
    knowledge, analyze, openExternal, renderPdf, discord, meet,
    ready,                       // resolves when the secrets are opened: await it before anything reads an API key
    settled: Promise.resolve(),  // after close(): resolves once the last sealed write is on disk
    meeting: (id, opts) => toMeeting({ notes, knowledge, speakers, settings }, id, opts),
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
      detector.stop();
      clearInterval(retentionTimer);
      meet.close().catch(() => {});
      discord.logout().catch(() => {});
      engine.stop();
      const closeDb = () => { try { conn.close(); } catch { /* already closed */ } };
      self.settled = settings.box ? settings.flush().then(closeDb) : (closeDb(), Promise.resolve());   // a sealed write may still be queued
    },
  });
}

module.exports = { createApp };
