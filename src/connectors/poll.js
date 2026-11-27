'use strict';
// Notion pages and Linear issues you imported, kept up to date: each is read again every few hours and the meeting is updated when the
// page or issue changed (the importer compares a hash, so an unchanged one does nothing). Only what you already imported is followed:
// nothing new is pulled in by itself.
//
// Unless the source is set to mode 'all' AND its grant says so (src/access/grants.js): then every page shared with the Notion integration
// (up to 500 per run, kind 'document') or every issue of the configured Linear team (up to 1000 per run, kind 'issue') also becomes an
// item of this source (not a meeting), incrementally by the time it was last changed. A run that hits the cap remembers where it
// stopped and continues next time, so nothing is skipped.
//   metadata (with mode 'all'): the titles and when they changed, no text; the imported meetings are not refreshed (they carry text)
//   part (or no grant): exactly what it always did: only what was imported
//   all (with mode 'all'): titles and text; the "never read" list (people, labels, words) is applied before anything is stored
const { titleOf } = require('../integrations/notion');
const { levelOf, blockedReason, skippedRun, neverMatcher } = require('./chat');

const MAX_REFS = 100;
const MAX_NOTION_PAGES = 500;
const MAX_LINEAR_ISSUES = 1000;
const every = 6 * 3600_000;

// ---- the items (also what a live search opens) ----

// p: { id, title, url, lastEditedTime, createdTime, markdown } (NotionClient.pageToMarkdown, or a search hit with no markdown)
function notionItem(p, { metadataOnly = false } = {}) {
  return {
    externalId: p.id, kind: 'document', title: String(p.title || 'Untitled'), text: metadataOnly ? '' : String(p.markdown || ''), uri: p.url || '',
    occurredAt: Date.parse(p.lastEditedTime) || Date.parse(p.createdTime) || Date.now(), metaInHash: true,
    meta: { notionId: p.id, lastEdited: p.lastEditedTime || '', created: p.createdTime || '', ...(metadataOnly ? { metadataOnly: true } : {}) },
  };
}

// i: a Linear issue ({ identifier, title, description, url, state, assignee, comments: [{ body, user, createdAt }], labels, updatedAt })
function linearItem(i, { metadataOnly = false } = {}) {
  const comments = i.comments || [];
  const text = metadataOnly ? '' : `${i.description || ''}${comments.length ? `\n\n## Discussion\n\n${comments.map((c) => `- **${c.user || 'Someone'}** (${String(c.createdAt).slice(0, 10)}): ${String(c.body || '').replace(/\n+/g, ' ')}`).join('\n')}` : ''}`.trim();
  return {
    externalId: i.identifier, kind: 'issue', title: `${i.identifier} ${i.title}`, text, uri: i.url || '',
    occurredAt: Date.parse(i.updatedAt) || Date.now(), metaInHash: true,
    meta: { identifier: i.identifier, state: i.state || '', assignee: i.assignee || '', labels: (i.labels || []).slice(0, 10), updatedAt: i.updatedAt || '', ...(metadataOnly ? { metadataOnly: true } : {}) },
  };
}

const pageSaved = (items, source, item, out) => { const r = items.upsert(source.id, item); out[r.action === 'revived' ? 'updated' : r.action]++; };

// Where a "sweep" of the whole service stands, kept in config so a run that stopped at its cap (or at a rate limit) continues:
//   { since: the newest change fully swept, after: the page to continue from, newest: the newest change seen in the sweep so far }
const sweepOf = (source, key) => ({ since: '', after: null, newest: '', ...(source.config?.[key] || {}) });
const saveSweep = (items, source, key, sw) => items.updateSource(source.id, { config: { [key]: sw } });
// the sweep finished: what it saw becomes the new mark; a later change is anything after it
const finished = (sw) => ({ since: sw.newest > sw.since ? sw.newest : sw.since, after: null, newest: '' });

// ---- Notion: every page shared with the integration ----
async function syncNotionAll({ source, items, integrations, out, metadataOnly, never }) {
  const client = integrations.notion();
  const m = neverMatcher(never);
  let sw = sweepOf(source, 'notionSweep');
  let seen = 0;
  try {
    for (;;) {
      const res = await client.request('POST', '/search', { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 100, ...(sw.after ? { start_cursor: sw.after } : {}) });
      let reachedKnown = false;
      for (const r of res?.results || []) {
        if (sw.since && r.last_edited_time <= sw.since) { reachedKnown = true; break; }          // newest first: from here on nothing changed
        seen++;
        if (r.last_edited_time > sw.newest) sw.newest = r.last_edited_time;
        if (r.archived || r.in_trash) { if (items.tombstone(source.id, r.id)) out.removed++; continue; }
        const title = titleOf(r);
        if (m.text(title)) { if (items.tombstone(source.id, r.id)) out.removed++; continue; }
        let p = { id: r.id, title, url: r.url, lastEditedTime: r.last_edited_time, createdTime: r.created_time };
        if (!metadataOnly) {
          try { p = await client.pageToMarkdown(r.id); } catch (e) { if (e.status === 429 || e.code === 'rate_limited') throw e; out.errors++; continue; }
          if (m.text(p.markdown)) { if (items.tombstone(source.id, r.id)) out.removed++; continue; }
        }
        pageSaved(items, source, notionItem(p, { metadataOnly }), out);
      }
      if (reachedKnown || !res?.has_more) { sw = finished(sw); break; }
      sw.after = res.next_cursor;
      if (seen >= MAX_NOTION_PAGES) break;                                                      // the rest waits for the next run
    }
  } finally { saveSweep(items, source, 'notionSweep', sw); }
}

