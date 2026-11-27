'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { GoogleCalendar, toEvent, idTokenEmail } = require('../src/meetings/google');
const { builtInClient } = require('../src/core/oauth-clients');
const { Calendar } = require('../src/meetings/calendar');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Settings } = require('../src/core/settings');

const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const T0 = Date.parse('2026-11-25T10:00:00Z');

// A fake Google: token endpoint, revoke endpoint and the two Calendar API calls we use, on 127.0.0.1:0.
async function fakeGoogle() {
  const g = { tokenReqs: [], apiReqs: [], revoked: [], fail401: 0, refreshError: null, calendars: null, events: {} };
  g.calendars = [
    [{ id: 'me@example.com', summary: 'me@example.com', primary: true, backgroundColor: '#123456' }, { id: 'team', summary: 'Team' }],
    [{ id: 'holidays', summary: 'Holidays', summaryOverride: 'Days off' }],
  ];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
      if (req.method === 'POST' && u.pathname === '/token') {
        const f = Object.fromEntries(new URLSearchParams(body));
        g.tokenReqs.push({ ...f, contentType: req.headers['content-type'] });
        if (f.grant_type === 'authorization_code') {
          if (f.code !== 'good-code') return json(400, { error: 'invalid_grant' });
          return json(200, { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1', id_token: jwt({ email: 'me@example.com', sub: '1' }) });
        }
        if (g.refreshError) return json(400, { error: g.refreshError });
        return json(200, { access_token: `at-r${g.tokenReqs.length}`, expires_in: 3600 });
      }
      if (req.method === 'POST' && u.pathname === '/revoke') { g.revoked.push(Object.fromEntries(new URLSearchParams(body)).token); return json(200, {}); }
      g.apiReqs.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
      if (g.fail401 > 0) { g.fail401--; return json(401, { error: { message: 'Invalid Credentials' } }); }
      if (u.pathname === '/cal/users/me/calendarList') {
        const i = u.searchParams.get('pageToken') === 'p2' ? 1 : 0;
        return json(200, { items: g.calendars[i], ...(i === 0 && { nextPageToken: 'p2' }) });
      }
      const m = /^\/cal\/calendars\/([^/]+)\/events$/.exec(u.pathname);
      if (m) {
        if (g.failIncremental && u.searchParams.get('updatedMin')) return json(400, { error: { message: 'bad updatedMin' } });
        let pages = g.events[decodeURIComponent(m[1])] || [[]];
        if (u.searchParams.get('updatedMin')) pages = [pages.flat().filter((e) => e.updated && e.updated >= u.searchParams.get('updatedMin'))];
        const i = Number(u.searchParams.get('pageToken') || 0);
        return json(200, { items: pages[i], ...(i + 1 < pages.length && { nextPageToken: String(i + 1) }) });
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  g.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  g.urls = { tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke`, apiBase: `${base}/cal`, authBase: `${base}/auth` };
  return g;
}

function rig(g, cfg0 = {}, opts = {}) {
  let cfg = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh', ...cfg0 };
  let clock = T0;
  const gc = new GoogleCalendar({ getConfig: () => cfg, saveConfig: (p) => { cfg = { ...cfg, ...p }; }, ...g.urls, now: () => clock, builtIn: { clientId: '', clientSecret: '' }, ...opts });
  return { gc, cfg: () => cfg, advance: (ms) => { clock += ms; } };
}

test('google: the page hears when the sign-in finishes (google.connected / google.error reach it, and every handled event is subscribed)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(path.join(__dirname, '..', 'ui/api.js'), 'utf8');
  for (const type of ['google.connected', 'google.error']) assert.ok(client.includes(`'${type}'`), `${type} is not in ui/api.js: the Integrations page would stay on "waiting" until you leave it`);
  assert.ok(client.includes('Object.keys(handlers)'), 'events() must also subscribe to every event the caller has a handler for');
});

test('oauth-clients: the client file can never be committed (it is git-ignored)', () => {
  const ignore = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('src/core/oauth-clients.local.json'));
});

test('oauth-clients: the shipped client comes from the git-ignored file, the environment wins, a missing or broken file means none', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-oauth-'));
  const file = path.join(dir, 'c.json');
  assert.deepEqual(builtInClient('google', { file, env: {} }), { clientId: '', clientSecret: '' }, 'no file');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(builtInClient('google', { file, env: {} }), { clientId: '', clientSecret: '' }, 'broken file');
  fs.writeFileSync(file, JSON.stringify({ google: { clientId: ' file.apps.googleusercontent.com ', clientSecret: 'fs' } }));
  assert.deepEqual(builtInClient('google', { file, env: {} }), { clientId: 'file.apps.googleusercontent.com', clientSecret: 'fs' });
  assert.deepEqual(builtInClient('google', { file, env: { WB_GOOGLE_CLIENT_ID: 'env-id', WB_GOOGLE_CLIENT_SECRET: 'env-s' } }), { clientId: 'env-id', clientSecret: 'env-s' });
  assert.deepEqual(builtInClient('zoom', { file, env: {} }), { clientId: '', clientSecret: '' }, 'other providers: none');
  fs.rmSync(dir, { recursive: true });
});

test('google: a client built into the app signs in with no keys from the person, and their own client still wins', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const builtIn = { clientId: 'builtin.apps.googleusercontent.com', clientSecret: 'public-ish' };
  const none = rig(g, { clientId: '', clientSecret: '' }, { builtIn });
  assert.equal(none.gc.hasBuiltInClient(), true);
  assert.equal(none.gc.config().clientId, builtIn.clientId);
  const flow = await none.gc.beginAuth({ gmail: true });
  const q = new URL(flow.authUrl).searchParams;
  assert.equal(q.get('client_id'), builtIn.clientId);
  assert.match(q.get('scope'), /gmail\.readonly/);
  await fetch(`${flow.redirectUri}?code=good-code&state=${encodeURIComponent(q.get('state'))}`);
  await flow.done;
  assert.equal(g.tokenReqs[0].client_id, builtIn.clientId);
  assert.equal(g.tokenReqs[0].client_secret, builtIn.clientSecret);
  assert.equal(none.cfg().clientId, '', 'the built-in id is not copied into the person\'s settings');
  assert.equal(await none.gc.accessToken({ force: true }), 'at-r2');
  assert.equal(g.tokenReqs[1].client_id, builtIn.clientId, 'refresh uses it too');

  const own = rig(g, {}, { builtIn });
  assert.equal(own.gc.config().clientId, 'cid.apps.googleusercontent.com', 'their own client wins');
  assert.equal(own.gc.config().clientSecret, 'shh');
  assert.equal(rig(g).gc.hasBuiltInClient(), false, 'no client built in: they must bring one');
});

test('google: loopback auth with PKCE, state check, token exchange, id_token email, calendars saved', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const { gc, cfg } = rig(g);
  assert.equal(gc.connected(), false);
  let opened = null;
  const flow = await gc.beginAuth({ openExternal: (u) => { opened = u; } });
  assert.equal(opened, flow.authUrl);
  const au = new URL(flow.authUrl);
  assert.equal(au.origin + au.pathname, g.urls.authBase);
  const q = au.searchParams;
  assert.match(flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(q.get('redirect_uri'), flow.redirectUri);
  assert.equal(q.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly openid email');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state').length >= 16);

  const bad = await fetch(`${flow.redirectUri}?code=good-code&state=forged`);
  assert.equal(bad.status, 400, 'state mismatch refused');
  assert.equal(g.tokenReqs.length, 0, 'no exchange for a forged state');

  const ok = await fetch(`${flow.redirectUri}?code=good-code&state=${encodeURIComponent(q.get('state'))}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Connected — you can close this tab and return to WhisperBrain/);
  const res = await flow.done;
  assert.equal(res.email, 'me@example.com');
  assert.deepEqual(res.calendars.map((c) => [c.id, c.selected]), [['me@example.com', true], ['team', false], ['holidays', false]]);
  assert.equal(res.calendars[2].summary, 'Days off');

  const [ex] = g.tokenReqs;
  assert.equal(ex.contentType, 'application/x-www-form-urlencoded');
  assert.deepEqual({ ...ex, code_verifier: undefined, contentType: undefined }, {
    code: 'good-code', client_id: 'cid.apps.googleusercontent.com', client_secret: 'shh', redirect_uri: flow.redirectUri,
    grant_type: 'authorization_code', code_verifier: undefined, contentType: undefined,
  });
  assert.match(ex.code_verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(crypto.createHash('sha256').update(ex.code_verifier).digest('base64url'), q.get('code_challenge'), 'PKCE S256 challenge');

  const c = cfg();
  assert.equal(c.refreshToken, 'rt-1');
  assert.equal(c.accessToken, 'at-1');
  assert.equal(c.expiresAt, T0 + 3600000);
  assert.equal(c.email, 'me@example.com');
  assert.equal(gc.connected(), true);
  assert.equal(g.apiReqs[0].auth, 'Bearer at-1');
  await assert.rejects(fetch(flow.redirectUri), 'listener closed after the callback');
});

test('google: auth needs a client id, reports ?error= and times out', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  await assert.rejects(rig(g, { clientId: '' }).gc.beginAuth(), /client ID/);
  const a = await rig(g).gc.beginAuth();
  const state = new URL(a.authUrl).searchParams.get('state');
  const r = await fetch(`${a.redirectUri}?error=access_denied&state=${state}`);
  assert.equal(r.status, 400);
  await assert.rejects(a.done, (e) => e.code === 'google-auth' && /cancelled/.test(e.message));
  const b = await rig(g, {}, { authTimeoutMs: 30 }).gc.beginAuth();
  await assert.rejects(b.done, /timed out/);
  await assert.rejects(fetch(b.redirectUri));
});

test('google: access token refresh on expiry, 401 retry, invalid_grant clears the refresh token', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const { gc, cfg, advance } = rig(g, { refreshToken: 'rt-1', accessToken: 'old', expiresAt: T0 + 30000 });
  assert.equal(await gc.accessToken(), 'at-r1', 'expiring within 60 s => refreshed');
  assert.deepEqual({ ...g.tokenReqs[0], contentType: undefined }, { client_id: 'cid.apps.googleusercontent.com', client_secret: 'shh', refresh_token: 'rt-1', grant_type: 'refresh_token', contentType: undefined });
  assert.equal(await gc.accessToken(), 'at-r1', 'cached while valid');
  assert.equal(g.tokenReqs.length, 1);
  advance(3600000);
  assert.equal(await gc.accessToken(), 'at-r2');
  assert.equal(cfg().refreshToken, 'rt-1', 'refresh token kept when Google does not rotate it');

  g.fail401 = 1;
  await gc.listCalendars();
  assert.equal(g.tokenReqs.length, 3, 'a 401 forces one refresh');
  assert.deepEqual(g.apiReqs.map((r) => r.auth), ['Bearer at-r2', 'Bearer at-r3', 'Bearer at-r3'], '401, retry, page 2');

  g.refreshError = 'invalid_grant';
  advance(4000000);
  await assert.rejects(gc.accessToken(), (e) => e.code === 'google-auth');
  assert.equal(cfg().refreshToken, '');
  assert.equal(gc.connected(), false);
});

test('google: calendarList pagination keeps the previous selection', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const { gc } = rig(g, { refreshToken: 'rt', accessToken: 'at', expiresAt: T0 + 3600000, calendars: [{ id: 'team', selected: true }, { id: 'me@example.com', selected: false }] });
  const cals = await gc.listCalendars();
  assert.equal(cals.length, 3);
  assert.deepEqual(cals.map((c) => c.selected), [false, true, false]);
  assert.deepEqual(cals[0], { id: 'me@example.com', summary: 'me@example.com', primary: true, color: '#123456', selected: false });
  assert.equal(g.apiReqs[1].q.pageToken, 'p2');
});

