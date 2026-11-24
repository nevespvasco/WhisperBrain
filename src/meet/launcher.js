'use strict';
// Linux: Chromium-based browsers only put a page in the accessibility tree when they are started with
// --force-renderer-accessibility (measured). This adds that flag to the launcher a person clicks, in a copy of the
// browser's desktop entry that lives in their own applications folder and shadows the system one. Nothing outside the
// user's home is touched, and removing the copy puts everything back. A copy the person made themselves is never touched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLAG = '--force-renderer-accessibility';
const MARK = 'X-WhisperBrain-Accessibility';
const BROWSER = /^(?:google-chrome|chromium|chromium-browser|brave-browser|brave|microsoft-edge|vivaldi|opera)[\w.-]*\.desktop$|^(?:com\.google\.Chrome|org\.chromium\.Chromium|com\.brave\.Browser|com\.microsoft\.Edge)\.desktop$/;

// extra: also look where snap and flatpak keep their launchers (a test says false: it must not depend on the machine)
function dirs({ home = os.homedir(), env = process.env, extra = true } = {}) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share');
  const system = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean).map((d) => path.join(d, 'applications'));
  return {
    user: path.join(dataHome, 'applications'),
    system: extra ? [...system, '/var/lib/snapd/desktop/applications', '/var/lib/flatpak/exports/share/applications', path.join(dataHome, 'flatpak/exports/share/applications')] : system,
  };
}

// Puts the flag in every Exec= line of a desktop entry (the main one and the "new window" style actions), before the
// placeholders for files and addresses (%U, %u, @@u…) so it reaches the browser and not the page.
function withFlag(text) {
  const lines = text.split('\n').map((line) => {
    if (!line.startsWith('Exec=') || line.includes(FLAG)) return line;
    const tokens = line.slice(5).split(' ');
    const at = tokens.findIndex((t, i) => i > 0 && (/^%[a-zA-Z]$/.test(t) || t.startsWith('@@')));
    tokens.splice(at < 0 ? tokens.length : at, 0, FLAG);
    return `Exec=${tokens.join(' ')}`;
  });
  const out = lines.join('\n');
  return out.includes(`${MARK}=`) ? out : out.replace(/^\[Desktop Entry\]\s*$/m, `[Desktop Entry]\n${MARK}=true`);
}

const ours = (text) => new RegExp(`^${MARK}=true\\s*$`, 'm').test(text);
const field = (text, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() || '';

// -> [{ file, name, state: 'on' | 'off' | 'foreign', source }]   'foreign': the person's own copy is there, left alone
function browsers({ home, env, extra, read = (f) => fs.readFileSync(f, 'utf8'), list = (d) => fs.readdirSync(d) } = {}) {
  const d = dirs({ home, env, extra });
  const out = new Map();
  for (const dir of d.system) {
    let names;
    try { names = list(dir); } catch { continue; }
    for (const file of names) {
      if (!BROWSER.test(file) || out.has(file)) continue;
      let text;
      try { text = read(path.join(dir, file)); } catch { continue; }
      // not a launcher a person clicks: no command, hidden, made for another desktop, or a snap's service entry (Exec=/usr/bin/false)
      const exec = field(text, 'Exec');
      if (!exec || /^(?:\/usr\/bin\/)?false\b/.test(exec) || /^true$/i.test(field(text, 'NoDisplay')) || field(text, 'OnlyShowIn')) continue;
      out.set(file, { file, name: field(text, 'Name') || file, state: 'off', source: path.join(dir, file) });
    }
  }
  for (const b of out.values()) {
    let mine;
    try { mine = read(path.join(d.user, b.file)); } catch { continue; }
    b.state = ours(mine) ? 'on' : 'foreign';
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function enable(file, { home, env, extra, read = (f) => fs.readFileSync(f, 'utf8'), write = (f, t) => fs.writeFileSync(f, t), mkdir = (p) => fs.mkdirSync(p, { recursive: true }), list } = {}) {
  const b = browsers({ home, env, extra, read, list }).find((x) => x.file === file);
  if (!b) throw new Error('that browser was not found');
  if (b.state === 'foreign') throw new Error('you already have your own launcher for it; add --force-renderer-accessibility to it yourself');
  const d = dirs({ home, env, extra });
  mkdir(d.user);
  write(path.join(d.user, file), withFlag(read(b.source)));
  return { ...b, state: 'on' };
}

function disable(file, { home, env, read = (f) => fs.readFileSync(f, 'utf8'), remove = (f) => fs.unlinkSync(f) } = {}) {
  const f = path.join(dirs({ home, env }).user, file);
  let text;
  try { text = read(f); } catch { return false; }
  if (!ours(text)) throw new Error('that launcher is not one WhisperBrain made');
  remove(f);
  return true;
}

module.exports = { browsers, enable, disable, withFlag, dirs, FLAG, MARK };
