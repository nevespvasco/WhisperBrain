'use strict';
// After-recording speaker diarization, the pure half (no I/O, no models).
//
// While recording, each VAD utterance gets one voice embedding and one speaker, so a turn change without a pause, or
// two people talking at once, all goes to one person. After Stop the ASR worker runs a real diarization pass over each
// channel's spooled audio (pyannote segmentation-3.0 + the voice model, see ../asr/worker.js) and returns speaker
// turns. This module turns those turns into labels:
//   - toTimeline: spool positions -> note timeline (pauses make the spool and the timeline drift apart),
//   - assignWords: each stored word goes to the speaker whose turn overlaps it most, with ~200 ms of slack for word
//     timing errors near turn boundaries,
//   - mapSpeakers: the final speakers take over the live ids by time overlap (Hungarian), so names the user typed
//     during the meeting stay attached,
//   - planChannel: which stored utterances keep their speaker, change it, or are cut where the speaker changes.
const { hungarian } = require('./hungarian');

const RATE_PER_MS = 16;     // samples per millisecond at 16 kHz
const MIN_WORD_MS = 40;     // a word with no duration is treated as this long around its time
const OVERLAP_SHARE = 0.3;  // a word is "overlapped" when a second speaker covers at least this share of it
const SNAP_MAX_WORDS = 2;   // a stray run of at most this many words…
const SNAP_MAX_MS = 1000;   // …and this long, between two words of one speaker, may snap back to that speaker

const overlapMs = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// Diarization turns are in seconds of spooled audio. stretches: [{ at: spool sample where a stretch of audio starts,
// ms: where that stretch starts on the note timeline }] (one per start/resume). A turn that runs across a pause is cut
// in two. -> [{ startMs, endMs, speaker }] sorted by start.
function toTimeline(turns, stretches) {
  const st = [...stretches].sort((a, b) => a.at - b.at);
  const out = [];
  for (const t of turns) {
    const s = Math.round(t.start * 16000), e = Math.round(t.end * 16000);
    for (let k = 0; k < st.length; k++) {
      const from = st[k].at, to = k + 1 < st.length ? st[k + 1].at : Infinity;
      const a = Math.max(s, from), b = Math.min(e, to);
      if (b <= a) continue;
      out.push({ startMs: Math.round(st[k].ms + (a - from) / RATE_PER_MS), endMs: Math.round(st[k].ms + (b - from) / RATE_PER_MS), speaker: t.speaker });
    }
  }
  return out.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
}

// words: [{ startMs, endMs }] on the timeline; turns: [{ startMs, endMs, speaker }].
// -> [{ speaker, overlap }] in the order of `words` (speaker null when there are no turns at all).
function assignWords(words, turns, { tolerance = 200 } = {}) {
  const span = (w) => {
    if (w.endMs - w.startMs >= MIN_WORD_MS) return [w.startMs, w.endMs];
    const mid = (w.startMs + w.endMs) / 2;
    return [mid - MIN_WORD_MS / 2, mid + MIN_WORD_MS / 2];
  };
  const out = words.map((w) => {
    const [s, e] = span(w);
    const cover = new Map();
    let nearest = null, gapBest = Infinity;
    for (const t of turns) {
      const o = overlapMs(s, e, t.startMs, t.endMs);
      if (o > 0) { cover.set(t.speaker, (cover.get(t.speaker) || 0) + o); continue; }
      const gap = t.startMs >= e ? t.startMs - e : s - t.endMs;
      if (gap < gapBest) { gapBest = gap; nearest = t.speaker; }
    }
    if (!cover.size) return { speaker: nearest, overlap: false }; // a word in a gap goes to the closest turn
    const ranked = [...cover].sort((a, b) => b[1] - a[1]);
    return { speaker: ranked[0][0], overlap: ranked.length > 1 && ranked[1][1] >= OVERLAP_SHARE * (e - s) };
  });

  // Word timings are off by 100-200 ms near turn boundaries. A short run of words between two words of the same
  // speaker snaps back to that speaker when, with the boundaries moved by `tolerance`, that speaker covers most of it.
  // A real backchannel ("yeah") sits clear of the other speaker's turns and is left alone.
  const order = words.map((_, i) => i).sort((a, b) => words[a].startMs - words[b].startMs || a - b);
  for (let k = 1; k < order.length - 1; k++) {
    const x = out[order[k]].speaker;
    const y = out[order[k - 1]].speaker;
    if (x === y || y === null) continue;
    let end = k;
    while (end + 1 < order.length && out[order[end + 1]].speaker === x && end - k + 1 < SNAP_MAX_WORDS + 1) end++;
    if (end - k + 1 > SNAP_MAX_WORDS || end + 1 >= order.length || out[order[end + 1]].speaker !== y) continue;
    const [s] = span(words[order[k]]), [, e] = span(words[order[end]]);
    if (e - s > SNAP_MAX_MS) continue;
    let covered = 0;
    for (const t of turns) if (t.speaker === y) covered += overlapMs(s, e, t.startMs - tolerance, t.endMs + tolerance);
    if (covered >= 0.5 * (e - s)) for (let i = k; i <= end; i++) out[order[i]].speaker = y;
  }
  return out;
}

