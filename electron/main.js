'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, Tray, Notification, globalShortcut, session, desktopCapturer, shell, clipboard, nativeImage, systemPreferences, ipcMain, screen } = require('electron');
const { SIZE, shouldShow, placeWithin, defaultBounds } = require('./float');

const ROOT = path.join(__dirname, '..');
const SMOKE = process.env.WB_SMOKE === '1';

app.setName('WhisperBrain');
if (process.env.WB_USER_DATA) app.setPath('userData', process.env.WB_USER_DATA);
if (!app.requestSingleInstanceLock() && !SMOKE) { app.quit(); process.exit(0); }

const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');

let core = null;
let server = null;
let win = null;
let tray = null;
let pill = null;
let float = null;           // the floating recorder window
let floatExpanded = false;
let floatAnchorRight = false;
let floatKeepUntil = 0;      // keep it up briefly after Stop so "Notes saved" is seen
let floatTimer = null;
let floatSaveTimer = null;
let quitting = false;
let registeredHotkey = null;
let origin = '';

// The OS clipboard as the platform adapters expect it (sync read/write of text).
const hostClipboard = { read: () => clipboard.readText(), write: (t) => clipboard.writeText(t) };

function resource(...p) { return path.join(app.isPackaged ? process.resourcesPath : ROOT, ...p); }

async function start() {
  const dataDir = app.getPath('userData');
  core = createApp({ dataDir, clipboard: hostClipboard, version: app.getVersion(), detect: true, openExternal: (u) => shell.openExternal(u), renderPdf });
  server = createServer(core, { uiDir: path.join(ROOT, 'ui') });
  const { port, token, url } = await server.listen(0);
  origin = url;
  if (process.env.WB_STATE_FILE) fs.writeFileSync(process.env.WB_STATE_FILE, JSON.stringify({ port, token, dataDir }));

  setupSession();
  buildMenu();
  createWindow(`${url}/?token=${token}`);
  createTray();
  wireEvents();
  wireFloat();
  registerHotkey();
}

function setupSession() {
  const ses = session.defaultSession;
  // Only our own UI may use the microphone / screen audio.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = ['media', 'display-capture'].includes(permission) && String(details?.requestingUrl || wc.getURL()).startsWith(origin);
    cb(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => ['media', 'display-capture'].includes(permission) && String(requestingOrigin).startsWith(origin));
  // System audio on macOS/Windows: answer getDisplayMedia() with the OS loopback (ScreenCaptureKit / WASAPI).
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      cb({ video: sources[0], audio: 'loopback' });
    } catch { cb({}); }
  }, { useSystemPicker: false });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 380, minHeight: 520, show: !SMOKE,
    title: 'WhisperBrain', backgroundColor: '#f5f4fb', icon: resource('build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu?.();
  win.loadURL(url);
  // Never navigate away from our UI; open web links in the real browser.
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^(https?|mailto|obsidian|notion|linear):/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(origin)) { e.preventDefault(); if (/^(https?|obsidian|notion|linear):/i.test(u)) shell.openExternal(u); } });
  win.on('close', (e) => {
    if (quitting) return;
    if (core?.recording.status().active) { e.preventDefault(); win.hide(); notify('WhisperBrain', 'Still recording in the background. Use the tray icon to reopen or stop.'); }
  });
  // If the page process dies (out of memory, GPU trouble), reload it instead of leaving a blank white window.
  // Back off when it keeps dying so a crash on load does not spin.
  let crashes = [];
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`renderer gone: ${d.reason} (exit ${d.exitCode})`);
    if (quitting || d.reason === 'clean-exit' || !win || win.isDestroyed()) return;
    const now = Date.now();
    crashes = crashes.filter((at) => now - at < 60000).concat(now);
    if (crashes.length <= 3) setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(url); }, 500 * crashes.length);
  });
  win.on('closed', () => { win = null; updateFloat(); });
  for (const ev of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) win.on(ev, updateFloat);
  if (SMOKE) win.webContents.once('did-finish-load', () => setTimeout(smoke, 1500));
}

