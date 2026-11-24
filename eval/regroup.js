'use strict';
// EXPERIMENT, not used by the app (see eval/README.md, "Regrouping turns"). Ways to group the voice prints of a
// meeting's speaker turns into people, to compare with the clustering inside the diarization model:
//   ahc       average-link agglomerative clustering on cosine similarity, stopped at a threshold
//   spectral  spectral clustering on a pruned cosine affinity, the number of people from the eigengap
//   vb        a variational Bayes mixture with automatic pruning, in the style of VBx (Landini et al. 2022), without
//             a trained PLDA: the speaker-space scales come from an initial over-clustering of the same meeting
// Points are voice prints of whole turns; weights are their lengths in seconds. Pure maths.

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const unit = (v) => { const n = Math.sqrt(dot(v, v)) || 1; return Float64Array.from(v, (x) => x / n); };

// Eigen-decomposition of a symmetric matrix (rows of Float64Array) by cyclic Jacobi rotations.
// -> { values: Float64Array (descending), vectors: [Float64Array] (vectors[k] belongs to values[k]) }
function eigSym(A0) {
  const n = A0.length;
  const A = A0.map((r) => Float64Array.from(r));
  const V = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-14) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const kp = A[k][p], kq = A[k][q]; A[k][p] = c * kp - s * kq; A[k][q] = s * kp + c * kq; }
      for (let k = 0; k < n; k++) { const pk = A[p][k], qk = A[q][k]; A[p][k] = c * pk - s * qk; A[q][k] = s * pk + c * qk; }
      for (let k = 0; k < n; k++) { const kp = V[k][p], kq = V[k][q]; V[k][p] = c * kp - s * kq; V[k][q] = s * kp + c * kq; }
    }
  }
  const order = [...Array(n).keys()].sort((a, b) => A[b][b] - A[a][a]);
  return { values: Float64Array.from(order, (k) => A[k][k]), vectors: order.map((k) => Float64Array.from(V, (row) => row[k])) };
}

// ---- ahc ----
function ahc(points, weights, { threshold = 0.5 } = {}) {
  const n = points.length;
  const U = points.map(unit);
  let sim = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => (i === j ? -Infinity : dot(U[i], U[j]))));
  let size = new Float64Array(n).fill(1);
  const members = Array.from({ length: n }, (_, i) => [i]);
  const alive = new Set(members.keys());
  for (;;) {
    let bi = -1, bj = -1, best = threshold;
    for (const i of alive) for (const j of alive) if (j > i && sim[i][j] >= best) { best = sim[i][j]; bi = i; bj = j; }
    if (bi < 0) break;
    for (const k of alive) { // Lance-Williams update of the average link
      if (k === bi || k === bj) continue;
      sim[bi][k] = sim[k][bi] = (size[bi] * sim[bi][k] + size[bj] * sim[bj][k]) / (size[bi] + size[bj]);
    }
    size[bi] += size[bj];
    members[bi].push(...members[bj]);
    alive.delete(bj);
  }
  const lab = new Int32Array(n);
  [...alive].forEach((c, k) => members[c].forEach((i) => { lab[i] = k; }));
  return lab;
}

// ---- spectral ----
// Cosine affinity keeping each point's `keep` share of strongest neighbours; the number of speakers from the largest
// gap among the leading eigenvalues of the normalised Laplacian (capped at maxK), then k-means on the eigenvectors.
function spectral(points, weights, { keep = 0.2, maxK = 8, k = 0, seed = 1 } = {}) {
  const n = points.length;
  const U = points.map(unit);
  const S = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => (i === j ? 0 : Math.max(0, dot(U[i], U[j])))));
  const P = S.map((row) => {
    const sorted = [...row].sort((a, b) => b - a);
    const cut = sorted[Math.max(0, Math.floor(keep * n) - 1)] ?? 0;
    return row.map((v) => (v >= cut ? v : 0));
  });
  const A = P.map((row, i) => row.map((v, j) => 0.5 * (v + P[j][i])));
  const d = A.map((row) => row.reduce((s, v) => s + v, 0) || 1);
  const L = A.map((row, i) => Float64Array.from(row, (v, j) => (i === j ? 1 : 0) - v / Math.sqrt(d[i] * d[j])));
  const { values, vectors } = eigSym(L.map((r) => Float64Array.from(r)));
  const asc = [...values.keys()].sort((a, b) => values[a] - values[b]);
  let K = k;
  if (!K) {
    let gap = -1;
    for (let m = 1; m < Math.min(maxK, n - 1); m++) { const g = values[asc[m]] - values[asc[m - 1]]; if (g > gap) { gap = g; K = m; } }
    K = Math.max(1, K);
  }
  if (K === 1) return new Int32Array(n);
  const F = Array.from({ length: n }, (_, i) => unit(Float64Array.from({ length: K }, (_, m) => vectors[asc[m]][i])));
  return kmeans(F, K, seed);
}

