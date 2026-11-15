/**
 * Catalog overlays.
 *
 *   Gaia DR3  — VizieR table I/355/gaiadr3 (positions at epoch J2016.0, ICRS)
 *   WISE      — AllWISE via VizieR II/328/allwise (positions J2000-ish epoch; W1–W4 Vega mags)
 *
 * VizieR's TAP service is CORS-enabled in most deployments, but if the browser blocks it the
 * `CatalogService` abstraction below lets you swap in a proxy (see src/config/hosts.ts and vite.config.ts)
 * or a backend endpoint later without touching the UI.
 *
 * NEOWISE is not wired up: its time-resolved single-exposure data is best queried from IRSA TAP
 * (`neowiser_p1bs_psd`) — a future `CatalogService` implementation.
 */
import type { CatalogId, CatalogSource, SkyPosition } from '../../types';
import { fetchWithProxyFallback, parseCsv } from '../http';

export interface CatalogQuery {
  center: SkyPosition;
  radiusDeg: number;
  limit: number;
}

export interface CatalogService {
  id: CatalogId;
  label: string;
  description: string;
  /** Plain-language caveat shown next to the overlay toggle. */
  caveat: string;
  search(q: CatalogQuery): Promise<CatalogSource[]>;
}

const TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

async function vizierQuery(adql: string): Promise<Record<string, string>[]> {
  const params = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql });
  const res = await fetchWithProxyFallback(`${TAP}?${params.toString()}`, {}, 45_000);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error('VizieR returned an error document: ' + text.slice(0, 200));
  return parseCsv(text);
}

const f = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const circle = (q: CatalogQuery, raCol: string, decCol: string) =>
  `1=CONTAINS(POINT('ICRS',${raCol},${decCol}),CIRCLE('ICRS',${q.center.ra.toFixed(6)},${q.center.dec.toFixed(6)},${q.radiusDeg.toFixed(5)}))`;

export const gaiaDr3: CatalogService = {
  id: 'gaia-dr3',
  label: 'Gaia DR3',
  description: 'ESA Gaia Data Release 3 via CDS VizieR (I/355/gaiadr3)',
  caveat: 'Positions are at epoch J2016.0; proper motion is applied when overlaying on a dated image. Optical G-band — not a calibrated comparison with SPHEREx infrared photometry.',
  async search(q) {
    const adql =
      `SELECT TOP ${q.limit} "Source","RA_ICRS","DE_ICRS","Gmag","BPmag","RPmag","Plx","pmRA","pmDE" FROM "I/355/gaiadr3" WHERE ${circle(q, 'RA_ICRS', 'DE_ICRS')} ORDER BY "Gmag"`;
    const rows = await vizierQuery(adql);
    return rows
      .map((r): CatalogSource | null => {
        const ra = f(r['RA_ICRS']);
        const dec = f(r['DE_ICRS']);
        if (ra === null || dec === null) return null;
        return {
          id: `gaia-${r['Source']}`,
          catalog: 'gaia-dr3',
          ra, dec, epoch: 2016.0,
          pmRa: f(r['pmRA']), pmDec: f(r['pmDE']),
          magnitudes: { G: f(r['Gmag']), BP: f(r['BPmag']), RP: f(r['RPmag']) },
          label: `Gaia DR3 ${r['Source']}`,
          extra: { 'Parallax (mas)': f(r['Plx']), 'Source id': r['Source'] },
        };
      })
      .filter((s): s is CatalogSource => s !== null);
  },
};

export const allWise: CatalogService = {
  id: 'allwise',
  label: 'WISE (AllWISE)',
  description: 'AllWISE Source Catalog via CDS VizieR (II/328/allwise)',
  caveat: 'AllWISE is a mean position over 2010–2011 (W1–W4, 3.4–22 µm, Vega mags). NEOWISE epochs are not included. Overlay only — not a cross-mission photometric comparison.',
  async search(q) {
    const adql =
      `SELECT TOP ${q.limit} "AllWISE","RAJ2000","DEJ2000","W1mag","W2mag","W3mag","W4mag","pmRA","pmDE" FROM "II/328/allwise" WHERE ${circle(q, 'RAJ2000', 'DEJ2000')} ORDER BY "W1mag"`;
    const rows = await vizierQuery(adql);
    return rows
      .map((r): CatalogSource | null => {
        const ra = f(r['RAJ2000']);
        const dec = f(r['DEJ2000']);
        if (ra === null || dec === null) return null;
        return {
          id: `allwise-${r['AllWISE']}`,
          catalog: 'allwise',
          ra, dec, epoch: 2010.5,
          pmRa: f(r['pmRA']), pmDec: f(r['pmDE']),
          magnitudes: { W1: f(r['W1mag']), W2: f(r['W2mag']), W3: f(r['W3mag']), W4: f(r['W4mag']) },
          label: `AllWISE ${r['AllWISE']}`,
          extra: { Designation: r['AllWISE'] },
        };
      })
      .filter((s): s is CatalogSource => s !== null);
  },
};

export const CATALOG_SERVICES: Record<CatalogId, CatalogService> = { 'gaia-dr3': gaiaDr3, allwise: allWise };
