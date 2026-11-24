'use strict';
// The connection to each platform and "fetch this meeting's transcript": which provider, signed in as whom, which link on the
// note names the meeting, then attach what comes back (src/meet/attach.js). UNVERIFIED against the real platforms, see providers.js.
const { PkceClient } = require('./oauth');
const { PROVIDERS, meetingRef, TranscriptError } = require('./providers');
const { attachTranscript } = require('../meet/attach');

// where each provider signs people in, and the settings group that holds its app registration and tokens
const SETUP = {
  teams: { setting: 'microsoft', name: 'Microsoft', scope: 'offline_access OnlineMeetings.Read OnlineMeetingTranscript.Read.All',
    urls: (c) => { const base = `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'organizations')}/oauth2/v2.0`; return { authUrl: `${base}/authorize`, tokenUrl: `${base}/token` }; } },
  meet: { setting: 'googleMeet', name: 'Google', scope: 'https://www.googleapis.com/auth/meetings.space.readonly', extra: { access_type: 'offline', prompt: 'consent' },
    urls: () => ({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token' }) },
  zoom: { setting: 'zoom', name: 'Zoom', scope: '',
    urls: () => ({ authUrl: 'https://zoom.us/oauth/authorize', tokenUrl: 'https://zoom.us/oauth/token' }) },
};

class TranscriptService {
  constructor({ app, providers = PROVIDERS, fetchImpl = globalThis.fetch }) { Object.assign(this, { app, providers, fetchImpl }); this.clients = new Map(); }

  config(id) { return this.app.settings.get(SETUP[id].setting); }

  client(id) {
    if (!SETUP[id]) throw new TranscriptError(`There is no such platform as "${id}".`, 'unknown');
    const s = SETUP[id];
    return new PkceClient({
      name: s.name, scope: s.scope, extraAuthParams: s.extra || {}, ...s.urls(this.config(id)), fetchImpl: this.fetchImpl,
      getConfig: () => this.config(id), saveConfig: (patch) => this.app.settings.update({ [s.setting]: patch }),
    });
  }

  // [{ id, label, configured, connected }] (never the secrets)
  status() { return Object.keys(SETUP).map((id) => ({ id, label: this.providers[id]?.label || PROVIDERS[id].label, configured: !!this.config(id).clientId, connected: !!this.config(id).refreshToken })); }

  connect(id, opts) { return this.client(id).beginAuth(opts); }
  disconnect(id) { return this.client(id).disconnect(); }

  // The meeting link on a note for this platform, from its links (calendar links, the pasted join URL)
  refFor(noteId, id) {
    const platform = (this.providers[id] || PROVIDERS[id]).platform;
    for (const link of this.app.knowledge.links(noteId)) { const ref = meetingRef(link.url); if (ref?.platform === platform) return ref; }
    return null;
  }

  async fetchForNote(noteId, id) {
    const provider = this.providers[id];
    if (!provider || !SETUP[id]) throw new TranscriptError(`There is no such platform as "${id}".`, 'unknown');
    const client = this.client(id);
    if (!client.connected()) throw new TranscriptError(`${provider.label} is not connected: connect it in Settings first.`, 'not-connected');
    const ref = this.refFor(noteId, id);
    if (!ref) throw new TranscriptError(`This meeting has no ${provider.label} meeting link, so it cannot be looked up there.`, 'no-link');
    const { text, filename } = await provider.fetchTranscript({ client, ref });
    return attachTranscript(this.app, noteId, Buffer.from(text, 'utf8'), filename);
  }
}

module.exports = { TranscriptService, SETUP };
