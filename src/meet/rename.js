'use strict';
// Names for a meeting's voices from the evidence kept about it (table `evidence`), run again whenever there is new evidence
// (a platform transcript was attached). The same reasoning as at Stop (collector.js): what says "these words, this person"
// (transcript lines, captions) outranks who was highlighted; one name to one voice (names.js). Nothing the person typed is touched.
const { nameKey } = require('./protocol');
const { activeIntervals, estimateLag, rawIntervals, speechOf, nameSpeakers } = require('./names');
const { alignCaptions, mergeIntervals } = require('./captions');

// -> { named: [{ speakerId, name, source, score }], kept: [speakerId], unresolved: n }
function renameFromEvidence({ notes, speakers, evidence, noteId, selfNames = [] }) {
  const utterances = notes.segmentWords(noteId).filter((u) => u.speaker === 'them' && u.speakerId);
  const speech = speechOf(utterances);
  const rows = evidence.forNote(noteId);
  const by = (kind) => rows.filter((r) => r.kind === kind);

  // highlights: the raw intervals of each source, put back to events, the delay of each source found again
  const sources = new Map();
  for (const r of by('highlight')) { if (!sources.has(r.source)) sources.set(r.source, { events: [], prior: r.meta?.lagMs ?? 500 }); sources.get(r.source).events.push({ t: r.t0, name: r.name }, { t: r.t1, name: null }); }
  let highlight = [], best = 0;
  for (const { events, prior } of sources.values()) {
    const lag = estimateLag({ raw: rawIntervals(events), speech, prior });
    const iv = activeIntervals(events, { lagMs: lag });
    const ms = iv.reduce((n, x) => n + x.endMs - x.startMs, 0);
    if (ms > best) { highlight = iv; best = ms; }
  }

  // what says the words: transcript lines (already matched to utterances) and live captions (matched now)
  const transcript = by('transcript').map((r) => ({ startMs: r.t0, endMs: r.t1, name: r.name }));
  const captions = by('caption').map((r) => ({ t: r.t0, name: r.name, text: r.meta?.text || '' }));
  const fromCaptions = captions.length ? alignCaptions({ captions, utterances }) : [];
  const saying = [...transcript, ...fromCaptions.map(({ startMs, endMs, name }) => ({ startMs, endMs, name }))];
  const active = saying.length ? mergeIntervals(saying, highlight) : highlight;

  let latest = null;
  for (const r of by('roster')) if (!latest || r.t0 > latest) latest = r.t0;
  const remotes = latest === null ? null : [...new Set(by('roster').filter((r) => r.t0 === latest && !r.meta?.self).map((r) => r.name))];
  const selfKeys = [...new Set([...selfNames.map(nameKey), ...by('roster').filter((r) => r.meta?.self).map((r) => r.key)])].filter(Boolean);

  const res = nameSpeakers({ speech, active, remotes, selfKeys, candidates: by('calendar').map((r) => r.name) });
  const source = transcript.length ? 'transcript' : fromCaptions.length ? 'meeting:caption' : 'meeting:highlight';
  const named = [], kept = [];
  for (const n of res.named) {
    const r = speakers.nameFromMeeting(noteId, n.speakerId, n.name, { source: n.via === 'sole' ? 'meeting:roster' : source, confidence: n.score ?? n.share, replaceInferred: true });
    if (r === 'named' || r === 'agrees') named.push({ speakerId: n.speakerId, name: n.name, source, score: n.score ?? n.share });
    else if (r === 'kept') kept.push(n.speakerId);
  }
  return { named, kept, unresolved: res.unresolved.length };
}

module.exports = { renameFromEvidence };
