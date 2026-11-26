'use strict';
// Google Calendar over OAuth 2.0 (installed-app loopback flow with PKCE). Read-only: lists calendars and events
// and maps them to the same shape ics.js `expand()` produces, so Calendar can merge both kinds of source.
const http = require('node:http');
const crypto = require('node:crypto');
const { meetingUrl } = require('./ics');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly openid email';
const SCOPE_GMAIL = `${SCOPE} https://www.googleapis.com/auth/gmail.readonly`;   // only when the person chose to connect mail too
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const INCREMENTAL_MAX_AGE_MS = 12 * 3600_000;
const STATUS = { accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE', needsAction: 'NEEDS-ACTION' };

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pkceChallenge = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

function authError(message) { const e = new Error(message); e.code = 'google-auth'; return e; }

// The id_token comes straight from the token endpoint over TLS, so its payload is trusted without a signature check.
function idTokenEmail(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || ''; } catch { return ''; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(title, text) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhisperBrain</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f5;color:#222}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.3rem}@media(prefers-color-scheme:dark){body{background:#1c1c1c;color:#eee}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

// Local midnight, like ics.js does for a non-recurring all-day DTSTART.
function dateMs(d) { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getTime(); }

// One Google event resource -> the expand() shape (plus calendarId/calendar/color), or null when it should be hidden.
function toEvent(it, cal = {}) {
  if (!it || it.status === 'cancelled' || !it.start) return null;
  if ((it.attendees || []).some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = !!it.start.date;
  const start = allDay ? dateMs(it.start.date) : Date.parse(it.start.dateTime);
  if (!Number.isFinite(start)) return null;
  let end = it.end ? (it.end.date ? dateMs(it.end.date) : Date.parse(it.end.dateTime)) : NaN;
  if (!Number.isFinite(end)) end = start + (allDay ? 86400000 : 0);
  const video = (it.conferenceData?.entryPoints || []).find((p) => p.entryPointType === 'video' && /^https:/i.test(p.uri || ''));
  const org = it.organizer;
  return {
    uid: it.iCalUID || it.id, start, end, allDay, summary: it.summary || '(no title)',
    location: it.location || '', description: it.description || '',
    attendees: (it.attendees || []).filter((a) => !a.resource).map((a) => ({ name: a.displayName || '', email: a.email || '', status: STATUS[a.responseStatus] || '' })),
    organizer: org ? { name: org.displayName || '', email: org.email || '' } : undefined,
    url: it.hangoutLink || video?.uri || meetingUrl(it.location, it.description),
    recurring: !!it.recurringEventId,
    calendarId: cal.id, calendar: cal.summary, color: cal.color,
  };
}

class GoogleCalendar {
  constructor({ getConfig, saveConfig, fetchImpl = globalThis.fetch, authBase = 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl = 'https://oauth2.googleapis.com/token', revokeUrl = 'https://oauth2.googleapis.com/revoke',
    apiBase = 'https://www.googleapis.com/calendar/v3', gmailBase = 'https://gmail.googleapis.com/gmail/v1', now = Date.now, authTimeoutMs = AUTH_TIMEOUT_MS }) {
    Object.assign(this, { getConfig, saveConfig, authBase, tokenUrl, revokeUrl, apiBase, gmailBase, now, authTimeoutMs });
    this.fetch = fetchImpl;
    this.refreshing = null;
    this.windows = new Map();   // calendar id -> what is known of its window (calendarItems)
  }

  config() { return { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, email: '', calendars: [], ...(this.getConfig() || {}) }; }

  connected() { return !!this.config().refreshToken; }

  async postForm(url, fields) {
    const body = new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''));
    const res = await this.fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  saveTokens(j) {
    const patch = { accessToken: j.access_token || '', expiresAt: this.now() + (Number(j.expires_in) || 3600) * 1000 };
    if (j.refresh_token) patch.refreshToken = j.refresh_token;
    this.saveConfig(patch);
    return patch;
  }

  // Starts the loopback listener and returns the consent URL. `done` settles once Google redirects back (or after 5 min).
  async beginAuth({ openExternal, gmail = false } = {}) {
    const { clientId, clientSecret } = this.config();
    if (!clientId) throw new Error('Set a Google OAuth client ID (a "Desktop app" client from Google Cloud Console) before connecting.');
    const verifier = b64url(crypto.randomBytes(48)); // 64 url-safe chars
    const state = b64url(crypto.randomBytes(24));
    let settle;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    done.catch(() => {}); // callers may only care about authUrl
    let finished = false;
    let busy = false; // one code exchange per flow
    const server = http.createServer();
    const close = () => { clearTimeout(timer); server.close(); }; // in-flight replies finish (Connection: close)
    const finish = (err, value) => { if (finished) return; finished = true; close(); err ? settle.reject(err) : settle.resolve(value); };
    const reply = (res, code, title, text) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' }).end(page(title, text));

    server.on('request', async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback' || finished || busy) return reply(res, 404, 'Not found', 'Nothing here.');
      if (u.searchParams.get('state') !== state) return reply(res, 400, 'Sign-in not recognised', 'This sign-in link does not match the one WhisperBrain started. Please try connecting again.');
      const error = u.searchParams.get('error');
      if (error) {
        reply(res, 400, 'Google Calendar not connected', error === 'access_denied' ? 'Access was declined. You can close this tab.' : `Google returned: ${error}`);
        return finish(authError(error === 'access_denied' ? 'Google sign-in was cancelled' : `Google sign-in failed: ${error}`));
      }
      busy = true;
      try {
        const r = await this.postForm(this.tokenUrl, { code: u.searchParams.get('code') || '', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
        if (!r.ok || !r.json.access_token) throw authError(`Google token exchange failed: ${r.json.error_description || r.json.error || `HTTP ${r.status}`}`);
        if (!r.json.refresh_token) throw authError('Google did not return a refresh token; remove WhisperBrain from your Google account permissions and try again.');
        this.saveTokens(r.json);
        const email = idTokenEmail(r.json.id_token);
        this.saveConfig({ email, gmail: !!gmail });
        const calendars = await this.listCalendars().catch(() => this.config().calendars); // connected even if listing hiccups
        reply(res, 200, 'Connected', 'Connected — you can close this tab and return to WhisperBrain.');
        finish(null, { email, calendars });
      } catch (e) {
        reply(res, 500, 'Google Calendar not connected', e.message);
        finish(e);
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const timer = setTimeout(() => finish(authError('Google sign-in timed out')), this.authTimeoutMs);
    timer.unref?.();
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: gmail ? SCOPE_GMAIL : SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' });
    const authUrl = `${this.authBase}?${q}`;
    if (openExternal) { try { await openExternal(authUrl); } catch (e) { finish(e); } }
    return { authUrl, redirectUri, done, cancel: () => finish(authError('Google sign-in was cancelled')) };
  }

  // A valid access token, refreshed when missing or expiring within 60 s.
  async accessToken({ force = false } = {}) {
    const c = this.config();
    if (!force && c.accessToken && c.expiresAt - this.now() > 60000) return c.accessToken;
    if (!c.refreshToken) throw authError('Google Calendar is not connected');
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const r = await this.postForm(this.tokenUrl, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' });
        if (!r.ok || !r.json.access_token) {
          if (r.json.error === 'invalid_grant') {
            this.saveConfig({ refreshToken: '', accessToken: '', expiresAt: 0 });
            throw authError('Google access expired or was revoked; reconnect Google Calendar');
          }
          throw new Error(`Google token refresh failed: ${r.json.error_description || r.json.error || `HTTP ${r.status}`}`);
        }
        return this.saveTokens(r.json).accessToken;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  // GET <apiBase><path>?params with one refresh-and-retry on 401.
  async api(path, params = {}, base = this.apiBase) {
    const url = `${base}${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken({ force: attempt > 0 });
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 401 && attempt === 0) continue;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(`Google Calendar: ${json.error?.message || `HTTP ${res.status}`}`);
        if (res.status === 401) e.code = 'google-auth';
        throw e;
      }
      return json;
    }
  }

  // Gmail (read-only), with the same token and the same refresh. Only after the person connected mail.
  gmail(path, params = {}) {
    if (!this.config().gmail) throw authError('Mail is not connected: connect Google again with mail switched on.');
    return this.api(path, params, this.gmailBase);
  }

  async paginate(path, params) {
    const items = [];
    let pageToken;
    for (let i = 0; i < 50; i++) {
      const j = await this.api(path, { ...params, pageToken });
      items.push(...(j.items || []));
      if (!(pageToken = j.nextPageToken)) break;
    }
    return items;
  }

  // Refreshes the calendar list, keeping the user's previous selection (primary is selected by default).
  async listCalendars() {
    const prev = new Map(this.config().calendars.map((c) => [c.id, c]));
    const items = await this.paginate('/users/me/calendarList', { maxResults: 250 });
    const calendars = items.filter((c) => !c.deleted).map((c) => ({
      id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: !!c.primary, color: c.backgroundColor || '',
      selected: prev.has(c.id) ? !!prev.get(c.id).selected : !!c.primary,
    }));
    this.saveConfig({ calendars });
    return calendars;
  }

  // The raw events of one calendar for a window. The first time (or for a wider window, or after twelve hours) the whole window is read; after
  // that only what changed since the last look is asked for (updatedMin, cancelled ones included) and applied to what is already known, so
  // a refresh of a busy calendar is a few events, not all of them. Any trouble with that falls back to reading the whole window again.
  async calendarItems(calId, from, to) {
    const path = `/calendars/${encodeURIComponent(calId)}/events`;
    const c = this.windows.get(calId);
    if (c && c.from <= from && c.to >= to && this.now() - c.fullAt < INCREMENTAL_MAX_AGE_MS) {
      try {
        const changed = await this.paginate(path, { singleEvents: 'true', timeMin: new Date(c.from).toISOString(), timeMax: new Date(c.to).toISOString(), updatedMin: new Date(c.syncedAt - 60_000).toISOString(), showDeleted: 'true', maxResults: 250 });
        for (const it of changed) { if (it.status === 'cancelled') c.items.delete(it.id); else c.items.set(it.id, it); }
        c.syncedAt = this.now();
        return [...c.items.values()];
      } catch (e) { if (e.code === 'google-auth') throw e; this.windows.delete(calId); }
    }
    const w = c ? { from: Math.min(c.from, from), to: Math.max(c.to, to) } : { from, to };
    const syncedAt = this.now();
    const items = await this.paginate(path, { singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(w.from).toISOString(), timeMax: new Date(w.to).toISOString(), maxResults: 250 });
    this.windows.set(calId, { ...w, items: new Map(items.map((it) => [it.id, it])), syncedAt, fullAt: syncedAt });
    return items;
  }

  // Events of the selected calendars overlapping [from, to), sorted like expand().
  async events({ from, to }) {
    let cals = this.config().calendars;
    if (!cals.length) cals = await this.listCalendars();
    const out = [];
    const seen = new Set();
    for (const cal of cals.filter((c) => c.selected)) {
      const items = await this.calendarItems(cal.id, from, to);
      for (const it of items) {
        const ev = toEvent(it, cal);
        if (!ev || ev.end <= from || ev.start >= to) continue;
        const key = `${ev.uid}|${ev.start}`; // the same meeting on two selected calendars shows once
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ev);
      }
    }
    return out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
  }

  async disconnect() {
    const c = this.config();
    const token = c.refreshToken || c.accessToken;
    if (token) await this.postForm(this.revokeUrl, { token }).catch(() => {});
    this.windows.clear();
    this.saveConfig({ refreshToken: '', accessToken: '', expiresAt: 0, email: '', calendars: [], gmail: false });
  }
}

module.exports = { GoogleCalendar, toEvent, idTokenEmail, pkceChallenge, SCOPE, SCOPE_GMAIL };
