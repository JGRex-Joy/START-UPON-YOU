import { finiteValues, percentile } from '../../utils/stats';

export type StretchKind = 'linear' | 'sqrt' | 'log' | 'asinh';
export type ColormapKind = 'gray' | 'heat' | 'diverging';

export interface RenderOptions {
  stretch: StretchKind;
  colormap: ColormapKind;
  /** Percentile clip (0..1) for the low/high display limits. */
  lowPct: number;
  highPct: number;
  /** For 'diverging': symmetric limit around zero. If undefined it is derived from the data. */
  symmetricLimit?: number;
}

export const DEFAULT_RENDER: RenderOptions = { stretch: 'asinh', colormap: 'gray', lowPct: 0.02, highPct: 0.995 };

type RGB = [number, number, number];

function lerpStops(stops: [number, RGB][], t: number): RGB {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      const f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

const HEAT: [number, RGB][] = [
  [0, [6, 9, 18]],
  [0.25, [52, 38, 92]],
  [0.5, [170, 62, 98]],
  [0.75, [236, 140, 60]],
  [1, [252, 236, 170]],
];
const DIVERGING: [number, RGB][] = [
  [0, [38, 96, 170]],
  [0.35, [118, 168, 214]],
  [0.5, [236, 238, 242]],
  [0.65, [226, 160, 130]],
  [1, [176, 52, 44]],
];

function buildLut(kind: ColormapKind): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const c: RGB = kind === 'gray' ? [t * 255, t * 255, t * 255] : lerpStops(kind === 'heat' ? HEAT : DIVERGING, t);
    lut[i * 3] = c[0];
    lut[i * 3 + 1] = c[1];
    lut[i * 3 + 2] = c[2];
  }
  return lut;
}
const LUTS: Record<ColormapKind, Uint8ClampedArray> = { gray: buildLut('gray'), heat: buildLut('heat'), diverging: buildLut('diverging') };

function stretchFn(kind: StretchKind): (t: number) => number {
  switch (kind) {
    case 'linear': return (t) => t;
    case 'sqrt': return (t) => Math.sqrt(t);
    case 'log': return (t) => Math.log10(1 + 999 * t) / 3;
    case 'asinh': return (t) => Math.asinh(10 * t) / Math.asinh(10);
  }
}

export interface DisplayLimits {
  lo: number;
  hi: number;
}

export function computeLimits(data: Float32Array, lowPct: number, highPct: number): DisplayLimits {
  const vals = finiteValues(data, 200_000).sort();
  if (vals.length === 0) return { lo: 0, hi: 1 };
  let lo = percentile(vals, lowPct);
  let hi = percentile(vals, highPct);
  if (!(hi > lo)) hi = lo + 1;
  return { lo, hi };
}

/**
 * Convert float pixels to RGBA. Image rows are flipped so FITS y=0 (bottom) is drawn at the bottom.
 * Missing (NaN) pixels are rendered as a dark hatch — never as zero flux.
 */
export function renderToImageData(
  data: Float32Array,
  width: number,
  height: number,
  opts: RenderOptions,
  out?: ImageData,
): ImageData {
  const img = out ?? new ImageData(width, height);
  const px = img.data;
  const lut = LUTS[opts.colormap];
  const fn = stretchFn(opts.stretch);
  let lo: number;
  let hi: number;
  if (opts.colormap === 'diverging') {
    let lim = opts.symmetricLimit;
    if (lim === undefined) {
      const l = computeLimits(data.map((v) => Math.abs(v)), 0, 0.995);
      lim = l.hi;
    }
    lo = -lim;
    hi = lim;
  } else {
    ({ lo, hi } = computeLimits(data, opts.lowPct, opts.highPct));
  }
  const span = hi - lo || 1;
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      const v = data[srcRow + x];
      const o = (dstRow + x) * 4;
      if (!Number.isFinite(v)) {
        const hatch = ((x + y) & 3) === 0;
        px[o] = hatch ? 60 : 20;
        px[o + 1] = hatch ? 44 : 22;
        px[o + 2] = hatch ? 44 : 30;
        px[o + 3] = 255;
        continue;
      }
      let t = (v - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      // Diverging maps are stretched about zero (symmetric), others via the chosen stretch.
      const s = opts.colormap === 'diverging' ? t : fn(t);
      const li = Math.round(s * 255) * 3;
      px[o] = lut[li];
      px[o + 1] = lut[li + 1];
      px[o + 2] = lut[li + 2];
      px[o + 3] = 255;
    }
  }
  return img;
}

/** Bilinear resample preserving NaN (a NaN neighbour makes the output NaN — no invented values). */
export function resampleBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * fy - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * fx - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

/** 3x3 box smoothing that ignores NaN neighbours (used to suppress pixel noise before detection). */
export function boxSmooth3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = src[yy * w + xx];
          if (Number.isFinite(v)) {
            s += v;
            c++;
          }
        }
      }
      out[y * w + x] = c >= 5 ? s / c : NaN;
    }
  }
  return out;
}
