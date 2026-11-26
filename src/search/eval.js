'use strict';
// Does search find the right things? A set of questions with the titles that should come back, measured as recall@k and MRR.
// Made for the person's own Portuguese and English notes: the set is written by hand from their data (see scripts/retrieval-eval.js),
// and the same questions are asked again after any change to chunking or to the embedding model.

// cases: [{ q, expect: ['part of a title', ...] }]. search(q) -> hits with { title }, best first.
async function evaluate(cases, search, { k = 5 } = {}) {
  let recall = 0, rr = 0;
  const rows = [];
  for (const c of cases) {
    const hits = await search(c.q);
    const titles = hits.map((h) => String(h.title || '').toLowerCase());
    const want = c.expect.map((e) => e.toLowerCase());
    const rank = (w) => titles.findIndex((t) => t.includes(w));
    const found = want.filter((w) => { const r = rank(w); return r >= 0 && r < k; });
    const first = Math.min(...want.map(rank).filter((r) => r >= 0), Infinity);
    recall += found.length / want.length;
    rr += first === Infinity ? 0 : 1 / (first + 1);
    rows.push({ q: c.q, found: found.length, wanted: want.length, firstRank: first === Infinity ? null : first + 1 });
  }
  const n = cases.length || 1;
  return { k, cases: cases.length, recallAtK: Math.round((recall / n) * 1000) / 1000, mrr: Math.round((rr / n) * 1000) / 1000, rows };
}

module.exports = { evaluate };
