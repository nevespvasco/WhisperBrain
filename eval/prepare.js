#!/usr/bin/env node
'use strict';
// Builds the speaker-evaluation recordings in .eval/data (nothing here is committed: the audio is third-party).
//   node eval/prepare.js [--ami IS1009a,ES2004a] [--no-libri]
//
//   ami-<meeting>  An AMI meeting (CC BY 4.0, groups.inf.ed.ac.uk/ami): the headset mix as the "system" channel,
//                  reference words with times and speakers from the manual annotations. 4 people, real overlap.
//   libri-call     A constructed call from LibriSpeech dev-clean (CC BY 4.0, openslr.org/12): one person on the
//                  "mic" channel, three on "system", with quick turn changes (most pauses shorter than the 0.6 s the
//                  VAD needs to cut) and some overlap. Reference times are exact per utterance; words inside an
//                  utterance are spread by character count.
//   --local <folder> [--name pt-meeting-1]
//                  Your own recording (e.g. a pt-PT meeting, recorded with everyone's consent; never commit it): the folder
//                  holds system.wav and/or mic.wav (any format ffmpeg reads) and ref.tsv, one line per utterance:
//                  start<TAB>end<TAB>speaker<TAB>text (seconds; a corrected transcript exported from WhisperBrain will do).
//                  Words inside an utterance are spread by character count, as for libri-call, so WDER/cpWER/DER are exact
//                  per utterance and approximate inside it.
// Each recording is a folder with <channel>.wav (16 kHz mono s16le) and ref.json { name, channels, words }.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseWav, floatToPcm16, pcm16ToWav, pcm16ToFloat } = require('../src/audio/pcm');

const ROOT = path.join(__dirname, '..');
const DL = path.join(ROOT, '.eval', 'dl');
const DATA = path.join(ROOT, '.eval', 'data');
const AMI_AUDIO = (m) => `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${m}/audio/${m}.Mix-Headset.wav`;
const AMI_WORDS = 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip';
const LIBRI = 'https://www.openslr.org/resources/12/dev-clean.tar.gz';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const AMI = opt('--ami', 'IS1009a').split(',').filter(Boolean);

function run(cmd, a, o = {}) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', maxBuffer: 1 << 30, ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed: ${String(r.stderr || r.error).slice(0, 400)}`);
  return r.stdout;
}

async function download(url, dest, { check } = {}) {
  if (fs.existsSync(dest) && (!check || check(dest))) return dest;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
  if (check && !check(dest)) throw new Error(`${url}: unexpected content`);
  return dest;
}
const isWav = (f) => { const b = Buffer.alloc(4); const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('ascii') === 'RIFF'; };

function writeRecording(name, channels, words) {
  const dir = path.join(DATA, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const [ch, pcm] of Object.entries(channels)) { files[ch] = `${ch}.wav`; fs.writeFileSync(path.join(dir, files[ch]), pcm16ToWav(pcm)); }
  fs.writeFileSync(path.join(dir, 'ref.json'), JSON.stringify({ name, channels: files, words }, null, 1));
  const secs = Math.max(...Object.values(channels).map((p) => p.length / 32000));
  console.log(`${name}: ${(secs / 60).toFixed(1)} min, ${words.length} words, ${new Set(words.map((w) => w.speaker)).size} speakers`);
}

async function ami(meeting) {
  const wav = await download(AMI_AUDIO(meeting), path.join(DL, `${meeting}.Mix-Headset.wav`), { check: isWav });
  const zip = await download(AMI_WORDS, path.join(DL, 'ami_manual.zip'));
  const words = [];
  for (const spk of ['A', 'B', 'C', 'D', 'E']) {
    let xml;
    try { xml = run('unzip', ['-p', zip, `words/${meeting}.${spk}.words.xml`]).toString('latin1'); } catch { continue; }
    for (const m of xml.matchAll(/<w ([^>]*)>([^<]*)<\/w>/g)) {
      if (/punc="true"/.test(m[1])) continue;
      const st = /starttime="([\d.]+)"/.exec(m[1]), et = /endtime="([\d.]+)"/.exec(m[1]);
      if (!st || !et) continue;
      words.push({ speaker: `${meeting}.${spk}`, start: Number(st[1]), end: Number(et[1]), word: m[2] });
    }
  }
  const { samples, rate } = parseWav(fs.readFileSync(wav));
  if (rate !== 16000) throw new Error(`${meeting}: expected 16 kHz, got ${rate}`);
  writeRecording(`ami-${meeting}`, { system: floatToPcm16(samples) }, words.sort((a, b) => a.start - b.start));
}

// ---- constructed call from LibriSpeech ----
function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Cut leading and trailing silence (keeps 50 ms), so the gaps between turns are the ones the script chose.
function trim(x) {
  const F = 320;
  let peak = 0;
  const e = [];
  for (let i = 0; i + F <= x.length; i += F) { let s = 0; for (let k = i; k < i + F; k++) s += x[k] * x[k]; e.push(Math.sqrt(s / F)); peak = Math.max(peak, e[e.length - 1]); }
  const on = e.map((v) => v > peak * 0.08);
  const a = Math.max(0, on.indexOf(true) * F - 800), b = Math.min(x.length, (on.lastIndexOf(true) + 1) * F + 800);
  return x.subarray(a, b);
}

