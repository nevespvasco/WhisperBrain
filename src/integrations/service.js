'use strict';
// Sends meetings to other tools (Notion, Obsidian, Linear, webhooks) and brings material back in.
// Clients are built from settings on every call so a changed token takes effect immediately.
const { NotionClient } = require('./notion');
const { LinearClient, actionItemsToIssues } = require('./linear');
const { ObsidianVault } = require('./obsidian');
const { postWebhook } = require('./webhook');
const { isLanguage } = require('../llm/languages');
const { toMarkdown } = require('../knowledge/meeting');

const err = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

class Integrations {
  constructor({ app, fetchImpl = globalThis.fetch }) { this.app = app; this.fetch = fetchImpl; }

  get settings() { return this.app.settings; }

  notion() { const c = this.settings.get('notion'); if (!c.token) throw err('Connect Notion first: add an integration token in Integrations.', 412, 'not-configured'); return new NotionClient({ token: c.token, fetchImpl: this.fetch }); }
  linear() { const c = this.settings.get('linear'); if (!c.apiKey) throw err('Connect Linear first: add a personal API key in Integrations.', 412, 'not-configured'); return new LinearClient({ apiKey: c.apiKey, fetchImpl: this.fetch }); }
  obsidian() { const c = this.settings.get('obsidian'); if (!c.vaultPath) throw err('Choose your Obsidian vault folder in Integrations first.', 412, 'not-configured'); return new ObsidianVault({ vaultPath: c.vaultPath, folder: c.folder, transcript: c.transcript }); }

  // Discord without a bot: what the card shows (the call is only how many people are in it, and its name)
  discordRpcStatus() {
    const c = this.settings.get('discordRpc');
    const st = this.app.discordRpc?.status() || { state: 'off', detail: '', call: null };
    return { configured: !!(c.clientId && c.clientSecret), enabled: c.enabled, authorised: !!c.accessToken, clientId: c.clientId, state: st.state, detail: st.detail, user: st.user ? st.user.name : null, call: st.call ? { id: st.call.id, name: st.call.name, people: st.call.people.length } : null };
  }

  status() {
    const s = this.settings;
    const g = s.get('google');
    return {
      notion: { configured: !!s.get('notion').token, parentId: s.get('notion').parentId, parentTitle: s.get('notion').parentTitle, parentKind: s.get('notion').parentKind, autoExport: s.get('notion').autoExport },
      linear: { configured: !!s.get('linear').apiKey, teamId: s.get('linear').teamId, teamName: s.get('linear').teamName },
      obsidian: { configured: !!s.get('obsidian').vaultPath, ...s.get('obsidian') },
      google: { configured: !!g.clientId, connected: !!g.refreshToken, email: g.email, calendars: g.calendars },
      webhooks: s.publicView().webhooks,
      discordRpc: this.discordRpcStatus(),
      discord: { configured: !!s.get('discord').token, enabled: s.get('discord').enabled, userId: s.get('discord').userId, guildId: s.get('discord').guildId, channelId: s.get('discord').channelId, call: this.app.discord?.status() || { joined: false } },
    };
  }

  async test(kind) {
    if (kind === 'notion') return { ok: true, ...(await this.notion().me()) };
    if (kind === 'linear') { const l = this.linear(); const [viewer, teams] = await Promise.all([l.viewer(), l.teams()]); return { ok: true, viewer, teams }; }
    if (kind === 'obsidian') return this.obsidian().check();
    if (kind === 'discord') {
      if (this.app.recording.status().active) throw err('Stop the recording first: the test joins your call by itself.', 409, 'busy');
      try { return await this.app.discord.probe(); } finally { this.app.discord.leave(); }
    }
    throw err('unknown integration');
  }

