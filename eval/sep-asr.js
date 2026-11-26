#!/usr/bin/env node
'use strict';
// Transcribe the separated streams of overlap regions (see eval/overlap.js): node eval/sep-asr.js <dir with meta.json>
// -> <dir>/asr.json [{ start, end, streams: [{ words: [{word,start,end}], embedding, rms }] }] (times on the recording).
const fs = require('node:fs');
const path = require('node:path');
const sherpa = require('sherpa-onnx-node');
const { Models, recognizerConfig } = require('../src/asr/models');
const { wordsOf } = require('../src/asr/segment-info');

const dir = process.argv[2];
const models = new Models(process.env.WB_MODELS_DIR || path.join(__dirname, '..', '.models'));
const model = models.resolve('parakeet-tdt-0.6b-v3');
const rec = new sherpa.OfflineRecognizer(recognizerConfig(model, { threads: 8 }));
const emb = new sherpa.SpeakerEmbeddingExtractor({ model: models.speakerPath(), numThreads: 8, provider: 'cpu', debug: 0 });
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const t0 = Date.now();
const out = meta.regions.map((r) => ({
  start: r.start, end: r.end,
  streams: r.files.map((f) => {
    const w = sherpa.readWave(path.resolve(dir, path.basename(f)));
    const st = rec.createStream();
    st.acceptWaveform({ samples: w.samples, sampleRate: w.sampleRate });
    rec.decode(st);
    const res = rec.getResult(st);
    const words = (wordsOf(res) || []).map(([word, a, b]) => ({ word, start: r.start + a / 1000, end: r.start + b / 1000 }));
    const es = emb.createStream();
    es.acceptWaveform({ samples: w.samples, sampleRate: w.sampleRate });
    es.inputFinished();
    const embedding = emb.isReady(es) ? Array.from(emb.compute(es, false)) : null;
    let e = 0; for (const x of w.samples) e += x * x;
    return { text: res.text, words, embedding, rms: Math.sqrt(e / w.samples.length) };
  }),
}));
fs.writeFileSync(path.join(dir, 'asr.json'), JSON.stringify(out));
console.log(`${out.length} regions, ${out.reduce((a, r) => a + r.streams.length, 0)} streams, asr+embedding ${((Date.now() - t0) / 1000).toFixed(1)} s`);
