'use strict';
// Structured insights for one meeting: overview, key points, decisions, action items, next steps, topics and
// glossary terms. The model is asked for JSON; parsing is tolerant, and there is an offline fallback.
const { meetingHeader, neutralizeTags, UNTRUSTED } = require('./prompts');

const INSIGHTS_SYSTEM = `You analyse a meeting and return ONLY a JSON object, no prose, no code fences.
Schema:
{
  "overview": "2-3 sentences: what the meeting was about and its outcome",
  "keyPoints": [{ "title": "short theme", "bullets": ["fact", "..."] }],
  "decisions": ["decision", "..."],
  "actionItems": [{ "text": "task, imperative", "owner": "person or empty", "due": "YYYY-MM-DD or empty" }],
  "nextSteps": ["..."],
  "topics": [{ "name": "2-4 word noun phrase", "summary": "one sentence: what was said about it and by whom", "weight": 0.1-1 }],
  "glossary": [{ "term": "acronym, product name or jargon", "definition": "plain-language meaning as used here" }]
}
Rules:
- Use only facts from the notes and transcript. Never invent names, dates or numbers. Empty arrays are fine.
- 2-4 keyPoints groups, at most 6 topics, at most 8 glossary terms (only terms a newcomer would not know).
- Topics are subjects, not people. When a subject matches one of the EXISTING TOPICS, reuse that exact name so meetings connect.
- Glossary: when a term is in EXISTING TERMS, reuse its spelling; define it only from context.
- Write values in the language the meeting was held in.
- Action items are copied into other tools: plain text only, no links and no markup.
- ${UNTRUSTED}`;

function insightsMessages({ note, transcript, existingTopics = [], existingTerms = [], userName = '' }) {
  const user = [
    meetingHeader(note),
    userName ? `The user is ${userName} ("Me").` : '',
    existingTopics.length ? `EXISTING TOPICS: ${existingTopics.slice(0, 80).join('; ')}` : '',
    existingTerms.length ? `EXISTING TERMS: ${existingTerms.slice(0, 80).join('; ')}` : '',
    '',
    note.summary ? `<enhanced_notes>\n${neutralizeTags(note.summary)}\n</enhanced_notes>` : '',
    `<user_notes>\n${neutralizeTags(note.body.trim() || '(none)')}\n</user_notes>`,
    `<transcript>\n${neutralizeTags(transcript || '(no transcript)')}\n</transcript>`,
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: INSIGHTS_SYSTEM }, { role: 'user', content: user }];
}

// Pull the first balanced JSON object out of a model reply (handles code fences and chatter around it).
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const raw = s.slice(start, i + 1);
      try { return JSON.parse(raw); } catch { try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch { return null; } }
    }
  }
  return null;
}