const idNumber = (id, prefix) => (String(id).startsWith(prefix) ? Number(String(id).slice(prefix.length)) || 0 : 0);

// The final speakers take over the live ids they overlap most in time, one to one, so a name typed during the
// meeting stays with the voice it was typed for. live: [{ speakerId, startMs, endMs }] (the stored utterances, with
// the speaker the live pass gave them); turns: [{ speaker, startMs, endMs }]. usedIds: ids already taken in this
// note (new speakers get fresh numbers after them).
// -> { map: Map(finalSpeaker -> speakerId), born: [speakerId] }
function mapSpeakers(live, turns, { prefix = 's', usedIds = [] } = {}) {
  const finals = [...new Set(turns.map((t) => t.speaker))];
  const ids = [...new Set(live.map((l) => l.speakerId).filter(Boolean))];
  const ov = finals.map((f) => ids.map((id) => {
    let s = 0;
    for (const t of turns) if (t.speaker === f) for (const l of live) if (l.speakerId === id) s += overlapMs(t.startMs, t.endMs, l.startMs, l.endMs);
    return s;
  }));
  const pick = ids.length ? hungarian(ov.map((row) => row.map((x) => -x))) : new Int32Array(finals.length).fill(-1);
  let next = Math.max(0, ...usedIds.map((id) => idNumber(id, prefix)), ...ids.map((id) => idNumber(id, prefix))) + 1;
  const map = new Map(), born = [];
  // new speakers are numbered in order of first appearance
  const firstAt = (f) => Math.min(...turns.filter((t) => t.speaker === f).map((t) => t.startMs));
  for (const fi of finals.map((_, i) => i).sort((a, b) => firstAt(finals[a]) - firstAt(finals[b]))) {
    const j = pick[fi];
    if (j >= 0 && ov[fi][j] > 0) map.set(finals[fi], ids[j]);
    else { const id = `${prefix}${next++}`; map.set(finals[fi], id); born.push(id); }
  }
  return { map, born };
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Cut one stored utterance where its words change speaker. seg: { startMs, endMs, text, words: [[word, startMs,
// endMs], ...] relative to the segment start }; labels: speaker per word. -> [{ startMs, endMs, text, words,
// speakerId }] (one part when the speaker does not change), or null when the words do not spell the text (then the
// caller labels the utterance as a whole).
function splitByWords(seg, labels) {
  const words = seg.words || [];
  if (!words.length || squash(words.map((w) => w[0]).join(' ')) !== squash(seg.text)) return null;
  const parts = [];
  for (let i = 0; i < words.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.speakerId === labels[i]) { last.w.push(words[i]); continue; }
    parts.push({ speakerId: labels[i], w: [words[i]] });
  }
  return parts.map((p, k) => {
    const startMs = k === 0 ? seg.startMs : seg.startMs + p.w[0][1];
    const endMs = k === parts.length - 1 ? seg.endMs : seg.startMs + parts[k + 1].w[0][1];
    const off = startMs - seg.startMs;
    return { startMs, endMs, text: p.w.map((w) => w[0]).join(' '), words: p.w.map(([t, s, e, o]) => (o ? [t, s - off, e - off, 1] : [t, s - off, e - off])), speakerId: p.speakerId };
  });
}

// Plan the relabelling of one channel. segments: the utterances of this recording on this channel, [{ id, startMs,
// endMs, text, speakerId, words }]; turns: timeline turns. -> { map, born, changes: [{ id, parts }] } where `parts`
// replaces the utterance (only utterances that change are listed), plus `words`/`overlapped` counts.
// exclusive: optional timeline turns with one speaker per moment (the owned pipeline's); when given, each word goes
// to the speaker that dominates that moment, while `turns` (overlap included) still flag overlapped words.
function planChannel({ segments, turns, exclusive = null, prefix = 's', usedIds = [], tolerance = 200 }) {
  const { map, born } = mapSpeakers(segments, turns, { prefix, usedIds });
  const changes = [];
  let nWords = 0, overlapped = 0;
  for (let seg of segments) {
    const words = (seg.words || []).map(([, s, e]) => ({ startMs: seg.startMs + s, endMs: seg.startMs + e }));
    let parts = null;
    let flagChanged = false;
    if (words.length) {
      const got = assignWords(words, turns, { tolerance });
      if (exclusive?.length) assignWords(words, exclusive, { tolerance }).forEach((x, i) => { if (x.speaker !== null) got[i].speaker = x.speaker; });
      nWords += got.length;
      overlapped += got.filter((g) => g.overlap).length;
      // an overlapped word (two people talking at once) carries a fourth element, 1; redone from scratch on every pass
      const flagged = seg.words.map(([t, s, e], i) => (got[i].overlap ? [t, s, e, 1] : [t, s, e]));
      flagChanged = flagged.some((w, i) => (w[3] || 0) !== (seg.words[i][3] || 0));
      seg = { ...seg, words: flagged };
      // a word with no turn near it keeps the label of its neighbours (or the utterance's own)
      const labels = got.map((g) => (g.speaker === null ? null : map.get(g.speaker)));
      for (let i = 0; i < labels.length; i++) if (!labels[i]) labels[i] = labels[i - 1] || labels.find(Boolean) || seg.speakerId;
      parts = splitByWords(seg, labels);
      if (!parts) parts = [{ ...pick(seg), speakerId: majority(words, labels) || seg.speakerId }];
    } else {
      const cover = new Map();
      for (const t of turns) { const o = overlapMs(seg.startMs, seg.endMs, t.startMs, t.endMs); if (o > 0) cover.set(t.speaker, (cover.get(t.speaker) || 0) + o); }
      const best = [...cover].sort((a, b) => b[1] - a[1])[0];
      parts = [{ ...pick(seg), speakerId: best ? map.get(best[0]) : seg.speakerId }];
    }
    if (parts.length > 1 || parts[0].speakerId !== seg.speakerId || flagChanged) changes.push({ id: seg.id, parts });
  }
  return { map, born, changes, words: nWords, overlapped };
}

const pick = (seg) => ({ startMs: seg.startMs, endMs: seg.endMs, text: seg.text, words: seg.words || null });

function majority(words, labels) {
  const dur = new Map();
  words.forEach((w, i) => { if (labels[i]) dur.set(labels[i], (dur.get(labels[i]) || 0) + Math.max(1, w.endMs - w.startMs)); });
  return [...dur].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// The stretches where `speaker` talks alone, longest first, up to `maxSec` in all (each at least `minSec`): the audio
// a voice print and a pitch for that speaker are taken from. turns: [{ start, end, speaker }] in seconds.
// -> [[start, end], ...] in seconds
function soloStretches(turns, speaker, { maxSec = 30, minSec = 0.5 } = {}) {
  const others = turns.filter((t) => t.speaker !== speaker).map((t) => [t.start, t.end]).sort((a, b) => a[0] - b[0]);
  const solo = [];
  for (const t of turns) {
    if (t.speaker !== speaker) continue;
    let cur = [[t.start, t.end]];
    for (const [a, b] of others) {
      if (b <= t.start || a >= t.end) continue;
      cur = cur.flatMap(([s, e]) => [[s, Math.min(e, a)], [Math.max(s, b), e]].filter(([x, y]) => y > x));
    }
    solo.push(...cur);
  }
  solo.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const out = [];
  let total = 0;
  for (const [s, e] of solo) {
    if (e - s < minSec || total >= maxSec) continue;
    const take = Math.min(e - s, maxSec - total);
    out.push([s, s + take]);
    total += take;
  }
  return out;
}

module.exports = { toTimeline, assignWords, mapSpeakers, splitByWords, planChannel, soloStretches };
