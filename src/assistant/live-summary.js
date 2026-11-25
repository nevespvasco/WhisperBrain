'use strict';
// The running summary of a call in progress: the previous summary plus what was said since, folded into a new one, so each update
// costs about the same however long the meeting gets. JSON in and out: summary, decisions, actions (with an owner when said),
// open questions.
const { neutralizeTags, UNTRUSTED } = require('../llm/prompts');
const { languageName } = require('../llm/languages');
const { extractJson } = require('../llm/insights');

const MAX_NEW_CHARS = 6000;   // what was said since the last update, newest kept
const MAX_ITEMS = 12;

const EMPTY = Object.freeze({ summary: '', decisions: [], actions: [], openQuestions: [] });

function liveSummaryMessages({ previous = EMPTY, lines = [], language = '' }) {
  let said = lines.map((l) => `${l.speaker === 'me' ? 'Me' : neutralizeTags(l.label || 'Them')}: ${neutralizeTags(String(l.text ?? '').replace(/\s+/g, ' ').trim())}`).join('\n');
  if (said.length > MAX_NEW_CHARS) said = said.slice(said.length - MAX_NEW_CHARS).replace(/^[^\n]*\n/, '');
  return [
    { role: 'system', content: `You keep a running summary of a meeting that is still going on.
You get the summary so far (JSON) and the lines said since. Reply with the updated summary as JSON only:
{"summary": "3 to 5 sentences", "decisions": ["…"], "actions": [{"text": "…", "owner": "name or Me or ''"}], "openQuestions": ["…"]}
- Keep what is still true from the summary so far; add what the new lines bring; drop a question once it was answered.
- Only what was actually said. Never invent names, numbers, dates or decisions. "Me" is the user.
- ${language ? `Write in ${languageName(language)}.` : 'Write in the language of the meeting.'}
- ${UNTRUSTED}` },
    { role: 'user', content: `Summary so far:\n${JSON.stringify(previous)}\n\nSaid since:\n<transcript>\n${said || '(nothing new)'}\n</transcript>` },
  ];
}

const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, MAX_ITEMS) : []);

// The model's reply -> { summary, decisions, actions, openQuestions }, or null when it is not usable
function parseLiveSummary(reply) {
  const o = extractJson(reply);
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.summary !== 'string') return null;
  const actions = Array.isArray(o.actions) ? o.actions.map((a) => (typeof a === 'string' ? { text: a, owner: '' } : a && typeof a.text === 'string' ? { text: a.text.trim(), owner: typeof a.owner === 'string' ? a.owner.trim() : '' } : null)).filter((a) => a && a.text).slice(0, MAX_ITEMS) : [];
  return { summary: o.summary.trim(), decisions: strings(o.decisions), actions, openQuestions: strings(o.openQuestions) };
}

module.exports = { liveSummaryMessages, parseLiveSummary, EMPTY, MAX_NEW_CHARS };
