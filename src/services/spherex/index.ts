/**
 * NASA/IPAC IRSA — SPHEREx spectral-image retrieval.
 *
 * Verified against the IRSA tutorials (caltech-ipac.github.io/irsa-tutorials/spherex-cutouts, spherex-intro):
 *   - Spectral images are discovered through the IRSA TAP service, tables `spherex.plane` and `spherex.artifact`
 *     (join on planeid), with `p.poly` (footprint) and `p.time_bounds_lower` (observation start, MJD).
 *   - The cutout service is addressed by appending `?center=<ra>,<dec>d&size=<deg>` to `https://irsa.ipac.caltech.edu/<a.uri>`.
 *   - Each file is a multi-extension FITS: PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE.
 *   - The IMAGE header carries DATE, DETECTOR, OBSID, BUNIT. NOTE: in FITS, `DATE` is the file-CREATION date, so it is
 *     never used as the observation date here. Observation time comes from `spherex.plane.time_bounds_lower` (MJD)
 *     and, when present in the header, `DATE-OBS` / `MJD-OBS`.
 *
 * IMPORTANT data model notes (not "channels = dates"):
 *   - One file = one exposure on one of 6 detectors; each pixel in that exposure samples a different wavelength
 *     (linear variable filter). Epochs (time) and the 102 spectral channels are independent concepts.
 *   - Unlike a data cube, a single exposure has no per-channel slices.
 *
 * AWS-FIRST: pixels are read from the public AWS bucket (`../aws/level2`); the IRSA cutout service below is only an
 * OPTIONAL fallback when AWS is unreachable. TAP is one OPTIONAL *discovery* provider (see `./discovery.ts`).
 *
 * Status: written from the documented formats; it could NOT be exercised against the live archive from the
 * environment this prototype was built in (network-restricted). Treat first live runs as the integration test.
 */
import type { EpochEntry, FitsImage, SkyPosition } from '../../types';
import { fetchWithProxyFallback, parseCsv, ServiceError } from '../http';
import { parseFits, pickScienceHdu, toFitsImage } from '../fits';
import { mjdToIso } from '../../utils/time';
import { AwsError, CancelledError } from '../aws/errors';
import { loadLevel2Window, onPremUriToS3Key } from '../aws/level2';

export const IRSA_ORIGIN = 'https://irsa.ipac.caltech.edu';
const TAP_SYNC = `${IRSA_ORIGIN}/TAP/sync`;

export const CUTOUT_SIZE_DEG = 0.1;
export const MAX_EPOCHS = 100;

