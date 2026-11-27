'use strict';
// Actions that write to the services you connected: a Slack message, a GitHub comment or issue, a Discord message, a Notion page, a
// Linear comment. Same rules as src/brain/actions.js: nothing here runs by itself. Each is PROPOSED with its exact arguments, shown in
// the Inbox in plain words, and runs only after an explicit approval, with exactly those arguments (a proposal changes nothing anywhere).
//
// Every build() also returns `outbound`: who this goes to and exactly what leaves, so one generic check can look at ALL of them the same
// way (an address or channel the person never mentioned, a link that could carry data out):
//   outbound = { recipients: ['slack:#general', ...], urls: [every link found in the text], text: the full message }
// recipients are prefixed with the service so a guard can compare them to what it expects:
//   slack:#name or slack:<id> (a thread: slack:#name/<ts>) · github:owner/name (an issue or PR: github:owner/name#12) · discord:<channel id>
//   notion:<parent id> · linear:<identifier, like ENG-12>
// deps = { settings, integrations, fetchImpl, bases, sleep }. Tokens stay in settings and are read only when the action runs.
const { request } = require('../connectors/http');

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const SLACK = 'https://slack.com/api';
const GITHUB = 'https://api.github.com';
const DISCORD = 'https://discord.com/api/v10';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SNOWFLAKE = /^\d{15,22}$/;
const LIMITS = { slack: 4000, discord: 2000, github: 20000, linear: 20000, notion: 20000 };

// every web link in a text, without the punctuation that closes a sentence or a Markdown link
function urlsIn(text) {
  const found = String(text || '').match(/\bhttps?:\/\/[^\s<>"'`\]]+/gi) || [];
  return [...new Set(found.map((u) => u.replace(/[)\].,;:!?*_]+$/, '')))];
}
// the text of a message: required, no control characters (a tab and a new line are fine), at most `max` long: it is NOT cut silently,
// because what was approved must be what is sent
function messageText(v, max, what = 'The message') {
  const t = String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!t) throw err(`${what} is empty.`);
  if (t.length > max) throw err(`${what} is too long (${t.length} characters; at most ${max}).`);
  return t;
}
const short = (t, n = 80) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const base = (deps, key, dflt) => deps.bases?.[key] || dflt;
const call = (deps, service, url, { method = 'POST', headers, body }) => request(url, { service, method, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), fetchImpl: deps.fetchImpl, sleep: deps.sleep });
const ghHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', 'User-Agent': 'WhisperBrain' });

