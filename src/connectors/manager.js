'use strict';
// Runs the sources: adds folders and vaults, scans them as jobs (in their own lane, so a big vault never holds up the summary of a
// meeting), watches them for edits, and scans again every so often to catch what a watcher can miss.
const fs = require('node:fs');
const path = require('node:path');
const { FolderConnector } = require('./folder');

const RECONCILE_MS = 10 * 60_000;
const LANE = 'sources';
const err = (message, status = 400) => Object.assign(new Error(message), { status });

class SourceManager {
  // services: { github, slack, ... } (src/connectors/*.js) and ctx: what they need to reach the world ({ settings, google, integrations, app, fetchImpl, bases, sleep })
  constructor({ items, runner, bus = null, pdfToText = null, ocr = null, watch = true, reconcileMs = RECONCILE_MS, services = {}, ctx = {} }) {
    this.services = services;
    this.ctx = ctx;
    this.items = items;
    this.runner = runner;
    this.bus = bus;
    this.pdfToText = pdfToText;
    this.ocr = ocr;
    this.watchOn = watch;
    this.reconcileMs = reconcileMs;
    this.connectors = new Map();   // source id -> FolderConnector (only while it is enabled)
    this.timer = null;
    this.progress = new Map();     // source id -> { done, total } while a scan runs
    runner.register('source.sync', (payload) => this.sync(payload.sourceId), { lane: LANE });
  }

  // a service source (GitHub, Slack, Discord, Gmail, Notion/Linear polling): scanned with the service's own sync
  remote(source) {
    const svc = source.config?.remote && this.services[source.kind];
    if (!svc) return null;
    return { svc, scan: () => svc.sync({ ...this.ctx, source: this.items.source(source.id) || source, items: this.items }) };
  }

  connector(source) {
    const rem = this.remote(source);
    if (rem) return rem;
    if (!['folder', 'obsidian'].includes(source.kind) || !source.config?.path) return null;   // (imported meetings have no folder to read)
    const live = this.connectors.get(source.id);
    if (live) { live.source = source; return live; }
    const c = new FolderConnector({ source, items: this.items, pdfToText: this.pdfToText, ocr: this.ocr });
    this.connectors.set(source.id, c);
    return c;
  }

  // Start: every enabled folder source is scanned once and watched; then a periodic scan.
  start() {
    for (const s of this.items.sources()) if (s.enabled && this.connector(s)) { this.enqueueSync(s.id); this.watch(s); }
    if (this.reconcileMs > 0 && !this.timer) {
      this.timer = setInterval(() => { for (const s of this.items.sources()) if (s.enabled && this.connector(s) && this.due(s)) this.enqueueSync(s.id); }, this.reconcileMs);
      this.timer.unref?.();
    }
  }

  // a folder is scanned on every round; a service only when its own interval has passed (they have rate limits)
  due(s) { const svc = s.config?.remote && this.services[s.kind]; return !svc || !s.lastSyncAt || Date.now() - s.lastSyncAt >= svc.every; }

  stop() {
    clearInterval(this.timer); this.timer = null;
    for (const c of this.connectors.values()) c.unwatch();
    this.connectors.clear();
  }

  enqueueSync(sourceId) { return this.runner.enqueue('source.sync', { sourceId }, { key: sourceId, maxAttempts: 2 }); }

  watch(source) {
    if (!this.watchOn) return;
    const c = this.connector(source);
    c?.watch({
      onChange: () => this.bus?.publish('sources.changed', { id: source.id }),
      onError: (e) => this.items.markSync(source.id, { ok: false, error: `watching: ${e.message}` }),
    });
  }

