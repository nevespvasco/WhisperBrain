'use strict';
// The meeting-window side of the app as one object: the hub the readers report to, the door for the browser extension
// (opened only while the extension is switched on in Settings) and the pairing secret.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SignalHub } = require('./hub');
const { PLATFORMS } = require('./platforms');
const { createIntake } = require('./intake');
const { A11ySource, helperSpec, loadPlatformSelectors } = require('./a11y-source');
const launcher = require('./launcher');
const { VisionSource } = require('./vision');

class MeetService {
  // platformId: 'linux' | 'darwin' | 'win32'. roots: where the accessibility helper may be (see a11y-source.js).
  // dataDir: where your own selectors files live (meet-selectors.json for Google Meet, <platform>-selectors.json for the others).
  // platforms: the registry of meeting platforms (platforms.js).
  constructor({ settings, bus, version = '0.0.0', isRecording = () => false, platforms = PLATFORMS, hub = new SignalHub({ platforms }), platformId = process.platform, roots = [], dataDir = null, spawn = undefined, llm = null, captureWindow = null, onTabAudio = null }) {
    Object.assign(this, { settings, bus, version, hub, platformId, platforms });
    this.spec = helperSpec(platformId, { roots });
    this.userSelectors = dataDir ? path.join(dataDir, 'meet-selectors.json') : null;
    this.dataDir = dataDir;
    this.a11y = new A11ySource({ hub, spec: this.spec, platforms, dataDir, spawn });
    this.launcher = launcher; // replaceable: a test must not write to the real home folder
    // last resort: look at the meeting window (needs a way to capture it, which only the desktop app has, and a vision model)
    this.vision = new VisionSource({ hub, llm, capture: captureWindow, userName: () => this.settings.get('userName') });
    this.intake = createIntake({ hub, getToken: () => this.settings.get('meet').token, info: () => ({ version: this.version, recording: isRecording() }), onAudio: onTabAudio });
    this.listening = false;
    this.error = '';
    this.queue = Promise.resolve();
  }

  // Opens or closes the extension's door to match the settings. Calls queue up, so a quick on-off-on never races.
  sync() {
    this.queue = this.queue.then(() => this.apply()).catch(() => {});
    return this.queue;
  }

  async apply() {
    const m = this.settings.get('meet');
    if (!m.token) { this.settings.update({ meet: { ...m, token: crypto.randomBytes(24).toString('base64url') } }); return this.apply(); }
    const want = m.enabled && m.extension;
    if (this.listening && (!want || this.intake.port !== this.boundFor)) { await this.intake.close(); this.listening = false; this.hub.report('extension', { kind: 'extension', state: 'off', detail: '' }); }
    if (want && !this.listening) {
      try {
        await this.intake.listen(m.port);
        this.listening = true; this.error = ''; this.boundFor = m.port;
        this.hub.report('extension', { kind: 'extension', state: 'waiting', detail: `listening on port ${this.intake.port}` });
      } catch (e) { this.error = e.message; this.hub.report('extension', { kind: 'extension', state: 'error', detail: e.message }); }
    }
  }

  // The accessibility reader runs while a recording does (and only then: it reads another program's window).
  watch(bus = this.bus) {
    return bus.subscribe((e) => {
      if (e.type === 'recording.started') {
        const m = this.settings.get('meet');
        if (m.enabled && m.a11y) this.a11y.start();
        if (m.enabled && m.vision) this.vision.start();
      } else if (e.type === 'recording.finalizing' || e.type === 'recording.stopped') { this.a11y.stop(); this.vision.stop(); }
    });
  }

  // Linux browsers that need to be started with accessibility on, and whether WhisperBrain has done that for them
  browsers() { return this.platformId === 'linux' ? this.launcher.browsers() : []; }
  enableBrowser(file) { return this.launcher.enable(file); }
  disableBrowser(file) { return this.launcher.disable(file); }

  // The folder with the browser extension, to be loaded into Chrome, Edge or Brave ("Load unpacked"). null when it is not there.
  extensionDir() {
    const dirs = [path.join(__dirname, '..', '..', 'extension', 'meet'), process.resourcesPath && path.join(process.resourcesPath, 'extension', 'meet')].filter(Boolean);
    return dirs.find((d) => fs.existsSync(path.join(d, 'manifest.json'))) || null;
  }

  // The code the user pastes into the extension: where to find the app and the secret. null while the door is closed.
  pairing() {
    const m = this.settings.get('meet');
    if (!this.listening || !m.token) return null;
    return { code: `wb1.${this.intake.port}.${m.token}`, port: this.intake.port };
  }

  resetToken() {
    const m = this.settings.get('meet');
    this.settings.update({ meet: { ...m, token: crypto.randomBytes(24).toString('base64url') } });
    return this.pairing();
  }

  // What Settings shows for each platform: whether its selectors were checked and, for every kind of source that can
  // serve it, how that source is doing and how many messages about this platform it has sent.
  platformStatus(hubStatus) {
    const rank = { connected: 0, waiting: 1, 'needs-setup': 2, denied: 3, error: 4, off: 5 };
    return this.platforms.list().map((p) => {
      let verified = false;
      if (p.selectors) { try { verified = loadPlatformSelectors(p.id, { dataDir: this.dataDir, platforms: this.platforms }).sel.verified; } catch { /* the source reports it */ } }
      const kinds = [p.selectors && p.apps[this.platformId] ? 'a11y' : null, p.extension ? 'extension' : null, p.rpc ? 'rpc' : null, p.recognise.windowTitle ? 'vision' : null].filter(Boolean);
      const sources = kinds.map((kind) => {
        const mine = hubStatus.sources.filter((s) => s.kind === kind).sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
        return { kind, state: mine[0]?.state || 'off', detail: mine[0]?.detail || '', messages: mine.reduce((n, s) => n + (s.platforms?.[p.id] || 0), 0) };
      });
      return { id: p.id, name: p.name, verified, ownSelectors: p.selectors && this.dataDir ? path.join(this.dataDir, p.userFile) : null, sources };
    });
  }

  status() {
    const m = this.settings.get('meet');
    let verified = false;
    try { verified = loadPlatformSelectors('meet', { dataDir: this.dataDir, platforms: this.platforms }).sel.verified; } catch { /* the source reports it */ }
    const hub = this.hub.status();
    return { enabled: m.enabled, platform: this.platformId, vision: { available: !!this.vision.capture, on: this.vision.on }, a11y: { available: !!this.spec, on: this.a11y.on, helper: this.spec?.file || null, selectorsVerified: verified, ownSelectors: this.userSelectors }, extension: { on: m.extension, dir: this.extensionDir(), listening: this.listening, port: this.listening ? this.intake.port : null, error: this.error }, ...hub, platforms: this.platformStatus(hub) };
  }

  async close() { this.a11y.stop(); this.vision.stop(); await this.queue; await this.intake.close(); this.listening = false; }
}

module.exports = { MeetService };
