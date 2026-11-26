'use strict';
// Notion pages and Linear issues you imported, kept up to date: each is read again every few hours and the meeting is updated when the
// page or issue changed (the importer compares a hash, so an unchanged one does nothing). Only what you already imported is followed:
// nothing new is pulled in by itself.
const MAX_REFS = 100;
const every = 6 * 3600_000;

function make(kind) {
  const label = kind === 'notion' ? 'Notion' : 'Linear';
  const ready = ({ settings }) => (kind === 'notion' ? !!settings.get('notion').token : !!settings.get('linear').apiKey);
  return {
    kind, every, label,
    validate: () => ({ poll: true }),
    ready,
    check: async ({ integrations }) => (kind === 'notion' ? { ok: true, ...(await integrations.notion().me()) } : { ok: true, viewer: await integrations.linear().viewer() }),
    async sync({ source, items, settings, integrations, app }) {
      if (!ready({ settings })) throw Object.assign(new Error(`Connect ${label} first (Integrations).`), { permanent: true });
      const refs = app.db.prepare('SELECT source_ref AS ref FROM notes WHERE source = ? AND source_ref IS NOT NULL ORDER BY updated_at DESC LIMIT ?').all(kind, MAX_REFS).map((r) => r.ref);
      const out = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
      for (let i = 0; i < refs.length; i += 10) {
        let res;
        try { res = await (kind === 'notion' ? integrations.importNotion(refs.slice(i, i + 10)) : integrations.importLinear(refs.slice(i, i + 10))); } catch (e) { if (e.code === 'rate-limited' || /429/.test(e.message)) throw e; out.errors += refs.slice(i, i + 10).length; continue; }
        for (const r of res) { if (r.unchanged) out.unchanged++; else if (r.updated) out.updated++; else out.created++; }
      }
      items.updateSource(source.id, { cursor: String(Date.now()) });
      return out;
    },
  };
}

module.exports = { notion: make('notion'), linear: make('linear') };
