'use strict';
// Technical term cards (#21): spot terms in the other side's final transcript lines. Glossary terms carry their
// stored definition (no AI call); unknown technical-looking tokens are explained by the AI in one sentence.
// Pure: the caller feeds lines, asks the AI, caches the answer in the glossary and emits `assistant.term`.
const { neutralizeTags, UNTRUSTED } = require('../llm/prompts');
const { languageName } = require('../llm/languages');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word boundaries that know about accents: a letter, digit or underscore on either side means "inside a word".
const wholeWord = (alts) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');

// A token starts and ends with a letter or digit and may hold dots and apostrophes inside ("Node.js", "API's").
const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{N}.'’]*[\p{L}\p{N}])?/gu;

// Is this token worth explaining? Returns the term to show (plural "s" and possessive "'s" dropped) or null.
function technical(token) {
  const t = token.replace(/['’]s$/i, '');
  if (/^[A-Z]{2,6}s?$/.test(t)) return t.replace(/s$/, ''); // SLA, OKR, APIs
  if (/['’]/.test(t)) return null;
  if (t.includes('.')) {
    // Node.js, ASP.NET: starts with a letter, one capital at least, a segment of two letters or more (not "U.S").
    const parts = t.split('.');
    if (!/^\p{L}/u.test(t) || !/\p{Lu}/u.test(t) || !parts.some((p) => p.length >= 2)) return null;
    return t;
  }
  if (/\p{Ll}\p{Lu}/u.test(t)) return t; // gRPC, PostgreSQL, GraphQL, useEffect
  if (/^\p{L}/u.test(t) && /\p{N}/u.test(t)) return t; // S3, OAuth2, k8s (but not 3pm or 2nd)
  return null;
}

// Tokens that look technical but that everyone in a meeting already knows: a card for them is noise. Compared
// case-insensitively. Glossary entries always win over this list.
const COMMON_WORDS = Object.freeze([
  // everyday English acronyms and abbreviations
  'OK', 'OKAY', 'AM', 'PM', 'TV', 'PC', 'ID', 'US', 'USA', 'UK', 'EU', 'UN', 'CEO', 'CFO', 'CTO', 'COO', 'HR', 'IT',
  'FYI', 'ASAP', 'PS', 'FAQ', 'PDF', 'SMS', 'GPS', 'USB', 'ATM', 'VIP', 'DIY', 'BTW', 'LOL', 'OMG', 'TBD', 'ETA',
  'WiFi', 'PhD', 'MBA',
  // interjections that speech recognition sometimes writes in capitals
  'UM', 'UH', 'OH', 'AH', 'HM', 'HMM', 'MM',
  // business calendar
  'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2',
  // pt-PT
  'EUA', 'UE', 'PT', 'SA', 'LDA', 'IVA', 'NIF', 'IRS', 'RH', 'TI', 'CV', 'SNS', 'CTT', 'GNR', 'PSP', 'ONU', 'PME',
  // household brands
  'YouTube', 'LinkedIn', 'WhatsApp', 'PowerPoint', 'iPhone', 'iPad', 'MacBook', 'FaceTime', 'TikTok', 'PayPal', 'eBay', 'iCloud', 'McDonald',
]);
const COMMON = new Set(COMMON_WORDS.map((w) => w.toLowerCase()));
// Roman numerals made of I, V and X only (século XXI, Henrique VIII, Fase II); CI, CD, MD and the like stay technical.
const ROMAN = /^X{0,3}(?:IX|IV|V?I{0,3})$/;

const explainSystem = (language) => `You explain technical terms heard in a meeting to someone listening in.
Rules:
- Reply with ONE plain sentence of at most 30 words, in ${language ? languageName(language) : 'the language of the transcript line'}, saying what the term means as it is used in the line.
- No preface, no Markdown, no quotes, no list. Do not repeat the line.
- If the term is a name you do not know, say briefly what it most likely is from the line; never invent details.
- ${UNTRUSTED}`;

class TermSpotter {
  constructor({ glossary, now = Date.now, minGapMs = 30000, maxPerMeeting = 20, commonWords = [] } = {}) {
    this.glossary = glossary || (() => []);
    this.now = now;
    this.minGapMs = minGapMs;
    this.maxPerMeeting = maxPerMeeting;
    this.reset();
    this.common = new Set([...COMMON, ...[...(commonWords || [])].map((w) => String(w).toLowerCase())]);
  }

  // A new meeting: every term may be shown again, no gap to wait for, a fresh cap.
  reset() {
    this.shown = new Set();
    this.lastAt = null;
  }

  // Candidate terms in one line, in order of appearance: [{ term, known: { definition } | null }].
  spot(text) {
    const line = String(text ?? '').normalize('NFC');
    const found = [];
    const spans = [];
    for (const entry of this.glossary() || []) {
      if (!entry || typeof entry.term !== 'string' || !entry.term.trim()) continue;
      const names = [entry.term, ...(entry.aliases || [])].filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().normalize('NFC'));
      if (!names.length) continue;
      const re = wholeWord(names);
      let first = null;
      for (const m of line.matchAll(re)) {
        first ??= m.index;
        spans.push([m.index, m.index + m[0].length]);
      }
      const definition = typeof entry.definition === 'string' ? entry.definition.trim() : '';
      if (first !== null) found.push({ at: first, term: entry.term, known: definition ? { definition } : null });
    }
    const seen = new Set(found.map((f) => f.term.toLowerCase()));
    for (const m of line.matchAll(TOKEN)) {
      const [from, to] = [m.index, m.index + m[0].length];
      if (spans.some(([a, b]) => from < b && a < to)) continue; // already a glossary hit
      const term = technical(m[0]);
      if (!term || seen.has(term.toLowerCase()) || this.common.has(term.toLowerCase()) || ROMAN.test(term)) continue;
      seen.add(term.toLowerCase());
      found.push({ at: from, term, known: null });
    }
    return found.sort((a, b) => a.at - b.at).map(({ term, known }) => ({ term, known }));
  }

  // At most one card for this line: { term, definition | null, needsAi }, or null. A stored definition wins over
  // an unknown term, so the cheap card goes first.
  next(text) {
    if (this.shown.size >= this.maxPerMeeting) return null;
    const t = this.now();
    if (this.lastAt !== null && t - this.lastAt < this.minGapMs) return null;
    const candidates = this.spot(text).filter((c) => !this.shown.has(c.term.toLowerCase()));
    const pick = candidates.find((c) => c.known) || candidates[0];
    if (!pick) return null;
    this.shown.add(pick.term.toLowerCase());
    this.lastAt = t;
    return { term: pick.term, definition: pick.known ? pick.known.definition : null, needsAi: !pick.known };
  }

  // The AI request for an unknown term. The term and the line are what somebody said: both stay in the user message,
  // the line wrapped in <transcript> with our tags defused, and the system message says it is data.
  explainMessages({ term, line, language }) {
    const one = (s) => neutralizeTags(String(s ?? '').replace(/\s+/g, ' ').trim());
    return [
      { role: 'system', content: explainSystem(language) },
      { role: 'user', content: `Term: ${one(term)}\n\n<transcript>\n${one(line)}\n</transcript>` },
    ];
  }
}

module.exports = { TermSpotter, COMMON_WORDS };
