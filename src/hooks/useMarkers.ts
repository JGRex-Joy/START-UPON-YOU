import { useMemo } from 'react';
import { useStore } from '../app/store';
import type { EpochEntry } from '../types';
import { propagate } from '../utils/coords';
import { decimalYear, mjdToDate } from '../utils/time';
import { skyToPixel } from '../services/fits/wcs';
import type { ViewerImage } from '../components/sky/ImageViewer';
import type { Marker } from '../components/sky/viewState';

/** Decimal year of an epoch when its date is genuinely known. */
export function epochYear(epoch: EpochEntry | undefined): number | null {
  if (!epoch) return null;
  if (epoch.mjd !== null) return decimalYear(mjdToDate(epoch.mjd));
  if (epoch.isoDate) {
    const t = Date.parse(epoch.isoDate);
    if (Number.isFinite(t)) return decimalYear(new Date(t));
  }
  return null;
}

/** Candidate, catalog and target markers for the given epoch image, positioned via its WCS. */
export function useMarkers(epoch: EpochEntry | undefined, image: ViewerImage | null): Marker[] {
  const { state } = useStore();
  const { detection, catalogs, selectedCandidate, target } = state;
  return useMemo(() => {
    if (!image) return [];
    const out: Marker[] = [];
    const year = epochYear(epoch);
    const det = epoch ? detection[epoch.id] : undefined;
    det?.candidates.forEach((c) =>
      out.push({ id: `c${c.id}`, x: c.x, y: c.y, kind: 'candidate', label: `#${c.id}`, selected: selectedCandidate === c.id }),
    );
    if (image.wcs) {
      for (const layer of [catalogs['gaia-dr3'], catalogs.allwise]) {
        if (!layer.enabled) continue;
        for (const s of layer.sources) {
          const pos = year !== null ? propagate({ ra: s.ra, dec: s.dec }, s.pmRa, s.pmDec, year - s.epoch) : { ra: s.ra, dec: s.dec };
          const p = skyToPixel(image.wcs, pos.ra, pos.dec);
          if (p && p.x > -5 && p.y > -5 && p.x < image.width + 5 && p.y < image.height + 5) {
            out.push({ id: s.id, x: p.x, y: p.y, kind: s.catalog === 'gaia-dr3' ? 'gaia' : 'wise', label: s.label });
          }
        }
      }
      if (target?.challenge && state.dataset?.origin !== 'demo') {
        const c = target.challenge;
        const pos = year !== null ? propagate(target.pos, c.pmRa, c.pmDec, year - 2000) : target.searchPos;
        const p = skyToPixel(image.wcs, pos.ra, pos.dec);
        if (p) out.push({ id: 'target', x: p.x, y: p.y, kind: 'target', label: c.name });
      } else if (target && !target.challenge && state.dataset?.origin === 'spherex-live') {
        // Arbitrary RA/Dec search: mark the requested position (NOT the cutout centre, which can differ near footprint edges).
        const p = skyToPixel(image.wcs, target.searchPos.ra, target.searchPos.dec);
        if (p) out.push({ id: 'target', x: p.x, y: p.y, kind: 'target', label: 'requested position' });
      }
    }
    return out;
  }, [image, epoch, detection, catalogs, selectedCandidate, target, state.dataset?.origin]);
}
