'use strict';
// Typed settings stored as JSON rows. Unknown keys are rejected; values are coerced/validated per key.
const os = require('node:os');
const { SecretBox } = require('./secret-box');
const { PRESETS: CONSENT_PRESETS } = require('../consent/notice');
const { isLanguage } = require('../llm/languages');
const { isLocalUrl } = require('./policy');
const { DEFAULT_HOTKEYS, validateHotkeys } = require('../assistant/hotkeys');

// Speech-model threads: about half the logical CPUs (they are usually SMT siblings), 2..8. Decoding stops scaling near 8.
function defaultAsrThreads(cpus = os.availableParallelism()) {
  return Math.max(2, Math.min(8, Math.round(cpus / 2)));
}

const DEFAULTS = {
  language: 'en',               // UI language: en | pt
  setupSeen: false,             // the first-run "is this computer ready?" check has been shown (Settings → Setup check opens it again)
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
  speakerNamesFromTranscript: 'auto', // while recording and after, an AI reads the transcript and names voices from what people say ("I'm Maria", "Thanks, George"): auto = only when the AI server runs on this computer, on = always, off = never. The names are guesses that say so, and never save a voice print
  translation: {
    enabled: false,             // translate meetings into other languages. Off by default; nothing is translated until it is on and a language is chosen
    targets: [],                // the languages offered (ISO codes in the order chosen, e.g. ['en', 'pt-PT']); the first is the one live translation uses
    live: false,                // translate while recording, line by line (keeps the AI busy during the call)
    view: 'original',           // what a meeting shows by default once it has a translation: original | translation | both
    notesLanguage: '',          // the language the notes are written in: '' = the language of the meeting
  },
  // The live meeting assistant (src/assistant): suggestions for questions asked on the call, grounded in the user's briefings.
  assistant: {
    enabled: false,             // off until switched on (here for every meeting, or per meeting from the recording)
    mode: 'bullets',            // bullets (short points to glance at) | spoken (a first-person reply to say aloud)
    trigger: 'auto',            // auto (a question from the other side prepares help by itself) | manual (only the "answer now" shortcut or button)
    revealMs: 1500,             // how long the other side must stay quiet before a prepared suggestion is shown (a question with "?" is shown sooner)
    words: 90,                  // length of a suggestion
    language: '',               // '' = the language of the question
    liveSummaryMin: 5,          // refresh the live summary, decisions and action items every N minutes (0 = only when asked)
    termCards: true,            // explain technical terms the other side uses (once each, a few per meeting)
    allowRemote: false,         // also when the AI server is not on this computer: what is said on the call is then sent to it
    hotkeys: { ...DEFAULT_HOTKEYS }, // global shortcuts; '' switches one off
  },
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
  semanticSearch: false,        // also search by meaning (a spike, off by default: indexes the transcripts, needs the optional sqlite-vec; see src/search/semantic.js)
  voiceprints: true,            // voice prints at all: saving a voice and recognising saved ones (an organisation can switch it off, see policy.js)
  retentionDays: 0,             // delete meetings older than this many days (0 = keep them; set by an organisation, see policy.js)
  perAppCapture: true,          // capture only the meeting application's own audio when it can be told (Linux, macOS 14.2+, Windows with the helper); off = everything the computer plays
  autoInsights: true,           // after enhancing, extract topics, glossary terms and action items
  sidebarCollapsed: false,
  backupDir: '',                 // a folder for backups of the database ('' = none); with one, a copy is made every day while the app runs (src/core/backup.js)
  autoAssertions: true,          // after a meeting, look for decisions and commitments (each one a suggestion with its quote; nothing is accepted by itself)
  embeddingModel: '',            // an embedding model on the AI server (e.g. embeddinggemma): search by meaning as well as by words; '' = words only (src/search)
  startPage: 'home',            // what opens with the app: 'home' (Today door) | 'meetings' (the meetings list)
  consentPreset: 'general',     // wording of the "this call is recorded" notice: 'general' | 'eu' | 'us' (see src/consent/notice.js)
  secretStorage: 'ask',         // what to do when the keystore is no real protection: 'ask' (keep as is, show a warning) | 'plaintext' (keep them in the clear, on purpose) | 'never' (do not save secrets)
  google: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, email: '', calendars: [], gmail: false },   // gmail: the sign-in also asked for read-only access to mail
  // The platforms' own transcripts (src/transcripts): the app each person registered with the platform, and the tokens it gave
  microsoft: { clientId: '', tenant: 'organizations', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0 },
  googleMeet: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0 },
  zoom: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0 },
  notion: { token: '', parentId: '', parentKind: 'page', parentTitle: '', autoExport: false },
  linear: { apiKey: '', teamId: '', teamName: '' },
  obsidian: { vaultPath: '', folder: 'Meetings', transcript: true, autoExport: false },
  github: { token: '' },        // a personal access token (read-only: repository metadata, issues and pull requests): src/connectors/github.js
  slack: { token: '' },         // a token of YOUR OWN Slack app (internal apps are exempt from the limits on shared apps): src/connectors/slack.js
  webhooks: [],                 // [{ id, name, url, secret, auto }]
  meet: {
    enabled: true,              // use what the meeting window shows (who is speaking, who is on the call) to name the voices on the call
    headcount: true,            // ...and the number of other people on the call as the number of voices to expect
    a11y: true,                 // read the meeting from the browser's accessibility tree (no extension; Linux needs the browser started with accessibility on)
    extension: false,           // accept the browser extension on 127.0.0.1 (off until you pair it)
    port: 47631,                // where the extension finds the app; the next ports are tried when it is taken
    token: '',                  // the secret the extension pairs with (made on first use)
    refine: true,               // let the names fix the voices: one person heard as two voices is joined, two people heard as one are split
    learnVoices: false,         // opt-in (a voice print is biometric data): remember a voice the call named clearly (many seconds, no doubt) so the next meetings recognise it
    captions: true,             // use the meeting's live captions (name and words) when the extension sends them
    vision: false,              // last resort: look at the meeting window and ask your local vision model who is speaking
  },
  discord: { enabled: false, token: '', userId: '', guildId: '', channelId: '' }, // bot that joins your voice call and hears each person separately; userId = your own Discord user ID (found from your voice channel, and left out because the microphone already has you)
};

