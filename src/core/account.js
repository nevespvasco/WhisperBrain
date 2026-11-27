'use strict';
// "Account" for a local-only app: who you are, where your data lives, exporting it, and the danger zone.
const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('./db');

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : (fs.statSync(p).size || 0);
    }
  } catch { /* missing */ }
  return total;
}

class Account {
  // semantic: the search-by-meaning index, which keeps a copy of the transcripts' text and vectors made from it
  constructor({ db, notes, settings, speakers, models, dataDir, bus, knowledge, semantic = null }) { Object.assign(this, { db, notes, settings, speakers, models, dataDir, bus, knowledge, semantic }); }

  summary() {
    const c = (sql) => this.db.prepare(sql).get().c;
    return {
      name: this.settings.get('userName'),
      dataDir: this.dataDir,
      modelsDir: this.models.dir,
      stats: {
        notes: c('SELECT COUNT(*) c FROM notes'), spaces: c('SELECT COUNT(*) c FROM folders'), segments: c('SELECT COUNT(*) c FROM segments'),
        voices: c('SELECT COUNT(*) c FROM voices'), chats: c('SELECT COUNT(*) c FROM chat_messages'),
        topics: c('SELECT COUNT(*) c FROM topics'), glossary: c('SELECT COUNT(*) c FROM glossary'), actions: c('SELECT COUNT(*) c FROM action_items'), tags: c('SELECT COUNT(*) c FROM tags'),
      },
      sizes: { dataBytes: dirSize(this.dataDir) - (this.models.dir.startsWith(this.dataDir) ? dirSize(this.models.dir) : 0), modelBytes: dirSize(this.models.dir) },
    };
  }

  // Full JSON backup (no secrets, no voice embeddings).
  exportJson() {
    const notes = this.notes.list({ limit: 100000 }).map((n) => ({
      ...n, transcript: this.notes.segments(n.id).map(({ id, ...s }) => s), speakers: this.speakers.publicForNote(n.id), chat: this.notes.chatHistory(n.id),
      ...(this.knowledge ? { tags: this.knowledge.noteTags(n.id).map((t) => t.name), topics: this.knowledge.noteTopics(n.id).map((t) => ({ name: t.name, summary: t.summary })),
        actionItems: this.knowledge.actionItems({ noteId: n.id }).map((a) => ({ text: a.text, owner: a.owner, due: a.due, done: a.done })),
        snippets: this.knowledge.snippets({ noteId: n.id }).map((x) => ({ text: x.text, speaker: x.speaker, startMs: x.startMs, label: x.label })),
        links: this.knowledge.links(n.id).map(({ id, ...l }) => l) } : {}),
    }));
    const settings = this.settings.publicView();
    delete settings.llm.apiKey;
    for (const k of ['google', 'microsoft', 'googleMeet', 'zoom', 'notion', 'linear']) delete settings[k];
    settings.webhooks = settings.webhooks.map(({ secret, ...w }) => w);
    const glossary = this.knowledge ? this.knowledge.glossary().map(({ id, noteId, noteTitle, ...g }) => g) : [];
    return { app: 'whisperbrain', format: 2, exportedAt: new Date().toISOString(), spaces: this.notes.folders(), notes, glossary, templates: this.db.prepare('SELECT id, name, prompt FROM templates').all(), voices: this.speakers.publicVoices(), settings };
  }

  exportMarkdown() {
    const spaces = Object.fromEntries(this.notes.folders().map((f) => [f.id, f.name]));
    return this.notes.list({ limit: 100000 }).map((n) => {
      const md = this.notes.exportMarkdown(n.id);
      return n.folderId ? md.replace(/\n/, `\n\n_Space: ${spaces[n.folderId] || ''}_\n`) : md;
    }).join('\n\n---\n\n');
  }

