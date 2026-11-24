'use strict';
// Typed settings stored as JSON rows. Unknown keys are rejected; values are coerced/validated per key.
const os = require('node:os');

// Speech-model threads: about half the logical CPUs (they are usually SMT siblings), 2..8. Decoding stops scaling near 8.
function defaultAsrThreads(cpus = os.availableParallelism()) {
  return Math.max(2, Math.min(8, Math.round(cpus / 2)));
}

const DEFAULTS = {
  language: 'en',               // UI language: en | pt
  theme: 'system',              // system | light | dark
  asrModel: 'auto',             // model id, or 'auto' = best installed
  asrLanguage: 'auto',          // hint for multilingual models
  asrThreads: defaultAsrThreads(), // speech-model threads; the user's value (1..16) overrides this
  asrHotwords: true,            // bias live recognition towards the meeting's attendees, glossary terms and known speakers (about 20% more CPU while the list is non-empty)
  liveDraft: true,              // show draft words within about a second while people speak (needs the optional streaming model; it is a no-op until that is installed)
  micEnabled: true,
  systemAudioEnabled: true,
  micDevice: '',                // '' = system default
  echoDedupe: true,             // drop mic text that merely echoes the system channel (text match + loudness match)
  echoCancel: true,             // cancel the speakers' sound out of the microphone before transcribing (Linux: PipeWire WebRTC AEC; macOS/Windows: Chromium's)
  micNoiseSuppression: 'auto',  // auto | on | off. Enhancement can raise word errors, so Linux leaves it off; macOS/Windows keep Chromium's default (on)
  micAutoGain: 'auto',          // auto | on | off, same meaning
  speakerDetection: true,       // tell voices apart ("Speaker 1", "Ana"…) with an on-device voice model
  speakerThreshold: 0.6,        // cosine similarity needed to call two utterances the same voice
  speakerDiarize: true,         // after a recording, work out who spoke when over the whole meeting (speaker segmentation + global clustering) and relabel word by word
  speakerCountHint: false,       // use the calendar event's attendee list as the expected number of voices on the call when clustering speakers (small meetings only). Off: exactly right it takes AMI 18.1 -> 14.8 and libri-call 24.9 -> 17.9 WDER, one voice off it costs up to 6 points; see eval/README.md
  speakerRefine: true,          // after the diarization, also re-check speakers with pitch and timbre (MFCC split/merge/reassign): on AMI it merges over-split speakers (WDER 25.4 -> 18.1, 6 -> 4 speakers), neutral elsewhere; see eval/README.md
  floatingRecorder: 'background', // small floating recording icon: off | background (when the app is not in front) | always
  llm: {
    provider: 'ollama',         // ollama | openai
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: '',
    temperature: 0.2,
    contextChars: 24000,        // transcript budget per request before map-reduce kicks in
  },
  defaultTemplate: 'general',
  autoSummarize: false,         // summarize automatically when a recording stops
  detectMeetings: true,
  notifyUpcoming: true,
  calendar: { sources: [] },    // [{ id, name, kind: 'url'|'file', location }]
  dictation: {
    enabled: false,
    hotkey: 'CommandOrControl+Shift+Space',
    autoPaste: true,
  },
  userName: '',
  userEmail: '',
  myDomains: '',                // comma-separated company domains; attendees outside them make a meeting "external"
  autoRecord: 'ask',            // when a meeting is detected: off | ask | always
  autoStop: true,               // stop an auto-started recording when the meeting app releases the microphone
  captureCalendar: 'off',       // start recording when a calendar meeting starts: off | selected | all
  autoInsights: true,           // after enhancing, extract topics, glossary terms and action items
  sidebarCollapsed: false,
  google: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, email: '', calendars: [] },
  notion: { token: '', parentId: '', parentKind: 'page', parentTitle: '', autoExport: false },
  linear: { apiKey: '', teamId: '', teamName: '' },
  obsidian: { vaultPath: '', folder: 'Meetings', transcript: true, autoExport: false },
  webhooks: [],                 // [{ id, name, url, secret, auto }]
  discord: { enabled: false, token: '', userId: '', guildId: '', channelId: '' }, // bot that joins your voice call and hears each person separately; userId = your own Discord user ID (found from your voice channel, and left out because the microphone already has you)
};

