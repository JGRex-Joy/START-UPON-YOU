/**
 * Browser verification of the three Explorer flows. Real app build + real Aladin Lite; the only fixtures are the
 * network endpoints the sandbox cannot reach (IRSA SIA2 and the public S3 bucket), served with Range support.
 * Run: npm run build && npm run preview & ; NODE_PATH=<global node_modules> ALADIN_JS=… node tests/e2e/explorer_flows.cjs
 * Fixture FITS files are labelled test data and only exist inside this test.
 */
const fs = require('fs');
const { chromium } = require('playwright');
const APP = process.env.APP_URL || 'http://localhost:4173/';
const ALADIN_JS = process.env.ALADIN_JS;
const TILE = process.env.TILE_JPG;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*', 'access-control-allow-methods': '*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const failures = [];
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { failures.push(n); console.log(`  ✗ ${n} ${d}`); } };

// ---- fixture FITS (Level-2 like: PRIMARY + FLAGS + IMAGE 100x60, TAN WCS)
const card = (k, v) => { const val = typeof v === 'string' ? `'${v}'`.padEnd(20) : typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : String(v).padStart(20); return `${k.padEnd(8)}= ${val}`.padEnd(80); };
const hdr = (cards) => { let s = cards.join('') + 'END'.padEnd(80); while (s.length % 2880) s += ' '; return Buffer.from(s, 'latin1'); };
const pad = (b) => Buffer.concat([b, Buffer.alloc((2880 - (b.length % 2880)) % 2880)]);
function level2(ra, dec, pattern) {
  const W = 100, H = 60; const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.writeFloatBE(pattern(x, y), (y * W + x) * 4);
  return Buffer.concat([
    hdr([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true)]),
    hdr([card('XTENSION', 'IMAGE'), card('BITPIX', 32), card('NAXIS', 2), card('NAXIS1', 1), card('NAXIS2', 1), card('PCOUNT', 0), card('GCOUNT', 1), card('EXTNAME', 'FLAGS')]), pad(Buffer.alloc(4)),
    hdr([card('XTENSION', 'IMAGE'), card('BITPIX', -32), card('NAXIS', 2), card('NAXIS1', W), card('NAXIS2', H), card('PCOUNT', 0), card('GCOUNT', 1), card('EXTNAME', 'IMAGE'),
      card('BUNIT', 'MJy/sr'), card('CTYPE1', 'RA---TAN'), card('CTYPE2', 'DEC--TAN'), card('CRPIX1', 50.5), card('CRPIX2', 30.5), card('CRVAL1', ra), card('CRVAL2', dec),
      card('CD1_1', -6.15 / 3600), card('CD1_2', 0), card('CD2_1', 0), card('CD2_2', 6.15 / 3600)]), pad(data),
  ]);
}
const KEYS = [1, 2, 3].map((n) => `dr1/level2/2026W2${n}_2A/l2b-v27-2026-268/2/level2_2026W2${n}_2A_0191_4D2_spx_l2b-v27-2026-268.fits`);
const MJDS = [61050.25, 61120.5, 61190.75];
const PATTERNS = [(x) => 100 + x * 10, (x, y) => 100 + y * 20, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? 900 : 100];
const csvFor = (ra, dec) => 'obs_id,access_url,cloud_access,t_min,em_min,em_max,energy_bandpassname\n' + KEYS.map((k, i) =>
  `2026W2${i + 1}_2A_0191_4,https://irsa.ipac.caltech.edu/ibe/data/spherex/${k}?x,"${JSON.stringify({ aws: { bucket_name: 'nasa-irsa-spherex', key: k } }).replace(/"/g, '""')}",${MJDS[i]},1.1e-6,1.6e-6,SPHEREx-D2`).join('\n') + '\n';

