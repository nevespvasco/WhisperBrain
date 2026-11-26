'use strict';
// The voice models WhisperBrain knows. A voice print only means something next to prints of the SAME model (different
// dimensions, different geometry), so every stored print is tagged with the model that made it, and each model brings
// what is specific to it: the average voice prints are centred on, and how sure a match has to be.
//   match.threshold  centred similarity from which a speaker is linked to a saved voice by itself
//   match.margin     how far ahead of the second-best voice it has to be
//   match.ask        from here up to the threshold the speaker is only suggested ("Ana?"), for the user to confirm
// Values for 3D-Speaker CAM++ come from eval/bakeoff-results.md (calibrated band: P >= 0.95 links, P >= 0.6 asks);
// the ResNet34 ones are the ones tuned on 2026-11-24 (eval/README.md, "Saved voices").
const path = require('node:path');
const { VOICE_MEAN, MATCH } = require('./cluster');

const toF32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const RESNET34 = {
  id: 'wespeaker-resnet34-lm', name: 'WeSpeaker ResNet34', file: 'wespeaker_en_voxceleb_resnet34_LM.onnx', dim: 256,
  mean: VOICE_MEAN, match: { threshold: MATCH.threshold, margin: MATCH.margin, ask: MATCH.ask },
};
const CAMPPLUS = {
  id: '3dspeaker-campplus-en', name: '3D-Speaker CAM++', file: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx', dim: 512,
  // mean of the unit-length prints of 291 recordings of 40 LibriSpeech readers, `node eval/voices.js mean --model <file>`
  mean: toF32('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'),
  match: { threshold: 0.63, margin: 0, ask: 0.44 },
};
const MODELS = [CAMPPLUS, RESNET34];   // the first is the one new installs use
const LEGACY = RESNET34;                // what every print made before models were tagged came from

const byId = (id) => MODELS.find((m) => m.id === id) || null;
const byFile = (file) => MODELS.find((m) => m.file === path.basename(String(file || ''))) || null;

module.exports = { MODELS, CAMPPLUS, RESNET34, LEGACY, byId, byFile };
