'use strict';
// The assistant's global shortcut table: pure validation and planning, Electron registers what the plan says.
const test = require('node:test');
const assert = require('node:assert/strict');
const hk = require('../src/assistant/hotkeys');

const DICTATION = 'CommandOrControl+Shift+Space';

test('DEFAULT_HOTKEYS: one accelerator per action, none of them the dictation default', () => {
  assert.deepEqual(hk.ACTIONS, ['answer', 'regenerate', 'ask', 'toggle', 'screenshot', 'prompter', 'prompterPause', 'prompterBack', 'prompterNext']);
  assert.deepEqual(Object.keys(hk.DEFAULT_HOTKEYS).sort(), [...hk.ACTIONS].sort());
  assert.equal(hk.DEFAULT_HOTKEYS.answer, 'CommandOrControl+Alt+Return');
  assert.equal(hk.DEFAULT_HOTKEYS.regenerate, 'CommandOrControl+Alt+R');
  assert.equal(hk.DEFAULT_HOTKEYS.ask, 'CommandOrControl+Alt+K');
  assert.equal(hk.DEFAULT_HOTKEYS.toggle, 'CommandOrControl+Alt+J');
  assert.equal(hk.DEFAULT_HOTKEYS.screenshot, 'CommandOrControl+Alt+S');
  assert.equal(hk.DEFAULT_HOTKEYS.prompter, 'CommandOrControl+Alt+Y');
  assert.equal(hk.DEFAULT_HOTKEYS.prompterPause, 'CommandOrControl+Alt+P');
  assert.equal(hk.DEFAULT_HOTKEYS.prompterBack, 'CommandOrControl+Alt+[');
  assert.equal(hk.DEFAULT_HOTKEYS.prompterNext, 'CommandOrControl+Alt+]');
  assert.ok(!Object.values(hk.DEFAULT_HOTKEYS).includes(DICTATION));
});

test('isAccelerator: accepts Electron accelerators with modifiers and exactly one key', () => {
  for (const s of [
    ...Object.values(hk.DEFAULT_HOTKEYS), DICTATION,
    'Ctrl+Shift+A', 'Cmd+9', 'CmdOrCtrl+Alt+Enter', 'Option+Space', 'AltGr+Q', 'Super+F5', 'Meta+Tab',
    'Control+Shift+Up', 'Alt+PageDown', 'Ctrl+Esc', 'Ctrl+Plus', 'Ctrl+/', 'Alt+;', 'Ctrl+,', 'Ctrl+.', "Alt+'",
    'Ctrl+[', 'Ctrl+]', 'Ctrl+\\', 'Ctrl+-', 'Ctrl+=', 'Ctrl+`', 'Shift+F12', 'F9', 'F24', 'ctrl+alt+k',
    'Command+Backspace', 'Ctrl+Delete', 'Ctrl+Insert', 'Ctrl+Home', 'Ctrl+End', 'Ctrl+PageUp', 'Alt+Left', 'Alt+Right', 'Alt+Down',
  ]) assert.equal(hk.isAccelerator(s), true, s);
});

test('isAccelerator: rejects missing or doubled keys, unknown names, and bare or Shift-only typing keys', () => {
  for (const s of [
    '', '   ', 'Ctrl', 'Ctrl+Alt', 'Ctrl+A+B', 'Ctrl++', 'Ctrl+', '+A', 'Hyper+A', 'Ctrl+Ctrl+A', 'Ctrl+F25', 'Ctrl+F0',
    'Ctrl+AB', 'Ctrl+é', 'A', '5', 'Shift+A', 'Shift+5', 'Space', 'Return', 'Shift+Space', '/', 'Escape',
    null, undefined, 42, {},
  ]) assert.equal(hk.isAccelerator(s), false, String(s));
});

test('normalize: one spelling per shortcut, so equal shortcuts compare equal', () => {
  assert.equal(hk.normalize('cmdorctrl+alt+enter'), 'CommandOrControl+Alt+Return');
  assert.equal(hk.normalize('Shift+Alt+CmdOrCtrl+k'), 'CommandOrControl+Alt+Shift+K');
  assert.equal(hk.normalize(' Ctrl + Esc '), 'Control+Escape');
  assert.equal(hk.normalize('Option+Meta+f3'), 'Alt+Super+F3');
  assert.equal(hk.normalize('Cmd+Plus'), 'Command+Plus');
  assert.equal(hk.normalize(hk.normalize('ctrl+shift+/')), 'Control+Shift+/');
  assert.equal(hk.normalize('Ctrl+A+B'), null, 'not an accelerator: nothing to compare');
});

