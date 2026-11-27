'use strict';
// The Access page's brain (Settings › Access & privacy): every connected account and source with what it is granted, what has been
// read, where copies of it live (backups, pre-update copies), and what to review. Plus the two acts that change what is kept:
// revoking a source (forget what was read, optionally sign out at the service) and the 90-day review reminder.
const REVIEW_DAYS = 90;
const DAY = 86_400_000;

class AccessCenter {
  constructor({ db, items, accounts, settings, accessLog, aiRuns, account, listBackups, bus = null, now = () => Date.now() }) {
    Object.assign(this, { db, items, accounts, settings, accessLog, aiRuns, account, listBackups, bus, now });
  }

  meta(k) { return this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(k)?.value ?? null; }
  setMeta(k, v) { this.db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, String(v)); }

  // when a source's grant was last looked at: made, changed, or dismissed in the review
  reviewedAt(source) { return Number(this.meta(`access:review:${source.id}`)) || source.createdAt; }
  markReviewed(id) { this.setMeta(`access:review:${id}`, this.now()); return true; }

  // Sources whose grant nobody has looked at for 90 days and that still read something (or may act). The Inbox shows them once.
  reviewDue() {
    const out = [];
    for (const s of this.items.sources()) {
      if (s.kind === 'native' || s.id.startsWith('src_imports_') || !s.enabled) continue;
      const days = Math.floor((this.now() - this.reviewedAt(s)) / DAY);
      if (days >= REVIEW_DAYS && (s.readLevel !== 'none' || s.actions.length)) out.push({ id: s.id, name: s.name, level: s.readLevel, days });
    }
    return out;
  }

  // What the migration to grants did to each source the first time the app opens after the update (shown once)
  notice() {
    if (this.meta('access:notice') !== 'pending') return null;
    return this.items.sources().filter((s) => s.kind !== 'native' && !s.id.startsWith('src_imports_')).map((s) => ({ id: s.id, name: s.name, kind: s.kind, readLevel: s.readLevel, aiReach: s.aiReach, mcp: s.mcp, actions: s.actions }));
  }
  dismissNotice() { this.setMeta('access:notice', 'done'); return true; }

  liveBytes(sourceId) { return this.db.prepare('SELECT COALESCE(SUM(LENGTH(results) + LENGTH(query)), 0) AS n FROM live_cache WHERE source_id = ?').get(sourceId).n; }

  // The whole page
  overview() {
    const sources = this.items.sources().filter((s) => s.kind !== 'native').map((s) => {
      const last = this.db.prepare("SELECT MAX(at) AS at FROM access_log WHERE source_id = ? AND op IN ('live.search', 'action.run')").get(s.id)?.at || null;
      const ai = this.db.prepare("SELECT MAX(at) AS at, COUNT(*) AS n FROM ai_runs WHERE ',' || source_ids || ',' LIKE ?").get(`%,${s.id},%`);
      const live = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE source_id = ? AND origin = 'live' AND deleted_at IS NULL").get(s.id).n;
      return { ...s, account: s.config?.account || (s.kind === 'gmail' ? 'primary' : null), imported: s.id.startsWith('src_imports_'), cacheBytes: this.liveBytes(s.id), liveItems: live, lastUsedAt: Math.max(last || 0, ai?.at || 0) || null, aiCalls: ai?.n || 0, needsReconnect: !!s.config?.needsReconnect, reviewDays: Math.floor((this.now() - this.reviewedAt(s)) / DAY) };
    });
    const o = this.settings.get('outlook') || {};
    const others = [
      ...(o.refreshToken || o.email || o.needsReconnect ? [{ kind: 'outlook', id: 'outlook', email: o.email, connected: !!o.refreshToken, needsReconnect: !!o.needsReconnect }] : []),
      ...(this.settings.get('imapAccounts') || []).map((a) => ({ kind: 'imap', id: a.id, email: a.user, host: a.host, connected: true, needsReconnect: false })),
    ];
    return { accounts: this.accounts.list(), others, sources, copies: this.copies(), notice: this.notice(), review: this.reviewDue(), blocked: this.items.blocked().length };
  }

  // where copies of what was read live outside the live database: files the app made before updates, and backups in the folder chosen
  copies() {
    let backups = [];
    try { backups = this.listBackups?.() || []; } catch { /* no folder chosen */ }
    return { preUpdate: (this.account?.copies?.() || []).map((f) => ({ file: f })), backups: backups.map((b) => ({ file: b.file || b.name || String(b), at: b.at || b.mtime || null })) };
  }

  // Revoke a source: forget everything read from it. signOut: also sign the account out at Google (this also ends the calendar if that
  // account is the first sign-in: the answer says so). keepSource: leave the (empty) source so it can be opened up again.
  async revoke(sourceId, { signOut = false, keepSource = true } = {}) {
    const s = this.items.source(sourceId);
    if (!s) throw Object.assign(new Error('source not found'), { status: 404 });
    const n = this.items.purgeSource(sourceId, { keepSource });
    this.db.prepare('DELETE FROM live_cache WHERE source_id = ?').run(sourceId);
    let signedOut = false;
    if (signOut && s.kind === 'gmail') signedOut = await this.accounts.disconnect(s.config?.account || 'primary');
    if (signOut && s.kind === 'outlook' && this.outlook) { await this.outlook().disconnect().catch(() => {}); signedOut = true; }
    if (signOut && s.kind === 'imap' && s.config?.account) { const keep = (this.settings.get('imapAccounts') || []).filter((a) => a.id !== s.config.account); this.settings.update({ imapAccounts: keep }); signedOut = true; }   // the password is forgotten
    this.accessLog.add({ sourceId, op: 'grant.revoked', detail: `${n} items forgotten${signedOut ? '; signed out at Google' : ''}` });
    if (keepSource) this.items.setGrant(sourceId, { readLevel: 'none' });
    return { forgotten: n, signedOut, calendarAlso: signedOut && (s.config?.account || 'primary') === 'primary' };
  }
}

module.exports = { AccessCenter, REVIEW_DAYS };
