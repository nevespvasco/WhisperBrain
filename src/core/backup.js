'use strict';
// A consistent copy of the whole database (VACUUM INTO: safe while the app runs), into a folder the person chose, one file per backup,
// the newest few kept. The copy holds everything: meetings, notes read from folders, people, promises. It does NOT hold the files of the
// folders and vaults (those are the originals), the speech models, or the key that opens saved API keys: keep that file safe as well.
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 10;
const PREFIX = 'whisperbrain-backup-';
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

function backupTo(db, dir, { now = new Date(), keep = KEEP } = {}) {
  const target = String(dir || '').trim();
  if (!target) throw Object.assign(new Error('Choose a folder for the backups first.'), { status: 400 });
  fs.mkdirSync(target, { recursive: true });
  const real = fs.realpathSync(target);
  const file = path.join(real, `${PREFIX}${stamp(now)}.sqlite`);
  if (fs.existsSync(file)) throw Object.assign(new Error('A backup was just made. Try again in a moment.'), { status: 409 });
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this fs */ }
  const all = list(real);
  for (const old of all.slice(keep)) { try { fs.unlinkSync(old.file); } catch { /* already gone */ } }
  return { file, bytes: fs.statSync(file).size, kept: Math.min(all.length, keep) };
}

// newest first
function list(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.sqlite')).map((f) => ({ file: path.join(dir, f), name: f, at: fs.statSync(path.join(dir, f)).mtimeMs, bytes: fs.statSync(path.join(dir, f)).size })).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  } catch { return []; }
}

module.exports = { backupTo, list, PREFIX, KEEP };
