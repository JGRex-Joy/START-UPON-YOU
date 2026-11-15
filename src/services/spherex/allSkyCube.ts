/**
 * SPHEREx DR1 All-Sky Cube support (the 102-channel HEALPix tiles, NOT the Level-2 exposures or their PSF cubes).
 *
 * Data path: RA/Dec → HEALPix NESTED Npix (existing `healpixNestedIndex`) → provider locates the product →
 * Range/stream reads of the FITS headers and the IMAGE layer → existing FITS parser → SpectralCube.
 *
 * PROVIDERS (`provider.ts`): AWS S3 (`../aws/allSkyProvider`) is the DEFAULT and needs no IRSA service at all.
 * The IRSA SIA2 / on-prem route (`irsaAllSkyProvider`) remains as an explicit, optional alternative.
 *
 * Archive facts (SPHEREx Data Products / Data Access docs, IRSA):
 *  - 12,288 tiles, HEALPix order 5, NESTED. One MEF per tile: IMAGE (512x512x102, MJy/sr, zodi subtracted), NHITS, FLAGS,
 *    SPECTRAL_CHANNELS (table), WCS-WAVE. Channels 51 and 52 hold no data and are listed in the BLANKCH keyword.
 *  - Only IMAGE + the small channel table are transferred (Range when supported, otherwise a forward stream).
 *  - Tiles are in the HEALPix (HPX) projection, which `buildWcs` does not handle: shown in pixel space.
 * Nothing here is synthetic: wavelengths come from the file's SPECTRAL_CHANNELS table and are validated, otherwise absent.
 */
import type { CubeInfo, FitsHeader, HeaderValue, SkyPosition, SpectralCube } from '../../types';
import { fetchWithProxyFallback, parseCsv, ServiceError } from '../http';
import { makeHdu, readBinTable, readPlane, toSpectralCube, type FitsFile, type FitsHdu } from '../fits/parser';
import { isEndOfFile, nextHduOffset, openByteSource, readHeaderAt, type ByteSource } from '../fits/remote';
import { healpixNestedIndex } from '../healpix';
import { AwsError, CancelledError } from '../aws/errors';
import { awsAllSkyProvider } from '../aws/allSkyProvider';
import { defaultCubeCache, type CachedCube, type CubeCache } from '../aws/cubeCache';
import { IRSA_ORIGIN } from './index';
import type { AllSkyProvider, CubeLocation } from './provider';

export { CancelledError };
export const ALLSKY_ORDER = 5;
export const ALLSKY_DEPTH = 102;
export const SIA_COLLECTION = 'spherex_dr1_cube';
export const HIPS_CUBE_BASE = `${IRSA_ORIGIN}/ibe/data/spherex/dr1/hips5_cube/hips_20261026`;
/** Approximate size of the IMAGE layer download, for the UI. */
export const ALLSKY_IMAGE_MB = 107;
/** Without an explicit `authorize` callback, transfers above this are refused instead of started silently. */
export const DEFAULT_AUTO_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Hard cap on the IMAGE layer this application will load. */
export const MAX_CUBE_IMAGE_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------- tile + IRSA URLs (optional provider)

export function allSkyTile(pos: SkyPosition): { order: number; npix: number } {
  return { order: ALLSKY_ORDER, npix: healpixNestedIndex(ALLSKY_ORDER, pos.ra, pos.dec) };
}

/** HiPS directory convention: Dir<floor(Npix/10000)*10000>. */
export function tileDirectory(npix: number): number {
  return Math.floor(npix / 10000) * 10000;
}

export function directCubeUrl(npix: number): string {
  return `${HIPS_CUBE_BASE}/Norder${ALLSKY_ORDER}/Dir${tileDirectory(npix)}/Npix${npix}_cube.fits`;
}

export function siaCubeQueryUrl(pos: SkyPosition): string {
  return `${IRSA_ORIGIN}/SIA?COLLECTION=${SIA_COLLECTION}&POS=circle+${pos.ra.toFixed(6)}+${pos.dec.toFixed(6)}+0.01&RESPONSEFORMAT=CSV`;
}

const NPIX_RE = /Npix(\d+)_cube\.fits/i;

