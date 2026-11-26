'use strict';
// "Did this decision replace an earlier one?" Found by comparing the words of the decisions you accepted: a later decision that shares most of
// its words with an earlier one about the same thing is offered as a replacement, for a person to confirm. Nothing is changed by itself and no
// AI is asked: two decisions that look alike are only a question. "Not related" is remembered. The earlier decision is never deleted: it stays,
// marked superseded, with the way back to the one that replaced it.
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set('a an and are as at be but by do does for from had has have in is it its of on or that the their this to was we were will with o os as um uma de do da dos das em no na nos nas por para com que e é foi ser são se mas ao aos'.split(' '));
const words = (s) => new Set((fold(s).match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s|ar|er|ir|ou)$/, '')));
const MIN_SHARED = 3, MIN_JACCARD = 0.5;

class Supersession {
  constructor({ db, assertions }) { Object.assign(this, { db, assertions }); }

  key(oldId, newId) { return `supersede:no:${oldId}:${newId}`; }

  candidates(limit = 5) {
    const decisions = this.assertions.list({ state: 'accepted', kind: 'decision', limit: 300 });   // newest first
    const out = [];
    for (let i = 0; i < decisions.length && out.length < limit; i++) {
      const d = decisions[i], dw = words(d.text);
      if (dw.size < MIN_SHARED) continue;
      for (const e of decisions.slice(i + 1)) {
        if (e.occurredAt >= d.occurredAt || e.supersedes === d.id || d.supersedes === e.id) continue;
        const ew = words(e.text);
        const shared = [...dw].filter((w) => ew.has(w));
        const jac = shared.length / new Set([...dw, ...ew]).size;
        if (shared.length < MIN_SHARED || jac < MIN_JACCARD) continue;
        if (this.db.prepare('SELECT 1 FROM index_meta WHERE key = ?').get(this.key(e.id, d.id))) continue;
        out.push({ older: e, newer: d, shared: shared.slice(0, 6), score: Math.round(jac * 100) / 100 });
        break;                                            // one older decision per newer one: the closest first (newest of the older ones)
      }
    }
    return out;
  }

  confirm(oldId, newId) { return this.assertions.supersede(oldId, newId); }
  reject(oldId, newId) { this.db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)').run(this.key(oldId, newId), '1'); return { ok: true }; }
}

module.exports = { Supersession, words };
