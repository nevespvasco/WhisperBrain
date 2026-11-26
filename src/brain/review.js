'use strict';
// The weekly review: what happened in a week and what is still open, from facts only (no AI): meetings and who you met, what you decided,
// which promises were kept and which are late (yours, and others' to you), notes read, mail waiting for an answer. Every number is a list
// that opens its sources.
const DAY = 86_400_000;

// Monday 00:00 (local) of the week that contains `ms`
function weekStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

class Reviews {
  constructor({ db, notes, assertions, entities, items, inbox, now = () => Date.now() }) { Object.assign(this, { db, notes, assertions, entities, items, inbox, now }); }

  // weeksAgo 0 = this week
  build(weeksAgo = 0) {
    const from = weekStart(this.now()) - weeksAgo * 7 * DAY, to = from + 7 * DAY;
    this.entities.refresh();
    const meetings = this.db.prepare('SELECT id, title, COALESCE(started_at, created_at) AS at, started_at, ended_at FROM notes WHERE COALESCE(started_at, created_at) >= ? AND COALESCE(started_at, created_at) < ? ORDER BY at').all(from, to)
      .map((n) => ({ id: n.id, title: n.title, at: n.at, minutes: n.ended_at && n.started_at ? Math.round((n.ended_at - n.started_at) / 60000) : null }));
    const people = this.db.prepare(`SELECT e.name, e.key, COUNT(DISTINCT m.note_id) AS meetings FROM mentions m JOIN entities e ON e.id = m.entity_id JOIN notes n ON n.id = m.note_id
      WHERE e.merged_into IS NULL AND COALESCE(n.started_at, n.created_at) >= ? AND COALESCE(n.started_at, n.created_at) < ? GROUP BY e.id ORDER BY meetings DESC, e.name LIMIT 8`).all(from, to);
    const dec = (state, col) => this.db.prepare(`SELECT id, text, note_id AS noteId, segment_id AS segmentId, owner_name AS owner FROM assertions WHERE kind = ? AND state IN (${state}) AND ${col} >= ? AND ${col} < ? ORDER BY ${col} DESC`);
    const decisions = dec("'accepted','superseded'", 'decided_at').all('decision', from, to);
    const kept = dec("'done'", 'updated_at').all('commitment', from, to);
    const made = dec("'accepted','done'", 'decided_at').all('commitment', from, to);
    const open = this.assertions.open();
    const noteItems = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind <> 'meeting' AND deleted_at IS NULL AND ingested_at >= ? AND ingested_at < ?").get(from, to).n;
    return {
      from, to, weeksAgo, meetings, minutes: meetings.reduce((a, m) => a + (m.minutes || 0), 0), people, decisions, kept, made,
      lateMine: open.overdueMine, lateTheirs: open.overdueTheirs, openMine: open.mine.length, openTheirs: open.theirs.length,
      newNotes: noteItems, noReply: this.inbox.noReply().length, toReview: this.assertions.counts().suggested,
    };
  }
}

module.exports = { Reviews, weekStart };
