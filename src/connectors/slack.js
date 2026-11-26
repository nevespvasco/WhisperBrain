'use strict';
// Slack channels as items, through the token of YOUR OWN Slack app (an internal app is not under the limits Slack put on shared apps in
// 2025: one history request a minute for those). Read-only: channels:history (and groups:history for private channels), channels:read,
// users:read. One item per channel per day (src/connectors/chat.js). Incremental: it reads again from the start of the day of the last
// message it saw. A 429 is waited out when short; otherwise the run stops and the next one continues.
const { request } = require('./http');
const { DAY, startOfDay, saveDays, add } = require('./chat');

const BASE = 'https://slack.com/api';
const every = 15 * 60_000;
const FIRST_DAYS = 30;
const MAX_PAGES = 20;

function validate(config) {
  const channels = (Array.isArray(config.channels) ? config.channels : String(config.channels || '').split(/[\s,]+/)).map((c) => String(c).trim().replace(/^#/, '')).filter(Boolean);
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

async function paginate(method, params, ctx, key) {
  const out = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await api(method, { ...params, cursor }, ctx);
    out.push(...(j[key] || []));
    cursor = j.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function sync({ source, items, settings, fetchImpl, bases = {}, sleep, now = () => Date.now() }) {
  const token = settings.get('slack').token;
  if (!token) throw Object.assign(new Error('Add a Slack token first.'), { permanent: true });
  const ctx = { token, base: bases.slack || BASE, fetchImpl, sleep };
  const people = new Map((await paginate('users.list', { limit: 200 }, ctx, 'members').catch(() => [])).map((u) => [u.id, u.profile?.display_name || u.real_name || u.name || u.id]));
  const known = await paginate('conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: 200 }, ctx, 'channels');
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const cursors = { ...(source.config.cursors || {}) };
  for (const want of source.config.channels || []) {
    const ch = known.find((c) => c.id === want || c.name === want);
    if (!ch) { out.errors++; continue; }                                    // not found, or the app is not in it
    const since = cursors[ch.id] ? startOfDay(Number(cursors[ch.id]) * 1000) : startOfDay(now() - FIRST_DAYS * DAY);
    const msgs = await paginate('conversations.history', { channel: ch.id, oldest: String(since / 1000), limit: 200 }, ctx, 'messages');
    const all = [];
    for (const m of msgs) {
      if (m.subtype && !['bot_message', 'thread_broadcast'].includes(m.subtype)) continue;      // joins, topic changes...
      all.push(m);
      if (m.reply_count && m.thread_ts === m.ts) {
        const replies = await paginate('conversations.replies', { channel: ch.id, ts: m.ts, limit: 200 }, ctx, 'messages').catch(() => []);
        all.push(...replies.filter((r) => r.ts !== m.ts));
      }
    }
    const messages = all.filter((m) => m.text).map((m) => ({ at: Math.round(Number(m.ts) * 1000), who: people.get(m.user) || m.username || m.bot_profile?.name || m.user || 'someone', text: clean(m.text, people), ref: m.ts }));
    add(out, saveDays({ items, source, channel: { id: ch.id, name: `#${ch.name}` }, messages, uriOf: (c, m) => `https://slack.com/app_redirect?channel=${c.id}&message_ts=${m.ref}` }));
    if (all.length) cursors[ch.id] = all.reduce((a, m) => (Number(m.ts) > Number(a) ? m.ts : a), '0');
  }
  items.updateSource(source.id, { config: { cursors } });
  return out;
}

module.exports = { kind: 'slack', every, validate, ready, check, sync, clean };
