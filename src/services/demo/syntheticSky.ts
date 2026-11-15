import type { Dataset, EpochEntry, FitsImage, SkyPosition, SpectralCube } from '../../types';
import { makeTanWcs } from '../fits/wcs';

/**
 * DEMONSTRATION DATA — synthetic, deterministic, NOT a SPHEREx observation.
 * Generated so the analysis tools can be exercised when live archive access is unavailable.
 * Epochs have no dates on purpose: inventing observation dates is not allowed.
 */

const DEMO_NOTE = 'SYNTHETIC DEMONSTRATION DATA — generated in your browser. Not a NASA/SPHEREx observation.';
export const DEMO_PIXEL_SCALE_ARCSEC = 6.15; // SPHEREx native pixel scale, used only to make the demo geometry realistic

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

interface DemoStar {
  x: number;
  y: number;
  flux: number;
  vx: number;
  vy: number;
  variability: number;
  phase: number;
  temp: number;
}

function makeStars(rand: () => number, w: number, h: number): DemoStar[] {
  const stars: DemoStar[] = [];
  for (let i = 0; i < 46; i++) {
    stars.push({
      x: 8 + rand() * (w - 16),
      y: 8 + rand() * (h - 16),
      flux: 60 * Math.pow(1 - rand(), -0.9),
      vx: 0, vy: 0, variability: 0, phase: 0,
      temp: 0.4 + rand() * 1.6,
    });
  }
  stars[0] = { ...stars[0], x: w * 0.3, y: h * 0.62, flux: 900, vx: 2.4, vy: -1.1 }; // the "mover"
  stars[1] = { ...stars[1], x: w * 0.68, y: h * 0.35, flux: 700, variability: 0.7, phase: 0.8 }; // the "variable"
  return stars;
}

function paint(
  data: Float32Array, w: number, h: number, stars: DemoStar[], fluxAt: (s: DemoStar) => number,
  posAt: (s: DemoStar) => [number, number], sigmaPsf: number, rand: () => number, noise: number, bg: number,
): void {
  for (let i = 0; i < data.length; i++) data[i] = bg + gauss(rand) * noise;
  const r = Math.ceil(sigmaPsf * 4);
  for (const s of stars) {
    const [sx, sy] = posAt(s);
    const f = fluxAt(s);
    const norm = f / (2 * Math.PI * sigmaPsf * sigmaPsf);
    for (let y = Math.floor(sy) - r; y <= Math.ceil(sy) + r; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = Math.floor(sx) - r; x <= Math.ceil(sx) + r; x++) {
        if (x < 0 || x >= w) continue;
        const d2 = (x - sx) ** 2 + (y - sy) ** 2;
        data[y * w + x] += norm * Math.exp(-d2 / (2 * sigmaPsf * sigmaPsf));
      }
    }
  }
}

export function makeDemoDataset(center: SkyPosition, label: string): Dataset {
  const w = 160;
  const h = 160;
  const nEpochs = 6;
  const epochs: EpochEntry[] = [];
  const stars = makeStars(mulberry32(20251114), w, h);
  const wcs = makeTanWcs(center.ra, center.dec, w, h, DEMO_PIXEL_SCALE_ARCSEC);

  for (let e = 0; e < nEpochs; e++) {
    const rand = mulberry32(1000 + e * 77);
    const data = new Float32Array(w * h);
    const jx = e === 0 ? 0 : Math.round(gauss(rand) * 0.8); // small registration jitter
    const jy = e === 0 ? 0 : Math.round(gauss(rand) * 0.8);
    paint(
      data, w, h, stars,
      (s) => s.flux * (1 + s.variability * Math.sin(s.phase + e * 1.15)),
      (s) => [s.x + s.vx * e + jx, s.y + s.vy * e + jy],
      1.5, rand, 3.2, 20 + e * 0.4,
    );
    // A strip of missing pixels (NaN) in one epoch — demonstrates that gaps are not rendered as zeros.
    if (e === 2) for (let y = 20; y < 70; y++) for (let x = 112; x < 118; x++) data[y * w + x] = NaN;
    // The pointing jitter is real in the image content, so it must be reflected in this epoch's WCS.
    const epochWcs = { ...wcs, crpix: [wcs.crpix[0] + jx, wcs.crpix[1] + jy] as [number, number] };
    const image: FitsImage = {
      width: w, height: h, data, wcs: epochWcs, extname: 'IMAGE', bunit: 'demo units',
      header: {
        EXTNAME: { value: 'IMAGE' },
        DEMO: { value: true, comment: 'synthetic data' },
        CRVAL1: { value: center.ra },
        CRVAL2: { value: center.dec },
      },
    };
    epochs.push({
      id: `demo-${e + 1}`,
      label: `DEMO epoch ${e + 1}`,
      mjd: null, isoDate: null, detector: null, wavelengthRangeUm: null,
      status: 'ready', image,
      provenance: {
        origin: 'demo', mission: 'none (synthetic)', instrument: 'none', product: 'Synthetic image (demo)',
        observationDate: null, mjd: null,
        notes: [DEMO_NOTE, 'Injected: 1 moving source, 1 variable source, static sources, Gaussian noise, a patch of missing pixels (epoch 3).'],
      },
    });
  }
  return {
    origin: 'demo',
    title: `Demonstration — ${label}`,
    epochs,
    cube: makeDemoCube(center),
    structureNote: DEMO_NOTE + ' Six synthetic epochs and a 102-slice synthetic cube.',
  };
}

function makeDemoCube(center: SkyPosition): SpectralCube {
  const w = 96, h = 96, depth = 102;
  const stars = makeStars(mulberry32(7), w, h).slice(0, 20).map((s) => ({ ...s, vx: 0, vy: 0, variability: 0 }));
  const slices: (Float32Array | null)[] = new Array(depth).fill(null);
  const wcs = makeTanWcs(center.ra, center.dec, w, h, DEMO_PIXEL_SCALE_ARCSEC);
  return {
    width: w, height: h, depth, slices, wcs,
    header: { DEMO: { value: true, comment: 'synthetic cube' } },
    wavelengthsUm: null,
    bunit: 'demo units',
    readSlice(k: number) {
      const cached = slices[k];
      if (cached) return cached;
      const rand = mulberry32(5000 + k);
      const data = new Float32Array(w * h);
      const t = k / (depth - 1);
      paint(
        data, w, h, stars,
        (s) => s.flux * 0.5 * (0.35 + 1.4 * Math.exp(-((t - s.temp / 2) ** 2) / 0.12)),
        (s) => [s.x, s.y], 1.4, rand, 2.4, 15,
      );
      slices[k] = data;
      return data;
    },
  };
}