test('google: events across selected calendars, pagination, filtering, links, all-day', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const iso = (ms) => new Date(ms).toISOString();
  g.events['me@example.com'] = [[
    { id: 'a', iCalUID: 'a@google.com', summary: 'Standup', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + 900000) }, hangoutLink: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ email: 'me@example.com', self: true, responseStatus: 'accepted' }, { email: 'ana@example.com', displayName: 'Ana', responseStatus: 'tentative' }, { email: 'room@resource.calendar.google.com', resource: true }],
      organizer: { email: 'ana@example.com', displayName: 'Ana' }, recurringEventId: 'a' },
    { id: 'gone', status: 'cancelled', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + 1) } },
    { id: 'no', summary: 'Declined', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + 1) }, attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }] },
  ], [
    { id: 'z', summary: 'Customer', start: { dateTime: iso(T0 + 7200000) }, end: { dateTime: iso(T0 + 9000000) }, description: 'Join: <a href="https://acme.zoom.us/j/123456?pwd=x">here</a>' },
    { id: 't', summary: 'Vendor', start: { dateTime: iso(T0 + 3600000) }, end: { dateTime: iso(T0 + 5400000) },
      conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1' }, { entryPointType: 'video', uri: 'https://teams.microsoft.com/l/meetup-join/xyz' }] } },
    { id: 'day', summary: 'Offsite', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } },
  ]];
  g.events.team = [[{ id: 'a', iCalUID: 'a@google.com', summary: 'Standup', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + 900000) } },
    { id: 'w', summary: 'Retro', start: { dateTime: iso(T0 + 600000) }, end: { dateTime: iso(T0 + 1200000) }, location: 'https://whereby.com/retro-room' }]];
  g.events.holidays = [[{ id: 'h', summary: 'Should not appear', start: { date: '2026-11-25' }, end: { date: '2026-11-26' } }]];
  const { gc } = rig(g, { refreshToken: 'rt', accessToken: 'at', expiresAt: T0 + 3600000, calendars: [
    { id: 'me@example.com', summary: 'Me', selected: true, color: '#111' }, { id: 'team', summary: 'Team', selected: true }, { id: 'holidays', selected: false }] });
  const from = T0 - 3600000, to = T0 + 3 * 86400000;
  const evs = await gc.events({ from, to });
  assert.deepEqual(evs.map((e) => e.summary), ['Standup', 'Retro', 'Vendor', 'Customer', 'Offsite']);
  const evReqs = g.apiReqs.filter((r) => r.path.endsWith('/events'));
  assert.equal(evReqs.length, 3, 'two pages + one calendar; unselected skipped');
  assert.deepEqual({ ...evReqs[0].q }, { singleEvents: 'true', orderBy: 'startTime', timeMin: iso(from), timeMax: iso(to), maxResults: '250' });
  assert.equal(evReqs[1].q.pageToken, '1');
  assert.equal(evReqs[0].path, '/cal/calendars/me%40example.com/events');
  const [standup, retro, vendor, customer, offsite] = evs;
  assert.deepEqual(Object.keys(standup).sort(), ['allDay', 'attendees', 'calendar', 'calendarId', 'color', 'description', 'end', 'location', 'organizer', 'recurring', 'start', 'summary', 'uid', 'url'].sort());
  assert.equal(standup.uid, 'a@google.com');
  assert.equal(standup.start, T0);
  assert.equal(standup.end, T0 + 900000);
  assert.equal(standup.allDay, false);
  assert.equal(standup.recurring, true);
  assert.equal(standup.url, 'https://meet.google.com/abc-defg-hij');
  assert.deepEqual(standup.attendees, [{ name: '', email: 'me@example.com', status: 'ACCEPTED' }, { name: 'Ana', email: 'ana@example.com', status: 'TENTATIVE' }]);
  assert.deepEqual(standup.organizer, { name: 'Ana', email: 'ana@example.com' });
  assert.equal(standup.calendarId, 'me@example.com');
  assert.equal(vendor.url, 'https://teams.microsoft.com/l/meetup-join/xyz', 'conference video entry point');
  assert.equal(customer.url, 'https://acme.zoom.us/j/123456?pwd=x', 'link found in the description');
  assert.equal(retro.url, 'https://whereby.com/retro-room', 'link found in the location');
  assert.equal(offsite.allDay, true);
  assert.equal(offsite.start, new Date(2026, 10, 26).getTime());
  assert.equal(offsite.end, new Date(2026, 10, 27).getTime());
  assert.equal(offsite.url, null);
});

