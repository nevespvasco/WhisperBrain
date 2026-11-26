'use strict';
// Reminders: something to be told about at a time. A commitment that a person accepted and that has a date gets one on the morning
// of that day. A calm notification budget: at most a few things are announced at once; the rest are one line saying how many wait
// (they are all in the Inbox). Checked once a minute while the app runs, and at start, so what came due while it was closed is told then.
const crypto = require('node:crypto');

const newId = () => `rm_${crypto.randomBytes(6).toString('hex')}`;
const MORNING_MS = 9 * 3600_000;            // 09:00 on the day
const BUDGET = 3;

class Reminders {
  constructor({ db, bus = null, now = () => Date.now() }) { Object.assign(this, { db, bus, now }); this.timer = null; }

  create({ text, dueAt, assertionId = null }) {
    const id = newId();
    this.db.prepare('INSERT INTO reminders (id, text, due_at, assertion_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, String(text).slice(0, 300), Number(dueAt), assertionId, this.now());
    this.bus?.publish('reminders.changed', { id });
    return this.get(id);
  }

  get(id) { return this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) && map(this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id)); }

  // one reminder per commitment, on the morning of the day it is due (not in the past: an overdue one is shown in the Inbox instead)
  // mine = false: what somebody else promised you: the reminder is to check with them
  forAssertion(a, { mine = true } = {}) {
    if (!a?.dueAt || a.kind !== 'commitment') return null;
    const text = mine ? a.text : `Check with ${a.owner?.name || 'them'}: ${a.text}`;
    const day = new Date(a.dueAt); day.setHours(0, 0, 0, 0);
    const at = day.getTime() + MORNING_MS;
    const existing = this.db.prepare("SELECT id FROM reminders WHERE assertion_id = ? AND state = 'open'").get(a.id);
    if (existing) { this.db.prepare('UPDATE reminders SET due_at = ?, text = ?, fired_at = NULL WHERE id = ?').run(at, text.slice(0, 300), existing.id); return this.get(existing.id); }
    if (at < this.now() - 86400000) return null;
    return this.create({ text, dueAt: at, assertionId: a.id });
  }

  closeFor(assertionId) { this.db.prepare("UPDATE reminders SET state = 'done' WHERE assertion_id = ? AND state = 'open'").run(assertionId); }

  setState(id, state) {
    if (!['done', 'dismissed'].includes(state)) throw Object.assign(new Error('state must be done or dismissed'), { status: 400 });
    if (!this.get(id)) throw Object.assign(new Error('not found'), { status: 404 });
    this.db.prepare('UPDATE reminders SET state = ? WHERE id = ?').run(state, id);
    this.bus?.publish('reminders.changed', { id });
    return this.get(id);
  }

  snooze(id, ms = 3600_000) {
    if (!this.get(id)) throw Object.assign(new Error('not found'), { status: 404 });
    this.db.prepare("UPDATE reminders SET due_at = ?, fired_at = NULL, state = 'open' WHERE id = ?").run(this.now() + Math.max(60_000, Math.min(ms, 14 * 86400_000)), id);
    this.bus?.publish('reminders.changed', { id });
    return this.get(id);
  }

  // came due and not dealt with: what the Inbox shows
  pending() { return this.db.prepare("SELECT * FROM reminders WHERE state = 'open' AND due_at <= ? ORDER BY due_at").all(this.now()).map(map); }
  upcoming(days = 7) { return this.db.prepare("SELECT * FROM reminders WHERE state = 'open' AND due_at > ? AND due_at <= ? ORDER BY due_at").all(this.now(), this.now() + days * 86400_000).map(map); }

  // Announce what came due since the last look, within the budget.
  tick() {
    const due = this.db.prepare("SELECT * FROM reminders WHERE state = 'open' AND fired_at IS NULL AND due_at <= ? ORDER BY due_at").all(this.now()).map(map);
    if (!due.length) return 0;
    for (const r of due) this.db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(this.now(), r.id);
    due.slice(0, BUDGET).forEach((r) => this.bus?.publish('reminder.due', { id: r.id, text: r.text, assertionId: r.assertionId }));
    if (due.length > BUDGET) this.bus?.publish('reminder.due', { id: null, text: null, more: due.length - BUDGET });
    this.bus?.publish('reminders.changed', {});
    return due.length;
  }

  start(everyMs = 60_000) {
    if (this.timer) return;
    try { this.tick(); } catch { /* closing */ }
    this.timer = setInterval(() => { try { this.tick(); } catch { /* closing */ } }, everyMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

const map = (r) => ({ id: r.id, text: r.text, dueAt: r.due_at, state: r.state, assertionId: r.assertion_id, firedAt: r.fired_at, createdAt: r.created_at });

module.exports = { Reminders, BUDGET };