const HANDLERS = {
  // chat.postMessage with the bot token of the person's own Slack app (it needs the chat:write scope, and the bot must be in the channel)
  'slack.post': {
    label: 'Slack',
    ready: ({ settings }) => !!settings.get('slack').token,
    build({ channel, text, threadTs } = {}) {
      const ch = String(channel || '').trim().replace(/^#/, '');
      if (!ch || /\s/.test(ch)) throw err('Name the Slack channel (its name, like general, or its id).');
      const ts = threadTs ? String(threadTs).trim() : '';
      if (ts && !/^\d{9,11}\.\d{3,8}$/.test(ts)) throw err('A thread is named by the time of its first message (like 1700000000.000100).');
      const body = messageText(text, LIMITS.slack);
      const where = /^[CGD][A-Z0-9]{7,}$/.test(ch) ? ch : `#${ch}`;
      return {
        title: `Post in Slack ${where}${ts ? ' (in a thread)' : ''}: “${short(body)}”`,
        args: { channel: ch, text: body, ...(ts ? { threadTs: ts } : {}) },
        outbound: { recipients: [`slack:${where}`, ...(ts ? [`slack:${where}/${ts}`] : [])], urls: urlsIn(body), text: body },
      };
    },
    async run(args, deps) {
      // links are not unfurled: Slack's servers would otherwise go and fetch whatever address the text holds
      const r = await call(deps, 'Slack', `${base(deps, 'slack', SLACK)}/chat.postMessage`, { headers: { Authorization: `Bearer ${deps.settings.get('slack').token}` }, body: { channel: args.channel, text: args.text, ...(args.threadTs ? { thread_ts: args.threadTs } : {}), unfurl_links: false, unfurl_media: false } });
      if (!r.json?.ok) throw err(`Slack: ${r.json?.error || 'failed'}${r.json?.error === 'missing_scope' ? ` (needs ${r.json.needed})` : ''}${r.json?.error === 'not_in_channel' ? ' (invite the app to the channel first)' : ''}`, 502);
      return { url: `https://slack.com/app_redirect?channel=${r.json.channel}&message_ts=${r.json.ts}`, ts: r.json.ts };
    },
  },

  // a comment on an issue or a pull request (GitHub treats both as issues for comments). The token needs write access to issues / pull requests.
  'github.comment': {
    label: 'GitHub',
    ready: ({ settings }) => !!settings.get('github').token,
    build({ repo, number, text } = {}) {
      const r = String(repo || '').trim(), n = Number(number);
      if (!REPO.test(r)) throw err('Name the repository like owner/name.');
      if (!Number.isInteger(n) || n < 1) throw err('Give the issue or pull request number.');
      const body = messageText(text, LIMITS.github, 'The comment');
      return {
        title: `Comment on GitHub ${r}#${n}: “${short(body)}”`,
        args: { repo: r, number: n, text: body },
        outbound: { recipients: [`github:${r}#${n}`], urls: urlsIn(body), text: body },
      };
    },
    async run(args, deps) {
      const res = await call(deps, 'GitHub', `${base(deps, 'github', GITHUB)}/repos/${args.repo}/issues/${args.number}/comments`, { headers: ghHeaders(deps.settings.get('github').token), body: { body: args.text } });
      return { url: res.json?.html_url || '' };
    },
  },

  'github.issue': {
    label: 'GitHub',
    ready: ({ settings }) => !!settings.get('github').token,
    build({ repo, title, text, labels } = {}) {
      const r = String(repo || '').trim();
      if (!REPO.test(r)) throw err('Name the repository like owner/name.');
      const head = messageText(title, 250, 'The title').replace(/\s+/g, ' ');
      const body = String(text ?? '').trim() ? messageText(text, LIMITS.github, 'The description') : '';
      const labs = [...new Set((Array.isArray(labels) ? labels : String(labels || '').split(',')).map((l) => String(l).trim()).filter(Boolean))].slice(0, 10);
      const all = `${head}\n\n${body}`.trim();
      return {
        title: `Open a GitHub issue in ${r}: “${short(head)}”`,
        args: { repo: r, title: head, text: body, labels: labs },
        outbound: { recipients: [`github:${r}`], urls: urlsIn(all), text: all },
      };
    },
    async run(args, deps) {
      const res = await call(deps, 'GitHub', `${base(deps, 'github', GITHUB)}/repos/${args.repo}/issues`, { headers: ghHeaders(deps.settings.get('github').token), body: { title: args.title, ...(args.text ? { body: args.text } : {}), ...(args.labels?.length ? { labels: args.labels } : {}) } });
      return { url: res.json?.html_url || '', number: res.json?.number };
    },
  },

  // a message from your own bot into a channel of your server. Nobody is pinged: mentions are switched off, and link previews are suppressed.
  'discord.send': {
    label: 'Discord',
    ready: ({ settings }) => !!settings.get('discord').token,
    build({ channelId, text, channelName } = {}) {
      const id = String(channelId || '').trim();
      if (!SNOWFLAKE.test(id)) throw err('Give the Discord channel id (a long number).');
      const body = messageText(text, LIMITS.discord);
      const nm = String(channelName || '').trim().replace(/^#/, '').slice(0, 80);
      return {
        title: `Send in Discord ${nm ? `#${nm}` : `channel ${id}`}: “${short(body)}”`,
        args: { channelId: id, text: body, ...(nm ? { channelName: nm } : {}) },
        outbound: { recipients: [`discord:${id}`], urls: urlsIn(body), text: body },
      };
    },
    async run(args, deps) {
      // allowed_mentions: none, so a text with @everyone or <@id> notifies nobody; flags 4 = no link embeds
      const r = await call(deps, 'Discord', `${base(deps, 'discord', DISCORD)}/channels/${args.channelId}/messages`, { headers: { Authorization: `Bot ${deps.settings.get('discord').token}`, 'User-Agent': 'WhisperBrain (local)' }, body: { content: args.text, allowed_mentions: { parse: [] }, flags: 4 } });
      return { url: `https://discord.com/channels/${r.json?.guild_id || '@me'}/${args.channelId}/${r.json?.id || ''}` };
    },
  },

  // a page under the parent chosen in Settings → Notion (never anywhere else: the parent is read from the settings, not from the request)
  'notion.page': {
    label: 'Notion',
    ready: ({ settings }) => !!settings.get('notion').token && !!settings.get('notion').parentId,
    build({ title, text } = {}, { settings }) {
      const cfg = settings.get('notion');
      if (!cfg.parentId) throw err('Pick the Notion page or database to add pages to (Integrations → Notion).', 412);
      const head = messageText(title, 200, 'The title').replace(/\s+/g, ' ');
      const body = String(text ?? '').trim() ? messageText(text, LIMITS.notion, 'The page') : '';
      const all = `${head}\n\n${body}`.trim();
      return {
        title: `Create the Notion page “${short(head, 70)}” in ${cfg.parentTitle || 'your chosen parent'}`,
        args: { parentId: cfg.parentId, parentKind: cfg.parentKind || 'page', parentTitle: cfg.parentTitle || '', title: head, text: body },
        outbound: { recipients: [`notion:${cfg.parentId}`], urls: urlsIn(all), text: all },
      };
    },
    async run(args, { integrations }) {
      const page = await integrations.notion().createPage({ parentId: args.parentId, parentKind: args.parentKind, title: args.title, markdown: args.text });
      return { url: page.url, id: page.id };
    },
  },

  'linear.comment': {
    label: 'Linear',
    ready: ({ settings }) => !!settings.get('linear').apiKey,
    build({ identifier, text } = {}) {
      const id = String(identifier || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(id)) throw err('Give the issue like ENG-12.');
      const body = messageText(text, LIMITS.linear, 'The comment');
      return {
        title: `Comment on Linear ${id}: “${short(body)}”`,
        args: { identifier: id, text: body },
        outbound: { recipients: [`linear:${id}`], urls: urlsIn(body), text: body },
      };
    },
    async run(args, { integrations }) {
      const linear = integrations.linear();
      const issue = await linear.issue(args.identifier);            // the comment needs the issue's own id
      const c = await linear.createComment({ issueId: issue.id, body: args.text });
      return { url: c.url || issue.url };
    },
  },
};

module.exports = { HANDLERS, urlsIn };
