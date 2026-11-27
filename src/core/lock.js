'use strict';
// An app lock ("vault mode"): with a passphrase set, the app starts locked and locks again after a time without use; while locked, the
// interface and the local API answer nothing but the lock screen (recording that is already running keeps going).
//
// WHAT THIS IS AND IS NOT. It is a lock screen: it stops someone who sits down at your open computer or reaches the local API. It does NOT
// encrypt the database or the files on disk: someone who can copy the data folder can read it. node:sqlite has no encryption at rest; the
// real protection for that is disk encryption (FileVault, BitLocker, LUKS), and the app says so where it asks for the passphrase.
//
// The passphrase is kept as a scrypt hash with its own salt, in the database (not in Settings: the settings API can change settings, and
// the lock must not be switchable without the passphrase). Wrong guesses are slowed: five in a row lock the door for 30 seconds.
const crypto = require('node:crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_FAILS = 5, PENALTY_MS = 30_000;
const err = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

class AppLock {
  constructor({ db, bus = null, now = () => Date.now() }) {
    Object.assign(this, { db, bus, now });
    this.isLocked = this.enabled();      // starts locked when a passphrase is set
    this.persist();
    this.lastUse = now();
    this.fails = 0; this.blockedUntil = 0;
  }

  meta(k) { return this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(`lock:${k}`)?.value ?? null; }
  setMeta(k, v) { this.db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`lock:${k}`, String(v)); }
  enabled() { return !!this.meta('hash'); }
  // The state, written where the MCP server (another process, src/mcp/server.js) can read it, so it refuses while the app is locked.
  persist() { try { this.setMeta('state', this.isLocked ? 'locked' : 'unlocked'); } catch { /* read-only or closing */ } }
  minutes() { return Number(this.meta('minutes')) || 0; }

  status() { return { enabled: this.enabled(), locked: this.locked(), minutes: this.minutes() }; }

  // Called on use. Locks by itself when the idle time has passed.
  locked() {
    if (!this.enabled()) return false;
    const m = this.minutes();
    if (!this.isLocked && m > 0 && this.now() - this.lastUse > m * 60_000) this.lock();
    return this.isLocked;
  }
  touch() { if (!this.isLocked) this.lastUse = this.now(); }

  hash(pass, salt) { return crypto.scryptSync(String(pass), salt, 32, SCRYPT).toString('hex'); }
  check(pass) {
    const salt = this.meta('salt'), hash = this.meta('hash');
    if (!salt || !hash) return false;
    const a = Buffer.from(this.hash(pass, Buffer.from(salt, 'hex')), 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  guess(pass) {
    if (this.now() < this.blockedUntil) throw err(`Too many wrong tries. Wait ${Math.ceil((this.blockedUntil - this.now()) / 1000)} seconds.`, 429, 'throttled');
    if (this.check(pass)) { this.fails = 0; return true; }
    if (++this.fails >= MAX_FAILS) { this.fails = 0; this.blockedUntil = this.now() + PENALTY_MS; }
    throw err('That is not the passphrase.', 401, 'wrong-passphrase');
  }

  unlock(pass) { this.guess(pass); this.isLocked = false; this.lastUse = this.now(); this.persist(); this.bus?.publish('lock.changed', { locked: false }); return this.status(); }
  lock() { if (this.enabled()) { this.isLocked = true; this.persist(); this.bus?.publish('lock.changed', { locked: true }); } return this.status(); }

  // Set or change the passphrase. When one is already set, the current one is needed.
  enable({ passphrase, current, minutes = 0 }) {
    if (String(passphrase || '').length < 8) throw err('Use at least 8 characters.');
    if (this.enabled()) this.guess(current);
    const salt = crypto.randomBytes(16);
    this.setMeta('salt', salt.toString('hex'));
    this.setMeta('hash', this.hash(passphrase, salt));
    this.setMeta('minutes', Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0))));
    this.isLocked = false; this.lastUse = this.now(); this.persist();
    return this.status();
  }

  // The app is closing: whoever reads the database next (the MCP server) sees it locked until the app is opened and unlocked again.
  close() { if (this.enabled()) { this.isLocked = true; this.persist(); } }

  setMinutes(minutes, { passphrase }) { this.guess(passphrase); this.setMeta('minutes', Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)))); return this.status(); }

  disable({ passphrase }) {
    this.guess(passphrase);
    this.db.prepare("DELETE FROM index_meta WHERE key LIKE 'lock:%'").run();
    this.isLocked = false;
    return this.status();
  }
}

// what a locked app still answers: the lock itself, and the audio of a recording that is already running
const OPEN = [/^\/api\/lock(\/|$)/, /^\/api\/recording\/(pcm|stop)$/];
const mayPass = (method, pathname) => OPEN.some((re) => re.test(pathname));

module.exports = { AppLock, mayPass };
