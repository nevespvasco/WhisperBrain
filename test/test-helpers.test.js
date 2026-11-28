'use strict';
// The test helpers themselves: temporary folders do not outlive the test file that made them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./helpers');

const child = (code, env = {}) => spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

test('tmpDir: the folders a test file made are removed when its process ends, files and all', () => {
  const r = child(`const { tmpDir } = require('./test/helpers'); const fs = require('node:fs');
    const a = tmpDir('wb-helper-'), b = tmpDir('wb-helper-');
    fs.mkdirSync(a + '/deep/er', { recursive: true }); fs.writeFileSync(a + '/deep/er/f.bin', 'x');
    console.log(JSON.stringify([a, b]));`, { WB_KEEP_TMP: '' });
  assert.equal(r.status, 0, r.stderr);
  const dirs = JSON.parse(r.stdout.trim());
  assert.equal(dirs.length, 2);
  for (const d of dirs) { assert.match(path.basename(d), /^wb-helper-/); assert.equal(fs.existsSync(d), false, `${d} left behind`); }
});

test('tmpDir: WB_KEEP_TMP=1 keeps them, to look at after a failure', () => {
  const r = child(`const { tmpDir } = require('./test/helpers'); console.log(tmpDir('wb-helper-keep-'));`, { WB_KEEP_TMP: '1' });
  assert.equal(r.status, 0, r.stderr);
  const d = r.stdout.trim();
  try { assert.equal(fs.existsSync(d), true); } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('tmpDir: with a test context the folder goes as soon as that test ends', async () => {
  const { tmpDir } = require('./helpers');
  let d;
  await test('inner', (t) => { d = tmpDir('wb-helper-t-', t); assert.equal(fs.existsSync(d), true); });
  assert.equal(fs.existsSync(d), false);
});
