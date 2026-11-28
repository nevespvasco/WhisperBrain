'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Models } = require('../src/asr/models');

const ROOT = path.join(__dirname, '..');

// Models used by the integration tests live in $WB_MODELS_DIR or ./.models (see scripts/fetch-models.js).
function testModels() {
  const dir = process.env.WB_MODELS_DIR || path.join(ROOT, '.models');
  if (!fs.existsSync(dir)) return null;
  const m = new Models(dir);
  if (!(m.resolve('auto') && m.vadInstalled())) return null;
  m.dir = dir;
  return m;
}

// A fresh folder under the system temp dir. It is removed when the test passed as `t` ends, and in any case when this test
// file's process exits (node --test runs each file in its own process), so test runs do not pile folders up in /tmp.
// WB_KEEP_TMP=1 keeps them, to look at after a failure.
const made = new Set();
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use on Windows: the OS cleans up */ } made.delete(d); };
process.on('exit', () => { if (process.env.WB_KEEP_TMP !== '1') for (const d of made) rm(d); });
function tmpDir(prefix = 'wb-', t = null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  if (t && process.env.WB_KEEP_TMP !== '1') t.after(() => rm(d));
  return d;
}

module.exports = { ROOT, testModels, tmpDir, fixture: (n) => path.join(__dirname, 'fixtures', n) };
