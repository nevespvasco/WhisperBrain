#!/usr/bin/env node
'use strict';
// `npm start`: launches Electron from node_modules. On Linux the dev copy of Electron has no setuid sandbox helper (and Ubuntu
// 24.04 restricts user namespaces), so --no-sandbox is passed for development runs only. Packaged builds keep the sandbox: the .deb
// always, the AppImage wherever user namespaces work (docs/packaging.md §3).
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const args = [path.join(__dirname, '..'), ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...process.argv.slice(2)];
const child = spawn(electron, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
