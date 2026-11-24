#!/usr/bin/env node
'use strict';
// `npm start`: launches Electron from node_modules. On Linux the dev copy of Electron has no setuid sandbox helper,
// so --no-sandbox is passed (the app only ever loads its own local UI). Packaged builds are another matter: electron-builder.yml
// currently passes the flag to the .deb launcher too, see docs/packaging.md.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const args = [path.join(__dirname, '..'), ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...process.argv.slice(2)];
const child = spawn(electron, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
