'use strict';
// Agglomerative clustering of window embeddings, as pyannote speaker-diarization-3.1 does it: centroid linkage on
// unit-length embeddings (Euclidean), cut at a distance threshold, clusters smaller than `minClusterSize` handed to
// the nearest large one, then every embedding assigned to the closest centroid. Pure maths, no I/O.

// Centroid-linkage merges. X: [Float64Array] (unit length). -> [{ a, b, height, size }] in merge order, where a and b
// are cluster ids (0..n-1 the rows, n+i the cluster made by merge i), height the Euclidean centroid distance.
// Lance-Williams on squared distances: d²(k, i∪j) = (ni·d²(k,i) + nj·d²(k,j))/(ni+nj) − ni·nj·d²(i,j)/(ni+nj)².
function linkage(X) {
  const n = X.length;
  if (n < 2) return [];
  const dim = X[0].length;
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = 0;
    const a = X[i], b = X[j];
    for (let d = 0; d < dim; d++) { const t = a[d] - b[d]; s += t * t; }
    D[i * n + j] = D[j * n + i] = s;
  }
  const size = new Float64Array(n).fill(1);
  const alive = new Uint8Array(n).fill(1);
  const id = Int32Array.from({ length: n }, (_, i) => i); // slot -> cluster id
  const nn = new Int32Array(n), nd = new Float64Array(n);
  const refresh = (i) => {
    let b = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (j !== i && alive[j] && D[i * n + j] < bd) { bd = D[i * n + j]; b = j; }
    nn[i] = b; nd[i] = bd;
  };
  for (let i = 0; i < n; i++) refresh(i);
  const merges = [];
  for (let m = 0; m < n - 1; m++) {
    let i = -1, best = Infinity;
    for (let k = 0; k < n; k++) if (alive[k] && nd[k] < best) { best = nd[k]; i = k; }
    const j = nn[i];
    const ni = size[i], nj = size[j], nij = ni + nj;
    merges.push({ a: id[i], b: id[j], height: Math.sqrt(Math.max(0, D[i * n + j])), size: nij });
    // slot i becomes the merged cluster, slot j dies
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === i || k === j) continue;
      const v = (ni * D[k * n + i] + nj * D[k * n + j]) / nij - (ni * nj * D[i * n + j]) / (nij * nij);
      D[k * n + i] = D[i * n + k] = Math.max(0, v);
    }
    alive[j] = 0; size[i] = nij; id[i] = n + m;
    refresh(i);
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === i) continue;
      if (nn[k] === i || nn[k] === j) refresh(k);
      else if (D[k * n + i] < nd[k]) { nd[k] = D[k * n + i]; nn[k] = i; }
    }
  }
  return merges;
}

// Flat labels after the first `m` merges. -> Int32Array (0..k-1, in order of first row)
function cut(n, merges, m) {
  const parent = Int32Array.from({ length: n + merges.length }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < m; i++) { parent[find(merges[i].a)] = n + i; parent[find(merges[i].b)] = n + i; }
  const map = new Map();
  const out = new Int32Array(n);
  for (let r = 0; r < n; r++) { const root = find(r); if (!map.has(root)) map.set(root, map.size); out[r] = map.get(root); }
  return out;
}

const counts = (labels) => { const c = new Map(); for (const l of labels) c.set(l, (c.get(l) || 0) + 1); return c; };

function centroids(X, labels, ids) {
  const dim = X[0].length;
  return ids.map((c) => {
    const m = new Float64Array(dim);
    let k = 0;
    labels.forEach((l, r) => { if (l === c) { k++; for (let d = 0; d < dim; d++) m[d] += X[r][d]; } });
    const norm = Math.hypot(...m) || 1;
    for (let d = 0; d < dim; d++) m[d] /= norm;
    return m;
  });
}

const dot = (a, b) => { let s = 0; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; return s; };

// X: [Float64Array] unit-length training embeddings. -> { labels: Int32Array (0..k-1), centroids: [Float64Array] }
// threshold: Euclidean distance between unit vectors (pyannote 3.1: 0.7045654963945799, i.e. cosine ≈ 0.75).
// numSpeakers > 0 forces the number of large clusters (as close as the dendrogram allows).
// fallbackSpeakers: how many voices the recording is known to hold (the live labels, the call's list of people) when that is
// at least 2. Used only when the cut at the threshold leaves fewer than two large clusters: on call audio where every voice
// comes through the same chain (Discord: Opus, noise suppression) the prints of different people sit close together, one
// cluster chains through most of them, every other cluster is small and is handed to it, and a call of five came out as one
// voice. The dendrogram is then cut again for that many large clusters instead.
function ahc(X, { threshold = 0.7045654963945799, minClusterSize = 12, numSpeakers = 0, fallbackSpeakers = 0 } = {}) {
  const n = X.length;
  if (!n) return { labels: new Int32Array(0), centroids: [] };
  if (n === 1) return { labels: new Int32Array(1), centroids: [Float64Array.from(X[0])] };
  const merges = linkage(X);
  const mcs = Math.min(minClusterSize, Math.max(1, Math.round(0.1 * n)));
  let m = 0;
  while (m < merges.length && merges[m].height <= threshold) m++;
  let labels = cut(n, merges, m);
  const large = (lab) => [...counts(lab)].filter(([, c]) => c >= mcs).length;
  // the cut whose number of large clusters is closest to `target`, preferring cuts near the threshold one
  const recut = (target) => {
    let best = m, bestGap = Infinity;
    const order = merges.map((_, i) => i + 1).concat([0]).sort((x, y) => Math.abs(x - m) - Math.abs(y - m));
    for (const mm of order) {
      const g = Math.abs(large(cut(n, merges, mm)) - target);
      if (g < bestGap) { bestGap = g; best = mm; }
      if (!g) break;
    }
    return cut(n, merges, best);
  };
  if (numSpeakers > 0 && large(labels) !== numSpeakers) labels = recut(numSpeakers);
  else if (!(numSpeakers > 0) && fallbackSpeakers >= 2 && large(labels) < 2) labels = recut(fallbackSpeakers);
  const c = counts(labels);
  const bigIds = [...c].filter(([, k]) => k >= mcs).map(([l]) => l);
  if (!bigIds.length) return { labels: new Int32Array(n), centroids: centroids(X, new Int32Array(n), [0]) };
  const smallIds = [...c.keys()].filter((l) => !bigIds.includes(l));
  if (smallIds.length) {
    const bigC = centroids(X, labels, bigIds), smallC = centroids(X, labels, smallIds);
    const to = new Map(smallIds.map((s, i) => { let b = 0, bv = -Infinity; bigC.forEach((g, k) => { const v = dot(g, smallC[i]); if (v > bv) { bv = v; b = k; } }); return [s, bigIds[b]]; }));
    labels = labels.map((l) => (to.has(l) ? to.get(l) : l));
  }
  // renumber 0..k-1
  const ren = new Map();
  labels = labels.map((l) => { if (!ren.has(l)) ren.set(l, ren.size); return ren.get(l); });
  return { labels, centroids: centroids(X, labels, [...ren.values()]) };
}

module.exports = { ahc, linkage, cut, dot };