/** Pick the cube URL for tile `npix` from an SIA2 CSV answer; throws if SIA2 disagrees with our HEALPix computation. */
export function pickCubeUrlFromSia(csv: string, npix: number): string | null {
  const urls = parseCsv(csv).map((r) => r['access_url']).filter((u): u is string => !!u && NPIX_RE.test(u));
  if (urls.length === 0) return null;
  const hit = urls.find((u) => Number(NPIX_RE.exec(u)?.[1]) === npix);
  if (!hit) {
    const seen = [...new Set(urls.map((u) => NPIX_RE.exec(u)?.[1]))].join(', ');
    throw new ServiceError(`IRSA SIA2 returned All-Sky Cube tile(s) ${seen} for this position, but the computed HEALPix tile is ${npix}. Refusing to load a tile that does not match.`, 'parse');
  }
  return hit.replace(/^http:\/\//i, 'https://');
}

export async function resolveCubeUrl(pos: SkyPosition, npix: number): Promise<{ url: string; via: 'sia2' | 'direct-url'; notes: string[] }> {
  const notes: string[] = [];
  try {
    const r = await fetchWithProxyFallback(siaCubeQueryUrl(pos), {}, 60_000);
    const url = pickCubeUrlFromSia(await r.text(), npix);
    if (url) return { url, via: 'sia2', notes: [`Cube URL from IRSA SIA2 (${SIA_COLLECTION}); filename tile matches the computed HEALPix tile ${npix}.`] };
    notes.push('SIA2 returned no usable rows for this position; used the documented archive directory layout instead.');
  } catch (e) {
    if (e instanceof ServiceError && e.kind === 'parse') throw e;
    notes.push(`SIA2 lookup failed (${e instanceof Error ? e.message : String(e)}); used the documented archive directory layout instead.`);
  }
  return { url: directCubeUrl(npix), via: 'direct-url', notes };
}

/** OPTIONAL provider: IRSA SIA2 (+ on-prem archive). Used only when passed explicitly; never required for AWS loading. */
export const irsaAllSkyProvider: AllSkyProvider = {
  id: 'irsa',
  label: 'IRSA (SIA2 / on-prem archive)',
  candidateId: () => null,
  async locate(pos, npix): Promise<CubeLocation> {
    const r = await resolveCubeUrl(pos, npix);
    return {
      url: r.url, key: null, via: r.via, notes: r.notes, objectSize: null, etag: null, lastModified: null,
      fetcher: (range) => fetchWithProxyFallback(r.url, range ? { headers: { Range: `bytes=${range[0]}-${range[1]}` } } : {}, 60_000),
    };
  },
};

// ---------------------------------------------------------------- spectral channel table

const UNIT_TO_UM: Record<string, number> = { um: 1, micron: 1, microns: 1, μm: 1, µm: 1, nm: 1e-3, angstrom: 1e-4, angstroms: 1e-4, m: 1e6 };
const LO = new Set(['min', 'lo', 'low', 'lower', 'start', 'blue', 'left', 'lbound']);
const HI = new Set(['max', 'hi', 'high', 'upper', 'stop', 'end', 'red', 'right', 'ubound']);
const CEN = new Set(['cen', 'center', 'centre', 'central', 'mid', 'median', 'cwave', 'wave', 'wavelength', 'lambda', 'lam', 'wl']);
const IDX = new Set(['channel', 'chan', 'ch', 'index', 'idx', 'id', 'plane', 'layer']);

function columnKind(name: string): 'lo' | 'hi' | 'center' | 'index' | 'other' {
  const n = name.toLowerCase();
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => LO.has(t)) || /(min|low)$/.test(n)) return 'lo';
  if (tokens.some((t) => HI.has(t)) || /(max|high)$/.test(n)) return 'hi';
  if (tokens.some((t) => CEN.has(t)) || /(cen|center|wave|lambda)/.test(n)) return 'center';
  if (tokens.some((t) => IDX.has(t))) return 'index';
  return 'other';
}

export interface SpectralChannels {
  wavelengthsUm: (number | null)[] | null;
  edgesUm: ([number, number] | null)[] | null;
  column: string | null;
  notes: string[];
}

/** Validate a wavelength column: ≥90% finite, strictly increasing over finite entries, all within the SPHEREx range. */
function validWavelengths(values: (number | null)[], unitHint: string | null): (number | null)[] | null {
  const f = unitHint ? UNIT_TO_UM[unitHint.trim().toLowerCase()] : undefined;
  const conv = values.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * (f ?? 1) : null));
  const finite = conv.filter((v): v is number => v !== null);
  if (finite.length < 0.9 * values.length) return null;
  if (f === undefined && !finite.every((v) => v >= 0.5 && v <= 6)) return null; // no unit stated: accept only plausible micron values
  if (!finite.every((v) => v >= 0.7 && v <= 5.1)) return null;
  for (let i = 1; i < finite.length; i++) if (!(finite[i] > finite[i - 1])) return null;
  return conv;
}

