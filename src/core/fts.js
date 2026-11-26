'use strict';
// Writing to an FTS5 table can leave SQLite's "last insert rowid" at a number far beyond JavaScript's safe integers (the index keeps
// its own segments in shadow tables), and node:sqlite throws when it is asked to hand that number back. These statements read integers
// as BigInt, so the result of a write to a full-text index can always be returned.
//
// The number also stays behind on the connection: the next ordinary write would throw when it reports its own result. So after every
// write to a full-text index the last insert rowid is set back to a small number (the fts_reset table, one row).
function ftsRun(db, sql, ...args) {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  const r = st.run(...args);
  db.exec('INSERT OR REPLACE INTO fts_reset (id) VALUES (1)');
  return r;
}

module.exports = { ftsRun };
