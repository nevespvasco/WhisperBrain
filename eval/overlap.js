#!/usr/bin/env node
'use strict';
// Overlap-aware second pass, measured offline. Takes the final words of a normal eval run (eval/run.js --dump), the
// diarization of the channel (.eval/cache, written by eval/offline.js / eval/run.js) and the transcribed separated
// streams of the overlap regions (eval/separate.py + eval/sep-asr.js), merges the words the mix ASR never wrote and
// scores before vs after.
//
//   node eval/run.js --only ami-IS1009a --configs diarize+refine --dump dump   (final words of the normal pipeline)
//   node eval/overlap.js --write-regions regions.json                            (needs the eval/offline.js diarization cache)
//   python eval/separate.py cv:MossFormer2_SS_16K .eval/data/ami-IS1009a/system.wav regions.json sep/mf2-D --key D --savedir cvwork
//   node eval/sep-asr.js sep/mf2-D
//   node eval/overlap.js --base dump/ami-IS1009a.diarize+refine.json --sep sep/mf2-D [--who heard|turn|embedding] [--voices v.json] [--mode add|replace]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalize, score } = require('./metrics');
const { cosine } = require('../src/speakers/cluster');
const { parseWav } = require('../src/audio/pcm');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cacheFile = (k) => path.join(ROOT, '.eval', 'cache', `${crypto.createHash('sha1').update(k).digest('hex').slice(0, 16)}.json`);
const mid = (w) => (w.start + w.end) / 2;
const TOL = Number(opt('--tol', 0.6)); // seconds: a separated word this close to the same mix word is that word

