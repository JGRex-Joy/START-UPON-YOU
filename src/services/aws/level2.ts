/**
 * Level-2 Spectral Image MEFs (individual exposures) directly from the public AWS bucket.
 *
 * Layout (official docs, "Browsable Directories" + "Data Products"):
 *   <release>/level2/<PlanningPeriod>/l2b-v<Version>-<ProcessingDate>/<Detector>/level2_<ObservationID>D<Detector>_spx_l2b-v<Version>-<ProcessingDate>.fits
 *
 * What AWS alone can do / cannot do:
 *   ✔ Fetch a known product by key — whole file or just a spatial window via HTTP Range.
 *   ✔ Find a product from its OBSERVATION ID by listing the bucket (the planning period is part of the ID).
 *   ✘ Find products covering a COORDINATE: keys carry no sky position and no footprint index/manifest is documented in
 *     the bucket. Coordinate search needs an index (IRSA SIA2 `cloud_access` or TAP today) — see `spherex/discovery.ts`.
 */
import type { FitsHeader, FitsImage, SkyPosition } from '../../types';
import { buildWcs, pixelScaleArcsec, skyToPixel } from '../fits/wcs';
import { makeHdu, readPlane, type FitsFile, type FitsHdu } from '../fits/parser';
import { nextHduOffset, openByteSource, readHeaderAt } from '../fits/remote';
import { AwsError, CancelledError } from './errors';
import { headObject, listObjects, s3Request, S3_BUCKET } from './s3';

export interface Level2Key {
  key: string; release: string; planningPeriod: string; versionDir: string; version: number;
  processingDate: string; detector: number; observationId: string; fileName: string;
}

const KEY_RE = /^(dr1|qr3|qr2)\/level2\/([^/]+)\/(l2b-v(\d+)-(\d{4}-\d+))\/([1-6])\/(level2_(.+)D([1-6])_spx_l2b-v\d+-\d{4}-\d+\.fits)$/;

/** Parse a Level-2 key according to the documented layout; null when it does not match. */
export function parseLevel2Key(key: string): Level2Key | null {
  const m = KEY_RE.exec(key);
  if (!m || m[6] !== m[9]) return null;
  return { key, release: m[1], planningPeriod: m[2], versionDir: m[3], version: Number(m[4]), processingDate: m[5], detector: Number(m[6]), observationId: m[8], fileName: m[7] };
}

/**
 * Map an IRSA on-prem path/URL (TAP `uri`, SIA2 `access_url`) to the S3 key. Basis: the docs say the on-prem tree
 * `…/ibe/data/spherex/<release>/…` is mirrored on AWS under the same release prefix. Existence is verified on first read.
 */
