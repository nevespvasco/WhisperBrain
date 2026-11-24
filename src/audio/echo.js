'use strict';
// When the user listens on speakers, the microphone re-captures the other side of the call. Both channels then
// transcribe the same words. A mic segment that closely matches a time-overlapping system segment is an echo.
const tokens = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);

function overlaps(a, b, slackMs = 2500) {
  return a.startMs < b.endMs + slackMs && b.startMs < a.endMs + slackMs;
}

function isEcho(mic, sys) {
  if (!overlaps(mic, sys)) return false;
  const a = new Set(tokens(mic.text));
  const b = new Set(tokens(sys.text));
  if (a.size < 3 || b.size < 3) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = inter / Math.min(a.size, b.size);
  return jaccard >= 0.5 || containment >= 0.8;
}

module.exports = { isEcho, tokens };
