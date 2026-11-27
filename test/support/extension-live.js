'use strict';
// Runs under Xvfb, started by test/meet-extension-live.test.js: a real browser with the real extension, a mock Meet page,
// the real intake server and hub. Prints one JSON line with what the hub heard.
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SignalHub } = require('../../src/meet/hub');
const { createIntake } = require('../../src/meet/intake');

const { WB_BROWSER, WB_ROOT, WB_RUN_MS = '7000' } = process.env;
const display = `:${200 + (process.pid % 90)}`;
const kids = [];
const run = (cmd, args) => { const c = cp.spawn(cmd, args, { stdio: 'ignore' }); kids.push(c); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ext-'));
  const hub = new SignalHub();
  const heard = { meeting: [], roster: [], speakers: [], captions: [], sources: [] };
  hub.on('signal', ({ msg, source, kind }) => {
    if (msg.type === 'meeting') heard.meeting.push([msg.inCall, msg.code]);
    if (msg.type === 'roster') heard.roster.push(msg.participants.map((p) => `${p.name}${p.self ? '*' : ''}`));
    if (msg.type === 'speaker' && msg.name && heard.speakers.at(-1) !== msg.name) heard.speakers.push(msg.name);
    if (msg.type === 'caption' && !heard.captions.some((c) => c.text === msg.text && c.name === msg.name)) heard.captions.push({ name: msg.name, text: msg.text });
    if (!heard.sources.includes(`${source}/${kind}`)) heard.sources.push(`${source}/${kind}`);
  });
  const intake = createIntake({ hub, getToken: () => 'test-token-0123456789abcdef', info: () => ({ recording: true }) });
  const port = await intake.listen(0);

  // the extension, copied: it must also run on the mock page, and it is paired by a fixed code instead of the options page
  const ext = path.join(tmp, 'ext');
  fs.cpSync(path.join(WB_ROOT, 'extension/meet'), ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
  const bg = fs.readFileSync(path.join(ext, 'background.js'), 'utf8');
  const patched = bg.replace(/async function pairing\(\) \{[\s\S]*?\n\}\n/, `async function pairing() { return { base: 'http://127.0.0.1:${port}', token: 'test-token-0123456789abcdef' }; }\n`);
  if (patched === bg) throw new Error('the pairing function was not found in background.js');
  fs.writeFileSync(path.join(ext, 'background.js'), patched);

  const page = fs.readFileSync(path.join(WB_ROOT, 'test/fixtures/a11y/mock-meet-dom.html'));
  const web = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  run('Xvfb', [display, '-screen', '0', '1280x800x24']);
  await sleep(1000);
  process.env.DISPLAY = display;
  run(WB_BROWSER, [`--user-data-dir=${path.join(tmp, 'profile')}`, `--load-extension=${ext}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--password-store=basic', ...(process.env.CI ? ['--no-sandbox'] : []), `http://127.0.0.1:${web.address().port}/abc-defg-hij`]);
  await sleep(Number(WB_RUN_MS));
  console.log(JSON.stringify({ ...heard, hub: hub.status().sources.map((s) => [s.id, s.kind, s.state]) }));
  await intake.close();
  web.close();
  for (const k of kids.reverse()) { try { k.kill('SIGTERM'); } catch { /* gone */ } }
  await sleep(500);
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