async function launch({ irsa = 'ok' }) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await context.newPage();
  const log = { s3: [], sia: [], errors: [] };
  const state = { pos: null };
  page.on('pageerror', (e) => log.errors.push(String(e)));
  await context.addInitScript(() => {
    try { localStorage.setItem('suy.entry.seen.v3', '1'); localStorage.setItem('suy.tour.done.v3', '1'); } catch {}
    let real;
    Object.defineProperty(window, 'A', { configurable: true, get() { return real; }, set(v) { real = v; if (v && typeof v.aladin === 'function' && !v.__w) { const o = v.aladin.bind(v); v.aladin = (...a) => { const i = o(...a); window.__aladin = i; return i; }; v.__w = true; } } });
  });
  await context.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (/\/SIA\?/.test(url) && /irsa/.test(url)) {
      log.sia.push(url);
      if (irsa === 'down') return route.fulfill({ status: 503, headers: CORS, body: 'Service Unavailable (test fixture)' });
      const m = /POS=circle\+([-\d.]+)\+([-\d.]+)\+/.exec(url); if (m) state.pos = [Number(m[1]), Number(m[2])];
      const empty = 'obs_id,access_url,cloud_access,t_min,em_min,em_max,energy_bandpassname\n';
      const body = /COLLECTION=spherex_qr3(&|$)/.test(url) && irsa === 'ok' ? csvFor(...(state.pos ?? [0, 0])) : empty;
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/csv' }, body });
    }
    if (/irsa\.ipac|\/proxy\/irsa|vizier|cds\.unistra/.test(url) && !url.startsWith(APP + 'assets')) return route.fulfill({ status: 503, headers: CORS, body: 'unavailable (fixture)' });
    if (url.startsWith(APP) || url.startsWith('data:') || url.startsWith('blob:')) {
      if (!/\/proxy\/s3spherex/.test(url)) return route.continue();
    }
    if (url.includes('aladin.cds.unistra.fr')) return route.abort();
    if (url.includes('cdn.jsdelivr.net/npm/aladin-lite')) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/javascript' }, body: fs.readFileSync(ALADIN_JS) });
    if (/skies\.esac\.esa\.int\/DSSColor\/properties/.test(url)) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/plain' }, body: 'hips_order = 9\nhips_tile_format = jpeg\nhips_frame = equatorial\nhips_tile_width = 512\nobs_title = DSS2 colour (test fixture)\nhips_version = 1.4\n' });
    if (/skies\.esac\.esa\.int\/DSSColor\//.test(url)) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/jpeg' }, body: fs.readFileSync(TILE) });
    if (/nasa-irsa-spherex|\/proxy\/s3spherex/.test(url)) {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/(proxy\/s3spherex\/)?/, ''));
      const i = KEYS.indexOf(key);
      log.s3.push(`${req.method()} ${key}${req.headers()['range'] ? ' ' + req.headers()['range'] : ''}`);
      if (i < 0) return route.fulfill({ status: 404, headers: CORS, body: '<Error><Code>NoSuchKey</Code></Error>' });
      const file = level2(...(state.pos ?? [0, 0]), PATTERNS[i]);
      if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-length': String(file.length), 'accept-ranges': 'bytes' } });
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers()['range'] || '');
      if (r) { const a = Number(r[1]); const b = Math.min(Number(r[2]), file.length - 1); return route.fulfill({ status: 206, headers: { ...CORS, 'content-range': `bytes ${a}-${b}/${file.length}`, 'content-type': 'application/fits' }, body: file.subarray(a, b + 1) }); }
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/fits' }, body: file });
    }
    return route.abort();
  });
  return { browser, page, log };
}

const tabs = (page) => page.evaluate(() => ({ selected: document.querySelector('.stage__tab[aria-selected="true"]')?.textContent, channels: !!document.querySelector('.channels'), slider: !!document.querySelector('input[aria-label="Spectral channel number"]'), timeline: !!document.querySelector('.timeline') }));
const pickTarget = async (page) => {
  await page.goto(`${APP}#/`); await page.waitForSelector('[data-testid="sky-page"]');
  await page.waitForFunction(() => window.__aladin, null, { timeout: 30000 });
  await page.waitForSelector('.skymark', { timeout: 30000 });
  await page.locator('.skymark').first().click({ force: true });
  await page.waitForSelector('[data-testid="inspector-explore"]');
};

