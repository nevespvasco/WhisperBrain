'use strict';
// What the AI is shown with a question from the call: the parts of the user's briefings that bear on it, what was just said,
// the earlier questions and the help given, facts the user already stated about themselves, and the glossary terms that come
// up. Everything fits one character budget (small local models have small windows): when it is short, the user's facts go first,
// then the oldest earlier answers, then the oldest lines of what was said, and the briefing is cut last.
const crypto = require('node:crypto');
const { pick } = require('../llm/retrieve');
const { neutralizeTags } = require('../llm/prompts');

const RECENT_LINES = 12;
const HISTORY_PAIRS = 3;
const BRIEF_SHARE = 0.7;      // the briefing may take this share of the budget before anything else is dropped for it
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clean = (s) => neutralizeTags(String(s ?? '').replace(/\s+/g, ' ').trim());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A line the user said that states something about them: a number, or a name past the first word ("…at Acme").
const isFact = (s) => /\p{N}/u.test(s) || /\s\p{Lu}[\p{L}\p{N}]+/u.test(s);
const mentions = (hay, term) => term && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(hay);

// briefings: [{ title, kind, text }], tail: [{ speaker: 'me'|'them', label?, text }], history: [{ question, answer }],
// meSaid: [text], glossary: [{ term, definition, aliases? }] -> { text, key, sections }
function buildContext({ question, briefings = [], tail = [], history = [], meSaid = [], glossary = [], budget = 6000 } = {}) {
  let recent = tail.slice(-RECENT_LINES).filter((l) => String(l.text ?? '').trim()).map((l) => `${l.speaker === 'me' ? 'Me' : clean(l.label) || 'Them'}: ${clip(clean(l.text), 400)}`);
  let hist = history.slice(-HISTORY_PAIRS).map((h) => `Q: ${clip(clean(h.question), 300)}\nA: ${clip(clean(h.answer), 500)}`);
  let facts = [...new Set(meSaid.map(clean).filter(isFact))].slice(-8).map((f) => `- ${clip(f, 240)}`);
  const paragraphs = briefings.flatMap((b) => String(b.text ?? '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean).map((p) => `[${clean(b.title) || 'briefing'}${b.kind ? ` · ${b.kind}` : ''}] ${clean(p)}`));
  const briefTotal = paragraphs.reduce((n, p) => n + p.length + 1, 0);
  const query = [question, ...tail.slice(-4).map((l) => l.text)].join(' ');

  const glossaryFor = (hay) => glossary.filter((g) => [g.term, ...(g.aliases || [])].some((t) => mentions(hay, String(t || '')))).slice(0, 8).map((g) => `- ${clean(g.term)}: ${clip(clean(g.definition), 200)}`);
  const render = (excerpt, gloss) => {
    const parts = [];
    if (excerpt) parts.push(`### From the user's briefing\n${excerpt}`);
    if (recent.length) parts.push(`### Said just now\n${recent.join('\n')}`);
    if (hist.length) parts.push(`### Earlier questions and the help given\n${hist.join('\n')}`);
    if (facts.length) parts.push(`### What the user has already said about themselves\n${facts.join('\n')}`);
    if (gloss.length) parts.push(`### Terms\n${gloss.join('\n')}`);
    return parts.join('\n\n');
  };

  // Make room for the briefing: drop facts, then the oldest earlier answers, then the oldest lines said.
  const want = Math.min(briefTotal, Math.floor(budget * BRIEF_SHARE));
  const room = () => budget - render('', glossaryFor(query.toLowerCase())).length;
  while (want > 0 && room() < want) {
    if (facts.length) facts = [];
    else if (hist.length) hist = hist.slice(1);
    else if (recent.length > 2) recent = recent.slice(1);
    else break;
  }
  const excerpt = paragraphs.length ? pick(query, paragraphs, Math.max(200, room()), 700).map((w) => w.text).join('\n') : '';
  const gloss = glossaryFor(`${query} ${excerpt}`.toLowerCase());
  const text = render(excerpt, gloss);
  const sections = [excerpt && 'briefing', recent.length && 'recent', hist.length && 'history', facts.length && 'facts', gloss.length && 'glossary'].filter(Boolean);
  const key = crypto.createHash('sha1').update(`${question}\n${text}`).digest('hex').slice(0, 16);
  return { text, key, sections };
}

module.exports = { buildContext, isFact };
