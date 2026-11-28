'use strict';
// The live ASR worker as a process that can die, hang or fall behind: flushes have their own ids and a deadline, a dead or
// unreachable child is reported once (never as an uncaught exception), and the engine knows its backlog.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { AsrEngine, AsrWorker } = require('../src/asr/engine');

// A child process stand-in: records what is sent, can be killed, can exit or fail like a real one.
class FakeChild extends EventEmitter {
  constructor() { super(); this.sent = []; this.killed = null; this.connected = true; this.pid = 4242; }
  send(m) { this.sent.push(m); return true; }
  kill(sig = 'SIGTERM') { this.killed = sig; }
}
const sec = (s) => Buffer.alloc(s * 32000);

test('flush: every request has its own id, so a pause flush and a stop flush on one channel never answer each other', async () => {
  const w = new AsrWorker('live');
  const child = new FakeChild();
  w.adopt(child);
  const order = [];
  const a = w.flush('mic').then(() => order.push('a'));
  const b = w.flush('mic').then(() => order.push('b'));
  const [ma, mb] = child.sent.filter((m) => m.t === 'flush');
  assert.notEqual(ma.id, mb.id);
  child.emit('message', { t: 'flushed', ch: 'mic', id: ma.id });
  await a;
  assert.deepEqual(order, ['a'], 'the second flush is still waiting for its own answer');
  child.emit('message', { t: 'flushed', ch: 'mic', id: mb.id });
  await b;
  assert.deepEqual(order, ['a', 'b']);
});

test('flush: an error the worker reports for a flush reaches that flush', async () => {
  const w = new AsrWorker('live');
  const child = new FakeChild();
  w.adopt(child);
  const p = w.flush('system');
  const { id } = child.sent.find((m) => m.t === 'flush');
  child.emit('message', { t: 'error', message: 'decode failed', id });
  await assert.rejects(p, /decode failed/);
});

test('flush: a worker that never answers is killed after a deadline, and its death is reported as an exit', async () => {
  const w = new AsrWorker('live');
  const child = new FakeChild();
  w.adopt(child);
  const exits = [];
  w.on('exit', (e) => exits.push(e.message));
  await assert.rejects(w.flush('mic', { timeoutMs: 20 }), /did not finish/);
  assert.equal(child.killed, 'SIGKILL');
  child.emit('exit', null, 'SIGKILL');
  assert.equal(exits.length, 1);
  assert.equal(w.running, false);
});

test('flush: the deadline grows with the audio still waiting to be decoded', () => {
  const w = new AsrWorker('live');
  const child = new FakeChild();
  w.adopt(child);
  const idle = w.flushTimeout();
  w.feed('mic', sec(60));
  assert.equal(w.queued, 60 * 16000);
  assert.ok(w.flushTimeout() >= idle + 60 * 1000, `${w.flushTimeout()} should allow for a minute of backlog over ${idle}`);
  child.emit('message', { t: 'ack', n: 60 * 16000 });
  assert.equal(w.queued, 0);
  assert.equal(w.flushTimeout(), idle);
});

test('an IPC error on a child that is gone is handled: one exit, the waiters fail, nothing is thrown', async () => {
  const w = new AsrWorker('live');
  const child = new FakeChild();
  w.adopt(child);
  const exits = [];
  w.on('exit', (e) => exits.push(e.message));
  const p = w.flush('mic');
  child.connected = false;
  child.emit('error', Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
  await assert.rejects(p, /channel closed|exited/);
  child.emit('exit', 1, null); // the real exit that follows is not reported twice
  assert.equal(exits.length, 1);
});

test('backlog: the engine counts audio sent against audio decoded, and above a limit gives up live drafts and says why', () => {
  const engine = new AsrEngine();
  const child = new FakeChild();
  engine.live.adopt(child);
  engine.live.model = { id: 'm' };
  engine.live.draftOn = true;
  engine.draftModel = { id: 'draft' };
  const offs = [];
  engine.on('draft-off', (e) => offs.push(e.reason));
  engine.feed('mic', sec(5));
  assert.equal(engine.queued, 5 * 16000);
  assert.equal(offs.length, 0);
  for (let i = 0; i < 20; i++) engine.feed('mic', sec(1));
  assert.equal(offs.length, 1, 'switched off once');
  assert.match(offs[0], /behind/);
  assert.ok(child.sent.some((m) => m.t === 'draft' && m.config === null), 'the worker is told to drop the streaming model');
  engine.feed('mic', sec(1));
  assert.equal(offs.length, 1, 'not again');
  child.emit('message', { t: 'ack', n: 26 * 16000 });
  assert.equal(engine.queued, 0);
});

test('backlog: a big one is reported once as a warning even without drafts', () => {
  const engine = new AsrEngine();
  const child = new FakeChild();
  engine.live.adopt(child);
  engine.live.model = { id: 'm' };
  const warnings = [];
  engine.on('warning', (w) => warnings.push(w.message));
  for (let i = 0; i < 70; i++) engine.feed('mic', sec(1));
  for (let i = 0; i < 10; i++) engine.feed('mic', sec(1));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /behind/);
});

// The real worker script, without any model: protocol only.
test('worker: a flush is answered with its id, and audio it failed on is still acknowledged', { timeout: 20000 }, async (t) => {
  const child = fork(path.join(__dirname, '..', 'src', 'asr', 'worker.js'), [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill());
  const got = [];
  const wait = (pred) => new Promise((resolve) => { const on = (m) => { got.push(m); if (pred(m)) { child.off('message', on); resolve(m); } }; child.on('message', on); });
  const acked = wait((m) => m.t === 'ack');
  child.send({ t: 'audio', ch: 'mic', pcm: sec(1) }); // no recognizer was ever loaded: this fails inside the worker
  const ack = await acked;
  assert.equal(ack.n, 16000);
  const flushed = wait((m) => m.t === 'flushed');
  child.send({ t: 'flush', ch: 'mic', id: 77 });
  assert.equal((await flushed).id, 77);
  assert.ok(got.some((m) => m.t === 'error'), 'the failure itself is reported');
});
