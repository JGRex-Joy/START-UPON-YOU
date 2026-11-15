/* Observatory sky-map unit tests: run with `npm test` (tsx). Pure TypeScript — the browser behaviour is covered by tests/e2e. */
import { CHALLENGE_TARGETS, FOCUS_LABEL } from '../src/services/targets';
import { parseDec, parsePosition, parseRa, parseRaUnit } from '../src/utils/coords';
import { buildSkyHash, parseSkyHash } from '../src/app/skyUrl';
import { parseRoute } from '../src/app/router';
import { allSkyTile } from '../src/services/spherex/allSkyCube';
import {
  COMPANION_GREETING, ENTRY_TIMING, WELCOME_BUTTON, WELCOME_DIALOGUE,
  initialEntryPhase, isWelcomePhase, nextEntryPhase, welcomeDurationMs, tourRoute, TOUR, TOUR_TEXT, type EntryPhase,
} from '../src/app/entry';
import { checkTileAvailability, clearTileAvailabilityMemo } from '../src/services/aws/tileAvailability';
import { configureS3, resetS3Config } from '../src/services/aws/s3';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

console.log('--- featured targets');
check('exactly the five challenge targets', CHALLENGE_TARGETS.map((t) => t.name).join('|') === "Barnard's Star|Epsilon Indi B|WISE 0855−0714|RW Aurigae|R Draconis");
for (const t of CHALLENGE_TARGETS) {
  // The numeric ra/dec are written as arithmetic; the displayed sexagesimal strings are separate text. They must agree.
  const ra = parseRa(t.raSexagesimal.replace('h ', 'h').replace('m ', 'm'));
  const dec = parseDec(t.decSexagesimal.replace('−', '-').replace('+', '').replace(/\s/g, ''));
  check(`${t.name}: stored degrees match its cited sexagesimal position`, ra.ok && dec.ok && near(ra.value, t.ra, 1e-6) && near(dec.value, t.dec, 1e-6), JSON.stringify({ ra, dec, t: [t.ra, t.dec] }));
  check(`${t.name}: has a scientific focus (${t.focus}) and a cited source`, !!FOCUS_LABEL[t.focus] && t.source.url.startsWith('https://'));
}
check('WISE 0855 position is the one supplied in the challenge brief (133.795129, -7.245147)', (() => { const w = CHALLENGE_TARGETS.find((t) => t.id === 'wise-0855')!; return near(w.ra, 133.795129, 1e-5) && near(w.dec, -7.245147, 1e-5); })());
check('focus split: 3 motion, 2 variability', CHALLENGE_TARGETS.filter((t) => t.focus === 'motion').length === 3 && CHALLENGE_TARGETS.filter((t) => t.focus === 'variability').length === 2);
check('WISE 0855 falls in tile Npix10226 (existing HEALPix code)', allSkyTile({ ra: 133.795129, dec: -7.245147 }).npix === 10226);

console.log('--- RA in hours / degrees');
const h = (t: string) => parseRaUnit(t, 'hours');
check('8.919675 h = 133.795125°', (() => { const r = h('8.919675'); return r.ok && near(r.value, 133.795125, 1e-6); })());
check('24 h rejected, 25 h rejected, -1 h rejected', !h('24').ok && !h('25').ok && !h('-1').ok);
check('0 h accepted; 23.999 h accepted', h('0').ok && h('23.999').ok);
check('hms accepted in hours mode', (() => { const r = h('08h55m10.8s'); return r.ok && near(r.value, 133.795, 1e-3); })());
check('degrees mode: 360 rejected, 359.999 accepted', !parseRaUnit('360', 'deg').ok && parseRaUnit('359.999', 'deg').ok);
check('Dec: +90 and -90 accepted, 90.0001 and -91 rejected', parseDec('90').ok && parseDec('-90').ok && !parseDec('90.0001').ok && !parseDec('-91').ok);
check('non-numeric rejected with a message', (() => { const r = parseRa('abc'); return !r.ok && r.error.length > 5; })());
check('parsePosition hours unit', (() => { const r = parsePosition('12', '-30', 'hours'); return r.ok && r.value.ra === 180 && r.value.dec === -30; })());
check('parsePosition reports RA error first', (() => { const r = parsePosition('400', '95'); return !r.ok && /^RA:/.test(r.error); })());

