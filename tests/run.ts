/* Engine tests: run with `npm test` (tsx). Pure TypeScript — no DOM required. */
import { parseFits, pickScienceHdu, toFitsImage, toSpectralCube } from '../src/services/fits';
import { makeTanWcs, pixelToSky, skyToPixel, pixelScaleArcsec } from '../src/services/fits/wcs';
import { detectSources, DEFAULT_DETECTION } from '../src/engines/sourceDetection';
import { subtractImages, DEFAULT_SUBTRACTION, IncompatibleImagesError } from '../src/engines/imageSubtraction';
import { matchEpochs, DEFAULT_TRACKING } from '../src/engines/objectTracking';
import { parseRa, parseDec, parsePosition, formatRaHms, formatDecDms, propagate, separationArcsec } from '../src/utils/coords';
import { mjdToIso } from '../src/utils/time';
import { makeDemoDataset } from '../src/services/demo/syntheticSky';
import { parseHipsProperties, resolveSurvey, SURVEY_PROVIDERS } from '../src/services/aladin';
import { findHdu, readBinTable } from '../src/services/fits';
import { healpixNestedIndex } from '../src/services/healpix';
import {
  buildAllSkyCube, CancelledError, directCubeUrl, isAllSkyImageHdu, irsaAllSkyProvider, loadAllSkyCubeTile, parseBlankCh, pickCubeUrlFromSia,
  planeIsBlank, resolveBlankChannels, siaCubeQueryUrl,
} from '../src/services/spherex/allSkyCube';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---- build a minimal FITS file in memory (MEF: empty primary + IMAGE ext, BITPIX -32 and a 16-bit cube)
function card(k: string, v: string | number | boolean, str = false): string {
  const val = str ? `'${v}'`.padEnd(20) : typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : String(v).padStart(20);
  return `${k.padEnd(8)}= ${val}`.padEnd(80);
}
function header(cards: string[]): Uint8Array {
  const text = cards.join('') + 'END'.padEnd(80);
  const padded = text.padEnd(Math.ceil(text.length / 2880) * 2880);
  return new TextEncoder().encode(padded);
}
function buildFits(w: number, h: number, pix: Float32Array, extra: string[] = [], depth = 0, bitpix16 = false): ArrayBuffer {
  const prim = header([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true)]);
  const cards = [card('XTENSION', 'IMAGE', true), card('BITPIX', bitpix16 ? 16 : -32), card('NAXIS', depth ? 3 : 2), card('NAXIS1', w), card('NAXIS2', h)];
  if (depth) cards.push(card('NAXIS3', depth));
  cards.push(card('PCOUNT', 0), card('GCOUNT', 1), card('EXTNAME', 'IMAGE', true), ...extra);
  const hd = header(cards);
  const bp = bitpix16 ? 2 : 4;
  const dataBytes = pix.length * bp;
  const dat = new Uint8Array(Math.ceil(dataBytes / 2880) * 2880);
  const dv = new DataView(dat.buffer);
  pix.forEach((v, i) => (bitpix16 ? dv.setInt16(i * 2, v, false) : dv.setFloat32(i * 4, v, false)));
  const out = new Uint8Array(prim.length + hd.length + dat.length);
  out.set(prim, 0); out.set(hd, prim.length); out.set(dat, prim.length + hd.length);
  return out.buffer;
}

// gaussian noise + injected sources
function rng(seed: number) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function noisy(w: number, h: number, seed: number, srcs: [number, number, number][], bg = 50, sig = 2): Float32Array {
  const r = rng(seed); const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = bg + (r() + r() + r() + r() - 2) * sig * 1.73;
  for (const [sx, sy, f] of srcs) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] += f * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * 1.5 * 1.5));
  return d;
}

