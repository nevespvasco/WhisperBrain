'use strict';
// Live search of GitHub issues and pull requests, asked of GitHub itself instead of read from the copy kept here. Used when a source
// is granted live search and has not been (fully) synced. It only ever asks about repositories the source is granted: the question goes
// out with `repo:` qualifiers for exactly those, and every answer is checked again here before it is shown (a qualifier the service
// ignored, or an issue that is on the never-read list, never gets through).
//
// GitHub's search has three limits that shape this file: a query may be at most 256 characters, may use at most 5 AND/OR/NOT
// operators, and the search API answers 30 requests a minute. So the repositories are split over several queries, and the pace is kept
// (src/connectors/http.js waits out a short rate limit once; here we also wait for the window when it says it is used up).
const { request } = require('../../connectors/http');
const { headers, issueItem, issueAllowed, commentAllowed, listRepos, REPO, BASE } = require('../../connectors/github');
const { levelOf, blockedReason } = require('../../connectors/chat');
const { nextLink } = require('../../connectors/http');

const MAX_QUERY_CHARS = 256;
const MAX_OPERATORS = 5;
const MAX_QUERIES = 12;          // per search: well inside 30 a minute, and a search that takes longer than that is not "live" any more
const MAX_COMMENT_PAGES = 5;
const MAX_WAIT_MS = 30_000;

const readable = (source, now = Date.now()) => !blockedReason(source, now) && ['part', 'all'].includes(levelOf(source));

// Free text -> text that cannot change the shape of the query: no AND/OR/NOT, no parentheses, no repo/org/user qualifiers of its own.
function cleanTerms(q, max) {
  const t = String(q || '')
    .replace(/\b(?:repo|org|user|owner|is|in|involves|author|assignee|label|type|archived|team):\S*/gi, ' ')
    .replace(/[()]/g, ' ').replace(/\b(?:AND|OR|NOT)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') || t.slice(0, max) : t;
}

// repos + free text -> the queries to ask: each <= 256 characters and <= 5 boolean operators. -> [{ q, repos }]
function buildQueries(repos, text) {
  const longest = Math.max(0, ...repos.map((r) => r.length));
  const terms = cleanTerms(text, Math.max(20, MAX_QUERY_CHARS - 4 - (5 + longest) - 4));
  if (!terms || !repos.length) return [];
  const make = (rs) => `${terms} ${rs.length > 1 ? `(${rs.map((r) => `repo:${r}`).join(' OR ')})` : `repo:${rs[0]}`}`;
  const out = [];
  let cur = [];
  for (const r of repos) {
    const next = [...cur, r];
    if (cur.length && (next.length - 1 > MAX_OPERATORS || make(next).length > MAX_QUERY_CHARS)) { out.push(cur); cur = [r]; } else cur = next;
  }
  if (cur.length) out.push(cur);
  return out.map((rs) => ({ q: make(rs), repos: rs }));
}

// the repositories this source may be searched in
async function grantedRepos(source, ctx, h) {
  const listed = (source.config?.repos || []).filter((r) => REPO.test(r));
  if (levelOf(source) !== 'all') return [...new Set(listed)];
  const all = await listRepos({ base: ctx.bases?.github || BASE, h, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, includeArchived: !!source.config?.includeArchived });
  return [...new Set([...listed, ...all])];
}

const repoOfUrl = (u) => /\/repos\/([^/]+\/[^/]+)$/.exec(String(u || ''))?.[1] || '';
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = {
  provider: 'github',
  label: 'GitHub',
  buildQueries,
  supports: (source) => source?.kind === 'github',

  async search({ source, query, limit = 10, ctx }) {
    if (!readable(source, ctx.now?.())) return [];                               // metadata / none / expired: nothing may be asked about
    const token = ctx.settings.get('github').token;
    if (!token) throw Object.assign(new Error('Add a GitHub token first.'), { code: 'not-configured' });
    const base = ctx.bases?.github || BASE, h = headers(token);
    const granted = await grantedRepos(source, ctx, h);
    const allowed = new Set(granted.map((r) => r.toLowerCase()));
    const queries = buildQueries(granted, query);
    const found = new Map();
    let truncated = queries.length > MAX_QUERIES;
    for (let i = 0; i < Math.min(queries.length, MAX_QUERIES); i++) {
      const res = await request(`${base}/search/issues?q=${encodeURIComponent(queries[i].q)}&per_page=${Math.min(Math.max(limit, 1), 30)}`, { service: 'GitHub', headers: h, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
      for (const it of res.json?.items || []) {
        const repo = repoOfUrl(it.repository_url);
        if (!allowed.has(repo.toLowerCase())) continue;                           // re-checked: only repositories the source was granted
        if (!issueAllowed(it, { never: source.filter?.never, filter: source.filter || {} })) continue;
        found.set(`${repo}#${it.number}`, { externalId: `${repo}#${it.number}`, title: `${it.pull_request ? 'PR' : 'Issue'} #${it.number} ${it.title}`, snippet: oneLine(it.body, 240), uri: it.html_url || '', at: Date.parse(it.updated_at) || Date.parse(it.created_at) || 0, who: it.user?.login || '' });
      }
      // the search window is used up: wait for it to reopen before the next question (a short wait; a long one stops the search)
      if (res.headers?.get?.('x-ratelimit-remaining') === '0' && i + 1 < Math.min(queries.length, MAX_QUERIES)) {
        const wait = Math.max(0, Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now());
        if (wait > MAX_WAIT_MS) { truncated = true; break; }
        await (ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
      }
    }
    const out = [...found.values()].sort((a, b) => b.at - a.at).slice(0, limit);
    out.truncated = truncated;                                                     // more repositories were granted than one search asks about
    return out;
  },

  // One issue or pull request in full: the same payload the sync would store (what items.upsert takes).
  async open({ source, externalId, ctx }) {
    if (!readable(source, ctx.now?.())) throw Object.assign(new Error('This source may not be read at its current level.'), { status: 403 });
    const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(String(externalId));
    if (!m) throw Object.assign(new Error('not an issue reference (owner/name#number)'), { status: 400 });
    const [, repo, num] = m;
    const token = ctx.settings.get('github').token;
    if (!token) throw Object.assign(new Error('Add a GitHub token first.'), { code: 'not-configured' });
    const base = ctx.bases?.github || BASE, h = headers(token);
    const listed = (source.config?.repos || []).map((r) => r.toLowerCase());
    if (levelOf(source) !== 'all' && !listed.includes(repo.toLowerCase())) throw Object.assign(new Error('That repository is not part of this source.'), { status: 403 });
    const r = await request(`${base}/repos/${repo}/issues/${num}`, { service: 'GitHub', headers: h, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
    const it = r.json;
    if (!issueAllowed(it, { never: source.filter?.never, filter: source.filter || {} })) throw Object.assign(new Error('That issue is on this source\'s never-read list.'), { status: 403 });
    let comments = [];
    if (it.comments > 0) {
      let cu = `${it.comments_url || `${base}/repos/${repo}/issues/${num}/comments`}?per_page=100`;
      for (let i = 0; cu && i < MAX_COMMENT_PAGES; i++) { const c = await request(cu, { service: 'GitHub', headers: h, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep }); comments.push(...c.json); cu = nextLink(c.headers); }
      comments = comments.filter((c) => commentAllowed(c, source.filter?.never));
    }
    return issueItem(repo, it, comments);
  },
};
