'use strict';
// Meeting → Markdown / plain text. Shared by every exporter (Notion, Obsidian, Linear, webhooks, clipboard).

const pad = (n) => String(n).padStart(2, '0');
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v));

function fmtClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function fmtDuration(ms) {
  const min = Math.round((Number(ms) || 0) / 60000);
  if (min <= 0) return '';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
// Local calendar date / time — what the user saw on their clock.
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const meetingDate = (m) => toDate(m.startedAt) || toDate(m.createdAt);
function meetingDuration(m) {
  if (Number(m.durationMs) > 0) return Number(m.durationMs);
  const a = Number(m.startedAt), b = Number(m.endedAt);
  return a && b && b > a ? b - a : 0;
}
const attendeeNames = (m) => arr(m.attendees).map((a) => (typeof a === 'string' ? a : str(a?.name).trim() || str(a?.email).trim())).filter(Boolean);
const people = (m) => arr(m.people).map((p) => str(p).trim()).filter(Boolean);

// YAML scalar: plain when unambiguous, otherwise double-quoted (JSON strings are valid YAML).
const YAML_WORDS = /^(true|false|yes|no|on|off|null|~|y|n)$/i;
function yamlEscape(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  const s = str(v);
  if (/^[\p{L}\p{N}][\p{L}\p{N} _.\/@+()&,'-]*$/u.test(s) && !/\s$/.test(s) && !YAML_WORDS.test(s) && !/^[-+]?(\d|\.\d)/.test(s)) return s;
  return JSON.stringify(s);
}
function yamlList(key, items) {
  const xs = arr(items).map(str).filter((x) => x.trim());
  return xs.length ? [`${key}:`, ...xs.map((x) => `  - ${yamlEscape(x)}`)] : [`${key}: []`];
}

function frontmatterLines(m) {
  const d = meetingDate(m);
  const dur = meetingDuration(m);
  return ['---',
    `title: ${yamlEscape(str(m.title) || 'Untitled')}`,
    ...(d ? [`date: ${yamlEscape(d.toISOString())}`] : []),
    ...yamlList('attendees', attendeeNames(m)),
    ...yamlList('tags', arr(m.tags).map((t) => str(t).replace(/^#/, ''))),
    ...yamlList('topics', m.topics),
    ...(m.source ? [`source: ${yamlEscape(m.source)}`] : []),
    `whisperbrain_id: ${yamlEscape(str(m.id))}`,
    ...(dur ? [`duration_minutes: ${Math.round(dur / 60000)}`] : []),
    '---'];
}

// Obsidian forbids [ ] | # ^ inside link targets.
const wiki = (name) => `[[${str(name).replace(/[[\]|#^]/g, '').trim()}]]`;

function metaLine(m, { wikilinks = false } = {}) {
  const d = meetingDate(m);
  const parts = [];
  if (d) parts.push(`${ymd(d)} ${hm(d)}`);
  const dur = fmtDuration(meetingDuration(m));
  if (dur) parts.push(dur);
  const att = attendeeNames(m);
  if (att.length) parts.push(att.map((n) => (wikilinks ? wiki(n) : n)).join(', '));
  return parts.join(' · ');
}

function actionLine(a, { checkbox = true } = {}) {
  let s = `${checkbox ? (a.done ? '- [x] ' : '- [ ] ') : (a.done ? '[x] ' : '[ ] ')}${str(a.text).trim()}`;
  if (str(a.owner).trim()) s += ` — ${str(a.owner).trim()}`;
  if (str(a.due).trim()) s += ` (due ${str(a.due).trim()})`;
  return s;
}

function meetingToMarkdown(meeting, { transcript = true, frontmatter = false, wikilinks = false } = {}) {
  const m = meeting || {};
  const out = [];
  const section = (title, body) => { if (body && body.trim()) out.push(`## ${title}`, '', body.trim(), ''); };
  if (frontmatter) out.push(...frontmatterLines(m), '');
  out.push(`# ${str(m.title).trim() || 'Untitled'}`, '');
  const meta = metaLine(m, { wikilinks });
  if (meta) out.push(`_${meta}_`, '');
  const ppl = people(m);
  if (ppl.length) out.push(`**People:** ${ppl.map((p) => (wikilinks ? wiki(p) : p)).join(', ')}`, '');
  section('Summary', str(m.summary));
  section('Notes', str(m.body));
  section('Action items', arr(m.actionItems).filter((a) => str(a?.text).trim()).map((a) => actionLine(a)).join('\n'));
  section('Topics', arr(m.topics).filter((t) => str(t).trim()).map((t) => `- ${wikilinks ? wiki(t) : str(t).trim()}`).join('\n'));
  section('Glossary', arr(m.glossary).filter((g) => str(g?.term).trim()).map((g) => `- **${str(g.term).trim()}**${str(g.definition).trim() ? ` — ${str(g.definition).trim()}` : ''}`).join('\n'));
  section('Links', arr(m.links).filter((l) => l?.url).map((l) => `- [${str(l.title).trim() || l.url}](${l.url})`).join('\n'));
  if (transcript) section('Transcript', arr(m.transcript).filter((t) => str(t?.text).trim()).map((t) => `**${str(t.label).trim() || 'Speaker'}** [${fmtClock(t.startMs)}] ${str(t.text).trim()}`).join('\n\n'));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Light Markdown → plain text, for email bodies and the clipboard.
function stripMarkdown(md) {
  return str(md)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`))
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, a, __, b) => b || a)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+\[( |x|X)\]\s+/gm, (s, x) => `${s.match(/^\s*/)[0]}[${x.trim() ? 'x' : ' '}] `)
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/^>\s?/gm, '');
}

function meetingToText(meeting, { transcript = true } = {}) {
  const m = meeting || {};
  const title = str(m.title).trim() || 'Untitled';
  const out = [title, '='.repeat(Math.min(title.length, 60)), ''];
  const meta = metaLine(m);
  if (meta) out.push(meta, '');
  const section = (h, body) => { if (body && body.trim()) out.push(h.toUpperCase(), body.trim(), ''); };
  section('Summary', stripMarkdown(m.summary));
  section('Notes', stripMarkdown(m.body));
  section('Action items', arr(m.actionItems).filter((a) => str(a?.text).trim()).map((a) => actionLine(a, { checkbox: false })).join('\n'));
  section('Topics', arr(m.topics).map(str).filter((t) => t.trim()).join(', '));
  section('Glossary', arr(m.glossary).filter((g) => str(g?.term).trim()).map((g) => `${str(g.term).trim()}: ${str(g.definition).trim()}`).join('\n'));
  section('Links', arr(m.links).filter((l) => l?.url).map((l) => (l.title ? `${l.title}: ${l.url}` : l.url)).join('\n'));
  if (transcript) section('Transcript', arr(m.transcript).filter((t) => str(t?.text).trim()).map((t) => `[${fmtClock(t.startMs)}] ${str(t.label).trim() || 'Speaker'}: ${str(t.text).trim()}`).join('\n'));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// 'YYYY-MM-DD Title.md', safe on Windows, macOS and Linux.
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function slugFileName(title, date, { maxLength = 120 } = {}) {
  let t = str(title).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ') // illegal on Windows (and / on everything)
    .replace(/[[\]#^]/g, ' ') // break Obsidian links
    .replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  if (!t || WIN_RESERVED.test(t)) t = t ? `${t}_` : 'Untitled';
  const d = toDate(date);
  const prefix = d ? `${ymd(d)} ` : '';
  const room = Math.max(1, maxLength - prefix.length - 3);
  if (t.length > room) t = Array.from(t).slice(0, room).join('').replace(/[.\s]+$/, '') || 'Untitled';
  return `${prefix}${t}.md`;
}

module.exports = { meetingToMarkdown, meetingToText, fmtClock, fmtDuration, yamlEscape, yamlList, slugFileName, stripMarkdown, meetingDate, meetingDuration, attendeeNames, ymd };
