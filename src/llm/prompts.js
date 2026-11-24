'use strict';
const { fmtClock, speakerLabel } = require('../core/notes');

const SUMMARY_SYSTEM = `You turn a meeting into clear, accurate notes.
Rules:
- The user's own typed notes (<user_notes>) are the backbone: keep every point they made, in their order of importance, and enrich them with details from the transcript.
- Use only information present in the notes or the transcript. Never invent names, numbers, dates or decisions. If something is unclear, leave it out.
- The transcript labels who spoke: "Me" (or the user's name) is the user; "Them" or "Speaker N" are other participants, or their names when known. Attribute statements and action items to the right person.
- Write in the language the meeting was held in, unless the template says otherwise.
- Output Markdown only. Start directly with the content, no preamble and no closing remarks.`;

function formatTranscript(segments) {
  return segments.map((s) => `[${fmtClock(s.startMs)}] ${s.label || speakerLabel(s.speaker)}: ${s.text}`).join('\n');
}

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > maxChars && cur) { chunks.push(cur); cur = ''; }
    if (line.length > maxChars) { // a single enormous line: hard split
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function meetingHeader(note) {
  const parts = [`Title: ${note.title || '(untitled)'}`, `Date: ${new Date(note.startedAt || note.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`];
  if (note.attendees?.length) parts.push(`Attendees: ${note.attendees.map((a) => a.name || a.email).join(', ')}`);
  return parts.join('\n');
}

function summaryMessages({ note, transcript, template, userName }) {
  const user = [
    meetingHeader(note),
    userName ? `The user is ${userName} ("Me").` : '',
    '',
    `<template>\n${template.prompt}\n</template>`,
    '',
    `<user_notes>\n${note.body.trim() || '(the user typed no notes)'}\n</user_notes>`,
    '',
    `<transcript>\n${transcript || '(no transcript)'}\n</transcript>`,
  ].filter((l) => l !== null).join('\n');
  return [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: user }];
}

function partialMessages({ chunk, index, total }) {
  return [
    { role: 'system', content: 'You extract faithful, dense bullet-point notes from part of a meeting transcript. Keep facts, decisions, numbers, names, owners and open questions. No invention, no preamble. Same language as the transcript.' },
    { role: 'user', content: `Part ${index + 1} of ${total} of the transcript:\n\n${chunk}` },
  ];
}

function titleMessages({ note, summary, transcript }) {
  const basis = (summary || note.body || transcript || '').slice(0, 3000);
  return [
    { role: 'system', content: 'You write short, specific meeting titles: at most 7 words, no quotes, no trailing period, same language as the content. Reply with the title only.' },
    { role: 'user', content: basis },
  ];
}

const CHAT_SYSTEM = `You are a research assistant over the user's meeting notes and transcripts.
- Answer only from the provided context. If the answer is not there, say so plainly.
- Be concise. Quote short phrases when useful and say who said it (Me / Them) and roughly when ([m:ss]).
- When context comes from several meetings, name the meeting title for each claim.
- Reply in the language of the user's question.`;

module.exports = { SUMMARY_SYSTEM, CHAT_SYSTEM, formatTranscript, chunkText, summaryMessages, partialMessages, titleMessages, meetingHeader };
