#!/usr/bin/env node
'use strict';
// Trains the LDA + PLDA transform that VBx clustering needs (src/speakers/owned/vbx.js) for the voice model in use.
// pyannote community-1 ships one trained on VoxCeleb for the same WeSpeaker ResNet34 model, but it is behind a
// gated download; this one is trained on LibriSpeech readers (CC BY 4.0, openslr.org/12), clean plus simulated
// call/phone versions of the same clips (the ffmpeg chains of eval/voices.js), cut to window-like 2-8 s crops.
//
//   node eval/plda-train.js [--sets dev-clean,test-clean,dev-other,test-other] [--per-speaker 40] [--dim 128]
//                           [--model path/to/voice-model.onnx] [--out src/speakers/owned/plda/<model>.json]
//
// Needs ffmpeg and the LibriSpeech sets unpacked under .eval/dl/LibriSpeech. Embeddings are cached in .eval/plda.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Models } = require('../src/asr/models');

const ROOT = path.join(__dirname, '..');
const LS = path.join(ROOT, '.eval', 'dl', 'LibriSpeech');
const CACHE = path.join(ROOT, '.eval', 'plda');
const RATE = 16000;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const DEGRADE = { // same chains as eval/voices.js (simulated, not real calls)
  call: { snr: 30, filter: 'highpass=f=100,lowpass=f=7000,aecho=0.8:0.8:30|55:0.2|0.1', bitrate: '24k' },
  phone: { snr: 22, filter: 'highpass=f=250,lowpass=f=3600,aecho=0.8:0.8:30|55:0.3|0.15', bitrate: '12k' },
};

