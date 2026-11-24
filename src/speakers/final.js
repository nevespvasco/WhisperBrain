'use strict';
// The after-recording diarization of one channel: ask the diarization worker who spoke when over the channel's audio,
// then relabel this recording's stored words (cutting utterances where the speaker changes) and give each speaker a
// voice print and pitch pooled over its solo speech. Mic and system audio are never clustered together: each channel
// is its own call.
const { toTimeline, planChannel } = require('./diarize');
const { diarize: runWorker } = require('./diarizer');
const { cosine } = require('./cluster');

const secondsOf = (res) => { const m = new Map(); for (const t of res.turns) m.set(t.speaker, (m.get(t.speaker) || 0) + t.end - t.start); return m; };
const centroidOf = (res, id) => res.voices.find((v) => v.speaker === id)?.centroid;

// The voice among `keep` that sounds most like `id`
function nearest(res, id, keep) {
  const c = centroidOf(res, id);
  let best = keep[0], score = -2;
  for (const k of keep) {
    const kc = centroidOf(res, k);
    const sc = c && kc ? cosine(c, kc) : -1;
    if (sc > score) { score = sc; best = k; }
  }
  return best;
}

// Merge voices into others: to = Map(voice -> the voice it joins). res: { turns, voices } -> the same shape, plus `folded`.
function applyFold(res, to) {
  return { ...res, turns: res.turns.map((t) => ({ ...t, speaker: to.get(t.speaker) ?? t.speaker })), voices: res.voices.filter((v) => !to.has(v.speaker)), folded: to.size };
}

// Fold the voices that hold too little speech into the closest other voice. res: { turns, voices } as the worker
// returns them -> the same shape (turns relabelled, voices dropped), plus `folded` (how many).
function foldStarved(res, { minShare, minSeconds }) {
  const secs = secondsOf(res);
  const total = [...secs.values()].reduce((a, b) => a + b, 0);
  const starved = (id) => secs.get(id) < Math.max(minSeconds, minShare * total);
  const keep = [...secs.keys()].filter((id) => !starved(id));
  if (!keep.length || keep.length === secs.size) return { ...res, folded: 0 };
  const to = new Map();
  for (const id of secs.keys()) if (starved(id)) to.set(id, nearest(res, id, keep));
  return applyFold(res, to);
}

// At most `max` voices: while there are more, the one with the least speech joins the voice it sounds most like. A roster or a
// calendar says who might be there, not who spoke, so it only caps; it never invents a voice.
function capVoices(res, max) {
  let cur = { ...res, folded: 0 };
  for (;;) {
    const secs = secondsOf(cur);
    if (secs.size <= max) return cur;
    const [smallest] = [...secs].sort((a, b) => a[1] - b[1])[0];
    const to = nearest(cur, smallest, [...secs.keys()].filter((k) => k !== smallest));
    const next = applyFold(cur, new Map([[smallest, to]]));
    cur = { ...next, folded: cur.folded + 1 };
  }
}

// threshold: sherpa's clustering distance. 0.6 separates clean distinct voices (0.7 merged two of them in the real-voice test) and gave 25.4/24.9 WDER on AMI/libri-call; 0.7 was better on the AMI far-field mix (20.9) but merges people, see eval/README.md
// expected: how many voices the roster or calendar says to expect on this channel (hint.js). An upper bound: the clustering is
// free to find fewer (people invited do not always come), a voice that holds too little of the speech to be a person taking part
// is folded into its nearest neighbour, and if there are still more voices than that, the smallest join the ones they sound like.
// numSpeakers is the person's own count ("Others on the call"): forced on the clustering as it is.
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
  let res = await diarize({ ...source, segmentation, embedding, threads, threshold: o.threshold, windowShift: o.windowShift, numSpeakers: o.numSpeakers || undefined });
  if (!res?.turns?.length) return null;
  if (!o.numSpeakers && o.expected) res = capVoices(foldStarved(res, o), o.expected);
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

module.exports = { diarizeChannel, foldStarved, capVoices, DIARIZE_DEFAULTS: DEFAULTS };
