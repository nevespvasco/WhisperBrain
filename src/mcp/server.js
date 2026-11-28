'use strict';
// A Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0), READ-ONLY: other tools (Claude Code, Claude Desktop,
// Cursor, a launcher) can ask your brain a question. It opens the database read-only, so it can never change anything, and it never
// shows anything from a source marked private: whoever is on the other end may be a remote model. Only what is accepted counts:
// commitments and decisions you did not accept are not shared.
const { DatabaseSync } = require('node:sqlite');
const { Notes } = require('../core/notes');
const { ItemStore } = require('../items/store');
const { ChunkIndex } = require('../search/index');
const { can } = require('../access/grants');
const { MCP_FRESH_MS } = require('../core/lock');

const PROTOCOL = '2025-06-18';
const NEEDS_SCHEMA = 19;
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const TOOLS = [
  { name: 'search', description: 'Search the user\'s meetings and notes (by words; by meaning when an embedding model is set up). Returns excerpts with where each comes from.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 6 } }, required: ['query'] } },
  { name: 'get_note', description: 'The text of one note or file (id from a search result), or a meeting\'s title and summary.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_people', description: 'People the user has met, with how many meetings and when last. Optional name filter.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'get_person', description: 'One person: how they are known, recent meetings, and the promises open between them and the user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'open_commitments', description: 'Promises the user accepted that are not done yet: what they owe and what others owe them.', inputSchema: { type: 'object', properties: {} } },
  { name: 'recent_decisions', description: 'Decisions the user accepted, newest first.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 } } } },
];

class BrainReader {
  constructor(db) {
    this.db = db;
    this.notes = new Notes(db);
    this.items = new ItemStore(db);
    this.index = new ChunkIndex({ db, notes: this.notes, items: this.items });
  }

  // While WhisperBrain is locked (src/core/lock.js), nothing is served: the lock screen must not be walked around through MCP.
  // A passphrase is set and the app has not said it is unlocked (it writes lock:state; it starts locked), or has not said so lately:
  // the app writes lock:seen every 30 s, so a crashed app (that never wrote 'locked' on its way out) reads as locked.
  locked() {
    const meta = (k) => { try { return this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(`lock:${k}`)?.value ?? null; } catch { return null; } };
    if (!meta('hash')) return false;
    return meta('state') !== 'unlocked' || !(Date.now() - Number(meta('seen')) < MCP_FRESH_MS);
  }

  static open(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    const v = db.prepare('PRAGMA user_version').get().user_version;
    if (v < NEEDS_SCHEMA) { db.close(); throw new Error(`This WhisperBrain database is older than the brain (schema ${v}, needs ${NEEDS_SCHEMA}). Open WhisperBrain once to update it.`); }
    return new BrainReader(db);
  }

  // What MCP may serve, by each source's grant (src/access/grants.js, op 'mcp': switched on for that source, and not kept local).
  // A meeting follows the source it came from; one not yet filed under a source is the recorder's.
  allowed() {
    const sources = new Map();
    const src = (id) => { if (!sources.has(id)) sources.set(id, this.items.source(id)); return sources.get(id); };
    return (kind, id) => {
      if (kind === 'note') { const s = this.items.sourceOfNote(id); return s ? can(s, 'mcp') : true; }
      if (kind !== 'item') return false;
      const it = this.items.item(id);
      return !!it && can(src(it.sourceId), 'mcp', { item: it });
    };
  }

  async search({ query, limit = 6 }) {
    const hits = await this.index.search(String(query || ''), { limit: Math.max(1, Math.min(20, limit)), allow: this.allowed() });
    return hits.map((h) => ({ id: h.id, kind: h.kind === 'note' ? 'meeting' : 'note', title: h.title, text: h.text.slice(0, 1000), when: h.at ? new Date(h.at).toISOString().slice(0, 10) : null, uri: h.uri || undefined }));
  }

  getNote({ id }) {
    const item = this.items.item(String(id));
    if (item && !item.deletedAt) {
      if (!this.allowed()('item', item.id)) throw new Error('This note is in a private source and is not shared.');
      return { id: item.id, kind: 'note', title: item.title, text: item.text.slice(0, 20000), uri: item.uri || undefined };
    }
    const n = this.notes.get(String(id));
    if (n && !this.allowed()('note', n.id)) throw new Error('This meeting is in a source that is not shared over MCP.');
    if (n) return { id: n.id, kind: 'meeting', title: n.title, when: new Date(n.startedAt || n.createdAt).toISOString().slice(0, 10), summary: n.summary, notes: n.body };
    throw new Error('Not found.');
  }

  // People, promises and decisions come only from meetings MCP may serve: somebody met only in a meeting whose source is not
  // shared is not listed, and that meeting is not counted (each note checked once per call).
  noteFilter() {
    const ok = this.allowed(), seen = new Map();
    return (id) => { if (!seen.has(id)) seen.set(id, ok('note', id)); return seen.get(id); };
  }

  people(query, shared = this.noteFilter()) {
    const by = new Map();
    for (const m of this.db.prepare('SELECT e.id, e.name, m.note_id, m.at FROM entities e JOIN mentions m ON m.entity_id = e.id WHERE e.merged_into IS NULL').all()) {
      if (!shared(m.note_id)) continue;
      const p = by.get(m.id) || by.set(m.id, { name: m.name, notes: new Set(), lastAt: 0 }).get(m.id);
      p.notes.add(m.note_id); p.lastAt = Math.max(p.lastAt, m.at || 0);
    }
    const rows = [...by.values()].map((p) => ({ name: p.name, meetings: p.notes.size, lastAt: p.lastAt })).sort((a, b) => b.meetings - a.meetings || b.lastAt - a.lastAt);
    const q = fold(query || '');
    return rows.filter((r) => !q || fold(r.name).includes(q)).slice(0, 100).map((r) => ({ name: r.name, meetings: r.meetings, last: r.lastAt ? new Date(r.lastAt).toISOString().slice(0, 10) : null }));
  }

  // a promise or decision typed with no meeting behind it is the user's own and is shared; one from a meeting follows that meeting
  accepted(kind, limit = 200, shared = this.noteFilter()) {
    return this.db.prepare(`SELECT a.*, n.title AS noteTitle FROM assertions a LEFT JOIN notes n ON n.id = a.note_id WHERE a.state = 'accepted' AND a.kind = ? ORDER BY a.occurred_at DESC`).all(kind)
      .filter((a) => !a.note_id || shared(a.note_id)).slice(0, limit)
      .map((a) => ({ text: a.text, owner: a.owner_name || undefined, to: a.to_name || undefined, due: a.due_at ? new Date(a.due_at).toISOString().slice(0, 10) : undefined, said: a.quote || undefined, meeting: a.noteTitle || undefined, when: new Date(a.occurred_at).toISOString().slice(0, 10) }));
  }

  openCommitments() {
    const me = fold(this.db.prepare("SELECT value FROM settings WHERE key = 'userName'").get()?.value?.replace(/^"|"$/g, '') || '');
    const all = this.accepted('commitment', 500);
    return { youOwe: all.filter((a) => me && fold(a.owner || '') === me), owedToYou: all.filter((a) => !(me && fold(a.owner || '') === me)) };
  }

  person({ name }) {
    const key = fold(name);
    const shared = this.noteFilter();
    const seenIn = (r) => r && this.db.prepare('SELECT note_id FROM mentions WHERE entity_id = ?').all(r.id).some((m) => shared(m.note_id));
    let row = this.db.prepare(`SELECT e.* FROM entities e WHERE e.merged_into IS NULL AND (e.key = ? OR e.id IN (SELECT entity_id FROM entity_identities WHERE kind = 'name' AND value = ?))`).get(key, key);
    if (!seenIn(row)) row = this.people(name, shared).length ? this.db.prepare('SELECT e.* FROM entities e WHERE e.merged_into IS NULL AND e.name LIKE ?').all(`%${name}%`).find(seenIn) : null;
    if (!row) throw new Error('Nobody by that name.');   // also somebody met only in meetings that are not shared
    const idents = this.db.prepare('SELECT kind, value FROM entity_identities WHERE entity_id = ?').all(row.id);
    const meetings = this.db.prepare(`SELECT n.id, n.title, n.created_at AS at FROM mentions m JOIN notes n ON n.id = m.note_id WHERE m.entity_id = ? GROUP BY n.id ORDER BY n.created_at DESC`).all(row.id).filter((n) => shared(n.id)).slice(0, 8).map((n) => ({ id: n.id, title: n.title, when: new Date(n.at).toISOString().slice(0, 10) }));
    const mine = new Set(this.db.prepare('SELECT note_id FROM mentions WHERE entity_id = ?').all(row.id).map((r) => r.note_id).filter(shared));
    const promises = this.accepted('commitment', 500, shared).filter((a) => fold(a.owner || '') === fold(row.name) || (a.to && fold(a.to) === fold(row.name)));
    return { name: row.name, emails: idents.filter((i) => i.kind === 'email').map((i) => i.value), accounts: idents.filter((i) => i.kind === 'account').map((i) => i.value), alsoKnownAs: idents.filter((i) => i.kind === 'name').map((i) => i.value), recentMeetings: meetings, openPromises: promises, meetingsCount: mine.size };
  }

  async call(name, args = {}) {
    if (this.locked()) throw new Error('WhisperBrain is locked. Unlock it in the app first.');
    switch (name) {
      case 'search': return this.search(args);
      case 'get_note': return this.getNote(args);
      case 'list_people': return this.people(args.query);
      case 'get_person': return this.person(args);
      case 'open_commitments': return this.openCommitments();
      case 'recent_decisions': return this.accepted('decision', Math.max(1, Math.min(50, args.limit || 15)));
      default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
  }
}

// One JSON-RPC message → a response object, or null for a notification.
async function handle(reader, msg) {
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.id === undefined) return null;                                         // a notification (e.g. notifications/initialized)
  if (msg.method === 'initialize') return ok({ protocolVersion: msg.params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'whisperbrain', version: '1' }, instructions: 'Read-only access to the user\'s own meetings, notes, people and accepted decisions and promises. Nothing from private sources is shared.' });
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    if (!TOOLS.some((t) => t.name === msg.params?.name)) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
    try { return ok({ content: [{ type: 'text', text: JSON.stringify(await reader.call(msg.params.name, msg.params.arguments || {}), null, 2) }] }); } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e.message }] }); }
  }
  return fail(-32601, `Method not found: ${msg.method}`);
}

// stdio: one JSON message per line in, one per line out. Logs go to stderr, never to stdout (that would corrupt the protocol).
function serve(reader, { input = process.stdin, output = process.stdout } = {}) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue; }
      const res = await handle(reader, msg);
      if (res) output.write(`${JSON.stringify(res)}\n`);
    }
  });
}

module.exports = { BrainReader, handle, serve, TOOLS };
