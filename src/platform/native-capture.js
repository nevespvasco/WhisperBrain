'use strict';
// System audio captured by a small native helper instead of the renderer (macOS: whisperbrain-tap, Core Audio process tap;
// Windows: whisperbrain-loopback.exe, WASAPI process loopback). Both speak the same command line and write raw PCM
// (s16le, 16 kHz, mono) to stdout, so they are read like pw-record is on Linux:
//   <helper> system [--pid N | --exe NAME]    the audio of that process (and its children), else everything that plays
//   <helper> mic                              the microphone with echo cancellation (macOS only; off for now)
//   <helper> probe                            one line of JSON: what this machine can do
//   <helper> selftest                         checks the conversion on a synthetic tone, no audio hardware needed
const fs = require('node:fs');
const path = require('node:path');
const { ProcessSource, FallbackSource } = require('../audio/source');

const FILES = {
  darwin: ['tap/whisperbrain-tap', 'bin/whisperbrain-tap'],
  win32: ['loopback/whisperbrain-loopback.exe', 'bin/whisperbrain-loopback.exe'],
};

// roots: the folders to look in (the build output, the packaged app's resources). -> { file, command, prefixArgs } | null
function captureHelperSpec(platformId, { roots = [], exists = fs.existsSync } = {}) {
  for (const rel of FILES[platformId] || []) {
    const file = roots.map((r) => path.join(r, rel)).find((p) => exists(p));
    if (file) return { file, command: file, prefixArgs: [] };
  }
  return null;
}

// What the helper is told about the application. Only a process number or a plain program name goes on a command line.
function systemArgs(app) {
  if (Number.isInteger(app?.pid) && app.pid > 0) return ['system', '--pid', String(app.pid)];
  if (typeof app?.exe === 'string' && /^[\w.() -]{1,64}\.exe$/i.test(app.exe)) return ['system', '--exe', app.exe];
  return ['system'];
}

// The system channel for a recording. With an application: that application's audio, and the whole output if the helper
// cannot follow it or it goes away (the channel must not fall silent). `capture` says which, as on Linux.
function systemSource(spec, app) {
  const record = (args, label) => new ProcessSource(spec.command, [...(spec.prefixArgs || []), ...args], { label });
  const args = systemArgs(app);
  if (args.length === 1) {
    const src = record(args, 'native capture (whole output)');
    src.capture = { mode: 'output', reason: app ? 'could not tell which process to follow: capturing the whole output' : 'no application given: capturing the whole output' };
    return src;
  }
  return new FallbackSource({
    primary: record(args, `native capture (${app.name || 'application'})`),
    makeFallback: () => record(['system'], 'native capture (whole output)'),
    capture: { mode: 'app', app: app.name || app.exe || String(app.pid), reason: '' },
    fallbackCapture: { mode: 'output', reason: 'the application could not be followed or stopped playing: capturing the whole output' },
  });
}

module.exports = { captureHelperSpec, systemArgs, systemSource };