async function libriCall() {
  const tgz = await download(LIBRI, path.join(DL, 'dev-clean.tar.gz'));
  const base = path.join(DL, 'LibriSpeech');
  if (!fs.existsSync(path.join(base, 'dev-clean'))) run('tar', ['xzf', tgz, '-C', DL]);
  const meta = fs.readFileSync(path.join(base, 'SPEAKERS.TXT'), 'utf8').split('\n').filter((l) => /^\s*\d/.test(l))
    .map((l) => l.split('|').map((x) => x.trim())).filter((r) => r[2] === 'dev-clean').map((r) => ({ id: r[0], sex: r[1] }));
  const pickSex = (sex, n, skip = 0) => meta.filter((m) => m.sex === sex).sort((a, b) => Number(a.id) - Number(b.id)).slice(skip, skip + n).map((m) => m.id);
  const [me] = pickSex('M', 1);
  const remote = [pickSex('F', 1)[0], pickSex('M', 1, 1)[0], pickSex('F', 1, 1)[0]];
  const clips = new Map();
  for (const spk of [me, ...remote]) {
    const list = [];
    for (const chap of fs.readdirSync(path.join(base, 'dev-clean', spk)).sort()) {
      const dir = path.join(base, 'dev-clean', spk, chap);
      for (const line of fs.readFileSync(path.join(dir, `${spk}-${chap}.trans.txt`), 'utf8').split('\n').filter(Boolean)) {
        const [id, ...w] = line.split(' ');
        list.push({ id, file: path.join(dir, `${id}.flac`), text: w.join(' ') });
      }
    }
    clips.set(spk, list);
  }
  const decode = (f) => pcm16ToFloat(run('ffmpeg', ['-v', 'error', '-i', f, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1']));
  const next = (spk) => {
    for (;;) {
      const c = clips.get(spk).shift();
      if (!c) throw new Error(`ran out of clips for ${spk}`);
      const x = trim(decode(c.file));
      if (x.length >= 1.5 * 16000 && x.length <= 9 * 16000) return { ...c, x };
    }
  };
  const rand = rng(7);
  const GAPS = [[-0.5, 0.1], [0.1, 0.25], [0.25, 0.25], [0.4, 0.15], [1.0, 0.25]]; // [seconds, probability]
  const gap = () => { let r = rand(); for (const [g, p] of GAPS) { if ((r -= p) < 0) return g; } return 1; };
  const turns = [];
  let t = 0.5, prev = null;
  for (let k = 0; k < 70; k++) {
    const pool = [me, ...remote].filter((s) => s !== prev);
    const w = pool.map((s) => (s === me ? 0.3 : 0.7 / (pool.length - (pool.includes(me) ? 1 : 0))));
    let r = rand() * w.reduce((a, b) => a + b, 0), spk = pool[0];
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) < 0) { spk = pool[i]; break; }
    const c = next(spk);
    const start = Math.max(0, t + (k ? gap() : 0));
    turns.push({ spk, start, end: start + c.x.length / 16000, c });
    t = start + c.x.length / 16000;
    prev = spk;
  }
  const total = Math.ceil((Math.max(...turns.map((x) => x.end)) + 1) * 16000);
  const bus = { mic: new Float32Array(total), system: new Float32Array(total) };
  const words = [];
  for (const tr of turns) {
    const out = tr.spk === me ? bus.mic : bus.system;
    const at = Math.round(tr.start * 16000);
    for (let i = 0; i < tr.c.x.length; i++) out[at + i] += tr.c.x[i];
    const ws = tr.c.text.split(' ');
    const chars = ws.reduce((a, w) => a + w.length + 1, 0);
    let pos = 0;
    for (const w of ws) {
      const s = tr.start + (pos / chars) * (tr.end - tr.start);
      pos += w.length + 1;
      words.push({ speaker: `libri-${tr.spk}`, start: s, end: tr.start + (pos / chars) * (tr.end - tr.start), word: w });
    }
  }
  writeRecording('libri-call', { mic: floatToPcm16(bus.mic), system: floatToPcm16(bus.system) }, words.sort((a, b) => a.start - b.start));
  const changes = turns.slice(1).filter((x, i) => (x.spk === me) === (turns[i].spk === me) && x.start - turns[i].end < 0.6).length;
  console.log(`  ${changes} same-channel speaker changes with less than 0.6 s of pause`);
}

function spread(start, end, speaker, text) {
  const ws = String(text).trim().split(/\s+/).filter(Boolean);
  const chars = ws.reduce((a, w) => a + w.length + 1, 0);
  let pos = 0;
  return ws.map((w) => { const s = start + (pos / chars) * (end - start); pos += w.length + 1; return { speaker, start: s, end: start + (pos / chars) * (end - start), word: w }; });
}

function local(dir, name) {
  const channels = {};
  for (const ch of ['mic', 'system']) {
    const f = fs.readdirSync(dir).find((x) => x.startsWith(`${ch}.`));
    if (f) channels[ch] = floatToPcm16(pcm16ToFloat(run('ffmpeg', ['-v', 'error', '-i', path.join(dir, f), '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'])));
  }
  if (!Object.keys(channels).length) throw new Error(`${dir}: no mic.* or system.* audio file`);
  const words = [];
  for (const line of fs.readFileSync(path.join(dir, 'ref.tsv'), 'utf8').split('\n')) {
    const [a, b, speaker, ...text] = line.split('\t');
    if (!speaker || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) continue;
    words.push(...spread(Number(a), Number(b), speaker.trim(), text.join(' ')));
  }
  if (!words.length) throw new Error(`${dir}/ref.tsv: no utterances (start<TAB>end<TAB>speaker<TAB>text)`);
  writeRecording(name, channels, words.sort((x, y) => x.start - y.start));
}

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  if (opt('--local')) { local(path.resolve(opt('--local')), opt('--name', path.basename(path.resolve(opt('--local'))))); return; }
  for (const m of AMI) { try { await ami(m); } catch (e) { console.warn(`ami-${m}: ${e.message}`); } }
  if (!args.includes('--no-libri')) await libriCall();
})().catch((e) => { console.error(e.message); process.exit(1); });