export function onPremUriToS3Key(uri: string): string | null {
  const m = /(?:^|\/)ibe\/data\/spherex\/((?:dr1|qr3|qr2)\/[^?#]+)/.exec(uri);
  if (m) return decodeURIComponent(m[1]);
  return /^(dr1|qr3|qr2)\/[^?#]+$/.test(uri) ? uri : null;
}

/** Key from the SIA2 `cloud_access` column: JSON like {"aws": {"bucket_name": …, "key": …}} (as in IRSA's tutorials). */
export function cloudAccessToKey(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const aws = (JSON.parse(raw) as { aws?: { key?: unknown; bucket_name?: unknown } }).aws;
    if (!aws || typeof aws.key !== 'string' || !aws.key) return null;
    if (typeof aws.bucket_name === 'string' && aws.bucket_name !== S3_BUCKET) return null;
    return aws.key;
  } catch { return null; }
}

export interface Level2Match extends Level2Key { size: number }
const OBS_ID_RE = /^(\d{4}W\d{2}_[0-9A-Za-z]+)_\d{4}_[1-4]$/;

/** Locate the Level-2 file(s) of one observation by listing the bucket (no IRSA service). Newest version first. */
export async function findLevel2ByObservation(observationId: string, opts: { release?: string; detector?: number; signal?: AbortSignal } = {}): Promise<Level2Match[]> {
  const m = OBS_ID_RE.exec(observationId);
  if (!m) throw new AwsError(`'${observationId}' is not a SPHEREx Observation ID (expected e.g. 2026W20_2A_0191_4).`, 'invalid_response');
  const release = opts.release ?? 'dr1';
  const base = `${release}/level2/${m[1]}/`;
  const versions = await listObjects(base, { delimiter: '/', signal: opts.signal });
  if (versions.prefixes.length === 0) {
    throw new AwsError(`No Level-2 data for planning period ${m[1]} under '${release}/' in the bucket (it may belong to another release or is not published).`, 'not_found', undefined, base);
  }
  const out: Level2Match[] = [];
  for (const vPrefix of versions.prefixes) {
    for (const d of opts.detector ? [opts.detector] : [1, 2, 3, 4, 5, 6]) {
      const hit = await listObjects(`${vPrefix}${d}/level2_${observationId}D${d}_`, { maxKeys: 5, signal: opts.signal });
      for (const o of hit.objects) { const parsed = parseLevel2Key(o.key); if (parsed) out.push({ ...parsed, size: o.size }); }
    }
  }
  if (out.length === 0) throw new AwsError(`Observation ${observationId}${opts.detector ? ` detector ${opts.detector}` : ''} was not found under ${base}.`, 'not_found', undefined, base);
  return out.sort((a, b) => b.version - a.version || b.processingDate.localeCompare(a.processingDate) || a.detector - b.detector);
}

export interface Level2Window {
  image: FitsImage;
  header: FitsHeader;
  key: string;
  origin: [number, number];
  fullSize: [number, number];
  transport: 'range' | 'stream';
  bytesRead: number;
  notes: string[];
}
export interface WindowOptions { signal?: AbortSignal; isCancelled?: () => boolean; padPx?: number }

/** Cut a rectangular window out of a full-width row slab (rows are contiguous in FITS, columns are not). */
export function cropSlab(slab: Float32Array, width: number, x0: number, x1: number, rows: number): Float32Array {
  const w = x1 - x0 + 1;
  const out = new Float32Array(w * rows);
  for (let r = 0; r < rows; r++) out.set(slab.subarray(r * width + x0, r * width + x1 + 1), r * w);
  return out;
}

/**
 * Read only the pixels around `center` from a Level-2 IMAGE extension. Offsets come from the actual headers (HDU hop);
 * the IMAGE HDU position is not assumed. ≈ rows×2040×4 bytes are transferred instead of the ~70 MB file.
 */
export async function loadLevel2Window(key: string, center: SkyPosition, sizeDeg: number, opts: WindowOptions = {}): Promise<Level2Window> {
  const cancelled = () => !!(opts.isCancelled?.() || opts.signal?.aborted);
  const info = await headObject(key, opts.signal);
  const src = await openByteSource((range) => s3Request(key, { range, signal: opts.signal }), cancelled, info.size);
  try {
    const headers: FitsHeader[] = [];
    let image: FitsHdu | null = null;
    let off = 0;
    for (let index = 0; index < 8 && !image; index++) {
      const { header, end } = await readHeaderAt(src, off);
      const hdu = makeHdu(index, header, end);
      headers.push(header);
      if (hdu.isImage && hdu.extname.toUpperCase() === 'IMAGE') image = hdu; else off = nextHduOffset(hdu);
    }
    if (!image) throw new AwsError(`s3://${S3_BUCKET}/${key} has no IMAGE extension: not a Level-2 spectral image.`, 'unsupported_product', undefined, key);
    if (image.naxis.length !== 2) throw new AwsError(`The IMAGE extension has ${image.naxis.length} axes; a Level-2 spectral image is 2-D.`, 'unsupported_product', undefined, key);
    const [W, H] = image.naxis;
    const bpp = Math.abs(image.bitpix) / 8;
    if (![-32, -64, 16, 32].includes(image.bitpix)) throw new AwsError(`Unsupported BITPIX ${image.bitpix} in the IMAGE extension.`, 'unsupported_product', undefined, key);
    if (info.size !== null && image.dataOffset + image.dataBytes > info.size) throw new AwsError(`s3://${S3_BUCKET}/${key} is ${info.size} bytes but its headers need ${image.dataOffset + image.dataBytes}: truncated object.`, 'truncated', undefined, key);

    const wcs = buildWcs(image.header);
    if (!wcs) throw new AwsError('The IMAGE header has no celestial TAN WCS, so the target cannot be located in the image.', 'unsupported_product', undefined, key);
    const p = skyToPixel(wcs, center.ra, center.dec);
    if (!p || p.x < -0.5 || p.y < -0.5 || p.x > W - 0.5 || p.y > H - 0.5) {
      throw new AwsError(`The target (${center.ra.toFixed(5)}°, ${center.dec.toFixed(5)}°) falls outside this exposure's image (pixel ${p ? `${p.x.toFixed(0)}, ${p.y.toFixed(0)}` : 'n/a'} of ${W}×${H}).`, 'outside_footprint', undefined, key);
    }
    const half = Math.ceil((sizeDeg * 3600) / pixelScaleArcsec(wcs) / 2) + (opts.padPx ?? 3);
    const x0 = Math.max(0, Math.floor(p.x - half));
    const x1 = Math.min(W - 1, Math.ceil(p.x + half));
    const y0 = Math.max(0, Math.floor(p.y - half));
    const y1 = Math.min(H - 1, Math.ceil(p.y + half));
    const rows = y1 - y0 + 1;

    const start = image.dataOffset + y0 * W * bpp;
    const length = rows * W * bpp;
    if (src.mode === 'stream' && start + length > 25 * 1024 * 1024) {
      throw new AwsError('The server ignores Range requests and the window lies deep in the file; reading it would stream more than 25 MB. Not started.', 'authorization_required', undefined, key);
    }
    const slabBytes = await src.read(start, length);
    if (slabBytes.length < length) throw new AwsError(`Download ended early: got ${slabBytes.length} of ${length} bytes of the image window.`, 'truncated', undefined, key);
    if (cancelled()) throw new CancelledError();

    // Reuse the existing pixel reader (BSCALE/BZERO/BLANK) on a synthetic view of the slab.
    const slabFile: FitsFile = { buffer: slabBytes.buffer.slice(slabBytes.byteOffset, slabBytes.byteOffset + slabBytes.byteLength) as ArrayBuffer, hdus: [] };
    const slabHdu: FitsHdu = { ...image, naxis: [W, rows], dataOffset: 0, dataBytes: length };
    const data = cropSlab(readPlane(slabFile, slabHdu, 0), W, x0, x1, rows);

    // Shifting CRPIX by the window origin keeps the WCS exact.
    const w = x1 - x0 + 1;
    const header: FitsHeader = { ...image.header };
    const setNum = (k: string, v: number, c?: string) => { header[k] = { value: v, comment: c }; };
    setNum('NAXIS1', w); setNum('NAXIS2', rows);
    setNum('CRPIX1', wcs.crpix[0] - x0, 'shifted for the window'); setNum('CRPIX2', wcs.crpix[1] - y0, 'shifted for the window');
    setNum('CUTX0', x0, 'window origin in the full image (0-based)'); setNum('CUTY0', y0, 'window origin in the full image (0-based)');
    const merged: FitsHeader = { ...headers[0], ...header };
    const bunit = typeof image.header['BUNIT']?.value === 'string' ? (image.header['BUNIT'].value as string) : null;
    const fits: FitsImage = { width: w, height: rows, data, header: merged, wcs: buildWcs(merged), extname: image.extname, bunit };

    const notes = [`Pixels read directly from AWS S3 (s3://${S3_BUCKET}/${key}); ${src.mode === 'range' ? `HTTP Range: ${(length / 1e6).toFixed(2)} MB of ${info.size ? (info.size / 1e6).toFixed(0) + ' MB' : 'the file'}` : 'server ignores Range: streamed'}. Window ${w}×${rows} px at (${x0}, ${y0}) of ${W}×${H}.`];
    if (wcs.hasSip) notes.push('Header declares SIP distortion; this viewer uses the plain TAN WCS, so sky positions can be off by a few pixels towards the edges.');
    return { image: fits, header: merged, key, origin: [x0, y0], fullSize: [W, H], transport: src.mode, bytesRead: image.dataOffset + length, notes };
  } finally {
    src.close();
  }
}
