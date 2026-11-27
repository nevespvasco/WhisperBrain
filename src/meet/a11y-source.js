'use strict';
// The accessibility reader as a source of meeting signals: runs the native helper of this OS while a recording is on,
// reads the browser window's tree with the selectors, and tells the hub who is on the call and who is speaking.
const fs = require('node:fs');
const path = require('node:path');
const { HelperProcess } = require('./helper');
const { compileSelectors, MeetingReader } = require('./a11y');
const { PLATFORMS, DEFAULT_PLATFORM } = require('./platforms');

const SOURCE = 'a11y';
const SELECTORS_DIR = path.join(__dirname, 'selectors');
const DEFAULT_SELECTORS = path.join(SELECTORS_DIR, 'meet.json');   // Google Meet's: the platform that was here first

// The arguments that tell a helper which applications and window titles to watch (the registry says which, see platforms.js).
// apps and title are regex sources; given neither, the helper keeps its own defaults.
const watchFlags = { linux: (w) => [...(w.apps ? ['--apps', w.apps] : []), ...(w.title ? ['--title', w.title] : [])], darwin: (w) => watchFlags.linux(w), win32: (w) => [...(w.apps ? ['-Apps', w.apps] : []), ...(w.title ? ['-Title', w.title] : [])] };

// Where the helper of this OS is, and how to call it. -> { command, args(mode, opts), file } or null when there is none.
// roots: places to look, in order (the build folder in development, the resources folder when installed).
function helperSpec(platformId, { roots = [], exists = fs.existsSync } = {}) {
  const find = (rel) => roots.map((r) => path.join(r, rel)).find((p) => exists(p)) || null;
  if (platformId === 'linux') {
    const file = find('atspi/whisperbrain-atspi') || find('bin/whisperbrain-atspi');
    return file && { os: platformId, file, command: file, args: (mode, o = {}) => ['--interval-ms', String(o.intervalMs || 500), ...(mode === 'dump' ? ['--dump'] : mode === 'windows' ? ['--once'] : []), ...watchFlags.linux(o)] };
  }
  if (platformId === 'darwin') {
    const file = find('ax/whisperbrain-ax') || find('bin/whisperbrain-ax');
    return file && { os: platformId, file, command: file, args: (mode, o = {}) => (mode === 'permission' ? ['permission'] : [mode === 'dump' ? 'dump' : mode === 'windows' ? 'windows' : 'watch', '--interval-ms', String(o.intervalMs || 500), ...watchFlags.darwin(o)]) };
  }
  if (platformId === 'win32') {
    const file = find('windows/whisperbrain-uia.ps1') || find('bin/whisperbrain-uia.ps1');
    return file && { os: platformId, file, command: 'powershell.exe', args: (mode, o = {}) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Mode', mode === 'dump' ? 'dump' : mode === 'windows' ? 'windows' : 'watch', '-IntervalMs', String(o.intervalMs || 500), ...watchFlags.win32(o)] };
  }
  return null;
}

// The selectors of a file of your own when there is a good one, else the shipped file `fallback`.
function loadSelectors(userFile, { read = (f) => fs.readFileSync(f, 'utf8'), fallback = DEFAULT_SELECTORS } = {}) {
  let note = '';
  if (userFile) {
    try { return { sel: compileSelectors(JSON.parse(read(userFile))), file: userFile, note }; } catch (e) { if (e.code !== 'ENOENT') note = `your selectors file was ignored: ${e.message}`; }
  }
  return { sel: compileSelectors(JSON.parse(read(fallback))), file: fallback, note };
}

// Where the shipped selectors of a platform are, and where your own file for it is (it wins when it is good).
function selectorFiles(id, { dataDir = null, userSelectors = null, platforms = PLATFORMS } = {}) {
  const p = platforms.get(id);
  if (!p) throw new Error(`no such meeting platform: ${id}`);
  if (!p.selectors) throw new Error(`the platform ${id} has no accessibility selectors`);
  const shipped = path.isAbsolute(p.selectors) ? p.selectors : path.join(SELECTORS_DIR, p.selectors);
  const own = id === DEFAULT_PLATFORM && userSelectors ? userSelectors : dataDir ? path.join(dataDir, p.userFile) : null;
  return { shipped, own };
}

// -> { sel, file, note } for a platform of the registry
function loadPlatformSelectors(id, opts = {}) {
  const { shipped, own } = selectorFiles(id, opts);
  return loadSelectors(own, { fallback: shipped, read: opts.read });
}

class A11ySource {
  // spec: helperSpec(...) or null. platforms: the registry (platforms.js): the helper is told its apps and titles, and each
  // window is read with the selectors of its platform. dataDir: where your own selectors files are (they win over the shipped
  // ones); userSelectors: the path of your file for Google Meet, when it is not in dataDir.
  constructor({ hub, spec, platforms = PLATFORMS, dataDir = null, userSelectors = null, spawn = undefined, backoff = undefined, intervalMs = 500 }) {
    Object.assign(this, { hub, spec, platforms, dataDir, userSelectors, spawn, backoff, intervalMs });
    this.proc = null;
    this.selectors = new Map();  // platform id -> { sel, file, note }
    this.readers = new Map();    // platform id + window title -> MeetingReader
  }

  get on() { return !!this.proc; }

  // the platforms this system can read: those with selectors that name apps for it (a stand-in helper with no system reads them all)
  readable() { return this.spec?.os ? this.platforms.readable(this.spec.os) : this.platforms.list().filter((p) => p.selectors); }

  start() {
    if (this.proc) return true;
    if (!this.spec) { this.hub.report(SOURCE, { kind: 'a11y', state: 'off', detail: 'no accessibility helper for this system' }); return false; }
    const loaded = new Map();
    const notes = [];
    for (const p of this.readable()) {
      try { loaded.set(p.id, loadPlatformSelectors(p.id, { dataDir: this.dataDir, userSelectors: this.userSelectors, platforms: this.platforms })); } catch (e) { notes.push(`${p.name} selectors: ${e.message}`); }
    }
    if (!loaded.size) { this.hub.report(SOURCE, { kind: 'a11y', state: 'error', detail: notes[0] || 'no meeting platform to read' }); return false; }
    this.selectors = loaded;
    this.readers.clear();
    const note = [...notes, ...[...loaded.values()].map((l) => l.note)].filter(Boolean)[0] || '';
    const watch = this.spec.os ? this.platforms.watch(this.spec.os) : {};
    const proc = new HelperProcess({ command: this.spec.command, args: this.spec.args('watch', { intervalMs: this.intervalMs, ...watch }), spawn: this.spawn, backoff: this.backoff, label: 'accessibility helper' });
    proc.on('message', (m) => this.onMessage(m));
    proc.on('restart', ({ error }) => this.hub.report(SOURCE, { kind: 'a11y', state: 'error', detail: error.message }));
    proc.on('unavailable', (e) => { this.proc = null; this.hub.report(SOURCE, { kind: 'a11y', state: 'error', detail: e.message }); });
    this.proc = proc;
    this.hub.report(SOURCE, { kind: 'a11y', state: 'waiting', detail: note || 'looking for a meeting window' });
    proc.start();
    return true;
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    p.stop();
    // whoever was highlighted is not any more
    for (const [key, r] of this.readers) {
      if (r.speaker) { try { this.hub.ingest({ type: 'speaker', name: null, platform: key.split('|')[0] }, { source: SOURCE, kind: 'a11y' }); } catch { /* nobody listens */ } }
    }
    this.readers.clear();
    this.hub.report(SOURCE, { kind: 'a11y', state: 'off', detail: '' });
  }

  // Which platform a window shows, among those loaded: the one whose window title it has, else the default one (the helper
  // already chose the window by title, and a title nothing recognises was always read as Google Meet).
  platformOf(title) {
    const p = this.platforms.list().find((x) => this.selectors.has(x.id) && x.recognise.windowTitle && new RegExp(x.recognise.windowTitle, 'iu').test(String(title || '')));
    return p?.id || (this.selectors.has(DEFAULT_PLATFORM) ? DEFAULT_PLATFORM : null);
  }

  onMessage(m) {
    if (!this.proc) return;
    const report = (state, detail) => this.hub.report(SOURCE, { kind: 'a11y', state, detail });
    if (m.event === 'status') {
      if (m.state === 'ok') return; // the snapshots say it better
      const text = { 'no-web-tree': 'The browser is not exposing the page. Start it with accessibility on (Settings → Meetings).', 'no-window': 'No meeting window open.', 'no-apps': 'No application is exposing accessibility.', 'no-bus': 'The accessibility bus is not running.', 'no-permission': 'Accessibility permission is needed.', 'denied': 'Accessibility permission is needed.' }[m.state] || m.state;
      report(m.state === 'no-web-tree' ? 'needs-setup' : m.state === 'no-permission' || m.state === 'denied' ? 'denied' : m.state === 'no-bus' ? 'error' : 'waiting', text);
    } else if (m.event === 'permission') {
      report(m.trusted ? 'waiting' : 'denied', m.trusted ? 'looking for a meeting window' : 'Accessibility permission is needed.');
    } else if (m.event === 'snapshot') {
      const id = this.platformOf(m.window);
      if (!id) return;
      const key = `${id}|${m.window || ''}`;
      let r = this.readers.get(key);
      if (!r) { r = new MeetingReader(this.selectors.get(id).sel); this.readers.set(key, r); }
      let msgs;
      try { msgs = r.feed(m); } catch (e) { return report('error', `reading the page: ${e.message}`); }
      for (const msg of msgs) { try { this.hub.ingest({ ...msg, platform: id }, { source: SOURCE, kind: 'a11y' }); } catch { /* a bad message from a helper is dropped */ } }
      if (this.hub.sources.get(SOURCE)?.state !== 'connected') report('connected', '');
      if (!msgs.length && !r.inCall) report('waiting', this.selectors.get(id).sel.verified ? 'in a meeting window, no participants list found' : 'no participants list found (the selectors are not verified against the real page)');
    }
  }
}

module.exports = { A11ySource, helperSpec, loadSelectors, loadPlatformSelectors, selectorFiles, DEFAULT_SELECTORS };