console.log('FITS parser');
{
  const px = noisy(64, 48, 1, [[20, 20, 100]]);
  const buf = buildFits(64, 48, px, [card('BUNIT', 'MJy/sr', true), card('CTYPE1', 'RA---TAN', true), card('CTYPE2', 'DEC--TAN', true),
    card('CRPIX1', 32.5), card('CRPIX2', 24.5), card('CRVAL1', 133.8), card('CRVAL2', -7.245), card('CD1_1', -0.0017083), card('CD1_2', 0), card('CD2_1', 0), card('CD2_2', 0.0017083)]);
  const f = parseFits(buf);
  const hdu = pickScienceHdu(f)!;
  const img = toFitsImage(f, hdu);
  check('parses 2 HDUs', f.hdus.length === 2);
  check('selects IMAGE hdu', hdu.extname === 'IMAGE');
  check('dimensions', img.width === 64 && img.height === 48);
  check('pixel round-trip', near(img.data[20 * 64 + 20], px[20 * 64 + 20], 1e-4));
  check('BUNIT parsed', img.bunit === 'MJy/sr');
  check('WCS built', img.wcs !== null);
  let threw = false; try { parseFits(new ArrayBuffer(5760)); } catch { threw = true; }
  check('rejects non-FITS', threw);
}
{
  const depth = 4; const px = new Float32Array(8 * 8 * depth).map((_, i) => i % 1000);
  const buf = buildFits(8, 8, px, [card('CTYPE3', 'WAVE', true), card('CRVAL3', 0.75e-6), card('CRPIX3', 1), card('CDELT3', 1e-7), card('CUNIT3', 'm', true)], depth, true);
  const f = parseFits(buf); const cube = toSpectralCube(f, pickScienceHdu(f)!);
  check('cube depth', cube.depth === 4);
  check('cube wavelengths (linear WCS in header)', cube.wavelengthsUm !== null && near(cube.wavelengthsUm[1]!, 0.85, 1e-6));
  check('cube slice read', cube.readSlice(2)[0] === (8 * 8 * 2) % 1000);
  const buf2 = buildFits(8, 8, px, [], depth, true);
  const f2 = parseFits(buf2); const c2 = toSpectralCube(f2, pickScienceHdu(f2)!);
  check('no wavelength metadata -> null (never invented)', c2.wavelengthsUm === null);
}

console.log('WCS');
{
  const w = makeTanWcs(133.795, -7.245, 100, 100, 6.15);
  const s = pixelToSky(w, 30.5, 70.25);
  const p = skyToPixel(w, s.ra, s.dec)!;
  check('pixel<->sky round trip', near(p.x, 30.5, 1e-6) && near(p.y, 70.25, 1e-6));
  check('pixel scale', near(pixelScaleArcsec(w), 6.15, 1e-6));
  const c = pixelToSky(w, 49.5, 49.5);
  check('centre = CRVAL', near(c.ra, 133.795, 1e-9) && near(c.dec, -7.245, 1e-9));
  const e = pixelToSky(w, 59.5, 49.5);
  check('east is left (RA decreases with x)', e.ra < c.ra);
}

console.log('Coordinates');
{
  const wise = parsePosition('08h55m10.831s', "-07°14'42.53\"");
  check('WISE 0855 sexagesimal', wise.ok && near(wise.value.ra, 133.795129, 1e-5) && near(wise.value.dec, -7.245147, 1e-5));
  check('decimal RA', (() => { const r = parseRa('133.795'); return r.ok && r.value === 133.795; })());
  check('RA range rejected', !parseRa('360').ok && !parseRa('-1').ok);
  check('Dec range rejected', !parseDec('91').ok);
  check('garbage rejected', !parseRa('abc').ok);
  check('space-separated hms', (() => { const r = parseRa('08 55 10.831'); return r.ok && near(r.value, 133.795129, 1e-5); })());
  check('format RA', formatRaHms(133.795129).startsWith('08h 55m 10.83'));
  check('format Dec', formatDecDms(-7.245147).startsWith('−07° 14′ 42.5'));
  const moved = propagate({ ra: 269.452, dec: 4.6934 }, -801.551, 10362.394, 26);
  check('proper-motion propagation (Barnard ~270" in 26 yr)', near(separationArcsec({ ra: 269.452, dec: 4.6934 }, moved), 269.4, 1.0));
  check('MJD conversion', mjdToIso(60676) === '2025-01-01T00:00:00.000Z');
}