const MAX_TRANSLATION_TARGETS = 8;
const OBJECT_KEYS = new Set(['llm', 'calendar', 'dictation', 'google', 'microsoft', 'googleMeet', 'zoom', 'notion', 'linear', 'github', 'slack', 'obsidian', 'meet', 'discord', 'translation', 'assistant']);
// Secret fields: masked in publicView, and a masked value written back means "unchanged".
const SECRETS = { llm: ['apiKey'], google: ['clientSecret', 'refreshToken', 'accessToken'], microsoft: ['clientSecret', 'refreshToken', 'accessToken'], googleMeet: ['clientSecret', 'refreshToken', 'accessToken'], zoom: ['clientSecret', 'refreshToken', 'accessToken'], notion: ['token'], linear: ['apiKey'], github: ['token'], slack: ['token'], meet: ['token'], discord: ['token'] };
const MASK = '********';

// Apply f to every secret string inside one setting's value (sync or async f), keeping the rest as it is.
function secretFields(key, value) {
  if (key === 'webhooks') return Array.isArray(value) ? value.filter((w) => w && typeof w === 'object').map((w) => [w, 'secret']) : [];
  return (SECRETS[key] || []).filter((f) => value && typeof value === 'object').map((f) => [value, f]);
}
const hasSecrets = (key) => key === 'webhooks' || !!SECRETS[key];
function mapSecrets(key, value, f) {
  const out = structuredClone(value);
  for (const [holder, field] of secretFields(key, out)) if (typeof holder[field] === 'string' && holder[field]) holder[field] = f(holder[field]);
  return out;
}
async function mapSecretsAsync(key, value, f) {
  const out = structuredClone(value);
  for (const [holder, field] of secretFields(key, out)) if (typeof holder[field] === 'string' && holder[field]) holder[field] = await f(holder[field]);
  return out;
}

// assistant.mode used to be 'meeting' | 'interview': a value an older version stored (or an older client sends) still reads
const LEGACY_ASSISTANT_MODES = { meeting: 'bullets', interview: 'spoken' };

