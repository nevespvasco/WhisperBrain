'use strict';
// Contextual biasing ("hotwords") for the NeMo transducer models. The recognizer wants each phrase as a sequence of
// pieces from tokens.txt, not as plain words, so terms are split into the model's SentencePiece pieces here.
// Pure functions: the worker applies the result per stream, the recording builds the term list per meeting.
const fs = require('node:fs');

const WORD_MARK = '▁'; // "▁", the SentencePiece word-start marker
const MAX_TERMS = 50;       // a short, meeting-specific list: gains shrink as unrelated words are added
const MAX_TERM_CHARS = 60;
const DEFAULT_SCORE = 1.5;

// Piece set of a tokens.txt ("piece id" per line; the piece itself may contain no spaces).
function loadVocab(tokensPath) {
  const pieces = new Set();
  for (const line of fs.readFileSync(tokensPath, 'utf8').split('\n')) {
    const i = line.lastIndexOf(' ');
    if (i > 0) pieces.add(line.slice(0, i));
  }
  return pieces;
}

// One word as pieces: greedy longest match on "▁word", then on what is left. When a longest match leaves an
// unmatchable remainder it backs off to a shorter one, so a segmentation is found whenever one exists. null if none.
function piecesOf(word, vocab) {
  const chars = [...word];
  const memo = new Map();
  const from = (i, first) => {
    if (i === chars.length) return [];
    const key = i;
    if (memo.has(key)) return memo.get(key);
    let found = null;
    for (let j = chars.length; j > i && !found; j--) {
      const piece = (first ? WORD_MARK : '') + chars.slice(i, j).join('');
      if (!vocab.has(piece)) continue;
      const rest = from(j, false);
      if (rest) found = [piece, ...rest];
    }
    memo.set(key, found);
    return found;
  };
  return from(0, true);
}

// A term (one or more words) as space-separated pieces, or null if some word cannot be spelled with the vocabulary.
function tokenizeTerm(term, vocab) {
  const words = String(term || '').normalize('NFC').split(/[\s/]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  if (!words.length) return null;
  const out = [];
  for (const w of words) {
    const p = piecesOf(w, vocab);
    if (!p) return null;
    out.push(...p);
  }
  return out.join(' ');
}

// Clean and rank raw terms: trimmed, deduplicated case-insensitively (first spelling wins), very short or very long
// ones dropped, earlier sources first, at most `max`.
function normalizeTerms(terms, max = MAX_TERMS) {
  const seen = new Set();
  const out = [];
  for (const raw of terms || []) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > MAX_TERM_CHARS || !/\p{L}/u.test(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// What the recognizer takes as a stream's hotwords: terms joined by "/", each already in pieces. '' when nothing
// can be spelled, which means "no biasing". `score` is the per-phrase boost.
function hotwordsString(terms, vocab, { score = DEFAULT_SCORE, max = MAX_TERMS } = {}) {
  const phrases = [];
  for (const t of normalizeTerms(terms, max)) {
    const p = tokenizeTerm(t, vocab);
    if (p && !phrases.includes(p)) phrases.push(p);
  }
  return phrases.map((p) => `${p} :${score}`).join('/');
}

// Terms for one meeting, most useful first: attendees, the glossary the notes already extracted, saved speaker names.
// A person contributes the full name, and each name part too when it is long enough to be a distinctive word.
function meetingTerms({ attendees = [], glossary = [], speakerNames = [], userName = '' } = {}) {
  const people = [];
  for (const p of [...attendees, ...speakerNames, userName]) {
    const name = typeof p === 'string' ? p : p?.name || '';
    const label = String(name).includes('@') ? '' : String(name).trim(); // an address is not something anyone says
    if (!label) continue;
    people.push(label);
    const parts = label.split(/\s+/);
    if (parts.length > 1) for (const part of parts) if (part.length >= 4) people.push(part);
  }
  return normalizeTerms([...people, ...glossary.map((g) => (typeof g === 'string' ? g : g?.term || g?.name || ''))]);
}

module.exports = { loadVocab, piecesOf, tokenizeTerm, normalizeTerms, hotwordsString, meetingTerms, MAX_TERMS, DEFAULT_SCORE, WORD_MARK };