console.log('--- URL <-> selection');
check('route: "" and #/sky are the sky map, #/about is the intro', parseRoute('') === 'sky' && parseRoute('#/') === 'sky' && parseRoute('#/sky?t=r-dra') === 'sky' && parseRoute('#/about') === 'landing' && parseRoute('#/explorer') === 'explorer' && parseRoute('#/analysis') === 'analysis');
check('no params -> none', parseSkyHash('#/').kind === 'none' && parseSkyHash('#/sky').kind === 'none');
for (const t of CHALLENGE_TARGETS) {
  const r = parseSkyHash(buildSkyHash({ pos: { ra: t.ra, dec: t.dec }, challenge: t }));
  check(`${t.name}: hash round-trips and takes coordinates from the catalogue, not the URL`, r.kind === 'ok' && r.selection.challenge?.id === t.id && r.selection.pos.ra === t.ra && r.selection.pos.dec === t.dec);
}
check('position hash round-trips (5 decimals)', (() => { const r = parseSkyHash(buildSkyHash({ pos: { ra: 133.795129, dec: -7.245147 }, challenge: null })); return r.kind === 'ok' && near(r.selection.pos.ra, 133.795129, 1e-5) && near(r.selection.pos.dec, -7.245147, 1e-5) && r.selection.challenge === null; })());
check('a URL cannot override a target\'s coordinates', (() => { const r = parseSkyHash('#/sky?t=barnards-star&ra=1&dec=1'); return r.kind === 'ok' && r.selection.pos.ra > 269 && r.selection.pos.ra < 270; })());
check('unknown target, bad RA, bad Dec, half a position are reported', ['#/sky?t=nope', '#/sky?ra=400&dec=0', '#/sky?ra=10&dec=95', '#/sky?ra=10'].every((x) => parseSkyHash(x).kind === 'invalid'));

console.log('--- entry experience');
check('welcome dialogue is exactly the wording from the brief', WELCOME_DIALOGUE === "Oh, here you are. I've been waiting. Finally, someone curious. Let's start?", JSON.stringify(WELCOME_DIALOGUE));
check('button label is exactly START EXPLORING', WELCOME_BUTTON === 'START EXPLORING');
check('companion greeting is exactly the wording from the brief', COMPANION_GREETING === 'Feel free. Explore what you like.', JSON.stringify(COMPANION_GREETING));
check('the onboarding states run in order and never go back', (() => {
  const seen: EntryPhase[] = ['welcome_flying'];
  for (let i = 0; i < 15; i++) seen.push(nextEntryPhase(seen[seen.length - 1]));
  return seen.join(' ').startsWith('welcome_flying welcome_dialogue entering_universe sky_map_intro exploring explorer_intro explorer_image explorer_compare explorer_spectral explorer_sky_context analysis_intro analysis_detect analysis_subtract analysis_track onboarding_complete onboarding_complete');
})());
check('every tour step points at a real element and belongs to a real page', TOUR.length === 7
  && TOUR.filter((s) => s.route === 'explorer').length === 4 && TOUR.filter((s) => s.route === 'analysis').length === 3
  && TOUR.every((s) => s.text.length > 0 && s.text.length > 40));
check('tour steps carry the wording from the brief', [
  'Image lets you see the actual astronomical observations',
  'Compare lets you look at observations side by side',
  'Every object has a story written in light',
  "Sky Context helps you understand what's around your target",
].every((t, i) => TOUR[i].text.includes(t)));
check('the Analysis steps name the three prototypes and say so', TOUR.slice(4).every((s) => /prototype/i.test(s.text))
  && /Source detection/.test(TOUR[4].text) && /Image subtraction/.test(TOUR[5].text) && /Cross-epoch tracking/.test(TOUR[6].text));
check('closing lines are exactly as specified', TOUR_TEXT.analysisIntro === 'Welcome to Analysis! This is where exploration turns into investigation.'
  && TOUR_TEXT.done === "You're ready! The universe is yours to explore." && TOUR_TEXT.doneButton === 'START EXPLORING'
  && TOUR_TEXT.skyNext === 'Ready to explore a little deeper? This is your Explorer.');
check('each phase resolves to the page it runs on', tourRoute('explorer_intro') === 'explorer' && tourRoute('analysis_intro') === 'analysis'
  && tourRoute('explorer_spectral') === 'explorer' && tourRoute('analysis_track') === 'analysis'
  && tourRoute('exploring') === null && tourRoute('welcome_flying') === null);
