'use strict';
// The accessibility reader as a source of meeting signals: runs the native helper of this OS while a recording is on,
// reads the browser window's tree with the selectors, and tells the hub who is on the call and who is speaking.
const fs = require('node:fs');
const path = require('node:path');
const { HelperProcess } = require('./helper');
const { compileSelectors, MeetingReader } = require('./a11y');

const SOURCE = 'a11y';
const DEFAULT_SELECTORS = path.join(__dirname, 'selectors', 'meet.json');

// Where the helper of this OS is, and how to call it. -> { command, args(mode, opts), file } or null when there is none.
// roots: places to look, in order (the build folder in development, the resources folder when installed).
function helperSpec(platformId, { roots = [], exists = fs.existsSync } = {}) {
  const find = (rel) => roots.map((r) => path.join(r, rel)).find((p) => exists(p)) || null;
  if (platformId === 'linux') {
    const file = find('atspi/whisperbrain-atspi') || find('bin/whisperbrain-atspi');
    return file && { file, command: file, args: (mode, o = {}) => ['--interval-ms', String(o.intervalMs || 500), ...(mode === 'dump' ? ['--dump'] : mode === 'windows' ? ['--once'] : [])] };
  }
  if (platformId === 'darwin') {
    const file = find('ax/whisperbrain-ax') || find('bin/whisperbrain-ax');
    return file && { file, command: file, args: (mode, o = {}) => (mode === 'permission' ? ['permission'] : [mode === 'dump' ? 'dump' : mode === 'windows' ? 'windows' : 'watch', '--interval-ms', String(o.intervalMs || 500)]) };
  }
  if (platformId === 'win32') {
    const file = find('windows/whisperbrain-uia.ps1') || find('bin/whisperbrain-uia.ps1');
    return file && { file, command: 'powershell.exe', args: (mode, o = {}) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Mode', mode === 'dump' ? 'dump' : mode === 'windows' ? 'windows' : 'watch', '-IntervalMs', String(o.intervalMs || 500)] };
  }
  return null;
}

function loadSelectors(userFile, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let note = '';
  if (userFile) {
    try { return { sel: compileSelectors(JSON.parse(read(userFile))), file: userFile, note }; } catch (e) { if (e.code !== 'ENOENT') note = `your selectors file was ignored: ${e.message}`; }
  }
  return { sel: compileSelectors(JSON.parse(read(DEFAULT_SELECTORS))), file: DEFAULT_SELECTORS, note };
}

class A11ySource {
  // spec: helperSpec(...) or null. userSelectors: path of a selectors file that wins over the shipped one.
  constructor({ hub, spec, userSelectors = null, spawn = undefined, backoff = undefined, intervalMs = 500 }) {
    Object.assign(this, { hub, spec, userSelectors, spawn, backoff, intervalMs });
    this.proc = null;
    this.readers = new Map();  // window title -> MeetingReader
  }

  get on() { return !!this.proc; }

  start() {
    if (this.proc) return true;
    if (!this.spec) { this.hub.report(SOURCE, { kind: 'a11y', state: 'off', detail: 'no accessibility helper for this system' }); return false; }
    let loaded;
    try { loaded = loadSelectors(this.userSelectors); } catch (e) { this.hub.report(SOURCE, { kind: 'a11y', state: 'error', detail: `selectors: ${e.message}` }); return false; }
    this.selectors = loaded;
    this.readers.clear();
    const proc = new HelperProcess({ command: this.spec.command, args: this.spec.args('watch', { intervalMs: this.intervalMs }), spawn: this.spawn, backoff: this.backoff, label: 'accessibility helper' });
    proc.on('message', (m) => this.onMessage(m));
    proc.on('restart', ({ error }) => this.hub.report(SOURCE, { kind: 'a11y', state: 'error', detail: error.message }));
    proc.on('unavailable', (e) => { this.proc = null; this.hub.report(SOURCE, { kind: 'a11y', state: 'error', detail: e.message }); });
    this.proc = proc;
    this.hub.report(SOURCE, { kind: 'a11y', state: 'waiting', detail: loaded.note || 'looking for a meeting window' });
    proc.start();
    return true;
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    p.stop();
    // whoever was highlighted is not any more
    if ([...this.readers.values()].some((r) => r.speaker)) { try { this.hub.ingest({ type: 'speaker', name: null }, { source: SOURCE, kind: 'a11y' }); } catch { /* nobody listens */ } }
    this.readers.clear();
    this.hub.report(SOURCE, { kind: 'a11y', state: 'off', detail: '' });
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
      const key = m.window || '';
      let r = this.readers.get(key);
      if (!r) { r = new MeetingReader(this.selectors.sel); this.readers.set(key, r); }
      let msgs;
      try { msgs = r.feed(m); } catch (e) { return report('error', `reading the page: ${e.message}`); }
      for (const msg of msgs) { try { this.hub.ingest(msg, { source: SOURCE, kind: 'a11y' }); } catch { /* a bad message from a helper is dropped */ } }
      if (this.hub.sources.get(SOURCE)?.state !== 'connected') report('connected', '');
      if (!msgs.length && !r.inCall) report('waiting', this.selectors.sel.verified ? 'in a meeting window, no participants list found' : 'no participants list found (the selectors are not verified against the real page)');
    }
  }
}

module.exports = { A11ySource, helperSpec, loadSelectors, DEFAULT_SELECTORS };