export function parseSpectralChannels(file: FitsFile, hdu: FitsHdu, depth: number): SpectralChannels {
  const none = (note: string): SpectralChannels => ({ wavelengthsUm: null, edgesUm: null, column: null, notes: [note] });
  let table;
  try { table = readBinTable(file, hdu); } catch (e) { return none(`SPECTRAL_CHANNELS table could not be read (${e instanceof Error ? e.message : String(e)}); no wavelengths shown.`); }
  const names = table.columns.map((c) => c.name).join(', ');
  if (table.nrows !== depth) return none(`SPECTRAL_CHANNELS has ${table.nrows} rows but the cube has ${depth} channels; no wavelengths shown (columns: ${names}).`);

  // Row r describes plane r; if an explicit channel-index column exists, order by it.
  const idxCol = table.columns.findIndex((c, i) => columnKind(c.name) === 'index' && table.rows.every((r) => typeof r[i] === 'number'));
  const order = table.rows.map((_, r) => r);
  if (idxCol >= 0) order.sort((a, b) => (table.rows[a][idxCol] as number) - (table.rows[b][idxCol] as number));
  const col = (i: number): (number | null)[] => order.map((r) => (typeof table.rows[r][i] === 'number' ? (table.rows[r][i] as number) : null));
  const cands = table.columns.map((c, i) => ({ c, i, kind: columnKind(c.name) })).filter((x) => x.kind === 'center');
  const micronFirst = [...cands].sort((a, b) => Number(!!UNIT_TO_UM[(b.c.unit ?? '').trim().toLowerCase()]) - Number(!!UNIT_TO_UM[(a.c.unit ?? '').trim().toLowerCase()]));
  for (const cand of micronFirst) {
    const wl = validWavelengths(col(cand.i), cand.c.unit);
    if (!wl) continue;
    const notes = [`Wavelengths from the file's SPECTRAL_CHANNELS table, column '${cand.c.name}'${cand.c.unit ? ` [${cand.c.unit}]` : ' (no unit stated; values lie in the 0.7–5.1 µm range)'}.`];
    const lo = table.columns.findIndex((c) => columnKind(c.name) === 'lo');
    const hi = table.columns.findIndex((c) => columnKind(c.name) === 'hi');
    let edges: ([number, number] | null)[] | null = null;
    if (lo >= 0 && hi >= 0) {
      const l = validWavelengths(col(lo), table.columns[lo].unit);
      const h = validWavelengths(col(hi), table.columns[hi].unit);
      if (l && h) {
        edges = wl.map((w, k) => (w !== null && l[k] !== null && h[k] !== null && l[k]! <= w && w <= h[k]! ? [l[k]!, h[k]!] as [number, number] : null));
        notes.push(`Channel edges from '${table.columns[lo].name}' / '${table.columns[hi].name}'.`);
      }
    }
    return { wavelengthsUm: wl, edgesUm: edges, column: cand.c.name, notes };
  }
  return none(`SPECTRAL_CHANNELS was read but no column passed wavelength validation (102 rows, increasing, 0.7–5.1 µm). Columns found: ${names}. No wavelengths are shown (none are assumed).`);
}

// ---------------------------------------------------------------- blank channels

export function parseBlankCh(v: HeaderValue | undefined): number[] {
  if (typeof v === 'number') return [v];
  if (typeof v === 'string') return (v.match(/\d+/g) ?? []).map(Number);
  return [];
}

export function planeIsBlank(s: Float32Array): boolean {
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (v === v && v !== 0) return false; // finite-or-inf and non-zero
  }
  return true;
}

/** Combine data-detected blank planes (0-based) with BLANKCH (the docs number channels from 1). */
export function resolveBlankChannels(dataBlank: number[], blankch: number[], depth: number): { blank: number[]; note: string } {
  const ch = (a: number[]) => a.map((i) => i + 1).join(', ');
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
  if (blankch.length === 0) {
    return { blank: dataBlank, note: dataBlank.length ? `No BLANKCH keyword found; channel(s) ${ch(dataBlank)} contain no data and are treated as blank.` : '' };
  }
  const asOne = blankch.map((n) => n - 1);
  if (same(asOne, dataBlank)) return { blank: dataBlank, note: `BLANKCH lists channel(s) ${blankch.join(', ')} and the data confirm that exactly those planes hold no data.` };
  if (same(blankch, dataBlank)) return { blank: dataBlank, note: `BLANKCH lists ${blankch.join(', ')}; the data show those are 0-based plane indices (channels ${ch(dataBlank)}).` };
  const union = [...new Set([...dataBlank, ...asOne.filter((i) => i >= 0 && i < depth)])].sort((a, b) => a - b);
  return { blank: union, note: `BLANKCH lists ${blankch.join(', ')} but the data show blank planes at channel(s) ${dataBlank.length ? ch(dataBlank) : 'none'}; treating channel(s) ${ch(union)} as blank.` };
}

// ---------------------------------------------------------------- assembling the cube

export function isAllSkyImageHdu(hdu: FitsHdu): boolean {
  const name = hdu.extname.toUpperCase();
  return (name === 'IMAGE' || (hdu.index === 0 && name === 'PRIMARY')) && hdu.isImage && hdu.naxis.length === 3 && hdu.naxis[2] === ALLSKY_DEPTH && hdu.naxis[0] === hdu.naxis[1];
}

export interface AllSkyBuild { cube: SpectralCube; notes: string[] }

