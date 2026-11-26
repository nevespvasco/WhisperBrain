'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Speakers } = require('../src/speakers/store');
const { CAMPPLUS, RESNET34, LEGACY, byId, byFile, sameVoiceThreshold } = require('../src/speakers/voice-models');
const { cosine } = require('../src/speakers/cluster');
const { Models } = require('../src/asr/models');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');

function dirvec(seed, dim) { const v = new Float32Array(dim); let x = seed * 9301 + 49297; for (let i = 0; i < dim; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; } return v; }
const unit = (v) => { const n = Math.hypot(...v); return Float32Array.from(v, (x) => x / n); };
function near(base, other, c) { const b = unit(base), o0 = unit(other); const d = o0.reduce((a, x, i) => a + x * b[i], 0); const o = unit(Float32Array.from(o0, (x, i) => x - d * b[i])); return Float32Array.from(b, (x, i) => c * x + Math.sqrt(1 - c * c) * o[i]); }

test('registry: both models know their size, average voice and thresholds', () => {
  assert.equal(CAMPPLUS.mean.length, CAMPPLUS.dim);
  assert.equal(RESNET34.mean.length, RESNET34.dim);
  assert.equal(LEGACY, RESNET34);
  assert.equal(byId('3dspeaker-campplus-en'), CAMPPLUS);
  assert.equal(byFile('/x/models/speaker/wespeaker_en_voxceleb_resnet34_LM.onnx'), RESNET34);
  assert.equal(byFile('whatever.onnx'), null);
  assert.ok(CAMPPLUS.match.ask < CAMPPLUS.match.threshold);
});

test('prints of different models are never alike (no NaN, no merge)', () => {
  assert.equal(cosine(new Float32Array(256).fill(1), new Float32Array(512).fill(1)), -1);
});

// a store that moved from ResNet34 (256 d, default) to CAM++ (512 d)
function stores() {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), sp = new Speakers(db, bus);
  sp.adapt = false;
  const meeting = (centroid, { alt = null, model } = {}) => {
    const n = notes.create({});
    notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 30000, text: 'hello there' }]);
    sp.save(n.id, { speakerId: 's1', channel: 'system', centroid, count: 5, altCentroid: alt, altModel: alt ? LEGACY.id : null });
    db.prepare('UPDATE note_speakers SET quality = ? WHERE note_id = ?').run(JSON.stringify({ seconds: 30, clipped: 0, snrDb: 30 }), n.id);
    return n.id;
  };
  return { db, sp, notes, meeting };
}
const ANA_OLD = dirvec(1, 256), ANA_NEW = dirvec(1, 512), BRUNO_OLD = dirvec(5, 256), BRUNO_NEW = dirvec(5, 512);
const ZERO_OLD = new Float32Array(256), ZERO_NEW = new Float32Array(512); // no centring: scores are plain cosines

test('a voice saved with the old model is recognised through the second print, then gains a print of the new model', () => {
  const { db, sp, meeting } = stores();
  // saved in the days of ResNet34 (the default model of a store that was never told otherwise)
  sp.mean = ZERO_OLD;
  sp.rename(meeting(ANA_OLD), 's1', 'Ana', { remember: true, consentSource: 'user' });
  assert.deepEqual(db.prepare('SELECT DISTINCT model FROM voice_exemplars').all().map((r) => r.model), [LEGACY.id]);
  assert.equal(sp.hasPrintsOf(LEGACY.id), true);

  // the app moves to CAM++
  sp.useModel({ ...CAMPPLUS, mean: ZERO_NEW });
  assert.equal(sp.modelId, CAMPPLUS.id);
  sp.mean = ZERO_NEW;
  const ana2 = meeting(near(ANA_NEW, BRUNO_NEW, 0.97), { alt: near(ANA_OLD, BRUNO_OLD, 0.95) });
  // the old model's mean is centred away too in this synthetic setting: use no centring for it
  sp.autoMatch(ana2);
  let s = sp.forNote(ana2)[0];
  assert.ok(s.voiceId, 'recognised through the print made by the old model');
  assert.equal(s.model, CAMPPLUS.id);
  assert.equal(s.altModel, LEGACY.id);

  // without the second print there is nothing comparable: the speaker stays unlinked and nothing breaks
  const noAlt = meeting(near(ANA_NEW, BRUNO_NEW, 0.97));
  sp.autoMatch(noAlt);
  assert.equal(sp.forNote(noAlt)[0].voiceId, null);

  // confirming the match remembers the voice again: the profile gains prints of both models
  sp.rename(ana2, 's1', 'Ana', { remember: true, consentSource: 'user' });
  const models = db.prepare('SELECT model, COUNT(*) n FROM voice_exemplars WHERE negative = 0 GROUP BY model ORDER BY model').all();
  assert.deepEqual(models.map((m) => m.model).sort(), [CAMPPLUS.id, LEGACY.id].sort());
  assert.equal(sp.voices().length, 1);

  // now the new model alone recognises her
  const ana3 = meeting(near(ANA_NEW, BRUNO_NEW, 0.97));
  sp.autoMatch(ana3);
  assert.ok(sp.forNote(ana3)[0].voiceId, 'recognised by the new model on its own');
});

test('a stranger is not linked through either model, and a print of another model never mixes into a profile mean', () => {
  const { sp, meeting, db } = stores();
  sp.mean = ZERO_OLD;
  sp.rename(meeting(ANA_OLD), 's1', 'Ana', { remember: true, consentSource: 'user' });
  sp.useModel({ ...CAMPPLUS, mean: ZERO_NEW });
  sp.mean = ZERO_NEW;
  const bruno = meeting(BRUNO_NEW, { alt: BRUNO_OLD });
  sp.autoMatch(bruno);
  const s = sp.forNote(bruno)[0];
  assert.equal(s.voiceId, null);
  sp.rename(bruno, 's1', 'Ana', { remember: true, consentSource: 'user' }); // (renaming to an existing name reinforces that profile)
  const v = db.prepare('SELECT embedding, model FROM voices').get();
  assert.equal(v.model, CAMPPLUS.id);
  assert.equal(new Float32Array(new Uint8Array(v.embedding).slice().buffer).length, 512, 'the mean is of one model only');
});