console.log('Source detection');
{
  const w = 128, h = 128;
  const srcs: [number, number, number][] = [[30, 30, 120], [90, 40, 80], [60, 100, 150], [100, 100, 60]];
  const data = noisy(w, h, 11, srcs);
  const r = detectSources(data, w, h, null, { ...DEFAULT_DETECTION, k: 5 });
  check('background ~50', near(r.background, 50, 1.5), `got ${r.background}`);
  check('finds the 4 injected sources', r.candidates.length >= 4 && r.candidates.length <= 6, `got ${r.candidates.length}`);
  const near1 = srcs.every(([sx, sy]) => r.candidates.some((c) => Math.hypot(c.x - sx, c.y - sy) < 0.8));
  check('centroids within 0.8 px', near1);
  const lo = detectSources(data, w, h, null, { ...DEFAULT_DETECTION, k: 2.5 });
  const hi = detectSources(data, w, h, null, { ...DEFAULT_DETECTION, k: 80 });
  check('threshold rises with k', hi.threshold > r.threshold && r.threshold > lo.threshold);
  check('higher k -> fewer candidates', hi.candidates.length < r.candidates.length && r.candidates.length <= lo.candidates.length, `${lo.candidates.length}/${r.candidates.length}/${hi.candidates.length}`);
  const nanData = data.slice(); for (let i = 0; i < 400; i++) nanData[i] = NaN;
  const rn = detectSources(nanData, w, h, null, DEFAULT_DETECTION);
  check('NaN pixels ignored (no crash, finite bg)', Number.isFinite(rn.background));
  const empty = detectSources(new Float32Array(w * h).fill(NaN), w, h, null, DEFAULT_DETECTION);
  check('all-NaN image -> zero candidates', empty.candidates.length === 0);
}

console.log('Image subtraction');
{
  const w = 96, h = 96;
  const a = noisy(w, h, 3, [[40, 40, 100], [70, 60, 80]]);
  const b = noisy(w, h, 4, [[41, 40, 100], [70, 60, 80], [20, 75, 130]]); // star 1 shifted by 1px, new source at (20,75)
  const bShift = noisy(w, h, 5, [[43, 42, 100], [73, 62, 80], [23, 77, 130]]); // whole frame shifted (3,2)
  const d = subtractImages({ width: w, height: h, data: a, header: {}, wcs: null, extname: 'IMAGE', bunit: null }, { width: w, height: h, data: bShift, header: {}, wcs: null, extname: 'IMAGE', bunit: null }, DEFAULT_SUBTRACTION);
  check('registration recovers (3,2) shift', d.shift[0] === 3 && d.shift[1] === 2, `got ${d.shift}`);
  check('result flagged uncalibrated', d.calibrated === false);
  const det = detectSources(d.data, w, h, null, { ...DEFAULT_DETECTION, k: 5 });
  check('difference image has few residual sources', det.candidates.length <= 4, `got ${det.candidates.length}`);
  const dd = subtractImages({ width: w, height: h, data: a, header: {}, wcs: null, extname: 'IMAGE', bunit: null }, { width: w, height: h, data: b, header: {}, wcs: null, extname: 'IMAGE', bunit: null }, { ...DEFAULT_SUBTRACTION, register: false });
  check('D = I2 - I1: new source is positive', dd.data[75 * w + 20] > 50);
  let err: unknown = null;
  try { subtractImages({ width: w, height: h, data: a, header: {}, wcs: null, extname: 'IMAGE', bunit: null }, { width: 64, height: 64, data: new Float32Array(64 * 64), header: {}, wcs: null, extname: 'IMAGE', bunit: null }, { ...DEFAULT_SUBTRACTION, matchDimensions: false }); } catch (e) { err = e; }
  check('mismatched sizes rejected gracefully', err instanceof IncompatibleImagesError);
  const rs = subtractImages({ width: w, height: h, data: a, header: {}, wcs: null, extname: 'IMAGE', bunit: null }, { width: 64, height: 64, data: noisy(64, 64, 9, []), header: {}, wcs: null, extname: 'IMAGE', bunit: null }, DEFAULT_SUBTRACTION);
  check('resamples differing sizes when allowed', rs.width === w && rs.notes.some((n) => n.includes('resampled')));
}

console.log('Object tracking + demo dataset');
{
  const ds = makeDemoDataset({ ra: 133.795, dec: -7.245 }, 'test');
  const e = ds.epochs;
  check('demo epochs have no invented dates', e.every((x) => x.isoDate === null && x.mjd === null));
  check('demo epochs are labelled synthetic', e.every((x) => x.provenance.origin === 'demo'));
  check('demo cube has 102 slices and no wavelengths', ds.cube!.depth === 102 && ds.cube!.wavelengthsUm === null);
  const det = e.map((x) => detectSources(x.image!.data, x.image!.width, x.image!.height, x.image!.wcs, DEFAULT_DETECTION));
  check('demo detections found', det.every((r) => r.candidates.length > 10), det.map((d) => d.candidates.length).join(','));
  const m = matchEpochs(det[0].candidates, det[1].candidates, { ...DEFAULT_TRACKING, pixelScaleArcsec: 6.15 });
  const movers = m.filter((x) => x.kind === 'potential-mover');
  check('flags the injected mover (>=1 potential mover)', movers.length >= 1, `movers=${movers.length}`);
  check('most sources are stable', m.filter((x) => x.kind === 'stable').length > m.length / 3);
  const bright = m.find((x) => x.from.peak === Math.max(...det[0].candidates.map((c) => c.peak)));
  check('brightest source matched', !!bright && bright.to !== null);
}