const OBJECT_KEYS = new Set(['llm', 'calendar', 'dictation', 'google', 'notion', 'linear', 'obsidian', 'discord']);
// Secret fields: masked in publicView, and a masked value written back means "unchanged".
const SECRETS = { llm: ['apiKey'], google: ['clientSecret', 'refreshToken', 'accessToken'], notion: ['token'], linear: ['apiKey'], discord: ['token'] };
const MASK = '********';

function validate(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  const def = DEFAULTS[key];
  if (OBJECT_KEYS.has(key)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${key} must be an object`);
    const merged = { ...def, ...value };
    for (const k of Object.keys(merged)) if (!(k in def)) delete merged[k];
    for (const k of Object.keys(def)) {
      if (typeof merged[k] !== typeof def[k]) throw new Error(`${key}.${k} must be a ${typeof def[k]}`);
    }
    return merged;
  }
  if (typeof value !== typeof def) throw new Error(`${key} must be a ${typeof def}`);
  if (key === 'language' && !['en', 'pt'].includes(value)) throw new Error('language must be en or pt');
  if (key === 'theme' && !['system', 'light', 'dark'].includes(value)) throw new Error('invalid theme');
  if (key === 'asrThreads') return Math.max(1, Math.min(16, Math.round(value)));
  if (key === 'speakerThreshold') return Math.max(0.3, Math.min(0.95, value));
  if ((key === 'micNoiseSuppression' || key === 'micAutoGain') && !['auto', 'on', 'off'].includes(value)) throw new Error(`${key} must be auto, on or off`);
  if (key === 'floatingRecorder' && !['off', 'background', 'always'].includes(value)) throw new Error('floatingRecorder must be off, background or always');
  if (key === 'autoRecord' && !['off', 'ask', 'always'].includes(value)) throw new Error('autoRecord must be off, ask or always');
  if (key === 'captureCalendar' && !['off', 'selected', 'all'].includes(value)) throw new Error('captureCalendar must be off, selected or all');
  if (key === 'webhooks') {
    if (!Array.isArray(value)) throw new Error('webhooks must be a list');
    return value.slice(0, 20).map((w) => {
      const url = String(w?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('a webhook URL must start with http:// or https://');
      return { id: String(w.id || require('node:crypto').randomUUID()), name: String(w.name || '').trim().slice(0, 60) || new URL(url).hostname, url, secret: String(w.secret || ''), auto: !!w.auto };
    });
  }
  return value;
}

class Settings {
  constructor(db, bus) {
    this.db = db;
    this.bus = bus;
    this.cache = null;
  }

  all() {
    if (!this.cache) {
      const out = structuredClone(DEFAULTS);
      for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
        if (!(row.key in DEFAULTS)) continue;
        try { out[row.key] = validate(row.key, JSON.parse(row.value)); } catch { /* keep default */ }
      }
      this.cache = out;
    }
    return structuredClone(this.cache);
  }

  get(key) { return this.all()[key]; }

  // Public view: secrets are masked so they never travel to the UI.
  publicView() {
    const s = this.all();
    for (const [key, fields] of Object.entries(SECRETS)) for (const f of fields) if (s[key][f]) s[key][f] = MASK;
    s.webhooks = s.webhooks.map((w) => ({ ...w, secret: w.secret ? MASK : '' }));
    return s;
  }

  update(patch) {
    const current = this.all();
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      let v = value;
      if (SECRETS[key] && v && typeof v === 'object') {
        v = { ...v };
        for (const f of SECRETS[key]) if (v[f] === MASK) v[f] = current[key][f];
      }
      if (key === 'webhooks' && Array.isArray(v)) v = v.map((w) => (w?.secret === MASK ? { ...w, secret: current.webhooks.find((x) => x.id === w.id)?.secret || '' } : w));
      next[key] = validate(key, OBJECT_KEYS.has(key) ? { ...current[key], ...v } : v);
    }
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.exec('BEGIN');
    try {
      for (const [k, v] of Object.entries(next)) stmt.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    this.bus?.publish('settings', { keys: Object.keys(next) });
    return this.publicView();
  }
}

module.exports = { Settings, DEFAULTS, MASK, defaultAsrThreads };
