'use strict';
// Fetching a meeting's own transcript from Microsoft Graph (Teams), the Google Meet API and Zoom, to attach it (3.4).
// UNVERIFIED against the real services: the endpoints, scopes and response shapes below are the ones the code was written
// from (the vendors' documentation, from memory) and these tests use fake responses of that shape. Treat a first real call on
// each platform as the actual test.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const REAL_FETCH = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = REAL_FETCH; });   // the provider tests swap in a fake
const { PkceClient } = require('../src/transcripts/oauth');
const { graph, meet, zoom, meetingRef, TranscriptError } = require('../src/transcripts/providers');

// a fake `fetch`: routes[url-prefix] = (url, init) => { status?, json?, text? }; records what was asked
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => String(url).startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: { code: 'NotFound', message: `no route for ${url}` } }), { status: 404 });
    const r = await routes[key](String(url), init);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status || 200, headers: { 'Content-Type': r.text !== undefined ? 'text/vtt' : 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
const client = (token = 'tok') => ({ async request(url, init) { return globalThis.fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` } }); } });

test('meetingRef: the platform and the meeting from a join link', () => {
  assert.deepEqual(meetingRef('https://meet.google.com/abc-defg-hij?authuser=0'), { platform: 'meet', code: 'abc-defg-hij', url: 'https://meet.google.com/abc-defg-hij?authuser=0' });
  assert.deepEqual(meetingRef('https://acme.zoom.us/j/81234567890?pwd=xyz'), { platform: 'zoom', id: '81234567890', url: 'https://acme.zoom.us/j/81234567890?pwd=xyz' });
  assert.equal(meetingRef('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d').platform, 'teams');
  assert.equal(meetingRef('https://example.com/x'), null);
  assert.equal(meetingRef(''), null);
});

test('Teams (Graph): finds the meeting by its join link, takes the latest transcript, asks for VTT', async () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ana Silva>Good morning everyone</v>\n';
  const f = fakeFetch({
    'https://graph.microsoft.com/v1.0/me/onlineMeetings?': () => ({ json: { value: [{ id: 'MSo1', subject: 'Planning' }] } }),
    'https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo1/transcripts/T2/content': () => ({ text: vtt }),
    'https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo1/transcripts': () => ({ json: { value: [{ id: 'T1', createdDateTime: '2026-11-24T10:00:00Z' }, { id: 'T2', createdDateTime: '2026-11-24T11:00:00Z' }] } }),
  });
  globalThis.fetch = f;
  const r = await graph.fetchTranscript({ client: client(), ref: meetingRef('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0') });
  assert.equal(r.text, vtt);
  assert.equal(r.filename, 'teams-transcript.vtt');
  assert.match(decodeURIComponent(f.calls[0].url), /\$filter=JoinWebUrl eq 'https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  assert.match(f.calls.at(-1).url, /\/transcripts\/T2\/content\?\$format=text\/vtt$/);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('Teams (Graph): the errors an organisation\'s policy causes are explained, not shown raw', async () => {
  const run = (status, code) => { globalThis.fetch = fakeFetch({ 'https://graph.microsoft.com/': () => ({ status, json: { error: { code, message: 'x' } } }) }); return graph.fetchTranscript({ client: client(), ref: meetingRef('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0') }); };
  await assert.rejects(run(403, 'GraphAccessToTranscriptsDisabled'), (e) => e instanceof TranscriptError && /policy/i.test(e.message) && e.code === 'disabled');
  await assert.rejects(run(403, 'SpeakerAttributionNotAllowed'), (e) => /names/i.test(e.message) && e.code === 'no-names');
  await assert.rejects(run(404, 'NotFound'), (e) => e.code === 'not-found');
  await assert.rejects(run(401, 'InvalidAuthenticationToken'), (e) => e.code === 'auth');
});

test('Meet: conference record by meeting code, its transcript entries (paged), speakers by display name', async () => {
  const f = fakeFetch({
    'https://meet.googleapis.com/v2/conferenceRecords?': () => ({ json: { conferenceRecords: [{ name: 'conferenceRecords/c1', startTime: '2026-11-24T10:00:00Z' }] } }),
    'https://meet.googleapis.com/v2/conferenceRecords/c1/transcripts/t1/entries': (url) => (url.includes('pageToken=p2')
      ? { json: { transcriptEntries: [{ participant: 'conferenceRecords/c1/participants/u2', text: 'Happy to be here', startTime: '2026-11-24T10:00:08Z', endTime: '2026-11-24T10:00:11Z' }] } }
      : { json: { transcriptEntries: [{ participant: 'conferenceRecords/c1/participants/u1', text: 'Good morning everyone', startTime: '2026-11-24T10:00:02Z', endTime: '2026-11-24T10:00:05Z' }], nextPageToken: 'p2' } }),
    'https://meet.googleapis.com/v2/conferenceRecords/c1/transcripts': () => ({ json: { transcripts: [{ name: 'conferenceRecords/c1/transcripts/t1', state: 'ENDED' }] } }),
    'https://meet.googleapis.com/v2/conferenceRecords/c1/participants/u1': () => ({ json: { signedinUser: { user: 'users/1', displayName: 'Ana Silva' } } }),
    'https://meet.googleapis.com/v2/conferenceRecords/c1/participants/u2': () => ({ json: { anonymousUser: { displayName: 'Bruno (guest)' } } }),
  });
  globalThis.fetch = f;
  const r = await meet.fetchTranscript({ client: client(), ref: meetingRef('https://meet.google.com/abc-defg-hij') });
  assert.equal(r.filename, 'meet-transcript.vtt');
  assert.match(r.text, /^WEBVTT\n/);
  assert.match(r.text, /00:00:02\.000 --> 00:00:05\.000\n<v Ana Silva>Good morning everyone<\/v>/);
  assert.match(r.text, /00:00:08\.000 --> 00:00:11\.000\n<v Bruno \(guest\)>Happy to be here<\/v>/);
  assert.match(decodeURIComponent(f.calls[0].url), /filter=space\.meeting_code="abc-defg-hij"/);
});

test('Zoom: the cloud recording\'s transcript file, downloaded with the token', async () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nAna Silva: Good morning everyone\n';
  const f = fakeFetch({
    'https://api.zoom.us/v2/meetings/81234567890/recordings': () => ({ json: { recording_files: [{ file_type: 'MP4', download_url: 'https://zoom.us/rec/a.mp4' }, { file_type: 'TRANSCRIPT', file_extension: 'VTT', download_url: 'https://zoom.us/rec/download/t.vtt' }] } }),
    'https://zoom.us/rec/download/t.vtt': () => ({ text: vtt }),
  });
  globalThis.fetch = f;
  const r = await zoom.fetchTranscript({ client: client(), ref: meetingRef('https://acme.zoom.us/j/81234567890') });
  assert.deepEqual([r.text, r.filename], [vtt, 'zoom-transcript.vtt']);
  assert.ok(!f.calls.some((c) => c.url.includes('a.mp4')), 'only the transcript is downloaded');
  globalThis.fetch = fakeFetch({ 'https://api.zoom.us/': () => ({ json: { recording_files: [{ file_type: 'MP4', download_url: 'x' }] } }) });
  await assert.rejects(zoom.fetchTranscript({ client: client(), ref: meetingRef('https://acme.zoom.us/j/81234567890') }), (e) => e.code === 'not-found');
});

// ---- signing in: authorization code with PKCE on a loopback address ----
test('PkceClient: the sign-in URL carries a PKCE challenge and the loopback redirect; the code is exchanged; tokens are kept; refresh works', async () => {
  let saved = {};
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push({ url: String(url), body: new URLSearchParams(init.body) }); return new Response(JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 }), { status: 200 }); };
  const c = new PkceClient({ name: 'Microsoft', authUrl: 'https://login.example/authorize', tokenUrl: 'https://login.example/token', scope: 'a b', getConfig: () => ({ clientId: 'cid', ...saved }), saveConfig: (p) => { saved = { ...saved, ...p }; }, fetchImpl, now: () => 1000 });
  const { authUrl, redirectUri, done } = await c.beginAuth();
  const u = new URL(authUrl);
  assert.deepEqual([u.origin + u.pathname, u.searchParams.get('client_id'), u.searchParams.get('response_type'), u.searchParams.get('scope'), u.searchParams.get('code_challenge_method'), u.searchParams.get('redirect_uri')], ['https://login.example/authorize', 'cid', 'code', 'a b', 'S256', redirectUri]);
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  await new Promise((resolve, reject) => http.get(`${redirectUri}?code=CODE1&state=${u.searchParams.get('state')}`, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
  await done;
  assert.deepEqual([posts[0].body.get('code'), posts[0].body.get('grant_type'), posts[0].body.get('redirect_uri')], ['CODE1', 'authorization_code', redirectUri]);
  assert.ok(posts[0].body.get('code_verifier').length >= 43, 'the verifier that matches the challenge');
  assert.deepEqual([saved.refreshToken, saved.accessToken], ['R1', 'A1']);
  const before = posts.length;
  assert.equal(await c.accessToken(), 'A1', 'still valid: no request');
  c.now = () => 1000 + 3600 * 1000;
  assert.equal(await c.accessToken(), 'A1');
  assert.equal(posts.length, before + 1);
  assert.equal(posts.at(-1).body.get('grant_type'), 'refresh_token');
});

test('PkceClient: a wrong state is refused, and no client id says what to do', async () => {
  const c = new PkceClient({ name: 'Zoom', authUrl: 'https://z/authorize', tokenUrl: 'https://z/token', scope: 's', getConfig: () => ({ clientId: 'cid' }), saveConfig() {}, fetchImpl: async () => new Response('{}') });
  const { redirectUri, cancel } = await c.beginAuth();
  const status = await new Promise((resolve) => http.get(`${redirectUri}?code=x&state=wrong`, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(status, 400);
  cancel();
  await assert.rejects(new PkceClient({ name: 'Zoom', authUrl: 'a', tokenUrl: 't', scope: 's', getConfig: () => ({}), saveConfig() {} }).beginAuth(), /client ID/i);
});

// ---- the service: a note's join link -> the platform's transcript -> attached ----
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

const SAID = [
  ['s1', 2000, 7000, 'Good morning everyone thanks for joining the planning call today'],
  ['s2', 8000, 13000, 'Happy to be here I wanted to start with the budget for the second quarter'],
  ['s3', 14000, 20000, 'Before the budget we should settle the hiring plan for the platform team'],
];
const NAMES = { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' };
const cue = (ms) => { const t = ms; return `00:${String(Math.floor(t / 60000) % 60).padStart(2, '0')}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}.000`; };
const TEAMS_VTT = `WEBVTT\n\n${SAID.map(([id, a, b, text], i) => `${i + 1}\n${cue(a + 30000)} --> ${cue(b + 30000)}\n<v ${NAMES[id]}>${text}</v>`).join('\n\n')}\n`;
const quiet = { id: 'fake', session: 't', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null };

async function rig(t) {
  const dataDir = tmpDir('wb-tr-');
  const app = createApp({ dataDir, platform: quiet });
  await app.ready;
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); await app.settled; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const n = app.notes.create({ title: 'Planning' });
  app.notes.addSegments(n.id, SAID.map(([speakerId, startMs, endMs, text]) => ({ speaker: 'them', speakerId, startMs, endMs, text })));
  for (const id of ['s1', 's2', 's3']) app.speakers.save(n.id, { speakerId: id, channel: 'system', centroid: new Float32Array(4).fill(id === 's1' ? 1 : id === 's2' ? -1 : 0.5), count: 3 });
  return { app, call, n };
}

test('fetch-transcript: the meeting link on the note picks the platform; the transcript is attached and names the voices', async (t) => {
  const r = await rig(t);
  r.app.knowledge.addLink(r.n.id, { kind: 'calendar', url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0', title: 'Meeting link' });
  r.app.transcripts.providers = { teams: { id: 'teams', label: 'Teams', platform: 'teams', fetchTranscript: async ({ ref }) => { assert.equal(ref.platform, 'teams'); return { text: TEAMS_VTT, filename: 'teams-transcript.vtt' }; } } };
  { const first = await r.call('POST', `/api/notes/${r.n.id}/fetch-transcript`, { provider: 'teams' }); assert.equal(first.status, 409, JSON.stringify(first.json)); }
  r.app.settings.update({ microsoft: { clientId: 'cid', refreshToken: 'rt' } });
  const ok = await r.call('POST', `/api/notes/${r.n.id}/fetch-transcript`, { provider: 'teams' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.named.map((x) => x.name).sort(), ['Ana Silva', 'Bruno Costa', 'Carla Dias']);
  assert.ok(Math.abs(ok.json.offsetMs - -30000) <= 1000);
});

test('fetch-transcript: no link for that platform, an unknown provider, and a platform error are each said plainly', async (t) => {
  const r = await rig(t);
  r.app.settings.update({ zoom: { clientId: 'c', refreshToken: 'rt' } });
  const { TranscriptError } = require('../src/transcripts/providers');
  r.app.transcripts.providers = { zoom: { id: 'zoom', label: 'Zoom', platform: 'zoom', fetchTranscript: async () => { throw new TranscriptError('no cloud transcript', 'not-found'); } } };
  const noLink = await r.call('POST', `/api/notes/${r.n.id}/fetch-transcript`, { provider: 'zoom' });
  assert.equal(noLink.status, 422); assert.match(noLink.json.error, /no Zoom meeting link/i);
  r.app.knowledge.addLink(r.n.id, { kind: 'calendar', url: 'https://acme.zoom.us/j/81234567890', title: 'x' });
  const failed = await r.call('POST', `/api/notes/${r.n.id}/fetch-transcript`, { provider: 'zoom' });
  assert.equal(failed.status, 422); assert.match(failed.json.error, /no cloud transcript/);
  assert.equal((await r.call('POST', `/api/notes/${r.n.id}/fetch-transcript`, { provider: 'webex' })).status, 400);
});

test('transcript sources: what is configured and connected is listed, secrets never; sign-in starts from the app', async (t) => {
  const r = await rig(t);
  r.app.settings.update({ microsoft: { clientId: 'cid', refreshToken: 'secret-rt' } });
  const list = await r.call('GET', '/api/transcript-sources');
  assert.deepEqual(list.json.map((s) => [s.id, s.configured, s.connected]), [['teams', true, true], ['meet', false, false], ['zoom', false, false]]);
  assert.ok(!JSON.stringify(list.json).includes('secret-rt'));
  assert.equal((await r.call('POST', '/api/transcript-sources/meet/connect')).status, 400, 'no client ID: told what to set');
  assert.equal((await r.call('DELETE', '/api/transcript-sources/teams')).status, 200);
  assert.equal(r.app.settings.get('microsoft').refreshToken, '');
  assert.ok(!JSON.stringify(r.app.account.exportJson().settings).includes('cid'), 'the export carries no provider settings');
});


test('PkceClient: Zoom-style clients send their credentials as HTTP Basic, not in the body', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ headers: init.headers, body: new URLSearchParams(init.body) }); return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 })); };
  let cfg = { clientId: 'cid', clientSecret: 'sec' };
  const c = new PkceClient({ name: 'Zoom', authUrl: 'https://z/authorize', tokenUrl: 'https://z/token', scope: '', basicAuth: true, getConfig: () => cfg, saveConfig: (p) => { cfg = { ...cfg, ...p }; }, fetchImpl });
  const { authUrl, redirectUri, done } = await c.beginAuth();
  await new Promise((resolve) => http.get(`${redirectUri}?code=C&state=${new URL(authUrl).searchParams.get('state')}`, (res) => { res.resume(); res.on('end', resolve); }));
  await done;
  assert.equal(seen[0].headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(seen[0].body.get('client_secret'), null);
  assert.equal(seen[0].body.get('client_id'), null, 'the id travels in the header');
});

test('PkceClient: starting a second sign-in closes the first one\'s listener', async () => {
  const c = new PkceClient({ name: 'Zoom', authUrl: 'https://z/authorize', tokenUrl: 'https://z/token', scope: '', getConfig: () => ({ clientId: 'cid' }), saveConfig() {}, fetchImpl: async () => new Response('{}') });
  const first = await c.beginAuth();
  const second = await c.beginAuth();
  await assert.rejects(first.done, /cancelled/);
  const status = await new Promise((resolve) => { http.get(`${first.redirectUri}?code=x&state=y`, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve('closed')); });
  assert.equal(status, 'closed');
  second.cancel();
});

test('Teams: the policy errors are recognised wherever Graph puts the code (error.code or error.innerError.code)', async () => {
  globalThis.fetch = fakeFetch({ 'https://graph.microsoft.com/': () => ({ status: 403, json: { error: { code: 'Forbidden', innerError: { code: 'GraphAccessToTranscriptsDisabled' } } } }) });
  await assert.rejects(graph.fetchTranscript({ client: client(), ref: meetingRef('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0') }), (e) => e.code === 'disabled');
});

test('Zoom: the download link from the answer must be on zoom.us over https, or the token is not sent anywhere', async () => {
  for (const url of ['https://evil.example/t.vtt', 'http://zoom.us/rec/t.vtt', 'https://zoom.us.evil.example/t.vtt', 'not a url']) {
    const f = fakeFetch({ 'https://api.zoom.us/v2/meetings/81234567890/recordings': () => ({ json: { recording_files: [{ file_type: 'TRANSCRIPT', download_url: url }] } }) });
    globalThis.fetch = f;
    await assert.rejects(zoom.fetchTranscript({ client: client(), ref: meetingRef('https://acme.zoom.us/j/81234567890') }), /not on zoom\.us/, url);
    assert.equal(f.calls.length, 1, `nothing was requested from ${url}`);
  }
});

test('Meet: a service that keeps returning the same page token does not loop for ever; broken times and names with line breaks cannot break a cue', async () => {
  let pages = 0;
  globalThis.fetch = fakeFetch({
    'https://meet.googleapis.com/v2/conferenceRecords?': () => ({ json: { conferenceRecords: [{ name: 'conferenceRecords/c1' }] } }),
    'https://meet.googleapis.com/v2/conferenceRecords/c1/transcripts/t1/entries': () => { pages++; return { json: { transcriptEntries: [{ participant: 'conferenceRecords/c1/participants/u1', text: 'hello\n\n99:00:00.000 --> 99:00:01.000\nforged', startTime: 'nonsense', endTime: 'nonsense' }], nextPageToken: 'same' } }; },
    'https://meet.googleapis.com/v2/conferenceRecords/c1/transcripts': () => ({ json: { transcripts: [{ name: 'conferenceRecords/c1/transcripts/t1', state: 'ENDED' }] } }),
    'https://meet.googleapis.com/v2/conferenceRecords/c1/participants/u1': () => ({ json: { signedinUser: { displayName: 'Ana\n\nSilva' } } }),
  });
  const r = await meet.fetchTranscript({ client: client(), ref: meetingRef('https://meet.google.com/abc-defg-hij') });
  assert.ok(pages <= 3, `${pages} pages`);
  assert.ok(!/NaN/.test(r.text));
  assert.equal(r.text.split('\n\n').length, pages + 1, 'one block per entry: nothing was split or forged');
  assert.ok(!/\n99:00:00/.test(r.text));
});