test('google: event mapping helpers', () => {
  assert.equal(idTokenEmail(jwt({ email: 'x@y.z' })), 'x@y.z');
  assert.equal(idTokenEmail('garbage'), '');
  assert.equal(toEvent({ status: 'cancelled', start: { date: '2026-01-01' } }), null);
  assert.equal(toEvent({ summary: 'x', start: { dateTime: '2026-01-01T10:00:00Z' } }).end, Date.parse('2026-01-01T10:00:00Z'));
  assert.equal(toEvent({ start: { dateTime: '2026-01-01T10:00:00Z' }, location: 'https://meet.jit.si/MyRoom' }).url, 'https://meet.jit.si/MyRoom');
  assert.equal(toEvent({ start: { dateTime: '2026-01-01T10:00:00Z' } }).summary, '(no title)');
});

test('google: disconnect revokes (best effort) and clears tokens but keeps the client id', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const { gc, cfg } = rig(g, { refreshToken: 'rt-9', accessToken: 'at', expiresAt: T0 + 1, email: 'me@example.com', calendars: [{ id: 'x' }] });
  await gc.disconnect();
  assert.deepEqual(g.revoked, ['rt-9']);
  assert.deepEqual({ ...cfg() }, { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh', refreshToken: '', accessToken: '', expiresAt: 0, email: '', calendars: [], gmail: false });   // and mail is no longer connected
  const offline = rig({ urls: { ...g.urls, revokeUrl: 'http://127.0.0.1:1/revoke' } }, { refreshToken: 'rt' });
  await offline.gc.disconnect();
  assert.equal(offline.cfg().refreshToken, '', 'a failed revoke still disconnects');
});

test('calendar: merges Google events with ICS, prefixed ids, provider/source, cache and error reporting', async () => {
  const db = open(':memory:');
  const bus = new Bus();
  const settings = new Settings(db, bus);
  let calls = 0, fail = false, connected = true;
  const google = {
    connected: () => connected,
    config: () => ({ calendars: [{ id: 'me', selected: true }] }),
    async events({ from, to }) {
      calls++;
      if (fail) { const e = new Error('Google access expired'); e.code = 'google-auth'; throw e; }
      assert.ok(from <= T0 - 3600000 && to >= T0 + 7 * 86400000, 'one wide fetch');
      return [{ uid: 'g1', start: T0 + 600000, end: T0 + 4200000, allDay: false, summary: 'Google sync', attendees: [], url: 'https://meet.google.com/abc-defg-hij', calendarId: 'me' }];
    },
  };
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:i1\r\nSUMMARY:Feed\r\nDTSTART:20261125T120000Z\r\nDURATION:PT1H\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  let clock = T0;
  const cal = new Calendar({ settings, bus, google, now: () => clock, fetchImpl: async () => ({ ok: true, text: async () => ics }) });
  cal.addSource({ kind: 'url', location: 'https://cal.example.com/a.ics', name: 'Work' });
  assert.equal(cal.hasSources(), true);
  const { events, errors } = await cal.events();
  assert.deepEqual(errors, []);
  assert.deepEqual(events.map((e) => [e.summary, e.provider, e.source]), [['Google sync', 'google', 'Google Calendar'], ['Feed', 'ics', 'Work']]);
  assert.equal(events[0].id, `google:me:g1:${T0 + 600000}`);
  await cal.events({ from: T0, to: T0 + 3600000 });
  assert.equal((await cal.current({ at: T0 + 600000 })).summary, 'Google sync');
  assert.equal(calls, 1, 'served from the TTL cache');
  clock += 6 * 60000;
  fail = true;
  const r = await cal.events();
  assert.equal(calls, 2);
  assert.deepEqual(r.errors, [{ source: 'Google Calendar', error: 'Google access expired', code: 'google-auth' }]);
  assert.equal(r.events.filter((e) => e.provider === 'google').length, 1, 'last good events kept on error');
  connected = false;
  assert.deepEqual((await cal.events({ force: true })).events.map((e) => e.provider), ['ics']);
  cal.removeSource(cal.sources()[0].id);
  assert.equal(cal.hasSources(), false);
});

test('google: a refresh reads only what changed since the last look, applies cancellations, and falls back to the whole window on trouble', async (t) => {
  const g = await fakeGoogle();
  t.after(g.close);
  const iso = (ms) => new Date(ms).toISOString();
  const ev = (id, summary, at, extra = {}) => ({ id, iCalUID: `${id}@g`, summary, start: { dateTime: iso(at) }, end: { dateTime: iso(at + 3600000) }, ...extra });
  g.events['me@example.com'] = [[ev('a', 'Standup', T0 + 3600000), ev('b', 'Review', T0 + 7200000)]];
  const { gc, advance } = rig(g, { refreshToken: 'rt', accessToken: 'at', expiresAt: T0 + 86400000, calendars: [{ id: 'me@example.com', selected: true }] });
  const window = { from: T0, to: T0 + 86400000 };
  const first = await gc.events(window);
  assert.deepEqual(first.map((e) => e.summary), ['Standup', 'Review']);
  const reqs = () => g.apiReqs.filter((r) => r.path.endsWith('/events'));
  assert.equal(reqs().length, 1);
  assert.equal(reqs()[0].q.updatedMin, undefined, 'the first read is the whole window');
  // a minute later: one event moved, one cancelled, one new
  advance(120000);
  const stamp = iso(T0 + 100000);
  g.events['me@example.com'] = [[ev('a', 'Standup (moved)', T0 + 5400000, { updated: stamp }), { id: 'b', status: 'cancelled', updated: stamp }, ev('c', 'New one', T0 + 9000000, { updated: stamp }), ev('d', 'Untouched, not asked for', T0 + 10000000)]];
  const second = await gc.events(window);
  assert.equal(reqs().length, 2);
  assert.ok(reqs()[1].q.updatedMin && reqs()[1].q.showDeleted === 'true', 'only what changed since the last look was asked for');
  assert.deepEqual(second.map((e) => e.summary).sort(), ['New one', 'Standup (moved)'], 'moved applied, cancelled removed, new added, the rest as it was');
  // a wider window needs the whole thing again
  g.events['me@example.com'] = [[ev('a', 'Standup (moved)', T0 + 5400000), ev('c', 'New one', T0 + 9000000), ev('z', 'Next week', T0 + 3 * 86400000)]];
  assert.equal((await gc.events({ from: T0, to: T0 + 5 * 86400000 })).length, 3);
  assert.equal(reqs().at(-1).q.updatedMin, undefined);
  // trouble with the incremental request: read the whole window again instead of failing
  g.failIncremental = true;
  advance(60000);
  assert.equal((await gc.events({ from: T0, to: T0 + 5 * 86400000 })).length, 3);
  // after twelve hours the whole window is read again
  g.failIncremental = false; advance(13 * 3600000);
  const before = reqs().length;
  await gc.events({ from: T0, to: T0 + 5 * 86400000 });
  assert.equal(reqs().at(-1).q.updatedMin, undefined);
  assert.equal(reqs().length, before + 1);
});
