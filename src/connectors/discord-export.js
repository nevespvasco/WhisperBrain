'use strict';
// Discord's own "data package" (Settings → Privacy & Safety → Request all of my data): a ZIP with the messages YOU wrote, per channel. This is
// the allowed way to bring a personal Discord history in (a personal account is never read through an unofficial client). One item per
// channel per day, like the live reader, marked as yours. Both the JSON and the older CSV layout are understood.
const { readZip } = require('../importers/zip');
const { saveDays, add } = require('./chat');

const MAX_MESSAGES = 200_000;

// minimal CSV (quoted fields, doubled quotes, newlines inside quotes)
function csv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function readChannel(zip, dir) {
  const has = (n) => zip.has(`${dir}${n}`);
  if (has('messages.json')) {
    const list = JSON.parse(zip.read(`${dir}messages.json`).toString('utf8'));
    return list.map((m) => ({ id: String(m.ID ?? m.id ?? ''), ts: m.Timestamp ?? m.timestamp, text: m.Contents ?? m.content ?? '', files: m.Attachments ?? m.attachments ?? '' }));
  }
  if (has('messages.csv')) {
    const rows = csv(zip.read(`${dir}messages.csv`).toString('utf8'));
    const head = rows.shift() || [];
    const ix = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
    return rows.filter((r) => r.length > 1).map((r) => ({ id: r[ix('id')], ts: r[ix('timestamp')], text: r[ix('contents')] ?? '', files: r[ix('attachments')] ?? '' }));
  }
  return [];
}

// buffer: the ZIP. Returns { channels, created, updated, unchanged }.
function importPackage(buffer, { items, source }) {
  // lazy: only messages/* is ever read, so the budget counts what is read, not the analytics files' declared sizes
  const zip = readZip(buffer, { lazy: true });
  const names = new Map();
  try { const idx = JSON.parse(zip.read('messages/index.json').toString('utf8')); for (const [id, name] of Object.entries(idx)) names.set(id, name); } catch { /* names are optional */ }
  const dirs = [...new Set(zip.entries.map((e) => /^(messages\/c?\d+\/)/.exec(e.name)?.[1]).filter(Boolean))];
  if (!dirs.length) throw Object.assign(new Error('This does not look like a Discord data package (no messages folder).'), { status: 400 });
  const out = { channels: 0, created: 0, updated: 0, unchanged: 0 };
  let total = 0;
  for (const dir of dirs) {
    const id = dir.replace(/^messages\/c?/, '').replace(/\/$/, '');
    let raw;
    try { raw = readChannel(zip, dir); } catch { continue; }
    const messages = raw.map((m) => ({ at: Date.parse(m.ts), who: 'you', text: `${m.text || ''}${m.files ? ' [attachment]' : ''}`.trim(), ref: m.id })).filter((m) => Number.isFinite(m.at) && m.text);
    total += messages.length;
    if (total > MAX_MESSAGES) throw Object.assign(new Error('This package is too large to import at once.'), { status: 413 });
    if (!messages.length) continue;
    const name = names.get(id) || names.get(`c${id}`) || `channel ${id}`;
    add(out, saveDays({ items, source, channel: { id, name: `#${name.replace(/^Direct Message with /, 'DM: ')}` }, uriOf: (c, m) => (m.ref ? `https://discord.com/channels/@me/${c.id}/${m.ref}` : '') , messages }));
    out.channels++;
  }
  return out;
}

module.exports = { importPackage, csv };
