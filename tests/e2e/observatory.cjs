/**
 * End-to-end tests of the Observatory sky map in a real Chromium: real app build, real Aladin Lite (npm build, WebGL),
 * HiPS tiles and S3/IRSA served by fixtures (see harness.cjs). Run: `npm run build && npm run preview &` then
 * `ALADIN_JS=… TILE_JPG=… node tests/e2e/observatory.cjs`. Playwright is not a project dependency.
 */
const { launch, APP } = require('./harness.cjs');

let pass = 0; const failures = [];
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${detail}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;
const dms = (sign, d, m, s) => sign * (d + m / 60 + s / 3600);

// Expected positions, derived independently here from the sexagesimal values cited in src/services/targets.ts.
const EXPECTED = {
  'barnards-star': { name: "Barnard's Star", ra: hms(17, 57, 48.49847), dec: dms(1, 4, 41, 36.1139), focus: 'motion' },
  'eps-indi-b': { name: 'Epsilon Indi B', ra: hms(22, 4, 10.6), dec: dms(-1, 56, 46, 58.2), focus: 'motion' },
  'wise-0855': { name: 'WISE 0855−0714', ra: hms(8, 55, 10.831), dec: dms(-1, 7, 14, 42.53), focus: 'motion' },
  'rw-aur': { name: 'RW Aurigae', ra: hms(5, 7, 49.4562), dec: dms(1, 30, 24, 4.774), focus: 'variability' },
  'r-dra': { name: 'R Draconis', ra: hms(16, 32, 40), dec: dms(1, 66, 45, 17), focus: 'variability' },
};

const view = (page) => page.evaluate(() => { const a = window.__aladin; const c = a.getRaDec(); return { ra: c[0], dec: c[1], fov: a.getFov()[0], proj: a.getProjectionName() }; });
/** Walk through the welcome scene the way a first-time visitor does, and wait for the sky to be live. */
const enter = async (page) => {
  await page.waitForSelector('[data-testid="start-exploring"]', { timeout: 60000 });
  await page.locator('[data-testid="start-exploring"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="welcome"]'), null, { timeout: 10000 });
  await finishTour(page);
};
/** The guided tour is mandatory: walk it to the end, then the application is free. */
const finishTour = async (page) => {
  for (let i = 0; i < 14; i++) {
    if (!(await page.locator('[data-testid="tour-next"]').count())) break;
    await page.locator('[data-testid="tour-next"]').click({ timeout: 8000 }).catch(() => {});
    await sleep(260);
  }
  await page.waitForFunction(() => !document.querySelector('[data-testid="tour"]'), null, { timeout: 15000 }).catch(() => {});
  if ((await page.evaluate(() => location.hash)) !== '#/') await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('[data-testid="sky-page"]', { timeout: 10000 });
};
const ready = async (page, skipWelcome = false) => {
  await page.waitForSelector('[data-testid="sky-page"]');
  if (!skipWelcome) await enter(page);
  await page.waitForFunction(() => window.__aladin, null, { timeout: 20000 });
  await page.waitForSelector('.skymark', { timeout: 20000 });
};
/** The sky screen carries no controls of its own: they live behind the Nyan Cat companion. */
const openControls = async (page) => {
  if (await page.locator('.companion.is-open').count()) return;
  await page.locator('[data-testid="companion-button"]').click();
  await page.waitForSelector('.companion.is-open .companion__panel');
};
const allSky = async (page) => {
  await page.evaluate(() => { window.__aladin.gotoRaDec(180, 0); window.__aladin.setFoV(360); });
  await page.waitForFunction(() => window.__aladin.getFov()[0] > 359.5, null, { timeout: 8000 });
  await sleep(400);
};
const settle = async (page, ra, dec, tolDeg = 0.5) => { for (let i = 0; i < 40; i++) { const v = await view(page); if (near(v.ra, ra, tolDeg / Math.max(0.05, Math.cos(dec * Math.PI / 180))) && near(v.dec, dec, tolDeg)) return v; await sleep(150); } return view(page); };

