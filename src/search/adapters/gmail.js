'use strict';
// Live search in Gmail: the person's words AND the source's own part (its label/sender filter and never-read list) go into one Gmail
// search, so a live result never comes from outside what the grant allows; each hit is checked again from its headers. Not possible under
// the metadata permission (Google refuses `q`): then only the local copy is searched.
const { compileQuery, neverRead, threadItem } = require('../../connectors/gmail');
const { canSearch } = require('../../access/gmail-scopes');

const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];
const clientFor = (ctx, source) => (ctx.googleFor ? ctx.googleFor(source) : null) || ctx.google;
const header = (m, n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n)?.value || '';

module.exports = {
  provider: 'gmail',
  label: 'Gmail',

  supports(source, ctx) {
    const g = clientFor(ctx, source);
    return !!g && g.connected() && source.readLevel !== 'metadata' && canSearch(g.grantedScopes?.());
  },

  async search({ source, query, limit = 8, ctx }) {
    const g = clientFor(ctx, source);
    const filter = { ...(source.filter || {}), never: { ...(source.filter?.never || {}), senders: [...(source.filter?.never?.senders || []), ...(ctx.items?.blocked?.() || [])] } };
    // the person's words, then the part: the source's own search is NOT added (it limits to a date window: the point is to go beyond it)
    const q = `${query} ${compileQuery({ labels: source.config?.labels }, filter)}`.trim();
    const list = await g.gmail('/users/me/threads', { q, maxResults: Math.min(25, limit * 2) });
    const out = [];
    for (const t of list.threads || []) {
      if (out.length >= limit) break;
      const th = await g.gmail(`/users/me/threads/${t.id}`, { format: 'metadata', metadataHeaders: HEADERS });
      const msgs = th.messages || [];
      if (!msgs.length || neverRead(msgs, filter.never)) continue;
      const last = msgs[msgs.length - 1];
      out.push({ externalId: `thread:${t.id}`, kind: 'email', title: header(msgs[0], 'subject') || '(no subject)', snippet: String(last.snippet || th.snippet || '').slice(0, 240), uri: `https://mail.google.com/mail/?authuser=${encodeURIComponent(source.config?.email || '')}#all/${t.id}`, at: Number(last.internalDate) || 0, who: header(last, 'from'), historyId: th.historyId });
    }
    return out;
  },

  async open({ source, externalId, ctx }) {
    const g = clientFor(ctx, source);
    const id = String(externalId).replace(/^thread:/, '');
    const th = await g.gmail(`/users/me/threads/${id}`, { format: 'full' });
    const profile = await g.gmail('/users/me/profile');
    const me = new Set([String(profile.emailAddress || '').toLowerCase()]);
    return threadItem(th, me, { account: profile.emailAddress });
  },
};
