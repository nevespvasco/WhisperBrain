'use strict';
// Boots the real Electron app (headless under xvfb if there is no display) with throwaway data and checks the UI renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tmpDir, ROOT, testModels } = require('./helpers');

let electronPath = null;
try { electronPath = require('electron'); } catch { /* not installed */ }
const haveBinary = electronPath && fs.existsSync(electronPath);
const display = process.platform !== 'linux' || process.env.DISPLAY || spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
const skip = !haveBinary ? 'electron is not installed' : !display ? 'no display and no xvfb' : false;

test('electron app starts, serves its UI and the renderer boots', { skip, timeout: 90000 }, async () => {
  const userData = tmpDir('wb-electron-');
  const args = ['--no-sandbox', '--disable-gpu', ROOT];
  const cmd = process.platform === 'linux' && !process.env.WB_USE_DISPLAY ? 'xvfb-run' : electronPath;
  const full = cmd === 'xvfb-run' ? ['-a', electronPath, ...args] : args;
  const out = await new Promise((resolve) => {
    const p = spawn(cmd, full, { env: { ...process.env, ...(testModels() ? { WB_SMOKE_MODELS: testModels().dir } : {}), WB_SMOKE: '1', WB_USER_DATA: userData, WB_STATE_FILE: path.join(userData, 'state.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(buf + '\nTIMEOUT'); }, 80000);
    p.on('exit', () => { clearTimeout(timer); resolve(buf); });
  });
  fs.rmSync(userData, { recursive: true, force: true });
  assert.match(out, /SMOKE_OK/, out.slice(-2000));
  const r = JSON.parse(/SMOKE_RESULT (.*)/.exec(out)[1]);
  assert.equal(r.title, 'WhisperBrain');
  assert.equal(r.secure, true, 'localhost is a secure context, so getUserMedia works');
  assert.equal(r.gum, 'function');
  if (testModels()) assert.match(out, /SMOKE_ASR .*love/i, 'speech recognition works inside Electron');
  if (testModels()?.speakerInstalled()) assert.match(out, /SMOKE_SPEAKER \{"segments":[1-9]\d*,"dims":\[[1-9]/, 'voice embeddings work inside Electron (no external buffers)');
});