// ---- Aladin background-survey provider chain (fetch is mocked: tests never touch the network)
console.log('HiPS provider chain');
const ESA_DSS_PROPERTIES = [
  'creator_did          = ivo://CDS/P/DSS2/color', 'obs_title            = DSS colored', 'hips_version         = 1.4',
  'hips_order           = 9', 'hips_frame           = equatorial', 'hips_tile_width      = 512', 'hips_tile_format     = jpeg',
  'hips_status          = public mirror unclonable', '# 1975-1999', 't_min                = 42413',
].join('\n');
{
  const info = parseHipsProperties(ESA_DSS_PROPERTIES);
  check('parses real ESA DSSColor properties', info.order === 9 && info.frame === 'equatorial' && info.tileFormat === 'jpeg' && info.title === 'DSS colored');
  const rejects = (txt: string) => { try { parseHipsProperties(txt); return false; } catch { return true; } };
  check('rejects an HTML error page', rejects('<!doctype html><html><body>404 Not Found</body></html>'));
  check('rejects private HiPS', rejects(ESA_DSS_PROPERTIES + '\nhips_status = private master'));
  check('rejects unsupported frame', rejects(ESA_DSS_PROPERTIES.replace('equatorial', 'ecliptic')));
  check('ESA is the first DSS provider', SURVEY_PROVIDERS['P/DSS2/color'][0].url === 'https://skies.esac.esa.int/DSSColor');
}
{
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const mock = (ok: (url: string) => boolean) => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (!ok(url)) throw new TypeError('Failed to fetch');
      return new Response(ESA_DSS_PROPERTIES, { status: 200 });
    }) as typeof fetch;
  };
  // 1. everything unreachable -> one friendly error, each provider probed exactly once (no retry loop)
  mock(() => false);
  let msg = '';
  try { await resolveSurvey('P/2MASS/color'); } catch (e) { msg = e instanceof Error ? e.message : ''; }
  check('all providers down -> friendly error', msg.startsWith('None of the background-survey providers'), msg);
  check('each provider probed once', calls.length === SURVEY_PROVIDERS['P/2MASS/color'].length, String(calls.length));
  const before = calls.length;
  try { await resolveSurvey('P/2MASS/color'); } catch { /* expected */ }
  check('failures are cached (no repeated probing)', calls.length === before);
  // 2. preferred ESA host down, mirror up -> falls through to the next provider
  calls.length = 0;
  mock((u) => !u.startsWith('https://skies.esac.esa.int/'));
  const r = await resolveSurvey('P/DSS2/color');
  check('falls back to the next verified provider', r.provider.url === 'https://cdn.skies.esac.esa.int/DSSColor' && calls.length === 2, `${r.provider.url} calls=${calls.length}`);
  globalThis.fetch = realFetch;
}


