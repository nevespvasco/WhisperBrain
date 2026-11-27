'use strict';
// GitHub issues and pull requests of the repositories you list, as items (read-only; a personal access token with read access to the
// repositories). One item per issue or pull request: its text, then its comments. Incremental: only what changed since the last run
// (the `since` of the API); the cursor is the newest update seen. Closing an issue does not remove it: it is still what was said.
//
// What is read follows the source's access grant (src/access/grants.js; an old source without one reads the repositories config lists):
//   metadata: title, number, state, author, labels, when it changed. No body and no comments (their requests are not even made)
//   part:     the repositories config lists, minus the filter (labels, excluded labels and authors) and the "never read" list
//   all:      every repository the token sees (/user/repos, up to 200; archived ones skipped unless config.includeArchived), same rules
// The "never read" list is applied before anything is stored: authors (senders), labels, and words in the title, body or a comment.
const { request, nextLink } = require('./http');
const { levelOf, blockedReason, skippedRun, cursorsFor, cursorPatch, neverMatcher, listOf } = require('./chat');

const BASE = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ISSUES_PER_RUN = 300;
const MAX_COMMENT_PAGES = 5;
const MAX_ALL_REPOS = 200;

const every = 15 * 60_000;
const headers = (token) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', 'User-Agent': 'WhisperBrain' });

// grant: the grant the source is being added with, when the caller has it (level 'all' reads every repository the token sees: no list needed)
function validate(config, grant = {}) {
  const repos = (Array.isArray(config.repos) ? config.repos : String(config.repos || '').split(/[\s,]+/)).map((r) => String(r).trim()).filter(Boolean);
  if (!repos.length && (grant.readLevel === 'all' || config.all === true)) return { repos: [], all: true, ...(config.includeArchived ? { includeArchived: true } : {}) };
  if (!repos.length) throw Object.assign(new Error('Name at least one repository, like owner/name.'), { status: 400 });
  const bad = repos.find((r) => !REPO.test(r));
  if (bad) throw Object.assign(new Error(`“${bad}” is not a repository name (owner/name).`), { status: 400 });
  return { repos: [...new Set(repos)].slice(0, 20) };
}

const ready = ({ settings }) => !!settings.get('github').token;

async function check({ settings, fetchImpl, bases = {} }) {
  const r = await request(`${bases.github || BASE}/user`, { service: 'GitHub', headers: headers(settings.get('github').token), fetchImpl });
  return { ok: true, user: r.json.login };
}

const ghTime = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };

// Every repository the token sees, as owner/name (paginated, capped; archived and disabled ones left out unless asked for).
async function listRepos({ base, h, fetchImpl, sleep, includeArchived = false, max = MAX_ALL_REPOS }) {
  const out = [];
  let url = `${base}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`;
  for (let i = 0; url && out.length < max && i < 10; i++) {
    const page = await request(url, { service: 'GitHub', headers: h, fetchImpl, sleep });
    for (const r of page.json || []) if (r.full_name && (includeArchived || (!r.archived && !r.disabled))) out.push(r.full_name);
    url = nextLink(page.headers);
  }
  return [...new Set(out)].slice(0, max);
}

// May this issue be stored? The "never read" list first (always), then the part the filter allows. A rule that matches the issue
// itself (its author, a label, a word in the title or body) keeps the whole issue out; a comment that matches is left out alone.
function issueAllowed(it, { never, filter = {} }) {
  const m = neverMatcher(never);
  const labels = (it.labels || []).map((l) => l.name || l);
  if (!m.empty && (m.person(it.user?.login) || m.label(...labels) || m.text(it.title) || m.text(it.body))) return false;
  if (listOf(filter.labels, 10).length && !labels.some((l) => listOf(filter.labels, 10).includes(l))) return false;
  if (labels.some((l) => listOf(filter.excludeLabels, 50).includes(l))) return false;
  if (listOf(filter.excludeSenders, 50).map((s) => s.toLowerCase()).includes(String(it.user?.login || '').toLowerCase())) return false;
  return true;
}
const commentAllowed = (c, never) => { const m = neverMatcher(never); return m.empty || !(m.person(c.user?.login) || m.text(c.body)); };

