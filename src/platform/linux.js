'use strict';
const { execFile, spawn } = require('node:child_process');
const { ProcessSource } = require('../audio/source');
const { classify, classifyWindowTitle } = require('./apps');

const run = (cmd, args, { timeout = 3000, input } = {}) => new Promise((resolve) => {
  const p = execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  if (input !== undefined) p.stdin.end(input);
});
const has = async (cmd) => (await run('sh', ['-c', `command -v ${cmd}`])) !== null;

// ---- pw-dump parsing (pure, unit-tested against fixtures) ----
function parsePwDump(json) {
  const objs = typeof json === 'string' ? JSON.parse(json) : json;
  const out = { defaultSink: null, defaultSource: null, sources: [], sinks: [], inputStreams: [] };
  for (const o of objs) {
    if (o.type === 'PipeWire:Interface:Metadata') {
      for (const m of o.metadata || []) {
        if (m.key === 'default.audio.sink') out.defaultSink = m.value?.name || null;
        if (m.key === 'default.audio.source') out.defaultSource = m.value?.name || null;
      }
    } else if (o.type === 'PipeWire:Interface:Node') {
      const p = o.info?.props || {};
      const cls = p['media.class'];
      if (cls === 'Audio/Source') out.sources.push({ id: p['node.name'], name: p['node.description'] || p['node.nick'] || p['node.name'] });
      else if (cls === 'Audio/Sink') out.sinks.push({ id: p['node.name'], name: p['node.description'] || p['node.name'] });
      else if (cls === 'Stream/Input/Audio') {
        out.inputStreams.push({
          running: o.info?.state === 'running',
          name: p['application.name'] || p['node.name'] || '',
          binary: p['application.process.binary'] || '',
          pid: Number(p['application.process.id']) || null,
          title: p['media.name'] || '',
          monitor: p['stream.capture.sink'] === 'true' || p['stream.capture.sink'] === true,
        });
      }
    }
  }
  return out;
}

// Applications currently capturing from a microphone (not from a sink monitor), excluding ourselves.
function micUsers(parsed, { selfPids = [process.pid] } = {}) {
  const apps = [];
  for (const s of parsed.inputStreams) {
    if (!s.running || s.monitor) continue;
    if (s.pid && selfPids.includes(s.pid)) continue;
    const cls = classify({ name: s.name, binary: s.binary, title: s.title });
    if (!cls) continue;
    apps.push({ name: cls.name, appId: cls.id, weak: !!cls.weak, pid: s.pid });
  }
  return apps;
}

async function pwDump() {
  const out = await run('pw-dump', [], { timeout: 4000 });
  if (!out) return null;
  try { return parsePwDump(out); } catch { return null; }
}

// ---- top-level window titles (X11; pure parsers unit-tested) ----
// `wmctrl -lx`: "<id> <desktop> <instance.Class> <host> <title>"
function parseWmctrl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\S+)\s+(\S+)(?:\s(.*))?$/i.exec(line.trimEnd());
    if (m && m[5]?.trim()) out.push({ id: m[1], title: m[5].trim(), app: m[3].split('.').pop() });
  }
  return out;
}

// `xprop -root _NET_CLIENT_LIST` -> window ids
function parseClientList(text) {
  const m = /window id #\s*(.*)$/m.exec(String(text || ''));
  return m ? m[1].split(/\s*,\s*/).filter((x) => /^0x[0-9a-f]+$/i.test(x)) : [];
}

const xstr = (s) => s.replace(/\\(.)/g, '$1');
// `xprop -id <id> _NET_WM_NAME WM_CLASS` -> { title, app }
function parseXpropWindow(text) {
  const t = String(text || '');
  const name = /^(?:_NET_WM_NAME|WM_NAME)\([^)]*\) = "((?:[^"\\]|\\.)*)"/m.exec(t);
  const cls = /^WM_CLASS\([^)]*\) = (.*)$/m.exec(t);
  const parts = cls ? [...cls[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => xstr(x[1])) : [];
  return { title: name ? xstr(name[1]) : '', app: parts[1] || parts[0] || '' };
}

// Only windows that look like an ongoing call are returned (titles of everything else never leave this function).
function meetingWindowsFrom(list) {
  return list.map((w) => ({ title: w.title, app: w.app, cls: classifyWindowTitle(w.title) })).filter((w) => w.cls)
    .map((w) => ({ title: w.title, app: w.app, platform: w.cls.id }));
}

// ---- display server ----
function sessionKind(env = process.env) {
  if (env.XDG_SESSION_TYPE === 'wayland' || (env.WAYLAND_DISPLAY && !env.DISPLAY)) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'none';
}

const TERMINALS = /(gnome-terminal|konsole|xterm|kitty|alacritty|tilix|terminator|wezterm|foot|xfce4-terminal|st-256color|urxvt|ptyxis|terminal)/i;

