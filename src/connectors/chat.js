'use strict';
// Chat (Slack, Discord) as items: one item per channel per day, holding that day's messages as lines. A day is rebuilt in full every
// time something in it changes, so an item is always the whole day and a re-run updates it instead of duplicating it. Days are UTC days,
// so the same message always belongs to the same item whatever the computer's clock says.
const DAY = 86_400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

// messages: [{ at (ms), who, text, ref }] -> Map(day -> [messages]) in time order
function byDay(messages) {
  const out = new Map();
  for (const m of [...messages].sort((a, b) => a.at - b.at)) { const d = day(m.at); (out.get(d) || out.set(d, []).get(d)).push(m); }
  return out;
}

// Save each day as an item of the source. -> { created, updated, unchanged }
function saveDays({ items, source, channel, messages, uriOf }) {
  const out = { created: 0, updated: 0, unchanged: 0 };
  for (const [d, list] of byDay(messages)) {
    const text = list.map((m) => `[${hhmm(m.at)}] ${m.who}: ${m.text}`).join('\n');
    const r = items.upsert(source.id, {
      externalId: `${channel.id}:${d}`, kind: 'message', title: `${channel.name} · ${d}`, text, uri: uriOf ? uriOf(channel, list[0]) : '',
      occurredAt: list[list.length - 1].at, metaInHash: true, meta: { channel: channel.name, channelId: channel.id, day: d, messages: list.length, people: [...new Set(list.map((m) => m.who))].slice(0, 20) },
    });
    out[r.action === 'revived' ? 'updated' : r.action]++;
  }
  return out;
}

const add = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };

module.exports = { DAY, day, startOfDay, byDay, saveDays, add };
