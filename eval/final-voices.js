#!/usr/bin/env node
'use strict';
// Voice print of every final speaker of an eval run, pooled over up to 30 s of its words outside any overlap the
// diarization found: node eval/final-voices.js <words dump> <wav> <out.json> [recording name]
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const sherpa = require('sherpa-onnx-node');
const { Models } = require('../src/asr/models');
const { parseWav } = require('../src/audio/pcm');
const { overlaps } = require('./overlap');

const [dumpFile, wav, out, name = 'ami-IS1009a'] = process.argv.slice(2);
const models = new Models(process.env.WB_MODELS_DIR || path.join(__dirname, '..', '.models'));
const x = parseWav(fs.readFileSync(wav)).samples;
const dzKey = `dz:${name}:system:0:${2 * x.length}:0.6:0:0.1`;
const dz = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.eval', 'cache', `${crypto.createHash('sha1').update(dzKey).digest('hex').slice(0, 16)}.json`), 'utf8'));
const by = new Map();
for (const t of dz.turns) { if (!by.has(t.speaker)) by.set(t.speaker, []); by.get(t.speaker).push([t.start, t.end]); }
const ov = overlaps([...by.values()]);
const words = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
const emb = new sherpa.SpeakerEmbeddingExtractor({ model: models.speakerPath(), numThreads: 8, provider: 'cpu', debug: 0 });
const res = {};
for (const spk of new Set(words.map((w) => w.speaker))) {
  const parts = [];
  let n = 0;
  for (const w of words) {
    if (w.speaker !== spk || ov.some(([s, e]) => w.end > s - 0.3 && w.start < e + 0.3) || n > 30 * 16000) continue;
    const p = x.subarray(Math.round(w.start * 16000), Math.round(w.end * 16000));
    parts.push(p); n += p.length;
  }
  if (n < 16000) continue;
  const all = new Float32Array(n); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const st = emb.createStream();
  st.acceptWaveform({ samples: all, sampleRate: 16000 }); st.inputFinished();
  res[spk] = Array.from(emb.compute(st, false));
}
fs.writeFileSync(out, JSON.stringify(res));
console.log(Object.keys(res).join(' '));