// HTML → PDF in a hidden, sandboxed window with JavaScript disabled (the HTML is our own export).
async function renderPdf(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  } finally { w.destroy(); }
}

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function buildMenu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(resource('resources', 'tray.png'));
    tray = new Tray(img);
    tray.setToolTip('WhisperBrain');
    const refresh = () => {
      const rec = core.recording.status().active;
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open WhisperBrain', click: showWindow },
        { label: rec ? 'Stop recording' : 'Start a new recording', click: async () => { try { if (rec) await core.recording.stop(); else { const n = core.notes.create({}); await core.recording.start(n.id); showWindow(); } } catch (e) { notify('WhisperBrain', e.message); } } },
        { label: 'Toggle dictation', click: () => toggleDictation(), enabled: !!core.settings.get('dictation').enabled },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.setToolTip(rec ? 'WhisperBrain — recording' : 'WhisperBrain');
    };
    refresh();
    tray.on('click', showWindow);
    core.bus.subscribe((e) => { if (e.type.startsWith('recording.') && e.type !== 'recording.level' || e.type === 'settings') refresh(); });
  } catch (e) { console.warn('tray unavailable:', e.message); }
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => { showWindow(); onClick?.(); });
  n.show();
}

function wireEvents() {
  core.bus.subscribe((e) => {
    if (e.type === 'meeting.detected') {
      const title = e.data.event?.summary || e.data.title;
      notify('Meeting detected', `${e.data.apps.join(', ')} is using your microphone${title ? ` — ${title}` : ''}. Click to take notes.`, () => win?.webContents.executeJavaScript(`location.hash = '#/?detected=1'`).catch(() => {}));
    } else if (e.type === 'meeting.autostarted') notify('Recording started', 'WhisperBrain is taking notes for this meeting.', () => win?.webContents.executeJavaScript(`location.hash = '#/note/${e.data.noteId}'`).catch(() => {}));
    else if (e.type === 'meeting.ended' && core.recording.status().active) notify('Meeting ended', 'The call app released the microphone.');
    else if (e.type === 'meeting.starting') notify('Meeting starting', e.data.event.summary, () => win?.webContents.executeJavaScript(`location.hash = '#/'`).catch(() => {}));
    else if (e.type === 'dictation.state') updatePill(e.data.state);
    else if (e.type === 'dictation.result' && e.data.paste && !e.data.paste.ok && e.data.text) notify('Dictation copied', e.data.paste.reason || 'The text is on your clipboard.');
    else if (e.type === 'settings') { registerHotkey(); updateFloat(); }
    else if (e.type === 'recording.started' || e.type === 'recording.finalizing') updateFloat();
    else if (e.type === 'recording.stopped') { floatKeepUntil = Date.now() + 4500; updateFloat(); setTimeout(updateFloat, 4700); }
  });
}

// ---- dictation: global shortcut + a small floating indicator ----
async function toggleDictation() {
  try { await core.dictation.toggle(); } catch (e) { notify('Dictation', e.message); }
}

function registerHotkey() {
  const cfg = core.settings.get('dictation');
  if (registeredHotkey) { globalShortcut.unregister(registeredHotkey); registeredHotkey = null; }
  if (!cfg.enabled || !cfg.hotkey) return;
  try {
    if (globalShortcut.register(cfg.hotkey, toggleDictation)) registeredHotkey = cfg.hotkey;
    else notify('Dictation', `Could not register ${cfg.hotkey}. Another app (or this desktop session) may own it.`);
  } catch (e) { notify('Dictation', `Invalid shortcut ${cfg.hotkey}`); }
}

