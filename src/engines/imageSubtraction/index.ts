import type { DifferenceResult, FitsImage } from '../../types';
import { resampleBilinear } from '../imageProcessing';
import { estimateBackground } from '../../utils/stats';

export interface SubtractionOptions {
  /** Resample image 2 onto image 1's pixel grid when dimensions differ. */
  matchDimensions: boolean;
  /** Subtract each image's sigma-clipped median background before differencing. */
  normalizeBackground: boolean;
  /** Estimate an integer-pixel translation of I2 relative to I1 (brute-force cross-correlation). */
  register: boolean;
  /** Max shift searched in pixels (each direction). */
  maxShift: number;
  /** Optional noise gate: |D| < k*sigma_D is set to exactly 0 in the output (0 = disabled). */
  noiseGateK: number;
}

export const DEFAULT_SUBTRACTION: SubtractionOptions = {
  matchDimensions: true,
  normalizeBackground: true,
  register: true,
  maxShift: 6,
  noiseGateK: 0,
};

export class IncompatibleImagesError extends Error {}

/**
 * Integer-pixel registration: finds (dx, dy) maximising the normalised cross-correlation between
 * background-subtracted I1 and I2 shifted by (dx, dy). Brute force; subsampled for speed.
 */
export function estimateShift(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  maxShift: number,
): [number, number] {
  const ba = estimateBackground(a).background;
  const bb = estimateBackground(b).background;
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 60_000)));
  let best = -Infinity;
  let bestShift: [number, number] = [0, 0];
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let y = maxShift; y < h - maxShift; y += stride) {
        for (let x = maxShift; x < w - maxShift; x += stride) {
          const va = a[y * w + x] - ba;
          const vb = b[(y + dy) * w + (x + dx)] - bb;
          if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
          sab += va * vb;
          saa += va * va;
          sbb += vb * vb;
        }
      }
      const denom = Math.sqrt(saa * sbb);
      const score = denom > 0 ? sab / denom : -Infinity;
      if (score > best) {
        best = score;
        bestShift = [dx, dy];
      }
    }
  }
  return bestShift;
}

/**
 * D(x,y) = I2(x,y) - I1(x,y)
 *
 * This is a *basic pixel-difference prototype*: no PSF matching, no photometric calibration,
 * no flux scaling between detectors/wavelengths. Results are not scientifically validated.
 */
export function subtractImages(i1: FitsImage, i2: FitsImage, opts: SubtractionOptions): DifferenceResult {
  const notes: string[] = [];
  const w = i1.width;
  const h = i1.height;
  let b = i2.data;
  if (i2.width !== w || i2.height !== h) {
    if (!opts.matchDimensions) {
      throw new IncompatibleImagesError(
        `Image sizes differ (${i1.width}×${i1.height} vs ${i2.width}×${i2.height}). Enable "match dimensions" to resample.`,
      );
    }
    b = resampleBilinear(i2.data, i2.width, i2.height, w, h);
    notes.push(`Image 2 resampled bilinearly from ${i2.width}×${i2.height} to ${w}×${h} (pixel scales may differ; WCS not used).`);
  }
  if (w < 8 || h < 8) throw new IncompatibleImagesError('Images are too small to difference.');

  const a = i1.data;
  const bgA = estimateBackground(a);
  const bgB = estimateBackground(b);
  if (!Number.isFinite(bgA.background) || !Number.isFinite(bgB.background)) {
    throw new IncompatibleImagesError('One of the images contains no valid pixels.');
  }

  let shift: [number, number] = [0, 0];
  if (opts.register) {
    shift = estimateShift(a, b, w, h, Math.min(opts.maxShift, Math.floor(Math.min(w, h) / 4)));
    notes.push(
      shift[0] === 0 && shift[1] === 0
        ? 'Registration: no integer-pixel offset found.'
        : `Registration: image 2 shifted by (${-shift[0]}, ${-shift[1]}) px (integer only, no sub-pixel or WCS-based alignment).`,
    );
  } else {
    notes.push('Registration disabled.');
  }

  const off1 = opts.normalizeBackground ? bgA.background : 0;
  const off2 = opts.normalizeBackground ? bgB.background : 0;
  if (opts.normalizeBackground) notes.push('Background (sigma-clipped median) subtracted from each image before differencing.');

  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x2 = x + shift[0];
      const y2 = y + shift[1];
      const v1 = a[y * w + x];
      const v2 = x2 >= 0 && x2 < w && y2 >= 0 && y2 < h ? b[y2 * w + x2] : NaN;
      d[y * w + x] = Number.isFinite(v1) && Number.isFinite(v2) ? v2 - off2 - (v1 - off1) : NaN;
    }
  }

  const stat = estimateBackground(d);
  if (opts.noiseGateK > 0 && Number.isFinite(stat.sigma)) {
    const gate = opts.noiseGateK * stat.sigma;
    for (let i = 0; i < d.length; i++) if (Number.isFinite(d[i]) && Math.abs(d[i] - stat.background) < gate) d[i] = 0;
    notes.push(`Noise gate: pixels with |D − median| < ${opts.noiseGateK.toFixed(1)}σ set to 0 (σ from MAD of the difference).`);
  }
  notes.push('Prototype only: no PSF matching or photometric calibration. Differing detectors/wavelengths are NOT comparable.');
  return { width: w, height: h, data: d, sigma: stat.sigma, shift, scale: 1, notes, calibrated: false };
}
