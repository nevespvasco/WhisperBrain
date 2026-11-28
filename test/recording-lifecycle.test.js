'use strict';
// The recording's life when things happen at the wrong moment: Stop while it is still starting, Resume while a pause is still
// flushing, a speech engine that dies mid-meeting, a capture process that exits, a quit or a crash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');

const later = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const pcm = (ms) => Buffer.alloc(ms * 32);

// An engine whose steps a test can hold: `gate.start` / `gate.flush` are promises the call waits on when set.
class FakeEngine extends EventEmitter {
  constructor() { super(); this.log = []; this.gate = {}; }
  async start() { this.log.push('start'); if (this.gate.start) await this.gate.start; }
  feed(ch, buf) { this.log.push(`feed:${ch}:${buf.length}`); }
  async flush(ch) { this.log.push(`flush:${ch}`); if (this.gate.flush) await this.gate.flush; }
  reset(ch) { this.log.push(`reset:${ch}`); }
}

// A native source that remembers whether it was stopped.
class Native extends EventEmitter { constructor() { super(); this.stopped = false; this.started = false; } start() { this.started = true; } stop() { this.stopped = true; } }

function rig({ capture = { mic: 'renderer', system: 'renderer' }, platform: extra = {}, discord = null, settings: s = {} } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ echoDedupe: false, ...s });
  const engine = new FakeEngine();
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx' };
  const platform = { capture, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource(), ...extra };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, discord });
  return { db, bus, events, notes, settings, engine, mgr };
}

// ---- Stop while Start is still waiting ----
test('stop while the engine is still loading: the start is cancelled, nothing is left running, the note is not "recording"', async () => {
  const r = rig({ capture: { mic: 'native', system: 'renderer' } });
  const mics = [];
  r.mgr.platform.createMicSource = () => { const m = new Native(); mics.push(m); return m; };
  const n = r.notes.create({});
  const gate = later();
  r.engine.gate.start = gate.p;
  const starting = r.mgr.start(n.id);
  const stopping = r.mgr.stop();
  gate.resolve();
  await assert.rejects(starting, (e) => e.code === 'cancelled');
  const out = await stopping;
  assert.equal(out.cancelled, true);
  assert.equal(r.mgr.status().active, false);
  assert.notEqual(r.notes.get(n.id).status, 'recording');
  assert.ok(mics.every((m) => m.stopped), 'a source opened meanwhile is closed');
  assert.ok(!r.events.some((e) => e.type === 'recording.started'));
  // and the slot is free again
  await r.mgr.start(n.id);
  await r.mgr.stop();
  assert.equal(r.notes.get(n.id).status, 'done');
});

test('stop while the microphone (echo cancellation) is still opening: the microphone is closed once it arrives', async () => {
  const gate = later();
  const mic = new Native();
  const r = rig({ capture: { mic: 'native', system: 'renderer' }, platform: { openMicSource: async () => { await gate.p; return mic; } } });
  const n = r.notes.create({});
  const starting = r.mgr.start(n.id);
  await tick(5);
  const stopping = r.mgr.stop();
  gate.resolve();
  await assert.rejects(starting, (e) => e.code === 'cancelled');
  await stopping;
  assert.equal(mic.stopped, true);
  assert.equal(mic.started, false, 'it never started capturing');
  assert.notEqual(r.notes.get(n.id).status, 'recording');
});

test('stop while the Discord bot is joining: the bot leaves again', async () => {
  const gate = later();
  const discord = new EventEmitter();
  let left = 0;
  discord.join = async () => { await gate.p; return { channel: 'General' }; };
  discord.leave = () => { left++; };
  const r = rig({ discord, settings: { discord: { enabled: true, token: 't', userId: 'u1' } } });
  const n = r.notes.create({});
  const starting = r.mgr.start(n.id);
  await tick(5);
  const stopping = r.mgr.stop();
  gate.resolve();
  await assert.rejects(starting, (e) => e.code === 'cancelled');
  await stopping;
  assert.equal(left, 1);
  assert.equal(discord.listenerCount('audio'), 0);
});

test('the microphone opens while the Discord bot joins, not after it', async () => {
  const gate = later();
  const order = [];
  const discord = new EventEmitter();
  discord.join = async () => { order.push('join'); await gate.p; order.push('joined'); return null; };
  discord.leave = () => {};
  const r = rig({ discord, capture: { mic: 'native', system: 'renderer' }, settings: { discord: { enabled: true, token: 't' } }, platform: { openMicSource: async () => { order.push('mic'); return new Native(); } } });
  const n = r.notes.create({});
  const starting = r.mgr.start(n.id);
  await tick(5);
  assert.ok(order.includes('mic'), `the microphone did not wait for the bot: ${order}`);
  gate.resolve();
  await starting;
  await r.mgr.stop();
});

