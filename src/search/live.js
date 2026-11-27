'use strict';
// Live search (docs/access.md): ask the service itself, not only the copy kept here, so mail older or outside the part that was synced can
// still be found. Only sources whose grant allows it (search.live) are asked, only with the grant's own filter added, and what comes
// back is checked against it again. Answers are cached briefly, keyed by the question AND a hash of the grant, so changing a grant never
// serves what the old one allowed. A body opened from a result becomes a "live" item that expires (the grant's retention) unless kept.
//
// An adapter per service: { provider, label, supports(source, ctx), search({ source, query, limit, ctx }) -> [{ externalId, title, snippet,
// uri, at, who, kind }], open({ source, externalId, ctx }) -> the payload items.upsert takes }.
const crypto = require('node:crypto');
const { can } = require('../access/grants');

const TTL_MS = 15 * 60_000;
const DAY = 86_400_000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

// what decides which results a source may give: its level, its filter and what it was set to read
const grantHash = (source) => sha(JSON.stringify({ l: source.readLevel, f: source.filter, c: source.config, e: source.expiresAt || 0 }));

class LiveSearch {
  constructor({ db, items, accessLog = null, ctx = {}, adapters = [], ttlMs = TTL_MS, now = () => Date.now() }) {
    Object.assign(this, { db, items, accessLog, ctx, ttlMs, now });
    this.adapters = new Map();
    for (const a of adapters) this.register(a);
  }

  register(adapter) { this.adapters.set(adapter.provider, adapter); return this; }
  adapterFor(source) { return this.adapters.get(source.kind) || null; }

  // the sources a question may be sent to right now
  eligible(sourceIds = null) {
    return this.items.sources().filter((s) => s.enabled && (!sourceIds || sourceIds.includes(s.id)) && can(s, 'search.live', { now: this.now() }) && this.adapterFor(s)?.supports?.(s, this.ctx) !== false);
  }

  // -> { results: [{ sourceId, sourceName, provider, externalId, title, snippet, uri, at, who, kept }], searched: [{ source, provider, cached, count, error? }] }
  async search(query, { sourceIds = null, limit = 8, force = false } = {}) {
    const q = String(query || '').trim().slice(0, 300);
    const out = { results: [], searched: [] };
    if (!q) return out;
    for (const source of this.eligible(sourceIds)) {
      const adapter = this.adapterFor(source);
      const key = sha(`${q}\n${grantHash(source)}`);
      let hits = null, cached = false;
      const row = force ? null : this.db.prepare('SELECT results, fetched_at FROM live_cache WHERE source_id = ? AND key = ?').get(source.id, key);
      if (row && this.now() - row.fetched_at < this.ttlMs) { try { hits = JSON.parse(row.results); cached = true; } catch { hits = null; } }
      try {
        if (!hits) {
          hits = (await adapter.search({ source, query: q, limit, ctx: this.ctx })) || [];
          this.db.prepare('INSERT INTO live_cache (source_id, key, query, results, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (source_id, key) DO UPDATE SET results = excluded.results, fetched_at = excluded.fetched_at, query = excluded.query')
            .run(source.id, key, q.slice(0, 120), JSON.stringify(hits), this.now());
          this.accessLog?.add({ sourceId: source.id, op: 'live.search', detail: `${hits.length} results` });   // what was asked is not written down: only that a question went out
        }
        for (const h of hits.slice(0, limit)) out.results.push({ ...h, sourceId: source.id, sourceName: source.name, provider: source.kind, kept: !!this.items.byExternal(source.id, h.externalId) });
        out.searched.push({ source: source.name, sourceId: source.id, provider: source.kind, cached, count: hits.length });
      } catch (e) { out.searched.push({ source: source.name, sourceId: source.id, provider: source.kind, cached: false, count: 0, error: e.message }); }
    }
    out.results.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out;
  }

  // Open one result: its body is fetched (unless an up-to-date copy is already kept) and kept as a live item for the grant's retention.
  async open(sourceId, externalId) {
    const source = this.items.source(sourceId);
    if (!source) throw Object.assign(new Error('source not found'), { status: 404 });
    if (!can(source, 'search.live', { now: this.now() })) throw Object.assign(new Error('Live search is not allowed for this source.'), { status: 403 });
    const adapter = this.adapterFor(source);
    if (!adapter?.open) throw Object.assign(new Error('This service cannot open results.'), { status: 400 });
    const have = this.items.byExternal(sourceId, externalId);
    if (have && !have.deletedAt && have.text) return have;
    const payload = await adapter.open({ source, externalId, ctx: this.ctx });
    if (!payload) throw Object.assign(new Error('Not found at the service.'), { status: 404 });
    const days = Math.max(0, source.retentionDays ?? 7);
    const r = this.items.upsert(sourceId, { ...payload, origin: 'live', expiresAt: this.now() + (days ? days * DAY : 3_600_000) });
    this.accessLog?.add({ sourceId, op: 'live.open', detail: `kept ${days || 'a few'} day(s)` });
    return r.item;
  }

  // nightly: expired live copies and old cache entries go
  purge() {
    const items = this.items.purgeExpired(this.now());
    const cache = this.db.prepare('DELETE FROM live_cache WHERE fetched_at < ?').run(this.now() - 24 * 3_600_000).changes;
    return { items, cache };
  }
}

module.exports = { LiveSearch, grantHash, TTL_MS };
