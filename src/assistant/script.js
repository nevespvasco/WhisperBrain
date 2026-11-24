'use strict';
// One suggestion from the AI, streamed: sentences as they complete (and the one being written), [GAP] flags, then the clean text.
// Abortable; a server that has not said a word after firstTokenMs fails with code 'slow' instead of hanging the assistant.
const { Splitter } = require('./sentences');

const MAX_TOKENS = 450;      // a suggestion is short: ~300 words at most, and a looping local model cannot hold the slot

function joinSentences(sentences) {
  return sentences.map((s) => (s.bullet ? `\n- ${s.text}` : s.text)).join(' ').replace(/ \n/g, '\n').trim();
}

// onEvent: { type: 'sentence', index, text, closed, gap?, bullet? } | { type: 'flag', index, kind: 'gap' }
async function produceScript({ llm, messages, signal, firstTokenMs = 15000, maxTokens = MAX_TOKENS, temperature = 0.3, onEvent = () => {} }) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let slow = false;
  let timer = setTimeout(() => { slow = true; ctl.abort(); }, firstTokenMs);
  const split = new Splitter();
  const sentences = [];
  let shownOpen = '';
  const close = (list) => {
    for (const s of list) {
      sentences.push(s);
      onEvent({ type: 'sentence', ...s, closed: true });
      if (s.gap) onEvent({ type: 'flag', index: s.index, kind: 'gap' });
    }
  };
  try {
    for await (const delta of llm.stream(messages, { signal: ctl.signal, maxTokens, temperature })) {
      if (timer) { clearTimeout(timer); timer = null; }
      close(split.push(delta));
      const open = split.open();
      if (open.text && open.text !== shownOpen) { shownOpen = open.text; onEvent({ type: 'sentence', ...open, closed: false }); }
    }
    close(split.flush());
  } catch (e) {
    if (slow) throw Object.assign(new Error('The AI server did not start answering in time.'), { code: 'slow' });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return { text: joinSentences(sentences), sentences };
}

module.exports = { produceScript, joinSentences, MAX_TOKENS };
