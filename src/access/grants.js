'use strict';
// What each source has been granted, decided in ONE place (docs/access.md). Every path that reads, searches, hands material to an AI
// server, serves it over MCP or acts on a service asks `can(source, op)` here, so a level the person chose holds everywhere.
//
// A grant lives on its source (sources.read_level, filter, actions, ai_reach, live_search, mcp, expires_at) and has two axes:
//   - what may be read: none · metadata (who/when/subject, no body) · part (the filter) · all
//   - which actions may be PROPOSED (each still waits for the person's approval in the Inbox; `auto` is only for exporting the
//     person's own meeting notes, which they switched on themselves)
// ai_reach says who may see the content: 'local' (only an AI server on this computer), 'ask' (confirm each time; any automatic path
// treats it as local), 'any' (a server the person chose; it is redacted first where the caller supports it).
// An item may override its source's ai_reach (items.ai_reach) to keep one thread local while it stays searchable.
const { isThisComputer } = require('../core/policy');

const READ_LEVELS = ['none', 'metadata', 'part', 'all'];
const AI_REACH = ['local', 'ask', 'any'];
const OPS = ['read.meta', 'read.body', 'search.live', 'ai.remote', 'mcp', 'export'];
const parse = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } };

// The grant of a source row as stored (sources.*) or as ItemStore returns it (camelCase): always the same shape.
function grantOf(source) {
  if (!source) return null;
  const aiReach = source.aiReach || source.ai_reach || (source.sensitivity === 'private' ? 'local' : 'any');
  return {
    readLevel: READ_LEVELS.includes(source.readLevel || source.read_level) ? (source.readLevel || source.read_level) : 'all',
    filter: parse(source.filter, {}) || {},
    actions: parse(source.actions, []) || [],
    autoActions: parse(source.autoActions ?? source.auto_actions, []) || [],
    aiReach: AI_REACH.includes(aiReach) ? aiReach : 'local',
    liveSearch: !!(source.liveSearch ?? source.live_search),
    mcp: !!source.mcp,
    expiresAt: source.expiresAt ?? source.expires_at ?? null,
    enabled: source.enabled === undefined ? true : !!source.enabled,
  };
}

const expired = (g, now) => g.expiresAt != null && g.expiresAt <= now;

// Who may see this item's content: the item's own override, else its source's. The stricter of the two never loosens: an item marked
// 'local' stays local under an 'any' source, but an item cannot open up what its source keeps local.
function reachOf(g, item) {
  const own = item?.aiReach || item?.ai_reach;
  if (!own || !AI_REACH.includes(own)) return g.aiReach;
  return AI_REACH.indexOf(own) < AI_REACH.indexOf(g.aiReach) ? own : g.aiReach;
}

// can(source, op, { item, llmConfig, confirmed, now }) -> boolean
//   read.meta / read.body: may the connector read who/when/subject / the body
//   search.live:           may a live search be sent to the service
//   ai.remote:             may this content be shown to the AI server in llmConfig (a local server always may, unless read is none)
//   mcp:                   may the MCP server serve it
//   export:                may it leave in an export or backup made for someone else
//   action.<kind>:         may an action of this kind be proposed / run
function can(source, op, { item = null, llmConfig = null, confirmed = false, now = Date.now() } = {}) {
  const g = grantOf(source);
  if (!g || expired(g, now)) return false;
  if (op.startsWith('action.')) return g.actions.includes(op.slice(7));   // a webhook can be action-only: nothing read, one thing sent
  if (g.readLevel === 'none') return false;
  switch (op) {
    case 'read.meta': return true;
    case 'read.body': return g.readLevel === 'part' || g.readLevel === 'all';
    case 'search.live': return g.liveSearch && (g.readLevel === 'part' || g.readLevel === 'all');
    case 'ai.remote': {
      if (llmConfig && isThisComputer(llmConfig.baseUrl)) return true;            // never leaves this computer
      const reach = reachOf(g, item);
      return reach === 'any' || (reach === 'ask' && confirmed);
    }
    case 'mcp': return g.mcp && reachOf(g, item) === 'any';                   // whoever is on the other end may be a remote model
    case 'export': return reachOf(g, item) === 'any';
    default: throw new Error(`unknown access op "${op}"`);
  }
}

// Columns to write for a grant patch (validated). Keeps the old `sensitivity` column in step for older readers.
function grantColumns(patch = {}) {
  const out = {};
  const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  if ('readLevel' in patch) { if (!READ_LEVELS.includes(patch.readLevel)) bad(`readLevel must be one of ${READ_LEVELS.join(', ')}`); out.read_level = patch.readLevel; }
  if ('aiReach' in patch) { if (!AI_REACH.includes(patch.aiReach)) bad(`aiReach must be one of ${AI_REACH.join(', ')}`); out.ai_reach = patch.aiReach; out.sensitivity = patch.aiReach === 'any' ? 'normal' : 'private'; }
  if ('sensitivity' in patch && !('aiReach' in patch)) { if (!['normal', 'private'].includes(patch.sensitivity)) bad('sensitivity must be normal or private'); out.sensitivity = patch.sensitivity; out.ai_reach = patch.sensitivity === 'private' ? 'local' : 'any'; }
  if ('filter' in patch) { if (!patch.filter || typeof patch.filter !== 'object' || Array.isArray(patch.filter)) bad('filter must be an object'); out.filter = JSON.stringify(patch.filter); }
  const kinds = (v, name) => { if (!Array.isArray(v) || v.some((k) => typeof k !== 'string' || !/^[a-z]+\.[a-zA-Z]+$/.test(k))) bad(`${name} must be a list of action kinds`); return JSON.stringify([...new Set(v)].slice(0, 20)); };
  if ('actions' in patch) out.actions = kinds(patch.actions, 'actions');
  if ('autoActions' in patch) out.auto_actions = kinds(patch.autoActions, 'autoActions');
  if ('liveSearch' in patch) out.live_search = patch.liveSearch ? 1 : 0;
  if ('mcp' in patch) out.mcp = patch.mcp ? 1 : 0;
  if ('retentionDays' in patch) { const n = Number(patch.retentionDays); if (!Number.isInteger(n) || n < 0 || n > 3650) bad('retentionDays must be 0 to 3650'); out.retention_days = n; }
  if ('expiresAt' in patch) { const v = patch.expiresAt; if (v !== null && !(Number.isFinite(Number(v)) && Number(v) > 0)) bad('expiresAt must be a time or null'); out.expires_at = v === null ? null : Number(v); }
  return out;
}

// A grant to show (Sources page, Access page): plain words per level.
const publicGrant = (source) => { const g = grantOf(source); return g && { ...g, expired: expired(g, Date.now()) }; };

module.exports = { can, grantOf, grantColumns, publicGrant, reachOf, READ_LEVELS, AI_REACH, OPS };
