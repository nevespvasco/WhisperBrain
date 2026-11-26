'use strict';
// The LDA + PLDA transform VBx clustering needs is specific to the voice model (trained by eval/plda-train.js,
// stored as plda/<model file name>.json). Without one for the model in use, the pipeline clusters with plain AHC.
const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();

// embeddingPath: the voice model file. -> the transform, or null when there is none for it
function loadPlda(embeddingPath) {
  const file = path.join(__dirname, 'plda', `${path.basename(String(embeddingPath), '.onnx')}.json`);
  if (cache.has(file)) return cache.get(file);
  let out = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.mean1?.length && j.lda?.length === j.mean1.length * j.phi.length && j.tr?.length === j.phi.length ** 2) out = j;
  } catch { /* none for this model */ }
  cache.set(file, out);
  return out;
}

module.exports = { loadPlda };