export function buildAllSkyCube(
  img: { file: FitsFile; hdu: FitsHdu },
  tab: { file: FitsFile; hdu: FitsHdu } | null,
  otherHeaders: FitsHeader[] = [],
): AllSkyBuild {
  const notes: string[] = [];
  const cube = toSpectralCube(img.file, img.hdu);
  if (tab) {
    const sc = parseSpectralChannels(tab.file, tab.hdu, cube.depth);
    notes.push(...sc.notes);
    if (sc.wavelengthsUm) cube.wavelengthsUm = sc.wavelengthsUm;
    cube.wavelengthEdgesUm = sc.edgesUm;
  } else {
    notes.push('No SPECTRAL_CHANNELS table was found in the file; no wavelengths are shown (none are assumed).');
  }
  const dataBlank: number[] = [];
  // Scan with transient planes (readPlane): cube.readSlice would cache all 102 Float32 planes (~107 MB extra heap).
  for (let k = 0; k < cube.depth; k++) if (planeIsBlank(readPlane(img.file, img.hdu, k))) dataBlank.push(k);
  const headers = [img.hdu.header, ...(tab ? [tab.hdu.header] : []), ...otherHeaders];
  const blankch = parseBlankCh(headers.find((h) => h['BLANKCH'] !== undefined)?.['BLANKCH']?.value);
  const resolved = resolveBlankChannels(dataBlank, blankch, cube.depth);
  cube.blankChannels = resolved.blank;
  if (resolved.note) notes.push(resolved.note);
  if (!cube.wcs) notes.push('The tile is in the HEALPix (HPX) projection, which this viewer does not convert: it is shown in tile pixel space with no sky grid or RA/Dec readout.');
  notes.push('The All-Sky Cube has zodiacal light subtracted (unlike Level-2 images). Stripes near bright emission lines (e.g. He 1.083 µm) are known mosaic artifacts.');
  return { cube, notes };
}

// ---------------------------------------------------------------- loading

export type LoadPhase = 'discovering' | 'downloading' | 'validating';
export interface LoadProgress { phase: LoadPhase; stage: string; received: number; total: number | null }

/** What would be transferred, shown to the user BEFORE any large download starts. */
export interface DownloadPlan {
  tile: { order: number; npix: number };
  location: CubeLocation;
  transport: 'range' | 'stream';
  /** IMAGE layer (+ a small channel table). NHITS/FLAGS are not downloaded. */
  downloadBytes: number;
  fileBytes: number | null;
  shape: [number, number, number];
}

export interface LoadOptions {
  isCancelled?: () => boolean;
  /** Aborts in-flight requests (not just between chunks). */
  signal?: AbortSignal;
  onProgress?: (p: LoadProgress) => void;
  /** Default: AWS S3. Pass `irsaAllSkyProvider` for the optional IRSA route. */
  provider?: AllSkyProvider;
  /** Default: browser Cache API when available. `null` disables caching. */
  cache?: CubeCache | null;
  /** Called with the plan before the IMAGE layer is transferred; false → CancelledError. If omitted, plans above DEFAULT_AUTO_DOWNLOAD_BYTES are refused. */
  authorize?: (plan: DownloadPlan) => boolean | Promise<boolean>;
}

const SUPPORTED_BITPIX = new Set([-32, -64, 8, 16, 32, 64]);

const sameObject = (a: { etag: string | null; objectSize: number | null; lastModified: string | null }, b: { etag: string | null; fileBytes: number | null; lastModified: string | null }): boolean => {
  if (a.etag && b.etag) return a.etag === b.etag;
  if (a.objectSize === null || b.fileBytes === null || a.objectSize !== b.fileBytes) return false;
  return !(a.lastModified && b.lastModified) || a.lastModified === b.lastModified;
};

/** The ArrayBuffer behind `u8`, without copying when the view covers all of it (~107 MB must not be duplicated). */
const ownBuffer = (u8: Uint8Array): ArrayBuffer =>
  (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)) as ArrayBuffer;

function buildResult(
  tile: { order: number; npix: number }, location: Pick<CubeLocation, 'url' | 'key' | 'via'>, transport: CubeInfo['transport'],
  headers: FitsHeader[], image: { hdu: FitsHdu; bytes: Uint8Array }, table: { hdu: FitsHdu; bytes: Uint8Array } | null, leadNotes: string[], transferNote: string,
): { cube: SpectralCube; info: CubeInfo } {
  const imgFile: FitsFile = { buffer: ownBuffer(image.bytes), hdus: [] };
  const tabFile: FitsFile | null = table ? { buffer: ownBuffer(table.bytes), hdus: [] } : null;
  const built = buildAllSkyCube(
    { file: imgFile, hdu: { ...image.hdu, dataOffset: 0 } },
    tabFile && table ? { file: tabFile, hdu: { ...table.hdu, dataOffset: 0 } } : null,
    headers,
  );
  const info: CubeInfo = {
    kind: 'allsky-dr1',
    product: `SPHEREx DR1 All-Sky Cube tile Npix${tile.npix} (HEALPix order ${tile.order}, NESTED)`,
    tile: tile.npix, url: location.url, key: location.key, resolvedVia: location.via, transport,
    bytesRead: image.bytes.length + (table?.bytes.length ?? 0),
    notes: [...leadNotes, transferNote, ...built.notes],
  };
  return { cube: built.cube, info };
}

