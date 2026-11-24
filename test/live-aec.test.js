'use strict';
// Real PipeWire echo cancellation, looped back inside a private null sink: nothing is audible, no microphone is opened
// and the user's default devices and PipeWire configuration are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { detectEchoCancel, EchoCanceller } = require('../src/platform/pw-echo-cancel');
const { parsePwDump } = require('../src/platform/linux');
const { fixture } = require('./helpers');

const hasPw = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v pw-cli pw-play pw-record pw-dump pipewire'], { stdio: 'ignore' }).status === 0
  && spawnSync('pw-dump', { stdio: 'ignore' }).status === 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = async () => { const r = spawnSync('pw-dump', { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 5000 }); try { return parsePwDump(r.stdout); } catch { return null; } };

let skip = !hasPw ? 'PipeWire tools not available' : false;
const ready = (async () => { if (!skip) { const d = await detectEchoCancel(); if (!d.available) skip = `echo cancellation unavailable: ${d.reason}`; } })();

function nullSink(name) {
  const cli = spawn('pw-cli', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  cli.stdin.write(`create-node adapter { factory.name=support.null-audio-sink node.name=${name} media.class=Audio/Sink object.linger=false audio.position=[FL,FR] priority.session=0 }\n`);
  return cli;
}
function record(args, ms) {
  const chunks = [];
  const p = spawn('pw-record', ['--rate', '16000', '--channels', '1', '--format', 's16', ...args, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.on('data', (d) => chunks.push(d));
  const done = new Promise((r) => p.on('close', r));
  setTimeout(() => p.kill('SIGTERM'), ms);
  return done.then(() => Buffer.concat(chunks));
}
const rms = (buf) => { const n = buf.length >> 1; let s = 0; for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / Math.max(1, n)); };
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('whisperbrain-aec-')).length;
const defaults = async () => { const d = await dump(); return `${d?.defaultSink}|${d?.defaultSource}`; };

test('PipeWire really cancels what the speakers played, and leaves nothing behind', async (t) => {
  await ready;
  if (skip) return t.skip(skip);
  const sink = `wb-aec-test-sink-${process.pid}`;
  const cli = nullSink(sink);
  t.after(() => { cli.stdin.end('quit\n'); cli.kill(); });
  await wait(800);
  const before = await defaults();
  const leftBefore = tmpLeft();

  const aec = new EchoCanceller({ dump });
  t.after(() => aec.stop());
  // the "microphone" is the speakers' own monitor: a perfect echo of exactly what is played
  const name = await aec.start({ mic: sink, sink, captureSink: true });
  const d = await dump();
  assert.ok(d.sources.some((s) => s.id === name), 'the echo-cancelled source is listed');
  assert.equal(await defaults(), before, 'the default devices did not change');

  const cancelled = record(['--target', name], 11000);
  const raw = record(['-P', 'stream.capture.sink=true', '--target', sink], 11000);
  await wait(800);
  spawnSync('pw-play', ['--target', sink, fixture('speech-0.wav')]); // about 7 s
  const [c, r] = await Promise.all([cancelled, raw]);
  // compare seconds 3 to 6 of the 7 s playback, after the filter has had time to adapt
  const tail = (b) => b.subarray(32000 * 3, 32000 * 6);
  const loud = rms(tail(r)), left = rms(tail(c));
  assert.ok(c.length > 32000 * 6.5 && r.length > 32000 * 6.5, `the cancelled source delivered audio (${c.length} / ${r.length} bytes)`);
  assert.ok(loud > 50, `the speakers' monitor carried the speech (rms ${loud})`);
  assert.ok(left < loud / 4, `echo is at least 12 dB lower (before ${loud.toFixed(0)}, after ${left.toFixed(0)})`);

  await aec.stop();
  await wait(500);
  assert.ok(!(await dump())?.sources.some((s) => s.id === name), 'the source is gone after stop');
  assert.equal(await defaults(), before);
  assert.equal(tmpLeft(), leftBefore, 'the temporary config is deleted');
});

test('the helper does not outlive a crashed app', async (t) => {
  await ready;
  if (skip) return t.skip(skip);
  const script = `
    const { EchoCanceller } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'platform', 'pw-echo-cancel.js'))});
    const { parsePwDump } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'platform', 'linux.js'))});
    const { spawnSync } = require('node:child_process');
    const dump = async () => { try { return parsePwDump(spawnSync('pw-dump', { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 5000 }).stdout); } catch { return null; } };
    new EchoCanceller({ dump }).start({}).then((n) => { console.log('READY ' + n); setInterval(() => {}, 1000); }, (e) => { console.error(e.message); process.exit(1); });`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let name = null;
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { const m = /READY (\S+)/.exec(String(d)); if (m) { name = m[1]; resolve(); } });
    child.on('exit', () => reject(new Error('child exited before the helper was ready')));
  });
  assert.ok((await dump())?.sources.some((s) => s.id === name), 'helper is running');
  child.kill('SIGKILL');
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { await wait(300); gone = !(await dump())?.sources.some((s) => s.id === name); }
  assert.ok(gone, 'the echo-cancelled source disappeared within 6 s of the app dying');
  for (const n of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('whisperbrain-aec-'))) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true }); // a SIGKILLed app cannot clean its own temp config
});
