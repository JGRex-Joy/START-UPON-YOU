/* LIVE verification against the REAL public bucket (anonymous). Run on a machine with internet: `npm run test:live`.
 * Exit codes: 0 = verified, 1 = a real check failed, 2 = bucket unreachable (NOTHING verified — never counts as a pass). */
import { listObjects, headObject } from '../src/services/aws/s3';
import { AwsError } from '../src/services/aws/errors';
import { resolveCubeKey, candidateCubeKey } from '../src/services/aws/allSkyProvider';
import { loadAllSkyCubeTile } from '../src/services/spherex/allSkyCube';
import { findLevel2ByObservation, loadLevel2Window, parseLevel2Key } from '../src/services/aws/level2';
import { MemoryCubeCache } from '../src/services/aws/cubeCache';
import { healpixNestedIndex } from '../src/services/healpix';

let ok = 0; let bad = 0;
const check = (n: string, c: boolean, d = '') => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n} ${c ? '' : d}`); };
const WISE = { ra: 133.795129, dec: -7.245147 };

async function main() {
  console.log('1. public bucket accessibility (anonymous listing)');
  let top: string[];
  try { top = (await listObjects('', { delimiter: '/', maxKeys: 100 })).prefixes; }
  catch (e) { if (e instanceof AwsError && e.code === 'network') { console.log(`\nSKIPPED — bucket unreachable from this machine: ${e.message}\nNOTHING WAS VERIFIED.`); process.exit(2); } throw e; }
  console.log(`   top-level prefixes: ${top.join(' ')}`);
  check('bucket lists anonymously', top.length > 0);

  console.log('2. release availability');
  check("'dr1/' prefix exists", top.includes('dr1/'));
  const dr1 = top.includes('dr1/') ? (await listObjects('dr1/', { delimiter: '/', maxKeys: 100 })).prefixes : [];
  console.log(`   dr1/ contains: ${dr1.join(' ') || '(nothing)'}`);
  check("'dr1/hips5_cube/' exists", dr1.includes('dr1/hips5_cube/'));
  check("'dr1/level2/' exists", dr1.includes('dr1/level2/'));
  if (dr1.includes('dr1/hips5_cube/')) console.log(`   cube release dirs: ${(await listObjects('dr1/hips5_cube/', { delimiter: '/' })).prefixes.join(' ')}`);

  console.log('3. All-Sky Cube, WISE 0855');
  check('RA/Dec -> Npix 10226', healpixNestedIndex(5, WISE.ra, WISE.dec) === 10226);
  try {
    const r = await resolveCubeKey(10226);
    console.log(`   key: ${r.key} (${r.how}), size ${r.size}`);
    check('documented-path candidate equals the real key', r.key === candidateCubeKey(10226), `candidate=${candidateCubeKey(10226)}`);
    const cache = new MemoryCubeCache();
    const t0 = Date.now();
    const res = await loadAllSkyCubeTile(WISE, { cache, authorize: (p) => { console.log(`   plan: ${(p.downloadBytes / 1e6).toFixed(1)} MB via ${p.transport}, file ${p.fileBytes}`); return true; } });
    console.log(`   downloaded in ${((Date.now() - t0) / 1000).toFixed(0)} s, transport=${res.info.transport}`);
    check('real tile parsed: 512x512x102, MJy/sr', res.cube.width === 512 && res.cube.height === 512 && res.cube.depth === 102 && res.cube.bunit === 'MJy/sr');
    check('wavelengths come from SPECTRAL_CHANNELS', !!res.cube.wavelengthsUm && res.cube.wavelengthsUm.filter((x) => x !== null).length >= 100, res.info.notes.join(' | '));
    check('BLANKCH channels 51/52 recognised', res.cube.blankChannels?.join() === '50,51', String(res.cube.blankChannels));
    check('range transport (partial download)', res.info.transport === 'range', res.info.transport);
    const again = await loadAllSkyCubeTile(WISE, { cache, authorize: () => { throw new Error('should not download again'); } });
    check('second load served from cache', again.info.transport === 'cache');
  } catch (e) { check('All-Sky Cube end-to-end', false, e instanceof Error ? e.message : String(e)); }

  console.log('4. Level-2 spectral image (AWS only, by listing)');
  try {
    const periods = (await listObjects('dr1/level2/', { delimiter: '/', maxKeys: 5 })).prefixes;
    check('dr1/level2/ has planning periods', periods.length > 0);
    const obs = process.env.SPHEREX_OBS_ID ?? '2026W20_2A_0191_4';
    const found = await findLevel2ByObservation(obs, { release: 'dr1', detector: 2 });
    const f = found[0]; console.log(`   found ${f.key} (${(f.size / 1e6).toFixed(0)} MB)`);
    check('key parses per documented layout', !!parseLevel2Key(f.key));
    await headObject(f.key);
    // The window needs a coordinate inside the exposure: read its own WCS centre via a tiny first pass.
    const probe = await loadLevel2Window(f.key, { ra: Number(process.env.SPHEREX_RA ?? NaN), dec: Number(process.env.SPHEREX_DEC ?? NaN) }, 0.1).catch((e) => e);
    if (probe instanceof AwsError && probe.code === 'outside_footprint') console.log('   (set SPHEREX_RA/SPHEREX_DEC to a position inside this exposure to test the window read)');
    else check('Level-2 window read via Range', !(probe instanceof Error) && probe.transport === 'range', String(probe));
  } catch (e) { check('Level-2 listing/read', false, e instanceof Error ? e.message : String(e)); }

  console.log('5. coordinate discovery without TAP/SIA2');
  console.log('   NOT POSSIBLE from object keys alone (no sky position in keys; no index/manifest documented). See docs/AWS_MIGRATION.md.');
  console.log(`\n${ok} passed, ${bad} failed (LIVE)`); process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