function updatePill(state) {
  if (state === 'idle') { pill?.destroy(); pill = null; return; }
  const text = state === 'listening' ? '● Listening… press the shortcut to finish' : 'Transcribing…';
  const html = `<body style="margin:0;font:600 13px system-ui;color:#fff;background:${state === 'listening' ? '#c93c3c' : '#1f7a6d'};border-radius:999px;display:flex;align-items:center;justify-content:center;height:100vh">${text}</body>`;
  if (!pill) {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    pill = new BrowserWindow({ width: 300, height: 36, x: Math.round(wa.x + wa.width / 2 - 150), y: wa.y + 14, frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, hasShadow: true, show: false, webPreferences: { sandbox: true } });
    pill.setIgnoreMouseEvents(true);
    pill.once('ready-to-show', () => pill?.showInactive());
  }
  pill.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

// ---- floating recorder: a small always-on-top pill while recording and the app is out of sight ----
const widgetFile = () => path.join(app.getPath('userData'), 'widget.json');
const workAreas = () => screen.getAllDisplays().map((d) => d.workArea);

function savedFloatBounds() {
  try {
    const { x, y } = JSON.parse(fs.readFileSync(widgetFile(), 'utf8'));
    if (Number.isFinite(x) && Number.isFinite(y)) return placeWithin({ x, y, ...SIZE.collapsed }, workAreas());
  } catch { /* first run */ }
  return defaultBounds(screen.getPrimaryDisplay().workArea);
}

function rememberFloat() {
  clearTimeout(floatSaveTimer);
  floatSaveTimer = setTimeout(() => {
    if (!float || floatExpanded) return;
    const { x, y } = float.getBounds();
    try { fs.writeFileSync(widgetFile(), JSON.stringify({ x, y })); } catch { /* not worth failing for */ }
  }, 400);
}

function updateFloat() {
  if (!core) return;
  clearTimeout(floatTimer);
  floatTimer = setTimeout(applyFloat, 120); // focus/blur arrive in bursts; decide once they settle
}

function applyFloat(force = false) {
  const main = win && !win.isDestroyed() ? { minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused() } : null;
  const recording = core.recording.status().active || Date.now() < floatKeepUntil;
  if (force || shouldShow({ recording, mode: core.settings.get('floatingRecorder'), main })) showFloat(); else hideFloat();
}

function showFloat() {
  if (float && !float.isDestroyed()) return;
  floatExpanded = false;
  const b = savedFloatBounds();
  float = new BrowserWindow({
    ...b, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, show: false, title: 'WhisperBrain recorder',
    webPreferences: { preload: path.join(__dirname, 'widget-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  float.setAlwaysOnTop(true, 'floating');
  float.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  float.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  float.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(origin)) e.preventDefault(); });
  float.once('ready-to-show', () => { if (float && !float.isDestroyed()) float.showInactive(); });
  float.on('closed', () => { float = null; });
  float.loadURL(`${origin}/widget.html?token=${server.token}`);
}

function hideFloat() {
  if (float && !float.isDestroyed()) float.destroy();
  float = null;
}

function setFloatExpanded(expanded) {
  if (!float || float.isDestroyed() || expanded === floatExpanded) return;
  const b = float.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let next;
  if (expanded) {
    floatAnchorRight = b.x + b.width / 2 > wa.x + wa.width / 2; // grow towards the middle of the screen
    next = { ...SIZE.expanded, x: floatAnchorRight ? b.x + b.width - SIZE.expanded.width : b.x, y: b.y };
  } else {
    next = { ...SIZE.collapsed, x: floatAnchorRight ? b.x + b.width - SIZE.collapsed.width : b.x, y: b.y };
  }
  floatExpanded = expanded;
  float.setBounds(placeWithin(next, workAreas()));
  if (!expanded) rememberFloat();
}

function wireFloat() {
  const mine = (e) => float && !float.isDestroyed() && e.sender === float.webContents;
  ipcMain.on('widget:expanded', (e, expanded) => { if (mine(e)) setFloatExpanded(!!expanded); });
  ipcMain.on('widget:move', (e, dx, dy) => {
    if (!mine(e) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const b = float.getBounds();
    float.setBounds(placeWithin({ ...b, x: b.x + dx, y: b.y + dy }, workAreas()));
    rememberFloat();
  });
  ipcMain.on('widget:open', (e, noteId) => {
    if (!mine(e)) return;
    showWindow();
    if (/^[\w-]{1,64}$/.test(noteId)) win?.webContents.executeJavaScript(`location.hash = '#/note/${noteId}?tab=transcript'`).catch(() => {});
  });
}

// ---- smoke test (WB_SMOKE=1): load the UI, check it rendered, exit ----
async function smoke() {
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(500);
      const state = await fetch('/api/state').then((x) => x.json());
      return { title: document.title, sidebar: document.querySelector('#sidebar')?.children.length || 0, main: document.querySelector('#main h1')?.textContent || '', platform: state.platform, version: state.version,
               worklet: await fetch('/pcm-worklet.js').then((x) => x.status), widget: await Promise.all(['/widget.html', '/widget.js', '/widget.css'].map((u) => fetch(u).then((x) => x.status))), gum: typeof navigator.mediaDevices?.getUserMedia, secure: window.isSecureContext };
    })()`);
    console.log('SMOKE_RESULT ' + JSON.stringify(r));
    let ok = r.title === 'WhisperBrain' && r.sidebar >= 3 && r.main && r.worklet === 200 && r.widget.every((x) => x === 200);
    applyFloat(true); // the floating recorder must open, load its page and have its native bridge
    await new Promise((res) => { const t0 = Date.now(); const poll = () => (float && !float.webContents.isLoading() ? res() : Date.now() - t0 > 8000 ? res() : setTimeout(poll, 100)); poll(); });
    const fl = float ? await float.webContents.executeJavaScript(`({ bridge: typeof window.wbWidget?.move, pill: !!document.querySelector('.pill'), root: document.getElementById('w')?.dataset.state })`) : null;
    console.log('SMOKE_FLOAT ' + JSON.stringify(fl));
    if (!fl || fl.bridge !== 'function' || !fl.pill) ok = false;
    hideFloat();
    if (process.env.WB_SMOKE_MODELS) { // the ASR worker must run on Electron's own Node, as it does in the packaged app
      const { Models } = require('../src/asr/models');
      const { wavToPcm16 } = require('../src/audio/pcm');
      const m = new Models(process.env.WB_SMOKE_MODELS);
      const speakerModel = m.speakerInstalled() ? m.speakerPath() : null;
      await core.engine.start(m.resolve('auto'), { vadPath: m.vadPath(), speakerModel });
      const pcm = wavToPcm16(fs.readFileSync(process.env.WB_SMOKE_WAV || path.join(ROOT, 'test', 'fixtures', 'hello.wav')));
      const text = await core.engine.transcribe(pcm);
      console.log('SMOKE_ASR ' + text);
      if (speakerModel) { // the live path: VAD → recognizer → voice embedding, inside Electron's Node
        const { transcribePcm } = require('../src/recording/import');
        const segs = await transcribePcm(core.engine, pcm);
        const dims = segs.map((x) => x.embedding?.length || 0);
        console.log('SMOKE_SPEAKER ' + JSON.stringify({ segments: segs.length, dims }));
        if (!segs.some((x) => x.embedding?.length)) ok = false;
      }
    }
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
    await shutdown();
    app.exit(ok ? 0 : 1);
  } catch (e) { console.log('SMOKE_FAIL ' + e.message); app.exit(1); }
}

async function shutdown() {
  globalShortcut.unregisterAll();
  hideFloat();
  try { if (core?.recording.status().active) await Promise.race([core.recording.stop(), new Promise((r) => setTimeout(r, 15000))]); } catch { /* best effort */ }
  try { await server?.close(); core?.close(); } catch { /* best effort */ }
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => { if (!tray || process.platform !== 'darwin') { quitting = true; app.quit(); } });
app.on('activate', () => { if (!win && core) createWindow(`${origin}/?token=${server.token}`); else showWindow(); });
let shuttingDown = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (shuttingDown) return;
  shuttingDown = true;
  e.preventDefault();
  shutdown().finally(() => app.exit(0));
});

app.whenReady().then(start).catch((e) => { console.error(e); app.exit(1); });