function create({ x11Helper, env = process.env, clipboard: hostClipboard } = {}) {
  const kind = sessionKind(env);

  async function defaultNames() {
    const d = await pwDump();
    return { defaultSink: d?.defaultSink || null, defaultSource: d?.defaultSource || null, parsed: d };
  }

  const clipboard = hostClipboard || {
    async read() {
      if (kind === 'wayland') return run('wl-paste', ['--no-newline']);
      return run('xclip', ['-selection', 'clipboard', '-o']);
    },
    async write(text) {
      if (kind === 'wayland') return run('wl-copy', [], { input: text }) !== null;
      // xclip stays alive to serve the selection; don't wait for it to exit.
      return new Promise((resolve) => {
        const p = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
        p.on('error', () => resolve(false));
        p.stdin.on('error', () => {});
        p.stdin.end(text, () => { p.unref(); setTimeout(() => resolve(true), 60); });
      });
    },
  };

  async function activeWindowClass() {
    if (kind !== 'x11') return '';
    const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
    const id = /window id # (0x[0-9a-f]+)/i.exec(root || '')?.[1];
    if (!id || /^0x0+$/.test(id)) return '';
    return (await run('xprop', ['-id', id, 'WM_CLASS'])) || '';
  }

  return {
    id: 'linux',
    session: kind,
    // 'native' = main process captures; 'renderer' = the UI must capture and push PCM.
    capture: { mic: 'native', system: 'native' },

    async capabilities() {
      const [pw, xclip, wl, wtype, helper] = await Promise.all([has('pw-record'), has('xclip'), has('wl-copy'), has('wtype'), Promise.resolve(!!x11Helper)]);
      const canPaste = kind === 'x11' ? (xclip && helper) : kind === 'wayland' ? (wl && wtype) : false;
      return {
        platform: 'linux', session: kind,
        mic: pw, systemAudio: pw, micActivity: pw, paste: canPaste,
        notes: [
          !pw && 'Install PipeWire (pw-record, pw-dump) to capture audio.',
          kind === 'x11' && !helper && 'Build the X11 helper (npm run build:x11) to enable auto-paste.',
          kind === 'wayland' && 'Auto-paste works on wlroots compositors; elsewhere the text stays on the clipboard.',
        ].filter(Boolean),
      };
    },

    async listMics() {
      const d = await pwDump();
      if (!d) return [];
      return d.sources.filter((s) => !/\.monitor$/.test(s.id)).map((s) => ({ id: s.id, name: s.name, default: s.id === d.defaultSource }));
    },

    createMicSource({ device } = {}) {
      const args = ['--rate', '16000', '--channels', '1', '--format', 's16', '--media-role', 'Communication'];
      if (device) args.push('--target', device);
      return new ProcessSource('pw-record', [...args, '-'], { label: 'pw-record (mic)' });
    },

    // Captures whatever the default output device is playing (its monitor), without any virtual device.
    async createSystemSource({ sink } = {}) {
      const target = sink || (await defaultNames()).defaultSink;
      if (!target) throw new Error('no default audio output found');
      const args = ['--rate', '16000', '--channels', '1', '--format', 's16', '-P', 'stream.capture.sink=true', '--target', target, '-'];
      return new ProcessSource('pw-record', args, { label: 'pw-record (system audio)' });
    },

    async micActivity() {
      const d = await pwDump();
      if (!d) return { supported: false, active: false, apps: [] };
      const apps = micUsers(d);
      return { supported: true, active: apps.length > 0, apps };
    },

    async activeWindowTitle() {
      if (kind !== 'x11') return '';
      const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
      const id = /window id # (0x[0-9a-f]+)/i.exec(root || '')?.[1];
      if (!id) return '';
      return /"(.*)"/.exec((await run('xprop', ['-id', id, '_NET_WM_NAME'])) || '')?.[1] || '';
    },

    // Visible top-level windows whose title shows a meeting in progress. X11 only; [] on Wayland/elsewhere.
    async meetingWindows() {
      if (kind !== 'x11') return [];
      const wm = await run('wmctrl', ['-lx']);
      if (wm !== null) return meetingWindowsFrom(parseWmctrl(wm));
      const ids = parseClientList(await run('xprop', ['-root', '_NET_CLIENT_LIST'])).slice(0, 200);
      const wins = await Promise.all(ids.map(async (id) => parseXpropWindow(await run('xprop', ['-id', id, '_NET_WM_NAME', 'WM_CLASS'], { timeout: 1500 }))));
      return meetingWindowsFrom(wins.filter((w) => w.title));
    },

    clipboard,

    // Put text on the clipboard and send the paste shortcut. Returns what actually happened.
    async paste(text, { restore = true } = {}) {
      const previous = restore ? await clipboard.read() : null;
      if (!(await clipboard.write(text))) return { ok: false, method: 'none', reason: 'could not write to the clipboard' };
      let result;
      if (kind === 'x11' && x11Helper) {
        const term = TERMINALS.test(await activeWindowClass());
        const ok = (await run(x11Helper, term ? ['paste', 'term'] : ['paste'])) !== null;
        result = ok ? { ok: true, method: 'xtest' } : { ok: false, method: 'clipboard', reason: 'XTest paste failed' };
      } else if (kind === 'wayland' && (await has('wtype'))) {
        const ok = (await run('wtype', ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'])) !== null;
        result = ok ? { ok: true, method: 'wtype' } : { ok: false, method: 'clipboard', reason: 'this compositor does not accept virtual keyboard input; text is on the clipboard' };
      } else {
        result = { ok: false, method: 'clipboard', reason: 'no way to send keystrokes here; text is on the clipboard' };
      }
      if (result.ok && previous !== null) setTimeout(() => { clipboard.write(previous); }, 400);
      return result;
    },
  };
}

module.exports = { create, parsePwDump, micUsers, sessionKind, parseWmctrl, parseClientList, parseXpropWindow, meetingWindowsFrom };
