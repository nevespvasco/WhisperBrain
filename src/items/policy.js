'use strict';
// Per-source sensitivity, decided in one place. A source marked 'private' (mail, chat, anything the person would not paste into a
// website) may only be shown to an AI server that runs on this computer; 'normal' material may go to a server the person chose.
// Everything that hands items to an AI goes through this check (retrieval and briefs, from Phase 2).
const { isLocalUrl } = require('../core/policy');

function mayReachAi(source, llmConfig) {
  if (!source) return false;
  if (source.sensitivity !== 'private') return true;
  return isLocalUrl(llmConfig?.baseUrl);
}

// the items of a list that this AI server may see
const visibleToAi = (items, sourcesById, llmConfig) => items.filter((it) => mayReachAi(sourcesById.get(it.sourceId), llmConfig));

module.exports = { mayReachAi, visibleToAi };
