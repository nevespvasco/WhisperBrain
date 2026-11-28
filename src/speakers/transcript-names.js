'use strict';
// Names from what people say. Where nothing outside the audio says who a voice is (Zoom, Teams, a phone on speaker, an
// imported recording) the conversation often does: "I'm Maria", "Thanks, George". After a recording (and every so often during
// it: LiveNames) the AI reads the transcript, with the voices as tags, and says who is who; a name counts only when it quotes the line that shows it, the
// name is really written on that line or right beside it, and the voice it names talks right beside that line (two lines either side), so a name the AI
// made up (or copied from an example) is refused, and a name in an advert, a quote or a story about somebody else is not given to the wrong voice. Ported from Cicada's SpeakerNameGuess (wquguru/cicada, SpeakerID.swift).
//
// What this never does: replace a name somebody typed, overrule a voice already matched to a saved person (Speakers.nameFromMeeting
// answers 'kept' / 'conflict'), or save a voice print. A name from here is a guess that says so ('transcript:llm') and can be
// confirmed (it becomes the user's) or turned down (Speakers.rejectName). Pure functions plus one function that does the work.
const { neutralizeTags, speakerNamesMessages } = require('../llm/prompts');
const { fmtClock } = require('../core/notes');
const { nameKey } = require('../meet/protocol');
const { extractJson } = require('../llm/insights');
const { isThisComputer } = require('../core/policy');

const MAX_LINES = 400;     // the newest lines sent to the AI
const REACH = 2;           // how far from the evidence line the named voice may speak: "Okay, Amos, thank you" comes right after Amos
const SOURCE = 'transcript:llm';
const CONFIDENCE = 0.5;    // a guess from the words alone: shown as such

const isVoiceId = (id) => /^[ms]\d+$/.test(id || '');
const oneLine = (s) => neutralizeTags(String(s ?? '').replace(/\s+/g, ' ').trim());

// segments: [{ speaker, speakerId, startMs, text }] in time order; speakers: [{ speakerId, name }] (name: the user's or a saved voice's, '')
// -> { text, preface, lines: [{ n, speakerId, tag, startMs, text }], tags: Map(tag -> speakerId), counts: Map(speakerId -> lines),
//      eligible: Set(speakerId), userName } where eligible are the voices of other people that have no name yet
function buildTranscript(segments, speakers = [], { userName = '', max = MAX_LINES } = {}) {
  const named = new Map(speakers.filter((s) => s.name).map((s) => [s.speakerId, s.name]));
  const tagOf = (s) => (!s.speakerId ? (s.speaker === 'me' ? 'ME' : '?') : s.speakerId === 'm1' ? 'ME' : s.speakerId.toUpperCase());
  const counts = new Map();
  for (const s of segments) if (s.speakerId) counts.set(s.speakerId, (counts.get(s.speakerId) || 0) + 1);
  const lines = segments.slice(-max).map((s, i) => ({ n: i + 1, speakerId: s.speakerId || null, tag: tagOf(s), startMs: s.startMs, text: oneLine(s.text) }));
  const tags = new Map();
  for (const l of lines) if (l.speakerId) tags.set(l.tag, l.speakerId);
  const eligible = new Set([...tags.values()].filter((id) => isVoiceId(id) && id !== 'm1' && !named.has(id)));
  const known = [...tags].filter(([, id]) => named.has(id)).map(([tag, id]) => `${tag} = ${oneLine(named.get(id))}`);
  const preface = [`ME is the user${userName ? ` (${oneLine(userName)})` : ''}.`, known.length ? `Already named, do not name again: ${known.join(', ')}.` : ''].filter(Boolean).join(' ');
  return { text: lines.map((l) => `[L${l.n} ${fmtClock(l.startMs)} ${l.tag}] ${l.text}`).join('\n'), preface, lines, tags, counts, eligible, userName };
}