  // ---- danger zone ----
  // Delete the meetings older than `days` (0 = keep everything). A meeting still being recorded is never touched. -> how many
  applyRetention({ days, now = Date.now() } = {}) {
    if (!(days > 0)) return 0;
    const cutoff = now - days * 86400000;
    const old = this.db.prepare("SELECT id FROM notes WHERE status != 'recording' AND COALESCE(ended_at, created_at) < ?").all(cutoff);
    for (const { id } of old) this.notes.remove(id);
    if (old.length) this.semantic?.prune();
    if (old.length) this.bus?.publish('account.changed', { what: 'retention', deleted: old.length });
    return old.length;
  }

  deleteTranscripts() {
    const n = tx(this.db, () => {
      const count = this.db.prepare('DELETE FROM segments').run().changes;
      this.db.prepare('DELETE FROM note_speakers').run();
      this.db.prepare('DELETE FROM evidence').run();
      this.db.prepare('DELETE FROM semantic_chunks').run();   // the text copy kept for search by meaning
      return count;
    });
    this.semantic?.prune();     // and the vectors made from it (when the extension is loaded; otherwise at the next start)
    for (const { id } of this.db.prepare('SELECT id FROM notes').all()) this.notes.reindex(id);
    this.bus?.publish('account.changed', { what: 'transcripts' });
    return n;
  }

  deleteVoices() { const n = this.speakers.removeAllVoices(); this.bus?.publish('account.changed', { what: 'voices' }); return n; }

  // Everything the user created. Downloaded models are kept unless removeModels is set (they are re-downloadable but large).
  // Everything read from sources (mail, chat, files), what was worked out from it (people, promises, the search index), and the
  // records of AI calls, actions and access go too: "everything" that left the brain's own meetings behind would only look deleted.
  // The app lock's passphrase stays (index_meta), so the emptied app is still locked. The copies the app made of the database
  // before each update (whisperbrain.sqlite.before-vN, next to it) are deleted too; backups in a folder you chose are yours and
  // are listed, not deleted (Settings > Backups).
  deleteEverything({ removeModels = false, removeCopies = true } = {}) {
    const has = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    tx(this.db, () => {
      for (const t of ['chat_messages', 'snippets', 'action_items', 'note_tags', 'note_topics', 'note_links', 'segment_translations', 'note_translations', 'segments', 'note_speakers', 'note_briefings', 'briefings',
        'assistant_events', 'search', 'notes', 'folders', 'evidence', 'semantic_chunks', 'templates', 'voice_exemplars', 'voices', 'tags', 'topics', 'glossary', 'event_prefs', 'settings',
        // the brain: sources and what came from them, what was worked out, and the records
        'rule_runs', 'rules', 'reminders', 'actions', 'assertions', 'projects', 'mentions', 'entity_proposals', 'entity_merges', 'entity_identities', 'entities',
        'index_owner', 'chunks', 'items', 'sources', 'ai_runs', 'access_log', 'jobs']) if (has.has(t)) this.db.exec(`DELETE FROM ${t}`);
      for (const f of ['items_fts', 'chunks_fts']) if (has.has(f)) this.db.exec(`INSERT INTO ${f}(${f}) VALUES ('delete-all')`);
      this.db.exec("INSERT INTO seg_fts(seg_fts) VALUES ('rebuild')");
    });
    this.chunkIndex?.forgetVectors();
    this.settings.reset();
    this.semantic?.prune();
    this.db.exec('VACUUM');
    if (removeCopies) this.removeCopies();
    if (removeModels) for (const m of this.models.catalog) this.models.remove(m.id);
    this.bus?.publish('account.changed', { what: 'all' });
    return true;
  }
}

// The database copies the app wrote before updating its schema (db.js backupBeforeMigrating): whisperbrain.sqlite.before-vN.
Account.prototype.copies = function copies() {
  const file = this.dbFile;
  if (!file) return [];
  const dir = path.dirname(file), base = path.basename(file);
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.before-v`)).map((f) => path.join(dir, f)); } catch { return []; }
};
Account.prototype.removeCopies = function removeCopies() {
  let n = 0;
  for (const f of this.copies()) { try { fs.rmSync(f, { force: true }); n++; } catch { /* in use: listed again next time */ } }
  return n;
};

module.exports = { Account };