const str = (v, n = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
// Action items leave the app (Notion, Linear, webhooks), so what a model wrote, possibly steered by the transcript, is
// reduced to plain words first: no markup, no links (they could carry data out or lure a click), bounded length.
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|javascript:|data:|vbscript:|www\.)[^\s)>\]]*/gi;
function plain(v, n = 300) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/<[^>]*>/g, ' ').replace(URL_LIKE, ' ').replace(/!?\[([^\]]*)\]\(\s*\)/g, '$1').replace(/[*`~]+/g, '').replace(/^[\s#>]+/, '')
    .replace(/\s+/g, ' ').trim().slice(0, n).trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}
const arr = (v) => (Array.isArray(v) ? v : []);

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    overview: str(raw.overview, 1200),
    keyPoints: arr(raw.keyPoints).map((k) => ({ title: str(k?.title, 80), bullets: arr(k?.bullets).map((b) => str(b)).filter(Boolean).slice(0, 8) })).filter((k) => k.title || k.bullets.length).slice(0, 6),
    decisions: arr(raw.decisions).map((d) => str(d)).filter(Boolean).slice(0, 12),
    actionItems: arr(raw.actionItems).map((a) => (typeof a === 'string' ? { text: plain(a), owner: '', due: '' } : { text: plain(a?.text), owner: plain(a?.owner, 80), due: /^\d{4}-\d{2}-\d{2}$/.test(a?.due || '') ? a.due : '' })).filter((a) => a.text).slice(0, 25),
    nextSteps: arr(raw.nextSteps).map((d) => str(d)).filter(Boolean).slice(0, 12),
    topics: arr(raw.topics).map((t) => (typeof t === 'string' ? { name: str(t, 80), summary: '', weight: 1 } : { name: str(t?.name, 80), summary: str(t?.summary, 600), weight: Math.max(0.1, Math.min(1, Number(t?.weight) || 0.7)) })).filter((t) => t.name).slice(0, 8),
    glossary: arr(raw.glossary).map((g) => ({ term: str(g?.term, 80), definition: str(g?.definition, 600) })).filter((g) => g.term && g.definition).slice(0, 12),
  };
}

function parseInsights(text) { return sanitize(extractJson(text)); }

// Checklist lines in Markdown ("- [ ] Ana: send the deck (Friday)") → action items.
function parseChecklist(md) {
  const out = [];
  for (const line of String(md || '').split('\n')) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (!m) continue;
    let text = m[2].replace(/\*\*/g, '').trim(), owner = '';
    const om = /^([\p{L}][\p{L} .'-]{0,40}?):\s+(.+)$/u.exec(text) || /^(.+?)\s+[—–-]\s+@?([\p{L}][\p{L} .'-]{0,40})$/u.exec(text);
    if (om) { if (text.indexOf(om[1]) === 0 && text[om[1].length] === ':') { owner = om[1]; text = om[2]; } else { text = om[1]; owner = om[2]; } }
    const at = /@([\p{L}][\p{L}.-]+)/u.exec(text);
    if (!owner && at) owner = at[1];
    out.push({ text: text.slice(0, 500), owner: owner.trim(), due: '', done: m[1].toLowerCase() === 'x' });
  }
  return out;
}

// Without an LLM: overview from the enhanced notes, action items from their checklist, sections as key points.
function localInsights(note) {
  const md = note.summary || '';
  const sections = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const h = /^#{2,3}\s+(.+)/.exec(line);
    if (h) { cur = { title: h[1].trim(), bullets: [] }; sections.push(cur); continue; }
    const b = /^\s*[-*]\s+(?!\[)(.+)/.exec(line);
    if (b && cur) cur.bullets.push(b[1].replace(/\*\*/g, '').trim());
  }
  const first = md.split('\n').find((l) => l.trim() && !/^#|^\s*[-*]/.test(l)) || '';
  const decisions = sections.find((s) => /decis|decid/i.test(s.title))?.bullets || [];
  return {
    overview: first.replace(/\*\*/g, '').trim().slice(0, 1200),
    keyPoints: sections.filter((s) => s.bullets.length && !/action|decis|ação|ações|next|seguinte/i.test(s.title)).slice(0, 4),
    decisions, actionItems: parseChecklist(md).map(({ done, ...a }) => ({ ...a, text: plain(a.text), owner: plain(a.owner, 80) })).filter((a) => a.text), nextSteps: [], topics: [], glossary: [], local: true,
  };
}

function topicBriefMessages({ topic, items }) {
  return [
    { role: 'system', content: 'You synthesise what a team has said about one topic across several meetings. Use only the provided material. Output Markdown: a 2-sentence summary, "## How it evolved" (chronological bullets with meeting dates), "## Who said what" (bullets attributing positions to people), "## Open questions". Same language as the material. No preamble.' },
    { role: 'user', content: `Topic: ${topic.name}\n\n${items}` },
  ];
}

module.exports = { INSIGHTS_SYSTEM, insightsMessages, extractJson, parseInsights, sanitize, parseChecklist, localInsights, topicBriefMessages };
