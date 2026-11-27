'use strict';
// The real thing on Linux: a browser showing a mock Meet page, the AT-SPI helper, the source, the hub. Skipped where the
// pieces are missing (no Xvfb, no D-Bus session tool, no Chromium-based browser that is not a snap, helper not built).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const which = (c) => { try { return cp.execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const BROWSERS = ['brave-browser', 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
const browser = BROWSERS.map(which).find((p) => p && !fs.realpathSync(p).startsWith('/snap/')) || '';
const helper = path.join(ROOT, 'build', 'atspi', 'whisperbrain-atspi');
const missing = process.platform !== 'linux' ? 'not Linux' : process.env.WB_SKIP_BROWSER ? 'WB_SKIP_BROWSER is set'
  : !which('Xvfb') ? 'no Xvfb' : !which('dbus-run-session') ? 'no dbus-run-session' : !browser ? 'no Chromium-based browser (a snap cannot be used)' : !fs.existsSync(helper) ? 'helper not built (npm run build:atspi)' : '';

function live(flag) {
  const out = cp.spawnSync('dbus-run-session', ['--', process.execPath, path.join(ROOT, 'test/support/a11y-live.js')], {
    env: { ...process.env, WB_BROWSER: browser, WB_FLAG: flag ? '1' : '0', WB_ROOT: ROOT, WB_RUN_MS: '6000' }, encoding: 'utf8', timeout: 60000,
  });
  const line = out.stdout.split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `the runner printed nothing: ${out.stderr.slice(-500)}`);
  const r = JSON.parse(line);
  if (process.env.CI) console.error('[live a11y diagnostics]', JSON.stringify({ flag, state: r.state, detail: r.detail, code: r.code, roster: r.roster, diag: r.diag }));
  return r;
}

test('live (Linux): with accessibility on, the helper reads the call and who speaks, and the hub hears it', { skip: missing || false, timeout: 90000 }, () => {
  const r = live(true);
  assert.equal(r.error, undefined);
  assert.equal(r.code, 'abc-defg-hij');
  assert.deepEqual(r.rosterNames.sort(), ['Ana Silva', 'Bruno Costa', 'Carla Dias']);
  assert.ok(r.speakers.length >= 3, `the highlight moved: ${r.speakers.join(' → ')}`);
  // the page moves the highlight Ana → Bruno → Carla → Ana…: the order is kept
  const order = r.speakers.map((n) => ['Ana Silva', 'Bruno Costa', 'Carla Dias'].indexOf(n));
  assert.ok(order.slice(1).every((n, i) => n === (order[i] + 1) % 3), `in order: ${r.speakers.join(' → ')}`);
  assert.equal(r.state, 'connected');
});

test('live (Linux): without accessibility on, the source says what to do instead of failing quietly', { skip: missing || false, timeout: 90000 }, () => {
  const r = live(false);
  assert.equal(r.error, undefined);
  assert.equal(r.roster, 0);
  assert.equal(r.speakers.length, 0);
  assert.equal(r.state, 'needs-setup');
  assert.match(r.detail, /accessibility/i);
});
