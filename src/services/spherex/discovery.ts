/**
 * Discovery of Level-2 exposures covering a sky position — the one step AWS cannot do by itself (keys carry no
 * coordinates; no footprint index is published in the bucket). Discovery is a set of OPTIONAL providers:
 *   sia2  IRSA SIA2 (`spherex_dr1`, `_dr1_deep`, `_qr3`, `_qr3_deep`); its `cloud_access` column carries the S3 key.
 *   tap   IRSA TAP (`spherex.plane`), the previous behaviour.
 * They run concurrently and are merged. If all fail the caller still gets a result (zero epochs + reasons); nothing
 * downstream (All-Sky Cube, loading a known product) depends on discovery.
 */
import type { EpochEntry, SkyPosition } from '../../types';
import { fetchWithProxyFallback, parseCsv } from '../http';
import { cloudAccessToKey, onPremUriToS3Key, parseLevel2Key } from '../aws/level2';
import { mjdToIso } from '../../utils/time';
import { CUTOUT_SIZE_DEG, findObservations, IRSA_ORIGIN } from './index';

export interface Level2DiscoveryProvider {
  readonly id: 'sia2' | 'tap';
  readonly label: string;
  find(pos: SkyPosition): Promise<EpochEntry[] | { epochs: EpochEntry[]; warnings?: string[] }>;
}

export const SIA2_COLLECTIONS = ['spherex_dr1', 'spherex_dr1_deep', 'spherex_qr3', 'spherex_qr3_deep'] as const;

export function siaLevel2QueryUrl(pos: SkyPosition, collection: string): string {
  return `${IRSA_ORIGIN}/SIA?COLLECTION=${collection}&POS=circle+${pos.ra.toFixed(6)}+${pos.dec.toFixed(6)}+0.01&RESPONSEFORMAT=CSV`;
}

