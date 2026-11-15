/** Robust statistics that ignore NaN (missing) values. */

export function finiteValues(data: ArrayLike<number>, maxSamples = 0): Float32Array {
  const n = data.length;
  const step = maxSamples > 0 && n > maxSamples ? Math.ceil(n / maxSamples) : 1;
  const out = new Float32Array(Math.ceil(n / step));
  let k = 0;
  for (let i = 0; i < n; i += step) {
    const v = data[i];
    if (Number.isFinite(v)) out[k++] = v;
  }
  return out.subarray(0, k);
}

export function median(values: Float32Array): number {
  if (values.length === 0) return NaN;
  const a = Float32Array.from(values).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, p * (sorted.length - 1)));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Median absolute deviation scaled to a Gaussian sigma. */
export function madSigma(values: Float32Array, med: number): number {
  if (values.length === 0) return NaN;
  const dev = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - med);
  return 1.4826 * median(dev);
}

export interface BackgroundEstimate {
  background: number;
  sigma: number;
  validPixels: number;
}

/** Iterative sigma-clipped median + MAD sigma. Robust against bright sources. */
export function estimateBackground(data: ArrayLike<number>, clipSigma = 3, iterations = 5): BackgroundEstimate {
  let vals = finiteValues(data, 400_000);
  const validPixels = (() => {
    let c = 0;
    for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) c++;
    return c;
  })();
  if (vals.length === 0) return { background: NaN, sigma: NaN, validPixels: 0 };
  let med = median(vals);
  let sig = madSigma(vals, med);
  for (let it = 0; it < iterations && sig > 0; it++) {
    const lo = med - clipSigma * sig;
    const hi = med + clipSigma * sig;
    const kept = new Float32Array(vals.length);
    let k = 0;
    for (let i = 0; i < vals.length; i++) if (vals[i] >= lo && vals[i] <= hi) kept[k++] = vals[i];
    if (k < 16 || k === vals.length) break;
    vals = kept.subarray(0, k);
    med = median(vals);
    sig = madSigma(vals, med);
  }
  return { background: med, sigma: sig, validPixels };
}