/**
 * Load the DR1 All-Sky Cube tile covering `pos`.
 * Stages: discovering (locate + read headers) → [authorisation] → downloading → validating → result.
 * A previously downloaded copy is used when the archive says it is unchanged, or when the archive cannot be reached.
 */
export async function loadAllSkyCubeTile(pos: SkyPosition, opts: LoadOptions = {}): Promise<{ cube: SpectralCube; info: CubeInfo }> {
  const provider = opts.provider ?? awsAllSkyProvider;
  const cache = opts.cache === undefined ? defaultCubeCache() : opts.cache;
  const cancelled = () => !!(opts.isCancelled?.() || opts.signal?.aborted);
  const check = () => { if (cancelled()) throw new CancelledError(); };
  let lastEmit = 0;
  const emit = (phase: LoadPhase, stage: string, received: number, total: number | null, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    opts.onProgress?.({ phase, stage, received, total });
  };
  const tile = allSkyTile(pos);
  const ctx = { signal: opts.signal, isCancelled: cancelled };
  const candidate = provider.candidateId(tile.npix);

  // 1. a local copy?
  let cached: CachedCube | null = null;
  if (cache && candidate) { try { cached = await cache.get(candidate); } catch { cached = null; } }
  let location: CubeLocation | null = null;
  const cacheNotes: string[] = [];
  if (cached) {
    emit('discovering', `Found a local copy of tile ${tile.npix}; checking ${provider.label} for changes…`, 0, null, true);
    try {
      location = await provider.locate(pos, tile.npix, ctx);
      if (sameObject(location, cached.meta)) cacheNotes.push('Local copy is current: it matches the archive object (ETag/size).');
      else { cacheNotes.push('The archive object changed since it was cached; downloading the new version.'); cached = null; }
    } catch (e) {
      if (e instanceof CancelledError || cancelled()) throw new CancelledError();
      cacheNotes.push(`The archive could not be checked (${e instanceof Error ? e.message : String(e)}); using the previously downloaded local copy, which was not revalidated.`);
    }
  }
  if (cached) {
    emit('validating', 'Reading the local copy…', 0, null, true);
    const m = cached.meta;
    return buildResult(
      { order: ALLSKY_ORDER, npix: m.tile }, { url: m.url, key: m.key, via: m.via }, 'cache', m.headers,
      { hdu: m.imageHdu, bytes: cached.image }, cached.table && m.tableHdu ? { hdu: m.tableHdu, bytes: cached.table } : null,
      [...(location?.notes ?? []), ...cacheNotes],
      `Served from the local cache (no download); originally fetched ${new Date(m.storedAt).toISOString().slice(0, 19)}Z.`,
    );
  }

  // 2. locate + open + read headers up to the IMAGE HDU (a few KB)
  emit('discovering', `Locating All-Sky Cube tile ${tile.npix} via ${provider.label}…`, 0, null, true);
  if (!location) location = await provider.locate(pos, tile.npix, ctx);
  check();
  emit('discovering', 'Opening the cube file…', 0, null, true);
  let src: ByteSource;
  try {
    src = await openByteSource(location.fetcher, cancelled, location.objectSize);
  } catch (e) {
    const status = e instanceof ServiceError || e instanceof AwsError ? e.status : undefined;
    if (status === 404) {
      throw new AwsError(`${provider.label} has no All-Sky Cube file for HEALPix tile ${tile.npix} at ${location.url} (HTTP 404). The tile may not be published yet, or the DR1 cube directory has moved.`, 'not_found', 404, location.key ?? undefined);
    }
    throw e;
  }
  try {
    const headers: FitsHeader[] = [];
    let image: FitsHdu | null = null;
    let sawLevel2Hint = false;
    let off = 0;
    let index = 0;
    for (; index < 16 && !image; index++) {
      emit('discovering', `Reading FITS extension ${index + 1}…`, 0, null);
      let parsed: { header: FitsHeader; end: number };
      try { parsed = await readHeaderAt(src, off); } catch (e) { if (isEndOfFile(e)) break; throw e; }
      const hdu = makeHdu(index, parsed.header, parsed.end);
      headers.push(parsed.header);
      if (/^(EPSF|PSF)$/.test(hdu.extname.toUpperCase())) sawLevel2Hint = true;
      if (isAllSkyImageHdu(hdu)) image = hdu; else off = nextHduOffset(hdu);
    }
    if (!image) {
      throw new AwsError(
        `This file is not a SPHEREx All-Sky Cube: no IMAGE extension with ${ALLSKY_DEPTH} planes was found${sawLevel2Hint ? ' (it looks like a Level-2 exposure with a PSF cube, which is not a spectral cube)' : ''}.`,
        'unsupported_product',
      );
    }
    if (!SUPPORTED_BITPIX.has(image.bitpix)) throw new AwsError(`The cube IMAGE has unsupported BITPIX ${image.bitpix}.`, 'unsupported_product');
    if (image.dataBytes > MAX_CUBE_IMAGE_BYTES) throw new AwsError(`The cube IMAGE layer is ${(image.dataBytes / 1e6).toFixed(0)} MB, above this application's ${(MAX_CUBE_IMAGE_BYTES / 1e6).toFixed(0)} MB safety cap.`, 'too_large');
    const fileBytes = src.totalSize ?? location.objectSize;
    if (fileBytes !== null && image.dataOffset + image.dataBytes > fileBytes) {
      throw new AwsError(`The file is ${fileBytes} bytes but its headers describe an IMAGE layer ending at byte ${image.dataOffset + image.dataBytes}: truncated or corrupt object.`, 'truncated');
    }

    // 3. plan + authorisation (no large transfer has started)
    const plan: DownloadPlan = { tile, location, transport: src.mode, downloadBytes: image.dataBytes, fileBytes, shape: [image.naxis[0], image.naxis[1], image.naxis[2]] };
    if (opts.authorize) {
      if (!(await opts.authorize(plan))) throw new CancelledError();
    } else if (plan.downloadBytes > DEFAULT_AUTO_DOWNLOAD_BYTES) {
      throw new AwsError(`Downloading this tile transfers ${(plan.downloadBytes / 1e6).toFixed(0)} MB; this was not authorised, so nothing was downloaded.`, 'authorization_required');
    }
    check();

    // 4. download IMAGE, then locate and read the channel table
    const total = image.dataBytes;
    const stage = `Downloading IMAGE layer (${(total / 1e6).toFixed(0)} MB, ${image.naxis[2]} channels)…`;
    emit('downloading', stage, 0, total, true);
    const bytes = await src.read(image.dataOffset, total, (done) => emit('downloading', stage, done, total));
    if (bytes.length < total) throw new AwsError(`Download ended early: got ${bytes.length} of ${total} bytes of the IMAGE layer.`, 'truncated');
    emit('downloading', src.mode === 'stream' ? 'Server does not support partial downloads: streaming past NHITS/FLAGS to reach the wavelength table…' : 'Reading the channel table…', total, total, true);
    let table: { hdu: FitsHdu; bytes: Uint8Array } | null = null;
    off = nextHduOffset(image);
    for (index = image.index + 1; index < 16; index++) {
      let parsed: { header: FitsHeader; end: number };
      try { parsed = await readHeaderAt(src, off); } catch (e) { if (isEndOfFile(e)) break; throw e; }
      const hdu = makeHdu(index, parsed.header, parsed.end);
      headers.push(parsed.header);
      if (hdu.extname.toUpperCase() === 'SPECTRAL_CHANNELS' && hdu.dataBytes > 0 && hdu.dataBytes < 16 << 20) {
        table = { hdu, bytes: await src.read(parsed.end, hdu.dataBytes) };
        break;
      }
      off = nextHduOffset(hdu);
    }

    // 5. validate + assemble
    emit('validating', 'Validating FITS structure and spectral channels…', total, total, true);
    check();
    const result = buildResult(
      tile, location, src.mode, headers, { hdu: image, bytes }, table, [...location.notes, ...cacheNotes],
      `Downloaded only the IMAGE layer${table ? ' and the channel table' : ''} (${src.mode === 'range' ? 'HTTP Range requests' : 'forward stream; NHITS/FLAGS were discarded'}).`,
    );
    if (cache && candidate) {
      const stored = await cache.put({
        meta: {
          id: candidate, tile: tile.npix, key: location.key, url: location.url, via: location.via === 'local-file' ? 'direct-url' : location.via,
          etag: location.etag, lastModified: location.lastModified, fileBytes, storedAt: Date.now(),
          imageHdu: image, tableHdu: table?.hdu ?? null, headers, notes: location.notes,
        },
        image: bytes, table: table?.bytes ?? null,
      });
      result.info.notes.push(stored ? 'Saved to the local cache for offline / repeat use.' : 'Could not save to the local cache (storage unavailable or full); it will be downloaded again next time.');
    }
    return result;
  } finally {
    src.close();
  }
}

