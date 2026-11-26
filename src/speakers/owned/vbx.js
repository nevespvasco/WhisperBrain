'use strict';
// VBx clustering (Landini et al., "Bayesian HMM clustering of x-vector sequences (VBx)", 2022; the GMM form that
// pyannote speaker-diarization-community-1 uses on window embeddings): embeddings are projected with an LDA + PLDA
// transform into a space where one person's embeddings vary with unit covariance and different people differ with
// covariance diag(Phi); a variational Bayes mixture, started from an over-split AHC, then keeps only the speakers the
// data supports. Pure maths.
//
// plda: { mean1, lda (D×d, row-major), mean2, mu, tr (d×d, row-major), phi (d) } as written by eval/plda-train.js.

// x (raw embedding) -> PLDA features (Float64Array d), following the VBx recipe:
//   x1 = √D·unit(x − mean1);  x2 = ldaᵀx1;  x3 = √d·unit(x2 − mean2);  fea = tr·(x3 − mu)
function pldaFeatures(x, p) {
  const D = p.mean1.length, d = p.phi.length;
  const x1 = new Float64Array(D);
  let n = 0;
  for (let i = 0; i < D; i++) { x1[i] = x[i] - p.mean1[i]; n += x1[i] * x1[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < D; i++) x1[i] *= Math.sqrt(D) / n;
  const x2 = new Float64Array(d);
  for (let i = 0; i < D; i++) { const v = x1[i]; if (!v) continue; const row = i * d; for (let j = 0; j < d; j++) x2[j] += v * p.lda[row + j]; }
  let m = 0;
  for (let j = 0; j < d; j++) { x2[j] -= p.mean2[j]; m += x2[j] * x2[j]; }
  m = Math.sqrt(m) || 1;
  for (let j = 0; j < d; j++) x2[j] = (x2[j] * Math.sqrt(d)) / m - p.mu[j];
  const out = new Float64Array(d);
  for (let i = 0; i < d; i++) { let s = 0; const row = i * d; for (let j = 0; j < d; j++) s += p.tr[row + j] * x2[j]; out[i] = s; }
  return out;
}

const logsumexp = (a) => { let m = -Infinity; for (const v of a) if (v > m) m = v; let s = 0; for (const v of a) s += Math.exp(v - m); return m + Math.log(s); };

// The VB mixture. X: [Float64Array d] PLDA features; phi: Float64Array d; init: Int32Array AHC labels.
// -> { gamma: [Float64Array S] responsibilities, pi: Float64Array S, iterations, elbo }
function vbx(X, phi, init, { Fa = 0.07, Fb = 0.8, maxIters = 20, epsilon = 1e-6, smoothing = 7 } = {}) {
  const N = X.length, d = phi.length;
  const S = Math.max(...init) + 1;
  // smoothed one-hot start (softmax of 7·onehot), as pyannote does
  const e7 = Math.exp(smoothing);
  let gamma = Array.from({ length: N }, (_, i) => { const g = new Float64Array(S).fill(1 / (e7 + S - 1)); g[init[i]] = e7 / (e7 + S - 1); return g; });
  let pi = new Float64Array(S).fill(1 / S);
  const V = Float64Array.from(phi, Math.sqrt);
  const rho = X.map((x) => Float64Array.from(x, (v, j) => v * V[j]));
  const G = X.map((x) => { let s = 0; for (const v of x) s += v * v; return -0.5 * (s + d * Math.log(2 * Math.PI)); });
  let prev = -Infinity, elbo = -Infinity, it = 0;
  const invL = Array.from({ length: S }, () => new Float64Array(d)), alpha = Array.from({ length: S }, () => new Float64Array(d));
  for (it = 0; it < maxIters; it++) {
    for (let s = 0; s < S; s++) {
      let gs = 0;
      for (let i = 0; i < N; i++) gs += gamma[i][s];
      const a = alpha[s].fill(0);
      for (let i = 0; i < N; i++) { const g = gamma[i][s]; if (g < 1e-12) continue; const r = rho[i]; for (let j = 0; j < d; j++) a[j] += g * r[j]; }
      for (let j = 0; j < d; j++) { invL[s][j] = 1 / (1 + (Fa / Fb) * gs * phi[j]); a[j] *= (Fa / Fb) * invL[s][j]; }
    }
    const konst = Array.from({ length: S }, (_, s) => { let c = 0; for (let j = 0; j < d; j++) c += (invL[s][j] + alpha[s][j] * alpha[s][j]) * phi[j]; return -0.5 * c; });
    const lpi = Array.from(pi, (p) => Math.log(p + 1e-8));
    let llx = 0;
    const next = new Array(N);
    const newPi = new Float64Array(S);
    for (let i = 0; i < N; i++) {
      const lp = new Float64Array(S);
      for (let s = 0; s < S; s++) { let dotp = 0; const r = rho[i], a = alpha[s]; for (let j = 0; j < d; j++) dotp += r[j] * a[j]; lp[s] = Fa * (dotp + konst[s] + G[i]) + lpi[s]; }
      const z = logsumexp(lp);
      llx += z;
      const g = new Float64Array(S);
      for (let s = 0; s < S; s++) { g[s] = Math.exp(lp[s] - z); newPi[s] += g[s]; }
      next[i] = g;
    }
    gamma = next;
    const tot = newPi.reduce((a, b) => a + b, 0);
    pi = newPi.map((v) => v / tot);
    let reg = 0;
    for (let s = 0; s < S; s++) for (let j = 0; j < d; j++) reg += Math.log(invL[s][j]) - invL[s][j] - alpha[s][j] * alpha[s][j] + 1;
    elbo = llx + Fb * 0.5 * reg;
    if (it > 0 && elbo - prev < epsilon) { it++; break; }
    prev = elbo;
  }
  return { gamma, pi, iterations: it, elbo };
}

module.exports = { pldaFeatures, vbx };
