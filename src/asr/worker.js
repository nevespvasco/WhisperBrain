'use strict';
// ASR worker process. Owns the sherpa-onnx recognizer and one VAD per audio channel, so a slow
// decode never blocks the main process. Protocol (all messages are plain objects, Buffers allowed):
//   parent -> worker  init {model, vadPath, threads, language, vad}   audio {ch, pcm}   flush {ch}   reset {ch}   transcribe {id, pcm}
//   worker -> parent  ready   segment {ch, startMs, endMs, text, embedding?}   flushed {ch}   result {id, text}   error {message, id?}
const WINDOW = 512;
const RATE = 16000;

let sherpa = null;
let recognizer = null;
let vadConfig = null;
let speaker = null; // optional SpeakerEmbeddingExtractor
const MIN_EMBED_SAMPLES = RATE * 0.7; // shorter utterances give unreliable voice embeddings
const channels = new Map(); // ch -> { vad, pending: Float32Array[], pendingLen }

function send(m) { process.send(m); }

function toFloat(buf) {
  const n = buf.byteLength >> 1;
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i16[i] / 32768;
  return out;
}

function alignedCopy(buf) { // Int16Array views need an even byteOffset
  return buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf);
}

function transcribe(samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: RATE });
  recognizer.decode(stream);
  const r = recognizer.getResult(stream);
  return cleanText(r.text);
}

function embed(samples) {
  const st = speaker.createStream();
  st.acceptWaveform({ samples, sampleRate: RATE });
  st.inputFinished();
  if (!speaker.isReady(st)) return null;
  return Float32Array.from(speaker.compute(st, false)); // no external buffers: Electron's V8 memory cage refuses them
}

function cleanText(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

function channel(ch) {
  let c = channels.get(ch);
  if (!c) {
    c = { vad: new sherpa.Vad(vadConfig, 60), buf: new Float32Array(0) };
    channels.set(ch, c);
  }
  return c;
}

function drain(ch, c) {
  while (!c.vad.isEmpty()) {
    const seg = c.vad.front(false);
    c.vad.pop();
    const text = transcribe(seg.samples);
    if (text) {
      const embedding = speaker && seg.samples.length >= MIN_EMBED_SAMPLES ? embed(seg.samples) : null;
      send({ t: 'segment', ch, startMs: Math.round((seg.start / RATE) * 1000), endMs: Math.round(((seg.start + seg.samples.length) / RATE) * 1000), text, embedding });
    }
  }
}

function feed(ch, samples) {
  const c = channel(ch);
  let data = samples;
  if (c.buf.length) { data = new Float32Array(c.buf.length + samples.length); data.set(c.buf); data.set(samples, c.buf.length); }
  let i = 0;
  for (; i + WINDOW <= data.length; i += WINDOW) c.vad.acceptWaveform(data.subarray(i, i + WINDOW));
  c.buf = data.slice(i);
  drain(ch, c);
}

function handle(m) {
  switch (m.t) {
    case 'init': {
      sherpa = require('sherpa-onnx-node');
      recognizer = new sherpa.OfflineRecognizer(m.recognizer);
      speaker = m.speakerModel ? new sherpa.SpeakerEmbeddingExtractor({ model: m.speakerModel, numThreads: 1, provider: 'cpu', debug: 0 }) : null;
      vadConfig = {
        sileroVad: { model: m.vadPath, threshold: m.vad.threshold, minSilenceDuration: m.vad.minSilenceDuration, minSpeechDuration: m.vad.minSpeechDuration, windowSize: WINDOW, maxSpeechDuration: m.vad.maxSpeechDuration },
        sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0,
      };
      send({ t: 'ready' });
      break;
    }
    case 'audio': feed(m.ch, toFloat(alignedCopy(Buffer.from(m.pcm)))); break;
    case 'flush': {
      const c = channels.get(m.ch);
      if (c) {
        if (c.buf.length) { const pad = new Float32Array(WINDOW); pad.set(c.buf); c.vad.acceptWaveform(pad); c.buf = new Float32Array(0); }
        c.vad.flush();
        drain(m.ch, c);
      }
      send({ t: 'flushed', ch: m.ch });
      break;
    }
    case 'reset': channels.delete(m.ch); break;
    case 'transcribe': send({ t: 'result', id: m.id, text: transcribe(toFloat(alignedCopy(Buffer.from(m.pcm)))) }); break;
    default: throw new Error(`unknown message ${m.t}`);
  }
}

process.on('message', (m) => {
  try { handle(m); } catch (e) { send({ t: 'error', message: String(e && e.stack || e), id: m && m.id }); }
});
process.on('disconnect', () => process.exit(0));
