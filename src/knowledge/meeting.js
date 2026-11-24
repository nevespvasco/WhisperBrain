'use strict';
// One meeting gathered into a plain object (the shape every exporter and integration consumes),
// plus file renderers: Markdown, plain text, HTML (also the source for PDF), JSON, SRT and WebVTT subtitles.
const { fmtClock } = require('../core/notes');

// lang + mode: with the translation of the meeting into `lang`, 'translation' puts it in place of the words and 'both' under them
// (a line with no translation keeps its words). Left out: the meeting as it was said.
function toMeeting({ notes, knowledge, speakers, settings, translator }, id, { transcript = true, lang, mode } = {}) {
  const n = notes.get(id);
  if (!n) return null;
  const segs = transcript ? notes.segments(id) : [];
  const said = lang && ['translation', 'both'].includes(mode) && translator ? translator.translations(id, lang) : null;
  const words = (s) => { const t = said?.get(s.id); return !t ? s.text : mode === 'both' ? `${s.text}\n${t}` : t; };
  const label = (s) => knowledge.label(s);
  const people = [...new Set(notes.segments(id).map(label))];
  return {
    id: n.id, title: n.title || 'Untitled meeting', createdAt: n.createdAt, startedAt: n.startedAt, endedAt: n.endedAt,
    durationMs: n.endedAt && n.startedAt ? n.endedAt - n.startedAt : (segs.length ? segs[segs.length - 1].endMs : 0),
    attendees: n.attendees || [], tags: knowledge.noteTags(id).map((t) => t.name), topics: knowledge.noteTopics(id).map((t) => t.name), people,
    source: n.source, platform: n.platform, summary: (said && mode === 'translation' && translator.summaryTranslation(id, lang)?.text) || n.summary || '', body: n.body || '', insights: n.insights || null,
    actionItems: knowledge.actionItems({ noteId: id }).map((a) => ({ text: a.text, owner: a.owner, due: a.due, done: a.done })),
    transcript: segs.map((s) => ({ label: label(s), startMs: s.startMs, endMs: s.endMs, text: words(s), translation: said?.get(s.id) || '' })),
    translation: said ? { lang, mode } : null,
    glossary: knowledge.termsInNote(id).map((g) => ({ term: g.term, definition: g.definition })),
    links: knowledge.links(id).map((l) => ({ kind: l.kind, url: l.url, title: l.title })),
    speakers: speakers ? knowledge.analytics(id).speakers : [],
    userName: settings?.get('userName') || '',
  };
}

let fmt = null;
const format = () => (fmt ??= require('../integrations/format'));

