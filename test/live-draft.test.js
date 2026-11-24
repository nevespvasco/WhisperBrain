'use strict';
// Two-pass live captions: a streaming model writes draft words while people speak, the VAD segment's final text
// replaces them. Drafts are shown, never stored, never clustered, never worker restarts; they switch off by themselves
// when the model is missing, the setting is off or the computer is too small.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AsrEngine, draftMB, DRAFT_MIN_CORES, DRAFT_MAX_THREADS, MEMORY_RESERVE_MB } = require('../src/asr/engine');
const { Models, CATALOG, AUTO_ORDER, onlineRecognizerConfig } = require('../src/asr/models');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { RecordingManager } = require('../src/recording/manager');
const { PushSource } = require('../src/audio/source');
const { transcribePcm } = require('../src/recording/import');
const { wavToPcm16 } = require('../src/audio/pcm');
const { testModels, fixture, tmpDir } = require('./helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 20000, what = 'condition') {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(25); }
}

// ---- the catalog: optional, never the main model ----
test('catalog: the streaming draft model is pinned to a real release asset, optional, and never picked for transcription', () => {
  const m = CATALOG.find((x) => x.role === 'draft');
  assert.ok(m, 'a draft model is in the catalog');
  assert.match(m.url, /\/asr-models\/sherpa-onnx-nemotron-3\.5-asr-streaming-0\.6b-320ms-int8-2026-06-11\.tar\.bz2$/);
  assert.match(m.sha256, /^[0-9a-f]{64}$/, 'has a checksum');
  assert.equal(m.kind, 'streaming-transducer');
  assert.equal(AUTO_ORDER.includes(m.id), false);
  assert.equal(CATALOG.filter((x) => x.role !== 'draft').length, CATALOG.length - 1, 'only one entry is a draft model');

  const dir = tmpDir('wb-draft-models-');
  const models = new Models(dir);
  assert.equal(models.draftModel(), null);
  assert.equal(models.list().find((x) => x.id === m.id).role, 'draft');
  // installed on its own: still no main model, and asking for it by id as the main model finds nothing
  const d = models.modelDir(m.id);
  fs.mkdirSync(d, { recursive: true });
  for (const f of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) fs.writeFileSync(path.join(d, f), f);
  assert.equal(models.isInstalled(m.id), true);
  assert.equal(models.resolve('auto'), null, 'a streaming model cannot produce final text, so "auto" ignores it');
  assert.equal(models.resolve(m.id), null);
  const draft = models.draftModel();
  assert.equal(draft.id, m.id);
  const cfg = onlineRecognizerConfig(draft, { threads: 2 });
  assert.equal(cfg.decodingMethod, 'greedy_search');
  assert.equal(cfg.enableEndpoint, false, 'the VAD decides where utterances end');
  assert.equal(cfg.modelConfig.numThreads, 2);
  assert.match(cfg.modelConfig.transducer.encoder, /encoder\.int8\.onnx$/);
});

// ---- the engine's gate: cores and memory ----
test('engine: drafts need 4 physical cores and memory for another ~1 GB model, and never more than 2 threads', () => {
  const model = { id: 'draft', files: {} };
  const need = draftMB(model) + MEMORY_RESERVE_MB;
  const gate = (o) => { const e = new AsrEngine({ cpus: 16, freeMemMB: () => 1e6, ...o }); e.live.opts = { threads: 8, effective: 4 }; return e.draftGate(model); };
  assert.equal(gate({}).ok, true);
  assert.equal(gate({}).threads, DRAFT_MAX_THREADS);
  assert.equal(gate({ cpus: 2 * DRAFT_MIN_CORES }).ok, true, 'exactly the minimum');
  const small = gate({ cpus: 2 * DRAFT_MIN_CORES - 2 });
  assert.equal(small.ok, false);
  assert.match(small.reason, /CPU cores/);
  assert.equal(gate({ freeMemMB: () => need - 1 }).ok, false);
  assert.match(gate({ freeMemMB: () => need - 1 }).reason, /memory/);
  assert.equal(gate({ freeMemMB: () => need }).ok, true);
  const e = new AsrEngine({ cpus: 16, freeMemMB: () => 1e6 });
  e.live.opts = { threads: 1, effective: 1 };
  assert.equal(e.draftGate(model).threads, 1, 'follows a live worker that runs on one thread');
  // already loaded: memory is already spent, so a dip in free memory does not switch it off mid-way
  const loaded = new AsrEngine({ cpus: 16, freeMemMB: () => 0 });
  loaded.live.draftOn = true; loaded.live.opts = { threads: 4 };
  assert.equal(loaded.draftGate(model).ok, true);
});

