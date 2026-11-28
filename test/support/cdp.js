'use strict';
// A headless Chromium driven over the DevTools protocol, for UI tests that need real layout and real mouse hit-testing
// (a modal dialog makes the rest of the page inert: only a real click shows that). No dependencies: Node's own WebSocket.
// findBrowser() answers '' when there is none, and the test skips.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const which = (c) => { try { return cp.execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
function findBrowser() {
  if (process.env.WB_SKIP_BROWSER) return '';
  if (process.env.WB_HEADLESS_BIN) return process.env.WB_HEADLESS_BIN;
  // Playwright's headless shell (what CI and most dev boxes have), newest first
  const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(pw).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const f = path.join(pw, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(f)) return f;
    }
  } catch { /* none */ }
  // a snap browser cannot read a profile under /tmp
  return ['chromium', 'chromium-browser', 'google-chrome'].map(which).find((p) => p && !fs.realpathSync(p).startsWith('/snap/')) || '';
}
const browserMissing = () => (typeof WebSocket === 'undefined' ? 'no WebSocket in this Node' : findBrowser() ? '' : 'no headless Chromium (set WB_HEADLESS_BIN)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ bin = findBrowser(), width = 1280, height = 800 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cdp-'));
  const headless = /headless-shell/.test(bin) ? [] : ['--headless=new'];
  const ch = cp.spawn(bin, [...headless, '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(process.env.CI ? ['--no-sandbox'] : []), `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`the browser did not start: ${buf.slice(-400)}`)), 15000);
    ch.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\S+)/.exec(buf); if (m) { clearTimeout(t); resolve(m[1]); } });
    ch.on('exit', (code) => { clearTimeout(t); reject(new Error(`the browser exited (${code}): ${buf.slice(-400)}`)); });
  });
  const targets = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
  const ws = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  // a real click at a point: whatever is on top there gets it (or nothing, when the page under a modal is inert)
  const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
  const centre = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  const clickOn = async (sel) => { const p = await centre(sel); if (!p) throw new Error(`nothing matches ${sel}`); await click(p[0], p[1]); };
  const press = async (key, code = key, keyCode = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  const insertText = (text) => send('Input.insertText', { text });
  const goto = async (url) => { await send('Page.navigate', { url }); };
  const waitFor = async (expr, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await evaluate(expr).catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${expr}`); await sleep(50); }
  };
  const close = () => { try { ws.close(); } catch { /* gone */ } ch.kill('SIGKILL'); ch.once('exit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* left for the OS */ } }); };
  return { send, evaluate, click, clickOn, centre, press, insertText, goto, waitFor, close, errors };
}

module.exports = { findBrowser, browserMissing, launch, sleep };
