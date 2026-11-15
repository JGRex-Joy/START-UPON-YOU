import type { Candidate, TrackMatch } from '../../types';
import { separationArcsec } from '../../utils/coords';

export interface TrackingOptions {
  /** Max match radius in arcsec (sky) or pixels*scale when no WCS. */
  matchRadiusArcsec: number;
  /** Displacements above this (arcsec) are flagged as potential movers. */
  moverThresholdArcsec: number;
  /** Flux ratio outside [1/r, r] flags a potential variable. */
  variableRatio: number;
  /** Fallback arcsec/pixel when candidates have no sky coordinates. */
  pixelScaleArcsec: number | null;
}

export const DEFAULT_TRACKING: TrackingOptions = {
  matchRadiusArcsec: 60,
  moverThresholdArcsec: 8,
  variableRatio: 1.5,
  pixelScaleArcsec: null,
};

function distance(a: Candidate, b: Candidate, opts: TrackingOptions): { arcsec: number | null; px: number } {
  const px = Math.hypot(a.x - b.x, a.y - b.y);
  if (a.sky && b.sky) return { arcsec: separationArcsec(a.sky, b.sky), px };
  return { arcsec: opts.pixelScaleArcsec ? px * opts.pixelScaleArcsec : null, px };
}

/**
 * Greedy nearest-neighbour match of candidates from epoch A onto epoch B.
 * A displacement or flux change is only a *potential* motion/variability flag:
 * it can equally come from different wavelength sampling, registration error or noise.
 */
export function matchEpochs(a: Candidate[], b: Candidate[], opts: TrackingOptions): TrackMatch[] {
  const pairs: { i: number; j: number; d: number; px: number; arc: number | null }[] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const d = distance(a[i], b[j], opts);
      const metric = d.arcsec ?? d.px;
      const limit = d.arcsec !== null ? opts.matchRadiusArcsec : opts.matchRadiusArcsec / Math.max(1, opts.pixelScaleArcsec ?? 1);
      if (metric <= limit) pairs.push({ i, j, d: metric, px: d.px, arc: d.arcsec });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const matched = new Map<number, { j: number; px: number; arc: number | null }>();
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    matched.set(p.i, { j: p.j, px: p.px, arc: p.arc });
  }
  return a.map((from, i): TrackMatch => {
    const m = matched.get(i);
    if (!m) return { from, to: null, displacementArcsec: null, displacementPx: null, fluxRatio: null, kind: 'unmatched' };
    const to = b[m.j];
    const fluxRatio = from.flux > 0 && to.flux > 0 ? to.flux / from.flux : null;
    let kind: TrackMatch['kind'] = 'stable';
    const moved = m.arc !== null ? m.arc >= opts.moverThresholdArcsec : false;
    const varying = fluxRatio !== null && (fluxRatio > opts.variableRatio || fluxRatio < 1 / opts.variableRatio);
    if (moved) kind = 'potential-mover';
    else if (varying) kind = 'potential-variable';
    return { from, to, displacementArcsec: m.arc, displacementPx: m.px, fluxRatio, kind };
  });
}
