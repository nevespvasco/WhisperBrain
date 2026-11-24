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

function tmpDir(prefix = 'wb-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

module.exports = { ROOT, testModels, tmpDir, fixture: (n) => path.join(__dirname, 'fixtures', n) };
