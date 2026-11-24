'use strict';
// Real PipeWire capture. Uses a private null sink so nothing is audible and the user's default devices are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { AsrEngine } = require('../src/asr/engine');
const { RecordingManager } = require('../src/recording/manager');
const { createPlatform } = require('../src/platform');
const { testModels, fixture } = require('./helpers');

const models = testModels();
const hasPw = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v pw-cli pw-play pw-record'], { stdio: 'ignore' }).status === 0
  && spawnSync('pw-dump', { stdio: 'ignore' }).status === 0;
const skip = !hasPw ? 'PipeWire tools not available' : !models ? 'no ASR model installed' : false;

function nullSink(name) {
  const cli = spawn('pw-cli', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  cli.stdin.write(`create-node adapter { factory.name=support.null-audio-sink node.name=${name} media.class=Audio/Sink object.linger=false audio.position=[FL,FR] }\n`);
  return cli;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('system audio played into a sink is captured and transcribed as "them"', { skip, timeout: 120000 }, async (t) => {
  const name = `wb-test-sink-${process.pid}`;
  const cli = nullSink(name);
  t.after(() => { cli.stdin.end('quit\n'); cli.kill(); });
  await wait(800);

  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const engine = new AsrEngine();
  t.after(() => engine.stop());
  const platform = createPlatform();
  const realCreate = platform.createSystemSource.bind(platform);
  platform.createSystemSource = () => realCreate({ sink: name });
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus });

  const note = notes.create({ title: 'live' });
  await mgr.start(note.id, { mic: false, system: true });
  await wait(500);
  const play = spawn('pw-play', ['--target', name, fixture('speech-0.wav')], { stdio: 'ignore' });
  await new Promise((r) => play.on('close', r));
  await wait(1500);
  await mgr.stop();

  const segs = notes.segments(note.id);
  assert.ok(segs.length >= 1, 'expected at least one transcribed segment');
  assert.ok(segs.every((s) => s.speaker === 'them'));
  assert.ok(segs.map((s) => s.text).join(' ').length > 20, `got: ${JSON.stringify(segs)}`);
});

test('the mic activity probe runs against the live PipeWire graph', { skip: hasPw ? false : 'PipeWire tools not available' }, async () => {
  const r = await createPlatform().micActivity();
  assert.equal(r.supported, true);
  assert.equal(typeof r.active, 'boolean');
});

test('listing microphones returns the default device flagged', { skip: hasPw ? false : 'PipeWire tools not available' }, async () => {
  const mics = await createPlatform().listMics();
  assert.ok(Array.isArray(mics));
  if (mics.length) assert.ok(mics.some((m) => m.default));
});

const helper = require('node:path').join(__dirname, '..', 'build', 'x11', 'whisperbrain-x11');
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
test('the X11 helper sends a paste keystroke (inside a private Xvfb display)', { skip: !fs.existsSync(helper) ? 'helper not built (npm run build:x11)' : !xvfb ? 'xvfb-run missing' : false }, () => {
  const r = spawnSync('xvfb-run', ['-a', helper, 'paste'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const term = spawnSync('xvfb-run', ['-a', helper, 'paste', 'term'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(term.status, 0, term.stderr);
});

const hasXclip = spawnSync('sh', ['-c', 'command -v xclip'], { stdio: 'ignore' }).status === 0;
test('linux paste path: xclip clipboard + XTest keystroke, run inside a private Xvfb display', { skip: !fs.existsSync(helper) || !xvfb || !hasXclip ? 'needs the helper, xvfb-run and xclip' : false, timeout: 30000 }, () => {
  const script = `
    const { createPlatform } = require(${JSON.stringify(require('node:path').join(__dirname, '..', 'src', 'platform'))});
    (async () => {
      const p = createPlatform();
      const r = await p.paste('olá mundo — dictated', { restore: false });
      const back = await p.clipboard.read();
      console.log(JSON.stringify({ r, back, session: p.session }));
      process.exit(0);
    })();`;
  const out = spawnSync('xvfb-run', ['-a', process.execPath, '-e', script], { encoding: 'utf8', timeout: 25000, env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' } });
  assert.equal(out.status, 0, out.stderr);
  const res = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(res.session, 'x11');
  assert.deepEqual(res.r, { ok: true, method: 'xtest' });
  assert.equal(res.back, 'olá mundo — dictated');
});