test('models: the current voice model is preferred; the old one keeps working until it is downloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-models-'));
  try {
    const m = new Models(dir);
    fs.mkdirSync(path.join(dir, 'speaker'), { recursive: true });
    assert.equal(m.speakerInstalled(), false);
    fs.writeFileSync(m.legacySpeakerPath(), 'x');
    assert.equal(m.speakerInstalled(), true, 'only the old model: speaker features still work');
    assert.equal(m.speakerUpToDate(), false);
    assert.equal(m.speakerPath(), m.legacySpeakerPath());
    fs.writeFileSync(m.currentSpeakerPath(), 'y');
    assert.equal(m.speakerUpToDate(), true);
    assert.equal(m.speakerPath(), m.currentSpeakerPath());
    assert.equal(byFile(m.speakerPath()), CAMPPLUS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the API shape of a speaker never carries a voice print (neither the main one nor the second)', () => {
  const { sp, meeting } = stores();
  const id = meeting(ANA_NEW, { alt: ANA_OLD });
  const pub = sp.publicForNote(id)[0];
  assert.equal(pub.centroid, undefined);
  assert.equal(pub.altCentroid, undefined);
  assert.ok(JSON.stringify(pub).length < 2000, 'nothing vector-sized in it');
});

// ---- downloading the current voice model (against a local server: the checksum is verified, nothing is left behind on a mismatch) ----
const http = require('node:http');
const crypto = require('node:crypto');

async function withServer(body, fn) {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }); res.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { await new Promise((r) => srv.close(r)); }
}

test('models: the current voice model is downloaded, verified against its SHA-256 and installed; the old one is left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dl-'));
  const body = crypto.randomBytes(4096);
  const events = [];
  try {
    await withServer(body, async (base) => {
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      const bus = { publish: (type, data) => events.push([type, data.id]) };
      const m = new Models(dir, { bus, speaker: { id: 'speaker-voice', name: 'test', url: `${base}/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`, sizeMB: 1, sha256: sha } });
      fs.mkdirSync(path.join(dir, 'speaker'), { recursive: true });
      fs.writeFileSync(m.legacySpeakerPath(), 'old model');
      assert.equal(m.speakerUpToDate(), false);
      await m.installSpeakerModels().catch(() => {}); // the segmentation download is not served here; the voice model is what is checked
      assert.equal(m.speakerUpToDate(), true);
      assert.deepEqual(fs.readFileSync(m.currentSpeakerPath()), body);
      assert.equal(fs.readFileSync(m.legacySpeakerPath(), 'utf8'), 'old model', 'the old model stays where it is');
      assert.ok(events.some(([t, id]) => t === 'model.installed' && id === 'speaker-voice'));
      assert.deepEqual(fs.readdirSync(path.join(dir, 'speaker')).filter((f) => f.endsWith('.part')), [], 'no partial file left');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('models: a download whose SHA-256 does not match is refused and removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dl-'));
  try {
    await withServer(crypto.randomBytes(2048), async (base) => {
      const m = new Models(dir, { speaker: { id: 'speaker-voice', name: 'test', url: `${base}/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`, sizeMB: 1, sha256: '0'.repeat(64) } });
      await assert.rejects(() => m.installSpeaker(), /checksum mismatch/);
      assert.equal(fs.existsSync(m.currentSpeakerPath()), false);
      assert.equal(fs.existsSync(m.currentSpeakerPath() + '.part'), false);
      assert.equal(m.speakerInstalled(), false);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('same-voice threshold: each voice model has its own unless the user set one (CAM++ at 0.6 split a 3-person call into 18)', () => {
  const { DEFAULTS, validateSetting } = require('../src/core/settings');
  assert.equal(DEFAULTS.speakerThreshold, null);
  assert.equal(DEFAULTS.speakerPipeline, 'owned');
  assert.equal(sameVoiceThreshold(null, `/x/${CAMPPLUS.file}`), 0.5);
  assert.equal(sameVoiceThreshold(null, `/x/${RESNET34.file}`), 0.6);
  assert.equal(sameVoiceThreshold(null, null), LEGACY.same);   // no voice model installed
  assert.equal(sameVoiceThreshold(0.7, `/x/${CAMPPLUS.file}`), 0.7); // the user's choice wins
  assert.equal(validateSetting('speakerThreshold', null), null);
  assert.equal(validateSetting('speakerThreshold', 2), 0.95);
  assert.throws(() => validateSetting('speakerThreshold', 'high'), /number, or null/);
});

test('live diarizer: a worker that cannot start says why, at once and at Stop (not "not following a recording")', async () => {
  const { LiveDiarizer } = require('../src/speakers/owned');
  const warnings = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-live-'));
  const file = path.join(dir, 'system.pcm');
  fs.writeFileSync(file, Buffer.alloc(32000));
  const d = new LiveDiarizer({ file, segmentation: path.join(dir, 'missing-seg.onnx'), embedding: path.join(dir, 'missing-voice.onnx'), onWarning: (m) => warnings.push(m), pollMs: 50 });
  try {
    await assert.rejects(d.finish({ samples: 16000, timeoutMs: 30000 }), (e) => !/not following a recording/.test(e.message));
  } finally { d.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
