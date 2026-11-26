'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ahc, linkage, cut } = require('../src/speakers/owned/ahc');
const { DiarizationState, windowStarts, speakerRanges, runs, smooth } = require('../src/speakers/owned/pipeline');
const { toMultilabel, FRAMES, FRAME_STEP, FRAME_SPAN, WINDOW, LOCAL, RATE } = require('../src/speakers/owned/segmentation');

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const unit = (v) => { const n = Math.hypot(...v); return Float64Array.from(v, (x) => x / n); };
function blob(center, n, noise, r) { return Array.from({ length: n }, () => unit(center.map((c) => c + (r() - 0.5) * noise))); }

test('toMultilabel decodes the powerset classes', () => {
  const logits = new Float32Array(4 * 7).fill(-10);
  [0, 1, 4, 6].forEach((cls, f) => { logits[f * 7 + cls] = 0; }); // nobody, spk 0, spk 0+1, spk 1+2
  assert.deepEqual([...toMultilabel(logits, 4)], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
});

test('centroid linkage merges the closest pair first and cut() labels the rows', () => {
  const X = [[1, 0], [0.99, 0.14], [0, 1], [0.1, 0.99]].map(unit);
  const m = linkage(X);
  assert.equal(m.length, 3);
  assert.ok(m[0].height < m[2].height);
  assert.deepEqual([...cut(4, m, 2)], [0, 0, 1, 1]);
  assert.deepEqual([...cut(4, m, 3)], [0, 0, 0, 0]);
});

test('ahc finds well-separated voices and hands small clusters to the nearest large one', () => {
  const r = rng(3);
  const A = blob([1, 0, 0, 0], 30, 0.3, r), B = blob([0, 1, 0, 0], 30, 0.3, r);
  const stray = [unit([0.9, 0.1, 0.45, 0])]; // a lone point nearer A
  const res = ahc([...A, ...B, ...stray], { threshold: 0.7, minClusterSize: 12 });
  assert.equal(res.centroids.length, 2);
  const la = res.labels[0], lb = res.labels[30];
  assert.notEqual(la, lb);
  assert.ok(res.labels.slice(0, 30).every((l) => l === la));
  assert.ok(res.labels.slice(30, 60).every((l) => l === lb));
  assert.equal(res.labels[60], la);
});

test('ahc can be forced to a number of speakers', () => {
  const r = rng(5);
  const pts = [...blob([1, 0, 0], 20, 0.2, r), ...blob([0.8, 0.6, 0], 20, 0.2, r), ...blob([0, 0, 1], 20, 0.2, r)];
  assert.equal(ahc(pts, { threshold: 1.5, minClusterSize: 5 }).centroids.length, 1);
  assert.equal(ahc(pts, { threshold: 1.5, minClusterSize: 5, numSpeakers: 3 }).centroids.length, 3);
});

test('windowStarts covers the whole recording with one padded window at the end', () => {
  assert.deepEqual(windowStarts(5 * RATE), [0]);
  assert.deepEqual(windowStarts(WINDOW), [0]);
  assert.deepEqual(windowStarts(WINDOW + RATE / 2), [0, RATE]);
  assert.deepEqual(windowStarts(12 * RATE), [0, RATE, 2 * RATE]);
});

test('speakerRanges prefers solo frames and falls back to all frames', () => {
  const seg = new Uint8Array(FRAMES * LOCAL);
  for (let f = 0; f < 100; f++) seg[f * LOCAL] = 1;              // speaker 0 alone for 100 frames
  for (let f = 100; f < 120; f++) { seg[f * LOCAL] = 1; seg[f * LOCAL + 1] = 1; } // 0+1 together
  const r0 = speakerRanges(seg, 0, WINDOW);
  assert.ok(r0.length === 1 && r0[0][1] <= 100 * FRAME_STEP + FRAME_SPAN);
  const r1 = speakerRanges(seg, 1, WINDOW, { minEmbedSamples: 1000 }); // no solo frames: its overlapped frames
  assert.equal(r1.length, 1);
  assert.deepEqual(speakerRanges(seg, 2, WINDOW), []);
});

test('runs and smooth make tidy turns', () => {
  assert.deepEqual(runs(Uint8Array.from([0, 1, 1, 0, 1])), [[1, 2], [4, 4]]);
  const t = smooth([{ start: 0, end: 1, speaker: 0 }, { start: 1.3, end: 2, speaker: 0 }, { start: 5, end: 5.1, speaker: 0 }], { minDurationOn: 0.2, minDurationOff: 0.5 });
  assert.deepEqual(t, [{ start: 0, end: 2, speaker: 0 }]);
});

// A scripted "recording": who speaks when is written into the samples (speaker id + 1 as the value, 0 = silence,
// two speakers at once = 10*a + b). The fake segmenter reads it back per frame with consistent local labels per window
// (local order = order of first appearance), the fake voice model gives one direction per speaker.
function scripted(turns, seconds) {
  const audio = new Float32Array(seconds * RATE);
  for (let i = 0; i < audio.length; i++) {
    const t = i / RATE;
    const on = turns.filter((x) => t >= x.start && t < x.end).map((x) => x.speaker + 1).sort();
    audio[i] = on.length === 0 ? 0 : on.length === 1 ? on[0] : 10 * on[0] + on[1];
  }
  const who = (v) => (v === 0 ? [] : v < 10 ? [v - 1] : [Math.floor(v / 10) - 1, (v % 10) - 1]);
  const segment = async (windows) => windows.map((w) => {
    const order = [];
    const seg = new Uint8Array(FRAMES * LOCAL);
    for (let f = 0; f < FRAMES; f++) {
      const mid = Math.min(WINDOW - 1, f * FRAME_STEP + (FRAME_SPAN >> 1));
      for (const s of who(w[mid])) { if (!order.includes(s)) order.push(s); const k = order.indexOf(s); if (k < LOCAL) seg[f * LOCAL + k] = 1; }
    }
    return seg;
  });
  const embed = (x) => { const v = new Float32Array(4); for (const s of x) for (const p of who(s)) v[p]++; return v.some(Boolean) ? v : null; };
  return { audio, segment, embed, read: (a, b) => audio.subarray(a, Math.min(b, audio.length)) };
}

test('the pipeline rebuilds who spoke when, overlap included, and an exclusive version', async () => {
  const truth = [{ start: 1, end: 9, speaker: 0 }, { start: 8, end: 16, speaker: 1 }, { start: 17, end: 24, speaker: 0 }, { start: 25, end: 33, speaker: 2 }];
  const sc = scripted(truth, 35);
  const st = new DiarizationState({ minClusterSize: 2 });
  await st.add(st.pending(sc.audio.length, true), sc);
  const r = st.diarize(sc.audio.length);
  const speakers = [...new Set(r.turns.map((t) => t.speaker))];
  assert.equal(speakers.length, 3);
  const at = (turns, t) => turns.filter((x) => t >= x.start && t < x.end).map((x) => x.speaker);
  const A = at(r.turns, 4)[0], B = at(r.turns, 12)[0], C = at(r.turns, 30)[0];
  assert.equal(new Set([A, B, C]).size, 3);
  assert.deepEqual(at(r.turns, 20), [A]);                      // the same voice after a break
  assert.deepEqual(at(r.turns, 8.5).sort(), [A, B].sort());     // both at once
  assert.equal(at(r.exclusive, 8.5).length, 1);                 // exclusive: one of them
  assert.equal(r.overlaps.length, 1);
  assert.ok(Math.abs(r.overlaps[0][0] - 8) < 0.1 && Math.abs(r.overlaps[0][1] - 9) < 0.1, JSON.stringify(r.overlaps));
});

test('windows computed while recording give the same answer as all at once', async () => {
  const truth = [{ start: 0.5, end: 7, speaker: 0 }, { start: 7.2, end: 14, speaker: 1 }, { start: 14.5, end: 22, speaker: 0 }];
  const sc = scripted(truth, 23);
  const once = new DiarizationState({ minClusterSize: 2 });
  await once.add(once.pending(sc.audio.length, true), sc);
  const live = new DiarizationState({ minClusterSize: 2 });
  for (let have = 4 * RATE; have < sc.audio.length; have += 3 * RATE) await live.add(live.pending(have), sc); // as audio arrives
  await live.add(live.pending(sc.audio.length, true), sc);                                                 // at Stop
  assert.deepEqual(live.windows.map((w) => w.start), once.windows.map((w) => w.start));
  assert.deepEqual(live.diarize(sc.audio.length).turns, once.diarize(sc.audio.length).turns);
});

// ---- with the real models: the recording manager follows the spool live and diarizes at Stop ----
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testModels, fixture } = require('./helpers');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { RecordingManager } = require('../src/recording/manager');
const { AsrEngine } = require('../src/asr/engine');
const { wavToPcm16 } = require('../src/audio/pcm');