test('engine: setDraft without a running worker is a quiet no, and never throws', async () => {
  const e = new AsrEngine({ cpus: 16, freeMemMB: () => 1e6 });
  assert.deepEqual(await e.setDraft({ id: 'x', files: {} }), { enabled: false, reason: 'the speech engine is not running' });
  assert.deepEqual(await e.setDraft(null), { enabled: false, reason: 'the speech engine is not running' });
});

// ---- the recording manager, with a fake engine ----
class FakeEngine extends EventEmitter {
  constructor({ enable = true } = {}) { super(); this.enable = enable; this.drafts = []; }
  async start() {}
  async setDraft(model, o) { this.drafts.push(model ? { model: model.id, language: o?.language } : null); return model && this.enable ? { enabled: true } : { enabled: false, reason: model ? 'too small' : null }; }
  async setHotwords() {}
  async releaseHotwords() {}
  feed() {}
  async flush() {}
  reset() {}
}

function rig({ liveDraft = true, installed = true, enable = true } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  settings.update({ liveDraft });
  const engine = new FakeEngine({ enable });
  const models = { resolve: () => ({ id: 'm' }), vadInstalled: () => true, vadPath: () => '/vad.onnx', draftModel: () => (installed ? { id: 'draft-model' } : null) };
  const platform = { capture: { mic: 'renderer', system: 'renderer' }, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource() };
  const touched = [];
  const speakers = { // every way a segment could reach the voice code is recorded
    forNote: () => [], save: () => touched.push('save'), autoMatch: () => touched.push('autoMatch'), display: () => ({ shown: '', of: () => ({ label: 'Them', kind: 'them', n: null }) }), consolidate: () => {}, placeUnlabelled: () => 0, merge: () => {},
  };
  const events = [];
  bus.subscribe((e) => events.push(e));
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus, speakers });
  const partials = () => events.filter((e) => e.type === 'transcript.partial').map((e) => e.data);
  return { notes, engine, mgr, bus, settings, events, partials, touched };
}

test('manager: draft words are published as transcript.partial, replaced by the final segment, and never stored or clustered', async () => {
  const { notes, engine, mgr, events, partials, touched } = rig();
  const n = notes.create({});
  await mgr.start(n.id);
  await wait(5);
  assert.deepEqual(engine.drafts, [{ model: 'draft-model', language: 'auto' }]);
  assert.equal(mgr.status().draft.on, true);

  engine.emit('partial', { ch: 'system', text: 'good morning', startMs: 100 });
  engine.emit('partial', { ch: 'system', text: 'good morning everyone and welcome', startMs: 100 });
  assert.deepEqual(partials().map((p) => [p.ch, p.speaker, p.text, p.startMs]), [['system', 'them', 'good morning', 100], ['system', 'them', 'good morning everyone and welcome', 100]]);
  assert.equal(partials()[0].noteId, n.id);
  assert.equal(notes.segments(n.id).length, 0, 'drafts are not in the database');
  assert.deepEqual(touched, [], 'drafts never reach speaker clustering');
  assert.equal('speakerId' in partials()[0] || 'label' in partials()[0], false, 'a draft carries no speaker identity beyond the channel');

  engine.emit('segment', { ch: 'system', startMs: 100, endMs: 3000, text: 'Good morning, everyone, and welcome.', embedding: null, words: null });
  const after = events.slice(events.findIndex((e) => e.type === 'transcript.segment'));
  assert.deepEqual(after.map((e) => e.type), ['transcript.segment', 'transcript.partial'], 'the final line, then the draft is cleared');
  assert.equal(after[1].data.text, '');
  assert.equal(notes.segments(n.id).length, 1);
  assert.equal(notes.segments(n.id)[0].text, 'Good morning, everyone, and welcome.');

  engine.emit('partial', { ch: 'system', text: '', startMs: 100 }); // the worker's own clear arrives after: nothing more to say
  assert.equal(events.filter((e) => e.type === 'transcript.partial' && e.data.text === '').length, 1);
  await mgr.stop();
  assert.equal(engine.drafts.at(-1), null, 'the streaming model is released when the recording ends');
});

