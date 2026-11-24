'use strict';
// Who the transcript says spoke: the one place that decides which voices are shown, how they are numbered and what a line is
// called. The note page, the floating widget, the exports and the prompts to the AI all read their labels from here, so
// they cannot disagree ("Speaker 3" in the export, "Speaker 2" on the screen).
//
// While a recording runs, voices are still being told apart, so an unnamed one is not shown (and not numbered) until it has
// said MIN_LINES substantive lines: a cough or a "yeah" does not make "Speaker 5". A voice somebody has named is shown from
// its first line. Anonymous numbers appear only when two voices are shown on the channel, so a one-to-one call stays "Them".
// Numbers follow the order voices were shown and never move afterwards. After the recording the voices are final: every one
// is shown, numbered by first appearance.
// A pure module: no database, no I/O. Ported from Cicada's SpeakerLabels (wquguru/cicada, SpeakerID.swift).

const MIN_LINES = 5;
const MIN_VOICES = 2;

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힣\u{20000}-\u{3ffff}]/gu;

// A line long enough to say whose voice it is: three words (with letters in them), or four Chinese, Japanese or Korean
// characters. "Yeah." or a stray "." can make a voice of their own; they do not count towards showing one.
function substantive(text) {
  const t = String(text || '');
  if (t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 3) return true;
  return (t.match(CJK) || []).length >= 4;
}

// 'me' (the first microphone voice), 'room' (other microphone voices), 'remote' (system audio, Discord people)
const kindOf = (id) => (id && id[0] === 'm' ? (Number(id.slice(1)) === 1 ? 'me' : 'room') : 'remote');

// rows: [{ speakerId, speaker ('me'|'them'), text, speakerName }] in time order (speakerName: the name the user gave or the
// saved voice's, '' when none). live: the note is being recorded right now.
// order: the voices already on show, in the order they were numbered (see displayFor). The map's `order` is the new one.
// -> Map(speakerId -> { kind, shown, named, numbered, n })   n: 1-based place among the shown voices of its kind, or null if hidden;
//    numbered: whether an anonymous voice gets "Speaker n" (false while it is the only one shown on its channel)
function displayMap(rows, { live = false, minLines = MIN_LINES, minVoices = MIN_VOICES, order = [] } = {}) {
  const info = new Map();
  rows.forEach((r, i) => {
    const id = r.speakerId;
    if (!id) return;
    let v = info.get(id);
    if (!v) { v = { kind: kindOf(id), named: false, lines: 0, first: i, reached: null, shown: false, n: null, numbered: true }; info.set(id, v); }
    if (r.speakerName) v.named = true;
    if (substantive(r.text)) v.lines++;
    if (v.reached === null) {
      if (v.kind === 'me' || r.speakerName || !live) v.reached = live ? i : v.first;
      else if (v.lines >= minLines) v.reached = i;
    }
  });
  // a name may arrive later than the first line: the voice is shown from the start of what it said
  for (const v of info.values()) {
    if (v.reached === null && v.named) v.reached = v.first;
    v.shown = v.reached !== null;
  }
  // Voices already on show keep their places in `order` (a voice named after it was first heard, or one that turns up with
  // enough lines at once, comes after them); the rest follow in the order they were shown
  const at = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
  const ranked = [];
  for (const kind of ['remote', 'room']) {
    const shown = [...info].filter(([, v]) => v.kind === kind && v.shown).sort(([a, x], [b, y]) => (at(a) - at(b)) || (x.reached - y.reached) || (x.first - y.first));
    shown.forEach(([id, v], k) => { v.n = k + 1; ranked.push(id); });
    // anonymous remote voices are numbered only when there are enough of them to need telling apart
    if (kind === 'remote' && shown.length < minVoices) for (const [, v] of shown) if (!v.named) v.numbered = false;
  }
  info.order = ranked;
  return info;
}

// What to call one line. -> { label (English, for exports and prompts), kind, n } where kind says how a screen should write it:
// 'name' | 'me' | 'speaker' (Speaker n) | 'room' (Room speaker n) | 'room-hidden' (Someone in the room) | 'them'
function describe(map, row, { userName = '' } = {}) {
  const me = { label: userName || 'Me', kind: 'me', n: null };
  const d = row.speakerId ? map.get(row.speakerId) : null;
  if (row.speakerName) return { label: row.speakerName, kind: 'name', n: d?.n ?? null };
  if (!d) return row.speaker === 'me' ? me : { label: 'Them', kind: 'them', n: null };
  if (d.kind === 'me') return me;
  if (d.kind === 'room') return d.shown ? { label: `Room speaker ${d.n + 1}`, kind: 'room', n: d.n + 1 } : { label: 'Someone in the room', kind: 'room-hidden', n: null };
  return d.shown && d.numbered ? { label: `Speaker ${d.n}`, kind: 'speaker', n: d.n } : { label: 'Them', kind: 'them', n: null };
}

// How a note's voices are shown now. While the note is being recorded (`live`: a Map noteId -> order, kept by the recording manager)
// the order voices were numbered in is remembered, so a number never moves once shown; otherwise it is just the lines.
function displayFor(rows, noteId, live) {
  const recording = !!live?.has(noteId);
  const map = displayMap(rows, { live: recording, order: recording ? live.get(noteId) : [] });
  if (recording) live.set(noteId, map.order);
  return map;
}

module.exports = { displayMap, displayFor, describe, substantive, MIN_LINES, MIN_VOICES };
