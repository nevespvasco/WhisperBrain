'use strict';
// Live search of Notion pages, asked of Notion itself (its /search endpoint, through the connected integration, so only pages that were
// shared with the integration can ever appear). Notion's search matches TITLES only, never the text inside a page: a page whose title
// does not contain the words is not found even if its body does. Opening a hit reads the whole page.
const { levelOf, blockedReason, neverMatcher } = require('../../connectors/chat');
const { notionItem } = require('../../connectors/poll');

const readable = (source, now = Date.now()) => !blockedReason(source, now) && ['part', 'all'].includes(levelOf(source));

module.exports = {
  provider: 'notion',
  label: 'Notion',
  note: 'Notion search matches page titles only, not the text inside pages. Open a result to read the page.',
  supports: (source) => source?.kind === 'notion',

  async search({ source, query, limit = 10, ctx }) {
    if (!readable(source, ctx.now?.())) return [];                                    // metadata / none / expired: nothing may be asked about
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return [];
    const m = neverMatcher(source.filter?.never);
    const hits = await ctx.integrations.notion().search(q, { kind: 'page' });
    return hits
      .filter((h) => h.kind === 'page' && !m.text(h.title))                         // re-checked: pages only, and never one whose title is on the never-read list
      .slice(0, limit)
      .map((h) => ({ externalId: h.id, title: h.title || 'Untitled', snippet: '', uri: h.url || '', at: Date.parse(h.lastEdited) || 0, who: '' }));
  },

  // One page in full: the same payload the sync stores (what items.upsert takes).
  async open({ source, externalId, ctx }) {
    if (!readable(source, ctx.now?.())) throw Object.assign(new Error('This source may not be read at its current level.'), { status: 403 });
    const p = await ctx.integrations.notion().pageToMarkdown(String(externalId));
    const m = neverMatcher(source.filter?.never);
    if (m.text(p.title) || m.text(p.markdown)) throw Object.assign(new Error('That page is on this source\'s never-read list.'), { status: 403 });
    return notionItem(p);
  },
};