// ---------------------------------------------------------------- lazy (per-channel) loading

export interface LazyOptions extends LoadOptions {
  /** 0-based channel to fetch first (default: first channel that is not blank). */
  initialChannel?: number;
}

/** Cube whose channels are fetched on demand. Headers + channel table are read once; each plane is one Range request. */
function buildLazyAllSkyCube(
  image: FitsHdu, tab: { hdu: FitsHdu; bytes: Uint8Array } | null, headers: FitsHeader[],
  fetchPlane: (k: number) => Promise<Uint8Array>, live: { stopped: boolean }, dispose: () => void,
): AllSkyBuild {
  const notes: string[] = [];
  const cube = toSpectralCube({ buffer: new ArrayBuffer(0), hdus: [] }, image);
  const [w, h] = image.naxis;
  const planeBytes = w * h * (Math.abs(image.bitpix) / 8);
  if (tab) {
    const sc = parseSpectralChannels({ buffer: ownBuffer(tab.bytes), hdus: [] }, { ...tab.hdu, dataOffset: 0 }, cube.depth);
    notes.push(...sc.notes);
    if (sc.wavelengthsUm) cube.wavelengthsUm = sc.wavelengthsUm;
    cube.wavelengthEdgesUm = sc.edgesUm;
  } else {
    notes.push('No SPECTRAL_CHANNELS table was found in the file; no wavelengths are shown (none are assumed).');
  }
  const blankch = parseBlankCh(headers.find((x) => x['BLANKCH'] !== undefined)?.['BLANKCH']?.value);
  cube.blankChannels = [...new Set(blankch.map((n) => n - 1).filter((i) => i >= 0 && i < cube.depth))].sort((a, b) => a - b);
  notes.push(cube.blankChannels.length
    ? `BLANKCH lists channel(s) ${blankch.join(', ')} (numbered from 1 per the SPHEREx docs); in on-demand mode they are not read, and any other channel found empty when loaded is also treated as blank.`
    : 'No BLANKCH keyword found; a channel found empty when loaded is treated as blank.');
  if (!cube.wcs) notes.push('The tile is in the HEALPix (HPX) projection, which this viewer does not convert: it is shown in tile pixel space with no sky grid or RA/Dec readout.');
  notes.push('The All-Sky Cube has zodiacal light subtracted (unlike Level-2 images). Stripes near bright emission lines (e.g. He 1.083 µm) are known mosaic artifacts.');

  const placeholder = new Float32Array(w * h).fill(NaN);
  const inflight = new Map<number, Promise<void>>();
  cube.readSlice = (i: number) => cube.slices[i] ?? placeholder;
  cube.lazy = {
    bytesPerChannel: planeBytes,
    isLoaded: (i) => cube.slices[i] != null,
    loadedCount: () => cube.slices.filter((x) => x != null).length,
    load(i) {
      if (!Number.isInteger(i) || i < 0 || i >= cube.depth) return Promise.reject(new Error(`Channel ${i + 1} is outside 1–${cube.depth}`));
      if (cube.slices[i]) return Promise.resolve();
      const running = inflight.get(i);
      if (running) return running;
      const p = (async () => {
        if (live.stopped) throw new CancelledError();
        const bytes = await fetchPlane(i);
        if (bytes.length < planeBytes) throw new AwsError(`Channel ${i + 1}: got ${bytes.length} of ${planeBytes} bytes (truncated download).`, 'truncated');
        const plane = readPlane({ buffer: ownBuffer(bytes), hdus: [] }, { ...image, naxis: [w, h], dataOffset: 0, dataBytes: planeBytes }, 0);
        if (live.stopped) throw new CancelledError();
        cube.slices[i] = plane;
        if (planeIsBlank(plane) && !cube.blankChannels!.includes(i)) cube.blankChannels = [...cube.blankChannels!, i].sort((a, b) => a - b);
      })().finally(() => { inflight.delete(i); });
      inflight.set(i, p);
      return p;
    },
    dispose,
  };
  return { cube, notes };
}

