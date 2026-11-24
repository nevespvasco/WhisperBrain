'use strict';
// Linear GraphQL client (personal API key) and action-item → issue mapping.
const { meetingDate, ymd } = require('./format');

class LinearError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

const ISSUE_FIELDS = 'id identifier title url state { name } assignee { name }';
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const mapIssue = (i) => ({ id: i.id, identifier: i.identifier, title: i.title, url: i.url, state: i.state?.name || '', assignee: i.assignee?.name || null });

class LinearClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, url = 'https://api.linear.app/graphql' } = {}) {
    Object.assign(this, { apiKey, url });
    this.fetch = fetchImpl;
  }

  async gql(query, variables = {}) {
    if (!this.apiKey) throw new LinearError('No Linear API key is configured. Add one in Settings → Integrations.', { code: 'not-configured' });
    let res;
    try {
      // Personal API keys go in raw; OAuth tokens already carry their 'Bearer ' prefix.
      res = await this.fetch(this.url, { method: 'POST', headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new LinearError(`Cannot reach Linear (${e.cause?.code || e.message}).`, { code: 'unreachable' });
    }
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    const err = json?.errors?.[0];
    if (!res.ok) {
      const msg = res.status === 401 ? 'Linear rejected the API key (401). Check it in Settings → Integrations.' : err?.message || `Linear request failed (${res.status})`;
      throw new LinearError(msg, { status: res.status, code: err?.extensions?.code || (res.status === 401 ? 'unauthorized' : 'http') });
    }
    if (err) throw new LinearError(err.message || 'Linear returned an error', { status: res.status, code: err.extensions?.code || 'graphql' });
    return json?.data || {};
  }

  async viewer() {
    const { viewer } = await this.gql('query { viewer { id name email } }');
    return { id: viewer.id, name: viewer.name, email: viewer.email };
  }

  async teams() {
    const d = await this.gql('query { teams(first: 250) { nodes { id key name } } }');
    return (d.teams?.nodes || []).map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  async users() {
    const d = await this.gql('query { users(first: 250) { nodes { id name displayName email active } } }');
    return (d.users?.nodes || []).filter((u) => u.active !== false).map((u) => ({ id: u.id, name: u.name, email: u.email, displayName: u.displayName }));
  }

  async projects() {
    const d = await this.gql('query { projects(first: 250) { nodes { id name } } }');
    return (d.projects?.nodes || []).map((p) => ({ id: p.id, name: p.name }));
  }

  async searchIssues(query, { first = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    if (IDENTIFIER.test(q)) {
      try {
        const d = await this.gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: q.toUpperCase() });
        return d.issue ? [mapIssue(d.issue)] : [];
      } catch (e) {
        if (e.status === 401 || e.code === 'unreachable' || !/not found|entity/i.test(e.message)) throw e;
        return [];
      }
    }
    const d = await this.gql(`query($term: String!, $first: Int) { searchIssues(term: $term, first: $first) { nodes { ${ISSUE_FIELDS} } } }`, { term: q, first });
    return (d.searchIssues?.nodes || []).map(mapIssue);
  }

  async issue(idOrIdentifier) {
    const d = await this.gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description comments(first: 50) { nodes { body createdAt user { name } } } } }`, { id: String(idOrIdentifier) });
    const i = d.issue;
    if (!i) throw new LinearError(`Issue ${idOrIdentifier} not found`, { code: 'not-found' });
    return { ...mapIssue(i), description: i.description || '', comments: (i.comments?.nodes || []).map((c) => ({ body: c.body, user: c.user?.name || null, createdAt: c.createdAt })) };
  }

  async createIssue({ teamId, title, description, assigneeId, dueDate, projectId } = {}) {
    if (!teamId) throw new LinearError('Pick a Linear team first.', { code: 'no-team' });
    if (!String(title || '').trim()) throw new LinearError('An issue needs a title.', { code: 'no-title' });
    const input = compact({ teamId, title, description, assigneeId, dueDate, projectId });
    const d = await this.gql('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }', { input });
    if (!d.issueCreate?.success || !d.issueCreate.issue) throw new LinearError('Linear did not create the issue', { code: 'failed' });
    const i = d.issueCreate.issue;
    return { id: i.id, identifier: i.identifier, title: i.title, url: i.url };
  }

  async createComment({ issueId, body } = {}) {
    const d = await this.gql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }', { input: { issueId, body } });
    if (!d.commentCreate?.success || !d.commentCreate.comment) throw new LinearError('Linear did not create the comment', { code: 'failed' });
    return { id: d.commentCreate.comment.id, url: d.commentCreate.comment.url };
  }
}

// Owner text ("Alice", "alice@x.io", "Alice Smith") → a Linear user, or null when ambiguous / unknown.
function matchUser(owner, users = []) {
  const o = String(owner || '').trim().toLowerCase().replace(/^@/, '');
  if (!o) return null;
  const low = (s) => String(s || '').trim().toLowerCase();
  const exact = users.find((u) => low(u.email) === o || low(u.name) === o || low(u.displayName) === o);
  if (exact) return exact;
  const first = (s) => low(s).split(/[\s@._-]+/)[0];
  const of = first(o);
  const cands = users.filter((u) => [u.name, u.displayName, u.email].some((s) => s && first(s) === of));
  return cands.length === 1 ? cands[0] : null;
}

function excerpt(text, max = 600) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function actionItemsToIssues(meeting, { teamId, users = [] } = {}) {
  const m = meeting || {};
  const d = meetingDate(m);
  const ref = `From meeting “${String(m.title || '').trim() || 'Untitled'}”${d ? ` on ${ymd(d)}` : ''}`;
  const summary = excerpt(m.summary);
  return (Array.isArray(m.actionItems) ? m.actionItems : []).filter((a) => a && !a.done && String(a.text || '').trim()).map((a) => {
    let title = String(a.text).replace(/\s+/g, ' ').trim();
    if (title.length > 255) title = `${title.slice(0, 254)}…`;
    const user = matchUser(a.owner, users);
    const lines = [ref];
    if (a.owner && !user) lines.push(`Owner: ${String(a.owner).trim()}`);
    if (summary) lines.push('', '**Meeting summary**', '', summary);
    const due = String(a.due || '').trim();
    return compact({ teamId, title, description: lines.join('\n'), assigneeId: user?.id, dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined });
  });
}

module.exports = { LinearClient, LinearError, actionItemsToIssues, matchUser };
