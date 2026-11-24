'use strict';
// The after-recording diarization of one channel: ask the diarization worker who spoke when over the channel's audio,
// then relabel this recording's stored words (cutting utterances where the speaker changes) and give each speaker a
// voice print and pitch pooled over its solo speech. Mic and system audio are never clustered together: each channel
// is its own call.
const { toTimeline, planChannel } = require('./diarize');
const { diarize: runWorker } = require('./diarizer');
const { cosine } = require('./cluster');

// Fold the voices that hold too little speech into the closest other voice. res: { turns, voices } as the worker
// returns them -> the same shape (turns relabelled, voices dropped), plus `folded` (how many).
function foldStarved(res, { minShare, minSeconds }) {
  const secs = new Map();
  for (const t of res.turns) secs.set(t.speaker, (secs.get(t.speaker) || 0) + t.end - t.start);
  const total = [...secs.values()].reduce((a, b) => a + b, 0);
  const to = new Map();
  const starved = (id) => secs.get(id) < Math.max(minSeconds, minShare * total);
  const keep = [...secs.keys()].filter((id) => !starved(id));
  if (!keep.length || keep.length === secs.size) return { ...res, folded: 0 };
  for (const id of secs.keys()) {
    if (!starved(id)) continue;
    const c = res.voices.find((v) => v.speaker === id)?.centroid;
    let best = keep[0], score = -2;
    for (const k of keep) {
      const kc = res.voices.find((v) => v.speaker === k)?.centroid;
      const sc = c && kc ? cosine(c, kc) : -1;
      if (sc > score) { score = sc; best = k; }
    }
    to.set(id, best);
  }
  return { turns: res.turns.map((t) => ({ ...t, speaker: to.get(t.speaker) ?? t.speaker })), voices: res.voices.filter((v) => !to.has(v.speaker)), folded: to.size };
}

// threshold: sherpa's clustering distance. 0.6 separates clean distinct voices (0.7 merged two of them in the real-voice test) and gave 25.4/24.9 WDER on AMI/libri-call; 0.7 was better on the AMI far-field mix (20.9) but merges people, see eval/README.md
// expected: how many voices the calendar says to expect on this channel (hint.js). It is forced on the clustering, then
// any voice that holds too little of the speech to be a person taking part is folded into its nearest neighbour (people
// invited do not always come). numSpeakers forces a count without that check (the eval harness).
const DEFAULTS = { threshold: 0.6, windowShift: 0.1, tolerance: 200, minShare: 0.05, minSeconds: 8 };

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
  let res = await diarize({ ...source, segmentation, embedding, threads, threshold: o.threshold, windowShift: o.windowShift, numSpeakers: o.numSpeakers || o.expected });
  if (!res?.turns?.length) return null;
  if (!o.numSpeakers && o.expected) res = foldStarved(res, o);
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

module.exports = { diarizeChannel, foldStarved, DIARIZE_DEFAULTS: DEFAULTS };
