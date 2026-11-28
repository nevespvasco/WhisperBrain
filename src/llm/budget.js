'use strict';
// How much material (transcript, excerpts) one prompt may carry. Settings → AI gives a cap in characters (contextChars). A server only
// ever sees tokens, and Ollama runs a model with a context of its own (OLLAMA_CONTEXT_LENGTH, or a num_ctx in the model), often 4k: a
// longer prompt is cut from the START, where the "untrusted data" rules and the JSON schema are. So when the server says what context
// it uses (LlmClient.contextLength), the material is also kept within it, less the instructions and room for the reply. When it does not
// (another server, an Ollama that has not loaded the model yet) the setting stands, as before.

const CHARS_PER_TOKEN = 3.5;        // English and Portuguese text with names and timestamps: a little under 4
const WIDE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;   // Chinese, Japanese, Korean: about one token each
const FLOOR_CHARS = 2000;           // as before: below this a prompt carries too little to be worth sending
const TEMPLATE_TOKENS = 256;        // chat template, role markers, the meeting header

function estimateTokens(text) {
  const s = String(text ?? '');
  const wide = (s.match(WIDE) || []).length;
  return Math.ceil(wide + (s.length - wide) / CHARS_PER_TOKEN);
}

// setting: the cap in characters. contextTokens: the server's context, or null. systemTokens: the instructions. replyTokens: the reply's
// cap; only a quarter of the context is kept for it at most (a reply rarely uses its whole cap, and Ollama does not cut the prompt for
// the reply's sake: it shifts the context while writing, which only costs the oldest part of a very long reply).
function fitBudget({ setting, contextTokens, systemTokens = 0, replyTokens = 0 }) {
  if (!(contextTokens > 0)) return setting;
  const room = contextTokens - systemTokens - Math.min(replyTokens, Math.floor(contextTokens / 4)) - TEMPLATE_TOKENS;
  return Math.max(FLOOR_CHARS, Math.min(setting, Math.floor(room * CHARS_PER_TOKEN)));
}

module.exports = { estimateTokens, fitBudget, CHARS_PER_TOKEN, FLOOR_CHARS };
