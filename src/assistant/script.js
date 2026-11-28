'use strict';
// One suggestion from the AI, streamed: sentences as they complete (and the one being written), [GAP] flags, then the clean text.
// Abortable; a server that has not said a word after firstTokenMs fails with code 'slow' instead of hanging the assistant. That timer
// starts when the AI slot is granted (onStart from the scheduler), not while the request waits behind other work, and thinking counts
// as having started (onProgress). Waiting for the slot has its own, longer limit: waitMs.
const { Splitter } = require('./sentences');

const MAX_TOKENS = 450;      // a suggestion is short: ~300 words at most, and a looping local model cannot hold the slot

function joinSentences(sentences) {
  return sentences.map((s) => (s.bullet ? `\n- ${s.text}` : s.text)).join(' ').replace(/ \n/g, '\n').trim();
}

// onEvent: { type: 'sentence', index, text, closed, gap?, bullet? } | { type: 'flag', index, kind: 'gap' }
async function produceScript({ llm, messages, signal, firstTokenMs = 15000, waitMs = 60000, maxTokens = MAX_TOKENS, temperature = 0.3, onEvent = () => {} }) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let slow = false, timer = null, heard = false;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { slow = true; ctl.abort(); }, ms); };
  const alive = () => { heard = true; clearTimeout(timer); timer = null; };
  arm(waitMs);
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
    // reasoning 'off': a reasoning model left to think first misses the first-token limit every time
    for await (const delta of llm.stream(messages, { signal: ctl.signal, maxTokens, temperature, reasoning: 'off', onStart: () => { if (!heard) arm(firstTokenMs); }, onProgress: alive })) {
      if (!heard) alive();
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
