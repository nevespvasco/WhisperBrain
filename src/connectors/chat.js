'use strict';
// Chat (Slack, Discord) as items: one item per channel per day, holding that day's messages as lines. A day is rebuilt in full every
// time something in it changes, so an item is always the whole day and a re-run updates it instead of duplicating it. Days are UTC days,
// so the same message always belongs to the same item whatever the computer's clock says.
//
// What is stored follows the source's access grant (src/access/grants.js): at 'metadata' the item says who wrote and how much, with NO
// message text; at 'part' / 'all' it holds the day's lines. The "never read" list is applied to messages before anything is stored.
const DAY = 86_400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

// ---------- the grant, as a connector needs it ----------

// A source made before grants existed has no readLevel: it reads what its config lists ('part'), exactly as it did.
const levelOf = (source) => source?.readLevel || 'part';
const listOf = (v, n = 200) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, n);

// Why a sync may not read at all right now, or null. Same words as Gmail's, so the Sources page can show them the same way.
function blockedReason(source, now = Date.now()) {
  if (levelOf(source) === 'none') return 'nothing may be read';
  if (source?.expiresAt != null && source.expiresAt <= now) return 'access expired';
  return null;
}
const skippedRun = (reason) => ({ created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0, skipped: reason });

// The cursors only mean something for the kind of read they were made at: what was read as titles alone (metadata) was read WITHOUT its
// text, so a later sync with text must start again instead of continuing after it. A source that has never recorded one keeps its cursors.
const cursorClass = (level) => (level === 'metadata' ? 'metadata' : 'body');
function cursorsFor(source, level) {
  const was = source.config?.cursorsLevel;
  return was && was !== cursorClass(level) ? {} : { ...(source.config?.cursors || {}) };
}
const cursorPatch = (cursors, level) => ({ cursors, cursorsLevel: cursorClass(level) });

// ---------- the "never read" list ----------

// never: { senders, domains, labels, keywords } (the same list as for mail). For chat: senders = people (display name, handle or id),
// domains = the domain of a person's address when the service gives one, labels = channel names (or repository labels), keywords = words
// in the text. -> a checker object; every check is false when its list is empty.
function neverMatcher(never = {}) {
  const lc = (v, n) => listOf(v, n).map((s) => s.toLowerCase().replace(/^[@#]/, ''));
  const senders = new Set(lc(never?.senders)), labels = new Set(lc(never?.labels, 50)), domains = lc(never?.domains).map((d) => d.replace(/^@/, '')), words = lc(never?.keywords, 50);
  return {
    empty: !senders.size && !labels.size && !domains.length && !words.length,
    person: (...ids) => ids.some((i) => i && senders.has(String(i).toLowerCase().replace(/^@/, ''))),
    email: (e) => { const x = String(e || '').toLowerCase(); return !!x && (senders.has(x) || domains.some((d) => x.endsWith(`@${d}`) || x.endsWith(`.${d}`))); },
    label: (...names) => names.some((n) => n && labels.has(String(n).toLowerCase().replace(/^[@#]/, ''))),
    text: (t) => { const x = String(t || '').toLowerCase(); return !!x && words.some((w) => x.includes(w)); },
  };
}

// Must this NOT be stored? One check for chat: { channel (name or id, or a list of them), who / uid (who wrote it), email, text }.
// A matching channel is never read at all; a matching person or word leaves out that one message.
function neverRead(never, { channel, who, uid, email, text } = {}) {
  const m = neverMatcher(never);
  if (m.empty) return false;
  return m.label(...[].concat(channel || [])) || m.person(who, uid) || m.email(email) || m.text(text);
}

// The messages of a channel that may be stored: [] when the channel itself is on the list.
// messages: [{ at, who, uid, text, ref }]
function filterNever(never, channel, messages) {
  const m = neverMatcher(never);
  if (m.empty) return messages;
  if (m.label(channel?.name, channel?.id, String(channel?.name || '').replace(/^#/, ''))) return [];
  return messages.filter((x) => !(m.person(x.who, x.uid) || m.text(x.text)));
}
const channelBlocked = (never, channel) => filterNever(never, channel, [{ who: '', text: '' }]).length === 0;

// A channel that came onto the never list after it was read: forget what is kept of it (every day item starts with the channel id).
function forgetChannel(items, source, channelId) {
  let n = 0;
  if (!items.db?.prepare) return n;
  for (const r of items.db.prepare("SELECT external_id FROM items WHERE source_id = ? AND deleted_at IS NULL AND external_id LIKE ? ESCAPE '\\'").all(source.id, `${String(channelId).replace(/[\\%_]/g, '\\$&')}:%`)) if (items.tombstone(source.id, r.external_id)) n++;
  return n;
}

// ---------- the items ----------

// messages: [{ at (ms), who, text, ref }] -> Map(day -> [messages]) in time order
function byDay(messages) {
  const out = new Map();
  for (const m of [...messages].sort((a, b) => a.at - b.at)) { const d = day(m.at); (out.get(d) || out.set(d, []).get(d)).push(m); }
  return out;
}

// The item of one channel-day, exactly as it is handed to items.upsert (also what a live search opens): used by saveDays and by the
// live adapters, so a day found by a search looks the same as one that was synced.
// metadataOnly: who wrote and how many, no text at all.
function dayItem({ channel, day: d, list, uriOf, metadataOnly = false }) {
  const people = [...new Set(list.map((m) => m.who))];
  return {
    externalId: `${channel.id}:${d}`, kind: 'message',
    title: metadataOnly ? `${channel.name} · ${d} · ${list.length} message${list.length === 1 ? '' : 's'} from ${people.slice(0, 8).join(', ')}` : `${channel.name} · ${d}`,
    text: metadataOnly ? '' : list.map((m) => `[${hhmm(m.at)}] ${m.who}: ${m.text}`).join('\n'),
    uri: uriOf ? uriOf(channel, list[0]) : '',
    occurredAt: list[list.length - 1].at, metaInHash: true,
    meta: { channel: channel.name, channelId: channel.id, day: d, messages: list.length, people: people.slice(0, 20), ...(metadataOnly ? { metadataOnly: true } : {}) },
  };
}

// Save each day as an item of the source. -> { created, updated, unchanged }
function saveDays({ items, source, channel, messages, uriOf, metadataOnly = false }) {
  const out = { created: 0, updated: 0, unchanged: 0 };
  for (const [d, list] of byDay(messages)) {
    const r = items.upsert(source.id, dayItem({ channel, day: d, list, uriOf, metadataOnly }));
    out[r.action === 'revived' ? 'updated' : r.action]++;
  }
  return out;
}

const add = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };

module.exports = {
  DAY, day, startOfDay, hhmm, byDay, saveDays, dayItem, add,
  levelOf, blockedReason, skippedRun, cursorsFor, cursorPatch, listOf,
  neverMatcher, neverRead, filterNever, channelBlocked, forgetChannel,
};
