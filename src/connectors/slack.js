'use strict';
// Slack channels as items, through the token of YOUR OWN Slack app (an internal app is not under the limits Slack put on shared apps in
// 2025: one history request a minute for those). Read-only: channels:history (and groups:history for private channels), channels:read,
// users:read. One item per channel per day (src/connectors/chat.js). Incremental: it reads again from the start of the day of the last
// message it saw. A 429 is waited out when short; otherwise the run stops and the next one continues.
//
// What is read follows the source's access grant (src/access/grants.js; an old source without one reads what its config lists):
//   metadata: per channel per day, who wrote and how many messages, NO text (and thread replies are not fetched)
//   part:     the channels config lists, minus the "never read" list (channels, people, words), applied before anything is stored
//   all:      every channel the Slack app is in (public and private, up to 300), minus the same list
const { request } = require('./http');
const { DAY, startOfDay, saveDays, add, levelOf, blockedReason, skippedRun, cursorsFor, cursorPatch, filterNever, channelBlocked, forgetChannel } = require('./chat');

const BASE = 'https://slack.com/api';
const every = 15 * 60_000;
const FIRST_DAYS = 30;
const MAX_PAGES = 20;
const MAX_ALL_CHANNELS = 300;

// grant: the grant the source is being added with, when the caller has it (level 'all' needs no channel list: it reads every channel the app is in)
function validate(config, grant = {}) {
  const channels = (Array.isArray(config.channels) ? config.channels : String(config.channels || '').split(/[\s,]+/)).map((c) => String(c).trim().replace(/^#/, '')).filter(Boolean);
  if (!channels.length && (grant.readLevel === 'all' || config.all === true)) return { channels: [], all: true };
  if (!channels.length) throw Object.assign(new Error('Name at least one channel (for example general), or its id.'), { status: 400 });
  return { channels: [...new Set(channels)].slice(0, 30) };
}
const ready = ({ settings }) => !!settings.get('slack').token;

async function api(method, params, { token, base, fetchImpl, sleep }) {
  const url = `${base}/${method}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))}`;
  const r = await request(url, { service: 'Slack', headers: { Authorization: `Bearer ${token}` }, fetchImpl, sleep });
  if (!r.json?.ok) throw Object.assign(new Error(`Slack: ${r.json?.error || 'failed'}${r.json?.error === 'missing_scope' ? ` (needs ${r.json.needed})` : ''}`), { code: /invalid_auth|not_authed|token_revoked|account_inactive/.test(r.json?.error || '') ? 'unauthorized' : 'http', permanent: /invalid_auth|not_authed/.test(r.json?.error || '') });
  return r.json;
}

async function check(ctx) {
  const j = await api('auth.test', {}, { token: ctx.settings.get('slack').token, base: ctx.bases?.slack || BASE, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
  return { ok: true, team: j.team, user: j.user };
}

// "<@U1> <#C1|general> <https://x|label> &amp;" -> readable text
const clean = (text, names) => String(text || '')
  .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (m, id) => `@${names.get(id) || id}`)
  .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<(https?:[^>]+)>/g, '$1').replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// -> the items of up to MAX_PAGES pages; `out.more` is true when it stopped at that cap with pages left
async function paginate(method, params, ctx, key) {
  const out = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await api(method, { ...params, cursor }, ctx);
    out.push(...(j[key] || []));
    cursor = j.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  out.more = !!cursor;
  return out;
}

// The messages of one channel from `oldest` (and up to `latest` when given), thread replies included unless withReplies is false.
// -> the raw Slack messages, joins and topic changes left out. History comes newest first: when the page cap stopped it, `more` is
// true and `lowest` (ms) is the oldest message read; everything between `oldest` and that is still unread.
async function readMessages({ channelId, oldest, latest, ctx, withReplies = true }) {
  const msgs = await paginate('conversations.history', { channel: channelId, oldest: String(oldest / 1000), latest: latest ? String(latest / 1000) : undefined, limit: 200 }, ctx, 'messages');
  const all = [];
  all.more = msgs.more;
  all.lowest = msgs.reduce((a, m) => Math.min(a, Number(m.ts) * 1000), Infinity);
  all.highest = msgs.reduce((a, m) => Math.max(a, Number(m.ts) * 1000), -Infinity);   // of the history itself, not of thread replies
  for (const m of msgs) {
    if (m.subtype && !['bot_message', 'thread_broadcast'].includes(m.subtype)) continue;      // joins, topic changes...
    all.push(m);
    if (withReplies && m.reply_count && m.thread_ts === m.ts) {
      const replies = await paginate('conversations.replies', { channel: channelId, ts: m.ts, limit: 200 }, ctx, 'messages').catch(() => []);
      all.push(...replies.filter((r) => r.ts !== m.ts));
    }
  }
  return all;
}

// raw Slack messages -> the chat shape ({ at, who, uid, text, ref })
const toMessages = (all, people) => all.filter((m) => m.text).map((m) => ({ at: Math.round(Number(m.ts) * 1000), who: people.get(m.user) || m.username || m.bot_profile?.name || m.user || 'someone', uid: m.user || '', text: clean(m.text, people), ref: m.ts }));
const slackUri = (c, m) => `https://slack.com/app_redirect?channel=${c.id}&message_ts=${m.ref}`;

// The people of the workspace, id -> name (empty when the token may not list them: ids are shown instead)
async function peopleOf(ctx) { return new Map((await paginate('users.list', { limit: 200 }, ctx, 'members').catch(() => [])).map((u) => [u.id, u.profile?.display_name || u.real_name || u.name || u.id])); }

// The channels this token can see (public and private, not archived). `member` ones only when asked: the app is in them.
async function channelsOf(ctx, { memberOnly = false } = {}) {
  const known = await paginate('conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: 200 }, ctx, 'channels');
  return memberOnly ? known.filter((c) => c.is_member !== false) : known;
}

async function sync({ source, items, settings, fetchImpl, bases = {}, sleep, now = () => Date.now() }) {
  const token = settings.get('slack').token;
  if (!token) throw Object.assign(new Error('Add a Slack token first.'), { permanent: true });
  const blocked = blockedReason(source, now());
  if (blocked) return skippedRun(blocked);
  const level = levelOf(source), metadataOnly = level === 'metadata', never = source.filter?.never;
  const ctx = { token, base: bases.slack || BASE, fetchImpl, sleep };
  const people = await peopleOf(ctx);
  const known = await channelsOf(ctx);
  // what to read: the channels config lists, or (at 'all') every channel the app is in plus any it lists
  let targets;
  if (level === 'all') {
    const wanted = new Set(source.config.channels || []);
    targets = known.filter((c) => c.is_member !== false || wanted.has(c.id) || wanted.has(c.name)).slice(0, MAX_ALL_CHANNELS);
  } else targets = null;
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const cursors = cursorsFor(source, level);
  try {
    const list = targets ? targets.map((ch) => ({ ch })) : (source.config.channels || []).map((want) => ({ want, ch: known.find((c) => c.id === want || c.name === want) }));
    for (const { ch } of list) {
      if (!ch) { out.errors++; continue; }                                  // not found, or the app is not in it
      const channel = { id: ch.id, name: `#${ch.name}` };
      if (channelBlocked(never, channel)) { out.removed += forgetChannel(items, source, ch.id); continue; }   // on the never-read list: not even looked at
      const since = cursors[ch.id] ? startOfDay(Number(cursors[ch.id]) * 1000) : startOfDay(now() - FIRST_DAYS * DAY);
      // ranges an earlier run left unread, newest first: [{ oldest, latest }] (ms)
      const bkey = `backlog:${ch.id}`, backlog = [].concat(cursors[bkey] || []).filter((r) => r && r.latest > r.oldest);
      // Read [oldest, latest) and store the days it holds whole. At the page cap only the newest messages came back: the oldest
      // day read may be partial, so it is left out and [oldest, end of that day) is kept as the backlog for the next run (the
      // cursor used to jump to the newest message and the older ones were never read). A single day over the cap can't be
      // whole: its newest part is kept and the backlog goes on from the start of that day.
      const readRange = async (oldest, latest) => {
        const all = await readMessages({ channelId: ch.id, oldest, latest, ctx, withReplies: !metadataOnly });
        let from = oldest, rest = null;
        if (all.more && Number.isFinite(all.lowest)) {
          const cut = startOfDay(all.lowest) + DAY;
          if (all.highest >= cut) {   // something was read past the partial day: the days from `cut` on are whole
            from = cut; rest = { oldest, latest: cut }; } else { from = startOfDay(all.lowest); rest = { oldest, latest: from }; }
        }
        const messages = filterNever(never, channel, toMessages(all, people)).filter((m) => m.at >= from && (latest == null || m.at < latest));
        add(out, saveDays({ items, source, channel, messages, uriOf: slackUri, metadataOnly }));
        return { all, rest: rest && rest.latest > rest.oldest ? rest : null };
      };
      const fresh = await readRange(since, null);
      if (fresh.all.length) cursors[ch.id] = fresh.all.reduce((a, m) => (Number(m.ts) > Number(a) ? m.ts : a), cursors[ch.id] || '0');
      if (backlog.length) {                               // one more chunk of the newest range an earlier run left unread
        const old = await readRange(backlog[0].oldest, backlog[0].latest);
        backlog.splice(0, 1, ...(old.rest ? [old.rest] : []));
      }
      if (fresh.rest) backlog.unshift(fresh.rest);
      while (backlog.length > 5) { const last = backlog.pop(); backlog[backlog.length - 1].oldest = Math.min(backlog[backlog.length - 1].oldest, last.oldest); }
      if (backlog.length) cursors[bkey] = backlog; else delete cursors[bkey];
    }
  } finally {
    items.updateSource(source.id, { config: cursorPatch(cursors, level) });      // what was read stays read, even when a rate limit stopped the run
  }
  return out;
}

module.exports = { kind: 'slack', every, validate, ready, check, sync, clean, api, paginate, readMessages, toMessages, peopleOf, channelsOf, slackUri, BASE };