  // path: a folder on this computer. flavour: 'obsidian' (a vault: skips its .obsidian folder, links notes back to Obsidian) or 'folder'.
  add({ path: dir, flavour = 'folder', name, sensitivity = 'normal', exclude = [], grant = {} } = {}) {
    const kind = flavour === 'obsidian' ? 'obsidian' : 'folder';
    let root;
    try { root = fs.realpathSync(path.resolve(String(dir || ''))); } catch { throw err(`The folder does not exist: ${dir}`); }
    if (!fs.statSync(root).isDirectory()) throw err(`This is not a folder: ${root}`);
    const twin = this.items.sources().find((s) => ['folder', 'obsidian'].includes(s.kind) && s.config.path === root);
    if (twin) throw err('This folder is already a source.', 409);
    const source = this.items.addSource({ kind, name: name || path.basename(root), mode: 'pointer', sensitivity, config: { path: root, exclude }, grant });
    this.watch(source);
    this.enqueueSync(source.id);
    return source;
  }

  // A service: the token is in Settings (sealed); what is added here is what to read (repositories, channels, a mail search).
  // grant: what the person chose in the access sheet (src/access/grants.js); a service reads the part it is given unless told otherwise
  addRemote({ kind, name, config = {}, sensitivity = 'private', grant = {} }) {
    const svc = this.services[kind];
    if (!svc) throw err(`unknown service "${kind}"`);
    if (!svc.ready(this.ctx, config)) throw err(`Connect ${kind} first: its token or sign-in is missing.`, 412);
    const level = { readLevel: 'part', ...grant };
    const checked = svc.validate(config, level);
    const source = this.items.addSource({ kind, name: name || `${kind}`, mode: 'copy', sensitivity, config: { ...checked, remote: true }, grant: level });
    this.enqueueSync(source.id);
    return source;
  }

  // The scan, as a job. Progress is kept for the Sources page; the result is the job's result.
  async sync(sourceId) {
    const source = this.items.source(sourceId);
    if (!source || !source.enabled) return { skipped: true };
    if (source.readLevel === 'none' || (source.expiresAt != null && source.expiresAt <= Date.now())) return { skipped: true, reason: 'access' };   // nothing may be read now
    const c = this.connector(source);
    if (!c) return { skipped: true };
    try {
      this.bus?.publish('sources.syncing', { id: sourceId });
      const r = await c.scan({ onProgress: (p) => { this.progress.set(sourceId, p); this.bus?.publish('sources.progress', { id: sourceId, ...p }); } });
      this.items.markSync(sourceId, { ok: true });
      if (source.config?.needsReconnect) this.items.updateSource(sourceId, { config: { needsReconnect: false } });
      this.progress.delete(sourceId);
      this.bus?.publish('sources.changed', { id: sourceId });
      return r;
    } catch (e) {
      this.progress.delete(sourceId);
      this.items.markSync(sourceId, { ok: false, error: e.message });
      if (['google-auth', 'outlook-auth'].includes(e.code) && !source.config?.needsReconnect) this.items.updateSource(sourceId, { config: { needsReconnect: true } });   // data and grant stay: the card offers one-click Reconnect
      this.bus?.publish('sources.changed', { id: sourceId });
      throw Object.assign(e, { permanent: e.permanent || e.code === 'unauthorized' || e.code === 'google-auth' || e.code === 'outlook-auth' || /does not exist|not a folder|No folder/.test(e.message) });
    }
  }

  pause(sourceId) {
    this.connectors.get(sourceId)?.unwatch();
    return this.items.updateSource(sourceId, { enabled: false });
  }

  resume(sourceId) {
    const s = this.items.updateSource(sourceId, { enabled: true });
    if (s && this.connector(s)) { this.watch(s); this.enqueueSync(sourceId); }
    return s;
  }

  remove(sourceId) {
    this.connectors.get(sourceId)?.unwatch();
    this.connectors.delete(sourceId);
    return this.items.removeSource(sourceId);
  }

  view() {
    return this.items.sources().map((s) => ({ ...s, syncing: this.progress.has(s.id) || this.runner.queue.db.prepare("SELECT 1 FROM jobs WHERE kind = 'source.sync' AND key = ? AND state IN ('queued','running')").get(s.id) != null, progress: this.progress.get(s.id) || null }));
  }
}

module.exports = { SourceManager, LANE };
