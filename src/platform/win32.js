'use strict';
// Windows adapter. Capture runs in the renderer (getUserMedia for the mic; getDisplayMedia with Electron's
// 'loopback' audio, which is WASAPI loopback, for system audio) and is pushed to the server.
// Microphone usage comes from the Capability Access Manager registry, which Windows maintains per app.
// NOTE: written without access to Windows - only the pure parsers are unit-tested.
const { execFile } = require('node:child_process');
const path = require('node:path');
const { classify, classifyWindowTitle } = require('./apps');
const { systemSource } = require('./native-capture');

const run = (cmd, args, { timeout = 5000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
});

const CONSENT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

// Parse `reg query <key> /s`. An app is using the mic when LastUsedTimeStart is set and
// LastUsedTimeStop is 0 (or older than Start).
function parseConsentStore(text) {
  const apps = [];
  let key = null;
  let cur = null;
  const flush = () => { if (cur && cur.start > 0n && (cur.stop === 0n || cur.start > cur.stop)) apps.push(cur); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^HKEY_/i.test(line)) {
      flush();
      key = line;
      cur = { key, start: 0n, stop: 0n };
      continue;
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (m && cur) cur[m[1] === 'LastUsedTimeStart' ? 'start' : 'stop'] = BigInt(m[2]);
  }
  flush();
  return apps.map((a) => {
    const tail = a.key.split('\\').pop();
    const exe = tail.includes('#') ? path.win32.basename(tail.replace(/#/g, '\\')) : tail;
    return { exe };
  });
}

function micUsers(entries) {
  const out = [];
  for (const { exe } of entries) {
    const cls = classify({ name: exe.replace(/\.exe$/i, ''), binary: exe });
    if (!cls) continue;
    out.push({ name: cls.name === 'Unknown app' ? exe : cls.id === 'other' ? exe.replace(/\.exe$/i, '') : cls.name, appId: cls.id, weak: !!cls.weak, pid: null, exe });
  }
  return out;
}

// `tasklist /v /fo csv`: one row per process; the last column is its main window title ("N/A" when none).
// Column headers are localised, so only positions are used: first = image name, last = window title.
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseTasklistCsv(text) {
  const rows = String(text || '').split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
  return rows.slice(1).filter((r) => r.length >= 3).map((r) => ({ app: r[0].replace(/\.exe$/i, ''), title: r[r.length - 1].trim() }))
    .filter((w) => w.title && w.title !== 'N/A');
}

function meetingWindowsFrom(list) {
  return list.map((w) => ({ ...w, cls: classifyWindowTitle(w.title) })).filter((w) => w.cls).map((w) => ({ title: w.title, app: w.app, platform: w.cls.id }));
}

// captureHelper: { command, prefixArgs } from src/platform/native-capture.js: system audio from the helper (WASAPI process
// loopback, else the whole output) instead of the renderer. The microphone stays with the renderer.
function create({ clipboard, captureHelper = null } = {}) {
  return {
    id: 'win32',
    session: 'desktop',
    capture: { mic: 'renderer', system: captureHelper ? 'native' : 'renderer' },
    renderer: { system: true },   // the window can capture it too, if the helper stops (an error)
    async capabilities() {
      return { platform: 'win32', session: 'desktop', mic: true, systemAudio: true, micActivity: true, paste: true, notes: [] };
    },
    async listMics() { return []; }, // enumerated in the renderer
    createMicSource() { return null; },
    // Native only (see captureHelper); null = the renderer captures it.
    async createSystemSource({ app } = {}) { return captureHelper ? systemSource(captureHelper, app) : null; },
    async micActivity() {
      const out = await run('reg', ['query', CONSENT, '/s']);
      if (out === null) return { supported: false, active: false, apps: [] };
      const apps = micUsers(parseConsentStore(out));
      return { supported: true, active: apps.length > 0, apps };
    },
    async activeWindowTitle() { return ''; },
    // Best effort: each process's main window title (a browser shows only its active tab).
    async meetingWindows() {
      const out = await run('tasklist', ['/v', '/fo', 'csv', '/fi', 'STATUS eq RUNNING'], { timeout: 6000 });
      return out === null ? [] : meetingWindowsFrom(parseTasklistCsv(out));
    },
    clipboard,
    async paste(text, { restore = true } = {}) {
      if (!clipboard) return { ok: false, method: 'none', reason: 'no clipboard available' };
      const previous = restore ? clipboard.read() : null;
      clipboard.write(text);
      const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      if (r === null) return { ok: false, method: 'clipboard', reason: 'could not send Ctrl+V; text is on the clipboard' };
      if (previous !== null) setTimeout(() => clipboard.write(previous), 400);
      return { ok: true, method: 'sendkeys' };
    },
  };
}

module.exports = { create, parseConsentStore, micUsers, parseTasklistCsv, meetingWindowsFrom };