// A name that could be somebody's: letters, spaces, a hyphen, an apostrophe, a full stop; not a label the AI made up.
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]{0,78}$/u;
const GENERIC = /^(speaker|unknown|unidentified|them|me|you|someone|somebody|host|guest|participant|user|the user|other|person)\b/i;
function cleanName(raw) {
  const n = String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return NAME.test(n) && !GENERIC.test(n) && !/^[a-z]\d{1,3}$/i.test(n) ? n : '';
}

// Is the name written on the evidence line or within REACH of it? Speech recognition spells names by ear and the AI may write a
// public figure as the news does, so a word one letter off (two in a long word) still counts: "Powel" is "Powell", "Jose" is
// "José". Little words of a full name ("da", "de", "van") are not enough on their own: one word of the name that matters must be there.
const words = (s) => nameKey(s).split(' ').filter(Boolean);
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function sameWord(a, b) {
  if (a === b) return true;
  const slack = a.length >= 8 ? 2 : a.length >= 5 ? 1 : 0;
  return slack > 0 && Math.abs(a.length - b.length) <= slack && editDistance(a, b) <= slack;
}
function saidNear(name, built, line) {
  const heard = new Set(built.lines.filter((l) => Math.abs(l.n - line.n) <= REACH).flatMap((l) => words(l.text)));
  const all = words(name);
  const key = all.filter((w) => w.length >= 3);
  return (key.length ? key : all).some((w) => [...heard].some((h) => sameWord(w, h)));
}

// "Nimu, is this appropriate?", "thanks, Sav", "Powell said so": a name a voice says itself is the person it talks to or about. So when every line near the
// evidence that says the name is the named voice's own line, the name counts only if one of them introduces it ("I'm Nimu",
// "my name is Nimu", "eu sou a Inês", "Nimu here"). Matched on nameKey words, so "I'm" is "i m".
const INTRO_BEFORE = /(?:^| )(?:i m|i am|im|my name is|my name s|name s|this is|it s|call me|eu sou|eu sou o|eu sou a|sou o|sou a|chamo me|o meu nome e|meu nome e|aqui e|aqui fala|fala o|fala a)$/;
const INTRO_AFTER = /^(?:here|speaking|aqui|a falar)(?: |$)/;
function introduces(text, name) {
  const toks = words(text);
  const key = words(name).filter((w) => w.length >= 3);
  const want = key.length ? key : words(name);
  for (let i = 0; i < toks.length; i++) {
    if (!want.some((w) => sameWord(w, toks[i]))) continue;
    if (INTRO_BEFORE.test(toks.slice(Math.max(0, i - 4), i).join(' '))) return true;
    let j = i + 1;
    while (j < toks.length && want.some((w) => sameWord(w, toks[j]))) j++;   // past the rest of a full name
    if (INTRO_AFTER.test(toks.slice(j, j + 2).join(' '))) return true;
  }
  return false;
}
function onlyAddressed(name, built, line, speakerId) {
  const key = words(name).filter((w) => w.length >= 3);
  const want = key.length ? key : words(name);
  const says = built.lines.filter((l) => Math.abs(l.n - line.n) <= REACH && words(l.text).some((h) => want.some((w) => sameWord(w, h))));
  return says.length > 0 && says.every((l) => l.speakerId === speakerId && !introduces(l.text, name));
}