function kmeans(X, K, seed = 1) {
  const n = X.length, D = X[0].length;
  let rnd = seed;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const cen = [X[Math.floor(rand() * n)]];
  while (cen.length < K) { // farthest-first start
    let best = -1, bd = -1;
    for (let i = 0; i < n; i++) { const d = Math.min(...cen.map((c) => { let s = 0; for (let t = 0; t < D; t++) s += (X[i][t] - c[t]) ** 2; return s; })); if (d > bd) { bd = d; best = i; } }
    cen.push(X[best]);
  }
  const lab = new Int32Array(n);
  for (let it = 0; it < 50; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let b = 0, bd = Infinity;
      for (let k = 0; k < K; k++) { let s = 0; for (let t = 0; t < D; t++) s += (X[i][t] - cen[k][t]) ** 2; if (s < bd) { bd = s; b = k; } }
      if (lab[i] !== b) { lab[i] = b; moved++; }
    }
    const sum = Array.from({ length: K }, () => new Float64Array(D)), cnt = new Int32Array(K);
    for (let i = 0; i < n; i++) { cnt[lab[i]]++; for (let t = 0; t < D; t++) sum[lab[i]][t] += X[i][t]; }
    for (let k = 0; k < K; k++) if (cnt[k]) cen[k] = sum[k].map((v) => v / cnt[k]);
    if (!moved) break;
  }
  return lab;
}

