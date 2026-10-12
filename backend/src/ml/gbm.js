/**
 * gbm.js — small gradient-boosted trees for binary log loss (dependency-free).
 *
 * Purpose: a like-for-like challenger to the logistic model inside
 * evaluate.js, trained on the same folds and the same standardized,
 * clipped inputs. Newton-step leaf values with L2 regularization, depth-
 * limited trees, histogram (quantile) split candidates, row subsampling and
 * optional monotone constraints. Deterministic for a given seed.
 *
 * Model JSON is plain data ({ trees: [...], lr, base }) so it can be served
 * from Node without this module's training code.
 */

const sigmoid = z => 1 / (1 + Math.exp(-z));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Quantile thresholds per feature (at most `bins` per feature).
function thresholds(X, bins) {
  const d = X[0].length, out = [];
  for (let j = 0; j < d; j++) {
    const v = X.map(r => r[j]).sort((a, b) => a - b);
    const t = new Set();
    for (let q = 1; q < bins; q++) t.add(v[Math.floor((q / bins) * v.length)]);
    out.push([...t].filter(x => x > v[0]).sort((a, b) => a - b));
  }
  return out;
}

/**
 * @param X  rows of numbers; y  0/1 labels
 * @param opts rounds, depth, lr, l2 (leaf regularization), minLeaf (min hessian
 *             sum per leaf), subsample (row fraction per tree), bins, seed,
 *             monotone (array of +1/-1/0 per feature)
 */
function trainGBM(X, y, { rounds = 300, depth = 3, lr = 0.05, l2 = 5, minLeaf = 20, subsample = 0.8, bins = 32, seed = 7, monotone = null } = {}) {
  const n = X.length, d = X[0].length;
  const rand = mulberry32(seed);
  const thr = thresholds(X, bins);
  const pos = y.reduce((s, v) => s + v, 0);
  const base = Math.log((pos + 0.5) / (n - pos + 0.5)); // log-odds prior
  const F = new Float64Array(n).fill(base);
  const trees = [];

  const buildNode = (idx, g, h, lvl) => {
    const G = idx.reduce((s, i) => s + g[i], 0), H = idx.reduce((s, i) => s + h[i], 0);
    const leafValue = -G / (H + l2);
    if (lvl >= depth || idx.length < 2 * minLeaf) return { v: leafValue };
    let best = null;
    const parentGain = (G * G) / (H + l2);
    for (let j = 0; j < d; j++) {
      // one pass per feature over sorted thresholds using accumulated bins
      const ts = thr[j]; if (!ts.length) continue;
      const binG = new Float64Array(ts.length + 1), binH = new Float64Array(ts.length + 1);
      for (const i of idx) {
        const v = X[i][j];
        let b = 0; while (b < ts.length && v >= ts[b]) b++; // bin = number of thresholds <= v
        binG[b] += g[i]; binH[b] += h[i];
      }
      let GL = 0, HL = 0;
      for (let b = 0; b < ts.length; b++) {
        GL += binG[b]; HL += binH[b];
        const GR = G - GL, HR = H - HL;
        if (HL < minLeaf || HR < minLeaf) continue;
        if (monotone && monotone[j]) {
          const vl = -GL / (HL + l2), vr = -GR / (HR + l2);
          if (monotone[j] > 0 ? vl > vr : vl < vr) continue;
        }
        const gain = (GL * GL) / (HL + l2) + (GR * GR) / (HR + l2) - parentGain;
        if (!best || gain > best.gain) best = { gain, j, t: ts[b] };
      }
    }
    if (!best || best.gain <= 1e-9) return { v: leafValue };
    const left = [], right = [];
    for (const i of idx) (X[i][best.j] < best.t ? left : right).push(i);
    return { j: best.j, t: best.t, l: buildNode(left, g, h, lvl + 1), r: buildNode(right, g, h, lvl + 1) };
  };

  for (let m = 0; m < rounds; m++) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = p - y[i]; h[i] = p * (1 - p); }
    const idx = [];
    for (let i = 0; i < n; i++) if (subsample >= 1 || rand() < subsample) idx.push(i);
    const tree = buildNode(idx, g, h, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += lr * evalTree(tree, X[i]);
  }
  return { trees, lr, base };
}

function evalTree(node, x) {
  while (node.j != null) node = x[node.j] < node.t ? node.l : node.r;
  return node.v;
}

function predictGBM(model, x) {
  let z = model.base;
  for (const t of model.trees) z += model.lr * evalTree(t, x);
  return { z, p: sigmoid(z) };
}

module.exports = { trainGBM, predictGBM, evalTree };