test('manager: an echo-dropped final still clears its draft, and a mic draft that repeats the system channel is never shown', async () => {
  const { notes, engine, mgr, partials } = rig();
  const n = notes.create({});
  await mgr.start(n.id);
  await wait(5);
  engine.emit('partial', { ch: 'system', text: 'the quarterly numbers look good this week', startMs: 100 });
  engine.emit('partial', { ch: 'mic', text: 'the quarterly numbers look good', startMs: 140 }); // the speakers' sound in the mic
  engine.emit('partial', { ch: 'mic', text: 'the quarterly numbers look good this week and', startMs: 140 });
  assert.deepEqual(partials().map((p) => p.ch), ['system'], 'no draft for the echo');
  engine.emit('partial', { ch: 'mic', text: 'ok sounds fine to me', startMs: 5000 }); // a genuine, different utterance
  assert.deepEqual(partials().map((p) => p.ch), ['system', 'mic']);
  assert.equal(partials()[1].speaker, 'me');
  engine.emit('segment', { ch: 'mic', startMs: 5000, endMs: 7000, text: 'Ok, sounds fine to me.', embedding: null, words: null });
  assert.equal(partials().at(-1).text, '');
  assert.equal(notes.segments(n.id).length, 1);
  await mgr.stop();
});

test('manager: the same mic text is shown when the system channel said nothing like it, and echoDedupe off shows every draft', async () => {
  const off = rig();
  off.settings.update({ echoDedupe: false });
  const n = off.notes.create({});
  await off.mgr.start(n.id);
  await wait(5);
  off.engine.emit('partial', { ch: 'system', text: 'the quarterly numbers look good this week', startMs: 100 });
  off.engine.emit('partial', { ch: 'mic', text: 'the quarterly numbers look good this week', startMs: 140 });
  assert.deepEqual(off.partials().map((p) => p.ch), ['system', 'mic']);
  await off.mgr.stop();
});

test('manager: with the setting off, or no streaming model, there are no drafts and the recording is unchanged', async () => {
  for (const cfg of [{ liveDraft: false }, { installed: false }]) {
    const { notes, engine, mgr, partials } = rig(cfg);
    const n = notes.create({});
    await mgr.start(n.id);
    await wait(5);
    assert.deepEqual(engine.drafts, [null], 'the engine is told there are no drafts');
    assert.equal(mgr.status().draft.on, false);
    assert.ok(mgr.status().draft.reason);
    engine.emit('partial', { ch: 'system', text: 'stray draft', startMs: 0 });
    assert.deepEqual(partials(), []);
    engine.emit('segment', { ch: 'system', startMs: 0, endMs: 1500, text: 'Hello there everyone.', embedding: null, words: null });
    assert.equal(notes.segments(n.id).length, 1, 'final captions work as before');
    await mgr.stop();
  }
});