// Speech stretches per speaker (words closer than `gap` joined) and the times where two or more overlap.
function stretches(words, gap = 0.3) {
  const by = new Map();
  for (const w of words) { if (!by.has(w.speaker)) by.set(w.speaker, []); by.get(w.speaker).push([w.start, w.end]); }
  return [...by.values()].map((a) => {
    a.sort((x, y) => x[0] - y[0]);
    const m = [];
    for (const [s, e] of a) { if (m.length && s - m[m.length - 1][1] < gap) m[m.length - 1][1] = Math.max(m[m.length - 1][1], e); else m.push([s, e]); }
    return m;
  });
}
function overlaps(groups) {
  const ev = [];
  for (const g of groups) for (const [s, e] of g) ev.push([s, 1], [e, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  let c = 0, at = 0;
  for (const [t, d] of ev) { const p = c; c += d; if (p < 2 && c >= 2) at = t; if (p >= 2 && c < 2) out.push([at, t]); }
  return out;
}
const inside = (t, regs) => regs.some(([s, e]) => t >= s && t <= e);

// One-to-one matching of reference words to hypothesis words with the same token within `tol` seconds.
// sameSpeaker(refSpeaker, hypSpeaker) optionally restricts pairs (speaker-attributed recall).
function matchCount(ref, hyp, tol = 1, sameSpeaker = null) {
  const used = new Uint8Array(hyp.length);
  let hit = 0;
  for (const r of ref) {
    let best = -1, bd = tol;
    for (let j = 0; j < hyp.length; j++) {
      const h = hyp[j];
      if (used[j] || h.word !== r.word || (sameSpeaker && !sameSpeaker(r.speaker, h.speaker))) continue;
      const d = Math.abs(mid(h) - mid(r));
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0) { used[best] = 1; hit++; }
  }
  return hit;
}

function merge(base, regions, dz, { mode = 'add', who = 'heard', finalVoices = null } = {}) {
  // diarization cluster -> final speaker of the base run, by the words each cluster's turns hold
  const votes = new Map();
  for (const w of base) for (const t of dz.turns) if (mid(w) >= t.start && mid(w) <= t.end) {
    const k = `${t.speaker}|${w.speaker}`; votes.set(k, (votes.get(k) || 0) + 1);
  }
  const clusterTo = new Map();
  for (const v of dz.voices) {
    let best = null, n = 0;
    for (const [k, c] of votes) { const [cl, sp] = k.split('|'); if (Number(cl) === v.speaker && c > n) { n = c; best = sp; } }
    if (best) clusterTo.set(v.speaker, best);
  }
  let voices = dz.voices.filter((v) => v.centroid && clusterTo.has(v.speaker));
  if (finalVoices) { // voice prints of the final speakers themselves (eval/final-voices.js)
    voices = Object.entries(finalVoices).map(([sp, c], k) => ({ speaker: `f${k}`, centroid: c }));
    voices.forEach((v, k) => clusterTo.set(v.speaker, Object.keys(finalVoices)[k]));
  }
  let out = base.slice();
  const added = [];
  for (const r of regions) {
    const inR = (w) => mid(w) >= r.start && mid(w) <= r.end;
    const B = normalize(out.filter(inR));
    const S = r.streams.map((s) => normalize(s.words.map((w) => ({ ...w, speaker: 'x' }))));
    if (S.length < 2) continue;
    const m = S.map((ws) => matchCount(ws, B, TOL));
    const dom = m[0] === m[1] ? (S[0].length >= S[1].length ? 0 : 1) : (m[0] > m[1] ? 0 : 1);
    const sec = 1 - dom;
    // who the dominant speaker is in this region (most base words), and the voice of the secondary stream
    const cnt = new Map();
    for (const w of B) cnt.set(w.speaker, (cnt.get(w.speaker) || 0) + 1);
    const domSpk = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0];
    const e = r.streams[sec].embedding;
    const ranked = e ? voices.map((v) => [clusterTo.get(v.speaker), cosine(e, v.centroid)]).sort((a, b) => b[1] - a[1]) : [];
    // speakers the diarization heard in this region: the second voice is one of them (unless --who embedding)
    const heard = new Set(dz.turns.filter((t) => t.start < r.end && t.end > r.start).map((t) => clusterTo.get(t.speaker)).filter(Boolean));
    heard.delete(domSpk);
    const pick = (who !== 'embedding' && heard.size === 1) ? [[...heard][0]] : ranked.find(([sp]) => sp !== domSpk && (who === 'embedding' || !heard.size || heard.has(sp)));
    if (!pick) continue;
    const secSpk = pick[0];
    // the secondary stream's words that the mix ASR never wrote
    const usedB = new Uint8Array(B.length);
    const fresh = [];
    for (const w of S[sec]) {
      let hit = -1;
      for (let j = 0; j < B.length; j++) if (!usedB[j] && B[j].word === w.word && Math.abs(mid(B[j]) - mid(w)) < TOL) { hit = j; break; }
      if (hit >= 0) { usedB[hit] = 1; continue; }
      let spk = secSpk;
      if (who === 'turn') {
        // per word: a voice the diarization hears at this moment that is not the one the mix words already belong to
        const t = mid(w);
        const now = new Set(dz.turns.filter((x) => x.start - 0.2 <= t && x.end + 0.2 >= t).map((x) => clusterTo.get(x.speaker)).filter(Boolean));
        for (const b of B) if (Math.abs(mid(b) - t) < 0.5) now.delete(b.speaker);
        if (now.size === 1) spk = [...now][0];
        else if (now.size > 1) spk = ranked.find(([sp]) => now.has(sp))?.[0] ?? secSpk;
      }
      fresh.push({ ...w, speaker: spk, region: r.start });
    }
    if (mode === 'replace' && domSpk) {
      // the dominant speaker's words in the region come from its separated stream instead of the mix
      out = out.filter((w) => !(inR(w) && w.speaker === domSpk)).concat(S[dom].map((w) => ({ ...w, speaker: domSpk })));
    }
    out.push(...fresh);
    added.push(...fresh);
  }
  return { words: out.sort((a, b) => a.start - b.start), added };
}

function report(label, refN, hypN, R) {
  const s = score(refN, hypN);
  const refIn = refN.filter((w) => inside(mid(w), R));
  const anyRec = matchCount(refIn, hypN, 1) / refIn.length;
  return { label, wer: s.wer, wder: s.wder, cpwer: s.cpwer, tcpwer: s.tcpwer, recallOverlap: anyRec, recallAll: matchCount(refN, hypN, 1) / refN.length, hypWords: hypN.length };
}

if (require.main === module) {
  const name = opt('--rec', 'ami-IS1009a');
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, '.eval', 'data', name, 'ref.json'), 'utf8'));
  const samples = 2 * parseWav(fs.readFileSync(path.join(ROOT, '.eval', 'data', name, 'system.wav'))).samples.length; // eval/offline.js keys its cache by the PCM byte length
  const dz = JSON.parse(fs.readFileSync(cacheFile(opt('--dz', `dz:${name}:system:0:${samples}:0.6:0:0.1`)), 'utf8'));
  if (opt('--write-regions')) { // the input of eval/separate.py: R = overlap in the reference (oracle), D = overlap the diarization found
    const by = new Map();
    for (const t of dz.turns) { if (!by.has(t.speaker)) by.set(t.speaker, []); by.get(t.speaker).push([t.start, t.end]); }
    fs.writeFileSync(opt('--write-regions'), JSON.stringify({ R: overlaps(stretches(rec.words)), D: overlaps([...by.values()]) }));
    process.exit(0);
  }
  const base = JSON.parse(fs.readFileSync(opt('--base'), 'utf8'));
  const regions = JSON.parse(fs.readFileSync(path.join(opt('--sep'), 'asr.json'), 'utf8'));
  const refN = normalize(rec.words);
  const R = overlaps(stretches(rec.words));
  const { words, added } = merge(base, regions, dz, { mode: opt('--mode', 'add'), who: opt('--who', 'heard'), finalVoices: opt('--voices') ? JSON.parse(fs.readFileSync(opt('--voices'), 'utf8')) : null });
  const before = report('before', refN, normalize(base), R);
  const after = report('after', refN, normalize(words), R);
  // precision of the added words: does a reference word with the same token sit there (and was not already found)?
  const addN = normalize(added);
  const addHit = matchCount(addN, refN, 1);
  const pct = (x) => (100 * x).toFixed(1).padStart(5);
  for (const r of [before, after]) console.log(`${r.label.padEnd(7)} WER ${pct(r.wer)}  WDER ${pct(r.wder)}  cpWER ${pct(r.cpwer)}  tcpWER ${pct(r.tcpwer)}  recall overlap ${pct(r.recallOverlap)}  all ${pct(r.recallAll)}  hyp words ${r.hypWords}`);
  console.log(`added ${addN.length} words, ${addHit} match a reference word nearby (${pct(addHit / Math.max(1, addN.length))}%); reference overlap ${R.length} stretches, ${refN.filter((w) => inside(mid(w), R)).length} words`);
  // ceiling: every word of the mix plus every word of both separated streams (no dedupe, no speaker), recall only
  const union = normalize(base.concat(regions.flatMap((r) => r.streams.flatMap((st) => st.words.map((w) => ({ ...w, speaker: 'x' }))))));
  const refIn = refN.filter((w) => inside(mid(w), R));
  console.log(`ceiling (mix + both streams, any speaker): recall overlap ${pct(matchCount(refIn, union, 1) / refIn.length)}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ before, after, added: addN.length, addHit }));
}

module.exports = { stretches, overlaps, matchCount, merge };