// ---- Linear: every issue of the configured team ----
const ISSUES_QUERY = (metadataOnly) => `query($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { id identifier title url updatedAt state { name } assignee { name } creator { name } labels { nodes { name } }${metadataOnly ? '' : ' description comments(first: 25) { nodes { body createdAt user { name } } }'} }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function syncLinearAll({ source, items, integrations, settings, out, metadataOnly, never }) {
  const teamId = settings.get('linear').teamId || source.config.teamId;
  if (!teamId) throw Object.assign(new Error('Pick a Linear team (Integrations → Linear) to read all of its issues.'), { permanent: true });
  const client = integrations.linear();
  const m = neverMatcher(never);
  let sw = sweepOf(source, 'linearSweep');
  let seen = 0;
  try {
    for (;;) {
      const filter = { team: { id: { eq: teamId } }, ...(sw.since ? { updatedAt: { gt: sw.since } } : {}) };
      const d = await client.gql(ISSUES_QUERY(metadataOnly), { filter, first: 50, after: sw.after || undefined });
      for (const n of d.issues?.nodes || []) {
        seen++;
        if (n.updatedAt > sw.newest) sw.newest = n.updatedAt;
        const labels = (n.labels?.nodes || []).map((l) => l.name);
        if (!m.empty && (m.person(n.assignee?.name, n.creator?.name) || m.label(...labels) || m.text(n.title) || m.text(n.description))) { if (items.tombstone(source.id, n.identifier)) out.removed++; continue; }
        const comments = (n.comments?.nodes || []).filter((c) => !(m.person(c.user?.name) || m.text(c.body))).map((c) => ({ body: c.body, user: c.user?.name || null, createdAt: c.createdAt }));
        pageSaved(items, source, linearItem({ identifier: n.identifier, title: n.title, description: n.description, url: n.url, state: n.state?.name, assignee: n.assignee?.name, labels, updatedAt: n.updatedAt, comments }, { metadataOnly }), out);
      }
      const info = d.issues?.pageInfo;
      if (!info?.hasNextPage) { sw = finished(sw); break; }
      sw.after = info.endCursor;
      if (seen >= MAX_LINEAR_ISSUES) break;                                                     // the rest waits for the next run
    }
  } finally { saveSweep(items, source, 'linearSweep', sw); }
}

function make(kind) {
  const label = kind === 'notion' ? 'Notion' : 'Linear';
  const ready = ({ settings }) => (kind === 'notion' ? !!settings.get('notion').token : !!settings.get('linear').apiKey);
  return {
    kind, every, label,
    validate: (config = {}) => ({ poll: true, ...(config.mode === 'all' ? { mode: 'all' } : {}) }),
    ready,
    check: async ({ integrations }) => (kind === 'notion' ? { ok: true, ...(await integrations.notion().me()) } : { ok: true, viewer: await integrations.linear().viewer() }),
    async sync({ source, items, settings, integrations, app, now = () => Date.now() }) {
      if (!ready({ settings })) throw Object.assign(new Error(`Connect ${label} first (Integrations).`), { permanent: true });
      const blocked = blockedReason(source, now());
      if (blocked) return skippedRun(blocked);
      const level = levelOf(source);
      const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
      // what was imported as meetings carries text: at 'metadata' it is not refreshed
      if (level !== 'metadata') {
        const refs = app.db.prepare('SELECT source_ref AS ref FROM notes WHERE source = ? AND source_ref IS NOT NULL ORDER BY updated_at DESC LIMIT ?').all(kind, MAX_REFS).map((r) => r.ref);
        for (let i = 0; i < refs.length; i += 10) {
          let res;
          try { res = await (kind === 'notion' ? integrations.importNotion(refs.slice(i, i + 10)) : integrations.importLinear(refs.slice(i, i + 10))); } catch (e) { if (e.code === 'rate-limited' || /429/.test(e.message)) throw e; out.errors += refs.slice(i, i + 10).length; continue; }
          for (const r of res) { if (r.unchanged) out.unchanged++; else if (r.updated) out.updated++; else out.created++; }
        }
      }
      // everything the service shares: only when the source asks for it and the grant is wide enough
      if (source.config?.mode === 'all' && (level === 'all' || level === 'metadata')) {
        const args = { source, items, integrations, settings, out, metadataOnly: level === 'metadata', never: source.filter?.never };
        await (kind === 'notion' ? syncNotionAll(args) : syncLinearAll(args));
      }
      items.updateSource(source.id, { cursor: String(Date.now()) });
      return out;
    },
  };
}

module.exports = { notion: make('notion'), linear: make('linear'), notionItem, linearItem };
