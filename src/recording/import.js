'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { wavToPcm16 } = require('../audio/pcm');

// Decode an audio file to s16le mono 16 kHz. WAV is parsed natively; anything else goes through ffmpeg if present.
function decodeAudio(buffer, filename = '') {
  const isWav = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
  if (isWav) { try { return Promise.resolve(wavToPcm16(buffer)); } catch { /* e.g. float WAV: let ffmpeg try */ } }
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `Cannot decode ${path.extname(filename) || 'this'} audio: install ffmpeg, or use a 16-bit PCM WAV file.` : e.message)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').pop()}`))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
  });
}

// Run decoded audio through the recognizer on a dedicated channel and return timed segments.
async function transcribePcm(engine, pcm, { channel = 'import', chunkMs = 200, onProgress } = {}) {
  const segments = [];
  const on = (s) => { if (s.ch === channel) segments.push({ startMs: s.startMs, endMs: s.endMs, text: s.text, embedding: s.embedding || null }); };
  engine.on('segment', on);
  try {
    const size = 16 * 2 * chunkMs;
    for (let i = 0; i < pcm.length; i += size) {
      engine.feed(channel, pcm.subarray(i, i + size));
      if (onProgress && (i / size) % 50 === 0) onProgress(i / pcm.length);
      if ((i / size) % 25 === 24) await new Promise((r) => setImmediate(r));
    }
    engine.feed(channel, Buffer.alloc(16000 * 2)); // close the last utterance
    await engine.flush(channel);
    engine.reset(channel);
  } finally { engine.off('segment', on); }
  return segments;
}

// Label imported segments by voice (single channel: everyone is a "them" speaker s1, s2…).
function assignSpeakers(noteId, segments, speakers, { threshold = 0.6 } = {}) {
  if (!speakers || !segments.some((s) => s.embedding)) return segments.map((s) => ({ ...s, speaker: 'them' }));
  const { SpeakerTracker } = require('../speakers/cluster');
  const existing = speakers.forNote(noteId).filter((x) => x.channel === 'system' && x.centroid);
  const tr = new SpeakerTracker({ threshold, prefix: 's', speakers: existing.map((x) => ({ id: x.speakerId, centroid: x.centroid, count: x.count })) });
  let last = null;
  const out = segments.map((s) => {
    let speakerId = null;
    if (s.embedding) { speakerId = tr.assign(s.embedding).id; last = { id: speakerId, endMs: s.endMs }; }
    else if (last && s.startMs - last.endMs <= 3000) speakerId = last.id;
    return { ...s, speaker: 'them', speakerId };
  });
  for (const sp of tr.speakers) speakers.save(noteId, { speakerId: sp.id, channel: 'system', centroid: sp.centroid, count: sp.count });
  return out;
}

module.exports = { decodeAudio, transcribePcm, assignSpeakers };
