'use strict';
// Diarization worker process, started after a recording for one channel at a time and gone when it is done, so the
// long native call never blocks the main process or the ASR worker. Protocol:
//   parent -> worker  diarize {file | pcm, segmentation, embedding, threads, numSpeakers, threshold, windowShift}
//   worker -> parent  diarized {turns: [{start, end, speaker}] (seconds), voices: [{speaker, centroid, pitch, ms}]}
//                     error {message}
// pyannote segmentation-3.0 finds who is active frame by frame (overlap included), the voice model embeds each
// speaker per window, and the embeddings are clustered over the whole recording. Each speaker also gets a voice print
// pooled over up to 30 s of solo speech, and a pitch (used only as a veto when merging or matching voices).
const fs = require('node:fs');
const { soloStretches } = require('./diarize');
const { voiceFeatures } = require('../audio/features');

const RATE = 16000;

function toFloat(buf) {
  const b = buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf); // Int16Array views need an even byteOffset
  const i16 = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

function diarize(m) {
  const sherpa = require('sherpa-onnx-node');
  const samples = toFloat(m.pcm ? Buffer.from(m.pcm) : fs.readFileSync(m.file));
  const threads = m.threads || 2;
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: m.segmentation, windowShiftRatio: m.windowShift ?? 0.1 }, numThreads: threads, provider: 'cpu', debug: 0 },
    embedding: { model: m.embedding, numThreads: threads, provider: 'cpu', debug: 0 },
    clustering: { numClusters: m.numSpeakers > 0 ? m.numSpeakers : -1, threshold: m.threshold ?? 0.5 },
    minDurationOn: 0.2, minDurationOff: 0.5,
  });
  const turns = sd.process(samples).map((t) => ({ start: t.start, end: t.end, speaker: t.speaker }));
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: m.embedding, numThreads: threads, provider: 'cpu', debug: 0 });
  const voices = [...new Set(turns.map((t) => t.speaker))].map((id) => {
    const ms = Math.round(turns.filter((t) => t.speaker === id).reduce((a, t) => a + t.end - t.start, 0) * 1000);
    const parts = soloStretches(turns, id).map(([s, e]) => samples.subarray(Math.round(s * RATE), Math.round(e * RATE)));
    if (!parts.length) return { speaker: id, centroid: null, pitch: null, ms };
    const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const st = extractor.createStream();
    st.acceptWaveform({ samples: all, sampleRate: RATE });
    st.inputFinished();
    const centroid = extractor.isReady(st) ? Float32Array.from(extractor.compute(st, false)) : null; // no external buffers (Electron)
    const f0 = parts.slice(0, 8).map((p) => voiceFeatures(p.subarray(0, 8 * RATE))?.f0).filter(Boolean).sort((a, b) => a - b);
    return { speaker: id, centroid, pitch: f0.length ? f0[(f0.length - 1) >> 1] : null, ms };
  });
  return { turns, voices };
}

process.on('message', (m) => {
  try {
    if (m.t !== 'diarize') throw new Error(`unknown message ${m.t}`);
    process.send({ t: 'diarized', ...diarize(m) });
  } catch (e) { process.send({ t: 'error', message: String(e && e.stack || e) }); }
});
process.on('disconnect', () => process.exit(0));