test('a failing Discord join or a speaker test that cannot run still closes a microphone opened in parallel', async () => {
  const mic = new Native();
  const discord = new EventEmitter();
  discord.join = async () => null; // not in a voice channel
  discord.leave = () => {};
  const r = rig({ discord, capture: { mic: 'native', system: 'renderer' }, settings: { discord: { enabled: true, token: 't' } }, platform: { openMicSource: async () => mic } });
  const n = r.notes.create({});
  await assert.rejects(r.mgr.start(n.id, { speakerTest: true }), (e) => e.code === 'no-discord');
  await tick(5);
  assert.equal(mic.stopped, true);
});

// ---- Resume while the pause is still flushing ----
test('resume during a pause that is still flushing waits for it: audio is never fed into a channel about to be reset', async () => {
  const r = rig();
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.mgr.pushPcm(n.id, 'mic', pcm(100));
  const gate = later();
  r.engine.gate.flush = gate.p;
  const pausing = r.mgr.pause();
  const resuming = r.mgr.resume();
  r.mgr.pushPcm(n.id, 'mic', pcm(50)); // still settling: this must not reach the engine
  assert.equal(r.engine.log.filter((x) => x.startsWith('feed')).length, 1);
  gate.resolve();
  r.engine.gate.flush = null;
  await pausing;
  await resuming;
  assert.equal(r.mgr.status().paused, false);
  r.mgr.pushPcm(n.id, 'mic', pcm(50));
  const log = r.engine.log;
  assert.ok(log.indexOf('reset:mic') < log.lastIndexOf('feed:mic:1600'), `the reset comes before new audio: ${log}`);
  await r.mgr.stop();
});

test('stop during a pause that is still flushing waits for it and finishes the note', async () => {
  const r = rig();
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  const gate = later();
  r.engine.gate.flush = gate.p;
  const pausing = r.mgr.pause();
  const stopping = r.mgr.stop();
  await tick(5);
  gate.resolve();
  await pausing;
  const out = await stopping;
  assert.equal(out.note.status, 'done');
});


// ---- the speech engine dies in the middle of a meeting ----
const fs = require('node:fs');
const path = require('node:path');
const { Speakers } = require('../src/speakers/store');
const { Evidence } = require('../src/meet/evidence');
const { Spool } = require('../src/recording/spool');
const { tmpDir } = require('./helpers');

// With a speaker store and a spool directory, so the raw audio is kept while recording (the default setup).
// engine.recover(pcm) answers the after-Stop transcription of a missed stretch (transcribePcm's batch path).
function spoolRig(t, { settings: s = {}, run = null, spoolDir = tmpDir('wb-rec-'), db = open(':memory:') } = {}) {
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus), evidence = new Evidence(db);
  settings.update({ echoDedupe: false, speakerDiarize: true, speakerRefine: false, ...s });
  const engine = new FakeEngine();
  engine.recovered = [];
  engine.recover = () => [];
  engine.transcribeParallel = async (buf) => { engine.recovered.push(buf.length / 2); return engine.recover(buf); };
  const seg = !!run;
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad', speakerInstalled: () => seg, speakerPath: () => '/spk', segmentationInstalled: () => seg, segmentationPath: () => '/seg' };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, evidence, spoolDir, diarization: run ? { run } : {} });
  mgr.restartBackoff = [0, 0, 0];
  t.after(() => fs.rmSync(spoolDir, { recursive: true, force: true }));
  return { db, bus, events, notes, settings, speakers, evidence, engine, mgr, spoolDir };
}
const sec = (s) => Buffer.alloc(Math.round(s * 32000));
const warned = (events, re) => events.some((e) => e.type === 'recording.warning' && re.test(e.data.message));

