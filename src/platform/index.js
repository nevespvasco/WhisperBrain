'use strict';
// Picks the adapter for the current OS. Each adapter exposes the same surface:
//   id, session, capture{mic,system} ('native'|'renderer'), capabilities(), listMics(),
//   createMicSource(opts), createSystemSource({ app }), micActivity(), activeWindowTitle(), clipboard, paste(text)
// A native adapter may also offer openMicSource(opts) (async): the microphone for a recording with echo cancellation applied
// when it can be, returned with `.aec` = { requested, active, backend, reason }. Without it the recording uses createMicSource().
const fs = require('node:fs');
const path = require('node:path');
const { captureHelperSpec } = require('./native-capture');

function x11HelperPath(root) {
  for (const p of [
    path.join(root, 'build', 'x11', 'whisperbrain-x11'),
    path.join(process.resourcesPath || '', 'bin', 'whisperbrain-x11'),
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

function createPlatform({ platform = process.platform, clipboard, root = path.join(__dirname, '..', '..') } = {}) {
  if (platform === 'linux') return require('./linux').create({ clipboard, x11Helper: x11HelperPath(root) });
  const roots = [path.join(root, 'build'), process.resourcesPath || ''].filter(Boolean);
  if (platform === 'darwin') return require('./darwin').create({ clipboard, windowsHelper: require('../meet/a11y-source').helperSpec('darwin', { roots }), captureHelper: captureHelperSpec('darwin', { roots }) });
  if (platform === 'win32') return require('./win32').create({ clipboard, captureHelper: captureHelperSpec('win32', { roots }) });
  throw new Error(`unsupported platform: ${platform}`);
}

module.exports = { createPlatform };