function validate(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  const def = DEFAULTS[key];
  if (OBJECT_KEYS.has(key)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${key} must be an object`);
    const merged = { ...def, ...value };
    if (key === 'assistant' && LEGACY_ASSISTANT_MODES[merged.mode]) merged.mode = LEGACY_ASSISTANT_MODES[merged.mode];   // a value stored by an older version
    for (const k of Object.keys(merged)) if (!(k in def)) delete merged[k];
    for (const k of Object.keys(def)) {
      if (typeof merged[k] !== typeof def[k]) throw new Error(`${key}.${k} must be a ${typeof def[k]}`);
    }
    if (key === 'meet' && !(Number.isInteger(merged.port) && merged.port >= 1024 && merged.port <= 65000)) throw new Error('meet.port must be a port from 1024 to 65000');
    if (key === 'assistant') {
      if (!['bullets', 'spoken'].includes(merged.mode)) throw new Error('assistant.mode must be bullets or spoken');
      if (!['auto', 'manual'].includes(merged.trigger)) throw new Error('assistant.trigger must be auto or manual');
      if (!(Number.isInteger(merged.revealMs) && merged.revealMs >= 0 && merged.revealMs <= 10000)) throw new Error('assistant.revealMs must be 0 to 10000 ms');
      if (!(Number.isInteger(merged.words) && merged.words >= 20 && merged.words <= 300)) throw new Error('assistant.words must be 20 to 300');
      if (!(Number.isInteger(merged.liveSummaryMin) && merged.liveSummaryMin >= 0 && merged.liveSummaryMin <= 60)) throw new Error('assistant.liveSummaryMin must be 0 to 60');
      if (merged.language && !isLanguage(merged.language)) throw new Error(`assistant.language: unknown language "${merged.language}"`);
      merged.hotkeys = { ...def.hotkeys, ...(value.hotkeys || {}) };
      try { validateHotkeys(merged.hotkeys); } catch (e) { throw new Error(`assistant.hotkeys: ${e.message}`); }
    }
    if (key === 'translation') {
      const list = merged.targets;
      if (!Array.isArray(list)) throw new Error('translation.targets must be a list of language codes');
      const bad = list.find((c) => !isLanguage(c));
      if (bad !== undefined) throw new Error(`translation.targets: unknown language "${bad}"`);
      merged.targets = [...new Set(list)];
      if (merged.targets.length > MAX_TRANSLATION_TARGETS) throw new Error(`translation.targets: at most ${MAX_TRANSLATION_TARGETS} languages`);
      if (!['original', 'translation', 'both'].includes(merged.view)) throw new Error('translation.view must be original, translation or both');
      if (merged.notesLanguage && !isLanguage(merged.notesLanguage)) throw new Error(`translation.notesLanguage: unknown language "${merged.notesLanguage}"`);
    }
    return merged;
  }
  if (typeof value !== typeof def) throw new Error(`${key} must be a ${typeof def}`);
  if (key === 'consentPreset' && !CONSENT_PRESETS.includes(value)) throw new Error('consentPreset must be general, eu or us');
  if (key === 'retentionDays' && !(Number.isInteger(value) && value >= 0 && value <= 3650)) throw new Error('retentionDays must be a whole number of days from 0 (keep everything) to 3650');
  if (key === 'secretStorage' && !['ask', 'plaintext', 'never'].includes(value)) throw new Error('secretStorage must be ask, plaintext or never');
  if (key === 'language' && !['en', 'pt'].includes(value)) throw new Error('language must be en or pt');
  if (key === 'theme' && !['system', 'light', 'dark'].includes(value)) throw new Error('invalid theme');
  if (key === 'startPage' && !['home', 'meetings'].includes(value)) throw new Error('startPage must be home or meetings');
  if (key === 'asrThreads') return Math.max(1, Math.min(16, Math.round(value)));
  if (key === 'speakerThreshold') return Math.max(0.3, Math.min(0.95, value));
  if ((key === 'micNoiseSuppression' || key === 'micAutoGain') && !['auto', 'on', 'off'].includes(value)) throw new Error(`${key} must be auto, on or off`);
  if (key === 'speakerNamesFromTranscript' && !['auto', 'on', 'off'].includes(value)) throw new Error('speakerNamesFromTranscript must be auto, on or off');
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
  // secretBox (optional): where secrets rest. With one, call `await init()` once before use: until then secrets that were
  // sealed read as '' (never as their sealed text). Reads and updates stay synchronous; the sealed write of a secret
  // follows in order (`await flush()` to wait for it, e.g. at quit).
  // policy: what an organisation fixes (src/core/policy.js); locked settings have its values and refuse to change
  constructor(db, bus, secretBox = null, policy = null) {
    this.policy = policy || { locked: {}, requireLocalLlm: false, problems: [] };
    this.db = db;
    this.bus = bus;
    this.box = secretBox;
    this.cache = null;
    this.opened = new Map();           // sealed text -> plaintext, filled by init()
    this.queue = Promise.resolve();    // sealed writes, one after another
    this.unreadable = [];              // keys whose sealed secrets could not be opened (another user, another keystore)
    this.unlocked = !secretBox;        // false until init() has opened the sealed values
    this.epoch = 0;                    // bumped by reset(): a sealed write queued before it must not land after it
  }

  async init() {
    if (!this.box) return this;
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      if (!hasSecrets(row.key)) continue;
      let value; try { value = JSON.parse(row.value); } catch { continue; }
      const sealed = [];
      mapSecrets(row.key, value, (v) => { if (SecretBox.isSealed(v)) sealed.push(v); return v; });
      for (const v of sealed) {
        try { this.opened.set(v, await this.box.open(v)); } catch { this.opened.set(v, ''); if (!this.unreadable.includes(row.key)) this.unreadable.push(row.key); }
      }
    }
    this.cache = null;
    this.all();                        // built once, from the opened values; from here on the cache is the truth
    this.opened.clear();
    this.unlocked = true;
    if (this.mode() !== 'plain') this.rewriteSecrets();   // the one-time move of what an older version left in the clear
    await this.flush();
    return this;
  }

  // Forget everything held in memory and cancel sealed writes still waiting (the data was just deleted).
  reset() { this.epoch++; this.cache = null; this.opened.clear(); this.unreadable = []; }

  flush() { return this.queue; }

  // How secrets are written: 'seal' (keystore), 'plain' (as before: no box, or a weak one the person chose to live with
  // or has not been asked about yet), 'omit' (the person said not to save them).
  mode() {
    if (!this.box) return 'plain';
    if (this.box.strength === 'strong' || this.box.strength === 'fallback') return 'seal';
    return (this.cache || this.all()).secretStorage === 'never' ? 'omit' : 'plain';
  }

  // For the UI: how secrets rest right now, and whether the person has a choice to make.
  secretStatus() {
    const weak = !!this.box && (this.box.strength === 'weak' || this.box.strength === 'none');
    const policy = (this.cache || this.all()).secretStorage;
    return {
      kind: this.box?.kind || 'none', strength: this.box?.strength || 'none', policy, mode: this.mode(),
      needsChoice: weak && policy === 'ask',
      warning: !this.box ? null : this.box.strength === 'weak' ? 'weak-backend' : this.box.strength === 'none' ? 'no-backend' : this.box.strength === 'fallback' ? 'key-file' : null,
      unreadable: [...this.unreadable],
    };
  }

  all() {
    if (!this.cache) {
      const out = structuredClone(DEFAULTS);
      for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
        if (!(row.key in DEFAULTS)) continue;
        try {
          let v = JSON.parse(row.value);
          if (hasSecrets(row.key)) v = mapSecrets(row.key, v, (x) => (SecretBox.isSealed(x) ? (this.opened.get(x) ?? '') : x));
          out[row.key] = validate(row.key, v);
        } catch { /* keep default */ }
      }
      this.raw = structuredClone(out);        // what is stored, before the policy: updates are merged with this, so the policy's values are never written back
      this.applyPolicy(out);
      this.cache = out;
    }
    return structuredClone(this.cache);
  }

  // locked settings take the policy's value, and an AI server that is not local is not used when the policy says so
  applyPolicy(all) {
    for (const [pathStr, value] of Object.entries(this.policy.locked)) {
      const [a, b] = pathStr.split('.');
      if (b === undefined) all[a] = value; else all[a][b] = value;
    }
    if (this.policy.requireLocalLlm && !isLocalUrl(all.llm.baseUrl)) all.llm.baseUrl = '';
  }

  // refuses a change to what the policy fixes (saying what it already says is not a change)
  checkPolicy(next) {
    for (const [pathStr, value] of Object.entries(this.policy.locked)) {
      const [a, b] = pathStr.split('.');
      if (!(a in next)) continue;
      const now = b === undefined ? next[a] : next[a]?.[b];
      if (JSON.stringify(now) !== JSON.stringify(value)) throw new Error(`${b ?? a} is managed by your organisation and cannot be changed`);
    }
    if (this.policy.requireLocalLlm && next.llm && !isLocalUrl(next.llm.baseUrl)) throw new Error('the AI server must be on this computer or the local network: managed by your organisation');
  }

  get(key) { return this.all()[key]; }

  // Public view: secrets are masked so they never travel to the UI.
  publicView() {
    const s = this.all();
    for (const [key, fields] of Object.entries(SECRETS)) for (const f of fields) if (s[key][f]) s[key][f] = MASK;
    s.webhooks = s.webhooks.map((w) => ({ ...w, secret: w.secret ? MASK : '' }));
    s.managed = [...Object.keys(this.policy.locked), ...(this.policy.requireLocalLlm ? ['llm.baseUrl (local servers only)'] : [])];
    return s;
  }

  write(entries) {
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.exec('BEGIN');
    try {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // Write one secret-bearing setting the way the current mode says, after whatever was queued before it.
  persistSecretKey(key, value) {
    const epoch = this.epoch;
    this.queue = this.queue.then(async () => {
      if (epoch !== this.epoch) return;                  // the data was deleted in the meantime
      const mode = this.mode();
      const kept = this.retainUnreadable(key, value);
      const stored = mode === 'seal' ? await mapSecretsAsync(key, kept, (v) => (SecretBox.isSealed(v) ? v : this.box.seal(v)))
        : mode === 'omit' ? mapSecrets(key, kept, (v) => (SecretBox.isSealed(v) ? v : '')) : kept;
      if (epoch === this.epoch) this.write([[key, stored]]);
    }).catch((e) => this.bus?.publish('settings.error', { key, message: e.message }));
  }

  // A secret this keystore could not open is blank in memory; when the row is written again its sealed original is put
  // back, so an unrelated edit does not destroy what another keystore can still read.
  retainUnreadable(key, value) {
    if (!this.unreadable.includes(key)) return value;
    const old = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    let prev; try { prev = old && JSON.parse(old.value); } catch { return value; }
    const out = structuredClone(value);
    const pairs = secretFields(key, out), prevPairs = secretFields(key, prev);
    for (const [holder, field] of pairs) {
      if (holder[field]) continue;
      const was = key === 'webhooks' ? prevPairs.find(([h]) => h.id === holder.id) : prevPairs.find(([, f]) => f === field);
      if (was && SecretBox.isSealed(was[0][was[1]])) holder[field] = was[0][was[1]];
    }
    return out;
  }

  rewriteSecrets() {
    const present = new Set(this.db.prepare('SELECT key FROM settings').all().map((r) => r.key));
    const all = this.all();
    for (const key of present) if (hasSecrets(key) && key in all && !this.unreadable.includes(key)) this.persistSecretKey(key, all[key]);   // an unreadable row stays for the keystore that can open it
  }

  update(patch) {
    if (!this.unlocked) throw new Error('settings are still being unlocked: await init() first');
    const current = this.all();
    const raw = this.raw;                       // what is stored: the policy's values are not (see all())
    const next = {}, stored = {};
    for (const [key, value] of Object.entries(patch)) {
      let v = value;
      if (key === 'assistant' && v && typeof v === 'object' && v.hotkeys && typeof v.hotkeys === 'object') v = { ...v, hotkeys: { ...current.assistant.hotkeys, ...v.hotkeys } };   // one shortcut changed, the others kept
      if (SECRETS[key] && v && typeof v === 'object') {
        v = { ...v };
        for (const f of SECRETS[key]) if (v[f] === MASK) v[f] = current[key][f];
      }
      if (key === 'webhooks' && Array.isArray(v)) v = v.map((w) => (w?.secret === MASK ? { ...w, secret: current.webhooks.find((x) => x.id === w.id)?.secret || '' } : w));
      next[key] = validate(key, OBJECT_KEYS.has(key) ? { ...current[key], ...v } : v);        // as it will read (policy applied): checked and cached
      stored[key] = OBJECT_KEYS.has(key) ? validate(key, { ...raw[key], ...v }) : next[key];   // as it is kept
    }
    this.checkPolicy(next);
    const before = current.secretStorage;
    const sync = Object.entries(stored).filter(([k]) => !(this.box && hasSecrets(k)));
    if (sync.length) this.write(sync);
    if (this.box) {
      this.cache = { ...current, ...next };
      for (const [k, v] of Object.entries(stored)) if (hasSecrets(k)) {
        if (secretFields(k, v).some(([h, f]) => h[f])) this.unreadable = this.unreadable.filter((x) => x !== k);   // a secret was typed again
        this.persistSecretKey(k, v);
      }
      if (next.secretStorage && next.secretStorage !== before) this.rewriteSecrets();   // the person chose: apply it to what is stored
    } else this.cache = null;
    this.bus?.publish('settings', { keys: Object.keys(next) });
    return this.publicView();
  }
}

module.exports = { Settings, validateSetting: validate, DEFAULTS, MASK, defaultAsrThreads, LEGACY_ASSISTANT_MODES };