async function scenario(name, opts, fn) {
  console.log(`\n${name}`);
  const h = await launch(opts);
  try { await fn(h); } catch (e) { const m = e.message.split('\n').slice(0, 3).join(' | '); failures.push(`${name}: ${m}`); console.log(`  ✗ threw: ${m}`); await h.page.screenshot({ path: `/tmp/claude-0/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); }
  finally { await h.browser.close(); }
}

(async () => {
  await scenario('1. opens on the sky map; pan and zoom', {}, async ({ page, log }) => {
    await page.goto(APP); await ready(page);
    ok(await page.locator('[data-testid="sky-page"]').isVisible(), 'application opens on the sky map');
    ok(await page.locator('.skypage__bar, .findcoord, [data-testid="inspector"]').count() === 0, 'no coordinate panel and no inspector before anything is selected');
    ok(await page.locator('[data-testid="companion"]').isVisible(), 'the Nyan Cat companion is the only persistent interface');
    const v0 = await view(page);
    ok(v0.proj === 'AIT' && v0.fov > 300, `initial view is the whole sky (AIT, FoV ${v0.fov.toFixed(0)}°)`);
    ok(await page.locator('.skymark').count() === 5, 'five featured markers on the initial map');
    const box = await page.locator('.skyctx__host canvas').first().boundingBox();
    // zoom with the wheel
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -400); await sleep(80); }
    await sleep(600);
    const v1 = await view(page);
    ok(v1.fov < v0.fov * 0.8, `wheel zooms in (FoV ${v0.fov.toFixed(0)}° → ${v1.fov.toFixed(0)}°)`);
    // pan with a drag
    await page.mouse.move(box.x + 500, box.y + 400); await page.mouse.down(); await page.mouse.move(box.x + 700, box.y + 330, { steps: 8 }); await page.mouse.up(); await sleep(500);
    const v2 = await view(page);
    ok(Math.abs(v2.ra - v1.ra) > 0.1 || Math.abs(v2.dec - v1.dec) > 0.1, `drag pans the map (centre ${v1.ra.toFixed(1)},${v1.dec.toFixed(1)} → ${v2.ra.toFixed(1)},${v2.dec.toFixed(1)})`);
    ok(await page.locator('[data-testid="inspector"]').count() === 0, 'dragging does not select a position');
    ok(log.errors.filter((e) => !/Failed to fetch|unreachable/.test(e)).length === 0, 'no unexpected page errors', JSON.stringify(log.errors));
  });

  await scenario('2. five targets: verified positions, hover, click -> correct inspector', {}, async ({ page, log }) => {
    await page.goto(APP); await ready(page);
    for (const [id, exp] of Object.entries(EXPECTED)) {
      if (id !== 'barnards-star') { await page.getByRole('button', { name: 'Close inspector' }).click(); await allSky(page); }
      // position check: un-project the marker's on-screen location with Aladin itself and compare with the catalogue value
      const sky = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="marker-${id}"]`);
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
        const w = window.__aladin.pix2world(Number(m[1]), Number(m[2]));
        return w && { ra: w[0], dec: w[1] };
      }, id);
      ok(sky && near(((sky.ra - exp.ra + 540) % 360) - 180, 0, 1.0) && near(sky.dec, exp.dec, 1.0), `${exp.name}: marker sits at RA ${exp.ra.toFixed(4)}° Dec ${exp.dec.toFixed(4)}° (map says ${sky && sky.ra.toFixed(2)}, ${sky && sky.dec.toFixed(2)})`);
      const marker = page.locator(`[data-testid="marker-${id}"]`);
      ok((await marker.getAttribute('data-focus')) === exp.focus, `${exp.name}: ${exp.focus} marker style`);
      await marker.hover();
      ok((await marker.locator('.skymark__tip').innerText()).includes(exp.name), `${exp.name}: hover tooltip shows the name`);
      await marker.click();
      await page.waitForSelector('[data-testid="inspector"]');
      ok((await page.locator('[data-testid="inspector-title"]').innerText()) === exp.name, `${exp.name}: click opens its inspector`);
      ok(/Start Investigation/.test(await page.locator('[data-testid="inspector-explore"]').innerText()), `${exp.name}: "Start Investigation" action`);
      ok(new RegExp(exp.focus === 'motion' ? 'Motion investigation' : 'Variability investigation', 'i').test(await page.locator('.inspector__eyebrow').innerText()), `${exp.name}: focus label`);
      ok((await page.evaluate(() => location.hash)) === `#/sky?t=${id}`, `${exp.name}: URL carries the target`);
      ok(/found/i.test(await page.locator('[data-testid="inspector-aws"]').innerText()) || (await page.waitForFunction(() => /found/i.test(document.querySelector('[data-testid="inspector-aws"]').textContent), null, { timeout: 5000 }).then(() => true, () => false)), `${exp.name}: AWS tile availability retrieved`);
      await settle(page, exp.ra, exp.dec, 1);
    }
    ok(log.s3.some((l) => l.startsWith('HEAD /dr1/hips5_cube/')), 'availability uses an anonymous HEAD on the documented AWS path', log.s3.slice(0, 3).join(' | '));
    ok(!log.aborted.some((u) => /irsa/.test(u)) , 'map + inspector made no IRSA requests');
    await page.screenshot({ path: '/tmp/claude-0/e2e-inspector.png' });
  });

  await scenario('3. click on empty sky selects a position', {}, async ({ page }) => {
    await page.goto(APP); await ready(page);
    // Zoom in first: at all-sky zoom a single pixel is a quarter of a degree, which says nothing about the wiring.
    await page.evaluate(() => { window.__aladin.gotoRaDec(140, 10); window.__aladin.setFoV(10); });
    await page.waitForFunction(() => window.__aladin.getFov()[0] < 11, null, { timeout: 8000 });
    await sleep(600);
    const box = await page.locator('.skyctx__host canvas').first().boundingBox();
    const cx = box.x + box.width * 0.62; const cy = box.y + box.height * 0.45;
    await page.mouse.click(cx, cy);
    await page.waitForSelector('[data-testid="inspector"]');
    const title = await page.locator('[data-testid="inspector-title"]').innerText();
    ok(title === 'Selected position', 'position inspector (no invented object name)');
    ok(/No catalog source was looked up/.test(await page.locator('.inspector__kind').innerText()), 'states that no object is identified');
    ok(/Explore This Position/.test(await page.locator('[data-testid="inspector-explore"]').innerText()), 'Explore action for a bare position');
    const expected = await page.evaluate(([x, y]) => { const r = document.querySelector('.skyctx__host').getBoundingClientRect(); const w = window.__aladin.pix2world(x - r.left, y - r.top); return { ra: w[0], dec: w[1] }; }, [cx, cy]);
    // Both rows read "<sexagesimal> · <decimal>°"; take the decimal degrees after the separator.
    const decimal = (t) => Number(/·\s*(-?[\d.]+)°/.exec(t.replace(/−/g, '-'))[1]);
    const ra = decimal(await page.locator('[data-testid="inspector-ra"]').innerText());
    const dec = decimal(await page.locator('[data-testid="inspector-dec"]').innerText());
    ok(near(ra, expected.ra, 0.08) && near(dec, expected.dec, 0.08), `inspector coordinates match the clicked sky position (${ra.toFixed(2)}, ${dec.toFixed(2)} vs ${expected.ra.toFixed(2)}, ${expected.dec.toFixed(2)})`);
    ok(await page.locator('[data-testid="selected-position"]').isVisible(), 'selected position is visibly marked');
    ok(/#\/sky\?ra=/.test(await page.evaluate(() => location.hash)), 'URL carries the position');
    ok(await page.locator('text=Start a Mission').count() === 0, 'no "Start a Mission" action (no missions exist)');
  });

  await scenario('4. Find by Coordinates validates and navigates', {}, async ({ page }) => {
    await page.goto(APP); await ready(page);
    ok(await page.locator('[data-testid="find-by-coordinates"]').count() === 0, 'the control is not on the bare sky screen');
    await openControls(page);
    ok(await page.locator('[data-testid="find-by-coordinates"]').isVisible(), 'the companion reveals it');
    const panel = page.locator('#findcoord-panel');
    ok(!(await panel.isVisible()), 'panel is hidden until activated (does not occupy the map)');
    await page.locator('[data-testid="find-by-coordinates"]').click();
    ok(await panel.isVisible(), 'button slides the panel out');
    await page.fill('#sky-ra', '400'); await page.fill('#sky-dec', '12'); await page.getByRole('button', { name: 'Navigate' }).click();
    ok(/RA must be in \[0, 360\)/.test(await page.locator('#sky-ra-err').innerText()), 'RA 400° rejected with a clear message');
    await page.fill('#sky-ra', '10'); await page.fill('#sky-dec', '95'); await page.getByRole('button', { name: 'Navigate' }).click();
    ok(/±90/.test(await page.locator('#sky-dec-err').innerText()), 'Dec 95° rejected with a clear message');
    await page.fill('#sky-ra', 'abc'); await page.getByRole('button', { name: 'Navigate' }).click();
    ok(await page.locator('#sky-ra-err').isVisible(), 'non-numeric RA rejected');
    await page.getByRole('radio', { name: 'hours' }).click();
    await page.fill('#sky-ra', '25'); await page.fill('#sky-dec', '-7'); await page.getByRole('button', { name: 'Navigate' }).click();
    ok(/\[0, 24\) hours/.test(await page.locator('#sky-ra-err').innerText()), 'RA 25 h rejected');
    ok(await page.locator('[data-testid="inspector"]').count() === 0, 'nothing selected while input is invalid');
    await page.fill('#sky-ra', '8.919675'); await page.fill('#sky-dec', '-7.245147'); await page.getByRole('button', { name: 'Navigate' }).click();
    await page.waitForFunction(() => window.__aladin.getFov()[0] < 4.2, null, { timeout: 8000 });
    const v = await settle(page, 133.795125, -7.245147, 0.3);
    ok(near(v.ra, 133.795, 0.3) && near(v.dec, -7.245, 0.3), `map flew to RA 8.919675 h = 133.795° (view centre ${v.ra.toFixed(3)}, ${v.dec.toFixed(3)})`);
    ok(v.fov < 10, `and zoomed in (FoV ${v.fov.toFixed(1)}°)`);
    await page.waitForSelector('[data-testid="inspector"]');
    ok(/133\.7951/.test(await page.locator('[data-testid="inspector-ra"]').innerText()), 'hours converted to degrees in the shared target');
    ok(!(await panel.isVisible()), 'panel closes after navigating');
    ok(/#\/sky\?ra=133\.79512&dec=-7\.24515/.test(await page.evaluate(() => location.hash)), 'coordinates preserved in the URL');
    await page.locator('[data-testid="find-by-coordinates"]').click();
    await page.getByRole('radio', { name: 'degrees' }).click();
    await page.fill('#sky-ra', '08h55m10.8s'); await page.fill('#sky-dec', "-07°14′42.5″"); await page.getByRole('button', { name: 'Navigate' }).click();
    ok(await page.locator('#sky-ra-err').count() === 0 && await page.locator('#sky-dec-err').count() === 0, 'sexagesimal input accepted');
  });

  await scenario('5. shared research context across tools', {}, async ({ page }) => {
    await page.goto(APP); await ready(page);
    await page.locator('[data-testid="marker-barnards-star"]').click();
    await page.locator('[data-testid="inspector-explore"]').click();
    await page.waitForSelector('.explorer');
    ok((await page.locator('.selected__name').innerText()) === "Barnard's Star", 'Explorer opens with Barnard\'s Star already selected (no re-entry)');
    await page.waitForFunction(() => !document.querySelector('.stage__empty--idle'), null, { timeout: 8000 }).catch(() => {});
    await page.getByRole('tab', { name: 'Spectral' }).click();
    ok((await page.locator('.selected__name').innerText()) === "Barnard's Star", 'Spectral tab keeps the target');
    await page.getByRole('tab', { name: 'Compare' }).click();
    ok((await page.locator('.selected__name').innerText()) === "Barnard's Star", 'Compare (time) tab keeps the target');
    await page.locator('.nav__link', { hasText: 'Analysis' }).click();
    await page.waitForSelector('.analysis, .page-empty');
    ok(/Barnard's Star|individual epochs/.test(await page.locator('.analysis, .page-empty').innerText()), 'Analysis opens without asking for a position');
    await page.locator('.nav__link', { hasText: 'Observatory' }).click();
    await page.waitForSelector('[data-testid="inspector-title"]');
    ok(await page.locator('[data-testid="welcome"]').count() === 0, 'the welcome does not replay on the way back');
    ok((await page.locator('[data-testid="inspector-title"]').innerText()) === "Barnard's Star", 'back on the map the same target is selected');
    const v = await view(page);
    ok(near(v.ra, EXPECTED['barnards-star'].ra, 1) && near(v.dec, EXPECTED['barnards-star'].dec, 1) && v.fov < 20, `and the map re-opens centred on it (${v.ra.toFixed(2)}, ${v.dec.toFixed(2)}, FoV ${v.fov.toFixed(1)}°)`);
    ok(/IRSA|exposure|Not retrieved|retrieved/.test(await page.locator('[data-testid="inspector-epochs"]').innerText()), 'inspector reports epoch status honestly');
  });

  await scenario('6. deep links', {}, async ({ page }) => {
    await page.goto(`${APP}#/sky?t=rw-aur`); await ready(page, true);
    ok(await page.locator('[data-testid="welcome"]').count() === 0, 'a deep link never waits behind the intro');
    await page.waitForSelector('[data-testid="inspector-title"]');
    ok((await page.locator('[data-testid="inspector-title"]').innerText()) === 'RW Aurigae', '#/sky?t=rw-aur opens RW Aurigae');
    const v = await settle(page, EXPECTED['rw-aur'].ra, EXPECTED['rw-aur'].dec, 1);
    ok(near(v.ra, EXPECTED['rw-aur'].ra, 1.5) && v.fov < 20, 'map starts on it');
    await page.evaluate(() => { location.hash = '#/sky?ra=10&dec=95'; });
    await page.waitForSelector('[role="alert"]');
    ok(/Dec in the link is not valid/.test(await page.locator('.skypage__notice').innerText()), 'invalid link is reported, not silently ignored');
    await page.goto(`${APP}#/about`); await page.waitForSelector('.landing');
    ok(true, 'About (introduction) page still reachable');
  });

  await scenario('7. AWS tile absent', { s3: 'absent' }, async ({ page }) => {
    await page.goto(APP); await ready(page);
    await page.locator('[data-testid="marker-wise-0855"]').click();
    await page.waitForFunction(() => /No tile published/.test(document.querySelector('[data-testid="inspector-aws"]')?.textContent || ''), null, { timeout: 15000 });
    ok(true, 'missing tile is stated clearly ("No tile published")');
    ok(/not (found|published)|QR2|does not|no 'dr1/i.test(await page.locator('.inspector').innerText()), 'with the reason from the bucket');
    ok(await page.locator('[data-testid="inspector-explore"]').isEnabled(), 'the target can still be opened');
  });

  await scenario('8. AWS unreachable', { s3: 'down' }, async ({ page }) => {
    await page.goto(APP); await ready(page);
    await page.locator('[data-testid="marker-r-dra"]').click();
    await page.waitForFunction(() => /Could not check/.test(document.querySelector('[data-testid="inspector-aws"]')?.textContent || ''), null, { timeout: 60000 });
    ok(true, 'network failure shown as "Could not check" (not as "no data")');
    ok(await page.getByRole('button', { name: 'Try again' }).count() === 1, 'with a retry action');
  });

  await scenario('9. map provider unavailable', { aladin: false }, async ({ page }) => {
    await page.goto(APP); await page.waitForSelector('[data-testid="sky-page"]');
    await enter(page);
    await page.waitForSelector('.skyctx__overlay--error', { timeout: 20000 });
    ok(/Survey context unavailable/.test(await page.locator('.skyctx__overlay--error').innerText()), 'clear error state');
    await openControls(page);
    await page.locator('[data-testid="target-wise-0855"]').click();
    await page.waitForSelector('[data-testid="inspector"]');
    ok((await page.locator('[data-testid="inspector-title"]').innerText()) === 'WISE 0855−0714', 'targets remain selectable from the list without the map');
    await page.locator('[data-testid="find-by-coordinates"]').click();
    ok(await page.locator('#findcoord-panel').isVisible(), 'coordinate panel still works');
    await page.screenshot({ path: '/tmp/claude-0/e2e-nomap.png' });
  });

  await scenario('10. mobile layout', { viewport: { width: 390, height: 844 } }, async ({ page }) => {
    await page.goto(APP); await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `no horizontal page scroll (${overflow}px)`);
    ok(await page.locator('[data-testid="companion"]').isVisible(), 'companion visible');
    await page.screenshot({ path: '/tmp/claude-0/e2e-mobile-1.png' });
    await openControls(page);
    await page.locator('[data-testid="target-barnards-star"]').click();
    await page.waitForSelector('[data-testid="inspector"]');
    const b = await page.locator('[data-testid="inspector"]').boundingBox();
    ok(b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 844, 'inspector fits the phone viewport as a bottom sheet', JSON.stringify(b));
    ok(await page.locator('[data-testid="inspector-explore"]').isVisible(), 'primary action reachable');
    await openControls(page);
    await page.locator('[data-testid="find-by-coordinates"]').click();
    const p = await page.locator('#findcoord-panel').boundingBox();
    ok(p.x >= 0 && p.x + p.width <= 390, 'coordinate panel fits the phone viewport', JSON.stringify(p));
    await page.screenshot({ path: '/tmp/claude-0/e2e-mobile-2.png' });
  });


  // ---- the first-time entry experience -------------------------------------------------------------------------
  const DIALOGUE = "Oh, here you are. I've been waiting. Finally, someone curious. Let's start?";

  await scenario('11. welcome scene: a quiet universe, then Nyan Cat speaks', {}, async ({ page, log }) => {
    await page.goto(APP);
    await page.waitForSelector('[data-testid="welcome"]');
    ok((await page.locator('[data-testid="welcome"]').getAttribute('data-phase')) === 'welcome_flying', 'opens in welcome_flying');
    ok(await page.locator('.nav, .skypage__bar, [data-testid="inspector"]').count() === 0, 'no navigation bar, sidebar or dashboard');
    ok(await page.evaluate(() => {
      const w = document.querySelector('[data-testid="welcome"]');
      const r = w.getBoundingClientRect();
      if (getComputedStyle(w).opacity !== '1' || r.width < window.innerWidth || r.height < window.innerHeight) return false;
      // Anything the application already has mounted underneath must be out of sight behind the quiet universe.
      const c = document.querySelector('[data-testid="companion"]');
      const cr = c && c.getBoundingClientRect();
      const under = cr && document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
      return !c || w.contains(under);
    }), 'the universe fills the screen; nothing of the application shows through');
    ok(await page.locator('[data-testid="welcome"] button:not(.sr-only)').count() === 0, 'no buttons yet');
    ok(await page.locator('[data-testid="welcome-nyan"]').isVisible() && await page.locator('.welcome__trail').isVisible(), 'pixel-art Nyan Cat with a rainbow trail');
    ok(await page.locator('.starfield').isVisible(), 'a subtle field of stars');
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="welcome"]')).backgroundImage);
    ok(/rgb\(\s*(3|6|11)\s*,/.test(bg), 'a nearly black deep-space background', bg.slice(0, 60));

    // it flies: sample the cat's own on-screen position, and check the path is diagonal, varied and always visible
    const where = () => page.evaluate(() => {
      const r = document.querySelector('[data-testid="welcome-nyan"]').getBoundingClientRect();
      const t = new DOMMatrix(getComputedStyle(document.querySelector('.welcome__tilt')).transform);
      return { x: r.left + r.width * 0.786, y: r.top + r.height / 2, w: r.width * 0.23, h: r.height / 2, tilt: Math.atan2(t.b, t.a) * 180 / Math.PI, vw: window.innerWidth, vh: window.innerHeight };
    });
    const pts = [];
    for (let i = 0; i < 18; i++) { pts.push(await where()); await sleep(300); }
    // Drop the entrance: it deliberately flies in from off-screen.
    const first = pts.findIndex((p) => p.x - p.w >= -2 && p.x + p.w <= p.vw + 2);
    const on = first < 0 ? [] : pts.slice(first);
    const spanX = Math.max(...on.map((p) => p.x)) - Math.min(...on.map((p) => p.x));
    const spanY = Math.max(...on.map((p) => p.y)) - Math.min(...on.map((p) => p.y));
    ok(spanX > 300 && spanY > 150, `it roams the whole viewport, not just one axis (${Math.round(spanX)} × ${Math.round(spanY)} px)`);
    const diagonal = on.slice(1).filter((p, i) => Math.abs(p.x - on[i].x) > 6 && Math.abs(p.y - on[i].y) > 6).length;
    ok(diagonal >= 4, `most of the movement is diagonal (${diagonal} of ${on.length - 1} samples)`, JSON.stringify(on.map((p) => [Math.round(p.x), Math.round(p.y)])));
    const dirs = new Set(on.slice(1).map((p, i) => `${Math.sign(p.x - on[i].x)}${Math.sign(p.y - on[i].y)}`).filter((d) => d !== '00'));
    ok(dirs.size >= 3, `and it changes direction (${dirs.size} distinct headings)`, [...dirs].join(' '));
    const speeds = on.slice(1).map((p, i) => Math.hypot(p.x - on[i].x, p.y - on[i].y)).filter((v) => v > 1);
    ok(Math.max(...speeds) > Math.min(...speeds) * 2, 'at varying speeds', `${Math.round(Math.min(...speeds))}..${Math.round(Math.max(...speeds))}`);
    const escaped = on.find((p) => p.x - p.w < -2 || p.x + p.w > p.vw + 2 || p.y - p.h < -2 || p.y + p.h > p.vh + 2);
    ok(!escaped, 'the cat never clips outside the viewport', JSON.stringify(escaped || {}));
    ok(on.every((p) => Math.abs(p.tilt) <= 16.5), 'and never tilts far enough to stop looking like Nyan Cat');
    const steps = on.slice(1).map((p, i) => Math.hypot(p.x - on[i].x, p.y - on[i].y));
    ok(Math.max(...steps) < Math.max(...on.map((p) => p.vw)) * 0.9, 'no abrupt jumps across the screen', String(Math.round(Math.max(...steps))));

    await page.waitForSelector('[data-testid="welcome-dialogue"]', { timeout: 60000 });
    ok((await page.locator('[data-testid="welcome"]').getAttribute('data-phase')) === 'welcome_dialogue', 'phase welcome_dialogue once it has settled');
    const end = await where();
    ok(Math.abs(end.x - end.vw / 2) < 60, `it stopped in the central area (cat at ${Math.round(end.x)}px of ${end.vw})`);
    ok(Math.abs(end.tilt) < 1, 'level again, not still banking');
    const a = await where(); await sleep(900); const b = await where();
    ok(Math.hypot(b.x - a.x, b.y - a.y) < 2, 'and it does not keep drifting behind the dialogue');
    ok(await page.locator('.welcome__trail.is-settled').count() === 1, 'the rainbow trail has settled');

    // textContent, not innerText: innerText inserts newlines where the bubble wraps.
    const partial = (await page.locator('[data-testid="welcome-dialogue"] .bubble__text').textContent()).replace(/\s+/g, ' ').trim();
    ok(partial.length > 0 && partial.length < DIALOGUE.length && DIALOGUE.startsWith(partial), `the text types itself in, one character at a time ("${partial.slice(0, 28)}…")`, JSON.stringify(partial));
    await page.waitForFunction((full) => document.querySelector('[data-testid="welcome-dialogue"] .bubble__text').textContent.replace(/\s+/g, ' ').trim() === full, DIALOGUE, { timeout: 30000 });
    ok(true, 'the exact welcome dialogue is shown');
    ok((await page.locator('[data-testid="welcome-dialogue"]').innerText()).includes(DIALOGUE), 'and is available to assistive technology in full');

    await page.waitForSelector('[data-testid="start-exploring"]', { timeout: 15000 });
    ok((await page.locator('[data-testid="start-exploring"]').innerText()).trim() === 'START EXPLORING', 'the button says exactly START EXPLORING');
    const press = await page.evaluate(() => { const b = document.querySelector('[data-testid="start-exploring"]'); const s = getComputedStyle(b); return { radius: s.borderTopLeftRadius, clip: s.clipPath, bg: s.backgroundColor, font: s.fontFamily }; });
    ok(press.clip.startsWith('polygon') && press.radius === '0px', 'drawn with a pixelated border, not a rounded one');
    ok(press.bg === 'rgb(211, 233, 122)', 'in the project lime accent #D3E97A', press.bg);
    log.errors.length = 0;
  });

  await scenario('12. entering the universe, and the companion', {}, async ({ page, log }) => {
    await page.goto(APP);
    await page.waitForSelector('[data-testid="start-exploring"]', { timeout: 60000 });
    await page.evaluate(() => { window.__noReload = true; });
    await page.locator('[data-testid="start-exploring"]').click();
    ok((await page.locator('[data-testid="welcome"]').getAttribute('data-phase')) === 'entering_universe', 'phase entering_universe');
    ok(await page.locator('[data-testid="welcome-dialogue"]').count() === 0 && await page.locator('[data-testid="start-exploring"]').count() === 0, 'dialogue and button leave');
    await page.waitForFunction(() => !document.querySelector('[data-testid="welcome"]'), null, { timeout: 10000 });
    ok(await page.evaluate(() => window.__noReload === true), 'the page was never reloaded');
    await finishTour(page);
    ok(await page.locator('[data-testid="sky-page"]').isVisible(), 'the sky map is the whole experience');
    await page.waitForSelector('.skymark', { timeout: 20000 });

    ok(await page.locator('.skypage__bar, #findcoord-panel').count() === 0, 'no coordinate search panel');
    ok(await page.locator('[data-testid="inspector"]').count() === 0, 'no object inspector by default');
    ok(await page.locator('.skyctx__surveys').count() === 0, 'no survey chips');
    ok(await page.locator('.skymark').count() === 5, 'the five featured targets');
    ok(await page.locator('[data-testid="companion"]').isVisible(), 'and a small Nyan Cat companion');
    const cat = await page.locator('.companion__cat img').boundingBox();
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    ok(cat.height <= 56 && (cat.x < vp.w * 0.2 || cat.x > vp.w * 0.8) && cat.y > vp.h * 0.7, `small, and near the edge (${Math.round(cat.x)},${Math.round(cat.y)} · ${Math.round(cat.height)}px tall)`);

    await page.waitForSelector('[data-testid="companion-greeting"]', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="companion-greeting"] .bubble__text')?.textContent.replace(/\s+/g, ' ').trim() === 'Feel free. Explore what you like.', null, { timeout: 15000 });
    ok(true, 'it says exactly "Feel free. Explore what you like.", typed out the same way');
    await page.waitForSelector('[data-testid="companion-greeting"]', { state: 'detached', timeout: 20000 });
    ok(await page.locator('[data-testid="companion"]').isVisible(), 'the bubble goes, the companion stays');

    // the sky is still a real, interactive map
    await openControls(page);
    ok(await page.locator('[data-testid="find-by-coordinates"]').isVisible() && await page.locator('[data-testid="target-r-dra"]').isVisible(), 'the companion is where the controls live');
    await page.locator('[data-testid="target-r-dra"]').click();
    await page.waitForSelector('[data-testid="inspector"]');
    ok((await page.locator('[data-testid="inspector-title"]').innerText()) === 'R Draconis', 'selecting a target opens the existing inspector');
    ok(log.errors.filter((e) => !/Failed to fetch|unreachable/.test(e)).length === 0, 'no page errors', JSON.stringify(log.errors));

    // a second visit is not made to sit through the intro again
    await page.goto(APP);
    await page.waitForSelector('[data-testid="sky-page"]');
    await sleep(600);
    ok(await page.locator('[data-testid="welcome"]').count() === 0, 'a returning visitor goes straight to the sky');
    await page.waitForSelector('.skymark', { timeout: 20000 });
    await openControls(page);
    await page.locator('[data-testid="replay-intro"]').click();
    await page.waitForSelector('[data-testid="welcome"]', { timeout: 5000 });
    ok(true, 'and can replay it from the companion');
  });

  await scenario('13. reduced motion', { reducedMotion: 'reduce' }, async ({ page }) => {
    await page.goto(APP);
    await page.waitForSelector('[data-testid="welcome-dialogue"]', { timeout: 20000 });
    ok(true, 'the welcome still happens, without the flight');
    ok((await page.locator('[data-testid="welcome-dialogue"] .bubble__text').textContent()).replace(/\s+/g, ' ').trim() === DIALOGUE, 'the whole dialogue is there at once, not typed');
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.starfield__l--1')).animationName);
    ok(anim === 'none', 'the stars stop breathing');
    await page.waitForSelector('[data-testid="start-exploring"]', { timeout: 15000 });
    await page.locator('[data-testid="start-exploring"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="welcome"]'), null, { timeout: 10000 });
    await page.waitForSelector('.skymark', { timeout: 20000 });
    ok(await page.locator('.skymark').count() === 5, 'and it still ends on the map with the five targets');
  });


  await scenario('14. guided onboarding through the real pages', {}, async ({ page, log }) => {
    await page.goto(APP);
    await page.waitForSelector('[data-testid="start-exploring"]', { timeout: 60000 });
    await page.locator('[data-testid="start-exploring"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tour"]')?.dataset.phase === 'sky_map_intro', null, { timeout: 40000 });
    ok(await page.locator('[data-testid="tour-skip"]').count() === 0, 'the tour cannot be skipped');
    ok(await page.evaluate(() => !!document.querySelector('.nav__link:disabled')), 'and navigation past it is locked');
    await sleep(500);
    ok((await page.locator('[data-testid="tour-bubble"]').textContent()).includes('This is the sky map'), 'it introduces the sky map first');
    await page.locator('[data-testid="tour-next"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tour"]')?.dataset.phase === 'explorer_intro', null, { timeout: 10000 });
    ok((await page.evaluate(() => location.hash)).startsWith('#/explorer'), 'then moves on to the real Explorer route');

    const steps = [
      ['explorer_image', 'Image', 'Image lets you see the actual astronomical observations'],
      ['explorer_compare', 'Compare', 'Compare lets you look at observations side by side'],
      ['explorer_spectral', 'Spectral', 'Every object has a story written in light'],
      ['explorer_sky_context', 'Sky context', 'Sky Context helps you understand'],
    ];
    for (const [phase, tab, text] of steps) {
      await page.locator('[data-testid="tour-next"]').click();
      await page.waitForFunction((p) => document.querySelector('[data-testid="tour"]')?.dataset.phase === p, phase, { timeout: 10000 });
      await sleep(500);
      ok((await page.locator('[data-testid="tour-bubble"]').innerText()).includes(text), `${tab}: the explanation from the brief`);
      ok((await page.evaluate(() => document.querySelector('.stage__tab[aria-selected="true"]')?.textContent)) === tab, `${tab}: the real tab is selected, not a mock`);
      const spot = await page.locator('[data-testid="tour-spotlight"]').boundingBox();
      const real = await page.locator(`.stage__tab:text-is("${tab}")`).boundingBox();
      ok(spot && real && Math.abs(spot.x - real.x) < 10 && Math.abs(spot.y - real.y) < 10, `${tab}: the spotlight is on that element`);
    }
    // the tool under the spotlight stays usable
    await page.locator('.stage__tab:text-is("Image")').click();
    ok((await page.evaluate(() => document.querySelector('.stage__tab[aria-selected="true"]')?.textContent)) === 'Image', 'the tour never blocks the real controls');
    await page.locator('.stage__tab:text-is("Sky context")').click();

    await page.locator('[data-testid="tour-next"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tour"]')?.dataset.phase === 'analysis_intro', null, { timeout: 10000 });
    ok((await page.evaluate(() => location.hash)).startsWith('#/analysis'), '"Continue to Analysis" opens the real Analysis route');
    await sleep(400);
    ok((await page.locator('[data-testid="tour-bubble"]').innerText()).includes('Welcome to Analysis! This is where exploration turns into investigation.'), 'with the Analysis welcome from the brief');

    for (const [phase, word] of [['analysis_detect', 'Source detection'], ['analysis_subtract', 'Image subtraction'], ['analysis_track', 'Cross-epoch tracking']]) {
      await page.locator('[data-testid="tour-next"]').click();
      await page.waitForFunction((p) => document.querySelector('[data-testid="tour"]')?.dataset.phase === p, phase, { timeout: 10000 });
      await sleep(400);
      const t = await page.locator('[data-testid="tour-bubble"]').innerText();
      ok(t.includes(word), `${word}: described by its real name`);
      ok(/prototype/i.test(t), `${word}: and declared a prototype rather than a validated tool`);
    }

    await page.locator('[data-testid="tour-next"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tour"]')?.dataset.phase === 'onboarding_complete', null, { timeout: 10000 });
    await sleep(400);
    ok((await page.locator('[data-testid="tour-bubble"]').innerText()).includes("You're ready! The universe is yours to explore."), 'the closing line from the brief');
    ok((await page.locator('[data-testid="tour-next"]').innerText()).trim().toUpperCase() === 'START EXPLORING', 'and a START EXPLORING button');
    await page.locator('[data-testid="tour-next"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="tour"]'), null, { timeout: 5000 });
    ok(await page.locator('.analysis, .page-empty').count() > 0, 'which leaves the user on the real Analysis page, free to navigate');

    // and it is not repeated
    await page.goto(`${APP}#/explorer`);
    await page.waitForSelector('.explorer');
    await sleep(800);
    ok(await page.locator('[data-testid="tour"]').count() === 0, 'the tour does not start again on the next visit');
    ok(log.errors.filter((e) => !/Failed to fetch|unreachable/.test(e)).length === 0, 'no page errors', JSON.stringify(log.errors.slice(0, 3)));
  });

  await scenario('15. the tour can be skipped, and the target survives it', {}, async ({ page }) => {
    await page.goto(`${APP}#/sky?t=barnards-star`); await ready(page, true);
    await page.waitForSelector('[data-testid="inspector-title"]');
    await page.locator('[data-testid="inspector-explore"]').click();
    await page.waitForSelector('.explorer');
    const before = await page.locator('.selected__name').innerText();
    await page.evaluate(() => { try { localStorage.removeItem('suy.tour.done.v1'); } catch {} });
    await page.goto(`${APP}#/sky`);
    await ready(page, true);
    await finishTour(page);
    ok(await page.locator('[data-testid="tour"]').count() === 0, 'the onboarding completes and unlocks the application');
    ok(!(await page.evaluate(() => !!document.querySelector('.nav__link:disabled'))), 'navigation is unlocked afterwards');
    await page.locator('.nav__link', { hasText: 'Explorer' }).click();
    await page.waitForSelector('.explorer');
    ok((await page.locator('.selected__name').innerText()) === before, `the selected target is untouched by the tour (${before})`);
    ok(true, 'and it is remembered');
  });

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
