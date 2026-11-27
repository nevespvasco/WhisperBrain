'use strict';
// Kept for older callers: whether a source's material may be shown to an AI server is now decided by its access grant
// (src/access/grants.js, op 'ai.remote'). A source kept 'local' (mail, chat, anything the person would not paste into a website)
// may only reach an AI server on this computer; 'any' may go to a server the person chose.
const { can } = require('../access/grants');

const mayReachAi = (source, llmConfig, item = null) => !!source && can(source, 'ai.remote', { item, llmConfig: llmConfig || {} });

// the items of a list that this AI server may see
const visibleToAi = (items, sourcesById, llmConfig) => items.filter((it) => mayReachAi(sourcesById.get(it.sourceId), llmConfig, it));

module.exports = { mayReachAi, visibleToAi };
