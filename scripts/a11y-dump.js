#!/usr/bin/env node
'use strict';
// Captures the accessibility tree of the browser window that shows a Google Meet call, to write or check the selectors
// (src/meet/selectors/meet.json). Run it during a real call, on each system:
//   npm run a11y:dump -- [--redact] [--keep REGEX] [--out file.json] [--tries 5]
// With --redact, names and text are replaced by their length: the file is then fit to attach to an issue. READ IT FIRST.
// Linux needs the browser started with --force-renderer-accessibility (Settings → Meetings does that for you);
// macOS asks for the Accessibility permission; Windows needs nothing.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { helperSpec, loadSelectors } = require('../src/meet/a11y-source');
const { readMeeting } = require('../src/meet/a11y');
const { redactSnapshot } = require('../src/meet/redact');

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const root = path.join(__dirname, '..');
const spec = helperSpec(process.platform, { roots: [path.join(root, 'build'), path.join(root, 'native')] });
if (!spec) { console.error(`No accessibility helper for this system. ${process.platform === 'linux' ? 'Build it: npm run build:atspi' : process.platform === 'darwin' ? 'Build it: npm run build:ax' : ''}`); process.exit(2); }

const tries = Number(arg('tries', 5));
const child = spawn(spec.command, spec.args('dump'), { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const states = [];
let snapshot = null;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.startsWith('{')) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.event === 'status' || m.event === 'permission') states.push(m);
  if (m.event === 'snapshot' && !snapshot) { snapshot = m; child.kill(); }
});
child.on('exit', () => {
  if (!snapshot) {
    const last = states.at(-1);
    console.error(`No meeting window was read (${last ? `${last.event}: ${last.state ?? (last.trusted ? 'trusted' : 'not trusted')}` : 'nothing reported'}).`);
    if (last?.state === 'no-web-tree') console.error('The browser is not exposing the page. Linux: start it with --force-renderer-accessibility, then try again.');
    if (last?.state === 'no-window' || last?.state === 'no-apps') console.error('Open the Meet call in Chrome, Edge or Brave first (its window title must contain the meeting code).');
    if (last?.event === 'permission') console.error('macOS: allow WhisperBrain (or your terminal) in System Settings → Privacy & Security → Accessibility.');
    process.exit(1);
  }
  const out = arg('redact') ? redactSnapshot(snapshot, { keep: arg('keep') && arg('keep') !== true ? new RegExp(arg('keep'), 'iu') : null }) : snapshot;
  const text = JSON.stringify({ platform: process.platform, capturedAt: new Date().toISOString(), redacted: !!arg('redact'), snapshot: out }, null, 1);
  const file = arg('out') && arg('out') !== true ? arg('out') : null;
  if (file) { fs.writeFileSync(file, text); console.error(`wrote ${file}`); } else process.stdout.write(`${text}\n`);
  try {
    const m = readMeeting(snapshot, loadSelectors(path.join(process.env.WB_DATA || '', 'meet-selectors.json')).sel);
    console.error(`${snapshot.nodes.length} nodes. With the current selectors: ${m.found ? `${m.participants.length} people (${m.participants.map((p) => (p.speaking ? '*' : '') + (p.self ? '(you)' : 'person')).join(', ')}), speaking: ${m.speaking.length}` : 'no participants list found — the selectors need work'}.`);
  } catch (e) { console.error(`selectors: ${e.message}`); }
});
setTimeout(() => { console.error('timed out'); child.kill(); }, 8000 + tries * 1000).unref();
