'use strict';
// Live search of Linear issues, asked of Linear itself (its searchIssues). When a team is configured (Settings → Linear), only that
// team's issues are returned: the answer is checked again here by the team's key, because Linear's search spans the whole workspace.
const { levelOf, blockedReason, neverMatcher } = require('../../connectors/chat');
const { linearItem } = require('../../connectors/poll');

const readable = (source, now = Date.now()) => !blockedReason(source, now) && ['part', 'all'].includes(levelOf(source));
const teamOf = (source, ctx) => ctx.settings.get('linear').teamId || source.config?.teamId || '';

// the key ("ENG") of the configured team, or null when there is no team; '' when there is one that cannot be found (then nothing is shown)
async function teamKey(source, ctx, client) {
  const id = teamOf(source, ctx);
  if (!id) return null;
  const t = (await client.teams()).find((x) => x.id === id);
  return t?.key || '';
}
const inTeam = (identifier, key) => key === null || (key !== '' && String(identifier).toUpperCase().startsWith(`${key.toUpperCase()}-`));

module.exports = {
  provider: 'linear',
  label: 'Linear',
  supports: (source) => source?.kind === 'linear',

  async search({ source, query, limit = 10, ctx }) {
    if (!readable(source, ctx.now?.())) return [];                                    // metadata / none / expired: nothing may be asked about
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return [];
    const client = ctx.integrations.linear();
    const key = await teamKey(source, ctx, client);
    const m = neverMatcher(source.filter?.never);
    const hits = await client.searchIssues(q, { first: Math.min(Math.max(limit, 1) * 2, 50) });
    return hits
      .filter((i) => inTeam(i.identifier, key) && !m.person(i.assignee) && !m.text(i.title))     // re-checked: the granted team, and the never-read list
      .slice(0, limit)
      .map((i) => ({ externalId: i.identifier, title: `${i.identifier} ${i.title}`, snippet: [i.state, i.assignee].filter(Boolean).join(' · '), uri: i.url || '', at: 0, who: i.assignee || '' }));
  },

  // One issue in full: the same payload the sync stores (what items.upsert takes).
  async open({ source, externalId, ctx }) {
    if (!readable(source, ctx.now?.())) throw Object.assign(new Error('This source may not be read at its current level.'), { status: 403 });
    const client = ctx.integrations.linear();
    const i = await client.issue(String(externalId));
    if (!inTeam(i.identifier, await teamKey(source, ctx, client))) throw Object.assign(new Error('That issue is not in the team this source reads.'), { status: 403 });
    const m = neverMatcher(source.filter?.never);
    if (m.person(i.assignee) || m.text(i.title) || m.text(i.description)) throw Object.assign(new Error('That issue is on this source\'s never-read list.'), { status: 403 });
    return linearItem({ ...i, comments: (i.comments || []).filter((c) => !(m.person(c.user) || m.text(c.body))) });
  },
};