test('manager: turning the setting off mid-recording stops new drafts; a machine that is too small reports why; a failing load never stops the recording', async () => {
  const a = rig();
  const n = a.notes.create({});
  await a.mgr.start(n.id);
  await wait(5);
  a.engine.emit('partial', { ch: 'system', text: 'one', startMs: 0 });
  a.settings.update({ liveDraft: false });
  a.engine.emit('partial', { ch: 'system', text: 'one two', startMs: 0 });
  assert.equal(a.partials().length, 1);
  await a.mgr.stop();

  const b = rig({ enable: false });
  await b.mgr.start(b.notes.create({}).id);
  await wait(5);
  assert.equal(b.mgr.status().draft.on, false);
  assert.equal(b.mgr.status().draft.reason, 'too small');
  b.engine.emit('partial', { ch: 'system', text: 'ignored', startMs: 0 });
  assert.equal(b.partials().length, 0);
  await b.mgr.stop();

  const c = rig();
  c.engine.setDraft = async () => { throw new Error('model file is corrupt'); };
  await c.mgr.start(c.notes.create({}).id);
  await wait(5);
  assert.equal(c.mgr.status().active, true);
  assert.ok(c.events.some((e) => e.type === 'recording.warning' && /corrupt/.test(e.data.message)));
  await c.mgr.stop();
});

test('manager: when the worker gives drafts up (cannot keep up), the recording says so and goes on with final captions only', async () => {
  const { notes, engine, mgr, events, partials } = rig();
  const n = notes.create({});
  await mgr.start(n.id);
  await wait(5);
  engine.emit('partial', { ch: 'system', text: 'one', startMs: 0 });
  engine.emit('draft-off', { reason: 'this computer cannot decode drafts in real time' });
  assert.ok(events.some((e) => e.type === 'recording.warning' && /cannot decode drafts/.test(e.data.message)));
  assert.equal(mgr.status().draft.on, false);
  engine.emit('partial', { ch: 'system', text: 'one two', startMs: 0 });
  assert.equal(partials().length, 1, 'no more drafts');
  engine.emit('segment', { ch: 'system', startMs: 0, endMs: 1500, text: 'One two three.', embedding: null, words: null });
  assert.equal(notes.segments(n.id).length, 1);
  assert.equal(partials().at(-1).text, '', 'the draft that was showing is cleared by the final line');
  await mgr.stop();
});

test('manager: pausing clears the draft on screen', async () => {
  const { notes, engine, mgr, partials } = rig();
  await mgr.start(notes.create({}).id);
  await wait(5);
  engine.emit('partial', { ch: 'system', text: 'half a sentence', startMs: 10 });
  await mgr.pause();
  engine.emit('partial', { ch: 'system', text: '', startMs: 10 }); // the worker's flush clears it
  assert.equal(partials().at(-1).text, '');
  engine.emit('partial', { ch: 'system', text: 'late draft', startMs: 20 });
  assert.equal(partials().length, 2, 'nothing is shown while paused');
  await mgr.stop();
});

// ---- real models ----
const models = testModels();
const draftModel = models?.draftModel();
const mainModel = models?.resolve('auto');
const skip = mainModel && draftModel ? false : 'needs a speech model and the streaming model (node scripts/fetch-models.js nemotron-3.5-streaming-320ms)';

const pcmOf = (name) => wavToPcm16(fs.readFileSync(fixture(name)));
const silence = (s) => Buffer.alloc(Math.round(16000 * 2 * s));
const chunks = (pcm, ms = 100) => { const size = 16 * 2 * ms; const out = []; for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, i + size)); return out; };
const bigEngine = (o = {}) => new AsrEngine({ cpus: 32, freeMemMB: () => 1e6, ...o });
const start = (engine, extra = {}) => engine.start(mainModel, { vadPath: models.vadPath(), threads: 4, ...extra });

async function stream(engine, ch, pcm) {
  for (const c of chunks(pcm)) engine.feed(ch, c);
  engine.feed(ch, silence(1.5));
  await engine.flush(ch);
}
function record(engine) {
  const log = [];
  engine.on('partial', (p) => log.push({ k: 'partial', ...p }));
  engine.on('segment', (s) => log.push({ k: 'segment', ...s }));
  return log;
}

