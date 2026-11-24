'use strict';
// Runs inside `dbus-run-session`, started by test/meet-a11y-live.test.js: a private display and accessibility bus, a real
// browser showing a mock Meet page, the real helper and the real source. Prints one JSON line with what the hub heard.
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SignalHub } = require('../../src/meet/hub');
const { A11ySource, helperSpec } = require('../../src/meet/a11y-source');

const { WB_BROWSER, WB_FLAG = '1', WB_RUN_MS = '7000', WB_ROOT } = process.env;
const display = `:${100 + (process.pid % 100)}`;
const kids = [];
const run = (cmd, args, opts = {}) => { const c = cp.spawn(cmd, args, { stdio: 'ignore', ...opts }); kids.push(c); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-live-'));
  const page = fs.readFileSync(path.join(WB_ROOT, 'test/fixtures/a11y/mock-meet.html'));
  const web = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${web.address().port}/`;
  run('Xvfb', [display, '-screen', '0', '1280x800x24']);
  await sleep(1000);
  process.env.DISPLAY = display;
  const launcher = ['/usr/libexec/at-spi-bus-launcher', '/usr/lib/at-spi2-core/at-spi-bus-launcher'].find((p) => fs.existsSync(p));
  run(launcher, ['--launch-immediately']);
  await sleep(1500);
  run(WB_BROWSER, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--password-store=basic', ...(WB_FLAG === '1' ? ['--force-renderer-accessibility'] : []), url]);
  await sleep(6000);

  const hub = new SignalHub();
  const heard = { speakers: [], roster: 0, code: '', rosterNames: [] };
  hub.on('signal', ({ msg }) => {
    if (msg.type === 'speaker' && msg.name && heard.speakers.at(-1) !== msg.name) heard.speakers.push(msg.name);
    if (msg.type === 'roster') { heard.roster = msg.participants.length; heard.rosterNames = msg.participants.map((p) => p.name); }
    if (msg.type === 'meeting' && msg.inCall) heard.code = msg.code;
  });
  const spec = helperSpec('linux', { roots: [path.join(WB_ROOT, 'build')] });
  const src = new A11ySource({ hub, spec, intervalMs: 300 });
  src.start();
  await sleep(Number(WB_RUN_MS));
  const state = hub.status().sources.find((s) => s.id === 'a11y');
  src.stop();
  console.log(JSON.stringify({ ...heard, state: state?.state, detail: state?.detail }));
  web.close();
  for (const k of kids.reverse()) { try { k.kill('SIGTERM'); } catch { /* gone */ } }
  await sleep(500);
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
