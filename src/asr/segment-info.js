'use strict';
// Pure helpers for what the worker reports about a decoded segment.
const RATE = 16000;

// Words with timing, rebuilt from the recognizer's per-token output (a token starting with a space opens a word;
// punctuation and word pieces join the word before them). [[word, startMs, endMs], ...], relative to the segment start.
function wordsOf(r) {
  const { tokens, timestamps, durations } = r;
  if (!Array.isArray(tokens) || !tokens.length || !Array.isArray(timestamps) || timestamps.length !== tokens.length) return null;
  const words = [];
  let cur = null;
  for (let i = 0; i < tokens.length; i++) {
    const piece = String(tokens[i]);
    const from = Math.round(timestamps[i] * 1000);
    const to = Math.round((timestamps[i] + (durations?.[i] || 0)) * 1000);
    if (!cur || /^\s/.test(piece)) {
      if (cur && cur[0].trim()) words.push(cur);
      cur = [piece.trimStart(), from, to];
    } else { cur[0] += piece; cur[2] = Math.max(cur[2], to); }
  }
  if (cur && cur[0].trim()) words.push(cur);
  return words.length ? words : null;
}

// Mean and minimum token log-probability: how sure the recognizer was (0 = certain, more negative = less so).
function confidenceOf(r) {
  const p = r.ys_log_probs;
  if (!Array.isArray(p) || !p.length) return { logProbMean: null, logProbMin: null };
  let sum = 0, min = 0;
  for (const x of p) { sum += x; if (x < min) min = x; }
  return { logProbMean: sum / p.length, logProbMin: min };
}

// The loudest window of at most MAX_EMBED_SAMPLES: for a long utterance that is where the speaker is clearest.
function loudestWindow(samples, size, hop = RATE / 4) {
  if (samples.length <= size) return samples;
  const cum = new Float64Array(samples.length + 1); // running sum of squares
  for (let i = 0; i < samples.length; i++) cum[i + 1] = cum[i] + samples[i] * samples[i];
  let best = 0, bestE = -1;
  for (let at = 0; at + size <= samples.length; at += hop) {
    const e = cum[at + size] - cum[at];
    if (e > bestE) { bestE = e; best = at; }
  }
  const last = samples.length - size; // the final partial hop
  if (cum[samples.length] - cum[last] > bestE) best = last;
  return samples.subarray(best, best + size);
}

module.exports = { wordsOf, confidenceOf, loudestWindow };
