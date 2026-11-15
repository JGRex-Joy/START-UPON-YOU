/* AWS-route tests. ALL DATA HERE IS SYNTHETIC (mock S3 serving small hand-built FITS files): this verifies our logic,
 * NOT that the real bucket holds the products. Real-data verification: tests/live.ts. */
import { healpixNestedIndex } from '../src/services/healpix';
import { candidateCubeKey, awsAllSkyProvider } from '../src/services/aws/allSkyProvider';
import { configureS3, resetS3Config, parseListing } from '../src/services/aws/s3';
import { AwsError, CancelledError } from '../src/services/aws/errors';
import { MemoryCubeCache } from '../src/services/aws/cubeCache';
import { AllSkyCubeSession, type CubeLoadStatus } from '../src/services/aws/cubeSession';
import { cloudAccessToKey, cropSlab, findLevel2ByObservation, loadLevel2Window, onPremUriToS3Key, parseLevel2Key } from '../src/services/aws/level2';
import { loadAllSkyCubeLazy, loadAllSkyCubeTile } from '../src/services/spherex/allSkyCube';
import { discoverEpochs, mergeEpochs, parseSia2Level2 } from '../src/services/spherex/discovery';
import { loadEpochImage } from '../src/services/spherex';
import type { EpochEntry } from '../src/types';

