// Offline check of track.js + analyze.js, no Discord needed. Encodes two fake
// "speakers" as Discord does (Opus, 48 kHz stereo, 20 ms frames), feeds them through
// UserTrack with a fake clock (A talks 1-5 s, B talks 3-7 s, A again 9-10 s), then
// asserts both files line up on the wall clock and the 3-5 s overlap is in both.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { UserTrack, RATE } from './track.js';

const dir = path.join(import.meta.dirname, 'out', 'selftest');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

let clock = 0;
const now = () => clock;
const speakers = { 111: { freq: 220, spans: [[1, 5], [9, 10]] }, 222: { freq: 330, spans: [[3, 7]] } };
const enc = {}, tracks = {}, phase = {};
for (const id of Object.keys(speakers)) {
  enc[id] = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  tracks[id] = new UserTrack(path.join(dir, `${id}.wav`), 0, now);
  phase[id] = 0;
}

for (let ms = 0; ms < 11_000; ms += 20) {
  clock = ms + 20 + Math.random() * 15; // packet arrives after its 20 ms, plus jitter
  for (const [id, s] of Object.entries(speakers)) {
    if (!s.spans.some(([a, b]) => ms >= a * 1000 && ms < b * 1000)) continue;
    const pcm = new Int16Array(960 * 2);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(8000 * Math.sin(phase[id]) * (0.6 + 0.4 * Math.sin(phase[id] / 50)));
      phase[id] += (2 * Math.PI * s.freq) / 48000;
      pcm[2 * i] = pcm[2 * i + 1] = v;
    }
    tracks[id].push(enc[id].encode(Buffer.from(pcm.buffer), 960));
  }
}
clock = 11_000;
fs.writeFileSync(path.join(dir, 'speakers.json'), JSON.stringify({ 111: { displayName: 'Alice' }, 222: { displayName: 'Bob' } }));

const results = Object.fromEntries(Object.entries(tracks).map(([id, t]) => [id, t.close()]));
console.log(results);
for (const r of Object.values(results)) {
  assert.equal(r.decodeErrors, 0);
  assert.ok(Math.abs(r.seconds - 11) < 0.05, `file length ${r.seconds}s should be 11s`);
}

// Energy in 100 ms windows must match each speaker's script on the wall clock.
const pcmOf = (id) => {
  const b = fs.readFileSync(path.join(dir, `${id}.wav`)).subarray(44);
  return new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
};
const loudAt = (pcm, sec) => {
  let s = 0;
  const from = Math.floor(sec * RATE);
  for (let i = from; i < from + RATE / 10; i++) s += pcm[i] ** 2;
  return Math.sqrt(s / (RATE / 10)) > 500;
};
for (const [id, s] of Object.entries(speakers)) {
  const pcm = pcmOf(id);
  for (let sec = 0.2; sec < 10.8; sec += 0.1) {
    const near = s.spans.some(([a, b]) => Math.abs(sec - a) < 0.15 || Math.abs(sec - b) < 0.15);
    if (near) continue;
    const want = s.spans.some(([a, b]) => sec >= a && sec < b);
    assert.equal(loudAt(pcm, sec), want, `speaker ${id} at ${sec.toFixed(1)}s should be ${want ? 'loud' : 'silent'}`);
  }
}
console.log('selftest OK: per-user files are wall-clock aligned and the 3-5 s overlap is in both');
