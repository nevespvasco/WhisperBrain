// Follow the reader by voice. The teleprompter knows the suggestion's words; the microphone's live transcript (speaker 'me')
// says what the user is saying. Each time a line grows, its last few words are aligned with the next stretch of the suggestion
// and the reading position moves to the end of the best match. Pure, so it is unit-tested.
//
// It only ever moves forward by itself (a word said again must not throw the reader back), it tolerates skipped words, small
// changes of wording and recognition mistakes, and it ignores talk that matches nothing (an aside, an answer in other words).

// Lower-case words without accents or punctuation: "Já fiz 3,5 anos." -> ['ja', 'fiz', '3', '5', 'anos']
export function words(text) {
  return String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const SHORT = new Set(['a', 'o', 'e', 'de', 'do', 'da', 'em', 'um', 'the', 'an', 'and', 'of', 'to', 'in', 'is', 'it', 'i', 'que', 'se', 'na', 'no', 'os', 'as']);

export class ReadingTracker {
  // tail: how many of the last spoken words are matched. ahead: how far past the reading position a match may land (words).
  // minMatch: how many words must line up in order before the position moves.
  constructor({ tail = 6, ahead = 25, minMatch = 2 } = {}) {
    Object.assign(this, { tail, ahead, minMatch });
    this.tokens = [];       // [{ w, sentence }]
    this.starts = [];       // sentence index -> its first token
    this.pos = 0;           // the next word to read
  }

  // sentences: the suggestion's sentences in order (they grow while it is written; the position is kept).
  setSentences(sentences) {
    this.tokens = [];
    this.starts = [];
    sentences.forEach((s, i) => {
      this.starts[i] = this.tokens.length;
      for (const w of words(s)) this.tokens.push({ w, sentence: i });
    });
    this.pos = Math.min(this.pos, this.tokens.length);
  }

  reset(sentences = []) { this.pos = 0; this.setSentences(sentences); }

  get done() { return this.tokens.length > 0 && this.pos >= this.tokens.length; }

  // The sentence being read: the one holding the next word, or the last one once everything was read.
  get sentence() {
    if (!this.tokens.length) return 0;
    return this.tokens[Math.min(this.pos, this.tokens.length - 1)].sentence;
  }

  // A line (partial or final) of what the user is saying. -> true when the position moved.
  hear(text) {
    const spoken = words(text).slice(-this.tail);
    if (spoken.length < Math.min(this.minMatch, 2) || !this.tokens.length) return false;
    const last = spoken.slice(-3);             // the newest words ("per cent" heard for "percent" still ends near the end)
    let best = null;
    const end = Math.min(this.tokens.length, this.pos + this.ahead);
    for (let j = this.pos; j < end; j++) {
      if (!last.includes(this.tokens[j].w)) continue;           // a match must end on one of the newest words
      const score = this.align(spoken, j);
      if (score >= this.minMatch && (!best || score > best.score)) best = { j, score };
    }
    if (!best) return false;
    this.pos = best.j + 1;
    return true;
  }

  // How many spoken words line up, in order, with the suggestion's words ending at j (longest common subsequence over a
  // window a little longer than the spoken tail, so skipped or extra words still count). Short function words count half.
  align(spoken, j) {
    const from = Math.max(0, j - spoken.length - 3);
    const script = this.tokens.slice(from, j + 1).map((t) => t.w);
    const n = spoken.length, m = script.length;
    let prev = new Array(m + 1).fill(0);
    for (let a = 1; a <= n; a++) {
      const row = new Array(m + 1).fill(0);
      for (let b = 1; b <= m; b++) {
        row[b] = spoken[a - 1] === script[b - 1] ? prev[b - 1] + (SHORT.has(spoken[a - 1]) ? 0.5 : 1) : Math.max(prev[b], row[b - 1]);
      }
      prev = row;
    }
    return prev[m];
  }

  // The shortcuts: one sentence back or on (the only way back).
  jump(delta) {
    if (!this.tokens.length) return;
    const last = this.starts.length - 1;
    const next = Math.max(0, Math.min(last, this.sentence + delta));
    this.pos = this.starts[next] ?? this.pos;
  }
}
