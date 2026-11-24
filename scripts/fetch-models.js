#!/usr/bin/env node
'use strict';
// Download speech models without the app:  node scripts/fetch-models.js [model-id ...] [--dir DIR] [--list]
// Default target is ./.models (what the integration tests use). The app itself downloads into its data dir.
const path = require('node:path');
const { Models, CATALOG } = require('../src/asr/models');

const args = process.argv.slice(2);
const di = args.indexOf('--dir');
const dir = di >= 0 ? args.splice(di, 2)[1] : path.join(__dirname, '..', '.models');
if (args.includes('--list')) {
  for (const m of CATALOG) console.log(`${m.id.padEnd(24)} ${String(m.sizeMB).padStart(4)} MB  ${m.name} — ${m.note}`);
  process.exit(0);
}
const ids = args.length ? args : ['parakeet-tdt-110m-en'];
const models = new Models(dir);
(async () => {
  for (const id of ids) {
    if (models.isInstalled(id)) { console.log(`${id}: already installed`); continue; }
    let last = -1;
    process.stdout.write(`${id}: downloading `);
    await models.install(id, { onProgress: (p) => { const pct = Math.floor(p * 10); if (pct !== last) { last = pct; process.stdout.write('.'); } } });
    const sha = require('node:fs').readFileSync(path.join(models.modelDir(id), '.sha256'), 'utf8').trim();
    console.log(` done\n  archive sha256: ${sha}`);
  }
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