function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function ff(a, input) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...a], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr).slice(0, 200)}`);
  return r.stdout;
}
const f32 = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const decode = (file) => f32(ff(['-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1']));

function degrade(x, d, rand) {
  let p = 0;
  for (const v of x) p += v * v;
  const sigma = Math.sqrt(p / x.length / 10 ** (d.snr / 10));
  const noisy = Float32Array.from(x, (v) => v + sigma * (rand() * 2 - 1) * Math.sqrt(3));
  const ogg = ff(['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-af', d.filter, '-c:a', 'libopus', '-b:a', d.bitrate, '-application', 'voip', '-f', 'ogg', 'pipe:1'], Buffer.from(noisy.buffer));
  return f32(ff(['-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], ogg));
}

// ---- linear algebra (symmetric matrices, row-major Float64Array n×n) ----
// Cyclic Jacobi eigen-decomposition. -> { values: Float64Array n (descending), vectors: Float64Array n×n (column k = vector k) }
function eigSym(A, n) {
  const a = Float64Array.from(A), v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i * n + j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { // rotate columns p, q
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) { // rotate rows p, q
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) { const vkp = v[k * n + p], vkq = v[k * n + q]; v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq; }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y * n + y] - a[x * n + x]);
  const values = Float64Array.from(order, (i) => a[i * n + i]);
  const vectors = new Float64Array(n * n);
  order.forEach((src, k) => { for (let r = 0; r < n; r++) vectors[r * n + k] = v[r * n + src]; });
  return { values, vectors };
}

// within- and between-speaker covariance of rows X (Float64Array each) with labels.
function scatter(X, labels) {
  const n = X[0].length, N = X.length;
  const mean = new Float64Array(n);
  for (const x of X) for (let i = 0; i < n; i++) mean[i] += x[i] / N;
  const groups = new Map();
  X.forEach((x, k) => { if (!groups.has(labels[k])) groups.set(labels[k], []); groups.get(labels[k]).push(x); });
  const Sw = new Float64Array(n * n), Sb = new Float64Array(n * n);
  for (const xs of groups.values()) {
    const m = new Float64Array(n);
    for (const x of xs) for (let i = 0; i < n; i++) m[i] += x[i] / xs.length;
    for (const x of xs) for (let i = 0; i < n; i++) { const di = x[i] - m[i]; for (let j = 0; j < n; j++) Sw[i * n + j] += (di * (x[j] - m[j])) / N; }
    for (let i = 0; i < n; i++) { const di = m[i] - mean[i]; for (let j = 0; j < n; j++) Sb[i * n + j] += (xs.length * di * (m[j] - mean[j])) / N; }
  }
  return { mean, Sw, Sb };
}

const unitScale = (x, scale) => { const n = Math.hypot(...x) || 1; return x.map((v) => (v * scale) / n); };

// labelled embeddings -> the VBx transform { mean1, lda (D×d), mean2, mu, tr (d×d), phi (d) }
function trainPlda(E, labels, d) {
  const D = E[0].length, N = E.length;
  const mean1 = new Float64Array(D);
  for (const e of E) for (let i = 0; i < D; i++) mean1[i] += e[i] / N;
  const X1 = E.map((e) => unitScale(Float64Array.from(e, (v, i) => v - mean1[i]), Math.sqrt(D)));
  // LDA: generalised eigenvectors of (Sb, Sw) via Sw^-1/2
  const s1 = scatter(X1, labels);
  for (let i = 0; i < D; i++) s1.Sw[i * D + i] += 1e-6;
  const ew = eigSym(s1.Sw, D);
  const Wh = new Float64Array(D * D); // Sw^-1/2 = U Λ^-1/2 Uᵀ
  for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) { let s = 0; for (let k = 0; k < D; k++) s += ew.vectors[i * D + k] * ew.vectors[j * D + k] / Math.sqrt(Math.max(ew.values[k], 1e-10)); Wh[i * D + j] = s; }
  const M = mul(mul(Wh, s1.Sb, D, D, D), Wh, D, D, D);
  const em = eigSym(symmetrize(M, D), D);
  const lda = new Float64Array(D * d); // columns: Wh · top-d eigenvectors
  for (let i = 0; i < D; i++) for (let k = 0; k < d; k++) { let s = 0; for (let j = 0; j < D; j++) s += Wh[i * D + j] * em.vectors[j * D + k]; lda[i * d + k] = s; }
  const X2 = X1.map((x) => { const y = new Float64Array(d); for (let i = 0; i < D; i++) for (let k = 0; k < d; k++) y[k] += x[i] * lda[i * d + k]; return y; });
  const mean2 = new Float64Array(d);
  for (const y of X2) for (let k = 0; k < d; k++) mean2[k] += y[k] / N;
  const X3 = X2.map((y) => unitScale(Float64Array.from(y, (v, k) => v - mean2[k]), Math.sqrt(d)));
  // PLDA (two covariances): whiten within-speaker, diagonalise between-speaker
  const s3 = scatter(X3, labels);
  const e3 = eigSym(s3.Sw, d);
  const W = new Float64Array(d * d); // Λ^-1/2 Uᵀ
  for (let k = 0; k < d; k++) for (let j = 0; j < d; j++) W[k * d + j] = e3.vectors[j * d + k] / Math.sqrt(Math.max(e3.values[k], 1e-10));
  const B = mul(mul(W, s3.Sb, d, d, d), transpose(W, d), d, d, d);
  const eb = eigSym(symmetrize(B, d), d);
  const tr = mul(transpose(eb.vectors, d), W, d, d, d); // Vᵀ W
  return { mean1: [...mean1], lda: [...lda], mean2: [...mean2], mu: [...s3.mean], tr: [...tr], phi: [...eb.values].map((v) => Math.max(v, 1e-6)) };
}

function mul(A, B, n, m, p) { const C = new Float64Array(n * p); for (let i = 0; i < n; i++) for (let k = 0; k < m; k++) { const a = A[i * m + k]; if (!a) continue; for (let j = 0; j < p; j++) C[i * p + j] += a * B[k * p + j]; } return C; }
function transpose(A, n) { const T = new Float64Array(n * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) T[j * n + i] = A[i * n + j]; return T; }
function symmetrize(A, n) { const S = new Float64Array(n * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i * n + j] = (A[i * n + j] + A[j * n + i]) / 2; return S; }

async function main() {
  const models = new Models(process.env.WB_MODELS_DIR || path.join(ROOT, '.models'));
  const model = path.resolve(opt('--model', models.speakerPath()));
  const sets = opt('--sets', 'dev-clean,test-clean,dev-other,test-other').split(',');
  const perSpeaker = Number(opt('--per-speaker', 40));
  const d = Number(opt('--dim', 128));
  fs.mkdirSync(CACHE, { recursive: true });
  const cacheFile = path.join(CACHE, `${path.basename(model, '.onnx')}-${sets.join('+')}-${perSpeaker}.json`);
  let data;
  if (fs.existsSync(cacheFile)) data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  else {
    const sherpa = require('sherpa-onnx-node');
    const ex = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 4, provider: 'cpu', debug: 0 });
    const embed = (x) => { const st = ex.createStream(); st.acceptWaveform({ samples: x, sampleRate: RATE }); st.inputFinished(); return ex.isReady(st) ? Array.from(ex.compute(st, false)) : null; };
    const rand = rng(11);
    data = { model: path.basename(model), sets, rows: [] };
    for (const set of sets) {
      const dir = path.join(LS, set);
      if (!fs.existsSync(dir)) { console.warn(`missing ${set} (skipped)`); continue; }
      for (const spk of fs.readdirSync(dir).sort()) {
        const files = [];
        for (const chap of fs.readdirSync(path.join(dir, spk)).sort()) for (const f of fs.readdirSync(path.join(dir, spk, chap)).sort()) if (f.endsWith('.flac')) files.push(path.join(dir, spk, chap, f));
        const step = Math.max(1, Math.floor(files.length / perSpeaker));
        let n = 0;
        for (let i = 0; i < files.length && n < perSpeaker; i += step, n++) {
          let x = decode(files[i]);
          const len = Math.min(x.length, Math.round((2 + rand() * 6) * RATE));
          const at = Math.floor(rand() * Math.max(1, x.length - len));
          x = x.subarray(at, at + len);
          const r = rand();
          const variant = r < 0.6 ? 'clean' : r < 0.85 ? 'call' : 'phone';
          const y = variant === 'clean' ? x : degrade(x, DEGRADE[variant], rand);
          const e = embed(y);
          if (e) data.rows.push({ spk: `${set}/${spk}`, variant, e });
        }
        process.stdout.write(`\r${set} ${spk}: ${data.rows.length} embeddings   `);
      }
    }
    process.stdout.write('\n');
    fs.writeFileSync(cacheFile, JSON.stringify(data));
  }
  const speakers = new Set(data.rows.map((r) => r.spk));
  const dim = Math.min(d, speakers.size - 1);
  console.log(`${data.rows.length} embeddings of ${speakers.size} speakers -> LDA ${dim}`);
  const p = trainPlda(data.rows.map((r) => r.e), data.rows.map((r) => r.spk), dim);
  const out = opt('--out', path.join(ROOT, 'src', 'speakers', 'owned', 'plda', `${path.basename(model, '.onnx')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r6 = (a) => a.map((v) => Number(v.toPrecision(6)));
  fs.writeFileSync(out, JSON.stringify({
    about: `LDA+PLDA for VBx clustering with ${data.model}. Trained by eval/plda-train.js on ${data.rows.length} embeddings of ${speakers.size} LibriSpeech readers (${data.sets.join(', ')}; LibriSpeech by V. Panayotov et al., CC BY 4.0, openslr.org/12), clean and simulated call/phone crops of 2-8 s.`,
    model: data.model, dim, mean1: r6(p.mean1), lda: r6(p.lda), mean2: r6(p.mean2), mu: r6(p.mu), tr: r6(p.tr), phi: r6(p.phi),
  }));
  console.log(`wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB); phi[0..5] = ${p.phi.slice(0, 6).map((v) => v.toFixed(2)).join(', ')}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { eigSym, trainPlda, scatter };