// The item of one issue or pull request, as handed to items.upsert (also what a live search opens).
// comments: [] for metadata. metadataOnly: no text at all.
function issueItem(repo, it, comments = [], { metadataOnly = false } = {}) {
  const isPr = !!it.pull_request;
  const text = metadataOnly ? '' : [it.body || '', ...comments.map((c) => `— ${c.user?.login || 'someone'} (${String(c.created_at).slice(0, 10)}): ${c.body || ''}`)].join('\n\n');
  return {
    externalId: `${repo}#${it.number}`, kind: 'issue', title: `${isPr ? 'PR' : 'Issue'} #${it.number} ${it.title}`, text, uri: it.html_url || '',
    occurredAt: ghTime(it.updated_at) || ghTime(it.created_at), metaInHash: true,
    meta: { repo, number: it.number, state: it.state, pr: isPr, author: it.user?.login || '', labels: (it.labels || []).map((l) => l.name || l).slice(0, 10), assignees: (it.assignees || []).map((a) => a.login), updatedAt: it.updated_at, ...(metadataOnly ? { metadataOnly: true } : {}) },
  };
}

async function sync({ source, items, settings, fetchImpl, bases = {}, sleep, now = () => Date.now() }) {
  const token = settings.get('github').token;
  if (!token) throw Object.assign(new Error('Add a GitHub token first.'), { permanent: true });
  const blocked = blockedReason(source, now());
  if (blocked) return skippedRun(blocked);
  const level = levelOf(source), metadataOnly = level === 'metadata';
  const never = source.filter?.never, filter = source.filter || {};
  const base = bases.github || BASE;
  const h = headers(token);
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const cursors = cursorsFor(source, level);
  let repos = source.config.repos || [];
  if (level === 'all') repos = [...new Set([...repos, ...await listRepos({ base, h, fetchImpl, sleep, includeArchived: !!source.config.includeArchived })])];
  let seenIssues = 0;
  try {
    for (const repo of repos) {
      let url = `${base}/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100${cursors[repo] ? `&since=${encodeURIComponent(cursors[repo])}` : ''}`;
      let newest = cursors[repo] || '';
      while (url && seenIssues < MAX_ISSUES_PER_RUN) {
        const page = await request(url, { service: 'GitHub', headers: h, fetchImpl, sleep });
        for (const it of page.json) {
          if (seenIssues++ >= MAX_ISSUES_PER_RUN) break;
          if (it.updated_at > newest) newest = it.updated_at;
          if (!issueAllowed(it, { never, filter })) { if (items.tombstone(source.id, `${repo}#${it.number}`)) out.removed++; continue; }
          let comments = [];
          if (!metadataOnly && it.comments > 0) {
            let cu = `${it.comments_url}?per_page=100`;
            for (let i = 0; cu && i < MAX_COMMENT_PAGES; i++) { const c = await request(cu, { service: 'GitHub', headers: h, fetchImpl, sleep }); comments.push(...c.json); cu = nextLink(c.headers); }
            comments = comments.filter((c) => commentAllowed(c, never));
          }
          const r = items.upsert(source.id, issueItem(repo, it, comments, { metadataOnly }));
          out[r.action === 'revived' ? 'updated' : r.action]++;
        }
        url = nextLink(page.headers);
      }
      if (newest) cursors[repo] = newest;
    }
  } finally {
    items.updateSource(source.id, { config: cursorPatch(cursors, level) });      // what was read stays read, even when a rate limit stopped the run
  }
  return out;
}

module.exports = { kind: 'github', every, validate, ready, check, sync, headers, issueItem, issueAllowed, commentAllowed, listRepos, REPO, BASE };
