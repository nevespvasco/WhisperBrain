// Passes what the Meet page shows to the WhisperBrain app, on this computer only (127.0.0.1). The pairing code from the
// app (wb1.<port>.<secret>) says where and with what secret; without it nothing is sent.
const MAX_AGE_MS = 15000;   // a highlight older than this is no use to anybody
let state = { connected: false, paired: false, detail: 'not set up', recording: false };
let queue = [];
let sending = false;

async function pairing() {
  const { pairing: code } = await chrome.storage.local.get('pairing');
  const m = /^wb1\.(\d{4,5})\.([\w-]{16,})$/.exec(String(code || '').trim());
  return m ? { base: 'http://127.0.0.1:' + m[1], token: m[2] } : null;
}

function show(next) {
  state = { ...state, ...next };
  chrome.action.setBadgeText({ text: state.connected ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
  chrome.action.setTitle({ title: 'WhisperBrain: ' + state.detail });
}

async function call(path, init) {
  init = init || {};
  const p = await pairing();
  if (!p) { show({ connected: false, paired: false, detail: 'paste the pairing code in the options' }); return null; }
  try {
    const headers = { 'x-wb-signal-token': p.token, 'x-wb-source': 'extension' };
    if (init.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(p.base + path, { ...init, headers });
    if (r.status === 401) { show({ connected: false, paired: false, detail: 'the pairing code is not valid any more' }); return null; }
    return r.ok ? await r.json() : null;
  } catch (e) {
    show({ connected: false, paired: true, detail: 'the WhisperBrain app is not running' });
    return null;
  }
}

async function flush() {
  if (sending) return;
  sending = true;
  try {
    while (queue.length) {
      const now = Date.now();
      const batch = queue.filter((q) => now - q.at <= MAX_AGE_MS).slice(0, 100).map((q) => q.msg);
      queue = [];
      if (!batch.length) break;
      const r = await call('/meet/signals', { method: 'POST', body: JSON.stringify({ messages: batch }) });
      if (r) show({ connected: true, paired: true, detail: r.recording ? 'connected, recording' : 'connected', recording: !!r.recording });
    }
  } finally { sending = false; }
}

async function hello() {
  const r = await call('/meet/hello');
  if (r && r.paired) show({ connected: true, paired: true, detail: r.recording ? 'connected, recording' : 'connected', recording: !!r.recording });
  else if (r) show({ connected: false, paired: false, detail: 'the pairing code is not valid any more' });
  return state;
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m && Array.isArray(m.signals)) {
    const at = Date.now();
    for (const msg of m.signals) queue.push({ at, msg });
    flush();
    return false;
  }
  if (m && (m.type === 'status' || m.type === 'paired')) { hello().then(() => reply(state)); return true; }
  return false;
});
chrome.alarms.create('hello', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'hello') hello(); });
chrome.runtime.onInstalled.addListener(() => { hello(); });
chrome.runtime.onStartup.addListener(() => { hello(); });
