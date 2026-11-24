'use strict';
// How many voices to expect on a channel, from the calendar event's attendee list. The after-recording clustering
// over-splits one person and merges two similar ones; knowing the head count removes most of that. It is only a
// hint: people invited do not always come, and guests join uninvited, so it is used for small meetings only and the
// result is checked (see final.js).

const MAX_HEADS = 6;  // beyond this nobody can say how many of the invited actually speak

const person = (a) => (typeof a === 'string' ? { name: a } : a || {});

// -> the number of attendees who can be expected to be on the call, or 0 when the list says nothing
function headCount(attendees) {
  const seen = new Set();
  for (const raw of attendees || []) {
    const a = person(raw);
    if (String(a.status || '').toUpperCase() === 'DECLINED') continue;
    const key = String(a.email || a.name || '').trim().toLowerCase();
    if (key) seen.add(key);
  }
  return seen.size;
}

// channel: 'mic' | 'system'. The microphone carries the user (and anyone in the room with them): no hint there.
// The system audio carries everyone else on the call: the attendees minus the user. -> a count, or null (no hint)
function expectedSpeakers({ attendees, channel }) {
  if (channel !== 'system') return null;
  const heads = headCount(attendees);
  if (heads < 2 || heads > MAX_HEADS) return null;
  return heads - 1;
}

module.exports = { expectedSpeakers, headCount, MAX_HEADS };