test('live: draft words arrive before the final segment, which then replaces them, with no worker restart', { skip, timeout: 120000 }, async (t) => {
  const engine = bigEngine();
  t.after(() => engine.stop());
  await start(engine);
  const pid = engine.pools().live.pid;
  const r = await engine.setDraft(draftModel);
  assert.equal(r.enabled, true, r.reason);
  assert.equal(engine.pools().live.pid, pid, 'loading the streaming model does not restart the worker');
  assert.equal(engine.pools().draft, true);

  const log = record(engine);
  const pcm = Buffer.concat([pcmOf('speech-0.wav'), silence(1.3), pcmOf('hello.wav')]);
  await stream(engine, 'mic', pcm);
  const segs = log.filter((e) => e.k === 'segment');
  assert.ok(segs.length >= 2, `two utterances (${segs.length})`);
  for (const seg of segs) {
    const at = log.indexOf(seg);
    const before = log.slice(0, at).filter((e) => e.k === 'partial' && e.text && e.ch === 'mic' && e.startMs <= seg.endMs && e.startMs >= seg.startMs - 1500);
    assert.ok(before.length >= 1, `draft words came before the final text of "${seg.text.slice(0, 30)}…"`);
    assert.ok(before.every((p) => p.text.trim().length > 0));
    const clear = log.slice(at + 1).find((e) => e.k === 'partial' && e.ch === 'mic');
    assert.ok(clear && clear.text === '', 'the draft is cleared right after the final segment');
  }
  assert.equal(engine.pools().live.pid, pid);

  // drafts do not change the final text: the same audio without them gives the same segments
  const plain = bigEngine();
  t.after(() => plain.stop());
  await start(plain);
  const plainLog = record(plain);
  await stream(plain, 'mic', pcm);
  const expect = plainLog.filter((e) => e.k === 'segment');
  assert.equal(plainLog.some((e) => e.k === 'partial'), false, 'no drafts unless asked for');
  assert.deepEqual(segs.map((s) => [s.startMs, s.endMs, s.text]), expect.map((s) => [s.startMs, s.endMs, s.text]));

  // switching drafts off stops them, again without a restart
  assert.deepEqual(await engine.setDraft(null), { enabled: false, reason: null });
  assert.equal(engine.pools().draft, false);
  log.length = 0;
  await stream(engine, 'mic', pcmOf('hello.wav'));
  assert.ok(log.some((e) => e.k === 'segment'));
  assert.equal(log.some((e) => e.k === 'partial'), false, 'no drafts after switching them off');
  assert.equal(engine.pools().live.pid, pid);
});

test('live: each channel has its own draft, and imports never get one', { skip, timeout: 120000 }, async (t) => {
  const engine = bigEngine();
  t.after(() => engine.stop());
  await start(engine);
  assert.equal((await engine.setDraft(draftModel)).enabled, true);
  const log = record(engine);
  await Promise.all([stream(engine, 'mic', Buffer.concat([silence(0.5), pcmOf('speech-0.wav')])), stream(engine, 'system', Buffer.concat([silence(1), pcmOf('speech-0.wav')]))]);
  for (const ch of ['mic', 'system']) {
    assert.ok(log.some((e) => e.k === 'partial' && e.ch === ch && e.text), `a draft on ${ch}`);
    assert.ok(log.some((e) => e.k === 'segment' && e.ch === ch), `a final segment on ${ch}`);
  }
  log.length = 0;
  const segs = await transcribePcm(engine, Buffer.concat([pcmOf('hello.wav'), silence(1.5)]));
  assert.ok(segs.length >= 1, 'the file is transcribed as before');
  assert.equal(log.some((e) => e.k === 'partial'), false, 'a file import is not drafted');
  assert.match(await engine.transcribe(pcmOf('hello.wav')), /love/i, 'dictation (one-shot transcribe) is untouched');
  assert.equal(log.some((e) => e.k === 'partial'), false, 'dictation is not drafted');
});

