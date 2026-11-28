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
  const relabel = (list) => list?.map((t) => ({ ...t, speaker: to.get(t.speaker) ?? t.speaker }));
  return { ...res, turns: relabel(res.turns), exclusive: relabel(res.exclusive), voices: res.voices.filter((v) => !to.has(v.speaker)), folded: to.size };
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
  if (!(max >= 1)) return { ...res, folded: 0 };   // nothing sensible to cap to (0, NaN): leave the voices alone
  let cur = { ...res, folded: 0 };
  for (;;) {
    const secs = secondsOf(cur);
    if (secs.size <= max) return cur;
    const [smallest] = [...secs].sort((a, b) => a[1] - b[1])[0];
    const to = nearest(cur, smallest, [...secs.keys()].filter((k) => k !== smallest));
    cur = { ...applyFold(cur, new Map([[smallest, to]])), folded: cur.folded + 1 };
  }
}

// How many voices the live labels of a channel found that hold real speech: each with at least minSeconds and minShare of the
// channel's speech (the live tracker over-splits a little; fragments do not count). segments: [{ speakerId, startMs, endMs }].
function liveVoiceCount(segments, { minSeconds = 15, minShare = 0.05 } = {}) {
  const secs = new Map();
  for (const s of segments) if (s.speakerId) secs.set(s.speakerId, (secs.get(s.speakerId) || 0) + Math.max(0, s.endMs - s.startMs) / 1000);
  const total = [...secs.values()].reduce((a, b) => a + b, 0);
  return [...secs.values()].filter((v) => v >= Math.max(minSeconds, minShare * total)).length;
}

// threshold: sherpa's clustering distance. 0.6 separates clean distinct voices (0.7 merged two of them in the real-voice test) and gave 25.4/24.9 WDER on AMI/libri-call; 0.7 was better on the AMI far-field mix (20.9) but merges people, see eval/README.md
// expected: how many voices the roster or calendar says to expect on this channel (hint.js). An upper bound: the clustering is
// free to find fewer (people invited do not always come), a voice that holds too little of the speech to be a person taking part
// is folded into its nearest neighbour, and if there are still more voices than that, the smallest join the ones they sound like.
// numSpeakers is the person's own count ("Others on the call"): forced on the clustering as it is.
// fallbackSpeakers: how many voices the live labels heard (liveVoiceCount, capped by the call's list of people). When the
// clustering still finds a single voice where that says two or more, the live labels are worth more than one voice: nothing is
// relabelled and the result says `collapsed` (the caller warns). A 5-person Discord call came out as one voice before this.
// exclusive: when the diarization says who dominates each moment (the owned pipeline does), words follow that rather
// than the longest-covering of the overlapping turns.
const DEFAULTS = { threshold: 0.6, windowShift: 0.1, tolerance: 200, minShare: 0.05, minSeconds: 8, exclusive: true };

// source: { file } (a spool) or { pcm } (s16le mono 16 kHz). stretches: [{ at, ms }], where each stretch of the
// source starts in samples and on the note timeline. segIds: the utterances of this recording on this channel (an
// earlier recording into the same note keeps its labels). -> { changes, born, speakers, overlapped, words, splits:
// Map(oldId -> [{ id, startMs, endMs }]) } or null when there was nothing to do.
// diarize: the model call (diarizer.js by default; tests pass a scripted one).
// altEmbedding/altModel: an older voice model (path, id) the speakers' prints are also made with, so saved voices of that model are still recognised.
async function diarizeChannel({ diarize = runWorker, notes, speakers, noteId, channel, source, stretches, segIds, segmentation, embedding, altEmbedding = null, altModel = null, threads = 2, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const channelSpeaker = channel === 'mic' ? 'me' : 'them';
  const ours = new Set(segIds);
  const segments = notes.segmentWords(noteId).filter((s) => ours.has(s.id) && s.speaker === channelSpeaker);
  if (!segments.length) return null;
  const fallbackSpeakers = !o.numSpeakers && o.fallbackSpeakers >= 2 ? o.fallbackSpeakers : 0;
  let res = await diarize({ ...source, segmentation, embedding, altEmbedding: altEmbedding || undefined, threads, threshold: o.threshold, windowShift: o.windowShift, numSpeakers: o.numSpeakers || undefined, fallbackSpeakers: fallbackSpeakers || undefined });
  if (!res?.turns?.length) return null;
  if (fallbackSpeakers && new Set(res.turns.map((t) => t.speaker)).size < 2) return { collapsed: true, expected: fallbackSpeakers, changes: 0, born: 0, speakers: 1, splits: new Map(), stats: res.stats || null };
  if (!o.numSpeakers && o.expected) res = capVoices(foldStarved(res, o), o.expected);
  const turns = toTimeline(res.turns, stretches);
  const exclusive = o.exclusive && res.exclusive?.length ? toTimeline(res.exclusive, stretches) : null;
  const usedIds = speakers.forNote(noteId).map((x) => x.speakerId);
  const plan = planChannel({ segments, turns, exclusive, prefix: channel === 'mic' ? 'm' : 's', usedIds, tolerance: o.tolerance });

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
    voices.push({ speakerId, centroid: v?.centroid || null, pitch: v?.pitch || null, count: counts.get(speakerId), quality: v?.quality || null, altCentroid: v?.altCentroid || null, altModel: v?.altCentroid ? altModel : null });
  }
  speakers.adoptDiarization(noteId, channel, voices);
  return { changes: plan.changes.length, born: plan.born, speakers: voices.length, overlapped: plan.overlapped, words: plan.words, splits, overlaps: res.overlaps || null, stats: res.stats || null };
}

module.exports = { diarizeChannel, foldStarved, capVoices, liveVoiceCount, DIARIZE_DEFAULTS: DEFAULTS };