export function buildPlaneQuery(pos: SkyPosition, limit = MAX_EPOCHS): string {
  const { ra, dec } = pos;
  return [
    `SELECT TOP ${limit} a.uri AS uri, p.planeid, p.obs_publisher_did, p.time_bounds_lower, p.energy_bandpassname, p.energy_bounds_lower, p.energy_bounds_upper`,
    'FROM spherex.plane p',
    'JOIN spherex.artifact a ON a.planeid = p.planeid',
    `WHERE 1 = CONTAINS(POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}), p.poly)`,
    'ORDER BY p.time_bounds_lower',
  ].join(' ');
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Plane metadata gives energy bounds in metres in CAOM; accept micron too. Never guess outside 0.3–6 µm. */
function toMicron(v: number | null): number | null {
  if (v === null) return null;
  const um = v < 1e-3 ? v * 1e6 : v;
  return um >= 0.3 && um <= 6 ? um : null;
}

export function parsePlaneRows(csv: string, pos: SkyPosition): EpochEntry[] {
  const rows = parseCsv(csv);
  const entries: EpochEntry[] = [];
  for (const r of rows) {
    const uri = r['uri'];
    if (!uri) continue;
    const mjd = num(r['time_bounds_lower']);
    const bandpass = r['energy_bandpassname'] || null;
    const lo = toMicron(num(r['energy_bounds_lower']));
    const hi = toMicron(num(r['energy_bounds_upper']));
    const iso = mjd !== null ? mjdToIso(mjd) : null;
    const base = uri.startsWith('http') ? uri : `${IRSA_ORIGIN}/${uri.replace(/^\//, '')}`;
    const url = `${base}?center=${pos.ra.toFixed(6)},${pos.dec.toFixed(6)}d&size=${CUTOUT_SIZE_DEG}`;
    const id = r['planeid'] || uri;
    const s3Key = onPremUriToS3Key(uri);
    entries.push({
      id,
      label: iso ? iso.slice(0, 10) : id.slice(0, 12),
      mjd,
      isoDate: iso,
      detector: bandpass,
      wavelengthRangeUm: lo !== null && hi !== null ? [Math.min(lo, hi), Math.max(lo, hi)] : null,
      status: 'idle',
      provenance: {
        origin: 'spherex-live',
        mission: 'NASA SPHEREx',
        instrument: bandpass ? `SPHEREx ${bandpass}` : 'SPHEREx',
        product: 'Level-2 spectral image (cutout of IMAGE extension)',
        observationDate: iso,
        mjd,
        url,
        ...(s3Key ? { s3Key } : {}),
        notes: ['Date from spherex.plane time_bounds_lower (MJD).', ...(s3Key ? ['AWS S3 key derived from the documented on-prem → bucket directory mapping (verified when the file is opened).'] : [])],
      },
    });
  }
  return entries;
}

export interface CoverageResult {
  epochs: EpochEntry[];
  query: string;
}

/** Find all SPHEREx spectral images (exposures) whose footprint contains the position. */
export async function findObservations(pos: SkyPosition): Promise<CoverageResult> {
  const query = buildPlaneQuery(pos);
  const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
  const res = await fetchWithProxyFallback(`${TAP_SYNC}?${body.toString()}`, { method: 'GET' }, 180_000);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new ServiceError('IRSA TAP returned an error document instead of CSV: ' + text.slice(0, 160), 'parse');
  return { epochs: parsePlaneRows(text, pos), query };
}

/** Observation time stated by the file itself (DATE-OBS / MJD-OBS), verbatim. Never the creation `DATE`. */
export function headerObservationTime(header: FitsImage['header']): string | null {
  const d = header['DATE-OBS']?.value;
  if (typeof d === 'string' && d) return d;
  const m = header['MJD-OBS']?.value;
  return typeof m === 'number' ? mjdToIso(m) : null;
}

export interface EpochLoad {
  image: FitsImage;
  headerDate: string | null;
  source: 'aws-s3' | 'irsa-cutout';
  notes: string[];
}

/** AWS failures after which the optional IRSA cutout service is worth trying (not for "file missing" or "target outside"). */
const FALLBACK_CODES = new Set(['network', 'timeout', 'server_error', 'rate_limited', 'forbidden']);

function centerFromUrl(url: string | undefined): SkyPosition | undefined {
  const m = url ? /[?&]center=([-\d.]+),([-\d.]+)d/.exec(url) : null;
  return m ? { ra: Number(m[1]), dec: Number(m[2]) } : undefined;
}

/** Load the pixels of one epoch: AWS S3 first (HTTP Range window); IRSA cutout only if AWS is unreachable and a URL is known. */
export async function loadEpochImage(entry: EpochEntry, pos?: SkyPosition, opts: { signal?: AbortSignal } = {}): Promise<EpochLoad> {
  const p = entry.provenance;
  const notes: string[] = [];
  const center = pos ?? centerFromUrl(p.url);
  if (p.s3Key && center) {
    try {
      const w = await loadLevel2Window(p.s3Key, center, CUTOUT_SIZE_DEG, { signal: opts.signal });
      return { image: w.image, headerDate: headerObservationTime(w.image.header), source: 'aws-s3', notes: w.notes };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (!(e instanceof AwsError && FALLBACK_CODES.has(e.code) && !!p.url)) throw e;
      notes.push(`AWS S3 was not usable (${e.message}); fell back to the IRSA cutout service.`);
    }
  }
  const url = p.url;
  if (!url) throw new Error('No data location for this epoch (no AWS key and no cutout URL).');
  const res = await fetchWithProxyFallback(url, { signal: opts.signal }, 120_000);
  const file = parseFits(await res.arrayBuffer());
  const hdu = pickScienceHdu(file);
  if (!hdu) throw new ServiceError('FITS contains no image extension', 'parse');
  const image = toFitsImage(file, hdu);
  return { image, headerDate: headerObservationTime(image.header), source: 'irsa-cutout', notes: [...notes, 'Pixels from the IRSA cutout service (not AWS).'] };
}