  // ---- out ----
  async send(noteId, { target, webhookId, teamId, mode = 'issue', transcript, itemIds, lang, translation } = {}) {
    const { app } = this;
    const m = app.meeting(noteId, lang && ['translation', 'both'].includes(translation) && isLanguage(lang) ? { lang, mode: translation } : undefined);   // with its translation, when asked
    if (!m) throw err('note not found', 404);
    const link = (l) => app.knowledge.addLink(noteId, l);
    if (target === 'notion') {
      const c = this.settings.get('notion');
      if (!c.parentId) throw err('Pick a Notion page or database to export into (Integrations → Notion).', 412, 'no-parent');
      const page = await this.notion().createPage({ parentId: c.parentId, parentKind: c.parentKind, title: m.title, markdown: toMarkdown(m, { transcript: transcript ?? false }).replace(/^# .*\n+/, ''), icon: '🎙️' });
      return { target, url: page.url, link: link({ kind: 'notion', ref: page.id, url: page.url, title: `Notion: ${m.title}` }) };
    }
    if (target === 'obsidian') {
      const r = this.obsidian().writeNote(m);
      return { target, path: r.path, url: r.uri, link: link({ kind: 'obsidian', ref: r.relPath, url: r.uri, title: `Obsidian: ${r.relPath}` }) };
    }
    if (target === 'linear') {
      const cfg = this.settings.get('linear');
      const team = teamId || cfg.teamId;
      if (!team) throw err('Pick a Linear team (Integrations → Linear).', 412, 'no-team');
      const l = this.linear();
      if (mode === 'actions') {
        const items = app.knowledge.actionItems({ noteId }).filter((a) => !a.done && !a.extUrl && (!itemIds || itemIds.includes(a.id)));
        if (!items.length) throw err('There are no open action items to send.', 400, 'nothing');
        const users = await l.users().catch(() => []);
        const inputs = actionItemsToIssues({ ...m, actionItems: items.map((a) => ({ text: a.text, owner: a.owner, due: a.due, done: false })) }, { teamId: team, users });
        const created = [];
        for (let i = 0; i < inputs.length; i++) {
          const issue = await l.createIssue(inputs[i]);
          app.knowledge.updateAction(items[i].id, { ext: { kind: 'linear', id: issue.identifier, url: issue.url } });
          link({ kind: 'linear', ref: issue.identifier, url: issue.url, title: `${issue.identifier} ${issue.title}` });
          created.push(issue);
        }
        return { target, issues: created };
      }
      const issue = await l.createIssue({ teamId: team, title: m.title.slice(0, 250), description: toMarkdown(m, { transcript: false }).replace(/^# .*\n+/, '') });
      return { target, url: issue.url, issues: [issue], link: link({ kind: 'linear', ref: issue.identifier, url: issue.url, title: `${issue.identifier} ${issue.title}` }) };
    }
    if (target === 'webhook') {
      const hook = this.settings.get('webhooks').find((w) => w.id === webhookId);
      if (!hook) throw err('webhook not found', 404);
      const r = await postWebhook({ url: hook.url, secret: hook.secret, fetchImpl: this.fetch, payload: { event: 'meeting.exported', meeting: { ...m, markdown: toMarkdown(m, { transcript: transcript ?? true }) } } });
      return { target, status: r.status };
    }
    throw err('unknown target');
  }

  // Background exports configured as automatic (after a meeting is enhanced).
  async autoExport(noteId) {
    const done = [];
    const s = this.settings;
    const tryIt = async (opts) => { try { done.push(await this.send(noteId, opts)); } catch (e) { this.app.bus.publish('export.failed', { noteId, target: opts.target, message: e.message }); } };
    if (s.get('obsidian').autoExport && s.get('obsidian').vaultPath) await tryIt({ target: 'obsidian' });
    if (s.get('notion').autoExport && s.get('notion').token && s.get('notion').parentId) await tryIt({ target: 'notion' });
    for (const w of s.get('webhooks').filter((x) => x.auto)) await tryIt({ target: 'webhook', webhookId: w.id });
    if (done.length) this.app.bus.publish('export.done', { noteId, targets: done.map((d) => d.target) });
    return done;
  }

  // ---- in ----
  async importNotion(pageIds, { folderId } = {}) {
    const n = this.notion();
    const out = [];
    for (const id of pageIds.slice(0, 50)) {
      const p = await n.pageToMarkdown(id);
      out.push(this.app.importer.importMarkdown(`# ${p.title}\n\n${p.markdown}`, { title: p.title, date: Date.parse(p.createdTime) || null, source: 'notion', sourceRef: p.id, folderId, link: { kind: 'notion', ref: p.id, url: p.url, title: `Notion: ${p.title}` } }));
    }
    return out;
  }

  importObsidian(paths, { folderId } = {}) {
    const v = this.obsidian();
    const vault = require('node:path').basename(this.settings.get('obsidian').vaultPath);
    return paths.slice(0, 200).map((rel) => {
      const r = v.readNote(rel);
      const fm = r.frontmatter || {};
      const md = `---\n${Object.entries(fm).map(([k, val]) => `${k}: ${Array.isArray(val) ? `[${val.join(', ')}]` : val}`).join('\n')}\n---\n# ${r.title}\n\n${r.body.replace(/^# .*\n+/, '')}`;
      const uri = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(rel.replace(/\.md$/i, ''))}`;
      return this.app.importer.importMarkdown(md, { title: r.title, date: Date.parse(fm.date) || r.mtime || null, source: 'obsidian', sourceRef: rel, folderId, link: { kind: 'obsidian', ref: rel, url: uri, title: `Obsidian: ${rel}` } });
    });
  }

  async importLinear(ids, { folderId } = {}) {
    const l = this.linear();
    const out = [];
    for (const id of ids.slice(0, 50)) {
      const i = await l.issue(id);
      const md = `# ${i.identifier} ${i.title}\n\n${i.description || ''}\n\n${(i.comments || []).length ? `## Discussion\n\n${i.comments.map((c) => `- **${c.user || 'Someone'}** (${String(c.createdAt).slice(0, 10)}): ${c.body.replace(/\n+/g, ' ')}`).join('\n')}` : ''}`;
      out.push(this.app.importer.importMarkdown(md, { title: `${i.identifier} ${i.title}`, source: 'linear', sourceRef: i.identifier, folderId, link: { kind: 'linear', ref: i.identifier, url: i.url, title: `${i.identifier} ${i.title}` } }));
    }
    return out;
  }
}

module.exports = { Integrations };
