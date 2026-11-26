'use strict';
// pyannote segmentation-3.0, run by WhisperBrain itself (onnxruntime-node) instead of inside sherpa-onnx's
// OfflineSpeakerDiarization, so the frame-level speaker activity is ours: it feeds window embeddings cached while
// recording, global clustering at Stop, overlap regions and exclusive word assignment (see pipeline.js).
//
// The model takes 10 s of 16 kHz audio ([N, 1, 160000]) and returns, for 589 frames of 16.875 ms, log-probabilities
// over 7 "powerset" classes: nobody, speaker 1, 2, 3, speakers 1+2, 1+3, 2+3 (at most two at once, three local
// speakers per window). The local speakers of one window have nothing to do with those of the next: clustering their
// embeddings over the whole recording is what links them.

const RATE = 16000;
const WINDOW = 10 * RATE;           // samples per window
const FRAMES = 589;                 // frames per window
const FRAME_STEP = 270;             // samples between frames (16.875 ms)
const FRAME_SPAN = 991;             // samples one frame sees (61.9 ms receptive field)
const LOCAL = 3;                    // local speakers per window
// powerset class -> local speakers active
const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

// Hard decision per frame (the most likely class) -> Uint8Array(frames * 3), 1 where a local speaker is active.
function toMultilabel(logits, frames = FRAMES) {
  const out = new Uint8Array(frames * LOCAL);
  for (let f = 0; f < frames; f++) {
    let best = 0, bv = -Infinity;
    for (let c = 0; c < 7; c++) { const v = logits[f * 7 + c]; if (v > bv) { bv = v; best = c; } }
    for (const k of POWERSET[best]) out[f * LOCAL + k] = 1;
  }
  return out;
}

// The samples a frame stands for, centred on what it sees: [from, to) relative to the window start.
const frameSamples = (f) => [f * FRAME_STEP + (FRAME_SPAN >> 1) - (FRAME_STEP >> 1), f * FRAME_STEP + (FRAME_SPAN >> 1) + (FRAME_STEP - (FRAME_STEP >> 1))];

class Segmenter {
  constructor(modelPath, { threads = 1 } = {}) {
    this.modelPath = modelPath;
    this.threads = threads;
    this.session = null;
  }

  async open() {
    if (this.session) return this;
    const ort = require('onnxruntime-node');
    this.ort = ort;
    this.session = await ort.InferenceSession.create(this.modelPath, { intraOpNumThreads: this.threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
    this.input = this.session.inputNames[0];
    this.output = this.session.outputNames[0];
    return this;
  }

  // windows: [Float32Array(WINDOW)] -> [Uint8Array(FRAMES * 3)]
  async run(windows) {
    await this.open();
    const n = windows.length;
    if (!n) return [];
    const x = new Float32Array(n * WINDOW);
    windows.forEach((w, i) => x.set(w.subarray(0, WINDOW), i * WINDOW));
    const res = await this.session.run({ [this.input]: new this.ort.Tensor('float32', x, [n, 1, WINDOW]) });
    const y = res[this.output];
    const frames = y.dims[1];
    if (frames !== FRAMES) throw new Error(`segmentation model: expected ${FRAMES} frames per window, got ${frames}`);
    return windows.map((_, i) => toMultilabel(y.data.subarray(i * frames * 7, (i + 1) * frames * 7), frames));
  }

  release() { try { this.session?.release?.(); } catch { /* gone */ } this.session = null; }
}

module.exports = { Segmenter, toMultilabel, frameSamples, POWERSET, RATE, WINDOW, FRAMES, FRAME_STEP, FRAME_SPAN, LOCAL };