let passed = 0; let failed = 0;
function check(name: string, cond: boolean, detail = '') { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${detail}`); } }
const errOf = async (f: () => Promise<unknown>): Promise<unknown> => { try { await f(); return null; } catch (e) { return e; } };

// ---------------- FITS builders (synthetic)
const card = (k: string, v: string | number | boolean, str = false) => `${k.padEnd(8)}= ${(str ? `'${v}'`.padEnd(20) : typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : String(v).padStart(20))}`.padEnd(80);
const hdr = (cards: string[]) => { const t = cards.join('') + 'END'.padEnd(80); return new TextEncoder().encode(t.padEnd(Math.ceil(t.length / 2880) * 2880)); };
const pad = (b: Uint8Array) => { const o = new Uint8Array(Math.ceil(b.length / 2880) * 2880); o.set(b); return o; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, b) => a + b.length, 0)); let n = 0; for (const x of p) { o.set(x, n); n += x.length; } return o; };
const prim = () => hdr([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true)]);
function imageExt(name: string, bitpix: number, dims: number[], f: (i: number) => number, extra: string[] = []) {
  const n = dims.reduce((a, b) => a * b, 1); const bp = Math.abs(bitpix) / 8; const d = new Uint8Array(n * bp); const dv = new DataView(d.buffer);
  for (let i = 0; i < n; i++) { if (bitpix === -32) dv.setFloat32(i * 4, f(i)); else if (bitpix === 16) dv.setInt16(i * 2, f(i)); else dv.setInt32(i * 4, f(i)); }
  return cat(hdr([card('XTENSION', 'IMAGE', true), card('BITPIX', bitpix), card('NAXIS', dims.length), ...dims.map((x, i) => card(`NAXIS${i + 1}`, x)), card('PCOUNT', 0), card('GCOUNT', 1), card('EXTNAME', name, true), ...extra]), pad(d));
}
function table(name: string, cols: { name: string; unit?: string; values: number[] }[]) {
  const nrows = cols[0].values.length; const rb = cols.length * 8; const d = new Uint8Array(rb * nrows); const dv = new DataView(d.buffer);
  cols.forEach((c, ci) => c.values.forEach((v, r) => dv.setFloat64(r * rb + ci * 8, v)));
  const cs = [card('XTENSION', 'BINTABLE', true), card('BITPIX', 8), card('NAXIS', 2), card('NAXIS1', rb), card('NAXIS2', nrows), card('PCOUNT', 0), card('GCOUNT', 1), card('TFIELDS', cols.length)];
  cols.forEach((c, i) => { cs.push(card(`TTYPE${i + 1}`, c.name, true), card(`TFORM${i + 1}`, 'D', true)); if (c.unit) cs.push(card(`TUNIT${i + 1}`, c.unit, true)); });
  cs.push(card('EXTNAME', name, true));
  return cat(hdr(cs), pad(d));
}
const W = 8;
const wl = (k: number) => 0.75 + k * (4.25 / 101);
const cubeFile = () => cat(
  prim(),
  imageExt('IMAGE', -32, [W, W, 102], (i) => { const k = Math.floor(i / (W * W)); return k === 50 || k === 51 ? NaN : k + 1; }, [card('BUNIT', 'MJy/sr', true), card('BLANKCH', '51,52', true)]),
  imageExt('NHITS', 16, [W, W, 102], () => 3),
  imageExt('FLAGS', 32, [W, W, 102], () => 0),
  table('SPECTRAL_CHANNELS', [{ name: 'CHANNEL', values: Array.from({ length: 102 }, (_, k) => k + 1) }, { name: 'LAMBDA_CENTER', unit: 'um', values: Array.from({ length: 102 }, (_, k) => wl(k)) }]),
);
// Level-2: 2-D 100x60 IMAGE (value = x + 1000*y), TAN WCS centred on (150, 2), 6.15"/px; other HDUs before IMAGE to prove no fixed order.
const L2W = 100; const L2H = 60;
const level2File = () => cat(
  hdr([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true), card('DETECTOR', 2)]),
  imageExt('FLAGS', 32, [L2W, L2H], () => 0),
  imageExt('IMAGE', -32, [L2W, L2H], (i) => (i % L2W) + 1000 * Math.floor(i / L2W), [
    card('BUNIT', 'MJy/sr', true), card('CTYPE1', 'RA---TAN', true), card('CTYPE2', 'DEC--TAN', true), card('CRPIX1', 50.5), card('CRPIX2', 30.5),
    card('CRVAL1', 150), card('CRVAL2', 2), card('CD1_1', -6.15 / 3600), card('CD1_2', 0), card('CD2_1', 0), card('CD2_2', 6.15 / 3600),
  ]),
);

// ---------------- mock S3
interface Mock { objects: Map<string, Uint8Array>; range: boolean; log: { method: string; url: string; range?: string; auth: boolean }[]; failWith?: (url: string, n: number) => number | null; served: number; hits: number }
function mock(objects: Record<string, Uint8Array>, o: { range?: boolean; failWith?: Mock['failWith'] } = {}): Mock {
  const m: Mock = { objects: new Map(Object.entries(objects)), range: o.range ?? true, log: [], failWith: o.failWith, served: 0, hits: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input)); const method = init?.method ?? 'GET'; const h = (init?.headers ?? {}) as Record<string, string>;
    m.log.push({ method, url: u.pathname + u.search, range: h['Range'], auth: !!h['Authorization'] }); m.hits++;
    const forced = m.failWith?.(u.pathname + u.search, m.hits);
    if (forced) return new Response(`<Error><Code>X</Code><Message>forced ${forced}</Message></Error>`, { status: forced });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (u.pathname === '/' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? ''; const delim = u.searchParams.get('delimiter');
      const keys = [...m.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const prefixes = new Set<string>(); const contents: string[] = [];
      for (const k of keys) { const rest = k.slice(prefix.length); const i = delim ? rest.indexOf(delim) : -1; if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1)); else contents.push(`<Contents><Key>${k}</Key><Size>${m.objects.get(k)!.length}</Size><LastModified>2026-11-12T00:00:00.000Z</LastModified></Contents>`); }
      return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents.join('')}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    const key = decodeURIComponent(u.pathname.slice(1)); const obj = m.objects.get(key);
    if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: method === 'HEAD' ? 404 : 404 });
    const base = { 'content-type': 'application/fits', etag: `"len${obj.length}"`, 'last-modified': 'Thu, 12 Nov 2026 00:00:00 GMT' };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'content-length': String(obj.length) } });
    const r = m.range ? /bytes=(\d+)-(\d+)/.exec(h['Range'] ?? '') : null;
    if (r) { const a = Number(r[1]); const b = Math.min(Number(r[2]), obj.length - 1); const body = obj.slice(a, b + 1); m.served += body.length; return new Response(body, { status: 206, headers: { ...base, 'content-range': `bytes ${a}-${b}/${obj.length}` } }); }
    m.served += obj.length; return new Response(obj.slice(), { status: 200, headers: base });
  }) as typeof fetch;
  return m;
}

const pos = { ra: 133.795129, dec: -7.245147 };
const NPIX = 10226;
const KEY = 'dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10226_cube.fits';
const realFetch = globalThis.fetch;
const FAST = { retryDelaysMs: [0, 0] };

async function main() {
  console.log('--- key resolution (pure)');
  check('WISE 0855 -> HEALPix order-5 NESTED Npix 10226', healpixNestedIndex(5, pos.ra, pos.dec) === NPIX);
  check('Npix 10226 -> documented-layout candidate key', candidateCubeKey(NPIX) === KEY, candidateCubeKey(NPIX));
  check('doc example Npix4659 -> Dir0', candidateCubeKey(4659) === 'dr1/hips5_cube/hips_20261026/Norder5/Dir0/Npix4659_cube.fits');
  check('Npix 12287 -> Dir10000', candidateCubeKey(12287).includes('/Dir10000/'));
  check('invalid npix rejected', (await errOf(async () => candidateCubeKey(-1))) instanceof Error);
  check('parseListing reads prefixes/objects', (() => { const l = parseListing('<ListBucketResult><CommonPrefixes><Prefix>a/</Prefix></CommonPrefixes><Contents><Key>a&amp;b</Key><Size>5</Size></Contents></ListBucketResult>'); return l.prefixes[0] === 'a/' && l.objects[0].key === 'a&b' && l.objects[0].size === 5; })());

  console.log('--- All-Sky via mock S3 (SYNTHETIC)');
  resetS3Config(); configureS3(FAST);
  let m = mock({ [KEY]: cubeFile() });
  const seen: string[] = [];
  const res = await loadAllSkyCubeTile(pos, { cache: null, authorize: (p) => { seen.push(`${p.transport}:${p.downloadBytes}`); return true; } });
  const imageBytes = W * W * 102 * 4;
  check('coordinate -> Npix -> S3 key -> parser -> SpectralCube', res.info.tile === NPIX && res.info.key === KEY && res.info.resolvedVia === 'aws-s3' && res.cube.depth === 102);
  check('pixel data is the file data', res.cube.readSlice(0)[0] === 1 && res.cube.readSlice(101)[5] === 102);
  check('wavelengths from SPECTRAL_CHANNELS; channels 51,52 blank', Math.abs((res.cube.wavelengthsUm?.[0] ?? 0) - 0.75) < 1e-6 && res.cube.blankChannels?.join() === '50,51');
  check('Range transport; NHITS/FLAGS not downloaded', res.info.transport === 'range' && m.served < imageBytes + 25_000, `served=${m.served}`);
  check('authorisation plan carried the exact IMAGE size before download', seen[0] === `range:${imageBytes}`, seen[0]);
  check('requests are anonymous (no Authorization header, no IRSA host)', m.log.every((l) => !l.auth) && m.log.every((l) => !l.url.includes('SIA')));
  check('HEAD verified the key first', m.log[0].method === 'HEAD' && m.log[0].url.endsWith('Npix10226_cube.fits'));

  m = mock({ [KEY]: cubeFile() }, { range: false });
  const rs = await loadAllSkyCubeTile(pos, { cache: null, authorize: () => true });
  check('server without Range -> stream fallback gives same cube', rs.info.transport === 'stream' && rs.cube.readSlice(101)[5] === 102 && rs.cube.blankChannels?.join() === '50,51');

  // A header-correct, real-size tile (512x512x102 float32 = 106.7 MB of zeros) to exercise the size gate.
  const bigImgHdr = hdr([card('XTENSION', 'IMAGE', true), card('BITPIX', -32), card('NAXIS', 3), card('NAXIS1', 512), card('NAXIS2', 512), card('NAXIS3', 102), card('PCOUNT', 0), card('GCOUNT', 1), card('EXTNAME', 'IMAGE', true)]);
  const bigData = new Uint8Array(512 * 512 * 102 * 4 + (2880 - ((512 * 512 * 102 * 4) % 2880)) % 2880);
  m = mock({ [KEY]: cat(prim(), bigImgHdr, bigData) });
  const tooBig = await errOf(() => loadAllSkyCubeTile(pos, { cache: null }));
  check('no authorize callback + 107 MB plan -> authorization_required, IMAGE not downloaded', tooBig instanceof AwsError && tooBig.code === 'authorization_required' && m.served < 20_000, `${tooBig} served=${m.served}`);
  m.served = 0;
  const plans: number[] = [];
  const declined = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: (p) => { plans.push(p.downloadBytes); return false; } }));
  check('declining the 107 MB plan -> CancelledError, IMAGE not downloaded', declined instanceof CancelledError && m.served < 20_000 && plans[0] === 512 * 512 * 102 * 4, `served=${m.served} plans=${plans}`);

  console.log('--- missing / unpublished / listing fallback');
  m = mock({ 'qr2/level2/x/y.fits': new Uint8Array(1), 'qr3/level2/x/y.fits': new Uint8Array(1) });
  let e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('no dr1/ prefix -> unpublished, says what exists, no QR substitution', e instanceof AwsError && e.code === 'unpublished' && e.message.includes('qr2') && e.message.includes('not substituted'), String(e));
  m = mock({ 'dr1/level2/a/b.fits': new Uint8Array(1) });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('dr1 without hips5_cube -> unpublished, lists dr1 contents', e instanceof AwsError && e.code === 'unpublished' && e.message.includes('level2'), String(e));
  m = mock({ 'dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10000_cube.fits': new Uint8Array(1) });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('cube tree exists but tile missing -> not_found with expected key', e instanceof AwsError && e.code === 'not_found' && e.message.includes(KEY), String(e));
  const moved = 'dr1/hips5_cube/hips_20270101/Norder5/Dir10000/Npix10226_cube.fits';
  m = mock({ [moved]: cubeFile() });
  const rl = await loadAllSkyCubeTile(pos, { cache: null, authorize: () => true });
  check('documented path absent but tile elsewhere -> found by listing the bucket', rl.info.key === moved && rl.info.notes.some((n) => n.includes('listing')), String(rl.info.key));

  console.log('--- HTTP errors, retries, interruptions');
  m = mock({ [KEY]: cubeFile() }, { failWith: (u) => (u.endsWith('_cube.fits') ? 403 : null) });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('HTTP 403 on HEAD+listing surfaces a typed error (no hang)', e instanceof AwsError, String(e));
  m = mock({ [KEY]: cubeFile() }, { failWith: (_u, n) => (n <= 2 ? 429 : null) });
  const r429 = await loadAllSkyCubeTile(pos, { cache: null, authorize: () => true });
  check('HTTP 429 is retried then succeeds', r429.cube.depth === 102);
  m = mock({ [KEY]: cubeFile() }, { failWith: () => 503 });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('persistent 503 -> server_error after retries', e instanceof AwsError && e.code === 'server_error', String(e));
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('network down -> network error with explanation', e instanceof AwsError && e.code === 'network' && e.message.includes('could not reach AWS S3'), String(e));

  const full = cubeFile();
  m = mock({ [KEY]: full.slice(0, 2880 * 3 + 5000) });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('truncated object (headers promise more than exists) -> truncated', e instanceof AwsError && e.code === 'truncated', String(e));
  m = mock({ [KEY]: new TextEncoder().encode('<html>not fits</html>'.padEnd(5000)) });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('non-FITS response -> invalid_response', e instanceof AwsError && e.code === 'invalid_response', String(e));
  m = mock({ [KEY]: level2File() });
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, authorize: () => true }));
  check('a Level-2 file where a cube was expected -> unsupported_product', e instanceof AwsError && e.code === 'unsupported_product', String(e));

  console.log('--- cancellation');
  m = mock({ [KEY]: cubeFile() });
  const ctl = new AbortController();
  e = await errOf(() => loadAllSkyCubeTile(pos, { cache: null, signal: ctl.signal, authorize: () => { ctl.abort(); return true; } }));
  check('abort after authorisation -> CancelledError, no image transfer', e instanceof CancelledError && m.served < 10_000, String(e));

  console.log('--- local cache');
  const cache = new MemoryCubeCache();
  m = mock({ [KEY]: cubeFile() });
  const first = await loadAllSkyCubeTile(pos, { cache, authorize: () => true });
  check('first load is stored', cache.size === 1 && first.info.notes.some((n) => n.includes('Saved to the local cache')));
  m.served = 0;
  const second = await loadAllSkyCubeTile(pos, { cache, authorize: () => { throw new Error('must not ask: nothing to download'); } });
  check('second load is served from cache, unchanged ETag, zero image bytes', second.info.transport === 'cache' && m.served === 0 && second.cube.readSlice(101)[5] === 102, `served=${m.served}`);
  globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
  const offline = await loadAllSkyCubeTile(pos, { cache, authorize: () => true });
  check('AWS unreachable -> cached copy still usable, flagged as not revalidated', offline.info.transport === 'cache' && offline.info.notes.some((n) => n.includes('not revalidated')));
  m = mock({ [KEY]: cat(cubeFile(), new Uint8Array(2880)) }); // object changed (size differs)
  const refreshed = await loadAllSkyCubeTile(pos, { cache, authorize: () => true });
  check('changed object invalidates the cache', refreshed.info.transport === 'range' && refreshed.info.notes.some((n) => n.includes('changed')));

  console.log('--- typed session states');
  m = mock({ [KEY]: cubeFile() });
  const states: CubeLoadStatus[] = [];
  const sess = new AllSkyCubeSession(); sess.subscribe((s) => { if (states[states.length - 1] !== s.status) states.push(s.status); if (s.status === 'awaiting_download_authorization') sess.authorize(); });
  const out = await sess.start(pos, { cache: null, full: true });
  check('idle→discovering→awaiting_download_authorization→downloading→validating→loaded', !!out && states.join('>').startsWith('discovering>awaiting_download_authorization>downloading') && states.at(-1) === 'loaded', states.join('>'));
  const s2 = new AllSkyCubeSession(); const st2: CubeLoadStatus[] = []; s2.subscribe((s) => { st2.push(s.status); if (s.status === 'awaiting_download_authorization') s2.cancel(); });
  check('cancel while awaiting authorisation -> cancelled', (await s2.start(pos, { cache: null, full: true })) === null && st2.at(-1) === 'cancelled', st2.join('>'));
  m = mock({});
  const s3 = new AllSkyCubeSession(); await s3.start(pos, { cache: null, full: true });
  check('failure ends in error state with a message', s3.state.status === 'error' && s3.state.message.length > 10);
  m = mock({ [KEY]: cubeFile() });
  const s4 = new AllSkyCubeSession(); let stale = 0; s4.subscribe(() => stale++);
  const p1 = s4.start(pos, { cache: null, full: true }); s4.reset(); await p1;
  check('a reset run cannot overwrite the newer state', s4.state.status === 'idle');

  console.log('--- on-demand (lazy) channels (SYNTHETIC mock)');
  const cubeBytes = cubeFile();
  m = mock({ [KEY]: cubeBytes });
  const lz = await loadAllSkyCubeLazy(pos, { cache: null });
  const rangeLen = (r?: string) => { const x = r ? /bytes=(\d+)-(\d+)/.exec(r) : null; return x ? Number(x[2]) - Number(x[1]) + 1 : Infinity; };
  const L = lz.cube.lazy!;
  check('lazy: cube opened without downloading the IMAGE layer', lz.info.lazy === true && lz.info.transport === 'range' && m.served < cubeBytes.length / 2 && m.log.every((l) => l.method === 'HEAD' || rangeLen(l.range) <= 2880 * 2), `served=${m.served}/${cubeBytes.length}`);
  check('lazy: first non-blank channel is loaded, a distant one is not', L.isLoaded(0) && !L.isLoaded(80) && L.loadedCount() === 1 && lz.cube.readSlice(0)[0] === 1);
  check('lazy: unloaded channel reads as NaN placeholder, never zero flux', Number.isNaN(lz.cube.readSlice(80)[0]));
  check('lazy: blank channels from BLANKCH are [50,51]; wavelengths from the table', lz.cube.blankChannels?.join() === '50,51' && Math.abs((lz.cube.wavelengthsUm?.[101] ?? 0) - wl(101)) < 1e-6);
  const before = m.log.length;
  await Promise.all([L.load(5), L.load(5), L.load(5)]);
  check('lazy: concurrent loads of one channel issue one request', m.log.length - before === 1 && L.isLoaded(5));
  check('lazy: loaded channel has the file values (channel k = k+1)', lz.cube.readSlice(5)[3] === 6);
  await L.load(101);
  check('lazy: last channel loads from the right offset', lz.cube.readSlice(101)[0] === 102);
  e = await errOf(() => L.load(500));
  check('lazy: out-of-range channel rejected', e instanceof Error);
  L.dispose();
  e = await errOf(() => L.load(70));
  check('lazy: after dispose() a load rejects with CancelledError', e instanceof CancelledError, String(e));
  check('lazy: already loaded channels stay readable after dispose', lz.cube.readSlice(5)[3] === 6);

  let breakIt = false;
  m = mock({ [KEY]: cubeFile() }, { failWith: (u) => (breakIt && u.includes('Npix') ? 503 : null) });
  configureS3({ retryDelaysMs: [] });
  const lz2 = await loadAllSkyCubeLazy(pos, { cache: null });
  breakIt = true;
  e = await errOf(() => lz2.cube.lazy!.load(40));
  check('lazy: a 503 fails only that channel; loaded ones still work', e instanceof AwsError && e.code === 'server_error' && lz2.cube.lazy!.isLoaded(0) && !lz2.cube.lazy!.isLoaded(40), String(e));
  configureS3(FAST);

  m = mock({ [KEY]: cubeFile() }, { range: false });
  const lz3 = await loadAllSkyCubeLazy(pos, { cache: null, authorize: () => true });
  check('lazy: server without Range falls back to a full stream load', lz3.info.transport === 'stream' && !lz3.cube.lazy && lz3.cube.readSlice(101)[0] === 102);

  m = mock({ [KEY]: cubeFile().slice(0, 2880 * 3 + 100) });
  e = await errOf(() => loadAllSkyCubeLazy(pos, { cache: null }));
  check('lazy: truncated object -> typed error', e instanceof AwsError && (e.code === 'truncated'), String(e));
  m = mock({});
  e = await errOf(() => loadAllSkyCubeLazy(pos, { cache: null }));
  check('lazy: absent tile -> not_found/unpublished (no substitution)', e instanceof AwsError && ['not_found', 'unpublished'].includes(e.code), String(e));
  const lc2 = new AbortController(); lc2.abort(); m = mock({ [KEY]: cubeFile() });
  check('lazy: aborted before start -> CancelledError', (await errOf(() => loadAllSkyCubeLazy(pos, { cache: null, signal: lc2.signal }))) instanceof CancelledError);
  m = mock({ [KEY]: cubeFile() });
  const sl = new AllSkyCubeSession(); const stl: CubeLoadStatus[] = []; sl.subscribe((s) => stl.push(s.status));
  const lres = await sl.start(pos, { cache: null });
  check('session default is on-demand: no authorisation step, ends loaded', !!lres?.cube.lazy && !stl.includes('awaiting_download_authorization') && sl.state.status === 'loaded', stl.join('>'));

  console.log('--- Level-2 (SYNTHETIC mock)');
  const L2KEY = 'dr1/level2/2026W20_2A/l2b-v27-2026-268/2/level2_2026W20_2A_0191_4D2_spx_l2b-v27-2026-268.fits';
  const k = parseLevel2Key(L2KEY);
  check('Level-2 key parsed per documented layout', !!k && k.planningPeriod === '2026W20_2A' && k.detector === 2 && k.observationId === '2026W20_2A_0191_4' && k.version === 27);
  check('mismatched detector in path vs file name rejected', parseLevel2Key(L2KEY.replace('/2/level2', '/3/level2')) === null);
  check('on-prem URL -> S3 key', onPremUriToS3Key('https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_2D1_spx_l2b-v27-2026-268.fits?center=1,2&size=0.1') === 'qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_2D1_spx_l2b-v27-2026-268.fits');
  check('cloud_access JSON -> key; other bucket rejected', cloudAccessToKey(JSON.stringify({ aws: { bucket_name: 'nasa-irsa-spherex', key: L2KEY } })) === L2KEY && cloudAccessToKey(JSON.stringify({ aws: { bucket_name: 'other', key: 'x' } })) === null && cloudAccessToKey('nope') === null);
  check('cropSlab picks the right columns', (() => { const s = Float32Array.from({ length: 12 }, (_, i) => i); const c = cropSlab(s, 4, 1, 2, 3); return c.join() === '1,2,5,6,9,10'; })());

  const l2 = level2File();
  m = mock({ [L2KEY]: l2 });
  const win = await loadLevel2Window(L2KEY, { ra: 150, dec: 2 }, 6.15 * 10 / 3600);
  const px = win.image.wcs ? win.image : null;
  check('IMAGE found by header walk even though FLAGS comes first', win.image.extname === 'IMAGE' && win.transport === 'range');
  check('only a row slab is transferred (not the whole file)', m.served < l2.length && win.bytesRead < l2.length + 1, `served=${m.served} file=${l2.length}`);
  const [ox, oy] = win.origin;
  check('window pixels equal the file pixels (x + 1000 y)', win.image.data[0] === ox + 1000 * oy && win.image.data[win.image.width + 1] === ox + 1 + 1000 * (oy + 1));
  check('shifted WCS still maps the target to the same sky position', !!px && Math.abs(((await import('../src/services/fits/wcs')).pixelToSky(px.wcs!, 49.5 - ox, 29.5 - oy).ra) - 150) < 1e-6);
  e = await errOf(() => loadLevel2Window(L2KEY, { ra: 10, dec: 60 }, 0.01));
  check('target outside the exposure -> outside_footprint', e instanceof AwsError && e.code === 'outside_footprint', String(e));
  const lc = new AbortController(); lc.abort();
  check('aborted window request -> CancelledError', (await errOf(() => loadLevel2Window(L2KEY, { ra: 150, dec: 2 }, 0.01, { signal: lc.signal }))) instanceof CancelledError);
  m = mock({ [L2KEY]: l2, [L2KEY.replace('v27-2026-268', 'v28-2026-300').replace('l2b-v27', 'l2b-v28')]: l2 });
  const found = await findLevel2ByObservation('2026W20_2A_0191_4', { release: 'dr1', detector: 2 }).catch((x) => x);
  check('observation ID -> key by bucket listing (version dir name differs from file)', Array.isArray(found) ? found.length >= 1 : false, String(found));
  e = await errOf(() => findLevel2ByObservation('2026W20_2A_0191_4', { release: 'qr3' }));
  check('unknown release for the period -> not_found', e instanceof AwsError && e.code === 'not_found');

  console.log('--- epoch loading is AWS-first; IRSA only as fallback');
  const entry = (extra: Partial<EpochEntry['provenance']>): EpochEntry => ({ id: 'e1', label: 'x', mjd: 1, isoDate: null, detector: null, wavelengthRangeUm: null, status: 'idle', provenance: { origin: 'spherex-live', mission: 'm', instrument: 'i', product: 'p', observationDate: null, mjd: null, ...extra } });
  m = mock({ [L2KEY]: l2 });
  const el = await loadEpochImage(entry({ s3Key: L2KEY, url: 'https://irsa.ipac.caltech.edu/x.fits?center=150,2d&size=0.1' }), { ra: 150, dec: 2 });
  check('loadEpochImage reads from AWS and never touches IRSA', el.source === 'aws-s3' && m.log.every((l) => !l.url.includes('irsa')));
  globalThis.fetch = (async (input: RequestInfo | URL) => { const u = String(input); if (u.includes('amazonaws')) throw new TypeError('offline'); return new Response(l2.slice(), { status: 200, headers: { 'content-type': 'application/fits' } }); }) as typeof fetch;
  const fb = await loadEpochImage(entry({ s3Key: L2KEY, url: 'https://irsa.ipac.caltech.edu/x.fits' }), { ra: 150, dec: 2 }).catch((x) => x);
  check('AWS unreachable + IRSA URL known -> falls back, and says so', !(fb instanceof Error) && fb.source === 'irsa-cutout' && fb.notes.some((n: string) => n.includes('fell back')), String(fb));
  m = mock({ [L2KEY]: l2 });
  e = await errOf(() => loadEpochImage(entry({ s3Key: 'dr1/level2/nope.fits', url: 'https://irsa.ipac.caltech.edu/x.fits' }), { ra: 150, dec: 2 }));
  check('missing AWS object is NOT silently replaced by IRSA data', e instanceof AwsError && e.code === 'not_found', String(e));

  console.log('--- discovery is optional');
  const bad = { id: 'tap' as const, label: 'IRSA TAP', find: async () => { throw new Error('HTTP 502 Bad Gateway'); } };
  const r1 = await discoverEpochs(pos, [bad, { ...bad, id: 'sia2' as const, label: 'IRSA SIA2' }]);
  check('all discovery providers down -> resolves (never throws) with reasons', r1.epochs.length === 0 && r1.attempts.every((a) => !a.ok && a.error!.includes('502')));
  const csv = `obs_id,access_url,cloud_access,t_min,em_min,em_max,energy_bandpassname\n2026W20_2A_0191_4,https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2026W20_2A/l2b-v27-2026-268/2/level2_2026W20_2A_0191_4D2_spx_l2b-v27-2026-268.fits,"${JSON.stringify({ aws: { bucket_name: 'nasa-irsa-spherex', key: L2KEY } }).replace(/"/g, '""')}",61000.5,1.1e-6,1.6e-6,SPHEREx-D2\n`;
  const eps = parseSia2Level2(csv, pos, 'spherex_dr1');
  check('SIA2 row -> epoch with S3 key, MJD date, wavelength range (µm)', eps.length === 1 && eps[0].provenance.s3Key === L2KEY && eps[0].mjd === 61000.5 && Math.abs(eps[0].wavelengthRangeUm![0] - 1.1) < 1e-9);
  check('cube rows are never mixed into the epoch list', parseSia2Level2(`obs_id,access_url\nx,https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10226_cube.fits\n`, pos, 'c').length === 0);
  check('mergeEpochs dedupes by S3 key and orders by time', mergeEpochs([[eps[0]], [{ ...eps[0], id: 'dup' }]]).length === 1);

  globalThis.fetch = realFetch; resetS3Config();
  void awsAllSkyProvider;
  console.log(`\n${passed} passed, ${failed} failed (AWS tests, synthetic)`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