/**
 * Open the DR1 All-Sky Cube tile covering `pos` WITHOUT downloading the IMAGE layer: only the FITS headers, the channel
 * table and ONE channel (~1 MB) are read; other channels are fetched when `cube.lazy.load(i)` is called. Offsets come from
 * the headers (HDU hopping). Needs a server that honours HTTP Range; otherwise this falls back to `loadAllSkyCubeTile`
 * (full IMAGE layer, with the same authorisation rules).
 */
export async function loadAllSkyCubeLazy(pos: SkyPosition, opts: LazyOptions = {}): Promise<{ cube: SpectralCube; info: CubeInfo }> {
  const provider = opts.provider ?? awsAllSkyProvider;
  const live = { stopped: false };
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (opts.signal?.aborted) ctl.abort();
  const cancelled = () => ctl.signal.aborted || live.stopped || !!opts.isCancelled?.();
  const check = () => { if (cancelled()) throw new CancelledError(); };
  let lastEmit = 0;
  const emit = (phase: LoadPhase, stage: string, received: number, total: number | null, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    opts.onProgress?.({ phase, stage, received, total });
  };
  const tile = allSkyTile(pos);
  let src: ByteSource | null = null;
  let keep = false;
  try {
    emit('discovering', `Locating All-Sky Cube tile ${tile.npix} via ${provider.label}…`, 0, null, true);
    const location = await provider.locate(pos, tile.npix, { signal: ctl.signal, isCancelled: cancelled });
    check();
    emit('discovering', 'Opening the cube file…', 0, null, true);
    try {
      src = await openByteSource(location.fetcher, cancelled, location.objectSize);
    } catch (e) {
      const status = e instanceof ServiceError || e instanceof AwsError ? e.status : undefined;
      if (status === 404) throw new AwsError(`${provider.label} has no All-Sky Cube file for HEALPix tile ${tile.npix} at ${location.url} (HTTP 404). The tile may not be published yet, or the DR1 cube directory has moved.`, 'not_found', 404, location.key ?? undefined);
      throw e;
    }
    if (src.mode === 'stream') {
      // No Range support: channels cannot be fetched individually. Use the full-download path (explicit size/authorisation).
      src.close(); src = null;
      opts.signal?.removeEventListener('abort', onOuterAbort);
      return await loadAllSkyCubeTile(pos, opts);
    }
    const source = src;

    // Walk the HDU headers (a few KB) until both the IMAGE and the channel table are known.
    const headers: FitsHeader[] = [];
    let image: FitsHdu | null = null;
    let tabHdu: FitsHdu | null = null;
    let sawLevel2Hint = false;
    let off = 0;
    for (let index = 0; index < 16 && !(image && tabHdu); index++) {
      emit('discovering', `Reading FITS header ${index + 1}…`, 0, null);
      let parsed: { header: FitsHeader; end: number };
      try { parsed = await readHeaderAt(source, off); } catch (e) { if (isEndOfFile(e)) break; throw e; }
      const hdu = makeHdu(index, parsed.header, parsed.end);
      headers.push(parsed.header);
      const name = hdu.extname.toUpperCase();
      if (/^(EPSF|PSF)$/.test(name)) sawLevel2Hint = true;
      if (!image && isAllSkyImageHdu(hdu)) image = hdu;
      else if (!tabHdu && name === 'SPECTRAL_CHANNELS' && hdu.dataBytes > 0 && hdu.dataBytes < 16 << 20) tabHdu = hdu;
      off = nextHduOffset(hdu);
    }
    if (!image) {
      throw new AwsError(`This file is not a SPHEREx All-Sky Cube: no IMAGE extension with ${ALLSKY_DEPTH} planes was found${sawLevel2Hint ? ' (it looks like a Level-2 exposure with a PSF cube, which is not a spectral cube)' : ''}.`, 'unsupported_product');
    }
    if (!SUPPORTED_BITPIX.has(image.bitpix)) throw new AwsError(`The cube IMAGE has unsupported BITPIX ${image.bitpix}.`, 'unsupported_product');
    if (image.dataBytes > MAX_CUBE_IMAGE_BYTES) throw new AwsError(`The cube IMAGE layer is ${(image.dataBytes / 1e6).toFixed(0)} MB, above this application's ${(MAX_CUBE_IMAGE_BYTES / 1e6).toFixed(0)} MB safety cap.`, 'too_large');
    const fileBytes = source.totalSize ?? location.objectSize;
    if (fileBytes !== null && image.dataOffset + image.dataBytes > fileBytes) {
      throw new AwsError(`The file is ${fileBytes} bytes but its headers describe an IMAGE layer ending at byte ${image.dataOffset + image.dataBytes}: truncated or corrupt object.`, 'truncated');
    }
    let table: { hdu: FitsHdu; bytes: Uint8Array } | null = null;
    if (tabHdu) {
      const bytes = await source.read(tabHdu.dataOffset, tabHdu.dataBytes);
      if (bytes.length < tabHdu.dataBytes) throw new AwsError('The SPECTRAL_CHANNELS table is truncated.', 'truncated');
      table = { hdu: tabHdu, bytes };
    }
    check();

    const imageHdu = image;
    const planeBytes = (imageHdu.naxis[0] * imageHdu.naxis[1] * Math.abs(imageHdu.bitpix)) / 8;
    const built = buildLazyAllSkyCube(
      imageHdu, table, headers,
      (k) => source.read(imageHdu.dataOffset + k * planeBytes, planeBytes),
      live, () => { live.stopped = true; ctl.abort(); source.close(); },
    );
    const cube = built.cube;
    const first = opts.initialChannel ?? Math.max(0, [...Array(cube.depth).keys()].find((k) => !cube.blankChannels?.includes(k)) ?? 0);
    emit('downloading', `Downloading channel ${first + 1} (${(planeBytes / 1e6).toFixed(1)} MB)…`, 0, planeBytes, true);
    await cube.lazy!.load(first);
    emit('validating', 'Validating spectral channels…', planeBytes, planeBytes, true);
    check();
    const info: CubeInfo = {
      kind: 'allsky-dr1',
      product: `SPHEREx DR1 All-Sky Cube tile Npix${tile.npix} (HEALPix order ${tile.order}, NESTED)`,
      tile: tile.npix, url: location.url, key: location.key, resolvedVia: location.via, lazy: true, transport: 'range',
      bytesRead: planeBytes + (table?.bytes.length ?? 0),
      notes: [
        ...location.notes,
        `On-demand mode: only the headers, the channel table and channel ${first + 1} were read (${(planeBytes / 1e6).toFixed(1)} MB of the ${(imageHdu.dataBytes / 1e6).toFixed(0)} MB IMAGE layer); other channels are fetched with HTTP Range requests when opened.`,
        ...built.notes,
      ],
    };
    keep = true;
    opts.signal?.removeEventListener('abort', onOuterAbort);
    return { cube, info };
  } finally {
    if (!keep) {
      opts.signal?.removeEventListener('abort', onOuterAbort);
      src?.close();
    }
  }
}
