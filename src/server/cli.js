#!/usr/bin/env node
'use strict';
// Headless server: `node src/server/cli.js [--port 3787] [--data ~/.local/share/whisperbrain]`
// Useful for development and for running WhisperBrain on a box without Electron. Prints a one-time login URL.
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./app');
const { createServer } = require('./http');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };

(async () => {
  const dataDir = arg('data', process.env.WHISPERBRAIN_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'whisperbrain'));
  const modelsDir = process.env.WB_MODELS_DIR;
  const app = createApp({ dataDir, modelsDir, version: require('../../package.json').version, detect: true });
  const srv = createServer(app, { uiDir: path.join(__dirname, '..', '..', 'ui') });
  const { port, token } = await srv.listen(Number(arg('port', 3787)));
  console.log(`WhisperBrain server on http://127.0.0.1:${port}`);
  console.log(`Open: http://127.0.0.1:${port}/?token=${token}`);
  const stop = async () => { await srv.close(); app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