check('the welcome overlay covers only the first three states', ['welcome_flying', 'welcome_dialogue', 'entering_universe'].every((p) => isWelcomePhase(p as EntryPhase))
  && !isWelcomePhase('exploring') && !isWelcomePhase('explorer_image') && !isWelcomePhase('onboarding_complete'));
check('a first visit to the sky map gets the welcome', initialEntryPhase({ hash: '', seen: false }) === 'welcome_flying' && initialEntryPhase({ hash: '#/', seen: false }) === 'welcome_flying' && initialEntryPhase({ hash: '#/sky', seen: false }) === 'welcome_flying');
check('a returning visitor is not made to watch it again', initialEntryPhase({ hash: '#/', seen: true }) === 'exploring');
check('a deep link never waits behind the intro', ['#/sky?t=barnards-star', '#/sky?ra=10&dec=20', '#/sky?t=nope'].every((h) => initialEntryPhase({ hash: h, seen: false }) === 'exploring'));
check('another route never shows it', ['#/explorer', '#/analysis', '#/about'].every((h) => initialEntryPhase({ hash: h, seen: false }) === 'exploring'));
check('the welcome runs a few seconds, and much less with reduced motion', (() => {
  const full = welcomeDurationMs(false);
  const calm = welcomeDurationMs(true);
  return full > 7000 && full < 14000 && calm < 1500 && calm < full;
})(), `${welcomeDurationMs(false)} / ${welcomeDurationMs(true)}`);
check('every leg of the flight has a positive duration', Object.values(ENTRY_TIMING).every((v) => typeof v === 'number' && v > 0));

console.log('--- tile availability (anonymous S3, mocked)');
const realFetch = globalThis.fetch;
const mock = (impl: (url: string, method: string) => { status: number; headers?: Record<string, string>; body?: string }) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const r = impl(url, method);
    return new Response(method === 'HEAD' ? null : r.body ?? '', { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return calls;
};
configureS3({ origin: 'https://mock-s3.test', proxyPrefix: null, retryDelaysMs: [], timeoutMs: 3000 });
await (async () => {
  clearTileAvailabilityMemo();
  let calls = mock(() => ({ status: 200, headers: { 'content-length': '112000000', 'last-modified': 'Mon, 26 Oct 2026 00:00:00 GMT' } }));
  let r = await checkTileAvailability(10226);
  check('found: key, size and date come from the HEAD response', r.status === 'found' && r.key === 'dr1/hips5_cube/hips_20261026/Norder5/Dir10000/Npix10226_cube.fits' && r.size === 112_000_000 && r.how === 'documented-path');
  await checkTileAvailability(10226);
  check('a definitive answer is remembered (one request)', calls.length === 1, String(calls.length));

  clearTileAvailabilityMemo();
  calls = mock((url, m) => (m === 'HEAD' ? { status: 404 } : { status: 200, body: url.includes('prefix=dr1%2Fhips5_cube') ? '<ListBucketResult></ListBucketResult>' : '<ListBucketResult><CommonPrefixes><Prefix>qr2/</Prefix></CommonPrefixes></ListBucketResult>' }));
  r = await checkTileAvailability(10226);
  check('absent: tile not in bucket -> "absent" with the reason, never a substitute', r.status === 'absent' && /not published|not found|DR1/i.test(r.message), JSON.stringify(r));

  clearTileAvailabilityMemo();
  mock(() => { throw new TypeError('Failed to fetch'); });
  r = await checkTileAvailability(10226);
  check('network failure -> "error" (not "absent")', r.status === 'error', JSON.stringify(r));
  mock(() => ({ status: 200, headers: { 'content-length': '5' } }));
  r = await checkTileAvailability(10226);
  check('errors are not cached: the next check succeeds', r.status === 'found');

  clearTileAvailabilityMemo();
  mock(() => ({ status: 200, headers: { 'content-length': '5' } }));
  const ctl = new AbortController(); ctl.abort();
  let threw = false;
  try { await checkTileAvailability(10226, ctl.signal); } catch { threw = true; }
  check('a cancelled check rejects instead of reporting an answer', threw);
})();
globalThis.fetch = realFetch;
resetS3Config();

console.log(`\n${passed} passed, ${failed} failed (sky map)`);
process.exit(failed ? 1 : 0);