// reply: what the AI said. built: buildTranscript's result. skip: [{ speakerId, name }] names somebody turned down for a voice.
// -> { found: [{ speakerId, name, line, startMs, quote }], refuted: [{ speakerId, name, reason }] }
// refuted: names nobody said near the line given (reason 'not-said'), names the voice only says itself without introducing itself ('addressed': it
// is talking to that person), or given for a voice on a line it neither said nor spoke beside; found: the ones that stand.
function parseNames(reply, built, { skip = [] } = {}) {
  const out = { found: [], refuted: [] };
  const list = extractJson(reply)?.speakers;
  if (!Array.isArray(list)) return out;
  const turnedDown = new Set(skip.map((s) => `${s.speakerId}|${nameKey(s.name)}`));
  const me = nameKey(built.userName); // the user is ME: nobody else is called that
  const byVoice = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const speakerId = built.tags.get(String(item.speaker ?? '').trim().toUpperCase());
    const name = cleanName(item.name);
    if (!speakerId || !built.eligible.has(speakerId) || !name || (me && nameKey(name) === me) || byVoice.has(speakerId)) continue;
    if (turnedDown.has(`${speakerId}|${nameKey(name)}`)) continue;
    const digits = String(item.evidence ?? '').match(/\d+/);
    const line = digits ? built.lines[Number(digits[0]) - 1] : null;
    const near = line ? built.lines.filter((l) => Math.abs(l.n - line.n) <= REACH && l.speakerId === speakerId) : [];
    if (!line || !near.length) { out.refuted.push({ speakerId, name, reason: line ? 'far' : 'no-line' }); continue; }
    if (!saidNear(name, built, line)) { out.refuted.push({ speakerId, name, reason: 'not-said' }); continue; }
    if (onlyAddressed(name, built, line, speakerId)) { out.refuted.push({ speakerId, name, reason: 'addressed' }); continue; }
    byVoice.set(speakerId, { speakerId, name, line: line.n, startMs: line.startMs, quote: line.text.slice(0, 120) });
  }
  // two people rarely share a name in one meeting: a name given to two voices goes to the one with more lines
  const best = new Map();
  for (const f of byVoice.values()) {
    const k = nameKey(f.name), cur = best.get(k);
    if (!cur || (built.counts.get(f.speakerId) || 0) > (built.counts.get(cur.speakerId) || 0)) best.set(k, f);
  }
  out.found = [...byVoice.values()].filter((f) => best.get(nameKey(f.name)) === f);
  return out;
}

// Ask the AI for the names of a note's unnamed voices and give them to the voices. Best effort: no AI, an AI that fails, a meeting
// with nobody to name: nothing happens (an `error` says why when it failed).
// deps: { notes, speakers, evidence, llm ({ complete }), userName, signal, max (newest lines to send) }. -> { named: [{ speakerId, name, line, quote }], refuted, error? }
async function nameFromTranscript({ notes, speakers, evidence, llm, userName = '', signal, max = MAX_LINES }, noteId) {
  const none = { named: [], refuted: [] };
  if (!llm) return none;
  const segs = notes.segments(noteId);
  if (!segs.length) return none;
  const list = speakers.forNote(noteId).map((s) => ({ speakerId: s.speakerId, name: s.name || s.voiceName || '' }));
  const built = buildTranscript(segs, list, { userName, max });
  if (!built.eligible.size) return none;
  const skip = (evidence?.forNote(noteId, { kind: 'refuted' }) || []).map((r) => ({ speakerId: r.meta?.speakerId, name: r.name }));
  let reply;
  try { reply = await llm.complete(speakerNamesMessages(built), { temperature: 0.1, maxTokens: 400, signal, reasoning: 'off' }); } catch (e) { return { ...none, error: e.message }; }
  const { found, refuted } = parseNames(reply, built, { skip });
  const named = [];
  for (const f of found) {
    const r = speakers.nameFromMeeting(noteId, f.speakerId, f.name, { source: SOURCE, confidence: CONFIDENCE });
    if (r === 'named' || r === 'agrees') named.push(f);
  }
  if (named.length && evidence) {
    const again = new Set(named.map((f) => f.speakerId));
    const kept = evidence.forNote(noteId, { kind: 'mention' }).filter((r) => !again.has(r.meta?.speakerId));
    evidence.replace(noteId, ['mention'], [...kept, ...named.map((f) => ({ kind: 'mention', source: 'llm', key: nameKey(f.name), name: f.name, t0: f.startMs, weight: CONFIDENCE, meta: { speakerId: f.speakerId, line: f.line, quote: f.quote } }))]);
  }
  return { named, refuted };
}

