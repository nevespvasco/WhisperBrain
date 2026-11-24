'use strict';
// ASR worker process. Owns one sherpa-onnx recognizer (plus a VAD per audio channel and, optionally, the voice model),
// so a slow decode never blocks the main process. The app runs up to three of these (live, batch, dictation; see
// engine.js). Protocol (all messages are plain objects, Buffers allowed):
//   parent -> worker  init {recognizer, beamRecognizer, vadPath, speakerModel, embedThreads, embed, vad}   config {embed}
//                     audio {ch, pcm}   flush {ch}   reset {ch}   hotwords {phrases, keep?}
//                     transcribe {id, pcm}   resample {id, pcm, rate}   import {id, pcm, concurrency}
//                     draft {id, config}   (config {recognizer, language, channels} loads the streaming model for live drafts; null drops it)
//   worker -> parent  ready   segment {ch, startMs, endMs, text, embedding?, words?, logProbMean?, logProbMin?}   flushed {ch}
//                     result {id, text}   resampled {id, pcm}   progress {id, p}   imported {id, segments}   hotwords-set {phrases}
//                     partial {ch, text, startMs}   (draft words of the utterance in progress; text '' = no draft any more)
//                     draft-set {id, enabled, ms?, error?}   draft-off {reason}   error {message, id?}
const { wordsOf, confidenceOf, loudestWindow } = require('./segment-info');
const WINDOW = 512;
const RATE = 16000;

let sherpa = null;
let recognizer = null;
let recognizerConfigs = null; // { greedy, beam }
let beamOn = false;           // the recognizer was built for modified_beam_search (needed for hotwords)
let hotwords = '';            // phrases for every new stream; '' = no biasing
let vadConfig = null;
let speaker = null; // SpeakerEmbeddingExtractor, loaded whenever the voice model is installed
let embedOn = true; // whether closed segments get a voice embedding (the recording decides; the extractor stays loaded)
const MAX_EMBED_SEC = 6; // a voice print needs a few clear seconds, and its cost grows with length
const MIN_EMBED_SAMPLES = RATE * 0.7; // shorter utterances give unreliable voice embeddings
const channels = new Map(); // ch -> { vad, buf: Float32Array, fed, tail, draft }

// ---- live drafts -------------------------------------------------------------------------------------------------
// While an utterance is in progress a streaming recognizer (sherpa OnlineRecognizer) writes draft words, sent to the
// parent as 'partial'. The VAD and the offline recognizer are untouched: the draft never decides where a segment
// ends and never feeds anything but the caption; when the VAD closes the utterance the final 'segment' follows and
// the draft is cleared. The streaming model only listens while the VAD hears speech (silence would cost CPU for
// nothing), starting from a short pre-roll because the VAD needs ~0.4 s to notice a speech onset.
let draft = null;                         // { rec, language, channels: Set, strikes } while drafts are on
const DRAFT_PREROLL = Math.round(RATE * 0.8);
const DRAFT_GAP_MS = 150;                 // at most one partial every 150 ms per channel, and only when the text changed
const DRAFT_GRACE_SEC = 3;                // an utterance whose drafting takes longer than this fraction of real time is given up
const DRAFT_MAX_LOAD = 0.9;
const DRAFT_MAX_STRIKES = 3;              // that many give-ups in a row switch drafts off for the rest of the recording

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

function newStream(samples) {
  const stream = hotwords ? recognizer.createStream(hotwords) : recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: RATE });
  return stream;
}

function decode(samples) {
  const stream = newStream(samples);
  recognizer.decode(stream);
  return recognizer.getResult(stream);
}

function transcribe(samples) { return cleanText(decode(samples).text); }

function embed(samples) {
  const st = speaker.createStream();
  st.acceptWaveform({ samples: loudestWindow(samples, MAX_EMBED_SEC * RATE), sampleRate: RATE });
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
    c = { vad: new sherpa.Vad(vadConfig, 60), buf: new Float32Array(0), fed: 0, tail: new Float32Array(0), draft: null };
    channels.set(ch, c);
  }
  return c;
}

// What the parent is told about one decoded utterance. `start` is the sample offset of the utterance in its channel.
function segmentOf(start, samples, r) {
  const text = cleanText(r.text);
  if (!text) return null;
  const embedding = speaker && embedOn && samples.length >= MIN_EMBED_SAMPLES ? embed(samples) : null;
  return { startMs: Math.round((start / RATE) * 1000), endMs: Math.round(((start + samples.length) / RATE) * 1000), text, embedding, words: wordsOf(r), ...confidenceOf(r) };
}

function drain(ch, c) {
  while (!c.vad.isEmpty()) {
    const seg = c.vad.front(false);
    c.vad.pop();
    const s = segmentOf(seg.start, seg.samples, decode(seg.samples));
    if (s) send({ t: 'segment', ch, ...s });
    endDraft(ch, c); // the final text (or the lack of one) replaces whatever draft was showing
  }
}

function gc() { try { require('node:v8').setFlagsFromString('--expose-gc'); require('node:vm').runInNewContext('gc')(); } catch { /* best effort */ } }

