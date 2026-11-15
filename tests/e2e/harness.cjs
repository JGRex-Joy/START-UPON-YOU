/**
 * Browser harness for the sky-map e2e tests. The sandbox (and CI) cannot reach third-party hosts, so the three external
 * dependencies are served locally: Aladin Lite (the real npm build), a HiPS `properties` + flat tiles for the
 * context survey, and a mock of the public S3 bucket. Everything else (the app, Aladin's rendering, the DOM) is real.
 */
const fs = require('fs');
const { chromium } = require('playwright');

const ALADIN_JS = process.env.ALADIN_JS; // path to node_modules/aladin-lite/dist/aladin.js
const TILE = process.env.TILE_JPG;       // any small jpeg
const APP = process.env.APP_URL || 'http://localhost:4173/';
const S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*', 'access-control-allow-methods': '*' };

async function launch({ s3 = 'found', viewport = { width: 1280, height: 800 }, aladin = true, reducedMotion } = {}) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport, ...(reducedMotion ? { reducedMotion } : {}) });
  const page = await context.newPage();
  const log = { s3: [], errors: [], console: [], aborted: [] };
  // Capture the live Aladin view (the app does not expose it) so tests can read the real projection / FoV / centre.
  await context.addInitScript(() => {
    let real;
    Object.defineProperty(window, 'A', {
      configurable: true,
      get() { return real; },
      set(v) {
        real = v;
        if (v && typeof v.aladin === 'function' && !v.__wrapped) {
          const orig = v.aladin.bind(v);
          v.aladin = (...a) => { const inst = orig(...a); window.__aladin = inst; return inst; };
          v.__wrapped = true;
        }
      },
    });
  });
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text()); });
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(APP) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.includes('aladin.cds.unistra.fr')) return route.abort(); // force the loader's second (module) source
    if (url.includes('cdn.jsdelivr.net/npm/aladin-lite')) {
      return aladin ? route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/javascript' }, body: fs.readFileSync(ALADIN_JS) }) : route.abort();
    }
    if (/skies\.esac\.esa\.int\/DSSColor\/properties/.test(url)) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/plain' }, body: 'hips_order = 9\nhips_tile_format = jpeg\nhips_frame = equatorial\nhips_tile_width = 512\nobs_title = DSS2 colour (test fixture)\nhips_version = 1.4\n' });
    }
    if (/skies\.esac\.esa\.int\/DSSColor\//.test(url)) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/jpeg' }, body: fs.readFileSync(TILE) });
    if (url.startsWith(S3)) {
      log.s3.push(`${req.method()} ${url.replace(S3, '')}`);
      if (s3 === 'down') return route.abort('failed');
      if (s3 === 'absent') {
        if (req.method() === 'HEAD') return route.fulfill({ status: 404, headers: CORS });
        const q = new URL(url).searchParams;
        const prefix = q.get('prefix') || '';
        const body = prefix === '' ? '<ListBucketResult><CommonPrefixes><Prefix>qr2/</Prefix></CommonPrefixes></ListBucketResult>' : '<ListBucketResult></ListBucketResult>';
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/xml' }, body });
      }
      if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-length': '112000000', etag: '"abc"', 'last-modified': 'Mon, 26 Oct 2026 00:00:00 GMT' } });
      return route.fulfill({ status: 404, headers: CORS });
    }
    if (/irsa\.ipac\.caltech\.edu|vizier|cds\.unistra/.test(url)) return route.fulfill({ status: 503, headers: CORS, body: 'IRSA unavailable (test fixture)' });
    log.aborted.push(url);
    return route.abort();
  });
  return { browser, context, page, log };
}
module.exports = { launch, APP };