function toMarkdown(m, opts = {}) {
  try { return format().meetingToMarkdown(m, opts); } catch { return fallbackMarkdown(m, opts); }
}
function toText(m) {
  try { return format().meetingToText(m); } catch { return fallbackMarkdown(m, {}).replace(/[#*_`]/g, ''); }
}

function fallbackMarkdown(m, { transcript = true } = {}) {
  const out = [`# ${m.title}`, '', `_${new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ')}_`, ''];
  if (m.attendees.length) out.push(`**Attendees:** ${m.attendees.map((a) => a.name || a.email).join(', ')}`, '');
  if (m.summary) out.push('## Summary', '', m.summary, '');
  if (m.body) out.push('## Notes', '', m.body, '');
  if (m.actionItems.length) out.push('## Action items', '', ...m.actionItems.map((a) => `- [${a.done ? 'x' : ' '}] ${a.text}${a.owner ? ` — ${a.owner}` : ''}${a.due ? ` (${a.due})` : ''}`), '');
  if (m.topics.length) out.push('## Topics', '', m.topics.join(', '), '');
  if (transcript && m.transcript.length) out.push('## Transcript', '', ...m.transcript.map((s) => `**${s.label}** [${fmtClock(s.startMs)}] ${s.text}`), '');
  return out.join('\n').trimEnd() + '\n';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Minimal, safe Markdown → HTML for exports (headings, lists, checkboxes, bold/italic/code, links, paragraphs).
function mdToHtml(md) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,4})\s+(.+)/.exec(line))) { close(); const lv = Math.min(4, m[1].length + 1); out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); }
    else if ((m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul class="tasks">'); list = 'ul'; } out.push(`<li>${m[1] === ' ' ? '☐' : '☑'} ${inline(m[2])}</li>`); }
    else if ((m = /^\s*[-*]\s+(.+)/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\s*\d+[.)]\s+(.+)/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('\n');
}

function toHtml(m, { transcript = true } = {}) {
  const date = new Date(m.createdAt).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  const ins = m.insights || {};
  const sec = (title, html) => (html ? `<section><h2>${esc(title)}</h2>${html}</section>` : '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title><style>
  body{font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c1b22;max-width:780px;margin:32px auto;padding:0 24px}
  h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:#6d5dd3;margin:26px 0 8px;border-bottom:1px solid #ecebf5;padding-bottom:4px}
  h3,h4,h5{font-size:14px;margin:14px 0 4px}.meta{color:#6b6880;font-size:13px}.chip{display:inline-block;background:#f1efff;color:#5b4bc4;border-radius:99px;padding:1px 9px;margin:2px 4px 2px 0;font-size:12px}
  .seg{margin:6px 0}.seg div{white-space:pre-wrap}.who{font-weight:600}.ts{color:#8b88a0;font-size:12px;margin-left:6px}ul.tasks{list-style:none;padding-left:4px}code{background:#f4f3f8;padding:1px 4px;border-radius:4px}
  table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #ecebf5;padding:5px 6px;text-align:left}
  @media print{body{margin:0;max-width:none}a{color:inherit}}</style></head><body>
  <h1>${esc(m.title)}</h1><div class="meta">${esc(date)}${m.durationMs ? ` · ${Math.round(m.durationMs / 60000)} min` : ''}${m.attendees.length ? ` · ${esc(m.attendees.map((a) => a.name || a.email).join(', '))}` : ''}</div>
  <div>${[...m.tags.map((t) => `#${t}`), ...m.topics].map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
  ${sec('Overview', ins.overview ? `<p>${esc(ins.overview)}</p>` : '')}
  ${sec('Summary', mdToHtml(m.summary))}
  ${sec('Decisions', (ins.decisions || []).length ? `<ul>${ins.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '')}
  ${sec('Action items', m.actionItems.length ? `<ul class="tasks">${m.actionItems.map((a) => `<li>${a.done ? '☑' : '☐'} ${esc(a.text)}${a.owner ? ` — <strong>${esc(a.owner)}</strong>` : ''}${a.due ? ` <span class="meta">(${esc(a.due)})</span>` : ''}</li>`).join('')}</ul>` : '')}
  ${sec('My notes', mdToHtml(m.body))}
  ${sec('Speakers', m.speakers.length > 1 ? `<table><tr><th>Speaker</th><th>Talk time</th><th>Talk %</th><th>WPM</th></tr>${m.speakers.map((s) => `<tr><td>${esc(s.label)}</td><td>${fmtClock(s.talkMs)}</td><td>${s.talkPct}%</td><td>${s.wpm || '—'}</td></tr>`).join('')}</table>` : '')}
  ${sec('Glossary', m.glossary.length ? `<ul>${m.glossary.map((g) => `<li><strong>${esc(g.term)}</strong> — ${esc(g.definition)}</li>`).join('')}</ul>` : '')}
  ${transcript ? sec('Transcript', m.transcript.map((s) => `<div class="seg"><span class="who">${esc(s.label)}</span><span class="ts">${fmtClock(s.startMs)}</span><div>${esc(s.text)}</div></div>`).join('')) : ''}
  </body></html>`;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(ms, sep) { const h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${pad(h)}:${pad(mi)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`; }
function toSrt(m) { return m.transcript.map((s, i) => `${i + 1}\n${stamp(s.startMs, ',')} --> ${stamp(Math.max(s.endMs, s.startMs + 500), ',')}\n${s.label}: ${s.text}\n`).join('\n'); }
function toVtt(m) { return `WEBVTT\n\n${m.transcript.map((s) => `${stamp(s.startMs, '.')} --> ${stamp(Math.max(s.endMs, s.startMs + 500), '.')}\n<v ${s.label.replace(/[<>]/g, '')}>${s.text}\n`).join('\n')}`; }
function toJson(m) { const { speakers, userName, ...rest } = m; return JSON.stringify({ app: 'whisperbrain', format: 2, meeting: { ...rest, speakers } }, null, 2); }

const FORMATS = {
  md: { ext: 'md', type: 'text/markdown; charset=utf-8', render: (m, o) => toMarkdown(m, o) },
  obsidian: { ext: 'md', type: 'text/markdown; charset=utf-8', render: (m, o) => toMarkdown(m, { ...o, frontmatter: true, wikilinks: true }) },
  txt: { ext: 'txt', type: 'text/plain; charset=utf-8', render: (m) => toText(m) },
  html: { ext: 'html', type: 'text/html; charset=utf-8', render: (m, o) => toHtml(m, o) },
  json: { ext: 'json', type: 'application/json', render: (m) => toJson(m) },
  srt: { ext: 'srt', type: 'application/x-subrip; charset=utf-8', render: (m) => toSrt(m) },
  vtt: { ext: 'vtt', type: 'text/vtt; charset=utf-8', render: (m) => toVtt(m) },
};

function fileName(m, ext) {
  const day = new Date(m.createdAt).toISOString().slice(0, 10);
  const base = String(m.title || 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
  return `${day} ${base}.${ext}`;
}

module.exports = { toMeeting, toMarkdown, toText, toHtml, toSrt, toVtt, toJson, mdToHtml, FORMATS, fileName, esc };
