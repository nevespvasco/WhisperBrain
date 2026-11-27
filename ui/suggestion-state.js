// The assistant's suggestions as the teleprompter shows them, built from the `assistant.*` events (src/assistant/service.js).
// Pure: reduce(state, type, data) -> state, so it is unit-tested without a page. A card is
//   { seq, question, sentences: [text], closed: [bool], gaps: Set(index), bullets: Set(index), done, error }
// A sentence is re-sent as it grows (closed:false) and a last time closed; a gap flag may come after the sentence, or after done.

const MAX_PREVIOUS = 1;

export function initialState() { return { current: null, previous: [] }; }

function card(seq, question = '') {
  return { seq, question, sentences: [], closed: [], gaps: new Set(), bullets: new Set(), done: false, error: null };
}

function push(state, next) {
  const prev = state.current && (state.current.sentences.some(Boolean) || state.current.error) ? [state.current, ...state.previous].slice(0, MAX_PREVIOUS) : state.previous;
  return { current: next, previous: prev };
}

// The card an event about `seq` belongs to: the current one, or a new one when a sentence arrives for a question we missed.
function target(state, seq) {
  if (state.current && state.current.seq === seq) return state;
  return push(state, card(seq));
}

export function reduce(state, type, d = {}) {
  switch (type) {
    case 'assistant.question':
      if (state.current && state.current.seq === d.seq) { state.current.question = d.question || state.current.question; return state; }
      return push(state, card(d.seq, d.question || ''));
    case 'assistant.sentence': {
      if (!Number.isInteger(d.index) || d.index < 0) return state;
      const s = target(state, d.seq);
      const c = s.current;
      c.sentences[d.index] = String(d.text ?? '');
      c.closed[d.index] = !!d.closed;
      if (d.gap) c.gaps.add(d.index);
      if (d.bullet) c.bullets.add(d.index);
      return s;
    }
    case 'assistant.flag':
      if (state.current?.seq === d.seq && d.kind === 'gap' && Number.isInteger(d.index)) state.current.gaps.add(d.index);
      return state;
    case 'assistant.done': {
      if (state.current?.seq !== d.seq) return state;
      const c = state.current;
      c.done = true;
      c.closed = c.sentences.map(() => true);
      if (!c.sentences.some(Boolean) && d.text) { c.sentences = [String(d.text)]; c.closed = [true]; }
      if (d.question && !c.question) c.question = d.question;
      return state;
    }
    case 'assistant.error': {
      if (state.current && (state.current.seq === d.seq || (d.seq === undefined && !state.current.done))) {
        state.current.error = d.message || 'error';
        state.current.done = true;
        return state;
      }
      if (d.seq === undefined) return state; // an error from somewhere else (a term card, the summary): not about a suggestion
      const s = push(state, card(d.seq));
      s.current.error = d.message || 'error';
      s.current.done = true;
      return s;
    }
    case 'assistant.repeat': {
      const s = push(state, card(`repeat-${(state.current?.seq ?? '')}-${Date.now()}`, d.question || ''));
      s.current.sentences = [String(d.text || '')];
      s.current.closed = [true];
      s.current.done = true;
      return s;
    }
    default:
      return state;
  }
}

// The words of a card as one reading text, sentence by sentence (holes from a sentence not seen yet are skipped).
export function sentencesOf(c) { return c ? c.sentences.map((s) => s || '') : []; }
