'use strict';
// "Attach the platform's transcript to this note": a Teams / Zoom / Meet export (.vtt, .srt, .docx, ...) is matched to what was
// recorded (reconcile.js), kept as evidence, and the voices are named again from all the evidence (rename.js).
const { parseFile } = require('../importers');
const { reconcileTranscript } = require('./reconcile');
const { renameFromEvidence } = require('./rename');
const { nameKey } = require('./protocol');

const fail = (message, status) => Object.assign(new Error(message), { status });

function attachTranscript({ notes, speakers, evidence, settings }, noteId, buffer, filename = '') {
  const utterances = notes.segmentWords(noteId);
  if (!utterances.length) throw fail('This meeting has not been recorded: there is nothing to match the transcript with.', 409);
  let meetings;
  try { meetings = parseFile(buffer, filename, { me: settings.get('userName') }); } catch (e) { throw fail(e.message, 400); }
  const segments = meetings.map((m) => m.segments).sort((a, b) => b.length - a.length)[0] || [];
  const platform = segments.map((s) => ({ label: s.label, startMs: s.startMs, endMs: s.endMs, text: s.text }));
  const r = reconcileTranscript({ platform, utterances });
  if (!r.ok) throw fail(r.reason, 422);

  evidence.clear(noteId, { kinds: ['transcript'] });
  const ext = (String(filename).split('.').pop() || 'file').toLowerCase();
  evidence.add(noteId, r.matches.map((m) => ({ kind: 'transcript', source: ext, key: nameKey(m.name), name: m.name, t0: m.startMs, t1: m.endMs, weight: m.score, meta: { utteranceId: m.id, offsetMs: r.offsetMs } })));
  const renamed = renameFromEvidence({ notes, speakers, evidence, noteId, selfNames: [settings.get('userName')].filter(Boolean) });
  notes.reindex(noteId);
  return { offsetMs: r.offsetMs, support: r.support, matched: r.matches.length, ...renamed };
}

module.exports = { attachTranscript };
