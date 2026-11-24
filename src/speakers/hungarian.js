'use strict';
// Minimum-cost assignment (Hungarian algorithm, O(n³)) for a rectangular cost matrix. Pure maths, no I/O.
// cost[i][j] = cost of giving row i column j. -> Int32Array: for each row, its column, or -1 when there are more rows
// than columns and the row is left out.
function hungarian(cost) {
  const rows = cost.length;
  const cols = rows ? cost[0].length : 0;
  if (!rows || !cols) return new Int32Array(rows).fill(-1);
  const n = Math.max(rows, cols);
  const a = (i, j) => (i < rows && j < cols ? cost[i][j] : 0); // padding rows/columns cost nothing
  // 1-based potentials and matching (the classic e-maxx formulation)
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Int32Array(rows).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] && p[j] - 1 < rows && j - 1 < cols) out[p[j] - 1] = j - 1;
  return out;
}

module.exports = { hungarian };
