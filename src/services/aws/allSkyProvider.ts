/**
 * AWS S3 provider for the DR1 All-Sky Cube (`spherex_dr1_cube`).
 *
 * Official documentation states: bucket `nasa-irsa-spherex`, release prefix `dr1`,
 *   `hips5_cube/hips_20261026/Norder5/Dir[Directory Number]/Npix[HEALPix Pixel Index]_cube.fits`,
 * 12,288 tiles, HEALPix order 5, NESTED. It does NOT state how `[Directory Number]` derives from the pixel index.
 * We use the standard HiPS rule floor(Npix/10000)*10000 only as a CANDIDATE and verify it against the bucket:
 *   1. HEAD the candidate key → verified.
 *   2. Otherwise list the bucket (anonymous ListObjectsV2) to find the real release/Dir directory containing the tile.
 *   3. If DR1 / the cube tree is absent → 'unpublished' error describing what the bucket does contain. QR2/QR3 are never substituted.
 */
import type { AllSkyProvider, CubeLocation, LocateContext } from '../spherex/provider';
import { AwsError } from './errors';
import { headObject, listObjects, s3ObjectUrl, s3Request, type S3ObjectInfo } from './s3';

export const AWS_RELEASE = 'dr1';
export const CUBE_ROOT_PREFIX = `${AWS_RELEASE}/hips5_cube`;
export const DOCUMENTED_CUBE_RELEASE_DIR = 'hips_20261026';
export const CUBE_ORDER_DIR = 'Norder5';
export const DOCUMENTED_CUBE_PREFIX = `${CUBE_ROOT_PREFIX}/${DOCUMENTED_CUBE_RELEASE_DIR}/${CUBE_ORDER_DIR}`;
export const HIPS_DIR_SIZE = 10_000;

export const cubeDirName = (npix: number): string => `Dir${Math.floor(npix / HIPS_DIR_SIZE) * HIPS_DIR_SIZE}`;
export const cubeFileName = (npix: number): string => `Npix${npix}_cube.fits`;

/** Candidate key from the documented layout + the HiPS directory rule. Pure; NOT proof the object exists. */
export function candidateCubeKey(npix: number, prefix: string = DOCUMENTED_CUBE_PREFIX): string {
  if (!Number.isInteger(npix) || npix < 0) throw new Error(`Invalid HEALPix pixel index ${npix}`);
  return `${prefix}/${cubeDirName(npix)}/${cubeFileName(npix)}`;
}

export interface ResolvedCubeKey extends S3ObjectInfo { how: 'documented-path' | 'listing'; notes: string[] }

const names = (prefixes: string[], parent: string): string[] => prefixes.map((p) => p.slice(parent.length).replace(/\/$/, '')).filter(Boolean);

async function explainAbsence(npix: number, signal?: AbortSignal): Promise<AwsError> {
  const root = await listObjects('', { delimiter: '/', maxKeys: 100, signal });
  const top = names(root.prefixes, '');
  if (!top.includes(AWS_RELEASE)) {
    return new AwsError(`DR1 is not published in the bucket: no '${AWS_RELEASE}/' prefix exists in nasa-irsa-spherex (top-level prefixes found: ${top.join(', ') || 'none'}). The All-Sky Cube is DR1-only; QR2/QR3 are not substituted.`, 'unpublished');
  }
  const dr1 = await listObjects(`${AWS_RELEASE}/`, { delimiter: '/', maxKeys: 100, signal });
  const sub = names(dr1.prefixes, `${AWS_RELEASE}/`);
  if (!sub.includes('hips5_cube')) {
    return new AwsError(`DR1 exists in the bucket but has no 'hips5_cube' (All-Sky Cube) directory yet (found under ${AWS_RELEASE}/: ${sub.join(', ') || 'nothing'}). The cube is not published.`, 'unpublished');
  }
  const rel = await listObjects(`${CUBE_ROOT_PREFIX}/`, { delimiter: '/', signal });
  const rels = names(rel.prefixes, `${CUBE_ROOT_PREFIX}/`);
  if (rels.length === 0) return new AwsError(`'${CUBE_ROOT_PREFIX}/' exists but contains no release directory yet; the cube is not published.`, 'unpublished');
  return new AwsError(`All-Sky Cube tile Npix${npix} was not found. Release director${rels.length > 1 ? 'ies' : 'y'} present: ${rels.join(', ')}. The tile is not published (or the layout changed: expected ${candidateCubeKey(npix)}).`, 'not_found', undefined, candidateCubeKey(npix));
}

/** Find the tile's real key. Verified by HEAD or by a bucket listing; never assumed. */
export async function resolveCubeKey(npix: number, signal?: AbortSignal): Promise<ResolvedCubeKey> {
  const candidate = candidateCubeKey(npix);
  try {
    const info = await headObject(candidate, signal);
    return { ...info, how: 'documented-path', notes: [`Object found at the documented path s3://nasa-irsa-spherex/${candidate} (verified with an anonymous HEAD request).`] };
  } catch (e) {
    if (!(e instanceof AwsError) || (e.code !== 'not_found' && e.code !== 'forbidden')) throw e; // network/5xx: listing would fail too
  }
  const rel = await listObjects(`${CUBE_ROOT_PREFIX}/`, { delimiter: '/', signal });
  const releaseDirs = names(rel.prefixes, `${CUBE_ROOT_PREFIX}/`).sort((a, b) => (a === DOCUMENTED_CUBE_RELEASE_DIR ? -1 : b === DOCUMENTED_CUBE_RELEASE_DIR ? 1 : b.localeCompare(a)));
  const file = cubeFileName(npix);
  for (const r of releaseDirs) {
    const orderPrefix = `${CUBE_ROOT_PREFIX}/${r}/${CUBE_ORDER_DIR}/`;
    const dirs = await listObjects(orderPrefix, { delimiter: '/', signal });
    for (const d of names(dirs.prefixes, orderPrefix)) {
      const key = `${orderPrefix}${d}/${file}`;
      const hit = await listObjects(key, { maxKeys: 5, signal });
      const obj = hit.objects.find((o) => o.key === key);
      if (obj) {
        return { key, size: obj.size, etag: null, lastModified: obj.lastModified, how: 'listing', notes: [`The documented path did not exist; the tile was located by listing the bucket at s3://nasa-irsa-spherex/${key} (release dir ${r}, ${d}).`] };
      }
    }
  }
  throw await explainAbsence(npix, signal);
}

export const awsAllSkyProvider: AllSkyProvider = {
  id: 'aws-s3',
  label: 'AWS S3 (nasa-irsa-spherex, anonymous)',
  candidateId: (npix) => candidateCubeKey(npix),
  async locate(_pos, npix, ctx: LocateContext): Promise<CubeLocation> {
    const r = await resolveCubeKey(npix, ctx.signal);
    const info = r.how === 'listing' && r.etag === null ? await headObject(r.key, ctx.signal).catch(() => null) : null;
    return {
      url: s3ObjectUrl(r.key), key: r.key, via: 'aws-s3', notes: r.notes,
      objectSize: info?.size ?? r.size, etag: info?.etag ?? r.etag, lastModified: info?.lastModified ?? r.lastModified,
      fetcher: (range) => s3Request(r.key, { range, signal: ctx.signal }),
    };
  },
};
