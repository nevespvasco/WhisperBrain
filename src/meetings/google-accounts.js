'use strict';
// The Google accounts WhisperBrain reads mail from. The first one is the calendar sign-in (settings.google); more are added only for
// mail (settings.mailAccounts), each with its own tokens and the permissions Google really granted it. A Gmail source remembers which
// account it reads (config.account = 'primary' or the account id), so a work and a personal mailbox are two sources with two grants.
const crypto = require('node:crypto');
const { GoogleCalendar } = require('./google');
const { GMAIL_SCOPES } = require('../access/gmail-scopes');

const PRIMARY = 'primary';

class GoogleAccounts {
  // primary: the existing GoogleCalendar on settings.google. options: what it was built with (test servers, built-in client...)
  constructor({ settings, primary, options = {} }) { Object.assign(this, { settings, primary, options }); this.clients = new Map(); }

  extra() { return this.settings.get('mailAccounts') || []; }
  saveExtra(list) { this.settings.update({ mailAccounts: list }); }

  // a client for an account id: the primary one, or one bound to a mailAccounts entry (its tokens are kept there)
  client(id = PRIMARY) {
    if (id === PRIMARY || !id) return this.primary;
    if (!this.extra().some((a) => a.id === id)) return null;
    if (!this.clients.has(id)) {
      this.clients.set(id, new GoogleCalendar({
        ...this.options,
        // the same app registration as the first sign-in (the built-in client, or the person's own)
        getConfig: () => { const a = this.extra().find((x) => x.id === id) || {}; const p = this.primary.config(); return { ...a, clientId: p.clientId, clientSecret: p.clientSecret, calendars: [], gmail: (a.scopes || []).some((x) => GMAIL_SCOPES.has(x)) }; },
        saveConfig: (patch) => this.saveExtra(this.extra().map((a) => (a.id === id ? { ...a, ...pick(patch) } : a))),
      }));
    }
    return this.clients.get(id);
  }

  // the account a Gmail source reads
  forSource(source) { return this.client(source?.config?.account || PRIMARY); }

  list() {
    const p = this.primary.config();
    const out = [];
    if (p.refreshToken || p.email || p.needsReconnect) out.push({ id: PRIMARY, email: p.email, primary: true, calendar: true, gmail: !!p.gmail, scopes: p.scopes || [], connected: !!p.refreshToken, needsReconnect: !!p.needsReconnect });
    for (const a of this.extra()) out.push({ id: a.id, email: a.email, primary: false, calendar: false, gmail: true, scopes: a.scopes || [], connected: !!a.refreshToken, needsReconnect: !!a.needsReconnect });
    return out;
  }

  find(id) { return this.list().find((a) => a.id === id) || null; }

  // Sign in. account: 'primary' (the calendar sign-in, again), an existing account id (reconnect it) or 'new' (a further mailbox).
  // scopes: the Gmail permissions the grant needs (src/access/gmail-scopes.js). -> { auth, finished: Promise<{ id, email }> }
  async connect({ account = PRIMARY, scopes = [], openExternal } = {}) {
    if (account === PRIMARY) {
      const auth = await this.primary.beginAuth({ openExternal, scopes, calendar: true });
      return { auth, finished: auth.done.then((r) => ({ id: PRIMARY, email: r.email })) };
    }
    // another mailbox: a throwaway client keeps the result, which is stored as an account once Google has answered
    const state = { ...this.primary.config(), refreshToken: '', accessToken: '', expiresAt: 0, email: '', calendars: [], gmail: false, scopes: [] };
    const tmp = new GoogleCalendar({ ...this.options, getConfig: () => state, saveConfig: (p) => Object.assign(state, p) });
    const auth = await tmp.beginAuth({ openExternal, scopes, calendar: false });
    const finished = auth.done.then(() => {
      const email = String(state.email || '').toLowerCase();
      const same = this.extra().find((a) => (account !== 'new' ? a.id === account : a.email === email));
      const entry = { id: same?.id || crypto.randomUUID().slice(0, 12), email, refreshToken: state.refreshToken, accessToken: state.accessToken, expiresAt: state.expiresAt, scopes: state.scopes || [], needsReconnect: false };
      this.saveExtra(same ? this.extra().map((a) => (a.id === same.id ? { ...a, ...entry } : a)) : [...this.extra(), entry]);
      this.clients.delete(entry.id);
      return { id: entry.id, email };
    });
    return { auth, finished };
  }

  // Sign out of one account at Google and forget its tokens. The primary keeps its calendar settings unless keepCalendar is false.
  async disconnect(id = PRIMARY) {
    if (id === PRIMARY) { await this.primary.disconnect(); return true; }
    const c = this.client(id);
    if (!c) return false;
    await c.disconnect().catch(() => {});
    this.saveExtra(this.extra().filter((a) => a.id !== id));
    this.clients.delete(id);
    return true;
  }
}

// what a patch may change on a stored account
const pick = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => ['email', 'refreshToken', 'accessToken', 'expiresAt', 'scopes', 'needsReconnect'].includes(k)));

module.exports = { GoogleAccounts, PRIMARY };
