'use strict';
// Checks on an action before a person sees it (docs/access.md). An action only ever waits for approval, but a person approving a long
// text can miss that it is going to somebody new, carries a link that was not in the conversation, or quotes material from a source that
// belongs somewhere else. Each finding is a flag shown on the proposal in plain words; the ones that could leak something ('confirm')
// need a second, separate yes. Pure functions.
const crypto = require('node:crypto');

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const norm = (s) => String(s || '').trim().toLowerCase();
const domainOf = (e) => norm(e).split('@')[1] || '';
const urlsOf = (t) => [...new Set((String(t || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];

// outbound: { recipients: [addresses or names], urls?, text } ; context: { people: addresses already in the thread, text: the thread's text,
// typed: addresses the person typed themselves, provenance: source ids the text was made from, sourceId: where it goes, sameOwner(sourceId) }
function audit({ outbound = {}, context = {} } = {}) {
  const flags = [];
  const people = new Set((context.people || []).map(norm));
  const typed = new Set((context.typed || []).map(norm));
  const recipients = (outbound.recipients || []).map(norm).filter(Boolean);
  for (const r of recipients) {
    if (!r.includes('@')) continue;                                   // a channel or a repository: the connector's own check applies
    if (!people.has(r) && !typed.has(r)) flags.push({ code: 'new-recipient', severity: 'confirm', value: r, text: `${r} is not in this conversation and you did not type it.` });
  }
  for (const u of urlsOf(outbound.text)) {
    if (!String(context.text || '').includes(u)) flags.push({ code: 'new-url', severity: 'warn', value: u, text: `The text has a link that was not in the conversation: ${u}` });
  }
  const outsiders = recipients.filter((r) => r.includes('@') && !people.has(r) ? true : r.includes('@') && ![...people].some((p) => domainOf(p) === domainOf(r)));
  const foreign = (context.provenance || []).filter((id) => id && id !== context.sourceId);
  if (foreign.length && (outsiders.length || recipients.some((r) => !r.includes('@')))) flags.push({ code: 'foreign-material', severity: 'confirm', value: foreign.join(','), text: 'This text was made with material from another source or account, and it is going to somebody outside that conversation.' });
  return flags;
}

const needsSecondYes = (flags) => (flags || []).some((f) => f.severity === 'confirm');

// A hash of an action's arguments, made when it is proposed and checked when it runs
const argsHash = (args) => crypto.createHash('sha256').update(JSON.stringify(args, Object.keys(flatten(args)).sort())).digest('hex');
function flatten(o, out = {}) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out[k] = 1; flatten(v, out); } return out; }

module.exports = { audit, needsSecondYes, argsHash, urlsOf };
