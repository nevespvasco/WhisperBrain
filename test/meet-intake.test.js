'use strict';
// The door for the browser extension: it opens with its own secret, only to extensions, only for meeting signals.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Settings } = require('../src/core/settings');
const { SignalHub } = require('../src/meet/hub');
const { createIntake } = require('../src/meet/intake');
const { MeetService } = require('../src/meet/service');

function call(port, { method = 'GET', path = '/meet/hello', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(host ? { host } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, json: text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function rig() {
  const hub = new SignalHub();
  const seen = [];
  hub.on('signal', (s) => seen.push(s));
  let token = 'secret-token';
  const intake = createIntake({ hub, getToken: () => token, info: () => ({ version: '1', recording: true }) });
  const port = await intake.listen(0);
  return { hub, seen, intake, port, setToken: (t) => { token = t; }, close: () => intake.close() };
}
const EXT = 'chrome-extension://abcdefghijklmnop';
const auth = { 'x-wb-signal-token': 'secret-token', origin: EXT };

test('intake: hello says who is there, and only tells the details to a paired extension', async () => {
  const r = await rig();
  try {
    const open_ = await call(r.port);
    assert.equal(open_.json.app, 'whisperbrain');
    assert.equal(open_.json.paired, false);
    assert.equal(open_.json.recording, undefined, 'nothing about the app to the unpaired');
    const paired = await call(r.port, { headers: auth });
    assert.deepEqual([paired.json.paired, paired.json.recording], [true, true]);
    const wrong = await call(r.port, { headers: { 'x-wb-signal-token': 'nope' } });
    assert.equal(wrong.json.paired, false);
  } finally { await r.close(); }
});

test('intake: signals need the token; a paired extension gets them to the hub, cleaned', async () => {
  const r = await rig();
  try {
    assert.equal((await call(r.port, { method: 'POST', path: '/meet/signals', body: { type: 'speaker', name: 'Ana' } })).status, 401);
    assert.equal(r.seen.length, 0);
    const ok = await call(r.port, { method: 'POST', path: '/meet/signals', headers: auth, body: { messages: [{ type: 'speaker', name: ' Ana (You) ', self: false }, { type: 'roster', participants: ['Ana', 'Bruno'] }, { type: 'bogus' }] } });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.accepted, ok.json.rejected], [2, 1]);
    assert.deepEqual(r.seen.map((s) => [s.msg.type, s.source, s.kind]), [['speaker', 'extension', 'extension'], ['roster', 'extension', 'extension']]);
    assert.equal(r.seen[0].msg.self, true, 'the "(You)" mark is read, not shown');
    assert.equal(r.hub.status().sources[0].state, 'connected');
  } finally { await r.close(); }
});

test('intake: a web page cannot call it, even holding the token; other hosts are refused', async () => {
  const r = await rig();
  try {
    const page = await call(r.port, { method: 'POST', path: '/meet/signals', headers: { 'x-wb-signal-token': 'secret-token', origin: 'https://meet.google.com' }, body: { type: 'speaker', name: 'Ana' } });
    assert.equal(page.status, 403);
    const rebind = await call(r.port, { host: `evil.example:${r.port}`, headers: auth });
    assert.equal(rebind.status, 403);
    assert.equal(r.seen.length, 0);
  } finally { await r.close(); }
});

test('intake: the browser\'s preflight is answered for extensions only', async () => {
  const r = await rig();
  try {
    const ok = await call(r.port, { method: 'OPTIONS', path: '/meet/signals', headers: { origin: EXT, 'access-control-request-method': 'POST' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], EXT);
    assert.match(ok.headers['access-control-allow-headers'], /x-wb-signal-token/);
    const page = await call(r.port, { method: 'OPTIONS', path: '/meet/signals', headers: { origin: 'https://evil.example' } });
    assert.equal(page.status, 403);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
  } finally { await r.close(); }
});

test('intake: nonsense is refused with a plain error', async () => {
  const r = await rig();
  try {
    assert.equal((await call(r.port, { method: 'POST', path: '/meet/signals', headers: auth, body: '{not json' })).status, 400);
    assert.equal((await call(r.port, { method: 'POST', path: '/meet/signals', headers: auth, body: { messages: Array.from({ length: 201 }, () => ({ type: 'speaker', name: 'A' })) } })).status, 413);
    assert.equal((await call(r.port, { method: 'POST', path: '/meet/other', headers: auth, body: {} })).status, 404);
  } finally { await r.close(); }
});

test('intake: with no token set nothing is accepted; a new token cuts the old one off', async () => {
  const r = await rig();
  try {
    r.setToken('');
    assert.equal((await call(r.port, { headers: { 'x-wb-signal-token': '' } })).json.paired, false);
    r.setToken('fresh');
    assert.equal((await call(r.port, { method: 'POST', path: '/meet/signals', headers: auth, body: { type: 'speaker', name: 'A' } })).status, 401);
  } finally { await r.close(); }
});

test('intake: when the port is taken the next one is used', async () => {
  const a = await rig();
  const hub = new SignalHub();
  const b = createIntake({ hub, getToken: () => 'x' });
  try {
    const pb = await b.listen(a.port, 4);
    assert.equal(pb, a.port + 1);
  } finally { await b.close(); await a.close(); }
});

test('service: the door opens only while the extension is on, with a pairing code that works', async () => {
  const db = open(':memory:');
  const bus = new Bus();
  const settings = new Settings(db, bus);
  const base = 52000 + Math.floor(Math.random() * 3000);
  const svc = new MeetService({ settings, bus });
  try {
    await svc.sync();
    assert.equal(svc.listening, false);
    assert.equal(svc.pairing(), null);
    assert.ok(settings.get('meet').token.length >= 24, 'a token is made on first use');
    settings.update({ meet: { ...settings.get('meet'), extension: true, port: base } });
    await svc.sync();
    assert.equal(svc.listening, true);
    const p = svc.pairing();
    assert.match(p.code, /^wb1\.\d+\.[\w-]+$/);
    const [, port, token] = p.code.split('.');
    const hello = await call(Number(port), { headers: { 'x-wb-signal-token': token } });
    assert.equal(hello.json.paired, true);
    // a new token invalidates the old code
    const next = svc.resetToken();
    assert.notEqual(next.code, p.code);
    assert.equal((await call(Number(port), { headers: { 'x-wb-signal-token': token } })).json.paired, false);
    // switching it off closes the door
    settings.update({ meet: { ...settings.get('meet'), extension: false } });
    await svc.sync();
    assert.equal(svc.listening, false);
    await assert.rejects(call(Number(port)), /ECONNREFUSED/);
    assert.equal(svc.status().extension.on, false);
  } finally { await svc.close(); }
});

test('settings: the pairing secret is masked for the UI and the port is checked', () => {
  const settings = new Settings(open(':memory:'), new Bus());
  settings.update({ meet: { ...settings.get('meet'), token: 'abc' } });
  assert.equal(settings.publicView().meet.token, '********');
  assert.equal(settings.get('meet').token, 'abc');
  assert.throws(() => settings.update({ meet: { ...settings.get('meet'), port: 80 } }), /port/);
});
