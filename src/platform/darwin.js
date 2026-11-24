'use strict';
// macOS adapter. Capture runs in the renderer (getUserMedia for the mic; getDisplayMedia with Electron's
// 'loopback' audio, which uses ScreenCaptureKit on macOS 13+, for system audio) and is pushed to the server.
// NOTE: written without access to a Mac - only the pure parsers are unit-tested.
const { execFile } = require('node:child_process');
const { classify, classifyWindowTitle } = require('./apps');

const run = (cmd, args, { timeout = 4000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
});

// `pmset -g assertions` lists, per process, what it keeps the machine awake for. Call apps hold
// "PreventUserIdleDisplaySleep" assertions named like "Call in progress"/"Zoom Meeting". There is no public
// CLI that says "this process is using the microphone", so this is a heuristic.
function parsePmsetAssertions(text) {
  const out = [];
  const re = /pid\s+(\d+)\(([^)]*)\):\s+\[[^\]]*\]\s+[\d:]+\s+(\w+)\s+named:\s+"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) out.push({ pid: Number(m[1]), process: m[2], type: m[3], name: m[4] });
  return out;
}

const CALL_HINT = /(call|meeting|huddle|audio|webrtc|voice|conference)/i;

function micUsersFromAssertions(assertions) {
  const apps = [];
  const seen = new Set();
  for (const a of assertions) {
    if (!/PreventUserIdle(Display)?Sleep|NoDisplaySleep/.test(a.type)) continue;
    const cls = classify({ name: a.process, binary: a.process, title: a.name });
    if (!cls || cls.id === 'other') continue;
    const confident = cls.id !== 'browser' || CALL_HINT.test(a.name);
    if (!confident || seen.has(cls.id)) continue;
    seen.add(cls.id);
    apps.push({ name: cls.name, appId: cls.id, weak: !!cls.weak, pid: a.pid });
  }
  return apps;
}

// The browser windows the accessibility helper lists (`whisperbrain-ax windows`) that are a call, by their titles.
function meetingWindowsFromHelper(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.event !== 'windows' || !Array.isArray(m.windows)) continue;
    return m.windows.map((w) => ({ ...w, cls: classifyWindowTitle(w.title) })).filter((w) => w.cls).map((w) => ({ title: w.title, app: w.app, platform: w.cls.id }));
  }
  return [];
}

// windowsHelper: { command, args(mode) } from src/meet/a11y-source.js, when the helper is there
function create({ clipboard, windowsHelper = null } = {}) {
  return {
    id: 'darwin',
    session: 'aqua',
    capture: { mic: 'renderer', system: 'renderer' },
    async capabilities() {
      return {
        platform: 'darwin', session: 'aqua', mic: true, systemAudio: true, micActivity: true, paste: true,
        notes: [
          'System audio needs macOS 13+ and the Screen & System Audio Recording permission.',
          'Auto-paste needs the Accessibility permission.',
          'Meeting detection is heuristic on macOS (power assertions of call apps).',
        ],
      };
    },
    async listMics() { return []; }, // enumerated in the renderer
    createMicSource() { return null; },
    async createSystemSource() { return null; },
    async micActivity() {
      const out = await run('pmset', ['-g', 'assertions']);
      if (out === null) return { supported: false, active: false, apps: [] };
      const apps = micUsersFromAssertions(parsePmsetAssertions(out));
      return { supported: true, active: apps.length > 0, apps, heuristic: true };
    },
    async activeWindowTitle() {
      const out = await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
      return (out || '').trim();
    },
    // Listing other apps' window titles needs the Accessibility permission. The helper never asks for it here (this runs in
    // the background): without it the list is empty and the power assertions above carry the detection, as before.
    async meetingWindows() {
      if (!windowsHelper) return [];
      const out = await run(windowsHelper.command, windowsHelper.args('windows'), { timeout: 4000 });
      return out === null ? [] : meetingWindowsFromHelper(out);
    },
    clipboard,
    async paste(text, { restore = true } = {}) {
      if (!clipboard) return { ok: false, method: 'none', reason: 'no clipboard available' };
      const previous = restore ? clipboard.read() : null;
      clipboard.write(text);
      const r = await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
      if (r === null) return { ok: false, method: 'clipboard', reason: 'grant the Accessibility permission to enable auto-paste; text is on the clipboard' };
      if (previous !== null) setTimeout(() => clipboard.write(previous), 400);
      return { ok: true, method: 'osascript' };
    },
  };
}

module.exports = { create, parsePmsetAssertions, micUsersFromAssertions, meetingWindowsFromHelper };
