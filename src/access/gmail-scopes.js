'use strict';
// The Google permissions Gmail needs for a grant (docs/access.md). Google cannot take back one permission alone, and the metadata
// permission cannot be combined with read access (its limits win: no searches, no bodies), so a level change is a fresh sign-in
// that asks for exactly these and nothing more.
const G = 'https://www.googleapis.com/auth/';
const METADATA = `${G}gmail.metadata`, READONLY = `${G}gmail.readonly`, COMPOSE = `${G}gmail.compose`, MODIFY = `${G}gmail.modify`, SEND = `${G}gmail.send`;
const GMAIL_SCOPES = new Set([METADATA, READONLY, COMPOSE, MODIFY, SEND]);

// Which Google permission each action needs. draft and send both need compose (drafts.send needs compose or modify); label, archive and
// mark-read need modify, whose consent text reads "read, compose and send".
const ACTION_SCOPE = { 'gmail.draft': COMPOSE, 'gmail.send': COMPOSE, 'gmail.label': MODIFY, 'gmail.archive': MODIFY, 'gmail.markRead': MODIFY };

// level: none | metadata | part | all; actions: ['gmail.draft', ...] -> the list of Google permissions to ask for
function gmailScopesFor({ level = 'part', actions = [] } = {}) {
  if (level === 'none' && !actions.length) return [];
  const extra = [...new Set(actions.map((a) => ACTION_SCOPE[a]).filter(Boolean))];
  if (level === 'metadata' && !extra.length) return [METADATA];
  return [...new Set([READONLY, ...extra])];     // metadata + actions is not possible: the actions need to read what they act on
}

// What the person's grant needs vs what Google gave (scopes: the list the token response said). Old sign-ins have no list: they were readonly.
const covers = (granted, need) => (!granted?.length ? need === READONLY || need === METADATA
  : granted.includes(need) || (need === READONLY && granted.includes(MODIFY)) || (need === COMPOSE && granted.includes(MODIFY)) || (need === METADATA && (granted.includes(READONLY) || granted.includes(MODIFY))));
const hasGmail = (granted) => !granted?.length || granted.some((s) => GMAIL_SCOPES.has(s));
// can the connector read bodies / search? (not under the metadata permission alone)
const canReadBodies = (granted) => !granted?.length || granted.some((s) => [READONLY, MODIFY].includes(s));
const canSearch = canReadBodies;

module.exports = { gmailScopesFor, covers, hasGmail, canReadBodies, canSearch, ACTION_SCOPE, METADATA, READONLY, COMPOSE, MODIFY, SEND, GMAIL_SCOPES };