test('planHotkeys: the defaults all register, in action order, with no problems', () => {
  const plan = hk.planHotkeys(hk.DEFAULT_HOTKEYS, { reserved: [DICTATION] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.register, hk.ACTIONS.map((action) => ({ action, accelerator: hk.DEFAULT_HOTKEYS[action] })));
});

test('planHotkeys: an empty string switches the action off; unknown actions are ignored', () => {
  const plan = hk.planHotkeys({ answer: 'Ctrl+Alt+Return', ask: '', bogus: 'Ctrl+Alt+B' });
  assert.deepEqual(plan.register, [{ action: 'answer', accelerator: 'Ctrl+Alt+Return' }]);
  assert.deepEqual(plan.problems, []);
});

test('planHotkeys: a blank-but-not-empty value is reported as empty (only "" means off)', () => {
  const plan = hk.planHotkeys({ toggle: '   ' });
  assert.deepEqual(plan.register, []);
  assert.deepEqual(plan.problems, [{ action: 'toggle', accelerator: '   ', reason: 'empty' }]);
});

test('planHotkeys: an invalid accelerator is a problem and the others still register', () => {
  const plan = hk.planHotkeys({ answer: 'Ctrl+A+B', ask: 'Ctrl+Alt+K', toggle: 7 });
  assert.deepEqual(plan.register, [{ action: 'ask', accelerator: 'Ctrl+Alt+K' }]);
  assert.deepEqual(plan.problems, [
    { action: 'answer', accelerator: 'Ctrl+A+B', reason: 'invalid' },
    { action: 'toggle', accelerator: 7, reason: 'invalid' },
  ]);
});

test('planHotkeys: two actions on the same shortcut (however spelled) keep the first, the later one is a problem', () => {
  const plan = hk.planHotkeys({ answer: 'CmdOrCtrl+Alt+Enter', regenerate: 'Alt+CommandOrControl+Return', ask: 'Ctrl+Alt+K' });
  assert.deepEqual(plan.register, [
    { action: 'answer', accelerator: 'CmdOrCtrl+Alt+Enter' },
    { action: 'ask', accelerator: 'Ctrl+Alt+K' },
  ]);
  assert.deepEqual(plan.problems, [{ action: 'regenerate', accelerator: 'Alt+CommandOrControl+Return', reason: 'duplicate' }]);
});

test('planHotkeys: a shortcut already reserved elsewhere (the dictation hotkey) is a problem', () => {
  const plan = hk.planHotkeys({ ask: 'cmdorctrl+shift+space', toggle: 'Ctrl+Alt+J' }, { reserved: [DICTATION, '', 'nonsense'] });
  assert.deepEqual(plan.register, [{ action: 'toggle', accelerator: 'Ctrl+Alt+J' }]);
  assert.deepEqual(plan.problems, [{ action: 'ask', accelerator: 'cmdorctrl+shift+space', reason: 'reserved' }]);
});

test('planHotkeys: CommandOrControl is the same key as Control off macOS and as Command on macOS', () => {
  const hotkeys = { answer: 'Ctrl+Shift+Space', ask: 'Cmd+Shift+Space', toggle: 'Control+Alt+R', regenerate: 'CmdOrCtrl+Alt+R' };
  const linux = hk.planHotkeys(hotkeys, { reserved: [DICTATION], platform: 'linux' });
  assert.deepEqual(linux.problems.map((p) => [p.action, p.reason]), [['answer', 'reserved'], ['toggle', 'duplicate']]);
  const mac = hk.planHotkeys(hotkeys, { reserved: [DICTATION], platform: 'darwin' });
  assert.deepEqual(mac.problems.map((p) => [p.action, p.reason]), [['ask', 'reserved']]);
});

test('validateHotkeys: accepts the defaults, a partial table and switched-off actions', () => {
  hk.validateHotkeys(hk.DEFAULT_HOTKEYS);
  hk.validateHotkeys({});
  hk.validateHotkeys({ answer: '', ask: 'Ctrl+Alt+Q' });
});

test('validateHotkeys: throws a message naming the bad entry', () => {
  assert.throws(() => hk.validateHotkeys(null), /hotkeys must be an object/);
  assert.throws(() => hk.validateHotkeys(['Ctrl+A']), /hotkeys must be an object/);
  assert.throws(() => hk.validateHotkeys('Ctrl+Alt+K'), /hotkeys must be an object/);
  assert.throws(() => hk.validateHotkeys({ launch: 'Ctrl+Alt+L' }), /unknown hotkey action "launch"/);
  assert.throws(() => hk.validateHotkeys({ ask: 5 }), /hotkey "ask" must be a string/);
  assert.throws(() => hk.validateHotkeys({ ask: 'Ctrl+A+B' }), /hotkey "ask": "Ctrl\+A\+B" is not a valid shortcut/);
  assert.throws(() => hk.validateHotkeys({ ask: 'Shift+K' }), /hotkey "ask": "Shift\+K" is not a valid shortcut/);
});