const num = (s: string | undefined): number | null => { if (s === undefined || s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const toMicron = (v: number | null): number | null => { if (v === null) return null; const um = v < 1e-3 ? v * 1e6 : v; return um >= 0.3 && um <= 6 ? um : null; };

/** Turn one SIA2 CSV answer into epochs. Rows that are not Level-2 images (e.g. cube rows) are skipped. */
export function parseSia2Level2(csv: string, pos: SkyPosition, collection: string): EpochEntry[] {
  const out: EpochEntry[] = [];
  for (const r of parseCsv(csv)) {
    const accessUrl = r['access_url'] || '';
    const cloud = cloudAccessToKey(r['cloud_access']);
    const key = cloud ?? onPremUriToS3Key(accessUrl);
    if (!key && !accessUrl) continue;
    const parsed = key ? parseLevel2Key(key) : null;
    if (key && !parsed) continue;
    const mjd = num(r['t_min']);
    const iso = mjd !== null ? mjdToIso(mjd) : null;
    const lo = toMicron(num(r['em_min'])); const hi = toMicron(num(r['em_max']));
    const detector = r['energy_bandpassname'] || (parsed ? `D${parsed.detector}` : null);
    const obs = r['obs_id'] || parsed?.observationId || '';
    const id = parsed ? `${parsed.observationId}D${parsed.detector}` : (obs || accessUrl);
    out.push({
      id, label: iso ? iso.slice(0, 10) : id.slice(0, 12), mjd, isoDate: iso, detector,
      wavelengthRangeUm: lo !== null && hi !== null ? [Math.min(lo, hi), Math.max(lo, hi)] : null,
      status: 'idle',
      provenance: {
        origin: 'spherex-live', mission: 'NASA SPHEREx', instrument: detector ? `SPHEREx ${detector}` : 'SPHEREx',
        product: 'Level-2 spectral image (window of the IMAGE extension)', observationDate: iso, mjd,
        ...(accessUrl ? { url: `${accessUrl.replace(/^http:\/\//i, 'https://')}?center=${pos.ra.toFixed(6)},${pos.dec.toFixed(6)}d&size=${CUTOUT_SIZE_DEG}` } : {}),
        ...(key ? { s3Key: key } : {}),
        notes: [
          `Discovered via IRSA SIA2 (${collection}); date from t_min (MJD).`,
          ...(key ? [cloud ? 'S3 key from the SIA2 cloud_access column.' : 'S3 key derived from the documented on-prem → bucket directory mapping (verified when the file is opened).'] : []),
        ],
      },
    });
  }
  return out;
}

export const sia2Provider: Level2DiscoveryProvider = {
  id: 'sia2',
  label: 'IRSA SIA2',
  async find(pos) {
    const answers = await Promise.allSettled(SIA2_COLLECTIONS.map(async (c) => {
      const res = await fetchWithProxyFallback(siaLevel2QueryUrl(pos, c), {}, 90_000);
      const text = await res.text();
      if (text.trimStart().startsWith('<')) throw new Error(`SIA2 (${c}) returned an error document: ${text.slice(0, 120)}`);
      return parseSia2Level2(text, pos, c);
    }));
    const ok = answers.filter((a): a is PromiseFulfilledResult<EpochEntry[]> => a.status === 'fulfilled');
    if (ok.length === 0) throw (answers[0] as PromiseRejectedResult).reason;
    // A collection that failed is not the same as a collection with no rows: report it instead of hiding it.
    const warnings = answers.flatMap((a, i) => (a.status === 'rejected' ? [`${SIA2_COLLECTIONS[i]}: ${a.reason instanceof Error ? a.reason.message : String(a.reason)}`] : []));
    return { epochs: ok.flatMap((a) => a.value), warnings };
  },
};

export const tapProvider: Level2DiscoveryProvider = {
  id: 'tap',
  label: 'IRSA TAP',
  find: async (pos) => (await findObservations(pos)).epochs,
};

export interface DiscoveryAttempt { provider: string; ok: boolean; count: number; error?: string; warnings?: string[] }
export interface DiscoveryResult { epochs: EpochEntry[]; attempts: DiscoveryAttempt[] }

/** One entry per exposure (S3 key, else id); earlier providers win ties. */
export function mergeEpochs(lists: EpochEntry[][]): EpochEntry[] {
  const seen = new Map<string, EpochEntry>();
  for (const e of lists.flat()) { const k = e.provenance.s3Key ?? e.id; if (!seen.has(k)) seen.set(k, e); }
  return [...seen.values()].sort((a, b) => (a.mjd ?? Infinity) - (b.mjd ?? Infinity));
}

/**
 * Run providers concurrently and merge. Once one has produced rows the others get only `graceMs` more (a hung TAP
 * must not hold up an SIA2 answer). Never throws: failures are reported in `attempts`.
 */
export async function discoverEpochs(pos: SkyPosition, providers: Level2DiscoveryProvider[] = [sia2Provider, tapProvider], graceMs = 5_000): Promise<DiscoveryResult> {
  const attempts: DiscoveryAttempt[] = providers.map((p) => ({ provider: p.label, ok: false, count: 0, error: 'still running when the grace period ended' }));
  const lists: EpochEntry[][] = providers.map(() => []);
  let firstRows = false;
  await new Promise<void>((resolve) => {
    let pending = providers.length;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => { if (timer) clearTimeout(timer); resolve(); };
    if (pending === 0) return done();
    providers.forEach((p, i) => {
      p.find(pos).then(
        (res) => { const eps = Array.isArray(res) ? res : res.epochs; const warnings = Array.isArray(res) ? undefined : res.warnings; attempts[i] = { provider: p.label, ok: true, count: eps.length, ...(warnings?.length ? { warnings } : {}) }; lists[i] = eps; if (eps.length > 0 && !firstRows) { firstRows = true; timer = setTimeout(done, graceMs); } },
        (e) => { attempts[i] = { provider: p.label, ok: false, count: 0, error: e instanceof Error ? e.message : String(e) }; },
      ).finally(() => { if (--pending === 0) done(); });
    });
  });
  return { epochs: mergeEpochs(lists), attempts };
}
