'use strict';
// Reads simulated meeting pages with the extension's own reader and selectors, in a real browser (under Xvfb, as the live extension
// test does): a DOM engine is the only honest way to test CSS selectors. The page is served from a small local server and posts what
// it read back to it.
//   readPages([{ name, html, platform, url }]) -> Promise<{ name: { st, msgs } }>
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension', 'meet');
const which = (c) => { try { return cp.execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// a Chromium-based browser that honours --load-extension is not needed here; one that is not a snap (it cannot read /tmp) is
const browser = () => (process.platform !== 'linux' || process.env.WB_SKIP_BROWSER || !which('Xvfb') ? '' : ['brave-browser', 'chromium', 'chromium-browser', 'google-chrome'].map(which).find((p) => p && !fs.realpathSync(p).startsWith('/snap/')) || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPages(cases, { timeoutMs = 45000 } = {}) {
  const bin = browser();
  if (!bin) throw new Error('no browser');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pages-'));
  const kids = [];
  const run = (cmd, args) => { const c = cp.spawn(cmd, args, { stdio: 'ignore' }); kids.push(c); return c; };
  const tpl = cases.map((c, i) => `<template id="t${i}">${c.html}</template>`).join('\n');
  const meta = JSON.stringify(cases.map((c) => ({ name: c.name, platform: c.platform, url: c.url })));
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="stage"></div>${tpl}
<script src="/selectors.js"></script><script src="/reader.js"></script><script>
  const out = {};
  ${meta.replace(/^/, 'const cases = ')};
  cases.forEach((c, i) => {
    document.getElementById('stage').replaceChildren(document.getElementById('t' + i).content.cloneNode(true));
    const st = self.WbMeetReader.readPage(document, self.WB_PLATFORMS[c.platform].selectors, c.url);
    out[c.name] = { st, msgs: new self.WbMeetReader.Differ().diff(st) };
  });
  fetch('/result', { method: 'POST', body: JSON.stringify(out) });
</script></body></html>`;
  let done;
  const result = new Promise((resolve) => { done = resolve; });
  const web = http.createServer((q, r) => {
    if (q.method === 'POST' && q.url === '/result') { const b = []; q.on('data', (d) => b.push(d)); q.on('end', () => { r.end('ok'); done(JSON.parse(Buffer.concat(b).toString('utf8'))); }); return; }
    const file = { '/selectors.js': 'selectors.js', '/reader.js': 'reader.js' }[q.url];
    if (file) { r.writeHead(200, { 'Content-Type': 'text/javascript' }); return r.end(fs.readFileSync(path.join(EXT, file))); }
    r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const display = `:${300 + (process.pid % 90)}`;
  run('Xvfb', [display, '-screen', '0', '1280x800x24']);
  await sleep(800);
  const b = cp.spawn(bin, [`--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--password-store=basic', `http://127.0.0.1:${web.address().port}/`], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
  kids.push(b);
  try {
    return await Promise.race([result, sleep(timeoutMs).then(() => { throw new Error('the browser did not report in time'); })]);
  } finally {
    web.close();
    for (const k of kids.reverse()) { try { k.kill('SIGTERM'); } catch { /* gone */ } }
    await sleep(400);
    for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { readPages, browser };
