// A transcript line with its glossary terms (a dotted underline, the definition as a tooltip) and the search hits marked.
// Everything is found on the plain text and escaped piece by piece: running term regexes over HTML already written put a term
// found inside another term's title="…" in the middle of that attribute. One combined regex per glossary list, cached.
import { esc } from './md.js';

const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cache = new WeakMap();

// glossary: [{ term, definition, aliases }] → { re, defs } (null when nothing to mark). The longest term wins where two overlap.
export function termMatcher(glossary) {
  if (!Array.isArray(glossary)) return null;
  if (cache.has(glossary)) return cache.get(glossary);
  const defs = new Map();
  for (const g of glossary) for (const w of [g.term, ...(g.aliases || [])]) if (w && w.length > 1 && !defs.has(w.toLowerCase())) defs.set(w.toLowerCase(), g.definition || '');
  const words = [...defs.keys()].sort((a, b) => b.length - a.length);
  const m = words.length ? { re: new RegExp(`(^|[^\\p{L}\\p{N}])(${words.map(quote).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu'), defs } : null;
  cache.set(glossary, m);
  return m;
}

// q: what the transcript search box holds (plain text, any case). The last one's regex is kept: a search runs it over every line.
let lastQ = '', lastRe = null;
function marked(text, q) {
  if (!q) return esc(text);
  if (q !== lastQ) { lastQ = q; lastRe = new RegExp(quote(q), 'giu'); }
  let out = '', at = 0;
  for (const hit of text.matchAll(lastRe)) { out += `${esc(text.slice(at, hit.index))}<mark>${esc(hit[0])}</mark>`; at = hit.index + hit[0].length; }
  return out + esc(text.slice(at));
}

export function highlight(text, glossary, q = '') {
  const s = String(text ?? ''), m = termMatcher(glossary);
  if (!m) return marked(s, q);
  let out = '', at = 0;
  m.re.lastIndex = 0;
  for (const hit of s.matchAll(m.re)) {
    const start = hit.index + hit[1].length, word = hit[2];
    out += marked(s.slice(at, start), q) + `<span class="term" title="${esc(m.defs.get(word.toLowerCase()) ?? '')}">${marked(word, q)}</span>`;
    at = start + word.length;
  }
  return out + marked(s.slice(at), q);
}
