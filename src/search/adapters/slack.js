'use strict';
// Live search of Slack messages, asked of Slack itself. Slack's `search.messages` only answers to a USER token with `search:read`
// (a bot token cannot call it), so this needs the setting slack.userToken in addition to the app token the sync uses. Without it the
// adapter says so instead of pretending to search.
//
// It only asks about channels the source is granted: at 'part' the channels config lists (one question per channel, `in:#name`); at 'all'
// the channels the Slack app is in (the same set the sync reads). Every answer is checked again here against those channels and against the
// never-read list, because a search by a person's token can reach more than the app was given (DMs, channels the app is not in).
const { request } = require('../../connectors/http');
const { clean, channelsOf, peopleOf, readMessages, toMessages, slackUri, BASE } = require('../../connectors/slack');
const { DAY, day, dayItem, levelOf, blockedReason, neverMatcher, filterNever, channelBlocked } = require('../../connectors/chat');

const MAX_CHANNEL_QUERIES = 8;     // search.messages is a "tier 2" method (about 20 a minute): a handful of channels per question
const needsToken = () => Object.assign(new Error('Slack\'s search needs a user token with search:read (Settings → Integrations → Slack → "User token for search"). The app token cannot search.'), { code: 'needs-user-token' });
const readable = (source, now = Date.now()) => !blockedReason(source, now) && ['part', 'all'].includes(levelOf(source));
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function call(method, params, { token, ctx }) {
  const url = `${ctx.bases?.slack || BASE}/${method}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))}`;
  const r = await request(url, { service: 'Slack', headers: { Authorization: `Bearer ${token}` }, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
  if (!r.json?.ok) throw Object.assign(new Error(`Slack: ${r.json?.error || 'failed'}${r.json?.error === 'missing_scope' ? ` (needs ${r.json.needed})` : ''}`), { code: r.json?.error === 'missing_scope' ? 'missing-scope' : 'http' });
  return r.json;
}

// The channels the source is granted: [{ id, name }] (name without '#'). `known` = what the app can list (may be empty when it cannot).
function grantedChannels(source, known) {
  if (levelOf(source) === 'all') return known.filter((c) => c.is_member !== false).map((c) => ({ id: c.id, name: c.name }));
  const out = [];
  for (const want of source.config?.channels || []) {
    const hit = known.find((c) => c.id === want || c.name === want);
    if (hit) out.push({ id: hit.id, name: hit.name });
    else if (!/^[CGD][A-Z0-9]{7,}$/.test(want)) out.push({ id: '', name: want });          // a name the app could not list: search by name, check by name
  }
  return out;
}

module.exports = {
  provider: 'slack',
  label: 'Slack',
  // ctx is optional: with it, the user token must be set
  supports: (source, ctx) => source?.kind === 'slack' && (!ctx?.settings || !!ctx.settings.get('slack').userToken),

  async search({ source, query, limit = 10, ctx }) {
    if (!readable(source, ctx.now?.())) return [];                                    // metadata / none / expired: nothing may be asked about
    const userToken = ctx.settings.get('slack').userToken;
    if (!userToken) throw needsToken();
    const q = String(query || '').replace(/\b(?:in|from|to|with|before|after|on|during|has|is):\S*/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);   // no modifiers of the person's own: the channel is ours to choose
    if (!q) return [];
    const appToken = ctx.settings.get('slack').token;
    let known = [];
    if (appToken || levelOf(source) === 'all') known = await channelsOf({ token: appToken || userToken, base: ctx.bases?.slack || BASE, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep }).catch(() => []);
    const never = source.filter?.never;
    const granted = grantedChannels(source, known).filter((c) => !channelBlocked(never, { id: c.id, name: `#${c.name}` }));   // a channel on the never-read list is not even asked about
    if (!granted.length) return [];
    const byId = new Set(granted.filter((c) => c.id).map((c) => c.id)), byNameOnly = new Set(granted.filter((c) => !c.id).map((c) => c.name));   // a channel the app could not list is checked by its name
    const asks = levelOf(source) === 'all' ? [{ text: q }] : granted.slice(0, MAX_CHANNEL_QUERIES).map((c) => ({ text: `${q} in:#${c.name}` }));
    const found = new Map();
    for (const ask of asks) {
      const j = await call('search.messages', { query: ask.text, count: Math.min(Math.max(limit, 1), 50), sort: 'timestamp', sort_dir: 'desc' }, { token: userToken, ctx });
      for (const m of j.messages?.matches || []) {
        const ch = m.channel || {};
        if (!(byId.has(ch.id) || byNameOnly.has(ch.name))) continue;                  // re-checked: only the granted channels
        const channel = { id: ch.id || '', name: `#${ch.name || ch.id}` };
        if (channelBlocked(never, channel)) continue;
        const text = clean(m.text, new Map());
        if (filterNever(never, channel, [{ who: m.username || m.user || '', uid: m.user || '', text }]).length === 0) continue;
        const at = Math.round(Number(m.ts) * 1000);
        found.set(`${ch.id}:${day(at)}`, { externalId: `${ch.id}:${day(at)}`, title: `${channel.name} · ${day(at)}`, snippet: oneLine(text, 240), uri: m.permalink || slackUri({ id: ch.id }, { ref: m.ts }), at, who: m.username || m.user || '' });
      }
    }
    return [...found.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  },

  // One channel-day in full, exactly as the sync would have stored it: externalId is "<channel id>:<YYYY-MM-DD>".
  async open({ source, externalId, ctx }) {
    if (!readable(source, ctx.now?.())) throw Object.assign(new Error('This source may not be read at its current level.'), { status: 403 });
    const m = /^([A-Z0-9]+):(\d{4}-\d{2}-\d{2})$/.exec(String(externalId));
    if (!m) throw Object.assign(new Error('not a Slack channel-day reference (channel id:YYYY-MM-DD)'), { status: 400 });
    const [, channelId, d] = m;
    const token = ctx.settings.get('slack').token || ctx.settings.get('slack').userToken;
    if (!token) throw Object.assign(new Error('Add a Slack token first.'), { code: 'not-configured' });
    const c = { token, base: ctx.bases?.slack || BASE, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep };
    const known = await channelsOf(c).catch(() => []);
    const granted = grantedChannels(source, known);
    const ch = granted.find((g) => g.id === channelId);
    if (!ch) throw Object.assign(new Error('That channel is not part of this source.'), { status: 403 });
    const channel = { id: ch.id, name: `#${ch.name}` };
    const never = source.filter?.never;
    if (channelBlocked(never, channel)) throw Object.assign(new Error('That channel is on this source\'s never-read list.'), { status: 403 });
    const from = Date.parse(`${d}T00:00:00Z`);
    const people = await peopleOf(c);
    const raw = await readMessages({ channelId, oldest: from, latest: from + DAY, ctx: c });
    const list = filterNever(never, channel, toMessages(raw, people)).sort((a, b) => a.at - b.at);   // in time order, as the sync stores a day
    if (!list.length) throw Object.assign(new Error('Nothing is left to show of that day.'), { status: 404 });
    return dayItem({ channel, day: d, list, uriOf: slackUri });
  },
};
