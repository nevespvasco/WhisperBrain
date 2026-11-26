'use strict';
// GitHub issues and pull requests of the repositories you list, as items (read-only; a personal access token with read access to the
// repositories). One item per issue or pull request: its text, then its comments. Incremental: only what changed since the last run
// (the `since` of the API); the cursor is the newest update seen. Closing an issue does not remove it: it is still what was said.
const { request, nextLink } = require('./http');

const BASE = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ISSUES_PER_RUN = 300;
const MAX_COMMENT_PAGES = 5;

const every = 15 * 60_000;
const headers = (token) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', 'User-Agent': 'WhisperBrain' });

function validate(config) {
  const repos = (Array.isArray(config.repos) ? config.repos : String(config.repos || '').split(/[\s,]+/)).map((r) => String(r).trim()).filter(Boolean);
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

async function sync({ source, items, settings, fetchImpl, bases = {}, sleep }) {
  const token = settings.get('github').token;
  if (!token) throw Object.assign(new Error('Add a GitHub token first.'), { permanent: true });
  const base = bases.github || BASE;
  const h = headers(token);
  const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
  const cursors = { ...(source.config.cursors || {}) };
  let seenIssues = 0;
  for (const repo of source.config.repos || []) {
    let url = `${base}/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100${cursors[repo] ? `&since=${encodeURIComponent(cursors[repo])}` : ''}`;
    let newest = cursors[repo] || '';
    while (url && seenIssues < MAX_ISSUES_PER_RUN) {
      const page = await request(url, { service: 'GitHub', headers: h, fetchImpl, sleep });
      for (const it of page.json) {
        if (seenIssues++ >= MAX_ISSUES_PER_RUN) break;
        let comments = [];
        if (it.comments > 0) {
          let cu = `${it.comments_url}?per_page=100`;
          for (let i = 0; cu && i < MAX_COMMENT_PAGES; i++) { const c = await request(cu, { service: 'GitHub', headers: h, fetchImpl, sleep }); comments.push(...c.json); cu = nextLink(c.headers); }
        }
        const isPr = !!it.pull_request;
        const text = [it.body || '', ...comments.map((c) => `— ${c.user?.login || 'someone'} (${String(c.created_at).slice(0, 10)}): ${c.body || ''}`)].join('\n\n');
        const r = items.upsert(source.id, {
          externalId: `${repo}#${it.number}`, kind: 'issue', title: `${isPr ? 'PR' : 'Issue'} #${it.number} ${it.title}`, text, uri: it.html_url || '',
          occurredAt: ghTime(it.updated_at) || ghTime(it.created_at), metaInHash: true,
          meta: { repo, number: it.number, state: it.state, pr: isPr, author: it.user?.login || '', labels: (it.labels || []).map((l) => l.name || l).slice(0, 10), assignees: (it.assignees || []).map((a) => a.login), updatedAt: it.updated_at },
        });
        out[r.action === 'revived' ? 'updated' : r.action]++;
        if (it.updated_at > newest) newest = it.updated_at;
      }
      url = nextLink(page.headers);
    }
    if (newest) cursors[repo] = newest;
  }
  items.updateSource(source.id, { config: { cursors } });
  return out;
}

module.exports = { kind: 'github', every, validate, ready, check, sync };
