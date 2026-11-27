'use strict';
// The assistant's global shortcuts. Pure: Electron's globalShortcut registers what planHotkeys() says.

const ACTIONS = Object.freeze(['answer', 'regenerate', 'ask', 'toggle', 'screenshot', 'prompter', 'prompterPause', 'prompterBack', 'prompterNext']);

// Ctrl/Cmd+Alt+letter: free in Zoom, Meet and Teams, and away from dictation's CommandOrControl+Shift+Space.
const DEFAULT_HOTKEYS = Object.freeze({
  answer: 'CommandOrControl+Alt+Return',
  regenerate: 'CommandOrControl+Alt+R',
  ask: 'CommandOrControl+Alt+K',
  toggle: 'CommandOrControl+Alt+J',
  screenshot: 'CommandOrControl+Alt+S',
  // The teleprompter window (electron/prompter.js). Not T (a terminal on Ubuntu), L (screen lock) or the arrows (workspaces on GNOME).
  prompter: 'CommandOrControl+Alt+Y',        // show / hide it
  prompterPause: 'CommandOrControl+Alt+P',   // pause / resume its scrolling
  prompterBack: 'CommandOrControl+Alt+[',    // one sentence back
  prompterNext: 'CommandOrControl+Alt+]',    // one sentence on
});

// Modifier spellings Electron accepts, lower-cased, to their canonical name. The order of CANON_MODIFIERS is the
// order normalize() writes them in.
const MODIFIERS = {
  command: 'Command', cmd: 'Command',
  control: 'Control', ctrl: 'Control',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  alt: 'Alt', option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super', meta: 'Super',
};
const CANON_MODIFIERS = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

// Named keys, lower-cased, to their canonical name. Letters, digits, F-keys and punctuation are handled apart.
const NAMED_KEYS = {
  return: 'Return', enter: 'Return', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', escape: 'Escape', esc: 'Escape', plus: 'Plus',
};
const PUNCTUATION = new Set(['/', ';', ',', '.', "'", '[', ']', '\\', '-', '=', '`']);

function canonicalKey(raw) {
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(raw);
  if (f) return `F${f[1]}`;
  if (PUNCTUATION.has(raw)) return raw;
  return NAMED_KEYS[raw.toLowerCase()] || null;
}

// { modifiers: [canonical, sorted], key } or null when the string is not an accelerator we accept.
function parse(s) {
  if (typeof s !== 'string') return null;
  const parts = s.trim().split('+').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === '')) return null;
  const key = canonicalKey(parts[parts.length - 1]);
  if (!key) return null;
  const mods = new Set();
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  // A global shortcut swallows the keystroke system-wide: anything that types or edits needs a real modifier
  // (Shift alone only changes what is typed). Only the function keys may stand bare or with Shift.
  const realModifier = [...mods].some((m) => m !== 'Shift');
  if (!realModifier && !/^F\d+$/.test(key)) return null;
  return { modifiers: CANON_MODIFIERS.filter((m) => mods.has(m)), key };
}

function isAccelerator(s) { return parse(s) !== null; }

// Canonical spelling (CmdOrCtrl→CommandOrControl, Enter→Return, Esc→Escape, modifiers in a fixed order), or null.
function normalize(s) {
  const p = parse(s);
  return p ? [...p.modifiers, p.key].join('+') : null;
}

// What to register and what to tell the user. Actions are planned in ACTIONS order; "" switches an action off.
// Two shortcuts clash when they press the same keys on this platform: CommandOrControl is Command on macOS and
// Control everywhere else.
function clashKey(accelerator, platform) {
  const p = parse(accelerator);
  if (!p) return null;
  const mine = platform === 'darwin' ? 'Command' : 'Control';
  const mods = new Set(p.modifiers.map((m) => (m === 'CommandOrControl' ? mine : m)));
  return [...CANON_MODIFIERS.filter((m) => mods.has(m)), p.key].join('+');
}

function planHotkeys(hotkeys, { reserved = [], platform = process.platform } = {}) {
  const register = [];
  const problems = [];
  const taken = new Set();
  const blocked = new Set((reserved || []).map((r) => clashKey(r, platform)).filter(Boolean));
  for (const action of ACTIONS) {
    if (!hotkeys || !Object.hasOwn(hotkeys, action)) continue;
    const accelerator = hotkeys[action];
    if (accelerator === '') continue;
    if (typeof accelerator === 'string' && accelerator.trim() === '') { problems.push({ action, accelerator, reason: 'empty' }); continue; }
    if (!isAccelerator(accelerator)) { problems.push({ action, accelerator, reason: 'invalid' }); continue; }
    const key = clashKey(accelerator, platform);
    if (blocked.has(key)) { problems.push({ action, accelerator, reason: 'reserved' }); continue; }
    if (taken.has(key)) { problems.push({ action, accelerator, reason: 'duplicate' }); continue; }
    taken.add(key);
    register.push({ action, accelerator });
  }
  return { register, problems };
}

// Settings validation: only known actions, each a valid accelerator or "" (off). Clashes are left to planHotkeys(),
// which reports them at registration time, so a table that clashes can still be saved and then fixed.
function validateHotkeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('hotkeys must be an object of action → shortcut');
  for (const [action, accelerator] of Object.entries(obj)) {
    if (!ACTIONS.includes(action)) throw new Error(`unknown hotkey action "${action}" (expected one of ${ACTIONS.join(', ')})`);
    if (typeof accelerator !== 'string') throw new Error(`hotkey "${action}" must be a string (an empty string switches it off)`);
    if (accelerator !== '' && !isAccelerator(accelerator)) {
      throw new Error(`hotkey "${action}": "${accelerator}" is not a valid shortcut (modifiers such as CommandOrControl, Alt, Shift plus one key, e.g. CommandOrControl+Alt+K)`);
    }
  }
}

module.exports = { ACTIONS, DEFAULT_HOTKEYS, isAccelerator, normalize, planHotkeys, validateHotkeys };