const models = testModels();
const realSkip = models && models.speakerInstalled() && models.segmentationInstalled() && models.isInstalled('parakeet-tdt-0.6b-v3') ? false : 'needs the speaker, segmentation and parakeet-tdt-0.6b-v3 models';
test('real voices, owned pipeline: windows computed while recording, two people told apart at Stop', { skip: realSkip, timeout: 240000 }, async (t) => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), settings = new Settings(db, bus), speakers = new Speakers(db, bus);
  settings.update({ speakerPipeline: 'owned', speakerDiarize: true, speakerRefine: false });
  const engine = new AsrEngine();
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-owned-'));
  t.after(() => { engine.stop(); fs.rmSync(spoolDir, { recursive: true, force: true }); });
  const mgr = new RecordingManager({ notes, engine, models, settings, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  const wav = (p) => wavToPcm16(fs.readFileSync(p));
  const sample = (f) => path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', f);
  const silence = Buffer.alloc(32000);
  for (const pcm of [wav(sample('en.wav')), silence, wav(fixture('speech-0.wav')), silence, wav(sample('en.wav')), silence]) {
    for (let i = 0; i < pcm.length; i += 3200) mgr.pushPcm(n.id, 'system', pcm.subarray(i, i + 3200));
  }
  const live = mgr.active.live?.system;
  assert.ok(live, 'the live diarizer follows the system spool');
  for (let k = 0; k < 120 && live.progress.windows === 0; k++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(live.progress.windows > 0, 'it computed windows before Stop');
  await mgr.stop();
  const segs = notes.segments(n.id);
  const ids = segs.map((s) => s.speakerId);
  assert.ok(new Set(ids).size >= 2, `expected two voices, got ${JSON.stringify(segs.map((s) => [s.speakerId, s.text.slice(0, 20)]))}`);
  assert.equal(ids[0], ids[ids.length - 1], 'the first speaker is recognised when they speak again');
  assert.ok(speakers.forNote(n.id).some((s) => s.quality && s.quality.seconds > 0), 'speakers carry the quality of their voice print');
});
