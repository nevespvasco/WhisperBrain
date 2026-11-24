#!/usr/bin/env node
'use strict';
// How late does each source show who is speaking? From the evidence WhisperBrain keeps about every recorded meeting (the
// highlights and captions of the meeting window, the speech of each voice), per platform and source:
//   estimated lag   the delay the aligner finds from the data (src/meet/names.js estimateLag)
//   onset           how long after a person started speaking their name lit up (p50 / p90 over every turn that has one)
//   caption         how long after a person started speaking their caption showed the words (p50 / p90)
// Naming happens once, when the recording stops: how long that takes is in the `recording.meet-names` event (tookMs).
//
//   node eval/latency.js --db ~/.config/WhisperBrain/whisperbrain.sqlite [--json]
// Real numbers need real calls: record a few meetings on each platform, then run this on the database. Results go in the table
// at the end of this file's section in eval/README.md.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Notes } = require('../src/core/notes');
const { Evidence } = require('../src/meet/evidence');
const { estimateLag, speechOf } = require('../src/meet/names');
const { tokens, containment } = require('../src/meet/captions');

// the p-th percentile (linear interpolation), null for nothing
function percentile(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const at = (p / 100) * (s.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (at - lo));
}
const stats = (list) => ({ n: list.length, p50: percentile(list, 50), p90: percentile(list, 90) });

const ONSET_BEFORE = 500, ONSET_AFTER = 5000;   // a highlight belongs to a speech onset when it arrives within this window of it

// -> [{ platform, source, meetings, estimatedLagMs, onset: { n, p50, p90 }, caption: { n, p50, p90 } }]
function latencyReport(db) {
  const notes = new Notes(db, null), evidence = new Evidence(db);
  const groups = new Map();   // platform|source -> { platform, source, meetings, lags: [], onsets: [], captions: [] }
  const group = (platform, source) => {
    const k = `${platform}|${source}`;
    if (!groups.has(k)) groups.set(k, { platform, source, meetings: 0, lags: [], onsets: [], captions: [] });
    return groups.get(k);
  };
  for (const { id } of db.prepare('SELECT DISTINCT note_id AS id FROM evidence WHERE kind IN (\'highlight\', \'caption\')').all()) {
    const note = notes.get(id);
    if (!note) continue;
    const platform = note.platform || 'unknown';
    const utterances = notes.segmentWords(id).filter((u) => u.speaker === 'them' && u.speakerId);
    const speech = speechOf(utterances);
    const voiceOf = new Map(db.prepare("SELECT speaker_id AS id, name FROM note_speakers WHERE note_id = ? AND name != ''").all(id).map((r) => [r.name.toLowerCase(), r.id]));
    const rows = evidence.forNote(id);

    const bySource = new Map();
    for (const r of rows.filter((x) => x.kind === 'highlight')) { if (!bySource.has(r.source)) bySource.set(r.source, []); bySource.get(r.source).push(r); }
    for (const [source, list] of bySource) {
      const g = group(platform, source);
      g.meetings++;
      g.lags.push(estimateLag({ raw: list.map((r) => ({ startMs: r.t0, endMs: r.t1, name: r.name })), speech, prior: list[0].meta?.lagMs ?? 500 }));
      for (const r of list) {
        const voice = voiceOf.get(r.name.toLowerCase());
        const onsets = (speech.get(voice) || []).map(([s]) => s).filter((s) => r.t0 >= s - ONSET_BEFORE && r.t0 - s <= ONSET_AFTER);
        if (onsets.length) g.onsets.push(r.t0 - Math.max(...onsets));
      }
    }
    const caps = rows.filter((x) => x.kind === 'caption');
    if (caps.length) {
      const sources = [...new Set(caps.map((c) => c.source))];
      for (const source of sources) {
        const g = group(platform, source);
        g.meetings++;
        for (const u of utterances) {
          const ut = tokens(u.text);
          if (ut.length < 3) continue;
          const voiceName = [...voiceOf].find(([, v]) => v === u.speakerId)?.[0];
          const first = caps.filter((c) => c.source === source && c.name.toLowerCase() === voiceName && c.t0 >= u.startMs - 1500 && c.t0 <= u.endMs + 7000 && containment(tokens(c.meta?.text || ''), ut) >= 0.5)
            .sort((a, b) => a.t0 - b.t0)[0];
          if (first) g.captions.push(first.t0 - u.startMs);
        }
      }
    }
  }
  return [...groups.values()].map((g) => ({
    platform: g.platform, source: g.source, meetings: g.meetings,
    estimatedLagMs: g.lags.length ? percentile(g.lags, 50) : null, onset: stats(g.onsets), caption: stats(g.captions),
  })).sort((a, b) => a.platform.localeCompare(b.platform) || a.source.localeCompare(b.source));
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const file = arg('db', '');
  if (!file) { console.error('usage: node eval/latency.js --db <path to whisperbrain.sqlite> [--json]\n(the app keeps it in its data folder, e.g. ~/.config/WhisperBrain/ on Linux)'); process.exit(64); }
  const db = new DatabaseSync(path.resolve(file), { readOnly: true });
  const rows = latencyReport(db);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else if (!rows.length) console.log('no meeting window evidence in this database: record a call with the extension or accessibility reader on first');
  else {
    console.log('platform'.padEnd(10), 'source'.padEnd(11), 'calls', 'est.lag', 'onset p50/p90 (n)', 'caption p50/p90 (n)');
    const f = (s) => (s.n ? `${s.p50}/${s.p90} (${s.n})` : '-');
    for (const r of rows) console.log(r.platform.padEnd(10), r.source.padEnd(11), String(r.meetings).padStart(5), String(r.estimatedLagMs ?? '-').padStart(7), f(r.onset).padEnd(17), f(r.caption));
  }
}

module.exports = { latencyReport, percentile };
