'use strict';
// Linux: the launcher that starts the browser with accessibility on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { browsers, enable, disable, withFlag, FLAG, MARK } = require('../src/meet/launcher');

const CHROME = `[Desktop Entry]
Version=1.0
Name=Google Chrome
Exec=/usr/bin/google-chrome-stable %U
Terminal=false
Type=Application

[Desktop Action new-window]
Name=New Window
Exec=/usr/bin/google-chrome-stable
`;

function home(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
  const sys = path.join(h, 'usr/share/applications');
  fs.mkdirSync(sys, { recursive: true });
  fs.writeFileSync(path.join(sys, 'google-chrome.desktop'), CHROME);
  fs.writeFileSync(path.join(sys, 'brave-browser.desktop'), CHROME.replace('Google Chrome', 'Brave').replace('google-chrome-stable', 'brave-browser-stable'));
  fs.writeFileSync(path.join(sys, 'org.gnome.Nautilus.desktop'), '[Desktop Entry]\nName=Files\nExec=nautilus %U\n');
  fs.writeFileSync(path.join(sys, 'chromium-browser.desktop'), '[Desktop Entry]\nName=Hidden\nNoDisplay=true\nExec=chromium %U\n');
  fs.writeFileSync(path.join(sys, 'chromium_daemon.desktop'), '[Desktop Entry]\nName=Chromium\nExec=/usr/bin/false\nOnlyShowIn=UbuntuFrame;\n');
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return { home: h, extra: false, env: { XDG_DATA_HOME: path.join(h, 'data'), XDG_DATA_DIRS: path.join(h, 'usr/share') } };
}

test('flag: it goes before the file and address placeholders, in every Exec line, once', () => {
  const out = withFlag(CHROME);
  assert.match(out, new RegExp(`Exec=/usr/bin/google-chrome-stable ${FLAG} %U`));
  assert.match(out, new RegExp(`Exec=/usr/bin/google-chrome-stable ${FLAG}\\n`));
  assert.equal(withFlag(out), out, 'twice is the same as once');
  assert.match(out, new RegExp(`\\[Desktop Entry\\]\\n${MARK}=true`));
  assert.match(withFlag('[Desktop Entry]\nExec=flatpak run --branch=stable com.google.Chrome @@u %U @@\n'), /com\.google\.Chrome --force-renderer-accessibility @@u/);
  assert.match(withFlag('[Desktop Entry]\nExec=env BAMF_DESKTOP_FILE_HINT=x /usr/bin/google-chrome-stable %U\n'), /google-chrome-stable --force-renderer-accessibility %U/);
});

test('browsers: only visible browsers are listed, and the state says whose launcher is in the way', (t) => {
  const e = home(t);
  assert.deepEqual(browsers(e).map((b) => [b.file, b.state]), [['brave-browser.desktop', 'off'], ['google-chrome.desktop', 'off']]);
  fs.mkdirSync(path.join(e.home, 'data/applications'), { recursive: true });
  fs.writeFileSync(path.join(e.home, 'data/applications/google-chrome.desktop'), CHROME.replace('%U', '--my-flag %U'));
  assert.equal(browsers(e).find((b) => b.file === 'google-chrome.desktop').state, 'foreign');
});

test('enable and disable: a copy in the user\'s own folder, and removing it puts everything back', (t) => {
  const e = home(t);
  const r = enable('google-chrome.desktop', e);
  assert.equal(r.state, 'on');
  const mine = path.join(e.home, 'data/applications/google-chrome.desktop');
  assert.match(fs.readFileSync(mine, 'utf8'), new RegExp(FLAG));
  assert.equal(browsers(e).find((b) => b.file === 'google-chrome.desktop').state, 'on');
  assert.equal(fs.readFileSync(path.join(e.home, 'usr/share/applications/google-chrome.desktop'), 'utf8'), CHROME, 'the system file is untouched');
  assert.equal(enable('google-chrome.desktop', e).state, 'on', 'enabling twice is fine');
  assert.equal(disable('google-chrome.desktop', e), true);
  assert.equal(fs.existsSync(mine), false);
  assert.equal(disable('google-chrome.desktop', e), false, 'nothing to remove');
});

test('a launcher the person made is never overwritten or removed', (t) => {
  const e = home(t);
  const mine = path.join(e.home, 'data/applications/brave-browser.desktop');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, '[Desktop Entry]\nName=My Brave\nExec=brave --incognito %U\n');
  assert.throws(() => enable('brave-browser.desktop', e), /your own launcher/);
  assert.throws(() => disable('brave-browser.desktop', e), /not one WhisperBrain made/);
  assert.match(fs.readFileSync(mine, 'utf8'), /My Brave/);
  assert.throws(() => enable('firefox.desktop', e), /not found/);
});
