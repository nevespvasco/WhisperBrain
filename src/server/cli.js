#!/usr/bin/env node
'use strict';
// Headless server: `node src/server/cli.js [--port 3787] [--data ~/.local/share/whisperbrain]`
// Useful for development and for running WhisperBrain on a box without Electron. Prints a one-time login URL.
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./app');
const { createServer } = require('./http');
const { fileSecretBox } = require('../core/secret-box');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };

(async () => {
  const dataDir = arg('data', process.env.WHISPERBRAIN_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'whisperbrain'));
  const modelsDir = process.env.WB_MODELS_DIR;
  // No OS keystore here: secrets are sealed with a key file next to the data (readable only by this user). That keeps them
  // out of a copied database, nothing more, and it says so.
  const app = createApp({ dataDir, modelsDir, version: require('../../package.json').version, detect: true, secretBox: fileSecretBox(path.join(dataDir, 'secret.key')) });
  await app.ready;
  console.warn(`Note: API keys are sealed with ${path.join(dataDir, 'secret.key')}. Anyone who can read that file and the database can read them; keep both private.`);
  const srv = createServer(app, { uiDir: path.join(__dirname, '..', '..', 'ui') });
  const { port, token } = await srv.listen(Number(arg('port', 3787)));
  console.log(`WhisperBrain server on http://127.0.0.1:${port}`);
  console.log(`Open: http://127.0.0.1:${port}/?token=${token}`);
  const stop = async () => { await srv.close(); app.close(); await app.settled; process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
