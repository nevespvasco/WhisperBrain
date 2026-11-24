'use strict';
// Names from what people say. Where nothing outside the audio says who a voice is (Zoom, Teams, a phone on speaker, an
// imported recording) the conversation often does: "I'm Maria", "Thanks, George". After a recording the AI reads the
// transcript, with the voices as tags, and says who is who; a name counts only when it quotes the line that shows it and the
// voice it names talks right beside that line (two lines either side), so a name in an advert, a quote or a story about
// somebody else is not given to the wrong voice. Ported from Cicada's SpeakerNameGuess (wquguru/cicada, SpeakerID.swift).
//
// What this never does: replace a name somebody typed, overrule a voice already matched to a saved person (Speakers.nameFromMeeting
// answers 'kept' / 'conflict'), or save a voice print. A name from here is a guess that says so ('transcript:llm') and can be
// confirmed (it becomes the user's) or turned down (Speakers.rejectName). Pure functions plus one function that does the work.
const { neutralizeTags, speakerNamesMessages } = require('../llm/prompts');
const { fmtClock } = require('../core/notes');
const { nameKey } = require('../meet/protocol');
const { extractJson } = require('../llm/insights');

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

// reply: what the AI said. built: buildTranscript's result. skip: [{ speakerId, name }] names somebody turned down for a voice.
// -> { found: [{ speakerId, name, line, startMs, quote }], refuted: [{ speakerId, name, reason }] }
// refuted: names given for a voice on a line it neither said nor spoke beside; found: the ones that stand.
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
// deps: { notes, speakers, evidence, llm ({ complete }), userName, signal }. -> { named: [{ speakerId, name, line, quote }], refuted, error? }
async function nameFromTranscript({ notes, speakers, evidence, llm, userName = '', signal }, noteId) {
  const none = { named: [], refuted: [] };
  if (!llm) return none;
  const segs = notes.segments(noteId);
  if (!segs.length) return none;
  const list = speakers.forNote(noteId).map((s) => ({ speakerId: s.speakerId, name: s.name || s.voiceName || '' }));
  const built = buildTranscript(segs, list, { userName });
  if (!built.eligible.size) return none;
  const skip = (evidence?.forNote(noteId, { kind: 'refuted' }) || []).map((r) => ({ speakerId: r.meta?.speakerId, name: r.name }));
  let reply;
  try { reply = await llm.complete(speakerNamesMessages(built), { temperature: 0.1, maxTokens: 400, signal }); } catch (e) { return { ...none, error: e.message }; }
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

// Does the AI server run on this computer? (a transcript sent to it does not leave the machine)
function isLocalServer(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

module.exports = { buildTranscript, parseNames, nameFromTranscript, isLocalServer, SOURCE, CONFIDENCE, REACH };
