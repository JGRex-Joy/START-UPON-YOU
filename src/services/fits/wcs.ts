import type { FitsHeader, SkyPosition, Wcs } from '../../types';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const n = (h: FitsHeader, k: string): number | null => {
  const v = h[k]?.value;
  return typeof v === 'number' ? v : null;
};

/** Build a celestial TAN WCS from a header; returns null if no usable celestial WCS exists. */
export function buildWcs(h: FitsHeader): Wcs | null {
  const ct1 = typeof h['CTYPE1']?.value === 'string' ? (h['CTYPE1'].value as string) : '';
  const ct2 = typeof h['CTYPE2']?.value === 'string' ? (h['CTYPE2'].value as string) : '';
  if (!/^RA---TAN/.test(ct1) || !/^DEC--TAN/.test(ct2)) return null;
  const crpix1 = n(h, 'CRPIX1');
  const crpix2 = n(h, 'CRPIX2');
  const crval1 = n(h, 'CRVAL1');
  const crval2 = n(h, 'CRVAL2');
  if (crpix1 === null || crpix2 === null || crval1 === null || crval2 === null) return null;

  let cd: [[number, number], [number, number]];
  const cd11 = n(h, 'CD1_1');
  if (cd11 !== null) {
    cd = [
      [cd11, n(h, 'CD1_2') ?? 0],
      [n(h, 'CD2_1') ?? 0, n(h, 'CD2_2') ?? 0],
    ];
  } else {
    const cdelt1 = n(h, 'CDELT1') ?? 1;
    const cdelt2 = n(h, 'CDELT2') ?? 1;
    const pc = [
      [n(h, 'PC1_1') ?? 1, n(h, 'PC1_2') ?? 0],
      [n(h, 'PC2_1') ?? 0, n(h, 'PC2_2') ?? 1],
    ];
    cd = [
      [cdelt1 * pc[0][0], cdelt1 * pc[0][1]],
      [cdelt2 * pc[1][0], cdelt2 * pc[1][1]],
    ];
  }
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (!Number.isFinite(det) || det === 0) return null;
  return {
    crpix: [crpix1, crpix2],
    crval: [crval1, crval2],
    cd,
    ctype: [ct1, ct2],
    hasSip: /SIP/.test(ct1) || n(h, 'A_ORDER') !== null,
  };
}

/** 0-based pixel (x right, y up) -> sky (deg). FITS pixel numbering is 1-based internally. */
export function pixelToSky(w: Wcs, x: number, y: number): SkyPosition {
  const dx = x + 1 - w.crpix[0];
  const dy = y + 1 - w.crpix[1];
  const xi = (w.cd[0][0] * dx + w.cd[0][1] * dy) * D2R;
  const eta = (w.cd[1][0] * dx + w.cd[1][1] * dy) * D2R;
  const a0 = w.crval[0] * D2R;
  const d0 = w.crval[1] * D2R;
  const denom = Math.cos(d0) - eta * Math.sin(d0);
  const ra = a0 + Math.atan2(xi, denom);
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(denom, xi));
  return { ra: (((ra * R2D) % 360) + 360) % 360, dec: dec * R2D };
}

/** Sky (deg) -> 0-based pixel. Returns null for points on the far hemisphere. */
export function skyToPixel(w: Wcs, ra: number, dec: number): { x: number; y: number } | null {
  const a = ra * D2R;
  const d = dec * D2R;
  const a0 = w.crval[0] * D2R;
  const d0 = w.crval[1] * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 1e-9) return null;
  const xi = ((Math.cos(d) * Math.sin(a - a0)) / cosc) * R2D;
  const eta = ((Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc) * R2D;
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
  const dx = (w.cd[1][1] * xi - w.cd[0][1] * eta) / det;
  const dy = (-w.cd[1][0] * xi + w.cd[0][0] * eta) / det;
  return { x: dx + w.crpix[0] - 1, y: dy + w.crpix[1] - 1 };
}

/**
 * Sky corners [ra, dec] (deg) of the outer pixel edges of a width x height image, ordered bottom-left, bottom-right,
 * top-right, top-left. Uses the plain TAN WCS: SIP distortion is NOT applied, so edges can be off by a few pixels.
 */
export function imageFootprint(w: Wcs, width: number, height: number): [number, number][] {
  const px: [number, number][] = [[-0.5, -0.5], [width - 0.5, -0.5], [width - 0.5, height - 0.5], [-0.5, height - 0.5]];
  return px.map(([x, y]) => { const s = pixelToSky(w, x, y); return [s.ra, s.dec] as [number, number]; });
}

/** Pixel scale in arcsec/pixel (geometric mean of the two axes). */
export function pixelScaleArcsec(w: Wcs): number {
  const det = Math.abs(w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0]);
  return Math.sqrt(det) * 3600;
}

/** Build a simple TAN WCS (north up, east left) — used for demo data and tests. */
export function makeTanWcs(ra: number, dec: number, width: number, height: number, scaleArcsec: number): Wcs {
  const s = scaleArcsec / 3600;
  return {
    crpix: [(width + 1) / 2, (height + 1) / 2],
    crval: [ra, dec],
    cd: [
      [-s, 0],
      [0, s],
    ],
    ctype: ['RA---TAN', 'DEC--TAN'],
    hasSip: false,
  };
}
