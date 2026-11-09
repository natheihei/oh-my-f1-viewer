/**
 * Moves labels apart along one axis so none overlap: each ends at least `gap` from its neighbours,
 * as close to where it wants to be as that allows, and inside `lo` to `hi`. Returns the positions
 * in the order given. With too little room, the labels are spread evenly from `lo` to `hi`.
 */
export function spreadLabels(wanted: number[], gap: number, lo = -Infinity, hi = Infinity): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const n = order.length;
  const out = new Array<number>(n);
  if (n === 0) return out;
  if (Number.isFinite(lo) && Number.isFinite(hi) && (n - 1) * gap > hi - lo) {
    order.forEach(({ i }, k) => (out[i] = n === 1 ? lo : lo + ((hi - lo) * k) / (n - 1)));
    return out;
  }
  const ys = order.map(({ y }) => Math.min(Math.max(y, lo), hi));
  for (let k = 1; k < n; k++) ys[k] = Math.max(ys[k], ys[k - 1] + gap);
  ys[n - 1] = Math.min(ys[n - 1], hi);
  for (let k = n - 2; k >= 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] - gap);
  order.forEach(({ i }, k) => (out[i] = ys[k]));
  return out;
}
