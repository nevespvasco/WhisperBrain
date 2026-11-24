'use strict';
const { newId } = require('./ids');

// Built-in summary templates. `prompt` describes the structure of the output; the system prompt
// (llm/prompts.js) adds the shared rules (use the user's own notes as the backbone, don't invent facts).
const BUILTIN = [
  {
    id: 'general', name: 'General meeting',
    prompt: 'Produce: a one-sentence overview, then "## Key points" (bullets), "## Decisions" (bullets, omit if none), and "## Action items" as a checklist ("- [ ] Owner: task (due date if mentioned)").',
  },
  {
    id: 'one-on-one', name: '1:1',
    prompt: 'Produce "## Updates", "## Blockers and concerns", "## Feedback" (both directions), "## Career and growth" (omit if absent) and "## Action items" as a checklist.',
  },
  {
    id: 'standup', name: 'Stand-up',
    prompt: 'For each speaker produce "### Name" with "Yesterday", "Today", "Blockers" bullets. End with "## Follow-ups" as a checklist.',
  },
  {
    id: 'customer-call', name: 'Customer call',
    prompt: 'Produce "## Who they are" (role, company, context), "## Pain points", "## Needs and requirements", "## Objections", "## Next steps" as a checklist with owners and dates.',
  },
  {
    id: 'interview', name: 'Interview',
    prompt: 'Produce "## Candidate background", "## Strengths" (with evidence quoted briefly), "## Concerns" (with evidence), "## Answers to key questions" and "## Recommendation" (hire / no hire / unsure, with reasoning).',
  },
  {
    id: 'brainstorm', name: 'Brainstorm',
    prompt: 'Group the ideas into themes under "## Themes"; for each idea note who raised it when known. End with "## Favorites" (what the group converged on) and "## Open questions".',
  },
];

class Templates {
  constructor(db) { this.db = db; }

  list() {
    const custom = this.db.prepare('SELECT id, name, prompt FROM templates ORDER BY created_at').all()
      .map((t) => ({ ...t, builtin: false }));
    return [...BUILTIN.map((t) => ({ ...t, builtin: true })), ...custom];
  }

  get(id) { return this.list().find((t) => t.id === id) || null; }

  create({ name, prompt }) {
    if (!name?.trim() || !prompt?.trim()) throw new Error('name and prompt are required');
    const id = newId();
    this.db.prepare('INSERT INTO templates(id, name, prompt, created_at) VALUES(?, ?, ?, ?)').run(id, name.trim(), prompt.trim(), Date.now());
    return this.get(id);
  }

  update(id, { name, prompt }) {
    if (BUILTIN.some((t) => t.id === id)) throw new Error('built-in templates are read-only');
    const cur = this.get(id);
    if (!cur) return null;
    this.db.prepare('UPDATE templates SET name = ?, prompt = ? WHERE id = ?').run((name ?? cur.name).trim(), (prompt ?? cur.prompt).trim(), id);
    return this.get(id);
  }

  remove(id) {
    if (BUILTIN.some((t) => t.id === id)) throw new Error('built-in templates are read-only');
    return this.db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
  }
}

module.exports = { Templates, BUILTIN };
