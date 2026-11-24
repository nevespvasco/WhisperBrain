'use strict';
// The after-recording diarization of one channel: ask the diarization worker who spoke when over the channel's audio,
// then relabel this recording's stored words (cutting utterances where the speaker changes) and give each speaker a
// voice print and pitch pooled over its solo speech. Mic and system audio are never clustered together: each channel
// is its own call.
const { toTimeline, planChannel } = require('./diarize');
const { diarize: runWorker } = require('./diarizer');

// threshold: sherpa's clustering distance. 0.6 separates clean distinct voices (0.7 merged two of them in the real-voice test) and gave 25.4/24.9 WDER on AMI/libri-call; 0.7 was better on the AMI far-field mix (20.9) but merges people, see eval/README.md
const DEFAULTS = { threshold: 0.6, windowShift: 0.1, tolerance: 200 };

// source: { file } (a spool) or { pcm } (s16le mono 16 kHz). stretches: [{ at, ms }], where each stretch of the
// source starts in samples and on the note timeline. segIds: the utterances of this recording on this channel (an
// earlier recording into the same note keeps its labels). -> { changes, born, speakers, overlapped, words, splits:
// Map(oldId -> [{ id, startMs, endMs }]) } or null when there was nothing to do.
// diarize: the model call (diarizer.js by default; tests pass a scripted one).
async function diarizeChannel({ diarize = runWorker, notes, speakers, noteId, channel, source, stretches, segIds, segmentation, embedding, threads = 2, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const channelSpeaker = channel === 'mic' ? 'me' : 'them';
  const ours = new Set(segIds);
  const segments = notes.segmentWords(noteId).filter((s) => ours.has(s.id) && s.speaker === channelSpeaker);
  if (!segments.length) return null;
  const res = await diarize({ ...source, segmentation, embedding, threads, threshold: o.threshold, windowShift: o.windowShift, numSpeakers: o.numSpeakers });
  if (!res?.turns?.length) return null;
  const turns = toTimeline(res.turns, stretches);
  const usedIds = speakers.forNote(noteId).map((x) => x.speakerId);
  const plan = planChannel({ segments, turns, prefix: channel === 'mic' ? 'm' : 's', usedIds, tolerance: o.tolerance });

  const splits = new Map();
  for (const ch of plan.changes) {
    const ids = notes.replaceSegment(noteId, ch.id, ch.parts);
    splits.set(ch.id, ch.parts.map((p, k) => ({ id: ids[k], startMs: p.startMs, endMs: p.endMs })));
  }
  // every final speaker gets the pooled voice print and pitch of its solo speech
  const mine = new Set(ours);
  for (const parts of splits.values()) for (const p of parts) mine.add(p.id);
  const counts = new Map();
  for (const s of notes.segmentWords(noteId)) if (mine.has(s.id) && s.speakerId) counts.set(s.speakerId, (counts.get(s.speakerId) || 0) + 1);
  const voices = [];
  for (const [final, speakerId] of plan.map) {
    const v = res.voices.find((x) => x.speaker === final);
    if (!counts.has(speakerId)) continue; // heard by the segmentation model but holding no words
    voices.push({ speakerId, centroid: v?.centroid || null, pitch: v?.pitch || null, count: counts.get(speakerId) });
  }
  speakers.adoptDiarization(noteId, channel, voices);
  return { changes: plan.changes.length, born: plan.born, speakers: voices.length, overlapped: plan.overlapped, words: plan.words, splits };
}

module.exports = { diarizeChannel, DIARIZE_DEFAULTS: DEFAULTS };
