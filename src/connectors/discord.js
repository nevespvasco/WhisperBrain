'use strict';
// Discord channels of YOUR OWN server as items, read with your own bot (the same bot token as the voice feature; unofficial clients and
// scraping a personal account are against Discord's rules and are not used). The bot needs View Channel and Read Message History, and the
// Message Content intent switched on in the developer portal. One item per channel per day (src/connectors/chat.js).
//
// What is read follows the source's access grant (src/access/grants.js; an old source without one reads the channels config lists):
//   metadata: per channel per day, who wrote and how many messages, NO text
//   part:     the channels config lists, minus the "never read" list (channels, people, words), applied before anything is stored
//   all:      every text channel of the server in config.guildId (up to 300), minus the same list
const { request } = require('./http');
const { DAY, startOfDay, saveDays, add, levelOf, blockedReason, skippedRun, cursorsFor, cursorPatch, filterNever, channelBlocked, forgetChannel } = require('./chat');

const BASE = 'https://discord.com/api/v10';
const EPOCH = 1420070400000n;
const every = 15 * 60_000;
const FIRST_DAYS = 30;
const MAX_PAGES = 30;
const MAX_ALL_CHANNELS = 300;
const TEXT_CHANNEL_TYPES = new Set([0, 5]);   // 0 = text, 5 = announcement; voice, categories, forums and threads are not read

const snowflake = (ms) => (BigInt(ms) - EPOCH << 22n).toString();
const toMs = (id) => Number((BigInt(id) >> 22n) + EPOCH);

// grant: the grant the source is being added with, when the caller has it (level 'all' reads a whole server: it needs its id, not a channel list)
function validate(config, grant = {}) {
  const channels = (Array.isArray(config.channels) ? config.channels : String(config.channels || '').split(/[\s,]+/)).map((c) => String(c).trim()).filter(Boolean);
  const guildId = String(config.guildId || '').trim();
  if (!channels.length && (grant.readLevel === 'all' || config.all === true)) {
    if (!/^\d{15,22}$/.test(guildId)) throw Object.assign(new Error('Give the server id to read all of it (Discord: right-click the server → Copy Server ID).'), { status: 400 });
    return { channels: [], guildId, all: true };
  }
  if (guildId && !/^\d{15,22}$/.test(guildId)) throw Object.assign(new Error(`“${guildId}” is not a server id (a long number).`), { status: 400 });
  if (!channels.length) throw Object.assign(new Error('Give at least one channel id (Discord: Settings → Advanced → Developer Mode, then right-click a channel → Copy Channel ID).'), { status: 400 });
  const bad = channels.find((c) => !/^\d{15,22}$/.test(c));
  if (bad) throw Object.assign(new Error(`“${bad}” is not a channel id (a long number).`), { status: 400 });
  return { channels: [...new Set(channels)].slice(0, 30), ...(guildId ? { guildId } : {}) };
}
const ready = ({ settings }) => !!settings.get('discord').token;
const headers = (token) => ({ Authorization: `Bot ${token}`, 'User-Agent': 'WhisperBrain (local, read-only)' });

async function check({ settings, fetchImpl, bases = {}, sleep }) {
  const r = await request(`${bases.discord || BASE}/users/@me`, { service: 'Discord', headers: headers(settings.get('discord').token), fetchImpl, sleep });
  return { ok: true, bot: r.json.username };
}

// The text channels of a server, as the bot sees them: [{ id, name, guild_id }]
async function guildChannels({ guildId, base, h, fetchImpl, sleep }) {
  const r = await request(`${base}/guilds/${guildId}/channels`, { service: 'Discord', headers: h, fetchImpl, sleep });
  return (r.json || []).filter((c) => TEXT_CHANNEL_TYPES.has(c.type)).map((c) => ({ ...c, guild_id: c.guild_id || guildId })).slice(0, MAX_ALL_CHANNELS);
}

// raw Discord messages -> the chat shape ({ at, who, uid, text, ref })
const toMessages = (msgs) => msgs.filter((m) => (m.type === 0 || m.type === 19) && (m.content || m.attachments?.length))
  .map((m) => ({ at: Date.parse(m.timestamp) || toMs(m.id), who: m.member?.nick || m.author?.global_name || m.author?.username || 'someone', uid: m.author?.id || '', text: `${m.content || ''}${m.attachments?.length ? ` [${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''}]` : ''}`.trim(), ref: m.id }));
const discordUri = (c, m) => `https://discord.com/channels/${c.guild || '@me'}/${c.id}/${m.ref}`;

async function sync({ source, items, settings, fetchImpl, bases = {}, sleep, now = () => Date.now() }) {
  const token = settings.get('discord').token;
  if (!token) throw Object.assign(new Error('Add the Discord bot token first (Integrations → Discord).'), { permanent: true });
  const blocked = blockedReason(source, now());
  if (blocked) return skippedRun(blocked);
  const level = levelOf(source), metadataOnly = level === 'metadata', never = source.filter?.never;
  const base = bases.discord || BASE, h = headers(token);
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const cursors = cursorsFor(source, level);
  let known = null;                                                            // channel objects listed for the whole server (level 'all')
  if (level === 'all') {
    const guildId = source.config.guildId || settings.get('discord').guildId;
    if (!guildId) throw Object.assign(new Error('Give the Discord server id to read all of it.'), { permanent: true });
    known = await guildChannels({ guildId, base, h, fetchImpl, sleep });
    for (const id of source.config.channels || []) if (!known.some((c) => c.id === id)) known.push({ id });   // a channel config names that is not in the list: read it too
  }
  try {
    for (const entry of known || (source.config.channels || []).map((id) => ({ id }))) {
      const id = entry.id;
      let info = entry;
      if (!entry.name) {
        try { info = (await request(`${base}/channels/${id}`, { service: 'Discord', headers: h, fetchImpl, sleep })).json; } catch (e) { if (e.code === 'rate-limited') throw e; out.errors++; continue; }
      }
      const channel = { id, name: `#${info.name || id}`, guild: info.guild_id };
      if (channelBlocked(never, channel)) { out.removed += forgetChannel(items, source, id); continue; }   // on the never-read list: not even looked at
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
      const messages = filterNever(never, channel, toMessages(msgs));
      add(out, saveDays({ items, source, channel, messages, uriOf: discordUri, metadataOnly }));
      for (const m of msgs) if (!newest || BigInt(m.id) > BigInt(newest)) newest = m.id;
      if (newest) cursors[id] = newest;
    }
  } finally {
    items.updateSource(source.id, { config: cursorPatch(cursors, level) });      // what was read stays read, even when a rate limit stopped the run
  }
  return out;
}

module.exports = { kind: 'discord', every, validate, ready, check, sync, headers, toMessages, discordUri, guildChannels, BASE };
