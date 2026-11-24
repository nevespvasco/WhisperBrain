'use strict';
// The words a meeting is likely to say that a speech model gets wrong: people's names, company and product terms.
// Gathered from what the app already knows about the meeting and handed to the recognizer as hotwords (hotwords.js).
const { meetingTerms } = require('./hotwords');

const MAX_VOICES = 15;   // saved voice profiles to consider, those heard in the most meetings first
const MAX_GLOSSARY = 25; // glossary terms to consider: this note's, then ones the user wrote, then recent automatic ones

// "ana.silva@acme.com" -> "Ana Silva": an attendee with no display name is still somebody the others will say aloud.
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  const words = local.split(/[._-]+/).filter((w) => /^\p{L}{2,}$/u.test(w));
  return words.length && words.length === local.split(/[._-]+/).length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : '';
}

// notes, speakers, knowledge and settings are the app's own stores; any of them may be missing.
function termsForNote({ notes, speakers, knowledge, settings }, noteId) {
  const note = notes?.get(noteId);
  if (!note) return [];
  const attendees = (note.attendees || []).map((a) => (typeof a === 'string' ? a : a?.name || nameFromEmail(a?.email)));
  const speakerNames = [];
  try {
    for (const s of speakers?.forNote(noteId) || []) speakerNames.push(s.name || s.voiceName || '');
    const voices = (speakers?.publicVoices() || []).sort((a, b) => b.meetings - a.meetings).slice(0, MAX_VOICES);
    for (const v of voices) speakerNames.push(v.name);
  } catch { /* speakers are optional */ }
  const glossary = [];
  try {
    const own = knowledge?.termsInNote(noteId) || [];
    const all = knowledge?.glossary() || [];
    const written = all.filter((g) => !g.auto);
    const recent = all.filter((g) => g.auto).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const g of [...own, ...written, ...recent]) glossary.push(g.term);
  } catch { /* the glossary is optional */ }
  return meetingTerms({ attendees, speakerNames, glossary: glossary.slice(0, MAX_GLOSSARY), userName: settings?.get('userName') || '' });
}

module.exports = { termsForNote, nameFromEmail };
