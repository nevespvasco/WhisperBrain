'use strict';
// Sign in to a meeting platform for the transcripts of one's own meetings: OAuth 2.0 authorization code with PKCE on a loopback
// address, as the Google Calendar connection does (src/meetings/google.js), for any provider that says where to send the person
// and where to exchange the code. Tokens are kept through saveConfig({ accessToken, refreshToken, expiresAt }) (settings, sealed
// like other secrets). UNVERIFIED against the real providers: written from their documentation; try each one for real.
const http = require('node:http');
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><title>WhisperBrain</title></head><body style="font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:28rem;text-align:center"><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
const authError = (m) => Object.assign(new Error(m), { code: 'auth' });

class PkceClient {
  // name: for messages. authUrl/tokenUrl: the provider's endpoints. scope: space separated. extraAuthParams: e.g. { prompt: 'consent' }
  // basicAuth: the client id and secret go in an HTTP Basic header, not in the body (Zoom asks for this)
  constructor({ name, authUrl, tokenUrl, scope, extraAuthParams = {}, basicAuth = false, getConfig, saveConfig, fetchImpl = globalThis.fetch, now = Date.now, authTimeoutMs = AUTH_TIMEOUT_MS }) {
    Object.assign(this, { name, authUrl, tokenUrl, scope, extraAuthParams, basicAuth, getConfig, saveConfig, now, authTimeoutMs });
    this.pending = null;            // the sign-in in progress: a second one cancels it, so no listener is left open
    this.fetch = fetchImpl;
    this.refreshing = null;
  }

  config() { return { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, ...(this.getConfig() || {}) }; }
  connected() { return !!this.config().refreshToken; }

  async postForm(fields) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.basicAuth) { headers.Authorization = `Basic ${Buffer.from(`${fields.client_id}:${fields.client_secret || ''}`).toString('base64')}`; fields = { ...fields, client_id: undefined, client_secret: undefined }; }
    const body = new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''));
    const res = await this.fetch(this.tokenUrl, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
  }

  saveTokens(j) {
    const patch = { accessToken: j.access_token || '', expiresAt: this.now() + (Number(j.expires_in) || 3600) * 1000 };
    if (j.refresh_token) patch.refreshToken = j.refresh_token;
    this.saveConfig(patch);
    return patch;
  }

  // Starts the loopback listener and returns the sign-in URL; `done` settles when the provider redirects back (or after 5 minutes).
  async beginAuth({ openExternal } = {}) {
    const { clientId, clientSecret } = this.config();
    if (!clientId) throw new Error(`Set a ${this.name} client ID (an app registered with ${this.name}) before connecting.`);
    this.pending?.();
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    let settle, finished = false, busy = false;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    done.catch(() => {});
    const server = http.createServer();
    let timer;
    const finish = (err, value) => { if (finished) return; finished = true; clearTimeout(timer); server.close(); err ? settle.reject(err) : settle.resolve(value); };
    const reply = (res, code, title, text) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' }).end(page(title, text));
    let redirectUri;

    server.on('request', async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback' || finished || busy) return reply(res, 404, 'Not found', 'Nothing here.');
      if (u.searchParams.get('state') !== state) return reply(res, 400, 'Sign-in not recognised', 'This sign-in does not match the one WhisperBrain started. Please try connecting again.');
      const error = u.searchParams.get('error');
      if (error) { reply(res, 400, `${this.name} not connected`, error === 'access_denied' ? 'Access was declined. You can close this tab.' : `${this.name} returned: ${error}`); return finish(authError(`${this.name} sign-in ${error === 'access_denied' ? 'was cancelled' : `failed: ${error}`}`)); }
      busy = true;
      try {
        const r = await this.postForm({ code: u.searchParams.get('code') || '', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
        if (!r.ok || !r.json.access_token) throw authError(`${this.name} token exchange failed: ${r.json.error_description || r.json.error || `HTTP ${r.status}`}`);
        if (!r.json.refresh_token) throw authError(`${this.name} did not return a refresh token, so WhisperBrain could not stay connected.`);
        this.saveTokens(r.json);
        reply(res, 200, 'Connected', 'Connected: you can close this tab and return to WhisperBrain.');
        finish(null, { connected: true });
      } catch (e) { reply(res, 500, `${this.name} not connected`, e.message); finish(e); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    timer = setTimeout(() => finish(authError(`${this.name} sign-in timed out`)), this.authTimeoutMs);
    timer.unref?.();
    redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: this.scope, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...this.extraAuthParams });
    const url = `${this.authUrl}?${q}`;
    if (openExternal) { try { await openExternal(url); } catch (e) { finish(e); } }
    const cancel = () => finish(authError(`${this.name} sign-in was cancelled`));
    this.pending = cancel;
    return { authUrl: url, redirectUri, done, cancel };
  }

  // A valid access token, refreshed when missing or about to expire.
  async accessToken({ force = false } = {}) {
    const c = this.config();
    if (!force && c.accessToken && c.expiresAt - this.now() > 60000) return c.accessToken;
    if (!c.refreshToken) throw authError(`${this.name} is not connected`);
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const r = await this.postForm({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' });
        if (!r.ok || !r.json.access_token) {
          if (r.json.error === 'invalid_grant') { this.saveConfig({ refreshToken: '', accessToken: '', expiresAt: 0 }); throw authError(`${this.name} access expired or was revoked: connect again`); }
          throw new Error(`${this.name} token refresh failed: ${r.json.error_description || r.json.error || `HTTP ${r.status}`}`);
        }
        return this.saveTokens(r.json).accessToken;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  // fetch(url, init) with the bearer token, refreshing once on a 401
  async request(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken({ force: attempt > 0 });
      const res = await this.fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }, signal: init.signal || AbortSignal.timeout(30000) });
      if (res.status === 401 && attempt === 0) continue;
      return res;
    }
  }

  async disconnect() { this.saveConfig({ refreshToken: '', accessToken: '', expiresAt: 0 }); }
}

module.exports = { PkceClient };
