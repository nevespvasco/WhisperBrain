'use strict';
// Automatic updates from the GitHub Releases of this project (electron-updater reads latest.yml / latest-linux.yml).
//
// Where it works:
//   Windows  the NSIS installer (not the "portable" build: nothing to replace)
//   Linux    the AppImage (the .deb belongs to the package manager, which an app must not bypass)
//   macOS    not yet: Squirrel.Mac refuses an update that is not signed with a Developer ID, and the builds are unsigned
//
// The logic lives here with the updater injected, so it is tested without Electron. electron/main.js wires the real one.

const HOUR = 3600 * 1000;

// Can this installation replace itself? (env = process.env)
function supported({ platform, packaged, env = {} }) {
  if (!packaged) return false;
  if (platform === 'win32') return !env.PORTABLE_EXECUTABLE_FILE && !env.PORTABLE_EXECUTABLE_DIR;
  if (platform === 'linux') return !!env.APPIMAGE;
  return false;
}

// How to start the new version after an update (app.relaunch options), or null where the installer does it (Windows).
// Linux: the AppImage file itself. No --no-sandbox here: its launcher (electron-builder's AppRun) adds the switch only when
// user namespaces do not work on this system, so the sandbox stays on wherever it can run (docs/packaging.md §3).
function relaunchOptions({ platform, env = {} }) {
  if (platform !== 'linux' || !env.APPIMAGE) return null;
  return { execPath: env.APPIMAGE, args: [] };
}

// updater: electron-updater's autoUpdater. enabled(): the person's setting. busy(): a recording is running.
// ask(version): resolves true to restart now. restart(): shut the app down cleanly, then install and relaunch.
function createUpdates({ updater, enabled, busy, ask, notify, restart, log = () => {}, firstCheckMs = 30000, everyMs = 6 * HOUR, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let ready = null;      // version downloaded and waiting for a restart
  let checking = false;
  let manual = false;    // the current check was asked for by the person: say the result even when there is nothing new
  let asking = false;
  let timer = null;
  let stopped = false;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false; // WhisperBrain shuts down in its own way (recording, database): install only through restart()
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: () => {}, debug: () => {} };

  async function offer() {
    if (!ready || asking) return;
    if (busy()) return; // never restart in the middle of a meeting: offered again when the recording stops
    asking = true;
    try {
      if (await ask(ready)) await restart(); // returns only if the install could not start
    } catch (e) { log('error', `update restart failed: ${e.message}`); }
    finally { asking = false; }
  }

  updater.on('update-available', (info) => log('info', `update ${info?.version} found, downloading`));
  updater.on('update-not-available', () => {
    if (manual) notify('WhisperBrain is up to date', 'You have the latest version.');
    manual = false;
  });
  updater.on('update-downloaded', (info) => {
    ready = info?.version || 'new';
    manual = false;
    if (busy()) notify('Update ready', `WhisperBrain ${ready} is downloaded. It will ask to restart when your recording ends.`);
    offer();
  });
  updater.on('error', (e) => { // electron-updater emits this and also rejects checkForUpdates(): reported here, once
    log('error', `update check failed: ${String(e?.message || e).split('\n')[0]}`);
    if (manual) notify('Could not check for updates', 'Try again later, or download the new version from the GitHub releases page.');
    manual = false;
  });

  // The setting is the person's: with it off nothing is contacted. A manual check is allowed either way.
  async function check({ byHand = false } = {}) {
    if (stopped || checking) return;
    if (!byHand && !enabled()) return;
    if (ready) { offer(); return; } // already downloaded: no need to ask GitHub again
    checking = true;
    manual = byHand;
    try { await updater.checkForUpdates(); }
    catch { /* the 'error' event above already reported it */ manual = false; }
    finally { checking = false; }
  }

  function schedule(ms) {
    timer = setTimer(async () => { await check(); if (!stopped) schedule(everyMs); }, ms);
    timer.unref?.();
  }

  return {
    start() { if (!timer) schedule(firstCheckMs); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
    check,
    offer,                       // call when a recording ends
    get ready() { return ready; },
  };
}

module.exports = { supported, createUpdates, relaunchOptions, HOUR };