// ---------------------------------------------------------------------------------------------
// SPHEREx DR1 All-Sky Cube
// NOTE: the "cube" built below is a TEST FIXTURE that mimics the documented MEF layout (IMAGE, NHITS, FLAGS,
// SPECTRAL_CHANNELS, WCS-WAVE) so the parser/loader logic can be exercised offline. It is never used by the app.
// ---------------------------------------------------------------------------------------------
console.log('All-Sky Cube');
{
  const HP_REF: [number, number, number][] = [
    [133.795129, -7.245147, 10226], [0.0, 0.0, 4864], [10.0, 89.0, 1023],
    [200.0, -85.0, 10248], [337.5, -5.979, 4659], [45.0, 41.8, 255],
    [359.9999, 0.0, 4693], [64.41653, -6.0039, 5688], [230.36874, -15.64275, 11119],
    [168.21662, -37.53203, 9587], [133.38019, 10.93713, 1063], [127.77024, -7.4334, 10222],
    [284.58657, -23.57924, 7239], [325.85178, -35.53272, 11705], [63.84715, 48.52529, 437],
    [235.00253, 36.50726, 2441], [107.389, 12.32281, 5613], [348.10639, -18.04711, 4272],
    [331.14606, 63.33422, 3918], [228.91349, 7.2821, 2066], [270.98355, -7.72824, 7409],
    [185.45533, 53.21606, 2792], [297.32229, -21.18106, 12195], [161.417, 23.07836, 1284],
    [121.97248, -21.8612, 10126], [100.04372, -28.48273, 5184], [81.4799, 23.68336, 6068],
    [189.29406, -32.97111, 10942], [155.12834, -0.78952, 6804], [238.74502, 9.2102, 7912],
    [4.62257, -38.47604, 8878],
  ];
  const bad = HP_REF.filter(([ra, dec, n]) => healpixNestedIndex(5, ra, dec) !== n);
  check('HEALPix order-5 NESTED matches hpgeom (31 reference points incl. poles, seams, caps)', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  check('doc example tile Npix4659 contains its own centre (337.5, -5.979)', healpixNestedIndex(5, 337.5, -5.979) === 4659);
  check('tile directory + direct URL follow the documented layout', directCubeUrl(10226).endsWith('/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10226_cube.fits') && directCubeUrl(4659).includes('/Dir0/Npix4659_cube.fits'));
  let badPos = false;
  try { healpixNestedIndex(5, 10, 95); } catch { badPos = true; }
  check('invalid declination is rejected', badPos);

  // SIA2 answer handling
  const csv = 'obs_id,access_url\nA,https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10226_cube.fits\nB,http://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10227_cube.fits\n';
  check('SIA2 row is chosen by computed tile, not by position in the answer', pickCubeUrlFromSia(csv, 10226)?.includes('Npix10226_cube') === true);
  check('SIA2 http URLs are upgraded to https', pickCubeUrlFromSia(csv, 10227)?.startsWith('https://') === true);
  check('SIA2 answer without cube rows -> null (caller falls back)', pickCubeUrlFromSia('obs_id,access_url\n', 5) === null && pickCubeUrlFromSia('<VOTABLE/>', 5) === null);
  let mismatch = '';
  try { pickCubeUrlFromSia(csv, 4659); } catch (e) { mismatch = e instanceof Error ? e.message : ''; }
  check('SIA2 tile that disagrees with the HEALPix computation is refused', mismatch.includes('Refusing to load'), mismatch);
  check('SIA2 query uses the DR1 cube collection', siaCubeQueryUrl({ ra: 133.795129, dec: -7.245147 }).includes('COLLECTION=spherex_dr1_cube'));

  // BLANKCH
  check('BLANKCH parsing: "51,52" / "51 52" / 51', JSON.stringify(parseBlankCh('51,52')) === '[51,52]' && JSON.stringify(parseBlankCh('51 52')) === '[51,52]' && JSON.stringify(parseBlankCh(51)) === '[51]' && parseBlankCh(undefined).length === 0);
  const r1 = resolveBlankChannels([50, 51], [51, 52], 102);
  check('BLANKCH 51,52 (1-based) confirmed by blank planes 50,51 (0-based)', JSON.stringify(r1.blank) === '[50,51]' && r1.note.includes('confirm'), r1.note);
  const r2 = resolveBlankChannels([50, 51], [50, 51], 102);
  check('BLANKCH that is really 0-based is detected from the data', JSON.stringify(r2.blank) === '[50,51]' && r2.note.includes('0-based'), r2.note);
  const r3 = resolveBlankChannels([], [51, 52], 102);
  check('BLANKCH listing planes that hold data is reported, header respected', JSON.stringify(r3.blank) === '[50,51]' && r3.note.includes('but the data show'), r3.note);
  check('planeIsBlank: NaN and zero planes are blank, any real value is not', planeIsBlank(new Float32Array([NaN, 0, NaN])) && !planeIsBlank(new Float32Array([NaN, 0, 1e-9])));

  // ---- fixture builders
  const pad = (b: Uint8Array): Uint8Array => { const o = new Uint8Array(Math.ceil(b.length / 2880) * 2880); o.set(b); return o; };
  const cat = (...parts: Uint8Array[]): Uint8Array => { const o = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let off = 0; for (const x of parts) { o.set(x, off); off += x.length; } return o; };
  const prim = () => header([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true)]);
  function imageExt(name: string, bitpix: number, dims: number[], val: (i: number) => number, extra: string[] = []): Uint8Array {
    const n = dims.reduce((a, b) => a * b, 1);
    const bp = Math.abs(bitpix) / 8;
    const dat = new Uint8Array(n * bp);
    const dv = new DataView(dat.buffer);
    for (let i = 0; i < n; i++) { if (bitpix === -32) dv.setFloat32(i * 4, val(i), false); else if (bitpix === 32) dv.setInt32(i * 4, val(i), false); else dv.setInt16(i * 2, val(i), false); }
    const cards = [card('XTENSION', 'IMAGE', true), card('BITPIX', bitpix), card('NAXIS', dims.length), ...dims.map((d, i) => card(`NAXIS${i + 1}`, d)), card('PCOUNT', 0), card('GCOUNT', 1), card('EXTNAME', name, true), ...extra];
    return cat(header(cards), pad(dat));
  }
  type Col = { name: string; form: string; unit?: string; values: (number | string)[] };
  function tableExt(name: string, cols: Col[]): Uint8Array {
    const sizes = cols.map((c) => (c.form === 'J' || c.form === 'E' ? 4 : c.form === 'D' ? 8 : Number(c.form.replace('A', ''))));
    const rowBytes = sizes.reduce((a, b) => a + b, 0);
    const nrows = cols[0].values.length;
    const dat = new Uint8Array(rowBytes * nrows);
    const dv = new DataView(dat.buffer);
    for (let r = 0; r < nrows; r++) {
      let off = r * rowBytes;
      cols.forEach((c, i) => {
        const v = c.values[r];
        if (c.form === 'J') dv.setInt32(off, v as number, false);
        else if (c.form === 'E') dv.setFloat32(off, v as number, false);
        else if (c.form === 'D') dv.setFloat64(off, v as number, false);
        else new TextEncoder().encodeInto(String(v).padEnd(sizes[i]), new Uint8Array(dat.buffer, off, sizes[i]));
        off += sizes[i];
      });
    }
    const cards = [card('XTENSION', 'BINTABLE', true), card('BITPIX', 8), card('NAXIS', 2), card('NAXIS1', rowBytes), card('NAXIS2', nrows), card('PCOUNT', 0), card('GCOUNT', 1), card('TFIELDS', cols.length)];
    cols.forEach((c, i) => { cards.push(card(`TTYPE${i + 1}`, c.name, true), card(`TFORM${i + 1}`, c.form, true)); if (c.unit) cards.push(card(`TUNIT${i + 1}`, c.unit, true)); });
    cards.push(card('EXTNAME', name, true));
    return cat(header(cards), pad(dat));
  }
  const W = 8; // fixture tile is 8x8 (real tiles are 512x512)
  const wl = (k: number) => 0.75 + k * ((5.0 - 0.75) / 101);
  const channelTable = (cols?: Col[]) => tableExt('SPECTRAL_CHANNELS', cols ?? [
    { name: 'CHANNEL', form: 'J', values: Array.from({ length: 102 }, (_, k) => k + 1) },
    { name: 'LAMBDA_CENTER', form: 'E', unit: 'um', values: Array.from({ length: 102 }, (_, k) => wl(k)) },
    { name: 'LAMBDA_MIN', form: 'E', unit: 'um', values: Array.from({ length: 102 }, (_, k) => wl(k) - 0.01) },
    { name: 'LAMBDA_MAX', form: 'E', unit: 'um', values: Array.from({ length: 102 }, (_, k) => wl(k) + 0.01) },
  ]);
  // plane k holds the constant k+1, except the blank planes 50 and 51 (channels 51 and 52) which are NaN
  const planeVal = (i: number) => { const k = Math.floor(i / (W * W)); return k === 50 || k === 51 ? NaN : k + 1; };
  const cubeFile = (opts: { table?: Uint8Array | null; blankch?: string | null } = {}): Uint8Array => cat(
    prim(),
    imageExt('IMAGE', -32, [W, W, 102], planeVal, [card('BUNIT', 'MJy/sr', true), ...(opts.blankch === null ? [] : [card('BLANKCH', opts.blankch ?? '51,52', true)])]),
    imageExt('NHITS', 16, [W, W, 102], () => 3),
    imageExt('FLAGS', 32, [W, W, 102], () => 0),
    opts.table === null ? new Uint8Array(0) : (opts.table ?? channelTable()),
    tableExt('WCS-WAVE', [{ name: 'X', form: 'J', values: [1] }]),
  );
  const pos = { ra: 133.795129, dec: -7.245147 };
  const siaCsv = (url: string) => `obs_id,access_url\nx,${url}\n`;

  // ---- mock archive: SIA2 + cube file, with or without HTTP Range support
  const realFetch2 = globalThis.fetch;
  let served = 0;
  const requested: string[] = [];
  function mockArchive(file: Uint8Array, o: { range: boolean; sia?: string | null; status?: number }) {
    served = 0; requested.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/SIA?')) return new Response(o.sia ?? '', { status: 200, headers: { 'content-type': 'text/csv' } });
      if (!url.includes('_cube.fits')) return new Response('nope', { status: 404 });
      if (o.status) return new Response('missing', { status: o.status, headers: { 'content-type': 'text/plain' } });
      const range = o.range ? /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string> | undefined)?.Range ?? '')) : null;
      if (range) {
        const a = Number(range[1]); const b = Math.min(Number(range[2]), file.length - 1);
        const body = a >= file.length ? new Uint8Array(0) : file.slice(a, b + 1);
        served += body.length;
        return new Response(body, { status: 206, headers: { 'content-type': 'application/fits', 'content-range': `bytes ${a}-${b}/${file.length}` } });
      }
      served += file.length;
      return new Response(file.slice(), { status: 200, headers: { 'content-type': 'application/fits' } });
    }) as typeof fetch;
  }

  const imageBytes = W * W * 102 * 4;
  const sia = siaCsv('https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10226_cube.fits');

  // 1. Range-capable server
  mockArchive(cubeFile(), { range: true, sia });
  const prog: string[] = [];
  const res = await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true, onProgress: (p) => prog.push(p.stage) });
  const cube = res.cube;
  check('cube shape and unit', cube.width === W && cube.height === W && cube.depth === 102 && cube.bunit === 'MJy/sr');
  check('plane values are the real file data (channel 1 = 1, channel 102 = 102)', cube.readSlice(0)[0] === 1 && cube.readSlice(101)[5] === 102 && cube.readSlice(49)[0] === 50);
  check('wavelengths come from the SPECTRAL_CHANNELS table', cube.wavelengthsUm !== null && near(cube.wavelengthsUm[0] ?? 0, 0.75, 1e-5) && near(cube.wavelengthsUm[101] ?? 0, 5.0, 1e-4), String(cube.wavelengthsUm?.[0]));
  check('channel edges are read when the table states them', !!cube.wavelengthEdgesUm?.[10] && near((cube.wavelengthEdgesUm![10]![1] - cube.wavelengthEdgesUm![10]![0]), 0.02, 1e-4));
  check('blank channels 51 and 52 detected (0-based 50, 51) and reported', JSON.stringify(cube.blankChannels) === '[50,51]' && res.info.notes.some((n) => n.includes('confirm')));
  check('HPX tile has no TAN WCS and says so', cube.wcs === null && res.info.notes.some((n) => n.includes('HEALPix (HPX) projection')));
  check('tile id, SIA2 provenance and Range transport are recorded', res.info.tile === 10226 && res.info.resolvedVia === 'sia2' && res.info.transport === 'range' && res.info.kind === 'allsky-dr1');
  check('Range mode fetches IMAGE + table only (NHITS/FLAGS skipped)', served < imageBytes + 20_000 && served > imageBytes, `served=${served} image=${imageBytes}`);
  check('progress is reported', prog.some((p) => p.includes('Downloading IMAGE')));
  check('SIA2 was queried before the file', requested[0].includes('/SIA?') && requested.some((u) => u.includes('Npix10226_cube.fits')));

  // 2. Server that ignores Range -> forward stream, still correct
  mockArchive(cubeFile(), { range: false, sia });
  const res2 = await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true });
  check('stream fallback: same cube, wavelengths and blank channels', res2.info.transport === 'stream' && res2.cube.readSlice(100)[0] === 101 && res2.cube.wavelengthsUm !== null && JSON.stringify(res2.cube.blankChannels) === '[50,51]');

  // 3. SIA2 empty -> documented directory layout
  mockArchive(cubeFile(), { range: true, sia: 'obs_id,access_url\n' });
  const res3 = await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true });
  check('empty SIA2 answer -> direct URL with Dir10000 used', res3.info.resolvedVia === 'direct-url' && requested.some((u) => u.includes('/Dir10000/Npix10226_cube.fits')));

  // 4. unavailable tile -> friendly error
  mockArchive(cubeFile(), { range: true, sia: 'obs_id,access_url\n', status: 404 });
  let e404 = '';
  try { await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true }); } catch (e) { e404 = e instanceof Error ? e.message : ''; }
  check('missing tile (HTTP 404) -> clear message naming the tile', e404.includes('10226') && e404.includes('404'), e404);

  // 5. Level-2 exposure with a PSF cube is NOT accepted as a spectral cube
  const level2 = cat(prim(), imageExt('IMAGE', -32, [16, 16], () => 1), imageExt('PSF', -32, [4, 4, 121], () => 1));
  mockArchive(level2, { range: true, sia });
  let eL2 = '';
  try { await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true }); } catch (e) { eL2 = e instanceof Error ? e.message : ''; }
  check('Level-2 file with PSF cube is rejected as an All-Sky Cube', eL2.includes('not a SPHEREx All-Sky Cube') && eL2.includes('Level-2'), eL2);
  check('isAllSkyImageHdu: 2-D images and 121-plane PSF cubes do not qualify', !isAllSkyImageHdu(parseFits(level2.buffer as ArrayBuffer).hdus[1]) && !isAllSkyImageHdu(parseFits(level2.buffer as ArrayBuffer).hdus[2]));

  // 6. table missing / unusable -> cube still loads, but no invented wavelengths
  mockArchive(cubeFile({ table: null }), { range: true, sia });
  const res6 = await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true });
  check('no SPECTRAL_CHANNELS table -> no wavelengths, stated explicitly', res6.cube.wavelengthsUm === null && res6.info.notes.some((n) => n.includes('No SPECTRAL_CHANNELS table')));
  const badTable = channelTable([
    { name: 'CHANNEL', form: 'J', values: Array.from({ length: 102 }, (_, k) => k + 1) },
    { name: 'LAMBDA_CENTER', form: 'E', unit: 'um', values: Array.from({ length: 102 }, (_, k) => 5 - k * 0.04) }, // decreasing: invalid
  ]);
  mockArchive(cubeFile({ table: badTable }), { range: true, sia });
  const res7 = await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true });
  check('non-monotonic wavelength column fails validation -> no wavelengths, columns listed', res7.cube.wavelengthsUm === null && res7.info.notes.some((n) => n.includes('Columns found: CHANNEL, LAMBDA_CENTER')));
  const nmTable = channelTable([{ name: 'WAVE_CEN', form: 'E', unit: 'nm', values: Array.from({ length: 102 }, (_, k) => wl(k) * 1000) }]);
  mockArchive(cubeFile({ table: nmTable }), { range: true, sia });
  const res8 = await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true });
  check('nm units are converted to micron', res8.cube.wavelengthsUm !== null && near(res8.cube.wavelengthsUm[0] ?? 0, 0.75, 1e-4));

  // 7. cancellation
  mockArchive(cubeFile(), { range: true, sia });
  let cancelled = false;
  try { await loadAllSkyCubeTile(pos, { provider: irsaAllSkyProvider, cache: null, authorize: () => true, isCancelled: () => requested.some((u) => u.includes('_cube.fits')) }); } catch (e) { cancelled = e instanceof CancelledError; }
  check('cancelling stops the load with CancelledError', cancelled);

  // 8. local file path (same builder as the "Open FITS file" route)
  {
    const parsed = parseFits(cubeFile().buffer as ArrayBuffer);
    const imgHdu = parsed.hdus.find((h) => isAllSkyImageHdu(h))!;
    const tabHdu = findHdu(parsed, 'SPECTRAL_CHANNELS')!;
    const built = buildAllSkyCube({ file: parsed, hdu: imgHdu }, { file: parsed, hdu: tabHdu }, parsed.hdus.map((h) => h.header));
    check('local All-Sky file: wavelengths and blank channels recovered', built.cube.wavelengthsUm !== null && JSON.stringify(built.cube.blankChannels) === '[50,51]' && built.cube.readSlice(2)[0] === 3);
  }

  // 9. binary table reader
  {
    const t = tableExt('T', [{ name: 'N', form: 'J', values: [7, 8] }, { name: 'X', form: 'D', unit: 'um', values: [1.5, 2.5] }, { name: 'S', form: '4A', values: ['ab', 'cd'] }]);
    const f = parseFits(cat(prim(), t).buffer as ArrayBuffer);
    const bt = readBinTable(f, f.hdus[1]);
    check('BINTABLE reader: int, double and string columns', bt.nrows === 2 && bt.rows[1][0] === 8 && bt.rows[0][1] === 1.5 && bt.rows[1][2] === 'cd' && bt.columns[1].unit === 'um');
  }
  globalThis.fetch = realFetch2;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
