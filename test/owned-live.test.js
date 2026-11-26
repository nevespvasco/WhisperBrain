'use strict';
// With the real models: what the recording manager does with the owned diarization pipeline while recording and after Stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testModels, fixture } = require('./helpers');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { CAMPPLUS, RESNET34, LEGACY } = require('../src/speakers/voice-models');
const { toBlob } = require('../src/speakers/cluster');
const { RecordingManager } = require('../src/recording/manager');
const { AsrEngine } = require('../src/asr/engine');
const { wavToPcm16 } = require('../src/audio/pcm');

const models = testModels();
const ROOT = path.join(__dirname, '..');
const CAMPP_FILE = path.join(ROOT, '.models', 'candidates', CAMPPLUS.file);
const skip = models && models.speakerInstalled() && models.segmentationInstalled() && models.isInstalled('parakeet-tdt-0.6b-v3') ? false : 'needs the speaker, segmentation and parakeet-tdt-0.6b-v3 models';
const skipDual = skip || (fs.existsSync(CAMPP_FILE) ? false : 'needs the CAM++ model in .models/candidates');

const wav = (p) => wavToPcm16(fs.readFileSync(p));
const sample = (f) => path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', f);
const silence = (s) => Buffer.alloc(Math.round(s * 32000));
// the sum of two 16-bit signals (clipped): both people talking at once
function mix(a, b, delay = 0) {
  const out = Buffer.alloc(Math.max(a.length, b.length + delay * 2));
  for (let i = 0; i < out.length; i += 2) {
    const x = i < a.length ? a.readInt16LE(i) : 0, j = i - delay * 2, y = j >= 0 && j < b.length ? b.readInt16LE(j) : 0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, x + y)), i);
  }
  return out;
}
const feed = (mgr, id, pcm) => { for (let i = 0; i < pcm.length; i += 3200) mgr.pushPcm(id, 'system', pcm.subarray(i, i + 3200)); };

function rig(t, { settings = {}, modelsOverride = models, voiceModel = null } = {}) {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), st = new Settings(db, bus), speakers = new Speakers(db, bus);
  if (voiceModel) speakers.useModel(voiceModel);
  st.update({ speakerPipeline: 'owned', speakerDiarize: true, speakerRefine: false, ...settings });
  const engine = new AsrEngine();
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-live-'));
  t.after(() => { engine.stop(); fs.rmSync(spoolDir, { recursive: true, force: true }); });
  const mgr = new RecordingManager({ notes, engine, models: modelsOverride, settings: st, platform: { capture: { mic: 'renderer', system: 'renderer' } }, bus, speakers, spoolDir });
  return { db, bus, notes, speakers, mgr };
}

test('owned pipeline: two people talking at once are reported while recording (recording.overlap)', { skip, timeout: 240000 }, async (t) => {
  const { bus, notes, mgr } = rig(t);
  const events = [];
  bus.subscribe((e) => { if (e.type === 'recording.overlap') events.push(e.data); });
  const n = notes.create({});
  await mgr.start(n.id, { mic: false });
  const a = wav(sample('en.wav')), b = wav(fixture('speech-0.wav'));
  // one voice alone, then both at once for 7 s, then a pause: more than one 10 s window of audio
  feed(mgr, n.id, Buffer.concat([silence(0.5), a, silence(0.5), mix(b, a, 1.0), silence(1.5), a, silence(2)]));
  const live = mgr.active.live?.system;
  assert.ok(live, 'the live diarizer follows the system spool');
  for (let k = 0; k < 160 && !events.length; k++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(events.length > 0, 'an overlap was reported before Stop');
  const e = events[0];
  assert.equal(e.channel, 'system');
  assert.equal(e.noteId, n.id);
  assert.ok(e.endMs > e.startMs && e.startMs >= 0, JSON.stringify(e));
  await mgr.stop();
});

for (const pipeline of ['owned', 'sherpa']) {
  test(`dual prints (${pipeline} pipeline): with a voice saved by the old model, each speaker also gets a print by it, and a CAM++ one`, { skip: skipDual, timeout: 300000 }, async (t) => {
    // the app has moved to CAM++, the old ResNet34 file is still installed and a voice was saved with it
    const dual = Object.create(models);
    dual.speakerPath = () => CAMPP_FILE;
    dual.speakerInstalled = () => true;
    dual.speakerUpToDate = () => true;
    dual.currentSpeakerPath = () => CAMPP_FILE;
    dual.legacySpeakerPath = () => models.speakerPath();
    dual.legacySpeakerInstalled = () => true;
    const { db, notes, speakers, mgr } = rig(t, { settings: { speakerPipeline: pipeline }, modelsOverride: dual, voiceModel: CAMPPLUS });
    const emb = new Float32Array(256).fill(0.0625);
    db.prepare('INSERT INTO voices(id, name, embedding, samples, created_at, updated_at, consent_at, consent_source, model) VALUES(?, ?, ?, 1, 1, 1, 1, ?, ?)').run('v-old', 'Old Ana', toBlob(emb), 'user', LEGACY.id);
    db.prepare('INSERT INTO voice_exemplars(voice_id, embedding, weight, channel, negative, created_at, model) VALUES(?, ?, 10, ?, 0, 1, ?)').run('v-old', toBlob(emb), 'system', LEGACY.id);
    assert.equal(speakers.hasPrintsOf(LEGACY.id), true);
    assert.deepEqual(mgr.altVoiceModel(), { path: models.speakerPath(), id: LEGACY.id });

    const n = notes.create({});
    await mgr.start(n.id, { mic: false });
    for (const pcm of [wav(sample('en.wav')), silence(1), wav(fixture('speech-0.wav')), silence(1), wav(sample('en.wav')), silence(2)]) feed(mgr, n.id, pcm);
    await mgr.stop();
    const sp = speakers.forNote(n.id).filter((s) => s.centroid);
    assert.ok(sp.length >= 2, `two voices: ${JSON.stringify(sp.map((s) => s.speakerId))}`);
    for (const s of sp) {
      assert.equal(s.model, CAMPPLUS.id);
      assert.equal(s.centroid.length, CAMPPLUS.dim, 'the main print is by CAM++');
      assert.equal(s.altModel, LEGACY.id);
      assert.equal(s.altCentroid.length, RESNET34.dim, 'the second print is by the old model');
    }
  });
}