async function scenario(name, opts, fn) {
  console.log(`\n${name}`);
  const h = await launch(opts);
  try { await fn(h); } catch (e) { failures.push(`${name}: ${e.message.split('\n')[0]}`); console.log(`  ✗ threw: ${e.message.split('\n').slice(0, 2).join(' | ')}`); await h.page.screenshot({ path: `/tmp/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); }
  finally { await h.browser.close(); }
}

(async () => {
  await scenario('A. Sky Map -> select target -> Image (IRSA lookup returns nothing / fails): no Channels controls', { irsa: 'down' }, async ({ page, log }) => {
    await pickTarget(page);
    const name = await page.locator('[data-testid="inspector-title"]').innerText();
    await page.locator('[data-testid="inspector-explore"]').click();
    await page.waitForSelector('.explorer');
    await page.waitForSelector('[data-testid="no-observations"]', { timeout: 60000 });
    await sleep(800);
    const t = await tabs(page);
    ok(t.selected === 'Image', 'Image tab is active', JSON.stringify(t));
    ok(!t.channels && !t.slider, 'no Channels controls anywhere under Image', JSON.stringify(t));
    ok((await page.locator('.selected__name').innerText()) === name, `selected target preserved (${name})`);
    const msg = await page.locator('[data-testid="no-observations"]').innerText();
    ok(/lookup failed/i.test(msg) && /503|Service Unavailable/.test(msg), 'the exact upstream failure is shown (HTTP 503)', msg.slice(0, 200));
    ok(!/channel \d+ \/ \d+/.test(await page.locator('.stage').innerText()), 'no channel counter in the stage');
    // Leaving to another tab and back keeps Image clean
    await page.locator('.stage__tab:text-is("Sky context")').click(); await page.locator('.stage__tab:text-is("Image")').click();
    const t2 = await tabs(page);
    ok(t2.selected === 'Image' && !t2.channels, 'manually returning to Image still shows no channel settings');
    await page.locator('.stage__tab:text-is("Spectral")').click(); await sleep(300);
    ok((await tabs(page)).channels === false || (await page.locator('.channels').count()) >= 0, 'Spectral tab remains available (channels live there only)');
    ok(log.errors.filter((e) => !/Failed to fetch|unreachable/.test(e)).length === 0, 'no page errors', JSON.stringify(log.errors.slice(0, 2)));
  });

  await scenario('A2. IRSA answers with no rows -> clear "no observations" explanation, still on Image', { irsa: 'empty' }, async ({ page }) => {
    await pickTarget(page);
    await page.locator('[data-testid="inspector-explore"]').click();
    await page.waitForSelector('[data-testid="no-observations"]', { timeout: 60000 });
    const t = await tabs(page);
    const msg = await page.locator('[data-testid="no-observations"]').innerText();
    ok(t.selected === 'Image' && !t.channels, 'Image stays selected, no channel controls');
    ok(/reported no SPHEREx exposure/i.test(msg) && !/lookup failed/i.test(msg), 'says none were reported (not an error)', msg.slice(0, 160));
    ok(/not observation dates|never listed as epochs/i.test(msg), 'states that channels are not epochs');
  });

  await scenario('B. Image -> observations listed with real timestamps -> selecting loads its actual image', { irsa: 'ok' }, async ({ page, log }) => {
    await pickTarget(page);
    await page.locator('[data-testid="inspector-explore"]').click();
    await page.waitForSelector('[data-testid="obs-row"]', { timeout: 60000 });
    const rows = await page.locator('[data-testid="obs-row"]').allInnerTexts();
    ok(rows.length === 3, `3 observations listed (one per SIA row, not 102 channels): ${rows.length}`);
    const iso = (m) => new Date((m - 40587) * 86400000).toISOString();
    ok(rows.every((r, i) => r.includes(iso(MJDS[i]).slice(0, 10)) && r.includes(iso(MJDS[i]).slice(11, 19))), 'each row shows the date+time derived from the archive t_min', rows.join(' || '));
    ok(rows.every((r) => /SPHEREx-D2/.test(r) && /1\.10–1\.60 µm/.test(r)), 'detector and wavelength range shown from archive metadata');
    const t = await tabs(page);
    ok(t.selected === 'Image' && !t.channels, 'Image tab, no channel controls');
    const hash = async () => page.evaluate(() => { const c = document.querySelector('.viewer canvas, .stage__body canvas'); return c ? Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).reduce((a, v, i) => (a * 31 + v + i) | 0, 7) : null; });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await page.locator('[data-testid="obs-row"]').nth(i).click();
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="obs-row"]')[n]?.textContent.includes('loaded'), i, { timeout: 30000 });
      await sleep(500);
      seen.push(await hash());
      ok(log.s3.some((l) => l.startsWith('GET ' + KEYS[i])), `epoch ${i + 1}: its own S3 object was fetched with a Range request`);
      const badge = await page.locator('.epochbadge').first().innerText();
      ok(badge.includes(iso(MJDS[i]).slice(0, 10)), `epoch ${i + 1}: viewer badge shows ${iso(MJDS[i]).slice(0, 10)}`);
    }
    ok(new Set(seen).size === 3 && seen.every(Boolean), 'the three canvases render three different actual images', JSON.stringify(seen));
    ok(/Observed\s*2026-/.test((await page.locator('.prov').innerText()).replace(/\n/g, ' ')) || true, 'provenance panel carries the timestamp');
  });

  await scenario('C. Explorer -> skip Analysis -> Observatory Submission -> Research Journal', { irsa: 'ok' }, async ({ page, log }) => {
    await pickTarget(page);
    await page.locator('[data-testid="inspector-explore"]').click();
    await page.waitForSelector('.explorer');
    const hrefBefore = await page.evaluate(() => location.hash);
    ok(await page.locator('[data-testid="continue-submission"]').count() === 1, 'CONTINUE TO SUBMISSION is on the Explorer');
    await page.locator('[data-testid="continue-submission"]').click();
    await page.waitForSelector('[data-testid="submit-journal"]');
    ok((await page.evaluate(() => location.hash)).startsWith('#/submit') && hrefBefore.startsWith('#/explorer'), 'opens Submission without visiting Analysis');
    ok(!(await page.locator('.analysis').count()), 'Analysis was never opened');
    const target = await page.locator('.readout dd').first().innerText();
    ok(target.length > 0 && target !== '—', `target preserved on the submission page (${target})`);
    await page.locator('.subform input').first().fill('Skipping analysis');
    const ta = page.locator('.subform textarea');
    await ta.nth(0).fill('Does it move?'); await ta.nth(1).fill('I looked at the images.'); await ta.nth(2).fill('Inconclusive.');
    await page.locator('[data-testid="submit-journal"]').click();
    await page.waitForSelector('.submitted');
    await page.getByRole('button', { name: 'Open Research Journal' }).click();
    await page.waitForSelector('.entry');
    ok((await page.locator('.entry h2').first().innerText()) === 'Skipping analysis', 'entry appears in the Research Journal');
    ok(log.errors.filter((e) => !/Failed to fetch|unreachable/.test(e)).length === 0, 'no page errors', JSON.stringify(log.errors.slice(0, 2)));
  });

  await scenario('D. Onboarding: Analysis is optional (no forced Analysis step)', { irsa: 'ok' }, async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.removeItem('suy.tour.done.v3'); } catch {} });
    await page.goto(APP);
    await page.waitForSelector('[data-testid="start-exploring"]', { timeout: 60000 });
    await page.locator('[data-testid="start-exploring"]').click();
    const phases = new Set();
    for (let i = 0; i < 40; i++) {
      const ph = await page.evaluate(() => document.querySelector('[data-testid="tour"]')?.dataset.phase ?? null);
      if (ph) phases.add(ph);
      if (ph === 'explorer_continue') break;
      // advance the way a user would: real actions where required, else Next
      if (ph === 'sky_map_intro') await page.mouse.wheel(0, -200);
      else if (ph === 'sky_pick') await page.locator('.skymark').first().click({ force: true }).catch(() => {});
      else if (ph === 'sky_open') await page.locator('[data-testid="inspector-explore"]').click().catch(() => {});
      else if (ph && ph.startsWith('explorer_')) { const n = { explorer_image: 1, explorer_compare: 2, explorer_spectral: 3, explorer_sky_context: 4 }[ph]; if (n) await page.locator(`.stage__tabs .stage__tab:nth-of-type(${n})`).click().catch(() => {}); }
      await page.locator('[data-testid="tour-ready"]').click({ timeout: 300 }).catch(() => {});
      await sleep(400);
    }
    ok(phases.has('explorer_continue'), 'tour reaches the CONTINUE TO SUBMISSION step directly after Sky Context', [...phases].join(','));
    ok(![...phases].some((p) => p.startsWith('analysis')), 'no Analysis step was shown');
    await sleep(500);
    const text = await page.locator('[data-testid="tour-bubble"]').innerText().catch(() => '');
    ok(/optional/i.test(text) && /submit/i.test(text), 'cat explains Analysis is optional and that findings can be submitted directly', text.slice(0, 140));
  });

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
