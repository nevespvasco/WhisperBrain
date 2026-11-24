'use strict';
// Real PipeWire: two applications play different tones into one (private, silent) output; capturing one application must
// give that tone and not the other's. Skips itself where PipeWire is not available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createPlatform } = require('../src/platform');
const { parsePwDump } = require('../src/platform/linux');
const { tmpDir } = require('./helpers');

const hasPw = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v pw-cli pw-play pw-record'], { stdio: 'ignore' }).status === 0
  && spawnSync('pw-dump', { stdio: 'ignore' }).status === 0;
const skip = !hasPw ? 'PipeWire tools not available' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16000;

function wav(file, hz, seconds) {
  const n = RATE * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / RATE) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// How much of a pure tone is in the samples (Goertzel), as a share of the signal's power: 0..1
function toneShare(pcm, hz) {
  const n = pcm.length >> 1;
  if (n < 1000) return 0;
  const w = 2 * Math.PI * hz / RATE, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0, power = 0;
  for (let i = 0; i < n; i++) { const x = pcm.readInt16LE(i * 2) / 32768; power += x * x; const s = x + c * s1 - s2; s2 = s1; s1 = s; }
  const mag = s1 * s1 + s2 * s2 - c * s1 * s2;
  return power ? (2 * mag / n) / power : 0;   // for a pure tone this is ~1
}

function nullSink(name) {
  const cli = spawn('pw-cli', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  cli.stdin.write(`create-node adapter { factory.name=support.null-audio-sink node.name=${name} media.class=Audio/Sink object.linger=false audio.position=[FL,FR] }\n`);
  return cli;
}
const playTone = (sink, app, file) => spawn('pw-play', ['--target', sink, '-P', `{ application.name=${app} }`, file], { stdio: 'ignore' });

async function waitForStream(name, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = spawnSync('pw-dump', { encoding: 'utf8', maxBuffer: 32 << 20 });
    const s = parsePwDump(d.stdout).outputStreams.find((x) => x.name === name && x.running);
    if (s) return s;
    await wait(150);
  }
  throw new Error(`no running playback stream named ${name}`);
}

async function capture(src, ms) {
  const chunks = [];
  src.on('pcm', (b) => chunks.push(b));
  src.start();
  await wait(ms);
  return { src, pcm: () => Buffer.concat(chunks) };
}

test('capturing one application gives its audio and not another application\'s', { skip, timeout: 60000 }, async (t) => {
  const dir = tmpDir('wb-perapp-');
  const sinkName = `wb-perapp-sink-${process.pid}`;
  const cli = nullSink(sinkName);
  const players = [];
  t.after(() => { for (const p of players) p.kill(); cli.stdin.end('quit\n'); cli.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  wav(path.join(dir, 'a.wav'), 440, 12);
  wav(path.join(dir, 'b.wav'), 1000, 12);
  await wait(800);
  const a = playTone(sinkName, 'wb-tone-a', path.join(dir, 'a.wav'));
  const b = playTone(sinkName, 'wb-tone-b', path.join(dir, 'b.wav'));
  players.push(a, b);
  await waitForStream('wb-tone-a'); await waitForStream('wb-tone-b');
  const platform = createPlatform();

  for (const [name, who, tones] of [['A', 'wb-tone-a', [440, 1000]], ['B', 'wb-tone-b', [1000, 440]]]) {
    const src = await platform.createSystemSource({ sink: sinkName, app: { name: who, appId: 'other' } });
    assert.equal(src.capture.mode, 'app', `${name}: its own stream was found`);
    const got = await capture(src, 2500);
    src.stop();
    const pcm = got.pcm();
    assert.ok(pcm.length > RATE, `${name}: audio arrived (${pcm.length} bytes)`);
    const [want, notWant] = [toneShare(pcm, tones[0]), toneShare(pcm, tones[1])];
    assert.ok(want > 0.6, `${name}: its own tone is there (${want.toFixed(2)})`);
    assert.ok(notWant < 0.05, `${name}: the other application's tone is not (${notWant.toFixed(3)})`);
  }

  // the whole output carries both (so the test would notice if "per app" were really "everything")
  const whole = await platform.createSystemSource({ sink: sinkName });
  assert.equal(whole.capture.mode, 'output');
  const all = await capture(whole, 2500); whole.stop();
  assert.ok(toneShare(all.pcm(), 440) > 0.15 && toneShare(all.pcm(), 1000) > 0.15, 'the output holds both tones');
});

test('when the application\'s stream goes away the capture carries on with the whole output', { skip, timeout: 60000 }, async (t) => {
  const dir = tmpDir('wb-perapp-');
  const sinkName = `wb-perapp-sink2-${process.pid}`;
  const cli = nullSink(sinkName);
  const players = [];
  t.after(() => { for (const p of players) p.kill(); cli.stdin.end('quit\n'); cli.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  wav(path.join(dir, 'a.wav'), 440, 2);     // the application stops after 2 s
  wav(path.join(dir, 'b.wav'), 1000, 12);
  await wait(800);
  const a = playTone(sinkName, 'wb-tone-a', path.join(dir, 'a.wav'));
  const b = playTone(sinkName, 'wb-tone-b', path.join(dir, 'b.wav'));
  players.push(a, b);
  await waitForStream('wb-tone-a'); await waitForStream('wb-tone-b');
  const src = await createPlatform().createSystemSource({ sink: sinkName, app: { name: 'wb-tone-a', appId: 'other' } });
  const modes = [];
  src.on('capture', (c) => modes.push(c.mode));
  const got = await capture(src, 6000);
  src.stop();
  assert.deepEqual(modes, ['output'], 'it noticed the stream was gone and widened the capture');
  assert.ok(toneShare(got.pcm().subarray(got.pcm().length - RATE * 2), 1000) > 0.5, 'afterwards the other application is heard (the output)');
});