test('the speech engine dies mid-recording: it is restarted, and what it missed is transcribed from the spool at Stop, before the speaker pass', async (t) => {
  const run = async () => ({ turns: [{ start: 0, end: 10, speaker: 0 }], voices: [{ speaker: 0, centroid: null }] });
  const r = spoolRig(t, { run });
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.mgr.pushPcm(n.id, 'mic', sec(1));
  r.engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 500, text: 'said before the crash' });
  r.mgr.pushPcm(n.id, 'mic', sec(1)); // decoded by nobody: the worker dies with it in its buffers
  r.engine.emit('exit', new Error('ASR worker exited (SIGKILL)'));
  r.mgr.pushPcm(n.id, 'mic', sec(0.5)); // while it restarts
  await tick(10);
  assert.equal(r.engine.log.filter((x) => x === 'start').length, 2, 'restarted');
  assert.ok(warned(r.events, /restart/i));
  r.mgr.pushPcm(n.id, 'mic', sec(1)); // the new worker: a new stretch of the spool
  assert.equal(r.mgr.active.stretches.mic.length, 2);
  r.engine.recover = () => [{ startMs: 100, endMs: 900, text: 'words the crash missed' }];
  const out = await r.mgr.stop();
  assert.deepEqual(r.engine.recovered, [Math.round(1.5 * 16000) + 8000], 'from the end of the last line to the restart');
  const segs = r.notes.segments(n.id);
  const rec = segs.find((x) => x.text === 'words the crash missed');
  assert.ok(rec, 'the missed words are in the transcript');
  assert.equal(rec.speaker, 'me');
  const first = segs.find((x) => x.text === 'said before the crash');
  assert.ok(rec.startMs - first.startMs >= 500 + 100 - 5 && rec.startMs - first.startMs <= 500 + 100 + 5, `on the timeline where they were said (${rec.startMs - first.startMs})`);
  const segEvent = r.events.findIndex((e) => e.type === 'transcript.segment' && e.data.segment.text === 'words the crash missed');
  const speakersStage = r.events.findIndex((e) => e.type === 'recording.finalizing' && e.data.stage === 'speakers');
  assert.ok(segEvent >= 0 && segEvent < speakersStage, 'transcribed before the speaker pass, which then sees them');
  assert.equal(out.note.status, 'done');
  assert.deepEqual(fs.readdirSync(r.spoolDir), [], 'nothing left to keep');
});

test('segments for a channel that is not this recording\'s (a stretch transcribed again) are not saved by the live path', async (t) => {
  const r = spoolRig(t);
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.engine.emit('segment', { ch: 'recover:mic', startMs: 0, endMs: 500, text: 'not a live line' });
  r.engine.emit('segment', { ch: 'import', startMs: 0, endMs: 500, text: 'nor this' });
  assert.equal(r.notes.segments(n.id).length, 0);
  await r.mgr.stop();
});

test('a speech engine that cannot be brought back: the audio it missed is kept with what is needed to transcribe it later', async (t) => {
  const r = spoolRig(t);
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.mgr.pushPcm(n.id, 'mic', sec(1));
  r.engine.start = async () => { throw new Error('out of memory'); };
  r.engine.emit('exit', new Error('ASR worker exited (SIGKILL)'));
  await tick(10);
  r.mgr.pushPcm(n.id, 'mic', sec(1));
  const out = await r.mgr.stop();
  assert.equal(out.note.status, 'done', 'the note is finished all the same');
  const stopped = r.events.find((e) => e.type === 'recording.stopped');
  assert.equal(stopped.data.deferred, true, 'the app is told to finish it in the background');
  const left = Spool.leftovers(r.spoolDir);
  assert.equal(left.length, 1);
  assert.equal(left[0].meta.noteId, n.id);
  assert.deepEqual(left[0].meta.gaps, [{ from: 0, to: 32000 }]);
  assert.ok(warned(r.events, /kept/));
});

test('a spool that cannot be written (disk full) says so once and the recording carries on', async (t) => {
  const r = spoolRig(t);
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.mgr.pushPcm(n.id, 'mic', sec(0.1));
  const sp = r.mgr.active.spool.mic;
  fs.closeSync(sp.fd); // every write now fails
  sp.fd = fs.openSync(path.join(r.spoolDir, 'ro'), 'w'); fs.closeSync(sp.fd);
  r.mgr.pushPcm(n.id, 'mic', sec(0.1));
  r.mgr.pushPcm(n.id, 'mic', sec(0.1));
  assert.equal(r.events.filter((e) => e.type === 'recording.warning' && /disk|saved audio/i.test(e.data.message)).length, 1);
  assert.equal(r.engine.log.filter((x) => x.startsWith('feed')).length, 3, 'transcription goes on');
  await r.mgr.stop();
});

