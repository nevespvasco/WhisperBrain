// Checks a bot.js run: is each file one person, and does overlapping speech land in both?
//   node analyze.js [out/<run>]        (defaults to the newest run)
// Prints per-speaker talk time, a pairwise overlap matrix, a waveform correlation
// matrix (near 0 = different audio, near 1 = the same mixed audio leaked into both),
// an activity timeline, and writes mix.wav (what a single system-audio capture hears).
import fs from 'node:fs';
import path from 'node:path';

const RATE = 16000;
const FRAME = RATE / 50; // 20 ms
const ACTIVE_DBFS = -42;

const outRoot = path.join(import.meta.dirname, 'out');
const dir = process.argv[2] ?? path.join(outRoot, fs.readdirSync(outRoot).sort().at(-1));
const speakers = fs.existsSync(path.join(dir, 'speakers.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'speakers.json'))) : {};

function readWav(file) {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf('data', 12);
  const data = buf.subarray(at + 8);
  return new Int16Array(data.buffer, data.byteOffset, data.length >> 1);
}

const tracks = fs.readdirSync(dir).filter((f) => /^\d+\.wav$/.test(f)).map((f) => {
  const id = f.slice(0, -4);
  const pcm = readWav(path.join(dir, f));
  const thr = 32768 * 10 ** (ACTIVE_DBFS / 20);
  const active = new Uint8Array(Math.floor(pcm.length / FRAME));
  let sumSq = 0;
  let activeSq = 0;
  for (let i = 0; i < active.length; i++) {
    let s = 0;
    for (let j = i * FRAME; j < (i + 1) * FRAME; j++) s += pcm[j] * pcm[j];
    sumSq += s;
    if (Math.sqrt(s / FRAME) > thr) { active[i] = 1; activeSq += s; }
  }
  const nActive = active.reduce((a, b) => a + b, 0);
  const dbfs = (sq, n) => (n ? (10 * Math.log10(sq / n / 32768 ** 2)).toFixed(1) : '-inf');
  return { id, name: speakers[id]?.displayName ?? id, pcm, active, nActive, rmsAll: dbfs(sumSq, pcm.length), rmsSpeech: dbfs(activeSq, nActive * FRAME) };
});
if (!tracks.length) { console.error(`no <userId>.wav files in ${dir}`); process.exit(1); }

console.log(`run: ${dir}\n`);
console.table(tracks.map((t) => ({
  speaker: t.name, userId: t.id, seconds: (t.pcm.length / RATE).toFixed(1),
  talkSec: (t.nActive / 50).toFixed(1), 'rms all dBFS': t.rmsAll, 'rms speech dBFS': t.rmsSpeech,
})));

const label = (t) => t.name.slice(0, 14);
const overlap = {};
const corr = {};
for (const a of tracks) {
  overlap[label(a)] = {};
  corr[label(a)] = {};
  for (const b of tracks) {
    const n = Math.min(a.active.length, b.active.length);
    let both = 0;
    for (let i = 0; i < n; i++) both += a.active[i] & b.active[i];
    overlap[label(a)][label(b)] = (both / 50).toFixed(1);
    const m = Math.min(a.pcm.length, b.pcm.length);
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < m; i++) { ab += a.pcm[i] * b.pcm[i]; aa += a.pcm[i] ** 2; bb += b.pcm[i] ** 2; }
    corr[label(a)][label(b)] = aa && bb ? (ab / Math.sqrt(aa * bb)).toFixed(3) : 'n/a';
  }
}
console.log('seconds where both speakers are active (diagonal = own talk time):');
console.table(overlap);
console.log('waveform correlation (off-diagonal near 0 = separate voices, near 1 = same audio):');
console.table(corr);

const secs = Math.ceil(Math.max(...tracks.map((t) => t.active.length)) / 50);
console.log('activity per second (# = speaking >25% of that second, ! = overlap with someone else):');
for (let start = 0; start < secs; start += 100) {
  console.log(`  t=${start}s`);
  for (const t of tracks) {
    let line = '';
    for (let s = start; s < Math.min(secs, start + 100); s++) {
      const mine = t.active.subarray(s * 50, s * 50 + 50).reduce((x, y) => x + y, 0);
      const others = tracks.some((o) => o !== t && o.active.subarray(s * 50, s * 50 + 50).reduce((x, y) => x + y, 0) > 12);
      line += mine > 12 ? (others ? '!' : '#') : '.';
    }
    console.log(`  ${label(t).padEnd(14)} ${line}`);
  }
}

const len = Math.max(...tracks.map((t) => t.pcm.length));
const mix = new Int16Array(len);
for (let i = 0; i < len; i++) {
  let s = 0;
  for (const t of tracks) s += t.pcm[i] ?? 0;
  mix[i] = Math.max(-32768, Math.min(32767, s));
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + len * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(len * 2, 40);
fs.writeFileSync(path.join(dir, 'mix.wav'), Buffer.concat([h, Buffer.from(mix.buffer)]));
console.log(`\nwrote ${path.join(dir, 'mix.wav')} (sum of all tracks)`);