// Stops the draft of one channel; tells the parent to clear it when words were shown.
function endDraft(ch, c) {
  const d = c.draft;
  if (!d) return;
  c.draft = null;
  if (d.sent) send({ t: 'partial', ch, text: '', startMs: d.startMs });
}

function dropDraft() {
  for (const [ch, c] of channels) endDraft(ch, c);
  draft = null;
  gc();
}

function draftOff(reason) {
  dropDraft();
  send({ t: 'draft-off', reason });
}

// Called after the audio of one feed() went through the VAD and any closed utterances were decoded.
function draftStep(ch, c, samples) {
  const d = c.draft;
  const speaking = c.vad.isDetected();
  if (!d) {
    if (!speaking) return;
    const stream = draft.rec.createStream();
    if (draft.language) stream.setOption('language', draft.language);
    const lead = Math.min(c.tail.length, DRAFT_PREROLL);
    c.draft = { stream, startMs: Math.round(((c.fed - lead) / RATE) * 1000), busyMs: 0, audioMs: 0, sent: false, sentText: '', sentAt: 0, gaveUp: false };
    return draftFeed(ch, c, c.tail.subarray(c.tail.length - lead));
  }
  if (!speaking && c.vad.isEmpty()) return endDraft(ch, c); // the VAD dropped it as noise: no final segment will come
  draftFeed(ch, c, samples);
}

function draftFeed(ch, c, samples) {
  const d = c.draft;
  if (d.gaveUp) return;
  const t0 = process.hrtime.bigint();
  d.stream.acceptWaveform({ samples, sampleRate: RATE });
  let n = 0;
  while (draft.rec.isReady(d.stream) && n++ < 200) draft.rec.decode(d.stream);
  const text = cleanText(draft.rec.getResult(d.stream).text);
  d.busyMs += Number(process.hrtime.bigint() - t0) / 1e6;
  d.audioMs += (samples.length / RATE) * 1000;
  if (d.audioMs >= DRAFT_GRACE_SEC * 1000 && d.busyMs > d.audioMs * DRAFT_MAX_LOAD) { // cannot keep up: never starve the final text
    d.gaveUp = true;
    if (++draft.strikes >= DRAFT_MAX_STRIKES) return draftOff('this computer cannot decode drafts in real time');
    return endDraft(ch, c);
  }
  if (d.audioMs >= DRAFT_GRACE_SEC * 1000 && d.busyMs <= d.audioMs * 0.5) draft.strikes = 0;
  const now = Date.now();
  if (text && text !== d.sentText && now - d.sentAt >= DRAFT_GAP_MS) {
    d.sent = true; d.sentText = text; d.sentAt = now;
    send({ t: 'partial', ch, text, startMs: d.startMs });
  }
}

function feed(ch, samples) {
  const c = channel(ch);
  let data = samples;
  if (c.buf.length) { data = new Float32Array(c.buf.length + samples.length); data.set(c.buf); data.set(samples, c.buf.length); }
  let i = 0;
  for (; i + WINDOW <= data.length; i += WINDOW) c.vad.acceptWaveform(data.subarray(i, i + WINDOW));
  c.buf = data.slice(i);
  c.fed += samples.length;
  drain(ch, c);
  if (draft?.channels.has(ch)) {
    c.tail = appendTail(c.tail, samples);
    try { draftStep(ch, c, samples); } catch (e) { draftOff(`draft error: ${e.message}`); }
  }
}

// The last DRAFT_PREROLL samples of the channel, kept so a draft can start a little before the VAD noticed speech.
function appendTail(tail, samples) {
  const keep = Math.min(tail.length, Math.max(0, DRAFT_PREROLL - samples.length));
  const out = new Float32Array(keep + Math.min(samples.length, DRAFT_PREROLL));
  if (keep) out.set(tail.subarray(tail.length - keep), 0);
  out.set(samples.subarray(Math.max(0, samples.length - DRAFT_PREROLL)), keep);
  return out;
}

// Switch the recognizer between greedy search and beam search (hotwords need the latter, and the method is fixed when
// a recognizer is created). The new one is built off the event loop before the old one is dropped.
async function useDecoding(beam) {
  if (beam === beamOn) return;
  recognizer = await sherpa.OfflineRecognizer.createAsync(beam ? recognizerConfigs.beam : recognizerConfigs.greedy);
  beamOn = beam;
}

// The utterances of a whole file, found with the same VAD settings the live path uses (one pass, so the result does
// not depend on how the decoding is split up afterwards). Returns [{ start, length }] in samples.
function scan(i16) {
  const vad = new sherpa.Vad(vadConfig, 60);
  const win = new Float32Array(WINDOW);
  const total = i16.length + RATE; // the live path closes the last utterance with a second of silence too
  const found = [];
  const take = () => { while (!vad.isEmpty()) { const seg = vad.front(false); vad.pop(); found.push({ start: seg.start, length: seg.samples.length }); } };
  for (let at = 0; at < total; at += WINDOW) {
    for (let k = 0; k < WINDOW; k++) win[k] = at + k < i16.length ? i16[at + k] / 32768 : 0;
    vad.acceptWaveform(win);
    take();
  }
  vad.flush();
  take();
  return found;
}