// ---- a crash or a quit ----
test('after a crash, notes left "recording" are finished: done, ended at their last line, marked interrupted, and handed back for analysis', async (t) => {
  const r = spoolRig(t);
  const n = r.notes.create({});
  r.notes.update(n.id, { status: 'recording', startedAt: 1_000_000 });
  r.notes.addSegments(n.id, [{ speaker: 'me', startMs: 0, endMs: 4000, text: 'hello' }, { speaker: 'them', startMs: 3000, endMs: 9000, text: 'bye' }]);
  const ids = r.mgr.recoverInterrupted();
  assert.deepEqual(ids, [{ noteId: n.id, interrupted: true }]);
  const note = r.notes.get(n.id);
  assert.equal(note.status, 'done');
  assert.equal(note.endedAt, 1_000_000 + 9000);
  assert.ok(r.evidence.forNote(n.id).some((e) => e.key === 'interrupted'), 'the interruption is on record');
  assert.deepEqual(r.mgr.recoverInterrupted(), [], 'once');
});

test('a crash leaves the spool: the next start keeps it, transcribes the tail nobody decoded, and deletes it', async (t) => {
  const dir = tmpDir('wb-rec-');
  const db = open(':memory:');
  const first = spoolRig(t, { spoolDir: dir, db });
  const n = first.notes.create({});
  await first.mgr.start(n.id, { system: false });
  first.mgr.pushPcm(n.id, 'mic', sec(3));
  first.engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 1000, text: 'the last line saved' });
  // the app dies here: no stop(), the spool and its notes stay on disk, the note stays 'recording'
  const spoolFile = first.mgr.active.spool.mic.file;
  const r = spoolRig(t, { spoolDir: dir, db });
  assert.ok(fs.existsSync(spoolFile), 'a young spool of a note that still exists is not swept');
  const ids = r.mgr.recoverInterrupted();
  assert.deepEqual(ids, [{ noteId: n.id, interrupted: true }]);
  r.engine.recover = () => [{ startMs: 200, endMs: 1500, text: 'the tail' }];
  const res = await r.mgr.recoverNote(n.id);
  assert.equal(res.transcribed, 1);
  assert.deepEqual(r.engine.recovered, [32000], 'from the end of the last line to the end of the audio');
  const tail = r.notes.segments(n.id).find((x) => x.text === 'the tail');
  const last = r.notes.segments(n.id).find((x) => x.text === 'the last line saved');
  assert.ok(Math.abs(tail.startMs - last.startMs - 1200) <= 5, `at its place on the timeline (${tail.startMs - last.startMs})`);
  assert.equal(fs.existsSync(spoolFile), false, 'and the audio is deleted once done');
});

test('sweep: old spools, spools without their notes and spools of deleted notes go; a young one of a note that exists stays', () => {
  const dir = tmpDir('wb-sweep-');
  const keepIt = new Spool(dir, 'kept', 'mic'); keepIt.write(sec(0.1)); keepIt.keep();
  const gone = new Spool(dir, 'deleted', 'mic'); gone.write(sec(0.1)); gone.keep();
  const old = new Spool(dir, 'kept', 'system'); old.write(sec(0.1)); old.keep();
  const past = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(old.file, past, past);
  fs.writeFileSync(path.join(dir, 'legacy.pcm'), 'x');
  const n = Spool.sweep(dir, { keep: (m) => m.noteId === 'kept' });
  assert.equal(n, 3);
  assert.deepEqual(Spool.leftovers(dir).map((x) => x.file), [keepIt.file]);
  fs.rmSync(dir, { recursive: true });
});

test('quitting: Stop does not run the long speaker pass; the note is finished at once and the pass is left to a background job', async (t) => {
  const calls = [];
  const run = async (o) => { calls.push(o); return { turns: [{ start: 0, end: 2, speaker: 0 }], voices: [{ speaker: 0, centroid: null }] }; };
  const r = spoolRig(t, { run });
  const n = r.notes.create({});
  await r.mgr.start(n.id, { system: false });
  r.mgr.pushPcm(n.id, 'mic', sec(2));
  r.engine.emit('segment', { ch: 'mic', startMs: 0, endMs: 1500, text: 'one two three four' });
  const out = await r.mgr.stop({ quick: true });
  assert.equal(out.note.status, 'done');
  assert.equal(calls.length, 0, 'no diarization while quitting');
  assert.equal(r.events.find((e) => e.type === 'recording.stopped').data.deferred, true);
  assert.equal(Spool.leftovers(r.spoolDir).length, 1, 'the audio is kept for it');
  // the background job at the next start
  const res = await r.mgr.recoverNote(n.id);
  assert.equal(calls.length, 1, 'the speaker pass runs there');
  assert.equal(res.diarized, 1);
  assert.deepEqual(Spool.leftovers(r.spoolDir), []);
});
