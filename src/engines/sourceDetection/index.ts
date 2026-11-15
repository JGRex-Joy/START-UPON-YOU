import type { Candidate, DetectionResult, Wcs } from '../../types';
import { boxSmooth3 } from '../imageProcessing';
import { estimateBackground } from '../../utils/stats';
import { pixelToSky } from '../../services/fits/wcs';

export interface DetectionOptions {
  /** Threshold multiplier: T = background + k * sigma */
  k: number;
  /** Minimum connected pixel count for a candidate. */
  minPixels: number;
  /** Smooth with a 3x3 box before thresholding (improves faint-source sensitivity). */
  smooth: boolean;
  /** Reject candidates touching the image border. */
  rejectEdges: boolean;
  maxCandidates: number;
}

export const DEFAULT_DETECTION: DetectionOptions = { k: 5, minPixels: 3, smooth: true, rejectEdges: false, maxCandidates: 500 };

/**
 * Simple threshold + connected-component detection.
 * Steps: background/noise (sigma-clipped) -> threshold T = mu + k*sigma -> 8-connected labelling ->
 * flux-weighted centroid, summed flux, peak, area.
 * These are *candidates only*: no deblending, no PSF fitting, no validation.
 */
export function detectSources(
  data: Float32Array,
  width: number,
  height: number,
  wcs: Wcs | null,
  opts: DetectionOptions,
): DetectionResult {
  const work = opts.smooth ? boxSmooth3(data, width, height) : data;
  const { background, sigma: rawSigma, validPixels } = estimateBackground(work);
  const sigma = rawSigma > 0 ? rawSigma : NaN;
  if (!Number.isFinite(background) || !Number.isFinite(sigma)) {
    return { candidates: [], background: NaN, sigma: NaN, threshold: NaN, k: opts.k, minPixels: opts.minPixels, validPixels };
  }
  const threshold = background + opts.k * sigma;
  const n = width * height;
  const label = new Int32Array(n); // 0 = unvisited
  const stack = new Int32Array(n);
  const found: Candidate[] = [];
  let nextId = 1;

  for (let start = 0; start < n; start++) {
    const v0 = work[start];
    if (label[start] !== 0 || !(v0 > threshold)) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = -1;
    let area = 0;
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let flux = 0;
    let peak = -Infinity;
    let touchesEdge = false;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      const raw = data[p];
      const v = Number.isFinite(raw) ? raw : work[p];
      const wgt = Math.max(0, work[p] - background);
      area++;
      sumW += wgt;
      sumX += wgt * x;
      sumY += wgt * y;
      flux += v - background;
      if (work[p] > peak) peak = work[p];
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (label[q] === 0 && work[q] > threshold) {
            label[q] = -1;
            stack[sp++] = q;
          }
        }
      }
    }
    if (area < opts.minPixels || (opts.rejectEdges && touchesEdge) || sumW <= 0) continue;
    const cx = sumX / sumW;
    const cy = sumY / sumW;
    const snr = (peak - background) / sigma;
    // Heuristic ranking score: saturating function of SNR, damped for tiny areas. Not a probability.
    const score = Math.min(1, (1 - Math.exp(-(snr - opts.k) / 8)) * Math.min(1, area / 6) + 0.05);
    found.push({
      id: nextId++,
      x: cx,
      y: cy,
      peak: peak - background,
      flux,
      area,
      snr,
      score: Math.max(0, Math.min(1, score)),
      sky: wcs ? pixelToSky(wcs, cx, cy) : null,
    });
  }
  found.sort((a, b) => b.snr - a.snr);
  const candidates = found.slice(0, opts.maxCandidates).map((c, i) => ({ ...c, id: i + 1 }));
  return { candidates, background, sigma, threshold, k: opts.k, minPixels: opts.minPixels, validPixels };
}