// A whole file: scan for utterances, then decode them `concurrency` at a time (decodeAsync runs on libuv threads and
// every decode shares this one recognizer, so extra parallelism costs no extra model copy). Utterances come back in
// time order with their exact offsets whatever order they finished in.
async function importJob(m) {
  const raw = alignedCopy(Buffer.from(m.pcm));
  const i16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  const found = scan(i16);
  const out = new Array(found.length).fill(null);
  let next = 0, done = 0, lastReport = 0;
  const lane = async () => {
    while (next < found.length) {
      const k = next++;
      const { start, length } = found[k];
      const samples = new Float32Array(length);
      for (let j = 0; j < length; j++) samples[j] = start + j < i16.length ? i16[start + j] / 32768 : 0;
      const r = await recognizer.decodeAsync(newStream(samples));
      out[k] = segmentOf(start, samples, r);
      done++;
      const now = Date.now();
      if (now - lastReport >= 250) { lastReport = now; send({ t: 'progress', id: m.id, p: done / found.length }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(m.concurrency || 1, found.length)) }, lane));
  send({ t: 'imported', id: m.id, segments: out.filter(Boolean) });
}

async function handle(m) {
  switch (m.t) {
    case 'init': {
      sherpa = require('sherpa-onnx-node');
      recognizerConfigs = { greedy: m.recognizer, beam: m.beamRecognizer || null };
      recognizer = new sherpa.OfflineRecognizer(m.recognizer);
      embedOn = m.embed !== false;
      speaker = m.speakerModel ? new sherpa.SpeakerEmbeddingExtractor({ model: m.speakerModel, numThreads: m.embedThreads || 2, provider: 'cpu', debug: 0 }) : null;
      vadConfig = {
        sileroVad: { model: m.vadPath, threshold: m.vad.threshold, minSilenceDuration: m.vad.minSilenceDuration, minSpeechDuration: m.vad.minSpeechDuration, windowSize: WINDOW, maxSpeechDuration: m.vad.maxSpeechDuration },
        sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0,
      };
      send({ t: 'ready' });
      break;
    }
    case 'config': if (m.embed !== undefined) embedOn = !!m.embed; break;
    case 'hotwords': { // '' clears them (and returns to greedy search unless keep is set); a model without a beam config ignores them
      const phrases = recognizerConfigs?.beam ? String(m.phrases || '') : '';
      if (phrases) await useDecoding(true);
      else if (!m.keep) await useDecoding(false);
      hotwords = phrases;
      send({ t: 'hotwords-set', phrases: !!phrases });
      break;
    }
    case 'audio': feed(m.ch, toFloat(alignedCopy(Buffer.from(m.pcm)))); break;
    case 'flush': {
      const c = channels.get(m.ch);
      if (c) {
        if (c.buf.length) { const pad = new Float32Array(WINDOW); pad.set(c.buf); c.vad.acceptWaveform(pad); c.buf = new Float32Array(0); }
        c.vad.flush();
        drain(m.ch, c);
        endDraft(m.ch, c);
      }
      send({ t: 'flushed', ch: m.ch });
      break;
    }
    case 'reset': { const c = channels.get(m.ch); if (c) endDraft(m.ch, c); channels.delete(m.ch); break; }
    case 'draft': { // load (or drop, with config null) the streaming recognizer for live drafts; the live recognizer and VADs stay as they are
      if (draft) dropDraft();
      if (!m.config) { send({ t: 'draft-set', id: m.id, enabled: false }); break; }
      const t0 = Date.now();
      try {
        draft = { rec: new sherpa.OnlineRecognizer(m.config.recognizer), language: m.config.language && m.config.language !== 'auto' ? m.config.language : '', channels: new Set(m.config.channels || []), strikes: 0 };
        send({ t: 'draft-set', id: m.id, enabled: true, ms: Date.now() - t0 });
      } catch (e) { draft = null; send({ t: 'draft-set', id: m.id, enabled: false, error: String(e.message || e) }); }
      break;
    }
    case 'transcribe': send({ t: 'result', id: m.id, text: transcribe(toFloat(alignedCopy(Buffer.from(m.pcm)))) }); break;
    case 'resample': { // proper low-pass resampling (not linear interpolation) of mono float PCM to 16 kHz
      const rs = new sherpa.LinearResampler(m.rate, RATE);
      const out = Float32Array.from(rs.flush(m.pcm)); // no external buffers: Electron's V8 memory cage refuses them
      send({ t: 'resampled', id: m.id, pcm: out });
      break;
    }
    default: throw new Error(`unknown message ${m.t}`);
  }
}

// Messages run one at a time in arrival order (a recognizer rebuild must finish before audio is decoded). A file
// import is the exception: it runs alongside, so a resample or a config change is not stuck behind it.
let chain = Promise.resolve();
process.on('message', (m) => {
  const fail = (e) => send({ t: 'error', message: String(e && e.stack || e), id: m && m.id });
  if (m && m.t === 'import') { importJob(m).catch(fail); return; }
  chain = chain.then(() => handle(m)).catch(fail);
});
process.on('disconnect', () => process.exit(0));