// ---- vb ----
// Project to `dim` principal directions, whiten by the within-cluster covariance of an initial over-clustering
// (`init` labels), keep the between-cluster scale of each direction (V^2 = max(0, eigenvalue - 1)): then every
// speaker is a point z_s in that space and a turn is V*z_s plus unit noise. Variational Bayes over turn-to-speaker
// responsibilities with weights; speakers whose total weight falls below `prune` are dropped as the iterations go.
function vb(points, weights, init, { dim = 24, Fa = 0.4, Fb = 1, iters = 40, prune = 0.03, minSpeakers = 1 } = {}) {
  const n = points.length, D0 = points[0].length;
  const U = points.map(unit);
  const mean = new Float64Array(D0);
  U.forEach((u) => u.forEach((v, d) => { mean[d] += v / n; }));
  const C = U.map((u) => Float64Array.from(u, (v, d) => v - mean[d]));
  const cov = Array.from({ length: D0 }, () => new Float64Array(D0));
  for (const c of C) for (let a = 0; a < D0; a++) for (let b = a; b < D0; b++) cov[a][b] += (c[a] * c[b]) / n;
  for (let a = 0; a < D0; a++) for (let b = 0; b < a; b++) cov[a][b] = cov[b][a];
  const pca = eigSym(cov);
  const D = Math.min(dim, D0);
  const Y = C.map((c) => Float64Array.from({ length: D }, (_, k) => dot(c, pca.vectors[k]) / Math.sqrt(Math.max(pca.values[k], 1e-9))));
  // within-cluster covariance of the initial labels, in this whitened space
  const K0 = Math.max(...init) + 1;
  const mu = Array.from({ length: K0 }, () => new Float64Array(D)), cnt = new Float64Array(K0);
  Y.forEach((y, i) => { cnt[init[i]] += weights[i]; for (let d = 0; d < D; d++) mu[init[i]][d] += weights[i] * y[d]; });
  mu.forEach((m, k) => { if (cnt[k]) for (let d = 0; d < D; d++) m[d] /= cnt[k]; });
  const W = Array.from({ length: D }, () => new Float64Array(D));
  let tot = 0;
  Y.forEach((y, i) => { const m = mu[init[i]]; tot += weights[i]; for (let a = 0; a < D; a++) for (let b = a; b < D; b++) W[a][b] += weights[i] * (y[a] - m[a]) * (y[b] - m[b]); });
  for (let a = 0; a < D; a++) for (let b = 0; b < D; b++) W[a][b] = b >= a ? W[a][b] / tot + (a === b ? 1e-6 : 0) : 0;
  for (let a = 0; a < D; a++) for (let b = 0; b < a; b++) W[a][b] = W[b][a];
  const we = eigSym(W);
  const T = we.vectors.map((v, k) => v.map((x) => x / Math.sqrt(Math.max(we.values[k], 1e-9)))); // D x D whitening rows
  const X = Y.map((y) => Float64Array.from(T, (row) => dot(row, y)));
  // between-cluster covariance of the initial labels, in the within-whitened space
  const gm = new Float64Array(D);
  X.forEach((x, i) => { for (let d = 0; d < D; d++) gm[d] += (weights[i] * x[d]) / tot; });
  const B = Array.from({ length: D }, () => new Float64Array(D));
  const cm = Array.from({ length: K0 }, () => new Float64Array(D));
  X.forEach((x, i) => { for (let d = 0; d < D; d++) cm[init[i]][d] += weights[i] * x[d]; });
  for (let k = 0; k < K0; k++) if (cnt[k]) { for (let d = 0; d < D; d++) cm[k][d] = cm[k][d] / cnt[k] - gm[d]; for (let a = 0; a < D; a++) for (let b = 0; b < D; b++) B[a][b] += (cnt[k] / tot) * cm[k][a] * cm[k][b]; }
  const be = eigSym(B);
  const Xb = X.map((x) => Float64Array.from(be.vectors, (v) => dot(v, x)));
  const V2 = Float64Array.from(be.values, (v) => Math.max(0, v));
  const V = V2.map(Math.sqrt);
  // responsibilities start at the initial labels
  let gamma = Xb.map((_, i) => { const g = new Float64Array(K0).fill(0.02 / K0); g[init[i]] += 0.98; return g; });
  let pi = new Float64Array(K0).fill(1 / K0);
  let alive = [...Array(K0).keys()];
  for (let it = 0; it < iters; it++) {
    const stats = alive.map((s) => {
      let N = 0;
      const sx = new Float64Array(D);
      for (let i = 0; i < n; i++) { const g = gamma[i][s] * weights[i]; N += g; for (let d = 0; d < D; d++) sx[d] += g * V[d] * Xb[i][d]; }
      const invL = V2.map((v2) => 1 / (1 + (Fa / Fb) * N * v2));
      const alpha = Float64Array.from(sx, (v, d) => (Fa / Fb) * invL[d] * v);
      let pen = 0;
      for (let d = 0; d < D; d++) pen += V2[d] * (invL[d] + alpha[d] ** 2);
      return { s, N, alpha, pen };
    });
    const total = stats.reduce((a, b) => a + b.N, 0) || 1;
    const keepStats = stats.filter((st) => st.N / total >= prune || stats.length <= minSpeakers);
    alive = keepStats.map((st) => st.s);
    pi = new Float64Array(K0);
    keepStats.forEach((st) => { pi[st.s] = st.N / keepStats.reduce((a, b) => a + b.N, 0); });
    gamma = Xb.map((x) => {
      const g = new Float64Array(K0);
      let mx = -Infinity;
      const lp = keepStats.map((st) => { const v = Fa * (dot(Float64Array.from(x, (xv, d) => V[d] * xv), st.alpha) - 0.5 * st.pen) + Math.log(pi[st.s] + 1e-12); if (v > mx) mx = v; return v; });
      let z = 0;
      keepStats.forEach((st, k) => { g[st.s] = Math.exp(lp[k] - mx); z += g[st.s]; });
      for (let s = 0; s < K0; s++) g[s] /= z;
      return g;
    });
  }
  const remap = new Map(alive.map((s, k) => [s, k]));
  return Int32Array.from(gamma, (g) => remap.get(alive.reduce((b, s) => (g[s] > g[b] ? s : b), alive[0])));
}

module.exports = { ahc, spectral, vb, eigSym, kmeans };