// Does the AI server run on this computer? (a transcript sent to it does not leave the machine). The one rule of policy.js; no
// server at all is not a server on this computer here.
function isLocalServer(url) { return !!String(url || '').trim() && isThisComputer(url); }

// While the meeting is still going: the same question, asked again every so often about the voices that have no name yet, so
// "I'm Maria" at minute two puts a name on the screen at minute three. A pass costs one AI request, so it waits until there are
// enough new lines and enough time since the last one; it asks only about the newest lines; it never holds up anything else (the
// AI queue serves translation and the assistant first); and a pass that fails is not retried at once. The names are the same
// guesses as after Stop: turned down or typed over by the user, never saved as a voice print. Stop runs the full pass again for
// the voices still without a name.
const LIVE_EVERY_LINES = 6;     // new lines since the last pass
const LIVE_MIN_GAP_MS = 45000;  // and at least this long since it started
const LIVE_MAX_LINES = 120;     // the newest lines sent: the cost of a pass does not grow with the meeting
const LIVE_TIMEOUT_MS = 60000;
const LIVE_MAX_FAILURES = 3;    // then this recording is left alone until Stop

class LiveNames {
  // deps: { notes, speakers, evidence, llm, bus, allowed ((noteId) -> whether the settings, the AI server and the meeting's source permit it), userName (() -> the user's name), now }
  constructor({ notes, speakers, evidence = null, llm, bus, allowed = () => true, userName = () => '', now = Date.now }) {
    Object.assign(this, { notes, speakers, evidence, llm, bus, allowed, userName, now });
    this.run = null;   // the recording being followed: { noteId, fresh, last, busy, failures, abort }
  }

  attach() {
    return this.bus.subscribe((e) => {
      if (e.type === 'recording.started') this.start(e.data.noteId);
      else if (e.type === 'recording.stopped') this.stop(e.data.noteId);
      else if (e.type === 'transcript.segment') this.hear(e.data.noteId, e.data.segment);
    });
  }

  start(noteId) { this.stop(); this.run = { noteId, fresh: 0, last: this.now(), busy: false, failures: 0, abort: new AbortController() }; }

  stop(noteId) {
    if (!this.run || (noteId && this.run.noteId !== noteId)) return;
    this.run.abort.abort();
    this.run = null;
  }

  // A line was saved. -> a promise when a pass was started (for tests; the caller need not wait for it)
  hear(noteId, segment) {
    const r = this.run;
    if (!r || r.noteId !== noteId || !segment?.text) return null;
    r.fresh++;
    if (r.busy || r.failures >= LIVE_MAX_FAILURES || r.fresh < LIVE_EVERY_LINES || this.now() - r.last < LIVE_MIN_GAP_MS) return null;
    if (!this.allowed(noteId)) return null;
    return this.pass(r);
  }

  async pass(r) {
    r.busy = true;
    r.fresh = 0;
    r.last = this.now();
    try {
      const signal = AbortSignal.any([r.abort.signal, AbortSignal.timeout(LIVE_TIMEOUT_MS)]);
      const out = await nameFromTranscript({ notes: this.notes, speakers: this.speakers, evidence: this.evidence, llm: this.llm, userName: this.userName(), signal, max: LIVE_MAX_LINES }, r.noteId);
      if (out.error) throw new Error(out.error);
      r.failures = 0;
      return out;
    } catch (err) {
      if (r.abort.signal.aborted) return null;   // Stop came first: nothing to report
      r.failures++;
      if (r.failures === LIVE_MAX_FAILURES) this.bus.publish('recording.warning', { message: `names from the conversation: ${err.message}` });
      return null;
    } finally { r.busy = false; }
  }
}

module.exports = { buildTranscript, parseNames, nameFromTranscript, isLocalServer, LiveNames, SOURCE, CONFIDENCE, REACH, LIVE_EVERY_LINES, LIVE_MIN_GAP_MS, LIVE_MAX_LINES };
