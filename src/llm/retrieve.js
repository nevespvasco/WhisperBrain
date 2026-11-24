'use strict';
// Lightweight lexical retrieval over transcript text, for questions about a long meeting.
const { words } = require('../core/text');

// Split transcript lines into windows of ~size chars, keeping order.
function windows(lines, size = 1200) {
  const out = [];
  let cur = [], len = 0, start = 0;
  lines.forEach((line, i) => {
    if (len + line.length > size && cur.length) { out.push({ idx: out.length, from: start, text: cur.join('\n') }); cur = []; len = 0; start = i; }
    cur.push(line); len += line.length + 1;
  });
  if (cur.length) out.push({ idx: out.length, from: start, text: cur.join('\n') });
  return out;
}

function rank(query, wins) {
  const q = words(query);
  if (!q.length) return wins.map((w) => ({ ...w, score: 0 }));
  const df = new Map();
  const toks = wins.map((w) => new Set(words(w.text)));
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  return wins.map((w, i) => {
    let score = 0;
    for (const term of new Set(q)) {
      if (toks[i].has(term)) score += Math.log(1 + wins.length / df.get(term));
    }
    return { ...w, score };
  });
}

// Pick the best windows within a char budget, returned in chronological order.
function pick(query, lines, budget, size = 1200) {
  const wins = rank(query, windows(lines, size));
  const ordered = [...wins].sort((a, b) => b.score - a.score || a.idx - b.idx);
  const chosen = [];
  let used = 0;
  for (const w of ordered) {
    if (used + w.text.length > budget && chosen.length) continue;
    chosen.push(w); used += w.text.length;
    if (used >= budget) break;
  }
  return chosen.sort((a, b) => a.idx - b.idx);
}

module.exports = { words, windows, rank, pick };
