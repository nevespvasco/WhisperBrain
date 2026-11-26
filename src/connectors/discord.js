'use strict';
// Discord channels of YOUR OWN server as items, read with your own bot (the same bot token as the voice feature; unofficial clients and
// scraping a personal account are against Discord's rules and are not used). The bot needs View Channel and Read Message History, and the
// Message Content intent switched on in the developer portal. One item per channel per day (src/connectors/chat.js).
const { request } = require('./http');
const { DAY, startOfDay, saveDays, add } = require('./chat');

const BASE = 'https://discord.com/api/v10';
const EPOCH = 1420070400000n;
const every = 15 * 60_000;
const FIRST_DAYS = 30;
const MAX_PAGES = 30;

const snowflake = (ms) => (BigInt(ms) - EPOCH << 22n).toString();
const toMs = (id) => Number((BigInt(id) >> 22n) + EPOCH);

function validate(config) {
  const channels = (Array.isArray(config.channels) ? config.channels : String(config.channels || '').split(/[\s,]+/)).map((c) => String(c).trim()).filter(Boolean);
  if (!channels.length) throw Object.assign(new Error('Give at least one channel id (Discord: Settings → Advanced → Developer Mode, then right-click a channel → Copy Channel ID).'), { status: 400 });
  const bad = channels.find((c) => !/^\d{15,22}$/.test(c));
  if (bad) throw Object.assign(new Error(`“${bad}” is not a channel id (a long number).`), { status: 400 });
  return { channels: [...new Set(channels)].slice(0, 30) };
}
const ready = ({ settings }) => !!settings.get('discord').token;
const headers = (token) => ({ Authorization: `Bot ${token}`, 'User-Agent': 'WhisperBrain (local, read-only)' });

async function check({ settings, fetchImpl, bases = {}, sleep }) {
  const r = await request(`${bases.discord || BASE}/users/@me`, { service: 'Discord', headers: headers(settings.get('discord').token), fetchImpl, sleep });
  return { ok: true, bot: r.json.username };
}

async function sync({ source, items, settings, fetchImpl, bases = {}, sleep, now = () => Date.now() }) {
  const token = settings.get('discord').token;
  if (!token) throw Object.assign(new Error('Add the Discord bot token first (Integrations → Discord).'), { permanent: true });
  const base = bases.discord || BASE, h = headers(token);
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const cursors = { ...(source.config.cursors || {}) };
  for (const id of source.config.channels || []) {
    let info;
    try { info = (await request(`${base}/channels/${id}`, { service: 'Discord', headers: h, fetchImpl, sleep })).json; } catch (e) { if (e.code === 'rate-limited') throw e; out.errors++; continue; }
    const from = startOfDay(cursors[id] ? toMs(cursors[id]) : now() - FIRST_DAYS * DAY);
    let after = snowflake(from), newest = cursors[id] || '';
    const msgs = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = (await request(`${base}/channels/${id}/messages?limit=100&after=${after}`, { service: 'Discord', headers: h, fetchImpl, sleep })).json || [];
      if (!page.length) break;
      msgs.push(...page);
      after = page.reduce((a, m) => (BigInt(m.id) > BigInt(a) ? m.id : a), after);
      if (page.length < 100) break;
    }
    const messages = msgs.filter((m) => (m.type === 0 || m.type === 19) && (m.content || m.attachments?.length))
      .map((m) => ({ at: Date.parse(m.timestamp) || toMs(m.id), who: m.member?.nick || m.author?.global_name || m.author?.username || 'someone', text: `${m.content || ''}${m.attachments?.length ? ` [${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''}]` : ''}`.trim(), ref: m.id }));
    add(out, saveDays({ items, source, channel: { id, name: `#${info.name || id}`, guild: info.guild_id }, messages, uriOf: (c, m) => `https://discord.com/channels/${c.guild || '@me'}/${c.id}/${m.ref}` }));
    for (const m of msgs) if (!newest || BigInt(m.id) > BigInt(newest)) newest = m.id;
    if (newest) cursors[id] = newest;
  }
  items.updateSource(source.id, { config: { cursors } });
  return out;
}

module.exports = { kind: 'discord', every, validate, ready, check, sync };
