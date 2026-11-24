'use strict';
// Picks the adapter for the current OS. Each adapter exposes the same surface:
//   id, session, capture{mic,system} ('native'|'renderer'), capabilities(), listMics(),
//   createMicSource(opts), createSystemSource(), micActivity(), activeWindowTitle(), clipboard, paste(text)
const fs = require('node:fs');
const path = require('node:path');

function x11HelperPath(root) {
  for (const p of [
    path.join(root, 'build', 'x11', 'whisperbrain-x11'),
    path.join(process.resourcesPath || '', 'bin', 'whisperbrain-x11'),
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

function createPlatform({ platform = process.platform, clipboard, root = path.join(__dirname, '..', '..') } = {}) {
  if (platform === 'linux') return require('./linux').create({ clipboard, x11Helper: x11HelperPath(root) });
  if (platform === 'darwin') return require('./darwin').create({ clipboard });
  if (platform === 'win32') return require('./win32').create({ clipboard });
  throw new Error(`unsupported platform: ${platform}`);
}

module.exports = { createPlatform };
