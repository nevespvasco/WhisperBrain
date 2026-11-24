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
const { Models } = require('../asr/models');
const { AsrEngine } = require('../asr/engine');
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

function createApp({ dataDir, platform, modelsDir, clipboard, version = '0.0.0', detect = false, openExternal = null, renderPdf = null } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true });
  const bus = new Bus();
  const conn = db.open(path.join(dataDir, 'whisperbrain.sqlite'));
  const notes = new Notes(conn, bus);
  const settings = new Settings(conn, bus);
  const templates = new Templates(conn);
  const speakers = new Speakers(conn, bus);
  const models = new Models(modelsDir || path.join(dataDir, 'models'), { bus });
  const engine = new AsrEngine({ speakerModel: () => (models.speakerInstalled() ? models.speakerPath() : null) });
  const plat = platform || createPlatform({ clipboard });
  const llm = new LlmClient(() => settings.get('llm'));
  const knowledge = new Knowledge({ db: conn, notes, settings, bus });
  const ai = new AiService({ notes, templates, settings, llm, bus, knowledge });
  const recording = new RecordingManager({ notes, engine, models, settings, platform: plat, bus, speakers, spoolDir: path.join(dataDir, 'spool') });
  const google = new GoogleCalendar({ getConfig: () => settings.get('google'), saveConfig: (p) => settings.update({ google: { ...settings.get('google'), ...p } }) });
  const calendar = new Calendar({ settings, bus, google });
  const detector = new MeetingDetector({ platform: plat, calendar, bus, settings, recording, notes });
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

  if (detect) detector.start();

  return Object.assign(self, {
    version, dataDir, importer, integrations, google, bus, db: conn, notes, speakers, settings, templates, models, engine, platform: plat, llm, ai, recording, calendar, detector, dictation, account,
    knowledge, analyze, openExternal, renderPdf,
    meeting: (id, opts) => toMeeting({ notes, knowledge, speakers, settings }, id, opts),
    async state() {
      const caps = await plat.capabilities();
      const model = models.resolve(settings.get('asrModel'));
      return {
        version, platform: plat.id, capture: plat.capture, capabilities: caps,
        recording: recording.status(), dictation: dictation.status(),
        model: model ? { id: model.id } : null, vadInstalled: models.vadInstalled(), speakerModel: models.speakerInstalled(),
        llmConfigured: !!settings.get('llm').baseUrl,
        stats: { ...notes.stats(), ...knowledge.stats() },
        sources: notes.sourceCounts(),
        detector: typeof detector.status === 'function' ? detector.status() : null,
        pdf: !!renderPdf,
      };
    },
    close() {
      self.pendingGoogleAuth?.cancel?.();
      detector.stop();
      engine.stop();
      try { conn.close(); } catch { /* already closed */ }
    },
  });
}

module.exports = { createApp };