test('live: a small computer gets no drafts, with the reason, and its captions are unchanged', { skip, timeout: 120000 }, async (t) => {
  const engine = new AsrEngine({ cpus: 4, freeMemMB: () => 1e6 }); // two physical cores
  t.after(() => engine.stop());
  await start(engine);
  const r = await engine.setDraft(draftModel);
  assert.equal(r.enabled, false);
  assert.match(r.reason, /CPU cores/);
  const log = record(engine);
  await stream(engine, 'mic', pcmOf('hello.wav'));
  assert.ok(log.some((e) => e.k === 'segment'));
  assert.equal(log.some((e) => e.k === 'partial'), false);

  const tight = new AsrEngine({ cpus: 32, freeMemMB: () => 100 });
  t.after(() => tight.stop());
  await start(tight);
  assert.match((await tight.setDraft(draftModel)).reason, /memory/);
});

test('live: noise the VAD rejects leaves no draft behind', { skip, timeout: 120000 }, async (t) => {
  const engine = bigEngine();
  t.after(() => engine.stop());
  await start(engine);
  assert.equal((await engine.setDraft(draftModel)).enabled, true);
  const log = record(engine);
  const blip = Buffer.alloc(16000 * 2 * 0.15); // 150 ms click: shorter than the VAD's minimum speech
  for (let i = 0; i < blip.length; i += 2) blip.writeInt16LE(Math.round(Math.sin(i / 7) * 12000), i);
  await stream(engine, 'mic', Buffer.concat([silence(1), blip, silence(1)]));
  const shown = log.filter((e) => e.k === 'partial' && e.text).length;
  const cleared = log.filter((e) => e.k === 'partial' && !e.text).length;
  assert.ok(cleared >= shown && (shown === 0 || log.at(-1).text === ''), 'whatever was shown is cleared');
});

test('recording: with real models, draft words are published before the final line and only the final line is saved', { skip, timeout: 120000 }, async (t) => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const engine = bigEngine();
  t.after(() => engine.stop());
  const platform = { capture: { mic: 'renderer', system: 'renderer' }, createMicSource: () => new PushSource(), createSystemSource: async () => new PushSource() };
  const mgr = new RecordingManager({ notes, engine, models, settings, platform, bus });
  const events = [];
  bus.subscribe((e) => { if (e.type.startsWith('transcript.')) events.push(e); });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false, system: true });
  const pid = engine.pools().live.pid;
  const pcm = Buffer.concat([pcmOf('speech-0.wav'), silence(1.5)]);
  for (const c of chunks(pcm)) { mgr.pushPcm(n.id, 'system', c); await wait(2); }
  await until(() => events.some((e) => e.type === 'transcript.segment'), 30000, 'the final segment');
  await mgr.stop();

  const types = events.map((e) => e.type + (e.type === 'transcript.partial' && !e.data.text ? ':clear' : ''));
  const firstFinal = types.indexOf('transcript.segment');
  assert.ok(types.indexOf('transcript.partial') >= 0 && types.indexOf('transcript.partial') < firstFinal, 'a draft was published before the final line');
  const saved = notes.segments(n.id);
  assert.equal(saved.length, events.filter((e) => e.type === 'transcript.segment').length, 'only final lines are saved');
  const drafted = events.filter((e) => e.type === 'transcript.partial' && e.data.text).map((e) => e.data.text);
  assert.ok(drafted.length >= 1);
  assert.equal(saved.some((s) => drafted.includes(s.text) && !events.some((e) => e.type === 'transcript.segment' && e.data.segment.text === s.text)), false);
  assert.equal(events.filter((e) => e.type === 'transcript.partial').at(-1).data.text, '', 'the screen ends with no draft left');
  assert.equal(engine.pools().live.pid, pid, 'one worker for the whole recording');
  assert.equal(engine.pools().draft, false, 'the streaming model is released after the recording');
});
