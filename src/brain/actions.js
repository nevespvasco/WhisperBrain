'use strict';
// Actions that reach outside this computer (docs/adr/0001-brain-data-model.md). Nothing here ever runs by itself: an action is PROPOSED with
// its exact arguments, shown in the Inbox as plain words, and only an explicit approval runs it, with exactly those arguments. A prompt
// injected into an e-mail or a transcript can at most make a proposal that a person reads and rejects; there is no tool that skips this.
const crypto = require('node:crypto');

const newId = () => `ac_${crypto.randomBytes(6).toString('hex')}`;
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const row = (r) => r && ({ id: r.id, kind: r.kind, title: r.title, args: parse(r.args, {}), state: r.state, origin: r.origin, assertionId: r.assertion_id, result: parse(r.result, null), error: r.error, createdAt: r.created_at, decidedAt: r.decided_at });

class Actions {
  // handlers: { kind: { label, build(input, deps) -> { title, args }, run(args, deps) -> result } }
  constructor({ db, bus = null, handlers = {}, deps = {}, now = () => Date.now() }) { Object.assign(this, { db, bus, handlers, deps, now }); }

  get(id) { return row(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id)); }
  pending() { return this.db.prepare("SELECT * FROM actions WHERE state = 'pending' ORDER BY created_at").all().map(row); }
  recent(limit = 20) { return this.db.prepare("SELECT * FROM actions WHERE state <> 'pending' ORDER BY decided_at DESC LIMIT ?").all(limit).map(row); }
  kinds() { return Object.entries(this.handlers).map(([kind, h]) => ({ kind, label: h.label, ready: h.ready ? !!h.ready(this.deps) : true })); }

  // Make a proposal. It changes nothing anywhere.
  propose(kind, input = {}, { origin = 'user', assertionId = null } = {}) {
    const h = this.handlers[kind];
    if (!h) throw err(`unknown action "${kind}"`);
    if (h.ready && !h.ready(this.deps)) throw err(`${h.label} is not connected yet.`, 412);
    const { title, args } = h.build(input, this.deps);
    const id = newId();
    this.db.prepare('INSERT INTO actions (id, kind, title, args, origin, assertion_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, String(title).slice(0, 200), JSON.stringify(args), origin, assertionId, this.now());
    this.bus?.publish('actions.changed', { id });
    return this.get(id);
  }

  // A person said yes: run it once with the arguments that were shown.
  async approve(id) {
    const a = this.get(id);
    if (!a) throw err('not found', 404);
    if (a.state !== 'pending') throw err(`this action is already ${a.state}`, 409);
    const h = this.handlers[a.kind];
    this.db.prepare("UPDATE actions SET decided_at = ? WHERE id = ? AND state = 'pending'").run(this.now(), id);
    try {
      const result = await h.run(a.args, this.deps);
      this.db.prepare("UPDATE actions SET state = 'done', result = ? WHERE id = ?").run(JSON.stringify(result ?? null), id);
    } catch (e) {
      this.db.prepare("UPDATE actions SET state = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 500), id);
    }
    this.bus?.publish('actions.changed', { id });
    return this.get(id);
  }

  reject(id) {
    const a = this.get(id);
    if (!a) throw err('not found', 404);
    if (a.state !== 'pending') throw err(`this action is already ${a.state}`, 409);
    this.db.prepare("UPDATE actions SET state = 'rejected', decided_at = ? WHERE id = ?").run(this.now(), id);
    this.bus?.publish('actions.changed', { id });
    return this.get(id);
  }
}

// What can be done. Each is a plain, reviewable request.
const HANDLERS = {
  'linear.issue': {
    label: 'Linear',
    ready: ({ settings }) => !!settings.get('linear').apiKey && !!settings.get('linear').teamId,
    // from a promise the person accepted: the title is its text, the description says where it was said, with the words
    build({ assertion, note }, { settings }) {
      if (!assertion) throw err('an assertion is needed');
      const cfg = settings.get('linear');
      const lines = [assertion.text, '', assertion.owner?.name ? `Owner: ${assertion.owner.name}` : '', assertion.dueText ? `Due: ${assertion.dueText}` : '', assertion.quote ? `\n> ${assertion.quote}` : '', note ? `\nFrom the meeting “${note.title || 'untitled'}” (WhisperBrain).` : ''].filter((l) => l !== '');
      return { title: `Create a Linear issue in ${cfg.teamName || 'your team'}: “${assertion.text.slice(0, 80)}”`, args: { teamId: cfg.teamId, teamName: cfg.teamName || '', title: assertion.text.slice(0, 250), description: lines.join('\n') } };
    },
    async run(args, { integrations }) {
      const issue = await integrations.linear().createIssue({ teamId: args.teamId, title: args.title, description: args.description });
      return { identifier: issue.identifier, url: issue.url };
    },
  },
};

module.exports = { Actions, HANDLERS };
