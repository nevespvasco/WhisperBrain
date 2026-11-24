'use strict';
// Cuts a streamed answer into numbered sentences as it arrives, so the UI can show each one when it is complete and mark the ones
// the AI flagged with [GAP] (not covered by the user's material). A sentence ends at . ! ? … followed by a space, or at a line
// break; "3.5", "e.g." and list numbers ("1. ") do not end one. Bullets ("- x") are sentences of their own.
const GAP = '[GAP]';
const ABBR = new Set(['e.g', 'i.e', 'etc', 'vs', 'dr', 'mr', 'mrs', 'ms', 'sr', 'sra', 'srs', 'dra', 'p.ex', 'ex', 'approx', 'cf', 'fig', 'jr', 'st', 'no', 'nº', 'n.º']);
const BULLET = /^(?:[-*•]|\d{1,2}[.)])\s+/;

// The longest end of `s` that could be the start of "[GAP]" being written (not shown until it is known).
function partialGap(s) {
  for (let n = Math.min(GAP.length - 1, s.length); n > 0; n--) if (s.endsWith(GAP.slice(0, n))) return n;
  return 0;
}

function shape(raw, index) {
  let text = raw.trim();
  let bullet = false, gap = false;
  if (BULLET.test(text)) { text = text.replace(BULLET, ''); bullet = true; }
  if (text.startsWith(GAP)) { text = text.slice(GAP.length).trim(); gap = true; }
  if (!text) return null;
  return { index, text, ...(gap ? { gap } : {}), ...(bullet ? { bullet } : {}) };
}

class Splitter {
  constructor() { this.buf = ''; this.index = 0; }

  // Where the first sentence in the buffer ends (index of its last character), or -1.
  boundary() {
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === '\n') return i;
      if (!'.!?…'.includes(c)) continue;
      const next = b[i + 1];
      if (next === undefined || !/\s/.test(next)) continue;
      if (c === '.') {
        const lineStart = b.lastIndexOf('\n', i) + 1;
        const before = b.slice(lineStart, i).trim();
        const token = (/([\p{L}\p{N}.º]+)$/u.exec(before)?.[1] || '').toLowerCase();
        if (ABBR.has(token)) continue;
        if (/^\d{1,2}$/.test(before)) continue;   // "1. " starts a numbered item
      }
      return i;
    }
    return -1;
  }

  drain() {
    const out = [];
    for (let i = this.boundary(); i >= 0; i = this.boundary()) {
      const cut = this.buf[i] === '\n' ? i : i + 1;
      const s = shape(this.buf.slice(0, cut), this.index);
      this.buf = this.buf.slice(cut + (this.buf[i] === '\n' ? 1 : 0));
      if (s) { out.push(s); this.index++; }
    }
    return out;
  }

  push(text) { this.buf += String(text ?? ''); return this.drain(); }

  flush() {
    const s = shape(this.buf, this.index);
    this.buf = '';
    if (!s) return [];
    this.index++;
    return [s];
  }

  // The sentence being written, as far as it can be shown: { index, text, gap?, bullet? }
  open() {
    let raw = this.buf.trimStart();
    raw = raw.slice(0, raw.length - partialGap(raw));
    return shape(raw, this.index) || { index: this.index, text: '' };
  }
}

module.exports = { Splitter, GAP };
